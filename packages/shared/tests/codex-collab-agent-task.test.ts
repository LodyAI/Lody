import { describe, expect, it } from 'vitest';

import { parseCodexCollabAgentTasks } from '../src/acp/codex-collab-agent-task';
import { applyNotificationOnHistory } from '../src/acp/history-apply';
import { parseSessionNotification } from '../src/acp/schema';

const rawInput = (overrides: Record<string, unknown> = {}) => ({
  prompt: 'Inspect the goal implementation.',
  senderThreadId: 'thread-main',
  receiverThreadIds: ['thread-worker'],
  agentsStates: {
    'thread-worker': { status: 'running', message: 'Reading files' },
  },
  status: 'inProgress',
  ...overrides,
});

describe('parseCodexCollabAgentTasks', () => {
  it('maps every receiver and preserves terminal failures', () => {
    const tasks = parseCodexCollabAgentTasks(
      'wait',
      rawInput({
        receiverThreadIds: ['thread-a'],
        agentsStates: {
          'thread-a': { status: 'completed', message: 'Done' },
          'thread-b': { status: 'errored', message: 'Tests failed' },
        },
        status: 'completed',
      })
    );

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ taskId: 'thread-a', status: 'completed' });
    expect(tasks[1]).toMatchObject({
      taskId: 'thread-b',
      status: 'failed',
      error: 'Tests failed',
    });
  });
});

describe('Codex collab-agent history normalization', () => {
  it('merges start and completion by receiver thread id without persisting a tool call', () => {
    const started = parseSessionNotification({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        kind: 'other',
        title: 'spawnAgent',
        status: 'in_progress',
        rawInput: rawInput(),
      },
    });
    const completed = parseSessionNotification({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        title: 'spawnAgent',
        status: 'completed',
        rawInput: rawInput({
          agentsStates: {
            'thread-worker': { status: 'completed', message: 'Goal code located' },
          },
          status: 'completed',
        }),
      },
    });

    const history = applyNotificationOnHistory([], [started, completed]);
    const items = history.flatMap((entry) => entry.items ?? []);
    expect(items.filter((item) => item.type === 'tool_call')).toHaveLength(0);
    expect(items.filter((item) => item.type === 'subagent_task')).toEqual([
      expect.objectContaining({
        type: 'subagent_task',
        taskId: 'thread-worker',
        status: 'completed',
        description: 'Inspect the goal implementation.',
        summary: 'Goal code located',
      }),
    ]);
  });
});
