import { isValidSessionFilePathSegment, type SessionId, type WorkspaceId } from '@lody/shared';
import { buildSessionFileDownloadUrl } from './session-file-upload';
import { Base64ChunkEncoder } from './base64-chunk';

/**
 * Native (Capacitor mobile) file-save flow for session file attachments.
 *
 * Why this exists: inside the iOS WKWebView shell a browser-style `<a download>`
 * silently fails, so "download" on mobile means "fetch the bytes, stage them in
 * the app cache, then let the OS share sheet route them to Files / AirDrop /
 * another app". See Decision #7 in plans/session-files-implementation.md and the
 * Mobile section of specs/session-files.md.
 *
 * Memory discipline (files can be up to 100 MB): we read the response body as a
 * `ReadableStream`, encode each ~3 MB slice to base64 on 3-byte-aligned
 * boundaries, and `appendFile` it to a temp cache file. We never call
 * `response.arrayBuffer()` / `.blob()`, so the full file is never resident.
 *
 * The Capacitor plugins are imported dynamically so the web/electron bundles
 * never pull `@capacitor/filesystem` or `@capacitor/share` (mirrors the
 * `@capacitor/browser` precedent in `native-browser.ts`).
 */

/** ~3 MB per appended chunk: large enough to amortize the JS↔native bridge
 * cost, small enough to bound peak memory (base64 inflates by 4/3). */
const CHUNK_BYTES = 3 * 1024 * 1024;

type NativeSaveArgs = {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  fileId: string;
  token: string;
  fileName: string;
  mimeType?: string;
};

export async function saveSessionFileToNativeShareSheet(args: NativeSaveArgs): Promise<void> {
  const { workspaceId, sessionId, fileId, token, fileName } = args;

  // `fileId` comes from CRDT history, which any workspace member can write —
  // it is untrusted input. It becomes a Filesystem directory segment below, so
  // a crafted `../` id would be a path traversal into the app sandbox. The URL
  // side is already safe (percent-encoding + server-side segment validation).
  if (!isValidSessionFilePathSegment(fileId)) {
    throw new Error('Invalid file id');
  }

  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');

  const response = await fetch(buildSessionFileDownloadUrl(workspaceId, sessionId, fileId), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to download file (${response.status})`);
  }

  // Stage under a per-save subdirectory so a corrupted/partial write can never
  // collide with another save and so cleanup is a single known path.
  const safeName = sanitizeCacheFileName(fileName || fileId);
  const cachePath = `lody-shared/${fileId}/${safeName}`;

  await writeResponseToCache({ response, Filesystem, Directory, cachePath });

  // Resolve the native file:// URI the share sheet needs.
  const { uri } = await Filesystem.getUri({ path: cachePath, directory: Directory.Cache });

  try {
    await Share.share({
      title: fileName,
      url: uri,
      dialogTitle: fileName,
    });
  } finally {
    // Best-effort cleanup: the share sheet has already copied/handed off the
    // bytes by the time it resolves or is dismissed. Failures here are benign
    // (the OS clears the cache dir eventually) so we never surface them.
    try {
      await Filesystem.deleteFile({ path: cachePath, directory: Directory.Cache });
    } catch {
      /* ignore — cache is OS-reclaimable */
    }
  }
}

/** Export an already-authorized, complete preview snapshot, never a host path. */
export async function shareFileBytesNatively(fileName: string, bytes: Uint8Array): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');
  const cachePath = `lody-shared/${crypto.randomUUID()}/${sanitizeCacheFileName(fileName)}`;
  try {
    await writeResponseToCache({
      response: new Response(bytes as unknown as BodyInit),
      Filesystem,
      Directory,
      cachePath,
    });
    const { uri } = await Filesystem.getUri({ path: cachePath, directory: Directory.Cache });
    try {
      await Share.share({ title: fileName, files: [uri], dialogTitle: fileName });
    } catch (error) {
      // Capacitor iOS/Android report dismissal as a rejected promise.
      const message = error instanceof Error ? error.message : String(error);
      if (!/^(Share canceled|Share cancelled|User cancelled sharing)$/i.test(message)) throw error;
    }
  } finally {
    await Filesystem.deleteFile({ path: cachePath, directory: Directory.Cache }).catch(() => {});
  }
}

type WriteArgs = {
  response: Response;
  Filesystem: typeof import('@capacitor/filesystem').Filesystem;
  Directory: typeof import('@capacitor/filesystem').Directory;
  cachePath: string;
};

/**
 * Stream the fetch body into the cache file in base64 chunks. The first write
 * uses `writeFile` (creating parent dirs); subsequent writes `appendFile`.
 * Omitting `Encoding` makes the plugin treat the string as base64 binary.
 */
async function writeResponseToCache({
  response,
  Filesystem,
  Directory,
  cachePath,
}: WriteArgs): Promise<void> {
  const body = response.body;
  const encoder = new Base64ChunkEncoder();
  let started = false;

  const writeSegment = async (base64: string): Promise<void> => {
    if (base64.length === 0) return;
    if (!started) {
      await Filesystem.writeFile({
        path: cachePath,
        directory: Directory.Cache,
        data: base64,
        recursive: true,
      });
      started = true;
    } else {
      await Filesystem.appendFile({ path: cachePath, directory: Directory.Cache, data: base64 });
    }
  };

  if (body) {
    const reader = body.getReader();
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      pending = concatBytes(pending, value);
      // Emit full CHUNK_BYTES slices; carry the tail to the next read.
      while (pending.length >= CHUNK_BYTES) {
        const slice = pending.subarray(0, CHUNK_BYTES);
        pending = pending.slice(CHUNK_BYTES);
        const segment = encoder.push(slice);
        if (segment) await writeSegment(segment);
      }
    }
    if (pending.length > 0) {
      const segment = encoder.push(pending);
      if (segment) await writeSegment(segment);
    }
  } else {
    // No streaming body (shouldn't happen on native, but degrade safely):
    // fall back to a single buffered read.
    const bytes = new Uint8Array(await response.arrayBuffer());
    const segment = encoder.push(bytes);
    if (segment) await writeSegment(segment);
  }

  const tail = encoder.flush();
  if (tail) await writeSegment(tail);

  // Empty file: ensure the file exists so the share sheet has something to hand.
  if (!started) {
    await Filesystem.writeFile({
      path: cachePath,
      directory: Directory.Cache,
      data: '',
      recursive: true,
    });
  }
}

/**
 * Strip path separators and reserved/control characters from an untrusted
 * display name so it can never escape the per-save cache subdirectory. The
 * directory is keyed by `fileId`, so we only need the basename to be benign and
 * human-readable. Spaces and other printable chars are preserved for readability.
 */
const RESERVED_CHARS = new Set([':', '*', '?', '"', '<', '>', '|']);

export function sanitizeCacheFileName(name: string): string {
  let cleaned = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop ASCII control chars (incl. NUL); replace path/reserved chars.
    if (code < 0x20 || ch === '/' || ch === '\\' || RESERVED_CHARS.has(ch)) {
      cleaned += '_';
    } else {
      cleaned += ch;
    }
  }
  cleaned = cleaned.trim();
  // Drop leading dots so the name can't become "." / ".." / a dotfile.
  const trimmed = cleaned.replace(/^\.+/, '').slice(0, 255).trim();
  return trimmed.length > 0 ? trimmed : 'download';
}

function concatBytes(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
