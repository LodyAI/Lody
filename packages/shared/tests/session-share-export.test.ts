import { describe, expect, it } from 'vitest';
import { compress } from '@loro-dev/streams-crdt/zstd';
import { decodeShareHistoryBytes } from '../src/session-share-codec';
import {
  prepareSharePackage as captureSharePackage,
  type PreparedSharePackage,
} from '../src/session-share-export';
import { type ShareHistoryEntry, validateShareHistory } from '../src/session-share-package';

function readPreparedShareHistory(
  prepared: PreparedSharePackage,
  conversationId: string
): ShareHistoryEntry[] {
  const conversation = prepared.manifest.conversations.find((entry) => entry.id === conversationId);
  const bytes = conversation && prepared.objects.get(conversation.historyObjectId);
  if (!bytes) throw new Error('Share conversation unavailable');
  const descriptor = prepared.manifest.objects.find((o) => o.id === conversation.historyObjectId)!;
  return validateShareHistory(
    JSON.parse(new TextDecoder().decode(decodeShareHistoryBytes(bytes, descriptor)))
  );
}

const capturedAt = '2026-09-12T00:00:00.000Z';
it('removes task proposals without changing source or agent history', async () => {
  const proposal = {
    type: 'system_notice',
    name: 'task_proposal',
    meta: { taskId: 'private-task', title: 'Private proposal' },
    content: [{ type: 'image', imageId: 'private-image' }],
  };
  const kept = [
    { type: 'subagent_task', taskId: 'agent-work', status: 'completed' },
    { type: 'tool_call', rawOutput: proposal },
    { type: 'text', text: 'task_proposal is mentioned here' },
  ];
  const source = [
    {
      id: 'turn',
      role: 'system',
      items: [proposal, ...kept, { type: 'content', content: [proposal] }],
      inputConfig: { inputBlocks: [proposal] },
    },
  ];
  const before = JSON.stringify(source);
  expect(() => validateShareHistory(source)).toThrow('Task proposals');
  const prepared = await captureSharePackage({
    rootSourceId: 'root',
    capturedAt,
    conversations: [{ sourceId: 'root', title: 'Root', history: source }],
    readAttachment: async () => {
      throw new Error('Excluded proposal must not read attachments');
    },
  });
  expect(readPreparedShareHistory(prepared, 'c1')).toEqual([
    {
      id: 'turn',
      role: 'system',
      items: [...kept, { type: 'content', content: [] }],
      inputConfig: { inputBlocks: [] },
    },
  ]);
  expect(prepared.manifest.attachments).toEqual([]);
  expect(JSON.stringify(source)).toBe(before);
  for (const nested of [
    { items: [{ type: 'content', content: [proposal] }] },
    { items: [], inputConfig: { inputBlocks: [proposal] } },
  ])
    expect(() => validateShareHistory([{ id: 'turn', role: 'system', ...nested }])).toThrow(
      'Task proposals'
    );
});
const prepareSharePackage = captureSharePackage;

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
});

it('omits terminal output and runtime metadata without touching other content, actors or source', async () => {
  const source = [
    {
      id: 't',
      role: 'assistant',
      read: true,
      userId: 'private-user',
      acpTurnId: 'runtime-turn',
      userTurnId: 'runtime-user-turn',
      fileDiff: { unused: 'diff' },
      inputConfig: { agentRoleId: 'role-id', prompt: 'repeat', resume: { snapshot: 'large' } },
      items: [
        { type: 'text', text: 'Visible answer', actor: { kind: 'agent', name: 'Researcher' } },
        { type: 'thought', text: 'Reasoning' },
        {
          type: 'tool_call',
          title: 'build',
          rawOutput: { output: 'opaque result' },
          permissionRequest: { options: [] },
          content: [
            { type: 'terminal', terminalId: 'live-only' },
            { type: 'terminal_command', command: 'build' },
            {
              type: 'terminal_output',
              output: 'x'.repeat(8000) + 'FAILED',
              terminalId: 'live-only',
              exitStatus: { exitCode: 1 },
            },
          ],
        },
      ],
    },
  ];
  const before = structuredClone(source);
  const prepared = await captureSharePackage({
    rootSourceId: 'root',
    capturedAt,
    conversations: [{ sourceId: 'root', title: '', history: source }],
    compressHistory: compress,
    readAttachment: async () => {
      throw new Error('Unexpected read');
    },
  });
  const projected = readPreparedShareHistory(prepared, 'c1');
  expect(projected[0]).not.toHaveProperty('inputConfig');
  for (const key of ['read', 'userId', 'acpTurnId', 'userTurnId', 'fileDiff'])
    expect(projected[0]).not.toHaveProperty(key);
  expect(projected[0]!.role).toBe('assistant');
  expect(projected[0]!.items!.slice(0, 2)).toEqual(source[0]!.items.slice(0, 2));
  expect(projected[0]!.items![2]).toEqual({
    type: 'tool_call',
    title: 'build',
    rawOutput: { output: 'opaque result' },
    content: [{ type: 'terminal_command', command: 'build' }],
  });
  expect(source).toEqual(before);
  const descriptor = prepared.manifest.objects[0]!;
  expect(descriptor.contentEncoding).toBe('zstd');
  expect(descriptor.sizeBytes).toBeLessThan(descriptor.decodedSizeBytes!);
  const wire = JSON.parse(
    new TextDecoder().decode(
      decodeShareHistoryBytes(prepared.objects.get(descriptor.id)!, descriptor)
    )
  );
  expect(wire[0].items[2]).toEqual({
    type: 'tool_call',
    rawOutput: { output: 'opaque result' },
    content: [{ type: 'terminal_command', command: 'build' }],
  });
});

