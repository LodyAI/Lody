import { protectedAttachmentBlob, protectedAttachmentChunks } from './encrypted-session-attachment';
import { SESSION_FILE_PREVIEW_FETCH_BYTES, type SessionId, type WorkspaceId } from '@lody/shared';
import { buildSessionFileDownloadUrl, buildSessionFilePreviewUrl } from './session-file-upload';
import { isNativeAppShell } from './native-platform';
import { saveSessionFileToNativeShareSheet } from './session-file-native-save';

type FileFetchArgs = {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  fileId: string;
  token: string;
  encryption?: import('@lody/shared').EncryptedAttachment;
  attachmentToken?: () => Promise<string>;
};

/**
 * Save/export a file's bytes for the user.
 *
 * Platform branches (Decision #7 in plans/session-files-implementation.md):
 * - **Native (Capacitor mobile)**: a browser-style `<a download>` is unreliable
 *   inside the iOS WKWebView shell, so we stream the bytes to the app cache via
 *   the Filesystem plugin (chunked, base64) and hand the resulting file URI to
 *   the OS share sheet (which exposes Save-to-Files / AirDrop / etc.). Bytes are
 *   never buffered whole — see `session-file-native-save.ts`.
 * - **Web / Electron**: bearer fetch → blob → synthetic `<a download>`. The
 *   server sets `Content-Disposition: attachment` + `nosniff`, so this never
 *   navigates the browser to user-controlled bytes.
 */
const downloadSessionFileInBrowser = async (
  args: FileFetchArgs & { fileName: string }
): Promise<void> => {
  const { workspaceId, sessionId, fileId, token, fileName } = args;
  let blob: Blob;
  if (args.encryption) blob = await protectedAttachmentBlob({ ...args, encryption: args.encryption });
  else {
    const response = await fetch(buildSessionFileDownloadUrl(workspaceId, sessionId, fileId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Failed to download file (${response.status})`);
    blob = await response.blob();
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName || fileId;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke on the next tick so the click has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
};

export const downloadSessionFile = async (
  args: FileFetchArgs & { fileName: string; mimeType?: string }
): Promise<void> => {
  if (isNativeAppShell()) {
    await saveSessionFileToNativeShareSheet(args);
    return;
  }
  await downloadSessionFileInBrowser(args);
};

export type SessionFilePreviewResult = {
  /** Raw source text of the fetched prefix (always the unmodified bytes). */
  text: string;
  /** True when only a bounded prefix was fetched and more bytes remain. */
  truncated: boolean;
  /** Bytes actually fetched for the preview. */
  fetchedBytes: number;
};

/**
 * Read at most `maxBytes` from a response body, cancelling the stream once the
 * cap is reached so an unbounded (Range-ignoring) response is never fully
 * buffered. Falls back to `arrayBuffer()` only when the body isn't a stream.
 */
const readBoundedBytes = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer).subarray(0, maxBytes);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/**
 * Fetch a bounded text prefix of a file's preview endpoint via an HTTP Range
 * request (`bytes=0-(N-1)`). The endpoint serves `text/plain`; we decode the
 * returned bytes as UTF-8 and report truncation so the UI can offer a full
 * download. 4xx surfaces as a thrown error the card degrades on.
 */
export const fetchSessionFilePreview = async (
  args: FileFetchArgs & { sizeBytes: number; signal?: AbortSignal }
): Promise<SessionFilePreviewResult> => {
  const { workspaceId, sessionId, fileId, token, sizeBytes, signal } = args;
  const maxBytes = SESSION_FILE_PREVIEW_FETCH_BYTES;
  if (args.encryption) {
    const parts: Uint8Array[] = []; let fetchedBytes = 0;
    for await (const bytes of protectedAttachmentChunks({ ...args, encryption: args.encryption })) {
      const take = bytes.slice(0, maxBytes - fetchedBytes);
      parts.push(take); fetchedBytes += take.length;
      if (fetchedBytes >= maxBytes) break;
    }
    const bytes = new Uint8Array(fetchedBytes); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return { text: new TextDecoder().decode(bytes), fetchedBytes, truncated: args.sizeBytes > fetchedBytes };
  }
  const response = await fetch(buildSessionFilePreviewUrl(workspaceId, sessionId, fileId), {
    headers: {
      Authorization: `Bearer ${token}`,
      Range: `bytes=0-${maxBytes - 1}`,
    },
    signal,
  });
  // 200 (server ignored Range) and 206 (partial) are both success here.
  if (!response.ok && response.status !== 206) {
    throw new Error(`Preview unavailable (${response.status})`);
  }
  // Bound the read ourselves: if the server ignores Range and returns 200 with
  // the whole (up to 100MB) file, arrayBuffer() would buffer all of it. Read at
  // most maxBytes from the stream, then cancel.
  const bytes = await readBoundedBytes(response, maxBytes);
  const fetchedBytes = bytes.byteLength;
  const text = new TextDecoder('utf-8').decode(bytes);
  // When the total size is known, truncation means we hold fewer bytes than the
  // file has (a file of exactly maxBytes is complete, not truncated). Only when
  // the size is unknown do we infer truncation from hitting the fetch window.
  const truncated = sizeBytes > 0 ? sizeBytes > fetchedBytes : fetchedBytes >= maxBytes;
  return { text, truncated, fetchedBytes };
};
