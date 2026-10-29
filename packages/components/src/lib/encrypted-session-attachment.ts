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

export async function uploadProtectedAttachment(args: {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  file: File;
  kind: 'image' | 'file';
  attachmentToken?: () => Promise<string>;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}) {
  if (!args.attachmentToken) throw new Error('e2ee_attachment_unavailable');
  const token = await args.attachmentToken();
  const result = await uploadEncryptedAttachment({
    ...args,
    fileName: args.file.name,
    mimeType: args.file.type || 'application/octet-stream',
    sizeBytes: args.file.size,
    read: async (offset, length) =>
      new Uint8Array(await args.file.slice(offset, offset + length).arrayBuffer()),
    upload: async (bytes, index) => {
      const response = await fetch(
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
}) {
  let token: Promise<string> | undefined;
  return readEncryptedAttachment({
    ...args,
    fetchPart: async (fileId) => {
      if (!args.attachmentToken) throw new Error('e2ee_attachment_unavailable');
      token ??= args.attachmentToken();
      return fetch(
        buildSessionFileApiUrl(
          API_BASE_URL,
          encryptedAttachmentPath(
            getSessionFileDownloadApiPath(args.workspaceId, args.sessionId, fileId),
            args.encryption.kind
          )
        ),
        {
          signal: args.signal,
          headers: { Authorization: `Bearer ${await token}` },
        }
      );
    },
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

/** Prepared local receipts keep their existing contract. Every relay reference
 * in protected history must carry a complete, matching secret manifest. */
export function assertProtectedAttachmentReferences(blocks: readonly SessionInputBlock[]): void {
  for (const block of blocks) {
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
