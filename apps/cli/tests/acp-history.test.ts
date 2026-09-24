import { updateTestHistory } from './history-port-fixture';
import { describe, expect, it } from 'vitest';

import { LoroRepo } from 'loro-repo';
import { v4 as uuidv4 } from 'uuid';

import {
  applyMessageContentsBatch,
  ensurePermissionRequestOnToolCall,
  updatePermissionOutcomeInHistory,
} from '../src/lib/acp/history';
import {
  applyNotificationOnHistory,
  buildMessageContentFromNotification,
} from '../src/lib/acp/history-apply';
import { SessionDocument } from '../src/lib/loro/doc';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { MessageContent, SessionHistoryInput, SessionId, ToolCallContent } from '@lody/shared';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

describe('acp history batch', () => {
  it('merges text deltas into last assistant entry', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'assistant',
        items: [{ type: 'text', text: 'hello' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];
    const messages: MessageContent[] = [{ type: 'text', text: ' world' }];
    const result = applyMessageContentsBatch(history, messages);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    const text = parsed.find((m) => m.type === 'text') as Extract<MessageContent, { type: 'text' }>;
    expect(text.text).toBe('hello world');
  });

  it('does not merge AI text into a worktree script system entry', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'setup-1',
        role: 'system',
        items: [
          {
            type: 'worktree_script',
            phase: 'setup',
            status: 'completed',
            steps: [
              {
                command: 'pnpm install',
                status: 'completed',
                output: 'hello\n',
              },
            ],
          },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        endedAt: Date.now(),
        finished: true,
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const result = applyMessageContentsBatch(history, [{ type: 'text', text: 'AI response' }], {
      createId: () => 'ai-1',
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('setup-1');
    expect((result[0]!.items as unknown as MessageContent[]).map((item) => item.type)).toEqual([
      'worktree_script',
    ]);
    expect(result[1]!.id).toBe('ai-1');
    expect(result[1]!.items as unknown as MessageContent[]).toEqual([
      { type: 'text', text: 'AI response' },
    ]);
  });

  it('merges adjacent thought deltas but does not merge across text/thought boundary', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'assistant',
        items: [{ type: 'text', text: 'hello' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];
    const messages: MessageContent[] = [
      { type: 'thought', text: ' a' },
      { type: 'thought', text: ' b' },
      { type: 'text', text: ' world' },
    ];
    const result = applyMessageContentsBatch(history, messages);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    expect(parsed.map((m) => m.type)).toEqual(['text', 'thought', 'text']);
    const thought = parsed[1] as Extract<MessageContent, { type: 'thought' }>;
    expect(thought.text).toBe(' a b');
  });

  it('dedupes replayed thought chunks (retry/reconnect)', () => {
    const repeated = [
      'Creating PR and posting data\n',
      '\n',
      'I plan to use the command gh pr create --fill, but I also need to specify a body for it.\n',
      "After that, I'll retrieve the PR's URL, number, and branch.\n",
    ].join('');

    const history: SessionHistoryInput[] = [];
    const first = applyMessageContentsBatch(history, [{ type: 'thought', text: repeated }]);
    const second = applyMessageContentsBatch(first, [{ type: 'thought', text: repeated }]);

    const parsed = (second[0]!.items ?? []) as MessageContent[];
    const thought = parsed.find((m) => m.type === 'thought') as Extract<
      MessageContent,
      { type: 'thought' }
    >;
    expect(thought.text).toBe(repeated);
  });

  it('supports snapshot-style thought chunks (prefix snapshots)', () => {
    const history: SessionHistoryInput[] = [];
    const first = applyMessageContentsBatch(history, [{ type: 'thought', text: 'Hello' }]);
    const second = applyMessageContentsBatch(first, [{ type: 'thought', text: 'Hello world' }]);

    const parsed = (second[0]!.items ?? []) as MessageContent[];
    const thought = parsed.find((m) => m.type === 'thought') as Extract<
      MessageContent,
      { type: 'thought' }
    >;
    expect(thought.text).toBe('Hello world');
  });

  it('keeps a single assistant entry for tool calls within a turn', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'u1',
        role: 'user',
        items: [{ type: 'text', text: 'hi' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const messages: MessageContent[] = [
      { type: 'text', text: 'hello' },
      { type: 'tool_call', toolCallId: 'tc1', title: 'Do thing', status: 'pending', kind: 'read' },
      { type: 'text', text: ' world' },
    ];

    const result = applyMessageContentsBatch(history, messages);
    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe('assistant');
    const parsed = (result[1]!.items ?? []) as MessageContent[];
    expect(parsed.map((m) => m.type)).toEqual(['text', 'tool_call', 'text']);
  });

  it('preserves image and file block order in direct message-content batches', () => {
    const history: SessionHistoryInput[] = [];
    const messages: MessageContent[] = [
      { type: 'text', text: 'before' },
      {
        type: 'image_group',
        images: [
          {
            imageId: 'img-1',
            mimeType: 'image/png',
            fileName: 'diagram.png',
            sizeBytes: 12,
          },
        ],
      },
      {
        type: 'file',
        fileId: 'file-1',
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        sha256: '0'.repeat(64),
        textPreview: true,
        transport: 'r2',
        uploadedAt: 1,
      },
      { type: 'text', text: 'after' },
    ];

    const result = applyMessageContentsBatch(history, messages, {
      createId: () => 'assistant-1',
      now: () => '2026-06-22T00:00:00.000Z',
    });

    expect(result).toHaveLength(1);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    expect(parsed.map((m) => m.type)).toEqual(['text', 'image_group', 'file', 'text']);
  });

  it('updates an existing tool call without creating a new entry', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            title: 'Do thing',
            status: 'pending',
            kind: 'read',
          },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const messages: MessageContent[] = [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Do thing',
        status: 'completed',
        kind: 'read',
      },
    ];

    const result = applyMessageContentsBatch(history, messages);
    expect(result).toHaveLength(1);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    const tool = parsed.find((m) => m.type === 'tool_call') as Extract<
      MessageContent,
      { type: 'tool_call' }
    >;
    expect(tool.status).toBe('completed');
  });

  it('does not regress tool call status when retry tails arrive out of order', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            title: 'Do thing',
            status: 'in_progress',
            kind: 'read',
          },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const readStatus = (entries: SessionHistoryInput[]) => {
      const items = (entries[0]!.items ?? []) as MessageContent[];
      return items.find((item) => item.type === 'tool_call')?.status;
    };

    const afterPendingReplay = applyMessageContentsBatch(history, [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Do thing',
        status: 'pending',
        kind: 'read',
      },
    ]);
    const statusAfterPendingReplay = readStatus(afterPendingReplay);
    const afterCompletion = applyMessageContentsBatch(afterPendingReplay, [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Do thing',
        status: 'completed',
        kind: 'read',
      },
    ]);
    const statusAfterCompletion = readStatus(afterCompletion);
    const afterProgressReplay = applyMessageContentsBatch(afterCompletion, [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Do thing',
        status: 'in_progress',
        kind: 'read',
      },
    ]);
    expect([
      statusAfterPendingReplay,
      statusAfterCompletion,
      readStatus(afterProgressReplay),
    ]).toEqual(['in_progress', 'completed', 'completed']);
  });

  it('does not reorder when plan updates are interleaved', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'u1',
        role: 'user',
        items: [{ type: 'text', text: 'hi' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const messages: MessageContent[] = [
      { type: 'text', text: 'hello' },
      { type: 'plan', entries: [{ content: 'a', priority: 'low', status: 'pending' }] },
      { type: 'text', text: ' world' },
      { type: 'plan', entries: [{ content: 'b', priority: 'high', status: 'completed' }] },
    ];

    const result = applyMessageContentsBatch(history, messages);
    expect(result).toHaveLength(2);
    const parsed = (result[1]!.items ?? []) as MessageContent[];
    // Plan is now stored on entry.plan, not in items
    expect(parsed.map((m) => m.type)).toEqual(['text']);

    const text = parsed[0] as Extract<MessageContent, { type: 'text' }>;
    expect(text.text).toBe('hello world');

    // Plan is stored on the entry itself
    expect(result[1]!.plan).toEqual([{ content: 'b', status: 'completed', priority: 'high' }]);
  });

  it('creates new entries with items', () => {
    const history: SessionHistoryInput[] = [];
    const messages: MessageContent[] = [{ type: 'text', text: 'hello' }];
    const result = applyMessageContentsBatch(history, messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.items).toBeDefined();
  });

  it('creates new assistant entry if last is not assistant', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'user',
        items: [{ type: 'text', text: 'hi' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];
    const messages: MessageContent[] = [{ type: 'text', text: 'response' }];
    const result = applyMessageContentsBatch(history, messages);
    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe('assistant');
  });

  it('allows injecting deterministic ids and timestamps', () => {
    const history: SessionHistoryInput[] = [];
    const messages: MessageContent[] = [{ type: 'text', text: 'hello' }];
    const result = applyMessageContentsBatch(history, messages, {
      createId: () => 'fixed-id',
      now: () => '2020-01-01T00:00:00.000Z',
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('fixed-id');
    expect(result[0]!.timestamp).toBe('2020-01-01T00:00:00.000Z');
  });

  it('upserts streamed proposed plan snapshots by Codex turn id', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'assistant-turn',
        role: 'assistant',
        items: [] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const first = applyMessageContentsBatch(
      history,
      [
        {
          type: 'proposed_plan',
          turnId: 'codex-turn-1',
          markdown: '- Inspect',
          status: 'delta',
          isLatest: true,
        },
      ],
      { targetAssistantEntryId: 'assistant-turn' }
    );
    const second = applyMessageContentsBatch(
      first,
      [
        {
          type: 'proposed_plan',
          turnId: 'codex-turn-1',
          markdown: '- Inspect\n- Implement',
          status: 'completed',
          isLatest: true,
        },
      ],
      { targetAssistantEntryId: 'assistant-turn' }
    );

    const items = (second[0]!.items ?? []) as MessageContent[];
    expect(items).toMatchObject([
      {
        type: 'proposed_plan',
        turnId: 'codex-turn-1',
        markdown: '- Inspect\n- Implement',
        status: 'completed',
      },
    ]);
  });

  it('can target an existing assistant entry that is not the latest history entry', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'assistant-turn',
        role: 'assistant',
        items: [{ type: 'text', text: 'working' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
      {
        id: 'queued-user',
        role: 'user',
        items: [{ type: 'text', text: 'queued' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const result = applyMessageContentsBatch(
      history,
      [
        {
          type: 'proposed_plan',
          turnId: 'codex-turn-1',
          markdown: '- Stream plan',
          status: 'delta',
          isLatest: true,
        },
      ],
      { targetAssistantEntryId: 'assistant-turn' }
    );

    expect(result).toHaveLength(2);
    const assistantItems = (result[0]!.items ?? []) as MessageContent[];
    const userItems = (result[1]!.items ?? []) as MessageContent[];
    expect(assistantItems.map((item) => item.type)).toEqual(['text', 'proposed_plan']);
    expect(userItems.map((item) => item.type)).toEqual(['text']);
  });

  it('updates the last matching tool call when duplicate ids exist across entries', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'assistant',
        items: [
          { type: 'tool_call', toolCallId: 'tc1', title: 'first', status: 'pending', kind: 'read' },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
      {
        id: 'h2',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            title: 'second',
            status: 'pending',
            kind: 'read',
          },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const messages: MessageContent[] = [
      { type: 'tool_call', toolCallId: 'tc1', title: 'update', status: 'completed', kind: 'read' },
    ];

    const result = applyMessageContentsBatch(history, messages);
    const firstItems = (result[0]!.items ?? []) as MessageContent[];
    const secondItems = (result[1]!.items ?? []) as MessageContent[];

    const firstTool = firstItems[0] as Extract<MessageContent, { type: 'tool_call' }>;
    const secondTool = secondItems[0] as Extract<MessageContent, { type: 'tool_call' }>;

    expect(firstTool.status).toBe('pending');
    expect(secondTool.status).toBe('completed');
  });

  it('does not persist diff blocks for edit tool calls', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            title: 'Edit file',
            status: 'pending',
            kind: 'edit',
            content: [
              { type: 'terminal_command', command: 'apply_patch', args: ['...'] },
              { type: 'diff', path: 'a.txt', oldText: 'old', newText: 'new' },
              { type: 'terminal_output', output: 'Success\n', stream: 'combined' },
              { type: 'content', content: { type: 'text', text: 'some extra' } },
            ] satisfies ToolCallContent[],
          },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const result = applyMessageContentsBatch(history, [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Edit file',
        status: 'completed',
        kind: 'edit',
        content: [{ type: 'diff', path: 'a.txt', oldText: 'old2', newText: 'new2' }],
      },
    ]);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    const tool = parsed[0] as Extract<MessageContent, { type: 'tool_call' }>;
    const merged = tool.content ?? [];
    expect(merged.some((c) => c.type === 'diff')).toBe(false);
    expect(merged.some((c) => c.type === 'content')).toBe(false);
    expect(merged.some((c) => c.type === 'terminal_command')).toBe(true);
    expect(merged.some((c) => c.type === 'terminal_output')).toBe(true);
  });

  it('replaces terminal output when a newer output arrives', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            title: 'Run',
            status: 'pending',
            kind: 'execute',
            content: [
              { type: 'terminal_output', output: 'old', stream: 'combined' },
              { type: 'terminal_command', command: 'echo', args: ['old'] },
            ] satisfies ToolCallContent[],
          },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const messages: MessageContent[] = [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Run',
        status: 'pending',
        kind: 'execute',
        content: [
          { type: 'terminal_output', output: 'new', stream: 'combined' },
        ] satisfies ToolCallContent[],
      },
    ];

    const result = applyMessageContentsBatch(history, messages);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    const tool = parsed[0] as Extract<MessageContent, { type: 'tool_call' }>;
    const merged = tool.content ?? [];
    expect(merged.filter((c) => c.type === 'terminal_output')).toHaveLength(1);
    const out = merged.find((c) => c.type === 'terminal_output') as Extract<
      ToolCallContent,
      { type: 'terminal_output' }
    >;
    expect(out.output).toBe('new');
  });

  it('replaces terminal command when a newer command arrives', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            title: 'Run',
            status: 'pending',
            kind: 'execute',
            content: [
              { type: 'terminal_command', command: 'echo', args: ['old'] },
              { type: 'terminal_output', output: 'out', stream: 'combined' },
            ] satisfies ToolCallContent[],
          },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    const messages: MessageContent[] = [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Run',
        status: 'pending',
        kind: 'execute',
        content: [
          { type: 'terminal_command', command: 'echo', args: ['new'] },
        ] satisfies ToolCallContent[],
      },
    ];

    const result = applyMessageContentsBatch(history, messages);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    const tool = parsed[0] as Extract<MessageContent, { type: 'tool_call' }>;
    const merged = tool.content ?? [];
    expect(merged.filter((c) => c.type === 'terminal_command')).toHaveLength(1);
    const cmd = merged.find((c) => c.type === 'terminal_command') as Extract<
      ToolCallContent,
      { type: 'terminal_command' }
    >;
    expect(cmd.args).toEqual(['new']);
    expect(merged.some((c) => c.type === 'terminal_output')).toBe(true);
  });

  it('drops fenced tool content snapshots when terminal output exists', () => {
    const history: SessionHistoryInput[] = [];
    const messages: MessageContent[] = [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Run',
        status: 'pending',
        kind: 'execute',
        content: [
          { type: 'terminal_output', output: 'out\n', stream: 'combined' },
          {
            type: 'content',
            content: { type: 'text', text: '```sh\nout\n```\n' },
          },
        ] as unknown as ToolCallContent[],
      },
    ];

    const result = applyMessageContentsBatch(history, messages);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    const tool = parsed[0] as Extract<MessageContent, { type: 'tool_call' }>;
    const merged = tool.content ?? [];
    expect(merged.some((c) => c.type === 'content')).toBe(false);
    expect(merged.some((c) => c.type === 'terminal_output')).toBe(true);
  });

  it('does not persist read file contents in history', () => {
    const history: SessionHistoryInput[] = [];
    const messages: MessageContent[] = [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Read file',
        status: 'completed',
        kind: 'read',
        content: [
          { type: 'terminal_command', command: 'sed', args: ['-n', '1,10p', 'file.txt'] },
          { type: 'terminal_output', output: 'hello\n', stream: 'combined' },
          { type: 'content', content: { type: 'text', text: 'hello\n' } },
          { type: 'content', content: { type: 'text', text: 'hello\n' } },
        ] as unknown as ToolCallContent[],
      },
    ];

    const result = applyMessageContentsBatch(history, messages);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    const tool = parsed[0] as Extract<MessageContent, { type: 'tool_call' }>;
    const merged = tool.content ?? [];
    expect(merged.some((c) => c.type === 'terminal_command')).toBe(true);
    expect(merged.some((c) => c.type === 'terminal_output')).toBe(false);
    expect(merged.some((c) => c.type === 'content')).toBe(false);
  });

  it('compacts execute output snapshots into a single terminal_output block', () => {
    const history: SessionHistoryInput[] = [];
    const messages: MessageContent[] = [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Run',
        status: 'pending',
        kind: 'execute',
        content: [
          { type: 'content', content: { type: 'text', text: '```sh\nfirst\n```\n' } },
          { type: 'content', content: { type: 'text', text: '```sh\nfirst\nsecond\n```\n' } },
        ] as unknown as ToolCallContent[],
      },
    ];

    const result = applyMessageContentsBatch(history, messages);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    const tool = parsed[0] as Extract<MessageContent, { type: 'tool_call' }>;
    const merged = tool.content ?? [];
    expect(merged.filter((c) => c.type === 'terminal_output')).toHaveLength(1);
    expect(merged.some((c) => c.type === 'content')).toBe(false);
    const out = merged.find((c) => c.type === 'terminal_output') as Extract<
      ToolCallContent,
      { type: 'terminal_output' }
    >;
    expect(out.output).toBe('first\nsecond');
  });

  it('merges execute output snapshots across updates without duplicating blocks', () => {
    const first = applyMessageContentsBatch(
      [],
      [
        {
          type: 'tool_call',
          toolCallId: 'tc1',
          title: 'Run',
          status: 'pending',
          kind: 'execute',
          content: [
            { type: 'content', content: { type: 'text', text: '```sh\nfirst\n```\n' } },
          ] as unknown as ToolCallContent[],
        },
      ]
    );

    const second = applyMessageContentsBatch(first, [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Run',
        status: 'pending',
        kind: 'execute',
        content: [
          { type: 'content', content: { type: 'text', text: '```sh\nfirst\nsecond\n```\n' } },
        ] as unknown as ToolCallContent[],
      },
    ]);

    const parsed = (second[0]!.items ?? []) as MessageContent[];
    const tool = parsed[0] as Extract<MessageContent, { type: 'tool_call' }>;
    const merged = tool.content ?? [];
    expect(merged.filter((c) => c.type === 'terminal_output')).toHaveLength(1);
    const out = merged.find((c) => c.type === 'terminal_output') as Extract<
      ToolCallContent,
      { type: 'terminal_output' }
    >;
    expect(out.output).toBe('first\nsecond');
  });

  it('does not persist large read outputs in history', () => {
    const huge = 'x'.repeat(5_000);
    const history: SessionHistoryInput[] = [];
    const messages: MessageContent[] = [
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Read big',
        status: 'completed',
        kind: 'read',
        content: [
          { type: 'terminal_output', output: huge, stream: 'combined' },
        ] satisfies ToolCallContent[],
      },
    ];

    const result = applyMessageContentsBatch(history, messages);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    const tool = parsed[0] as Extract<MessageContent, { type: 'tool_call' }>;
    const merged = tool.content ?? [];
    expect(merged.some((c) => c.type === 'terminal_output')).toBe(false);
  });

  it('replaces plan in-place when there is already a plan on the entry', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'assistant',
        items: [{ type: 'text', text: 'hello' }] satisfies MessageContent[],
        // Plan is now stored on the entry, not in items
        plan: [{ content: 'a', status: 'pending', priority: 'low' }],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];
    const messages: MessageContent[] = [
      { type: 'plan', entries: [{ content: 'b', status: 'completed', priority: 'high' }] },
    ];
    const result = applyMessageContentsBatch(history, messages);
    const parsed = (result[0]!.items ?? []) as MessageContent[];
    // Items should only contain text, not plan
    expect(parsed.map((m) => m.type)).toEqual(['text']);
    // Plan is stored on the entry itself and should be updated
    expect(result[0]!.plan).toEqual([{ content: 'b', status: 'completed', priority: 'high' }]);
  });

  it('never stores plan items in contents array - plan must be a separate field', () => {
    const history: SessionHistoryInput[] = [];
    const messages: MessageContent[] = [
      { type: 'text', text: 'Starting task' },
      {
        type: 'plan',
        entries: [
          { content: 'Step 1', priority: 'high', status: 'pending' },
          { content: 'Step 2', priority: 'medium', status: 'pending' },
          { content: 'Step 3', priority: 'low', status: 'pending' },
        ],
      },
      { type: 'text', text: ' - here is the plan' },
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        title: 'Do work',
        status: 'pending',
        kind: 'execute',
      },
      {
        type: 'plan',
        entries: [
          { content: 'Step 1', priority: 'high', status: 'completed' },
          { content: 'Step 2', priority: 'medium', status: 'in_progress' },
          { content: 'Step 3', priority: 'low', status: 'pending' },
        ],
      },
    ];

    const result = applyMessageContentsBatch(history, messages);
    expect(result).toHaveLength(1);

    // Verify items (contents) only contain non-plan content types
    const items = (result[0]!.items ?? []) as MessageContent[];
    const itemTypes = items.map((m) => m.type);
    expect(itemTypes).not.toContain('plan');
    expect(itemTypes).toEqual(['text', 'tool_call']);

    // Verify text was merged correctly
    const textItem = items[0] as Extract<MessageContent, { type: 'text' }>;
    expect(textItem.text).toBe('Starting task - here is the plan');

    // Verify plan is stored as a separate field on the entry (not in items)
    expect(result[0]!.plan).toBeDefined();
    expect(result[0]!.plan).toHaveLength(3);

    // Verify plan was updated to the latest snapshot
    expect(result[0]!.plan).toEqual([
      { content: 'Step 1', priority: 'high', status: 'completed' },
      { content: 'Step 2', priority: 'medium', status: 'in_progress' },
      { content: 'Step 3', priority: 'low', status: 'pending' },
    ]);
  });
});

