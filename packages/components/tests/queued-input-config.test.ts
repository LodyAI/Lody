import { describe, expect, it } from 'vitest';
import {
  buildSessionTurnInputConfig,
  normalizeSessionInputBlocks,
  normalizeSessionTurnInputConfig,
  type SessionInputBlock,
} from '@lody/shared';
import { buildQueuedInputConfig } from '../src/components/sessions/message-queue/queued-input-config';

const text = 'file https://example.com';
const fileSpan = { start: 0, end: 4, kind: 'file' as const, label: 'file', target: 'file' };
const inputBlocks: SessionInputBlock[] = [
  {
    type: 'text',
    text,
    spans: [
      fileSpan,
      { start: 5, end: text.length, kind: 'url', label: 'example', target: 'https://example.com' },
    ],
  },
  { type: 'image', imageId: 'synthetic-image', mimeType: 'image/png', sizeBytes: 12 },
  {
    type: 'file',
    fileId: 'synthetic-file',
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    sizeBytes: 16,
    sha256: 'a'.repeat(64),
    textPreview: false,
    transport: 'local',
    machineId: 'machine-1',
    uploadedAt: 1,
  },
];

describe('queued turn input compatibility', () => {
  it.each([
    undefined,
    { protocolCapabilities: { inlineReferences: 0 } },
    { protocolCapabilities: { inlineReferences: 1 } },
  ])('persists negotiated spans and promotes all attachments for %j', (machine) => {
    const inputConfig = buildSessionTurnInputConfig({
      machine,
      inputBlocks,
      cliType: 'builtin',
      agentType: 'codex',
      modeId: 'ask',
      modelId: 'model',
      configOptionValues: { enabled: true },
      mcpServerIds: [],
      taskToolsEnabled: false,
      agentRoleId: null,
      resume: 'session-1',
    });
    const queued = buildQueuedInputConfig(inputConfig);
    const expectedBlocks =
      machine?.protocolCapabilities.inlineReferences === 1
        ? inputBlocks
        : [{ ...inputBlocks[0], spans: [fileSpan] }, ...inputBlocks.slice(1)];
    expect(queued.inputBlocks).toEqual(expectedBlocks);
    expect(queued).toMatchObject({
      prompt: text,
      cliType: 'builtin',
      agentType: 'codex',
      modeId: 'ask',
      modelId: 'model',
      configOptionValues: { enabled: true },
      mcpServerIds: [],
      taskToolsEnabled: false,
      agentRoleId: null,
      resume: 'session-1',
      chainDepth: 0,
    });
    // Queue promotion reads persisted data back through the normal turn parser.
    const restored = normalizeSessionTurnInputConfig(JSON.parse(JSON.stringify(queued)));
    expect(restored).toBeDefined();
    expect(normalizeSessionInputBlocks(restored?.inputBlocks, restored?.prompt ?? '')).toEqual(
      expectedBlocks
    );
    expect(inputBlocks[0]).toMatchObject({ spans: [fileSpan, { kind: 'url' }] });
  });
});
