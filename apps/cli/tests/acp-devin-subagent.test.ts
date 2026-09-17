import { describe, expect, it, vi } from 'vitest';

import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { SessionId } from '@lody/shared';

import { appendAutonomousACPNotifications } from '../src/lib/acp/history';
import { applyNotificationOnHistory } from '../src/lib/acp/history-apply';
import { withHistoryPort } from './history-port-fixture';

const makeNotification = (update: SessionNotification['update']): SessionNotification => ({
  sessionId: 'session-1' as SessionId,
  update,
});

const context = (parentAgentId: string) => ({
  'cognition.ai/subagent_context': { parentAgentId },
});

// Devin lifecycle rows are in_progress tool_call_updates with no rawInput — the
// shape `filterNotificationsForHistory` compacts away. This test pins that the
// live pipeline (filter → enrich → apply) still persists them as task items.
describe('devin subagent updates through the ACP history pipeline', () => {
  it('persists the started row as a subagent_task and keeps internals out of items', async () => {
    let history: any[] = [];
    const doc = withHistoryPort({
      updateHistory: vi.fn(async (updateFn: (history: any[]) => any[]) => {
        history = updateFn(history);
      }),
      agentWrites: {
        applyAgentBatch: vi.fn(async (input: any) => {
          if (input.notifications?.length) {
            history = applyNotificationOnHistory(history, input.notifications, input.model, {
              ...(input.createId ? { createId: input.createId } : {}),
              ...(input.targetAssistantEntryId
                ? { targetAssistantEntryId: input.targetAssistantEntryId }
                : {}),
            });
          }
          return {
            status: 'accepted',
            receipt: { sessionId: 'session-1', kind: 'x', turnIds: [] },
          };
        }),
      },
      sessionData: {
        commands: {},
        history: {
          count: async () => 0,
          readAt: async () => ({ state: 'missing' as const }),
          readTurn: async () => ({ state: 'missing' as const }),
          readRange: async () => [],
          readDirectory: async () => [],
          observe: () => ({ initial: Promise.resolve([]), unsubscribe: () => {} }),
        },
      },
    }) as any;

    await appendAutonomousACPNotifications(
      doc,
      [
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'agent-1',
          status: 'in_progress',
          _meta: {
            'cognition.ai/subagent_started': { agentId: 'agent-1', title: 'Explore' },
          },
        } as SessionNotification['update']),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'internal' },
          _meta: context('agent-1'),
        } as SessionNotification['update']),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'visible' },
        }),
      ],
      {} as any
    );

    const items = (history[0]?.items ?? []) as any[];
    expect(items).toEqual([
      expect.objectContaining({ type: 'subagent_task', taskId: 'agent-1' }),
      { type: 'text', text: 'visible' },
    ]);
  });
});
