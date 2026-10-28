import { SessionImagePayloadSchema } from '../src/message-schemas';
import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import {
  uploadEncryptedAttachment,
  readEncryptedAttachment,
  EncryptedAttachmentSchema,
  ENCRYPTED_ATTACHMENT_CHUNK_BYTES,
  type EncryptedAttachment,
} from '../src/encrypted-attachment';
import {
  normalizeSessionInputBlocks,
  inputBlocksToHistoryItems,
  historyItemsToInputBlocks,
} from '../src/session-input';

const context = { workspaceId: 'workspace-1', sessionId: 'session-1' };
async function fixture(length = 31) {
  const source = Uint8Array.from({ length }, (_, i) => i % 251);
  const objects = new Map<string, Uint8Array>();
  const result = await uploadEncryptedAttachment({
    ...context,
    kind: 'file',
    fileName: 'private.txt',
    mimeType: 'text/plain',
    sizeBytes: source.length,
    read: async (offset, size) => source.slice(offset, offset + size),
    upload: async (bytes, index) => {
      const id = `part-${index}`;
      objects.set(id, bytes);
      return id;
    },
  });
  return { source, objects, ...result };
}
async function read(
  objects: Map<string, Uint8Array>,
  encryption: EncryptedAttachment,
  scope = context
) {
  const parts = [];
  for await (const bytes of readEncryptedAttachment({
    ...scope,
    encryption,
    fetchPart: async (id) => new Response(objects.get(id) as Uint8Array<ArrayBuffer>),
  }))
    parts.push(bytes);
  return Buffer.concat(parts);
}

describe('encrypted attachment wire boundary', () => {
  it('round trips multiple bounded parts, with only ciphertext in the relay', async () => {
    const f = await fixture(ENCRYPTED_ATTACHMENT_CHUNK_BYTES + 13);
    expect(f.encryption.parts).toEqual(['part-0', 'part-1']);
    expect(f.objects.get('part-0')?.length).toBe(ENCRYPTED_ATTACHMENT_CHUNK_BYTES + 16);
    expect(f.objects.get('part-1')?.length).toBe(29);
    expect(await read(f.objects, f.encryption)).toEqual(Buffer.from(f.source));
    expect(f.objects.get('part-0')?.subarray(0, 31)).not.toEqual(f.source.subarray(0, 31));
  });

  it.each([
    'workspace',
    'session',
    'key',
    'resource',
    'name',
    'mime',
    'kind',
    'size',
    'tamper',
    'truncated',
    'oversized',
  ])('rejects %s substitution', async (change) => {
    const f = await fixture();
    const manifest = structuredClone(f.encryption);
    let scope = context;
    if (change === 'workspace') scope = { ...context, workspaceId: 'workspace-2' };
    if (change === 'session') scope = { ...context, sessionId: 'session-2' };
    if (change === 'key') manifest.key = '00'.repeat(32);
    if (change === 'resource') manifest.resourceId = '00'.repeat(16);
    if (change === 'name') manifest.fileName = 'replacement';
    if (change === 'mime') manifest.mimeType = 'application/pdf';
    if (change === 'kind') manifest.kind = 'image';
    if (change === 'size') manifest.sizeBytes--;
    const bytes = f.objects.get('part-0');
    if (!bytes) throw new Error('fixture');
    if (change === 'tamper') bytes[0] = (bytes[0] ?? 0) ^ 1;
    if (change === 'truncated') f.objects.set('part-0', bytes.slice(0, -1));
    if (change === 'oversized') f.objects.set('part-0', new Uint8Array(bytes.length + 1));
    await expect(read(f.objects, manifest, scope)).rejects.toThrow();
  });

  it('rejects oversized or mismatched image manifests instead of bypassing image limits', async () => {
    const f = await fixture();
    const image = {
      imageId: 'part-0',
      fileName: 'private.txt',
      mimeType: 'image/png',
      sizeBytes: 1,
      encryption: f.encryption,
    };
    expect(SessionImagePayloadSchema.safeParse(image).success).toBe(false);
    expect(
      EncryptedAttachmentSchema.safeParse({
        ...f.encryption,
        kind: 'image',
        mimeType: 'image/png',
        sizeBytes: 100 * 1024 * 1024,
        parts: Array.from({ length: 25 }, (_, i) => `part-${i}`),
      }).success
    ).toBe(false);
  });

  it('rejects reordered, duplicate or omitted chunks', async () => {
    const f = await fixture(ENCRYPTED_ATTACHMENT_CHUNK_BYTES + 1);
    await expect(
      read(f.objects, { ...f.encryption, parts: [...f.encryption.parts].reverse() })
    ).rejects.toThrow();
    expect(
      EncryptedAttachmentSchema.safeParse({ ...f.encryption, parts: ['part-0', 'part-0'] }).success
    ).toBe(false);
    expect(
      EncryptedAttachmentSchema.safeParse({ ...f.encryption, parts: ['part-0'] }).success
    ).toBe(false);
  });

  it('survives protected-history serialization and a later epoch without rewrapping', async () => {
    const f = await fixture();
    const block = {
      type: 'file' as const,
      fileId: 'part-0',
      fileName: 'private.txt',
      mimeType: 'text/plain',
      sizeBytes: f.source.length,
      sha256: f.sha256,
      textPreview: true,
      transport: 'r2' as const,
      uploadedAt: 1,
      encryption: f.encryption,
    };
    const input = normalizeSessionInputBlocks([block], '');
    const history = inputBlocksToHistoryItems(input);
    const a = new LoroDoc();
    const b = new LoroDoc();
    try {
      a.getMap('attachment').set('block', history[0]);
      a.commit();
      b.import(a.export({ mode: 'snapshot' }));
      const parsed = historyItemsToInputBlocks([b.getMap('attachment').get('block') as never])[0];
      if (!parsed || parsed.type !== 'file' || !parsed.encryption) throw new Error('manifest lost');
      // Epoch is deliberately absent from the file-key context: retained history owns its key.
      expect(await read(f.objects, parsed.encryption)).toEqual(Buffer.from(f.source));
    } finally {
      a.free();
      b.free();
    }
  });

  it('retains caller sources on upload failure, and retries with a fresh key', async () => {
    const source = new Uint8Array([1, 2, 3]);
    let firstCiphertext: Uint8Array | undefined;
    const args = {
      ...context,
      kind: 'file' as const,
      fileName: 'private',
      mimeType: 'text/plain',
      sizeBytes: 3,
      read: async () => source.slice(),
    };
    await expect(
      uploadEncryptedAttachment({
        ...args,
        upload: async (bytes) => {
          firstCiphertext = bytes;
          throw new Error('offline');
        },
      })
    ).rejects.toThrow('offline');
    let secondCiphertext: Uint8Array | undefined;
    await uploadEncryptedAttachment({
      ...args,
      upload: async (bytes) => {
        secondCiphertext = bytes;
        return 'retry';
      },
    });
    expect(source).toEqual(new Uint8Array([1, 2, 3]));
    expect(secondCiphertext).not.toEqual(firstCiphertext);
  });
});
