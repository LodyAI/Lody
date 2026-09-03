import { describe, expect, it } from 'vitest';
import type { MessageContent, SessionHistoryInput, SessionMeta } from '@lody/shared';
import { buildSessionArtifacts, toExportSessionSummary, toUserFacingAgentType } from './formatters';
import { buildTranscriptMarkdown } from './markdown';

const createSessionMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 'session-1',
  machineId: 'machine-1',
  createdAt: '2026-03-23T10:00:00.000Z',
  userId: 'user-1',
  cliType: 'builtin',
  agentType: 'claude',
  ...overrides,
});

const createHistoryEntry = (overrides: Partial<SessionHistoryInput> = {}): SessionHistoryInput => ({
  id: 'turn-1',
  role: 'assistant',
  timestamp: '2026-03-23T10:01:00.000Z',
  items: [],
  fileDiff: [],
  ...overrides,
});

describe('session export formatters', () => {
  it('normalizes agent labels for user-facing export', () => {
    expect(toUserFacingAgentType(createSessionMeta())).toBe('claude-code');
    expect(
      toUserFacingAgentType(
        createSessionMeta({
          cliType: 'registry',
          agentType: 'kimi',
        })
      )
    ).toBe('kimi');
  });

  it('builds export summary without internal agent ids', () => {
    const summary = toExportSessionSummary(
      createSessionMeta({
        title: '  Export me  ',
        repoFullName: 'loro-dev/lody',
        baseBranch: 'main',
        branchName: 'feat/export',
      }),
      'workspace-1'
    );

    expect(summary).toEqual({
      sessionId: 'session-1',
      title: 'Export me',
      createdAt: '2026-03-23T10:00:00.000Z',
      status: null,
      archived: false,
      workspaceId: 'workspace-1',
      agent: {
        type: 'claude-code',
      },
      project: undefined,
      repoFullName: 'loro-dev/lody',
      baseBranch: 'main',
      branchName: 'feat/export',
    });
  });

  it('extracts transcript artifacts, plans, tool calls, notices, and attachments', () => {
    const artifacts = buildSessionArtifacts([
      createHistoryEntry({
        id: 'turn-1',
        role: 'user',
        items: [
          { type: 'text', text: 'Ship the exporter' },
          {
            type: 'image',
            imageId: 'img-1',
            mimeType: 'image/png',
            fileName: 'spec.png',
            sizeBytes: 120,
          },
        ],
      }),
      createHistoryEntry({
        id: 'turn-2',
        role: 'assistant',
        items: [
          { type: 'thought', text: 'Need to gather session data first.' },
          {
            type: 'tool_call',
            toolCallId: 'tool-1',
            status: 'completed',
            kind: 'read',
            title: 'Read session schema',
            content: [
              { type: 'terminal_command', command: 'sed', args: ['-n', '1,10p', 'schema.ts'] },
              { type: 'diff', path: 'schema.ts', newText: 'hidden' },
            ],
          },
          {
            type: 'system_notice',
            name: 'chat_failed',
            meta: { reason: 'acp_unknown_error', message: 'Retry later' },
          },
        ],
        plan: [{ status: 'in_progress', content: 'Export sessions', priority: 'high' }],
      }),
    ]);

    expect(artifacts.transcript).toHaveLength(2);
    expect(artifacts.plans).toEqual([
      {
        turnId: 'turn-2',
        timestamp: '2026-03-23T10:01:00.000Z',
        entries: [{ status: 'in_progress', content: 'Export sessions', priority: 'high' }],
      },
    ]);
    expect(artifacts.toolCalls).toEqual([
      expect.objectContaining({
        turnId: 'turn-2',
        toolCallId: 'tool-1',
        kind: 'read',
        title: 'Read session schema',
        content: [{ type: 'terminal_command', command: 'sed', args: ['-n', '1,10p', 'schema.ts'] }],
      }),
    ]);
    expect(artifacts.systemNotices).toEqual([
      {
        turnId: 'turn-2',
        timestamp: '2026-03-23T10:01:00.000Z',
        role: 'assistant',
        name: 'chat_failed',
        meta: { reason: 'acp_unknown_error', message: 'Retry later' },
      },
    ]);
    expect(artifacts.attachments).toEqual([
      {
        imageId: 'img-1',
        mimeType: 'image/png',
        fileName: 'img-1.png',
        originalFileName: 'spec.png',
        sizeBytes: 120,
        width: null,
        height: null,
        sourceTurnIds: ['turn-1'],
        relativePath: 'artifacts/attachments/files/img-1.png',
      },
    ]);
    expect(artifacts.transcript[1]?.items).toEqual([
      { type: 'thought', text: 'Need to gather session data first.' },
      {
        type: 'tool_call',
        toolCallId: 'tool-1',
        status: 'completed',
        kind: 'read',
        title: 'Read session schema',
        content: [{ type: 'terminal_command', command: 'sed', args: ['-n', '1,10p', 'schema.ts'] }],
      },
      {
        type: 'system_notice',
        name: 'chat_failed',
        meta: { reason: 'acp_unknown_error', message: 'Retry later' },
      },
    ]);
  });

  it('encodes attachment file names derived from unsafe image ids', () => {
    const artifacts = buildSessionArtifacts([
      createHistoryEntry({
        items: [
          {
            type: 'image',
            imageId: '../escape',
            mimeType: 'image/png',
            fileName: 'spec.png',
            sizeBytes: 120,
          },
        ],
      }),
    ]);

    expect(artifacts.attachments).toEqual([
      expect.objectContaining({
        imageId: '../escape',
        fileName: '..%2Fescape.png',
        relativePath: 'artifacts/attachments/files/..%2Fescape.png',
      }),
    ]);
  });

  it('tolerates sealed tool_call skeletons without execution payload', () => {
    // Sealed turns persist only kind/status/title/locations/ref — no
    // toolCallId, content, rawInput, or rawOutput (see ToolCallRef).
    const skeleton = {
      type: 'tool_call',
      kind: 'execute',
      status: 'completed',
      title: 'Shell: ls',
      locations: [{ path: '/tmp/work' }],
      ref: { machineId: 'machine-1', turnId: 'turn-2', index: 0 },
    } as unknown as MessageContent;

    const artifacts = buildSessionArtifacts([
      createHistoryEntry({
        id: 'turn-2',
        role: 'assistant',
        items: [skeleton],
      }),
    ]);

    expect(artifacts.toolCalls).toEqual([
      {
        turnId: 'turn-2',
        timestamp: '2026-03-23T10:01:00.000Z',
        role: 'assistant',
        toolCallId: null,
        title: 'Shell: ls',
        kind: 'execute',
        status: 'completed',
        locations: [{ path: '/tmp/work' }],
        permissionRequest: undefined,
        content: [],
        rawInput: undefined,
        rawOutput: undefined,
        ref: { machineId: 'machine-1', turnId: 'turn-2', index: 0 },
      },
    ]);
    // The transcript copy keeps the skeleton and serializes cleanly.
    expect(artifacts.transcript[0]?.items).toEqual([{ ...skeleton, content: [] }]);
    expect(() => JSON.stringify(artifacts)).not.toThrow();
  });

  it('keeps old-shape tool call records byte-identical in serialized output', () => {
    const artifacts = buildSessionArtifacts([
      createHistoryEntry({
        id: 'turn-2',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tool-1',
            status: 'completed',
            kind: 'read',
            title: 'Read session schema',
            rawInput: { path: 'schema.ts' },
            rawOutput: { ok: true },
          },
        ],
      }),
    ]);

    expect(JSON.stringify(artifacts.toolCalls[0])).toBe(
      '{"turnId":"turn-2","timestamp":"2026-03-23T10:01:00.000Z","role":"assistant",' +
        '"toolCallId":"tool-1","title":"Read session schema","kind":"read","status":"completed",' +
        '"content":[],"rawInput":{"path":"schema.ts"},"rawOutput":{"ok":true}}'
    );
  });

  it('renders transcript markdown with thought blocks and attachment links', () => {
    const markdown = buildTranscriptMarkdown({
      session: toExportSessionSummary(createSessionMeta({ title: 'Exporter' }), 'workspace-1'),
      turns: [
        {
          turnId: 'turn-1',
          role: 'assistant',
          timestamp: '2026-03-23T10:01:00.000Z',
          finished: true,
          sendStatus: undefined,
          startedAt: null,
          endedAt: null,
          modelInfo: undefined,
          items: [
            { type: 'text', text: 'Implemented the command.' },
            { type: 'thought', text: 'Need to keep this independent.' },
            {
              type: 'image',
              imageId: 'img-1',
              mimeType: 'image/png',
              fileName: 'diagram.png',
              sizeBytes: 30,
            },
          ],
        },
      ],
      attachments: [
        {
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: 'img-1.png',
          originalFileName: 'diagram.png',
          sizeBytes: 30,
          width: null,
          height: null,
          sourceTurnIds: ['turn-1'],
          relativePath: 'artifacts/attachments/files/img-1.png',
        },
      ],
    });

    expect(markdown).toContain('# Exporter');
    expect(markdown).toContain('#### Thought');
    expect(markdown).toContain('Need to keep this independent.');
    expect(markdown).toContain('![diagram.png](artifacts/attachments/files/img-1.png)');
  });

  it('renders old-shape tool calls unchanged in transcript markdown', () => {
    const markdown = buildTranscriptMarkdown({
      session: toExportSessionSummary(createSessionMeta({ title: 'Exporter' }), 'workspace-1'),
      turns: [
        {
          turnId: 'turn-1',
          role: 'assistant',
          timestamp: '2026-03-23T10:01:00.000Z',
          finished: true,
          sendStatus: undefined,
          startedAt: null,
          endedAt: null,
          modelInfo: undefined,
          items: [
            {
              type: 'tool_call',
              toolCallId: 'tool-1',
              status: 'completed',
              kind: 'read',
              title: 'Read `schema.ts`',
            },
          ],
        },
      ],
      attachments: [],
    });

    expect(markdown).toContain(
      '#### Tool Call\n- id: `tool-1`\n- title: Read `schema.ts`\n- status: `completed`\n- kind: `read`'
    );
    expect(markdown).not.toContain('origin machine');
  });

  it('renders sealed tool_call skeletons in transcript markdown without an id', () => {
    const skeleton = {
      type: 'tool_call',
      kind: 'execute',
      status: 'completed',
      title: 'Shell: ls',
      ref: { machineId: 'machine-1', turnId: 'turn-1', index: 0 },
    } as unknown as MessageContent;
    const titleless = {
      type: 'tool_call',
      kind: 'read',
      status: 'completed',
      ref: { machineId: 'machine-1', turnId: 'turn-1', index: 1 },
    } as unknown as MessageContent;

    const markdown = buildTranscriptMarkdown({
      session: toExportSessionSummary(createSessionMeta({ title: 'Exporter' }), 'workspace-1'),
      turns: [
        {
          turnId: 'turn-1',
          role: 'assistant',
          timestamp: '2026-03-23T10:01:00.000Z',
          finished: true,
          sendStatus: undefined,
          startedAt: null,
          endedAt: null,
          modelInfo: undefined,
          items: [skeleton, titleless],
        },
      ],
      attachments: [],
    });

    expect(markdown).toContain(
      '#### Tool Call\n- title: Shell: ls\n- status: `completed`\n- kind: `execute`\n' +
        '- note: execution details stored on the origin machine'
    );
    // Without a title the kind line still identifies the tool.
    expect(markdown).toContain(
      '#### Tool Call\n- status: `completed`\n- kind: `read`\n' +
        '- note: execution details stored on the origin machine'
    );
    expect(markdown).not.toContain('- id:');
  });
});
