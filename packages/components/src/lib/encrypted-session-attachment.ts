import {
  buildSessionFileApiUrl,
  EncryptedAttachmentSchema,
  type SessionInputBlock,
  uploadEncryptedAttachment,
  readEncryptedAttachment,
  encryptedAttachmentPath,
  attachmentSha256,
  buildSessionFileUploadMetadataHeaders,
  getSessionFileUploadApiPath,
  getSessionFileDownloadApiPath,
  SessionInputBlockSchema,
  type EncryptedAttachment,
  type WorkspaceId,
  type SessionId,
} from '@lody/shared';
import { API_BASE_URL } from '@/lib';

const ATTACHMENT_TRANSIENT_RETRY_DELAYS_MS = [150, 450] as const;
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';

const sleepWithAbort = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

async function fetchWithTransientRetry(
  run: () => Promise<Response>,
  signal?: AbortSignal,
  delaysMs: readonly number[] = ATTACHMENT_TRANSIENT_RETRY_DELAYS_MS
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await run();
      if (!TRANSIENT_HTTP_STATUSES.has(response.status) || attempt >= delaysMs.length) {
        return response;
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || attempt >= delaysMs.length) {
        throw error;
      }
    }
    await sleepWithAbort(delaysMs[attempt]!, signal);
  }
}

export async function uploadProtectedAttachment(args: {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  file: File;
  kind: 'image' | 'file';
  attachmentToken?: () => Promise<string>;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  retryDelaysMs?: readonly number[];
}) {
  if (!args.attachmentToken) throw new Error('e2ee_attachment_unavailable');
  let tokenPromise: Promise<string> | undefined;
  const getToken = () => {
    if (!tokenPromise) {
      const pending = args.attachmentToken!();
      tokenPromise = pending;
      void pending.catch(() => {
        if (tokenPromise === pending) tokenPromise = undefined;
      });
    }
    return tokenPromise;
  };
  await getToken();
  const result = await uploadEncryptedAttachment({
    ...args,
    fileName: args.file.name,
    mimeType: args.file.type || 'application/octet-stream',
    sizeBytes: args.file.size,
    read: async (offset, length) =>
      new Uint8Array(await args.file.slice(offset, offset + length).arrayBuffer()),
    upload: async (bytes, index) => {
      const response = await fetchWithTransientRetry(
        async () => {
          const token = await getToken();
          return fetch(
            buildSessionFileApiUrl(
              API_BASE_URL,
              encryptedAttachmentPath(getSessionFileUploadApiPath(args.workspaceId), args.kind)
            ),
            {
              method: 'POST',
              signal: args.signal,
              headers: {
                Authorization: `Bearer ${token}`,
                ...buildSessionFileUploadMetadataHeaders({
                  sessionId: args.sessionId,
                  fileName: 'attachment.bin',
                  mimeType: 'application/octet-stream',
                  sha256: attachmentSha256(bytes),
                  sizeBytes: bytes.length,
                  textPreview: false,
                }),
              },
              body: bytes as Uint8Array<ArrayBuffer>,
            }
          );
        },
        args.signal,
        args.retryDelaysMs
      );
      if (!response.ok) throw new Error(`Encrypted attachment upload failed (${response.status})`);
      const body: unknown = await response.json();
      const block = SessionInputBlockSchema.parse(
        body && typeof body === 'object' && 'file' in body ? body.file : undefined
      );
      if (block.type !== 'file') throw new Error('Invalid encrypted attachment receipt');
      args.onProgress?.(
        Math.min(100, Math.round((((index + 1) * 4 * 1024 * 1024) / args.file.size) * 100))
      );
      return block.fileId;
    },
  });
  return result;
}

/** Client-only previews and downloads; the relay never sees the manifest or key. */
export function protectedAttachmentChunks(args: {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  encryption: EncryptedAttachment;
  attachmentToken?: () => Promise<string>;
  signal?: AbortSignal;
  retryDelaysMs?: readonly number[];
}) {
  let token: Promise<string> | undefined;
  const getToken = () => {
    if (!args.attachmentToken) throw new Error('e2ee_attachment_unavailable');
    if (!token) {
      const pending = args.attachmentToken();
      token = pending;
      void pending.catch(() => {
        if (token === pending) token = undefined;
      });
    }
    return token;
  };
  return readEncryptedAttachment({
    ...args,
    fetchPart: async (fileId) =>
      fetchWithTransientRetry(
        async () =>
          fetch(
            buildSessionFileApiUrl(
              API_BASE_URL,
              encryptedAttachmentPath(
                getSessionFileDownloadApiPath(args.workspaceId, args.sessionId, fileId),
                args.encryption.kind
              )
            ),
            {
              signal: args.signal,
              headers: { Authorization: `Bearer ${await getToken()}` },
            }
          ),
        args.signal,
        args.retryDelaysMs
      ),
  });
}

export async function protectedAttachmentBlob(
  args: Parameters<typeof protectedAttachmentChunks>[0]
): Promise<Blob> {
  const parts: BlobPart[] = [];
  for await (const bytes of protectedAttachmentChunks(args))
    parts.push(bytes as Uint8Array<ArrayBuffer>);
  return new Blob(parts, { type: args.encryption.mimeType });
}

/** Collect authenticated plaintext within the caller's byte budget. */
export async function protectedAttachmentBytes(
  args: Parameters<typeof protectedAttachmentChunks>[0] & { maxBytes?: number }
): Promise<Uint8Array> {
  if (args.maxBytes !== undefined && args.encryption.sizeBytes > args.maxBytes)
    throw new Error('Share object exceeds size limit');
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of protectedAttachmentChunks(args)) {
    length += part.length;
    if (args.maxBytes !== undefined && length > args.maxBytes)
      throw new Error('Share object exceeds size limit');
    parts.push(part);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** Prepared local receipts keep their existing contract. Every relay reference
 * in protected history must carry a complete, matching secret manifest. */
export function assertProtectedAttachmentReferences(blocks: readonly SessionInputBlock[]): void {
  for (const block of blocks) {
    if (block.type === 'local_attachment') throw new Error('e2ee_attachment_unprotected');
    if (block.type !== 'image' && block.type !== 'file') continue;
    if (block.type === 'file' && block.transport === 'local') continue;
    if (!block.encryption) throw new Error('e2ee_attachment_unprotected');
    const manifest = EncryptedAttachmentSchema.parse(block.encryption);
    if (
      manifest.kind !== block.type ||
      manifest.parts[0] !== (block.type === 'image' ? block.imageId : block.fileId) ||
      manifest.sizeBytes !== block.sizeBytes ||
      manifest.fileName !== block.fileName ||
      manifest.mimeType !== block.mimeType
    )
      throw new Error('e2ee_attachment_manifest_mismatch');
  }
}