describe('acp history permission', () => {
  it('merges permission request and outcome onto tool call', async () => {
    const logger = createSilentLogger();
    const sessionId = uuidv4() as SessionId;
    const repo = await LoroRepo.create({});
    const doc = new SessionDocument(repo, sessionId);

    const initialHistory: SessionHistoryInput[] = [
      {
        id: 'h1',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            title: 'Read file',
            status: 'pending',
            kind: 'read',
          },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    await doc.initOffline();
    await updateTestHistory(doc, () => initialHistory);

    try {
      const request: RequestPermissionRequest = {
        sessionId,
        options: [
          {
            kind: 'allow_once',
            name: 'Allow once',
            optionId: 'opt1',
          },
        ],
        toolCall: {
          toolCallId: 'tc1',
          title: 'Read file',
          status: 'in_progress',
          kind: 'read',
        },
        _meta: {
          claudeCode: {
            requestType: 'askUserQuestion',
            askUserQuestion: {
              version: 1,
              allowCustomAnswer: true,
              questions: [
                {
                  question: 'Which database should we use?',
                  header: 'Database',
                  options: [{ label: 'Postgres', description: 'Use PostgreSQL' }],
                  multiSelect: false,
                },
              ],
            },
          },
        },
      } as RequestPermissionRequest;

      await expect(ensurePermissionRequestOnToolCall(doc, 'req1', request)).resolves.toBe(true);

      let history = await doc.sessionData.history.readAll();
      expect(history).toHaveLength(1);
      let contents = (history[0]!.items ?? []) as MessageContent[];
      const toolCall = contents[0] as Extract<MessageContent, { type: 'tool_call' }>;
      expect(toolCall.permissionRequest?.requestId).toBe('req1');
      expect(toolCall.permissionRequest?._meta).toEqual((request as { _meta?: unknown })._meta);

      const outcome: RequestPermissionResponse['outcome'] = {
        outcome: 'selected',
        optionId: 'opt1',
      };
      await updatePermissionOutcomeInHistory(doc, 'req1', outcome, logger);

      history = await doc.sessionData.history.readAll();
      contents = (history[0]!.items ?? []) as MessageContent[];
      const updated = contents[0] as Extract<MessageContent, { type: 'tool_call' }>;
      expect(updated.permissionRequest?.outcome).toEqual(outcome);
    } finally {
      await repo.destroy();
    }
  });

  it('attaches permission request to active assistant entry when tool call has not arrived yet', async () => {
    const sessionId = uuidv4() as SessionId;
    const repo = await LoroRepo.create({});
    const doc = new SessionDocument(repo, sessionId);

    const initialHistory: SessionHistoryInput[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        items: [{ type: 'text', text: 'working' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    await doc.initOffline();
    await updateTestHistory(doc, () => initialHistory);

    try {
      const request: RequestPermissionRequest = {
        sessionId,
        options: [
          {
            kind: 'allow_once',
            name: 'Allow once',
            optionId: 'opt1',
          },
        ],
        toolCall: {
          toolCallId: 'tc_late',
          title: 'Read file',
          status: 'pending',
          kind: 'read',
        },
      };

      await expect(ensurePermissionRequestOnToolCall(doc, 'req1', request)).resolves.toBe(true);

      let history = await doc.sessionData.history.readAll();
      expect(history).toHaveLength(1);
      expect(history[0]!.id).toBe('turn-1');
      let contents = (history[0]!.items ?? []) as MessageContent[];
      expect(contents.map((item) => item.type)).toEqual(['text', 'tool_call']);

      let toolCall = contents[1] as Extract<MessageContent, { type: 'tool_call' }>;
      expect(toolCall.toolCallId).toBe('tc_late');
      expect(toolCall.permissionRequest?.requestId).toBe('req1');

      await updateTestHistory(doc, (currentHistory) =>
        applyMessageContentsBatch(currentHistory, [
          {
            type: 'tool_call',
            toolCallId: 'tc_late',
            title: 'Read file result',
            status: 'completed',
            kind: 'read',
          },
        ])
      );

      history = await doc.sessionData.history.readAll();
      expect(history).toHaveLength(1);
      expect(history[0]!.id).toBe('turn-1');
      contents = (history[0]!.items ?? []) as MessageContent[];
      toolCall = contents[1] as Extract<MessageContent, { type: 'tool_call' }>;
      expect(toolCall.title).toBe('Read file result');
      expect(toolCall.status).toBe('completed');
      expect(toolCall.permissionRequest?.requestId).toBe('req1');
    } finally {
      await repo.destroy();
    }
  });

  it('does not create a fallback assistant entry when no active assistant entry exists', async () => {
    const sessionId = uuidv4() as SessionId;
    const repo = await LoroRepo.create({});
    const doc = new SessionDocument(repo, sessionId);

    await doc.initOffline();
    await updateTestHistory(doc, () => [
      {
        id: 'user-1',
        role: 'user',
        items: [{ type: 'text', text: 'hello' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: true,
        userId: 'user-1',
        fileDiff: [],
        finished: true,
      },
    ]);

    try {
      const request: RequestPermissionRequest = {
        sessionId,
        options: [
          {
            kind: 'allow_once',
            name: 'Allow once',
            optionId: 'opt1',
          },
        ],
        toolCall: {
          toolCallId: 'tc_missing_turn',
          title: 'Read file',
          status: 'pending',
          kind: 'read',
        },
      };

      await expect(ensurePermissionRequestOnToolCall(doc, 'req1', request)).resolves.toBe(false);

      const history = await doc.sessionData.history.readAll();
      expect(history).toHaveLength(1);
      expect(history[0]!.role).toBe('user');
    } finally {
      await repo.destroy();
    }
  });

  it('does not persist edit diffs (old/new text) from permission requests', async () => {
    const logger = createSilentLogger();
    const sessionId = uuidv4() as SessionId;
    const repo = await LoroRepo.create({});
    const doc = new SessionDocument(repo, sessionId);

    await doc.initOffline();
    await updateTestHistory(doc, () => [
      {
        id: 'turn-1',
        role: 'assistant',
        items: [],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ]);

    try {
      const oldSentinel = 'PERM_SENTINEL_OLD_6d0e4de7';
      const newSentinel = 'PERM_SENTINEL_NEW_7e188c44';
      const oldText = `${oldSentinel}\nline1\n`;
      const newText = `${newSentinel}\nline1\nline2\n`;

      const request: RequestPermissionRequest = {
        sessionId,
        options: [
          {
            kind: 'allow_once',
            name: 'Allow once',
            optionId: 'opt1',
          },
        ],
        toolCall: {
          toolCallId: 'tc_edit_1',
          title: 'Edit /tmp/example.txt',
          status: 'in_progress',
          kind: 'edit',
          content: [
            {
              type: 'diff',
              path: '/tmp/example.txt',
              oldText,
              newText,
            },
          ],
          locations: [{ path: '/tmp/example.txt' }],
        },
      };

      await expect(ensurePermissionRequestOnToolCall(doc, 'req1', request)).resolves.toBe(true);

      const history = await doc.sessionData.history.readAll();
      expect(history).toHaveLength(1);
      expect(history[0]!.id).toBe('turn-1');
      const contents = (history[0]!.items ?? []) as MessageContent[];
      const toolCall = contents[0] as Extract<MessageContent, { type: 'tool_call' }>;

      expect(toolCall.permissionRequest?.requestId).toBe('req1');
      expect(toolCall.kind).toBe('edit');

      const contentTypes = new Set((toolCall.content ?? []).map((b) => b.type));
      expect(contentTypes.has('diff')).toBe(false);
      expect(contentTypes.has('content')).toBe(false);

      const historyJson = JSON.stringify(history);
      expect(historyJson.includes(oldSentinel)).toBe(false);
      expect(historyJson.includes(newSentinel)).toBe(false);

      const outcome: RequestPermissionResponse['outcome'] = {
        outcome: 'selected',
        optionId: 'opt1',
      };
      await updatePermissionOutcomeInHistory(doc, 'req1', outcome, logger);

      const updatedHistory = await doc.sessionData.history.readAll();
      const updatedJson = JSON.stringify(updatedHistory);
      expect(updatedJson.includes(oldSentinel)).toBe(false);
      expect(updatedJson.includes(newSentinel)).toBe(false);
    } finally {
      await repo.destroy();
    }
  });
});

describe('Claude Code thinking tag parsing', () => {
  // Note: Claude Code streams <thinking> tags across multiple chunks.
  // The parsing happens in postProcessThinkingTags() after applyNotificationOnHistory(),
  // not in buildMessageContentFromNotification() per-chunk.

  it('parses <thinking> tags and converts to thought content via applyNotificationOnHistory', () => {
    const notifications = [
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk' as const,
          content: {
            type: 'text' as const,
            text: '<thinking>\nLet me think about this problem.\n</thinking>\nHere is my answer.',
          },
        },
      },
    ];

    const history = applyNotificationOnHistory([], notifications);

    expect(history.length).toBe(1);
    const items = history[0]?.items as MessageContent[];

    expect(items.length).toBe(2);

    // First item should be thought
    expect(items[0]?.type).toBe('thought');
    expect((items[0] as { text?: string })?.text).toBe('\nLet me think about this problem.\n');

    // Second item should be text
    expect(items[1]?.type).toBe('text');
    expect((items[1] as { text?: string })?.text).toBe('\nHere is my answer.');
  });

  it('handles multiple thinking blocks via applyNotificationOnHistory', () => {
    const notifications = [
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk' as const,
          content: {
            type: 'text' as const,
            text: 'Before\n<thinking>First thought</thinking>\nMiddle\n<thinking>Second thought</thinking>\nAfter',
          },
        },
      },
    ];

    const history = applyNotificationOnHistory([], notifications);

    expect(history.length).toBe(1);
    const items = history[0]?.items as MessageContent[];

    expect(items.length).toBe(5);
    expect(items[0]?.type).toBe('text');
    expect((items[0] as { text?: string })?.text).toBe('Before\n');

    expect(items[1]?.type).toBe('thought');
    expect((items[1] as { text?: string })?.text).toBe('First thought');

    expect(items[2]?.type).toBe('text');
    expect((items[2] as { text?: string })?.text).toBe('\nMiddle\n');

    expect(items[3]?.type).toBe('thought');
    expect((items[3] as { text?: string })?.text).toBe('Second thought');

    expect(items[4]?.type).toBe('text');
    expect((items[4] as { text?: string })?.text).toBe('\nAfter');
  });

  it('keeps inline <thinking> mentions in prose and code as visible text', () => {
    // Tags that are not anchored to line boundaries are conversation content
    // (e.g. an assistant explaining this very pipeline), not control markup.
    // Extracting them permanently rewrote persisted history.
    const inlineProse =
      'Claude Code streams `<thinking>` tags and closes them with `</thinking>` inline.';
    const inlineCode = 'Before<thinking>not a thought</thinking>After';
    for (const text of [inlineProse, inlineCode]) {
      const history = applyNotificationOnHistory(
        [],
        [
          {
            sessionId: 'test-session',
            update: {
              sessionUpdate: 'agent_message_chunk' as const,
              content: { type: 'text' as const, text },
            },
          },
        ]
      );
      expect(history.length).toBe(1);
      const items = history[0]?.items as MessageContent[];
      expect(items.length).toBe(1);
      expect(items[0]?.type).toBe('text');
      expect((items[0] as { text?: string })?.text).toBe(text);
    }
  });

  it('handles text without thinking tags', () => {
    const notification = {
      sessionId: 'test-session',
      update: {
        sessionUpdate: 'agent_message_chunk' as const,
        content: {
          type: 'text' as const,
          text: 'Just regular text without any thinking.',
        },
      },
    };

    const items = buildMessageContentFromNotification(notification);

    expect(items.length).toBe(1);
    expect(items[0]?.type).toBe('text');
    expect((items[0] as { text?: string })?.text).toBe('Just regular text without any thinking.');
  });

  it('handles only thinking tags without surrounding text via applyNotificationOnHistory', () => {
    const notifications = [
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk' as const,
          content: {
            type: 'text' as const,
            text: '<thinking>Only thinking content</thinking>',
          },
        },
      },
    ];

    const history = applyNotificationOnHistory([], notifications);

    expect(history.length).toBe(1);
    const items = history[0]?.items as MessageContent[];

    expect(items.length).toBe(1);
    expect(items[0]?.type).toBe('thought');
    expect((items[0] as { text?: string })?.text).toBe('Only thinking content');
  });

  it('handles multiline thinking blocks via applyNotificationOnHistory', () => {
    const notifications = [
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk' as const,
          content: {
            type: 'text' as const,
            text: '<thinking>\nLine 1\nLine 2\nLine 3\n</thinking>\nResponse text',
          },
        },
      },
    ];

    const history = applyNotificationOnHistory([], notifications);

    expect(history.length).toBe(1);
    const items = history[0]?.items as MessageContent[];

    expect(items.length).toBe(2);
    expect(items[0]?.type).toBe('thought');
    expect((items[0] as { text?: string })?.text).toBe('\nLine 1\nLine 2\nLine 3\n');

    expect(items[1]?.type).toBe('text');
    expect((items[1] as { text?: string })?.text).toBe('\nResponse text');
  });

  it('handles streaming chunks that split <thinking> tags across messages', () => {
    // This is the key test - Claude Code streams <thinking> tags across multiple chunks
    const notifications = [
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk' as const,
          content: { type: 'text' as const, text: '<thinking>\nThis is a' },
        },
      },
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk' as const,
          content: { type: 'text' as const, text: ' fascinating' },
        },
      },
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk' as const,
          content: { type: 'text' as const, text: ' problem.\n</thinking>\nHere is my answer.' },
        },
      },
    ];

    const history = applyNotificationOnHistory([], notifications);

    expect(history.length).toBe(1);
    const items = history[0]?.items as MessageContent[];

    expect(items.length).toBe(2);

    // First item should be thought (merged from multiple chunks)
    expect(items[0]?.type).toBe('thought');
    expect((items[0] as { text?: string })?.text).toBe('\nThis is a fascinating problem.\n');

    // Second item should be text
    expect(items[1]?.type).toBe('text');
    expect((items[1] as { text?: string })?.text).toBe('\nHere is my answer.');
  });
});
