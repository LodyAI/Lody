import { SESSION_IMAGE_MAX_SIZE_BYTES, SESSION_IMAGE_ALLOWED_MIME_TYPES } from './ai';
import { z } from 'zod';
import { IncrementalSha256 } from './incremental-sha256';

/** Bounded crypto and HTTP unit; each part is a separate opaque relay object. */
export const ENCRYPTED_ATTACHMENT_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = 100 * 1024 * 1024;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (x) => parseInt(x, 16));

/** Secret manifest. Persist only inside protected content; never send it to the relay. */
export const EncryptedAttachmentSchema = z
  .object({
    v: z.literal(1),
    key: z.string().regex(/^[0-9a-f]{64}$/),
    resourceId: z.string().regex(/^[0-9a-f]{32}$/),
    kind: z.enum(['image', 'file']),
    sizeBytes: z.number().int().positive().max(MAX_BYTES),
    fileName: z.string().max(4096),
    mimeType: z.string().max(256),
    parts: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/))
      .min(1)
      .max(25),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.kind === 'image' &&
      (value.sizeBytes > SESSION_IMAGE_MAX_SIZE_BYTES ||
        !SESSION_IMAGE_ALLOWED_MIME_TYPES.some((mime) => mime === value.mimeType))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid encrypted image manifest' });
    if (value.parts.length !== Math.ceil(value.sizeBytes / ENCRYPTED_ATTACHMENT_CHUNK_BYTES))
      ctx.addIssue({ code: 'custom', message: 'Invalid encrypted attachment length' });
    if (new Set(value.parts).size !== value.parts.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate encrypted attachment part' });
  });
export type EncryptedAttachment = z.infer<typeof EncryptedAttachmentSchema>;
type Manifest = Omit<EncryptedAttachment, 'parts'>;
export type AttachmentContext = { workspaceId: string; sessionId: string };

/** Stored image references must not bypass the bounded image contract. */
export function assertEncryptedImageReference(
  imageId: string,
  encryption: EncryptedAttachment
): void {
  const manifest = EncryptedAttachmentSchema.parse(encryption);
  if (manifest.kind !== 'image' || manifest.parts[0] !== imageId)
    throw new Error('Encrypted image reference mismatch');
}

const parameters = (context: AttachmentContext, manifest: Manifest, index: number) => {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  return {
    name: 'AES-GCM',
    iv,
    tagLength: 128,
    additionalData: new TextEncoder().encode(
      JSON.stringify([
        'lody-encrypted-attachment-v1',
        context.workspaceId,
        context.sessionId,
        manifest.resourceId,
        manifest.kind,
        manifest.sizeBytes,
        manifest.fileName,
        manifest.mimeType,
        ENCRYPTED_ATTACHMENT_CHUNK_BYTES,
        index,
      ])
    ),
  };
};

/** SHA-256 for one bounded ciphertext or plaintext block. */
export const attachmentSha256 = (bytes: Uint8Array): string => {
  const hash = new IncrementalSha256();
  hash.update(bytes);
  return hash.digestHex();
};

/**
 * Encrypt and upload one bounded part at a time. A failure publishes no manifest;
 * the caller retains its source for retry. Every new attempt uses a fresh key.
 */
export async function uploadEncryptedAttachment(
  args: AttachmentContext & {
    kind: 'image' | 'file';
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    read(offset: number, length: number): Promise<Uint8Array>;
    upload(bytes: Uint8Array, index: number): Promise<string>;
    signal?: AbortSignal;
  }
): Promise<{ encryption: EncryptedAttachment; sha256: string }> {
  if (!Number.isSafeInteger(args.sizeBytes) || args.sizeBytes <= 0 || args.sizeBytes > MAX_BYTES)
    throw new Error('Invalid encrypted attachment size');
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const manifest: Manifest = {
    v: 1,
    key: hex(rawKey),
    resourceId: hex(crypto.getRandomValues(new Uint8Array(16))),
    kind: args.kind,
    fileName: args.fileName,
    mimeType: args.mimeType,
    sizeBytes: args.sizeBytes,
  };
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  rawKey.fill(0);
  const hash = new IncrementalSha256();
  const parts: string[] = [];
  for (
    let offset = 0, index = 0;
    offset < args.sizeBytes;
    offset += ENCRYPTED_ATTACHMENT_CHUNK_BYTES, index++
  ) {
    args.signal?.throwIfAborted();
    const length = Math.min(ENCRYPTED_ATTACHMENT_CHUNK_BYTES, args.sizeBytes - offset);
    const bytes = await args.read(offset, length);
    if (bytes.byteLength !== length) throw new Error('Attachment changed during encryption');
    try {
      hash.update(bytes);
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          parameters(args, manifest, index),
          key,
          bytes as Uint8Array<ArrayBuffer>
        )
      );
      args.signal?.throwIfAborted();
      parts.push(await args.upload(sealed, index));
    } finally {
      bytes.fill(0);
    }
  }
  args.signal?.throwIfAborted();
  return {
    encryption: EncryptedAttachmentSchema.parse({ ...manifest, parts }),
    sha256: hash.digestHex(),
  };
}

/** Authenticate each bounded part before yielding it. Never downgrade to plaintext. */
export async function* readEncryptedAttachment(
  args: AttachmentContext & {
    encryption: EncryptedAttachment;
    fetchPart(fileId: string): Promise<Response>;
    signal?: AbortSignal;
  }
): AsyncGenerator<Uint8Array> {
  const manifest = EncryptedAttachmentSchema.parse(args.encryption);
  const rawKey = unhex(manifest.key);
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  rawKey.fill(0);
  for (const [index, fileId] of manifest.parts.entries()) {
    args.signal?.throwIfAborted();
    const expected =
      Math.min(
        ENCRYPTED_ATTACHMENT_CHUNK_BYTES,
        manifest.sizeBytes - index * ENCRYPTED_ATTACHMENT_CHUNK_BYTES
      ) + 16;
    const response = await args.fetchPart(fileId);
    if (!response.ok || !response.body) throw new Error('Encrypted attachment unavailable');
    const reader = response.body.getReader();
    const sealed = new Uint8Array(expected);
    let filled = 0;
    try {
      for (;;) {
        args.signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        if (value.length > expected - filled) throw new Error('Encrypted attachment size mismatch');
        sealed.set(value, filled);
        filled += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (filled !== expected) throw new Error('Encrypted attachment size mismatch');
    const bytes = new Uint8Array(
      await crypto.subtle.decrypt(parameters(args, manifest, index), key, sealed)
    );
    args.signal?.throwIfAborted();
    yield bytes;
  }
}

/** Dedicated route; ordinary credentials and image transforms cannot serve this content. */
export function encryptedAttachmentPath(path: string, kind: 'file' | 'image' = 'file'): string {
  return path.replace(
    '/session-files/',
    kind === 'image' ? '/session-encrypted-images/' : '/session-encrypted-files/'
  );
}
