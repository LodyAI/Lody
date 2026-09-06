import { describe, expect, it, vi } from 'vitest';
import {
  parseSessionNotification,
  type MessageContent,
  type SessionHistoryInput,
  type SessionId,
} from '@lody/shared';
import type { SessionDocument } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import {
  clearThreadGoalFromHistory,
  handleACPUpdateMessage,
  upsertThreadGoalInHistory,
} from './history';

const sid = (id: string) => id as SessionId;

function createDoc(initialHistory: SessionHistoryInput[] = []) {
  let history: SessionHistoryInput[] = initialHistory;

  const doc = {
    sessionId: sid('session-1'),
    updateHistory: vi.fn(
      async (updater: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        history = updater(history);
      }
    ),
    setPlan: vi.fn(async () => {}),
    getHistory: vi.fn(async () => history),
  } as unknown as SessionDocument;

  return { doc, readHistory: () => history };
}

describe('handleACPUpdateMessage', () => {
  it('keeps running terminal output out of history and writes its tail once on completion', async () => {
    const { doc, readHistory } = createDoc();
    const callbacks = { getCurrentSessionTurnId: () => 'turn-1' };

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'shell-1',
          title: 'Shell',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'echo running' },
          rawOutput: { aggregated_output: 'x'.repeat(4096) },
        },
      }),
      callbacks
    );

    const runningTool = ((readHistory()[0]?.items ?? []) as unknown as MessageContent[]).find(
      (item) => item.type === 'tool_call'
    ) as Extract<MessageContent, { type: 'tool_call' }>;
    expect(runningTool.content?.some((block) => block.type === 'terminal_output')).toBe(false);

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'shell-1',
          title: 'Shell',
          kind: 'execute',
          status: 'completed',
        },
      }),
      callbacks
    );

    const completedTool = ((readHistory()[0]?.items ?? []) as unknown as MessageContent[]).find(
      (item) => item.type === 'tool_call'
    ) as Extract<MessageContent, { type: 'tool_call' }>;
    const outputs =
      completedTool.content?.filter((block) => block.type === 'terminal_output') ?? [];
    expect(outputs).toHaveLength(1);
    expect(
      new TextEncoder().encode((outputs[0] as { output: string }).output).byteLength
    ).toBeLessThanOrEqual(1024);
  });

  it('restores accumulated terminal output when the terminal history write is retried', async () => {
    const { doc, readHistory } = createDoc();
    const callbacks = { getCurrentSessionTurnId: () => 'turn-retry' };

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'shell-retry',
          title: 'Shell',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'printf retry' },
          rawOutput: { aggregated_output: 'terminal output before failure' },
        },
      }),
      callbacks
    );

    const completed = parseSessionNotification({
      sessionId: 'acp-session',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'shell-retry',
        title: 'Shell',
        kind: 'execute',
        status: 'completed',
      },
    });
    vi.mocked(doc.updateHistory).mockRejectedValueOnce(new Error('transient doc failure'));

    await expect(handleACPUpdateMessage(doc, completed, callbacks)).rejects.toThrow(
      'transient doc failure'
    );
    await handleACPUpdateMessage(doc, completed, callbacks);

    const completedTool = ((readHistory()[0]?.items ?? []) as unknown as MessageContent[]).find(
      (item) => item.type === 'tool_call'
    ) as Extract<MessageContent, { type: 'tool_call' }>;
    const output = completedTool.content?.find((block) => block.type === 'terminal_output') as
      | { output: string }
      | undefined;
    expect(output?.output).toContain('terminal output before failure');
  });

  it('does not require a turn id for notifications that do not write history items', async () => {
    const { doc } = createDoc();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');
    const warn = vi.fn();

    await handleACPUpdateMessage(
      doc,
      [
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        }),
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'session_info_update',
            title: 'restored session',
          },
        }),
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'usage_update',
            size: 100_000,
            used: 1_234,
          },
        }),
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'image',
              data: 'aW1hZ2U=',
              mimeType: 'image/png',
            },
          },
        }),
      ],
      { getCurrentSessionTurnId, logger: { warn } as unknown as Logger }
    );

    expect(getCurrentSessionTurnId).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(doc.updateHistory).not.toHaveBeenCalled();
  });

  it('does not require a turn id for plan-only batches', async () => {
    const { doc } = createDoc();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'plan',
          entries: [{ status: 'in_progress', content: 'restore', priority: 'high' }],
        },
      }),
      { getCurrentSessionTurnId }
    );

    expect(getCurrentSessionTurnId).not.toHaveBeenCalled();
    expect(doc.setPlan).toHaveBeenCalledWith([
      { status: 'in_progress', content: 'restore', priority: 'high' },
    ]);
  });

  it('uses the active turn id for assistant output that persists to history', async () => {
    const { doc, readHistory } = createDoc();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello from agent' },
        },
      }),
      { getCurrentSessionTurnId }
    );

    expect(getCurrentSessionTurnId).toHaveBeenCalledWith(sid('session-1'));
    expect(readHistory()).toMatchObject([
      {
        id: 'turn-1',
        role: 'assistant',
        items: [{ type: 'text', text: 'hello from agent' }],
      },
    ]);
  });

  it('upserts Claude task lifecycle progress into a single subagent_task item', async () => {
    const { doc, readHistory } = createDoc();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');
    const lifecycleRawInput = (event: string, status: string, description?: string) => ({
      lodyClaudeTaskLifecycle: {
        version: 1,
        event,
        taskId: 'task-1',
        status,
        ...(description ? { description } : {}),
      },
    });

    await handleACPUpdateMessage(
      doc,
      [
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'claude-task:task-1',
            title: 'Explore: Start',
            kind: 'think',
            status: 'in_progress',
            content: [{ type: 'content', content: { type: 'text', text: 'Start' } }],
            rawInput: lifecycleRawInput('task_started', 'in_progress', 'Start'),
          },
        }),
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'claude-task:task-1',
            title: 'Explore: Reading files',
            kind: 'think',
            status: 'in_progress',
            content: [{ type: 'content', content: { type: 'text', text: 'Reading files' } }],
            rawInput: lifecycleRawInput('task_progress', 'in_progress', 'Reading files'),
          },
        }),
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'claude-task:task-1',
            title: 'Explore: Done',
            kind: 'think',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'Done' } }],
            rawInput: lifecycleRawInput('task_notification', 'completed'),
          },
        }),
      ],
      { getCurrentSessionTurnId }
    );

    expect(readHistory()).toMatchObject([
      {
        id: 'turn-1',
        role: 'assistant',
        items: [
          {
            type: 'subagent_task',
            taskId: 'task-1',
            status: 'completed',
            event: 'task_notification',
            // description survives from the earlier task_started/progress events
            description: 'Reading files',
          },
        ],
      },
    ]);
    const items = readHistory()[0]?.items as MessageContent[] | undefined;
    const tasks = items?.filter((item) => item.type === 'subagent_task') ?? [];
    expect(tasks).toHaveLength(1);
    // No tool_call is persisted for lifecycle events.
    expect(items?.some((item) => item.type === 'tool_call')).toBe(false);
  });

  it('preserves subagent identity when the terminal task_notification omits it', async () => {
    const { doc, readHistory } = createDoc();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');

    await handleACPUpdateMessage(
      doc,
      [
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'claude-task:task-9',
            title: 'Explore: Start',
            kind: 'think',
            status: 'in_progress',
            rawInput: {
              lodyClaudeTaskLifecycle: {
                version: 1,
                event: 'task_started',
                taskId: 'task-9',
                status: 'in_progress',
                subagentType: 'Explore',
                description: 'Find CLI startup',
              },
            },
          },
        }),
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'claude-task:task-9',
            kind: 'think',
            status: 'completed',
            rawInput: {
              lodyClaudeTaskLifecycle: {
                version: 1,
                event: 'task_notification',
                taskId: 'task-9',
                status: 'completed',
                summary: 'Found it',
              },
            },
          },
        }),
      ],
      { getCurrentSessionTurnId }
    );

    const items = readHistory()[0]?.items as MessageContent[] | undefined;
    const task = items?.find(
      (item): item is Extract<MessageContent, { type: 'subagent_task' }> =>
        item.type === 'subagent_task'
    );
    expect(task).toMatchObject({
      event: 'task_notification',
      status: 'completed',
      summary: 'Found it',
      subagentType: 'Explore',
      description: 'Find CLI startup',
    });
  });

  // The bundled Claude adapter publishes task lifecycle through `_meta.lody.task` on a
  // `tool_call` (task_started) and non-terminal `tool_call_update`s (task_progress /
  // task_updated). The fixtures below transcribe that update shape verbatim: no `rawInput`
  // and no `_meta.claudeCode`, because that absence is what used to drop them from history.
  const lodyTaskMeta = (task: Record<string, unknown>) => ({
    lody: { task: { version: 1, kind: 'subagent', ...task } },
  });

  it('persists the shipped _meta.lody.task progress snapshot so lastToolName reaches the panel', async () => {
    const { doc, readHistory } = createDoc();

    await handleACPUpdateMessage(
      doc,
      [
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'task:task-1',
            title: 'Explore: Find CLI startup behavior',
            kind: 'think',
            status: 'in_progress',
            _meta: lodyTaskMeta({
              taskId: 'task-1',
              status: 'in_progress',
              actor: 'Explore',
              description: 'Find CLI startup behavior',
            }),
          },
        }),
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'task:task-1',
            title: 'Explore: Find CLI startup behavior',
            kind: 'think',
            status: 'in_progress',
            _meta: lodyTaskMeta({
              taskId: 'task-1',
              status: 'in_progress',
              actor: 'Explore',
              description: 'Find CLI startup behavior',
              lastToolName: 'Read',
              usage: { totalTokens: 100, toolUses: 2, durationMs: 500 },
            }),
          },
        }),
      ],
      { getCurrentSessionTurnId: () => 'turn-1' }
    );

    const items = readHistory()[0]?.items as MessageContent[] | undefined;
    const task = items?.find(
      (item): item is Extract<MessageContent, { type: 'subagent_task' }> =>
        item.type === 'subagent_task'
    );
    expect(task).toMatchObject({
      taskId: 'task-1',
      status: 'in_progress',
      actor: 'Explore',
      description: 'Find CLI startup behavior',
      lastToolName: 'Read',
      usage: { totalTokens: 100, toolUses: 2, durationMs: 500 },
    });
    // Lifecycle events never leak a raw tool call into history.
    expect(items?.some((item) => item.type === 'tool_call')).toBe(false);
  });

  it('merges repeated _meta.lody.task progress into a single subagent_task item', async () => {
    const { doc, readHistory } = createDoc();
    // `task_progress.description` is required and activity-scoped — it changes on
    // essentially every tick — so the fixture changes it too.
    const progress = (lastToolName: string) =>
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: `task:task-2`,
          title: `Explore: running ${lastToolName}`,
          kind: 'think',
          status: 'in_progress',
          _meta: lodyTaskMeta({
            taskId: 'task-2',
            status: 'in_progress',
            actor: 'Explore',
            description: `running ${lastToolName}`,
            lastToolName,
          }),
        },
      });

    await handleACPUpdateMessage(
      doc,
      [
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'task:task-2',
            title: 'Explore: Auditing history',
            kind: 'think',
            status: 'in_progress',
            _meta: lodyTaskMeta({
              taskId: 'task-2',
              status: 'in_progress',
              actor: 'Explore',
              description: 'Auditing history',
            }),
          },
        }),
        ...['Read', 'Bash', 'Grep'].map(progress),
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'task:task-2',
            title: 'Explore: Auditing history',
            kind: 'think',
            status: 'completed',
            _meta: lodyTaskMeta({
              taskId: 'task-2',
              status: 'completed',
              actor: 'Explore',
              summary: 'Audit done',
            }),
          },
        }),
      ],
      { getCurrentSessionTurnId: () => 'turn-1' }
    );

    const items = readHistory()[0]?.items as MessageContent[] | undefined;
    const tasks = items?.filter((item) => item.type === 'subagent_task') ?? [];
    // Keeping every tick costs no extra item: the applier merges in place by taskId.
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: 'task-2',
      status: 'completed',
      summary: 'Audit done',
      // a progress tick's activity description wins and survives the terminal event,
      // matching the legacy-carrier expectation pinned above
      description: 'running Grep',
      // the last progress tick wins, and survives the terminal event that omits it
      lastToolName: 'Grep',
    });
  });

  it('keeps a real workflow run named through the shipped adapter stream', async () => {
    const { doc, readHistory } = createDoc();
    // The six `_meta.lody.task` notifications of one workflow run, transcribed from a
    // capture of the bundled adapter driven over ACP (Claude Code 2.1.258, the pinned
    // runtime). Only `task_started` carries an identity source, so every later event
    // falls through to the producer's placeholder.
    const shippedStream = [
      { status: 'in_progress', sessionUpdate: 'tool_call', task: { actor: 'e2e-probe', description: 'verify task lifecycle reaches history', kind: 'background', status: 'in_progress' } },
      { status: 'in_progress', sessionUpdate: 'tool_call_update', task: { actor: 'Claude task', description: 'Check: checker', kind: 'background', lastToolName: 'checker', status: 'in_progress', summary: 'verify task lifecycle reaches history', usage: { durationMs: 33, toolUses: 0, totalTokens: 0 } } },
      { status: 'in_progress', sessionUpdate: 'tool_call_update', task: { actor: 'Claude task', description: 'Check: checker', kind: 'background', lastToolName: 'checker', status: 'in_progress', summary: 'verify task lifecycle reaches history', usage: { durationMs: 1714, toolUses: 0, totalTokens: 26781 } } },
      { status: 'completed', sessionUpdate: 'tool_call_update', task: { actor: 'Claude task', kind: 'background', status: 'completed' } },
      { status: 'completed', sessionUpdate: 'tool_call_update', task: { actor: 'Claude task', kind: 'background', status: 'completed', summary: 'Dynamic workflow "verify task lifecycle reaches history" completed', usage: { durationMs: 1738, toolUses: 0, totalTokens: 26781 } } },
    ].map((n) =>
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: n.sessionUpdate as 'tool_call' | 'tool_call_update',
          toolCallId: 'task:w5ftatomx',
          title: 'workflow',
          kind: 'think',
          status: n.status as 'in_progress' | 'completed',
          _meta: lodyTaskMeta({
            taskId: 'w5ftatomx',
            parentToolCallId: 'toolu_01VGYjhBXHoAAc9a8dBx3Upu',
            ...n.task,
          }),
        },
      })
    );

    await handleACPUpdateMessage(doc, shippedStream, {
      getCurrentSessionTurnId: () => 'turn-1',
    });

    const items = readHistory()[0]?.items as MessageContent[] | undefined;
    const task = items?.find(
      (item): item is Extract<MessageContent, { type: 'subagent_task' }> =>
        item.type === 'subagent_task'
    );
    expect(task).toMatchObject({
      taskId: 'w5ftatomx',
      // the run keeps its own name; every event after the first says "Claude task"
      actor: 'e2e-probe',
      status: 'completed',
      lastToolName: 'checker',
      usage: { totalTokens: 26781 },
    });
    expect(task?.actor).not.toBe('Claude task');
  });

  it('ignores a non-terminal tick that lands after the task settled', async () => {
    const { doc, readHistory } = createDoc();
    const settledThenLateTick = [
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'task:task-6',
          title: 'Explore: done',
          kind: 'think',
          status: 'completed',
          _meta: lodyTaskMeta({
            taskId: 'task-6',
            status: 'completed',
            kind: 'subagent',
            actor: 'Explore',
            summary: 'Explored',
          }),
        },
      }),
      // A tick whose registry entry the producer has already pruned re-derives
      // `kind: 'background'`, which would badge a finished subagent Background.
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'task:task-6',
          title: 'Claude task: running Grep',
          kind: 'think',
          status: 'in_progress',
          _meta: lodyTaskMeta({
            taskId: 'task-6',
            status: 'in_progress',
            kind: 'background',
            actor: 'Claude task',
            description: 'running Grep',
            lastToolName: 'Grep',
          }),
        },
      }),
    ];

    await handleACPUpdateMessage(doc, settledThenLateTick, {
      getCurrentSessionTurnId: () => 'turn-1',
    });

    const items = readHistory()[0]?.items as MessageContent[] | undefined;
    const task = items?.find(
      (item): item is Extract<MessageContent, { type: 'subagent_task' }> =>
        item.type === 'subagent_task'
    );
    expect(task).toMatchObject({
      taskId: 'task-6',
      status: 'completed',
      summary: 'Explored',
      actor: 'Explore',
      taskKind: 'subagent',
    });
    expect(task?.isBackgrounded).not.toBe(true);
    expect(task?.lastToolName).toBeUndefined();
  });

  it('does not let a late progress tick resurrect a settled subagent_task', async () => {
    const { doc, readHistory } = createDoc();
    const tick = (status: 'in_progress' | 'completed', extra: Record<string, unknown>) =>
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'task:task-5',
          title: 'Explore: late tick',
          kind: 'think',
          status,
          _meta: lodyTaskMeta({ taskId: 'task-5', status, actor: 'Explore', ...extra }),
        },
      });

    await handleACPUpdateMessage(
      doc,
      [
        tick('completed', { summary: 'All done' }),
        // `claudeTaskStatus` reports `in_progress` for every task_progress, so a tick
        // that lands after the terminal event would restart a finished spinner.
        tick('in_progress', { description: 'running Grep', lastToolName: 'Grep' }),
      ],
      { getCurrentSessionTurnId: () => 'turn-1' }
    );

    const items = readHistory()[0]?.items as MessageContent[] | undefined;
    const tasks = items?.filter((item) => item.type === 'subagent_task') ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: 'task-5', status: 'completed', summary: 'All done' });
  });

  it('persists a backgrounding task_updated without letting it rename the task', async () => {
    const { doc, readHistory } = createDoc();

    await handleACPUpdateMessage(
      doc,
      [
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'task:task-3',
            title: 'Explore: Initial prompt',
            kind: 'think',
            status: 'in_progress',
            _meta: lodyTaskMeta({
              taskId: 'task-3',
              status: 'in_progress',
              actor: 'Explore',
              description: 'Initial prompt',
            }),
          },
        }),
        // A real `task_updated` carries only `{task_id, patch}`. A backgrounding patch is
        // the one that changes something observable — the producer's actor chain still
        // has no input and falls through to its placeholder.
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'task:task-3',
            title: 'Claude task',
            kind: 'think',
            status: 'in_progress',
            _meta: lodyTaskMeta({
              taskId: 'task-3',
              status: 'in_progress',
              kind: 'background',
              actor: 'Claude task',
            }),
          },
        }),
      ],
      { getCurrentSessionTurnId: () => 'turn-1' }
    );

    const items = readHistory()[0]?.items as MessageContent[] | undefined;
    const task = items?.find(
      (item): item is Extract<MessageContent, { type: 'subagent_task' }> =>
        item.type === 'subagent_task'
    );
    // the backgrounding reaches history, and the earlier identity survives it
    expect(task).toMatchObject({
      taskId: 'task-3',
      status: 'in_progress',
      taskKind: 'background',
      isBackgrounded: true,
      actor: 'Explore',
    });
  });

  it('keeps dropping an in-progress tool_call_update whose _meta carries no task snapshot', async () => {
    const { doc, readHistory } = createDoc();

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'shell-9',
          kind: 'execute',
          status: 'in_progress',
          rawOutput: { aggregated_output: 'x'.repeat(4096) },
          _meta: { lody: { activity: 'running' } },
        },
      }),
      { getCurrentSessionTurnId: () => 'turn-1' }
    );

    expect(readHistory()).toEqual([]);
  });

  it('creates the explicit target assistant entry instead of appending to another open entry', async () => {
    const { doc, readHistory } = createDoc([
      {
        id: 'other-turn',
        role: 'assistant',
        items: [
          { type: 'text', text: 'existing response' },
        ] as unknown as SessionHistoryInput['items'],
        timestamp: '2026-06-21T00:00:00.000Z',
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ]);

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'targeted response' },
        },
      }),
      { targetAssistantEntryId: 'turn-1' }
    );

    expect(readHistory()).toMatchObject([
      {
        id: 'other-turn',
        role: 'assistant',
        items: [{ type: 'text', text: 'existing response' }],
      },
      {
        id: 'turn-1',
        role: 'assistant',
        items: [{ type: 'text', text: 'targeted response' }],
      },
    ]);
  });

  it('appends late output to the finalized target turn instead of creating another entry', async () => {
    const { doc, readHistory } = createDoc([
      {
        id: 'turn-1',
        role: 'assistant',
        items: [
          {
            type: 'text',
            text: 'partial response',
          },
        ] as unknown as SessionHistoryInput['items'],
        timestamp: '2026-06-21T00:00:00.000Z',
        read: undefined,
        userId: undefined,
        fileDiff: [],
        finished: true,
        endedAt: 1,
      },
    ]);
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' after retry' },
        },
      }),
      { getCurrentSessionTurnId }
    );

    expect(getCurrentSessionTurnId).toHaveBeenCalledWith(sid('session-1'));
    expect(readHistory()).toMatchObject([
      {
        id: 'turn-1',
        role: 'assistant',
        finished: true,
        endedAt: 1,
        items: [{ type: 'text', text: 'partial response after retry' }],
      },
    ]);
    expect(readHistory()).toHaveLength(1);
  });

  it('drops assistant output by default when no assistant entry target exists', async () => {
    const { doc, readHistory } = createDoc();
    const getCurrentSessionTurnId = vi.fn(() => undefined);
    const warn = vi.fn();

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'continued after goal' },
        },
      }),
      { getCurrentSessionTurnId, logger: { warn } as unknown as Logger }
    );

    expect(getCurrentSessionTurnId).toHaveBeenCalledWith(sid('session-1'));
    expect(warn).toHaveBeenCalledWith(
      '[session-1] Dropping 1 ACP history notifications without an assistant entry target'
    );
    expect(readHistory()).toEqual([]);
  });

  it('persists explicitly autonomous assistant output when no active prompt turn exists', async () => {
    const { doc, readHistory } = createDoc();
    const getCurrentSessionTurnId = vi.fn(() => undefined);

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'continued after goal' },
        },
      }),
      { getCurrentSessionTurnId, allowAutonomousAssistantEntry: true }
    );

    expect(getCurrentSessionTurnId).toHaveBeenCalledWith(sid('session-1'));
    expect(readHistory()).toMatchObject([
      {
        role: 'assistant',
        items: [{ type: 'text', text: 'continued after goal' }],
      },
    ]);
  });

  it('fires edit callbacks for Codex completed updates that inherit edit kind from the begin event', async () => {
    const { doc } = createDoc();
    const editCallback = vi.fn();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'Edit /tmp/probe.txt',
          kind: 'edit',
          status: 'in_progress',
          content: [
            {
              type: 'diff',
              path: '/tmp/probe.txt',
              oldText: 'alpha old\n',
              newText: 'alpha new\n',
            },
          ],
        },
      }),
      { editCallback, getCurrentSessionTurnId }
    );

    expect(editCallback).not.toHaveBeenCalled();

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          content: [
            {
              type: 'diff',
              path: '/tmp/probe.txt',
              oldText: 'alpha old\n',
              newText: 'alpha new\n',
            },
          ],
        },
      }),
      { editCallback, getCurrentSessionTurnId }
    );

    expect(editCallback).toHaveBeenCalledTimes(1);
    // Hunk-level old/new text is intentionally not forwarded as file content; the path still
    // reports as an update edit so per-turn membership is preserved.
    expect(editCallback).toHaveBeenCalledWith([
      {
        path: '/tmp/probe.txt',
        changeType: 'update',
        contentOldText: 'alpha old\n',
        contentNewText: 'alpha new\n',
      },
    ]);
  });

  it('fires standard diff callbacks for non-terminal diff updates without completed status', async () => {
    const { doc } = createDoc();
    const standardDiffCallback = vi.fn();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-claude',
          content: [
            {
              type: 'diff',
              path: '/tmp/probe.txt',
              oldText: 'alpha old',
              newText: 'alpha new',
            },
          ],
        },
      }),
      { standardDiffCallback, getCurrentSessionTurnId }
    );

    expect(standardDiffCallback).toHaveBeenCalledTimes(1);
    expect(standardDiffCallback).toHaveBeenCalledWith([
      {
        path: '/tmp/probe.txt',
        oldText: 'alpha old',
        newText: 'alpha new',
      },
    ]);
  });

  it('propagates retryable standard diff callback failures', async () => {
    const { doc } = createDoc();
    const retryableError = Object.assign(new Error('workspace temporarily unavailable'), {
      options: { retryable: true },
    });
    const standardDiffCallback = vi.fn().mockRejectedValue(retryableError);

    await expect(
      handleACPUpdateMessage(
        doc,
        parseSessionNotification({
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-retry',
            content: [
              {
                type: 'diff',
                path: '/tmp/probe.txt',
                oldText: 'alpha old',
                newText: 'alpha new',
              },
            ],
          },
        }),
        { standardDiffCallback, getCurrentSessionTurnId: () => 'turn-1' }
      )
    ).rejects.toBe(retryableError);
  });

  it('fires edit callbacks for completed diff updates even when kind state is unavailable', async () => {
    const { doc } = createDoc();
    const editCallback = vi.fn();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          content: [
            {
              type: 'diff',
              path: '/tmp/probe.txt',
              oldText: 'alpha old\n',
              newText: 'alpha new\n',
            },
          ],
        },
      }),
      { editCallback, getCurrentSessionTurnId }
    );

    expect(editCallback).toHaveBeenCalledTimes(1);
    expect(editCallback).toHaveBeenCalledWith([
      {
        path: '/tmp/probe.txt',
        changeType: 'update',
        contentOldText: 'alpha old\n',
        contentNewText: 'alpha new\n',
      },
    ]);
  });

  it('fires edit callbacks from accumulated in-progress evidence when the completed update is bare (Claude Code)', async () => {
    const { doc } = createDoc();
    const editCallback = vi.fn();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');
    const send = (update: Record<string, unknown>) =>
      handleACPUpdateMessage(doc, parseSessionNotification({ sessionId: 'acp-session', update }), {
        editCallback,
        getCurrentSessionTurnId,
      });

    // Exact shape probed from acp-extension-claude@0.44.0: evidence only on non-terminal
    // updates, bare `status: completed` terminal update.
    await send({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit',
      title: 'Edit',
      kind: 'edit',
      status: 'pending',
      content: [],
      locations: [],
    });
    await send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit',
      title: 'Edit /tmp/work/notes.md',
      rawInput: {
        replace_all: false,
        file_path: '/tmp/work/notes.md',
        old_string: 'alpha line one',
        new_string: 'omega line one',
      },
      content: [
        {
          type: 'diff',
          path: '/tmp/work/notes.md',
          oldText: 'alpha line one',
          newText: 'omega line one',
        },
      ],
    });
    await send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit',
      content: [
        {
          type: 'diff',
          path: '/tmp/work/notes.md',
          oldText: '# Notes\n\nalpha line one\nbeta line two',
          newText: '# Notes\n\nomega line one\nbeta line two',
        },
      ],
      locations: [{ path: '/tmp/work/notes.md', line: 1 }],
    });
    expect(editCallback).not.toHaveBeenCalled();

    await send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit',
      status: 'completed',
    });

    expect(editCallback).toHaveBeenCalledTimes(1);
    expect(editCallback).toHaveBeenCalledWith([
      {
        path: '/tmp/work/notes.md',
        changeType: 'update',
        contentOldText: '# Notes\n\nalpha line one\nbeta line two',
        contentNewText: '# Notes\n\nomega line one\nbeta line two',
        oldString: 'alpha line one',
        newString: 'omega line one',
      },
    ]);
  });

  it('fires create edit callbacks from accumulated Write-tool evidence on a bare completed update', async () => {
    const { doc } = createDoc();
    const editCallback = vi.fn();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');
    const send = (update: Record<string, unknown>) =>
      handleACPUpdateMessage(doc, parseSessionNotification({ sessionId: 'acp-session', update }), {
        editCallback,
        getCurrentSessionTurnId,
      });

    await send({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-write',
      title: 'Write',
      kind: 'edit',
      status: 'pending',
    });
    await send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-write',
      title: 'Write /tmp/work/hello.txt',
      rawInput: { file_path: '/tmp/work/hello.txt', content: 'hi from probe' },
      content: [
        { type: 'diff', path: '/tmp/work/hello.txt', oldText: null, newText: 'hi from probe' },
      ],
    });
    await send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-write',
      status: 'completed',
    });

    expect(editCallback).toHaveBeenCalledTimes(1);
    expect(editCallback).toHaveBeenCalledWith([
      {
        path: '/tmp/work/hello.txt',
        changeType: 'add',
        fullNewText: 'hi from probe',
      },
    ]);
  });

  it('extracts unified-diff evidence from Codex apply_patch rawOutput.changes', async () => {
    const { doc } = createDoc();
    const editCallback = vi.fn();
    const getCurrentSessionTurnId = vi.fn(() => 'turn-1');

    await handleACPUpdateMessage(
      doc,
      parseSessionNotification({
        sessionId: 'acp-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          content: [
            {
              type: 'diff',
              path: '/repo/hello.txt',
              oldText: 'hello world\nline two\n',
              newText: 'goodbye world\nline two\n',
            },
            {
              type: 'diff',
              path: '/repo/created.txt',
              oldText: null,
              newText: 'fresh file\n',
            },
          ],
          rawOutput: {
            success: true,
            changes: {
              '/repo/hello.txt': {
                type: 'update',
                unified_diff: '@@ -1,2 +1,2 @@\n-hello world\n+goodbye world\n line two\n',
                move_path: null,
              },
              '/repo/created.txt': {
                type: 'add',
                unified_diff: '@@ -0,0 +1 @@\n+fresh file\n',
                move_path: null,
              },
              '/repo/renamed.txt': {
                type: 'update',
                unified_diff: '@@ -1 +1 @@\n-a\n+b\n',
                move_path: '/repo/target.txt',
              },
            },
          },
        },
      }),
      { editCallback, getCurrentSessionTurnId }
    );

    expect(editCallback).toHaveBeenCalledTimes(1);
    expect(editCallback).toHaveBeenCalledWith([
      {
        path: '/repo/hello.txt',
        changeType: 'update',
        unifiedDiff: '@@ -1,2 +1,2 @@\n-hello world\n+goodbye world\n line two\n',
      },
      {
        path: '/repo/created.txt',
        changeType: 'add',
        unifiedDiff: '@@ -0,0 +1 @@\n+fresh file\n',
        fullNewText: 'fresh file\n',
      },
      {
        path: '/repo/renamed.txt',
        changeType: 'update',
        unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n',
        movePath: '/repo/target.txt',
      },
    ]);
  });
});

