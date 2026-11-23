import { describe, expect, it } from 'vitest';
import {
  SHARE_LIMITS,
  assertShareAttachmentPolicy,
  SharePackageManifestSchema,
  captureShareHistory,
  encodeShareJson,
  validateShareHistory,
} from '../src/session-share-package';

const digest = '0'.repeat(64);
it('omits all typed terminal output and only deduplicates an exact first-command title', () => {
  const tools = [
    {
      type: 'tool_call',
      title: '构建 😀',
      content: [
        { type: 'terminal', terminalId: 'live' },
        { type: 'terminal_output', output: 'short', exitStatus: { exitCode: 0 } },
        { type: 'terminal_command', command: '构建 😀', cwd: '/project', args: [] },
        { type: 'terminal_output', output: 'long'.repeat(5000), truncated: true },
      ],
    },
    {
      type: 'tool_call',
      title: 'run build',
      content: [{ type: 'terminal_command', command: 'build' }],
    },
    {
      type: 'tool_call',
      title: 'build ',
      content: [{ type: 'terminal_command', command: 'build' }],
    },
    {
      type: 'tool_call',
      title: 'second',
      content: [
        { type: 'terminal_command', command: 'first' },
        { type: 'terminal_command', command: 'second' },
      ],
    },
    { type: 'tool_call', title: '', content: [{ type: 'terminal_command', command: '' }] },
    { type: 'tool_call', title: 'nonterminal', content: [{ type: 'content', text: 'keep' }] },
  ];
  const source = [
    {
      id: 't',
      role: 'assistant',
      items: tools,
      inputConfig: {
        inputBlocks: [
          {
            type: 'content',
            content: [
              { type: 'terminal_output', output: 'nested' },
              { type: 'text', text: 'keep' },
            ],
          },
        ],
      },
    },
  ];
  const before = structuredClone(source);
  const wire = captureShareHistory(source);
  expect(wire[0]!.items![0]).not.toHaveProperty('title');
  expect(wire[0]!.items![4]).not.toHaveProperty('title');
  expect(wire[0]!.items!.slice(1, 4)).toEqual(tools.slice(1, 4));
  expect(wire[0]!.items![5]).toEqual(tools[5]);
  expect(wire[0]!.items![0]!.content).toEqual([tools[0]!.content[2]]);
  expect(wire[0]!.inputConfig).toEqual({
    inputBlocks: [{ type: 'content', content: [{ type: 'text', text: 'keep' }] }],
  });
  const restored = validateShareHistory(JSON.parse(JSON.stringify(wire)));
  expect(restored[0]!.items!.map((item) => item.title)).toEqual(tools.map((item) => item.title));
  expect(validateShareHistory(restored)).toEqual(restored);
  expect(captureShareHistory(restored)).toEqual(wire);
  expect(source).toEqual(before);
  expect(wire[0]!.items![0]).not.toHaveProperty('title');
});

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
      { ...manifest(), formatVersion: 3 },
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
});

it('enforces new image limits without invalidating published packages or 32 MiB histories', () => {
  const value = manifest();
  value.attachments = Array.from({ length: 64 }, (_, i) => ({
    id: `a${i}`,
    kind: 'image',
    fileName: 'image.png',
    objectId: `a${i}`,
  }));
  value.objects = [
    ...value.objects.filter((object) => object.mediaType === 'application/json'),
    ...value.attachments.map((attachment, i) => ({
      id: attachment.objectId,
      mediaType: 'image/png',
      sizeBytes: i === 0 ? 20_000_000 : 1,
      sha256: digest,
    })),
  ];
  value.objects[0]!.sizeBytes = 32 * 1024 ** 2;
  const accepted = SharePackageManifestSchema.parse(value);
  expect(() => assertShareAttachmentPolicy(accepted)).not.toThrow();
  value.objects[3]!.sizeBytes = 20_000_001;
  const oldLargeImage = SharePackageManifestSchema.parse(value);
  expect(() => assertShareAttachmentPolicy(oldLargeImage)).toThrow(
    'Share image exceeds size limit'
  );
  value.objects[3]!.sizeBytes = 20_000_000;
  value.attachments.push({ id: 'a64', kind: 'image', fileName: 'image.png', objectId: 'a64' });
  value.objects.push({ id: 'a64', mediaType: 'image/png', sizeBytes: 1, sha256: digest });
  const oldManyImages = SharePackageManifestSchema.parse(value);
  expect(() => assertShareAttachmentPolicy(oldManyImages)).toThrow('Too many share attachments');
});
