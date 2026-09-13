import { describe, expect, it } from 'vitest';
import {
  SHARE_LIMITS,
  SharePackageManifestSchema,
  encodeShareJson,
  shareManifestKey,
  shareObjectDigest,
  shareObjectKey,
  validateShareHistory,
  verifyShareObject,
} from '../src/session-share-package';

const digest = '0'.repeat(64);
function manifest() {
  return {
    formatVersion: 1,
    historyFormatVersion: 1,
    capturedAt: '2026-09-12T00:00:00.000Z',
    rootConversationId: 'c1',
    conversations: [
      { id: 'c1', title: 'Root', historyObjectId: 'h1' },
      { id: 'c2', title: 'Tab', historyObjectId: 'h2', parentConversationId: 'c1' },
      { id: 'c3', title: 'Opened', historyObjectId: 'h3', openedByConversationId: 'c2' },
    ],
    attachments: [{ id: 'a1', kind: 'image', fileName: 'image.png', objectId: 'a1' }],
    objects: [
      ...['h1', 'h2', 'h3'].map((id) => ({
        id,
        mediaType: 'application/json',
        sizeBytes: 2,
        sha256: digest,
      })),
      { id: 'a1', mediaType: 'image/png', sizeBytes: 2, sha256: digest },
    ],
  };
}

describe('static share package', () => {
  it('keeps exact opener separate from tab ownership without source identities', () => {
    const parsed = SharePackageManifestSchema.parse(manifest());
    expect(parsed.conversations[1]?.parentConversationId).toBe('c1');
    expect(parsed.conversations[2]?.openedByConversationId).toBe('c2');
    expect(parsed.objects).toHaveLength(4);
  });

  it('rejects non-closed inventories, duplicate identities and invalid relationships', () => {
    const fixtures = [
      { ...manifest(), rootConversationId: 'not-selected' },
      { ...manifest(), workspaceId: 'source-workspace' },
      { ...manifest(), objects: manifest().objects.slice(1) },
      { ...manifest(), objects: [...manifest().objects, manifest().objects[0]] },
      {
        ...manifest(),
        objects: [
          ...manifest().objects,
          { id: 'hidden', mediaType: 'text/plain', sizeBytes: 0, sha256: digest },
        ],
      },
      { ...manifest(), attachments: [...manifest().attachments, manifest().attachments[0]] },
      {
        ...manifest(),
        conversations: [{ id: 'c1', title: '', historyObjectId: 'h1', parentConversationId: 'c1' }],
      },
      {
        ...manifest(),
        conversations: [
          { id: 'c1', title: '', historyObjectId: 'h1', openedByConversationId: 'missing' },
        ],
      },
      {
        ...manifest(),
        conversations: [
          { id: 'c1', title: '', historyObjectId: 'h1', childSessionPlacement: 'side-panel' },
        ],
      },
      { ...manifest(), formatVersion: 2 },
      { ...manifest(), historyFormatVersion: 2 },
    ];
    for (const value of fixtures)
      expect(SharePackageManifestSchema.safeParse(value).success).toBe(false);
  });

  it('rejects cycles in both relationship kinds', () => {
    for (const field of ['parentConversationId', 'openedByConversationId']) {
      const value = manifest();
      value.conversations = value.conversations.map((entry, index) => ({
        ...entry,
        [field]: `c${((index + 1) % 3) + 1}`,
      }));
      expect(SharePackageManifestSchema.safeParse(value).success).toBe(false);
    }
  });

  it('enforces history and package byte limits', () => {
    const value = manifest();
    value.objects[0]!.sizeBytes = SHARE_LIMITS.historyBytes + 1;
    expect(SharePackageManifestSchema.safeParse(value).success).toBe(false);
    expect(() => encodeShareJson({ text: '中' }, 4)).toThrow('size limit');
  });

  it('rejects mixed ownership/opener cycles and unsupported nested Tabs', () => {
    const value = manifest();
    value.conversations[0] = {
      id: 'c1',
      title: 'Root',
      historyObjectId: 'h1',
      openedByConversationId: 'c2',
    };
    expect(SharePackageManifestSchema.safeParse(value).success).toBe(false);
    value.conversations[0] = { id: 'c1', title: 'Root', historyObjectId: 'h1' };
    value.conversations[2] = {
      id: 'c3',
      title: 'Nested',
      historyObjectId: 'h3',
      parentConversationId: 'c2',
    };
    expect(SharePackageManifestSchema.safeParse(value).success).toBe(false);
  });

  it('preserves all materialized history, including system, thought and opaque extensions', () => {
    const history = [
      {
        id: 'm1',
        role: 'system',
        timestamp: '2026-09-12T00:00:00.000Z',
        finished: false,
        items: [
          { type: 'thought', text: 'synthetic reasoning' },
          {
            type: 'tool_call',
            rawInput: { command: 'pwd' },
            rawOutput: { text: '/synthetic' },
            _meta: { future: true },
          },
          { type: 'future_item', data: [1, null, false] },
        ],
        futureField: { nested: 'preserved' },
      },
    ];
    const bytes = encodeShareJson(validateShareHistory(history), SHARE_LIMITS.historyBytes);
    history[0]!.items[0]!.text = 'changed after capture';
    const captured = validateShareHistory(JSON.parse(new TextDecoder().decode(bytes)));
    expect(captured[0]?.items[0]?.text).toBe('synthetic reasoning');
    expect(captured[0]?.futureField).toEqual({ nested: 'preserved' });
    expect(captured[0]?.role).toBe('system');
    expect(captured[0]?.finished).toBe(false);
  });

  it('rejects non-JSON, excessive depth and duplicate message IDs without leaking content', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [cycle, { secret: undefined }, new Date(), { number: Infinity }]) {
      expect(() => encodeShareJson(value, 1024)).toThrow('Invalid share JSON');
    }
    let deep: unknown = 'synthetic-secret';
    for (let n = 0; n < 70; n++) deep = { child: deep };
    expect(() => encodeShareJson(deep, 1024)).toThrow('depth limit');
    expect(() =>
      validateShareHistory([
        { id: 'same', role: 'user', items: [] },
        { id: 'same', role: 'user', items: [] },
      ])
    ).toThrow('Invalid share history');
  });

  it('binds reads to exact byte length and digest', async () => {
    const bytes = encodeShareJson([], 100);
    const object = {
      id: 'h1',
      mediaType: 'application/json',
      sizeBytes: bytes.length,
      sha256: await shareObjectDigest(bytes),
    };
    await expect(verifyShareObject(bytes, object)).resolves.toBeUndefined();
    await expect(verifyShareObject(new TextEncoder().encode('{}'), object)).rejects.toThrow(
      'Invalid share object'
    );
    await expect(verifyShareObject(bytes, { ...object, sizeBytes: 9 })).rejects.toThrow(
      'Invalid share object'
    );
  });

  it('cannot select a source namespace or arbitrary object key', () => {
    expect(shareObjectKey('share', 'deployment', 'h1')).toBe('shares/share/deployment/objects/h1');
    expect(shareManifestKey('share', 'deployment')).toBe('shares/share/deployment/manifest.json');
    for (const value of ['../source', 'https://source', 'a/b', 'a%2fb', '']) {
      expect(() => shareObjectKey('share', 'deployment', value)).toThrow();
      expect(() => shareManifestKey(value, 'deployment')).toThrow();
    }
  });
});