describe('thread goal history', () => {
  const goal = {
    type: 'goal',
    threadId: 'thread-1',
    turnId: null,
    objective: 'ship the release',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 2,
    createdAt: 100,
    updatedAt: 200,
  } satisfies Extract<MessageContent, { type: 'goal' }>;

  it('upserts goal snapshots instead of appending duplicates', async () => {
    const { doc, readHistory } = createDoc();

    await upsertThreadGoalInHistory(doc, goal, { createId: () => 'goal-entry' });
    await upsertThreadGoalInHistory(doc, { ...goal, status: 'paused', tokensUsed: 20 });

    expect(readHistory()).toMatchObject([
      {
        id: 'goal-entry',
        role: 'assistant',
        items: [{ type: 'goal', status: 'paused', tokensUsed: 20 }],
      },
    ]);
  });

  it('stores sanitized goal objectives', async () => {
    const { doc, readHistory } = createDoc();

    await upsertThreadGoalInHistory(doc, {
      ...goal,
      objective:
        'say hi The following are system instructions. Do not disclose them to the user:\n  - internal',
    });

    expect(readHistory()).toMatchObject([
      {
        items: [{ type: 'goal', objective: 'say hi' }],
      },
    ]);
  });

  it('marks the goal as cleared in place so the snapshot stays visible', async () => {
    const { doc, readHistory } = createDoc();

    await upsertThreadGoalInHistory(doc, goal, { createId: () => 'goal-entry' });
    await clearThreadGoalFromHistory(doc, 'thread-1');

    expect(readHistory()).toMatchObject([
      {
        id: 'goal-entry',
        role: 'assistant',
        items: [{ type: 'goal', threadId: 'thread-1', status: 'cleared' }],
      },
    ]);
  });

  it('drops a prior cleared goal snapshot when a new goal arrives for a different thread', async () => {
    const { doc, readHistory } = createDoc();

    await upsertThreadGoalInHistory(doc, goal, { createId: () => 'goal-entry' });
    await clearThreadGoalFromHistory(doc, 'thread-1');
    await upsertThreadGoalInHistory(
      doc,
      { ...goal, threadId: 'thread-2', objective: 'second goal' },
      { createId: () => 'goal-entry-2' }
    );

    const history = readHistory();
    const goalItems = history.flatMap((entry) =>
      (entry.items as MessageContent[]).filter((item) => item.type === 'goal')
    );
    expect(goalItems).toMatchObject([{ threadId: 'thread-2', status: 'active' }]);
  });
});