it('deduplicates shared attachment references across conversations', async () => {
  const active: string[] = [];
  const prepared = await captureSharePackage({
    rootSourceId: 's0',
    capturedAt,
    conversations: Array.from({ length: 4 }, (_, i) => ({
      sourceId: `s${i}`,
      title: '',
      history: [
        {
          id: 't',
          role: 'user',
          items: [
            { type: 'image', imageId: `i${i}` },
            { type: 'image', imageId: 'shared', storageSessionId: 's0' },
          ],
        },
      ],
    })),
    readAttachment: async ({ reference }) => {
      active.push(String(reference.imageId));
      return { bytes: new Uint8Array([active.length]), mediaType: 'image/png' };
    },
  });
  expect(active.filter((id) => id === 'shared')).toHaveLength(1);
  expect(prepared.manifest.attachments).toHaveLength(5);
  for (const c of prepared.manifest.conversations) {
    const projected = readPreparedShareHistory(prepared, c.id);
    expect(projected[0]!.items![1]!.imageId).toBe('a2');
  }
});

it('captures 64 distinct images but refuses a 65th before downloading', async () => {
  const conversations = [
    {
      sourceId: 'root',
      title: '',
      history: [
        {
          id: 't',
          role: 'user',
          items: Array.from({ length: 64 }, (_, i) => ({ type: 'image', imageId: `image${i}` })),
        },
      ],
    },
  ];
  let reads = 0;
  const readAttachment = async () => {
    reads++;
    return { bytes: new Uint8Array([1]), mediaType: 'image/png' };
  };
  const result = await captureSharePackage({
    rootSourceId: 'root',
    capturedAt,
    conversations,
    readAttachment,
  });
  expect(result.manifest.attachments).toHaveLength(64);
  expect(reads).toBe(64);
  conversations[0]!.history[0]!.items.push({ type: 'image', imageId: 'image64' });
  await expect(
    captureSharePackage({ rootSourceId: 'root', capturedAt, conversations, readAttachment })
  ).rejects.toThrow('Too many share attachments');
  expect(reads).toBe(64);
});

it('accepts a 20 MB image and refuses one extra byte', async () => {
  const conversations = [
    {
      sourceId: 'root',
      title: '',
      history: [{ id: 't', role: 'user', items: [{ type: 'image', imageId: 'image' }] }],
    },
  ];
  const bytes = new Uint8Array(20_000_001);
  const readAttachment = async () => ({
    bytes: bytes.subarray(0, 20_000_000),
    mediaType: 'image/png',
  });
  const result = await captureSharePackage({
    rootSourceId: 'root',
    capturedAt,
    conversations,
    readAttachment,
  });
  expect(result.manifest.objects.find((object) => object.id === 'a1')?.sizeBytes).toBe(20_000_000);
  await expect(
    captureSharePackage({
      rootSourceId: 'root',
      capturedAt,
      conversations,
      readAttachment: async () => ({ bytes, mediaType: 'image/png' }),
    })
  ).rejects.toThrow('Share image exceeds size limit');
});
