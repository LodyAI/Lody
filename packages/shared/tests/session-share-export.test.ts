import { describe, expect, it } from 'vitest';
import {
  prepareSharePackage as captureSharePackage,
  readPreparedShareHistory,
} from '../src/session-share-export';
import { verifyShareObject } from '../src/session-share-package';

const capturedAt = '2026-09-12T00:00:00.000Z';
// Retain coverage of the file-copy path for the future rollout.
const prepareSharePackage = (options: Parameters<typeof captureSharePackage>[0]) =>
  captureSharePackage({ ...options, fileAttachmentsEnabled: true });

it('omits file blocks by default without reading them, while still copying images', async () => {
  const file = history()[0]!.items[1]!;
  const source = [
    {
      id: 'm',
      role: 'user',
      items: [
        file,
        { type: 'image', imageId: 'image', mimeType: 'image/png' },
        { type: 'content', content: [{ ...file, transport: 'r2' }] },
      ],
      inputConfig: { inputBlocks: [file] },
    },
  ];
  const before = JSON.stringify(source);
  const reads: string[] = [];
  const prepared = await captureSharePackage({
    rootSourceId: 'root',
    capturedAt,
    conversations: [{ sourceId: 'root', title: '', history: source }],
    fileAttachmentOmissionText: '文件附件未包含在此次分享中',
    readAttachment: async ({ kind }) => {
      reads.push(kind);
      if (kind !== 'image') throw new Error('File must never be read');
      return { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' };
    },
  });
  expect(reads).toEqual(['image']);
  expect(prepared.manifest.attachments.map((a) => a.kind)).toEqual(['image']);
  expect(prepared.objects.size).toBe(2);
  expect(prepared.uncopiedResourceCount).toBe(3);
  const output = readPreparedShareHistory(prepared, 'c1');
  const notice = { type: 'text', text: '文件附件未包含在此次分享中' };
  expect(output[0]).toMatchObject({
    items: [notice, { type: 'image' }, { type: 'content', content: [notice] }],
    inputConfig: { inputBlocks: [notice] },
  });
  expect(JSON.stringify(output)).not.toMatch(/source-file|inherited-source|private.txt|report.txt/);
  expect(JSON.stringify(source)).toBe(before);
});
const history = () => [
  {
    id: 'm1',
    role: 'assistant',
    finished: false,
    items: [
      { type: 'thought', text: 'synthetic reasoning' },
      {
        type: 'file',
        fileId: 'source-file',
        storageSessionId: 'inherited-source',
        machineId: 'machine',
        sourcePath: '/source/private.txt',
        fileName: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: 3,
        transport: 'local',
        uploadedAt: 1,
      },
    ],
  },
];

describe('client static share export', () => {
  it('freezes all histories before attachment I/O and removes typed source selectors', async () => {
    const original = history();
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release!: (value: { bytes: Uint8Array; mediaType: string }) => void;
    const loaded = new Promise<{ bytes: Uint8Array; mediaType: string }>((resolve) => {
      release = resolve;
    });
    const pending = prepareSharePackage({
      rootSourceId: 'source-root',
      capturedAt,
      conversations: [{ sourceId: 'source-root', title: 'Published title', history: original }],
      readAttachment: async (source) => {
        expect(source.reference.storageSessionId).toBe('inherited-source');
        signalStarted();
        return loaded;
      },
    });
    await started;
    original[0]!.items[0]!.text = 'live edit';
    release({ bytes: new TextEncoder().encode('abc'), mediaType: 'text/plain' });
    const prepared = await pending;
    const exported = readPreparedShareHistory(prepared, 'c1');
    expect(exported[0]?.items[0]?.text).toBe('synthetic reasoning');
    expect(exported[0]?.finished).toBe(false);
    expect(exported[0]?.items[1]).toEqual({
      type: 'file',
      fileId: 'a1',
      fileName: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: 3,
      transport: 'r2',
      uploadedAt: 1,
    });
    expect(original[0]?.items[1]?.storageSessionId).toBe('inherited-source');
    expect(prepared.manifest.attachments[0]?.objectId).toBe('a1');
    for (const descriptor of prepared.manifest.objects) {
      await expect(
        verifyShareObject(prepared.objects.get(descriptor.id)!, descriptor)
      ).resolves.toBeUndefined();
    }
    expect(JSON.stringify(prepared.manifest)).not.toContain('source-root');
  });

  it('keeps per-share identities and exact opener across redeploys', async () => {
    const result = await prepareSharePackage({
      rootSourceId: 'root',
      capturedAt,
      previousSourceIds: [
        { sourceId: 'root', conversationId: 'c9' },
        { sourceId: 'removed', conversationId: 'c1' },
      ],
      conversations: [
        { sourceId: 'root', title: 'Root', history: [] },
        { sourceId: 'tab', title: 'Tab', parentSourceId: 'root', history: [] },
        { sourceId: 'opened', title: 'Opened', openedBySourceId: 'tab', history: [] },
        {
          sourceId: 'side',
          title: 'Side',
          parentSourceId: 'root',
          childSessionPlacement: 'side-panel',
          history: [],
        },
      ],
      readAttachment: async () => {
        throw new Error('Unexpected attachment');
      },
    });
    expect(result.manifest.conversations).toEqual([
      { id: 'c9', title: 'Root', historyObjectId: 'h1' },
      { id: 'c2', title: 'Tab', historyObjectId: 'h2', parentConversationId: 'c9' },
      { id: 'c3', title: 'Opened', historyObjectId: 'h3', openedByConversationId: 'c2' },
      {
        id: 'c4',
        title: 'Side',
        historyObjectId: 'h4',
        parentConversationId: 'c9',
        childSessionPlacement: 'side-panel',
      },
    ]);
  });

  it('does not leak unselected ancestors or fetch URLs from raw tool content', async () => {
    const rawInput = { type: 'file', fileId: 'private', url: 'https://example.invalid/source' };
    const result = await prepareSharePackage({
      rootSourceId: 'tab',
      capturedAt,
      conversations: [
        {
          sourceId: 'tab',
          title: 'Tab',
          parentSourceId: 'not-selected',
          childSessionPlacement: 'side-panel',
          history: [{ id: 'm', role: 'assistant', items: [{ type: 'tool_call', rawInput }] }],
        },
      ],
      readAttachment: async () => {
        throw new Error('Unexpected source read');
      },
    });
    expect(result.manifest.conversations[0]).toEqual({
      id: 'c1',
      title: 'Tab',
      historyObjectId: 'h1',
    });
    expect(readPreparedShareHistory(result, 'c1')[0]?.items[0]?.rawInput).toEqual(rawInput);
    expect(result.manifest.attachments).toEqual([]);
  });

  it('fails the entire preparation for an unreadable attachment or cancellation', async () => {
    const options = {
      rootSourceId: 'root',
      capturedAt,
      conversations: [{ sourceId: 'root', title: 'Root', history: history() }],
      readAttachment: async () => {
        throw new Error('Attachment unavailable');
      },
    };
    await expect(prepareSharePackage(options)).rejects.toThrow('Attachment unavailable');
    const controller = new AbortController();
    controller.abort();
    await expect(prepareSharePackage({ ...options, signal: controller.signal })).rejects.toThrow();
  });

  it('copies inputConfig inputBlocks with the same attachment mapping as visible items', async () => {
    const file = history()[0]!.items[1]!;
    const result = await prepareSharePackage({
      rootSourceId: 'root',
      capturedAt,
      conversations: [
        {
          sourceId: 'root',
          title: 'Root',
          history: [
            {
              id: 'm',
              role: 'user',
              items: [file],
              inputConfig: { inputBlocks: [file], modelId: 'synthetic' },
            },
          ],
        },
      ],
      readAttachment: async () => ({
        bytes: new TextEncoder().encode('abc'),
        mediaType: 'text/plain',
      }),
    });
    const entry = readPreparedShareHistory(result, 'c1')[0]!;
    expect(entry.inputConfig).toEqual({ inputBlocks: [entry.items[0]], modelId: 'synthetic' });
    expect(result.manifest.attachments).toHaveLength(1);
    expect(JSON.stringify(entry)).not.toContain('inherited-source');
    expect(JSON.stringify(entry)).not.toContain('/source/private.txt');
  });

  it('rejects attachment bytes which differ from the captured source checksum', async () => {
    const source = history();
    Object.assign(source[0]!.items[1]!, { sha256: '0'.repeat(64) });
    await expect(
      prepareSharePackage({
        rootSourceId: 'root',
        capturedAt,
        conversations: [{ sourceId: 'root', title: 'Root', history: source }],
        readAttachment: async () => ({
          bytes: new TextEncoder().encode('abc'),
          mediaType: 'text/plain',
        }),
      })
    ).rejects.toThrow('checksum mismatch');
  });
  it('discloses unsupported embedded resources without fetching or rewriting opaque history', async () => {
    const source = [
      {
        id: 'turn',
        role: 'assistant',
        items: [
          { type: 'text', text: '![remote](https://example.test/private.png)' },
          {
            type: 'tool_call',
            toolCallId: 'tool',
            content: [{ type: 'resource_link', uri: 'file:///private/data' }],
            rawOutput: { uri: 'https://do-not-fetch.test' },
          },
        ],
      },
    ];
    const prepared = await prepareSharePackage({
      rootSourceId: 'root',
      capturedAt,
      conversations: [{ sourceId: 'root', title: 'Root', history: source }],
      readAttachment: async () => {
        throw new Error('Arbitrary URI fetch');
      },
    });
    expect(prepared.uncopiedResourceCount).toBe(2);
    expect(prepared.manifest.attachments).toEqual([]);
    expect(readPreparedShareHistory(prepared, 'c1')).toEqual(source);
  });
});
