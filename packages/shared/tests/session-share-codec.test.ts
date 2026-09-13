import { it, expect } from 'vitest';
import { compress } from '@loro-dev/streams-crdt/zstd';
import { decodeShareHistoryBytes } from '../src/session-share-codec';
import {
  SharePackageManifestSchema,
  SHARE_LIMITS,
  type ShareObject,
} from '../src/session-share-package';

it('decodes real Zstd histories and rejects oversized, concatenated, truncated and wrong-size frames', async () => {
  const raw = new TextEncoder().encode(
    JSON.stringify([
      { id: 't', role: 'assistant', items: [{ type: 'text', text: 'hello'.repeat(40000) }] },
    ])
  );
  const bytes = await compress(raw);
  const descriptor: ShareObject = {
    id: 'h1',
    mediaType: 'application/json',
    sizeBytes: bytes.length,
    sha256: 'a'.repeat(64),
    contentEncoding: 'zstd',
    decodedSizeBytes: raw.length,
  };
  expect(decodeShareHistoryBytes(bytes, descriptor)).toEqual(raw);
  expect(() =>
    decodeShareHistoryBytes(bytes, { ...descriptor, decodedSizeBytes: raw.length - 1 })
  ).toThrow();
  expect(() =>
    decodeShareHistoryBytes(bytes, {
      ...descriptor,
      decodedSizeBytes: SHARE_LIMITS.historyBytes + 1,
    })
  ).toThrow();
  expect(() => decodeShareHistoryBytes(bytes.slice(0, -1), descriptor)).toThrow();
  const joined = new Uint8Array(bytes.length * 2);
  joined.set(bytes);
  joined.set(bytes, bytes.length);
  expect(() => decodeShareHistoryBytes(joined, descriptor)).toThrow();
  // Untrusted window descriptor must be rejected before fzstd allocates its window.
  const enormousWindow = new Uint8Array([
    0x28,
    0xb5,
    0x2f,
    0xfd,
    0x80,
    0xf8,
    ...new Uint8Array(new Uint32Array([raw.length]).buffer),
    1,
    0,
    0,
  ]);
  expect(() => decodeShareHistoryBytes(enormousWindow, descriptor)).toThrow();
});

it('binds compressed history sizes to version two and excludes compressed attachments', () => {
  const manifest = {
    formatVersion: 2,
    historyFormatVersion: 1,
    capturedAt: '2026-09-12T00:00:00.000Z',
    rootConversationId: 'c1',
    conversations: [{ id: 'c1', title: '', historyObjectId: 'h1' }],
    attachments: [],
    objects: [
      {
        id: 'h1',
        mediaType: 'application/json',
        sizeBytes: 100,
        sha256: 'a'.repeat(64),
        contentEncoding: 'zstd',
        decodedSizeBytes: 1000,
      },
    ],
  };
  expect(SharePackageManifestSchema.safeParse(manifest).success).toBe(true);
  expect(SharePackageManifestSchema.safeParse({ ...manifest, formatVersion: 1 }).success).toBe(
    false
  );
  expect(
    SharePackageManifestSchema.safeParse({
      ...manifest,
      objects: [{ ...manifest.objects[0], decodedSizeBytes: undefined }],
    }).success
  ).toBe(false);
  expect(
    SharePackageManifestSchema.safeParse({
      ...manifest,
      attachments: [{ id: 'a1', kind: 'image', fileName: '', objectId: 'h1' }],
    }).success
  ).toBe(false);
});
