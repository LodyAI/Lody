import { describe, expect, it, vi } from 'vitest';

import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { SessionId } from '@lody/shared';

import { appendAutonomousACPNotifications } from '../src/lib/acp/history';
import { applyNotificationOnHistory } from '../src/lib/acp/history-apply';

const makeNotification = (update: SessionNotification['update']): SessionNotification => ({
  sessionId: 'session-1' as SessionId,
  update,
});

describe('handleACPUpdateMessage plan sync', () => {
  it('writes the latest plan snapshot onto the session doc', async () => {
    let history: any[] = [];
    const updateHistory = vi.fn(async (updateFn: (history: any[]) => any[]) => {
      history = updateFn(history);
    });
    const setPlan = vi.fn(async () => {});
    // The bound ACP batch is a session-data command now; apply the same shared
    // planner the production adapter uses.
    const applyAgentBatch = vi.fn(async (input: any) => {
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
        receipt: {
          sessionId: 'session-1',
          kind: 'apply-agent-batch',
          turnIds: input.targetAssistantEntryId ? [input.targetAssistantEntryId] : [],
        },
      };
    });

    const doc = {
      updateHistory,
      setPlan,
      sessionData: {
        commands: { applyAgentBatch },
        history: {
          count: async () => 0,
          readAt: async () => ({ state: 'missing' as const }),
          readTurn: async () => ({ state: 'missing' as const }),
          readRange: async () => [],
          readDirectory: async () => [],
          observe: () => ({ initial: Promise.resolve([]), unsubscribe: () => {} }),
        },
        durability: { waitDurable: async () => {} },
      },
    } as any;

    await appendAutonomousACPNotifications(
      doc,
      [
        makeNotification({
          sessionUpdate: 'plan',
          entries: [{ content: 'a', priority: 'low', status: 'pending' }],
        }),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        }),
        makeNotification({
          sessionUpdate: 'plan',
          entries: [{ content: 'b', priority: 'high', status: 'in_progress' }],
        }),
      ],
      {} as any
    );

    expect(setPlan).toHaveBeenCalledTimes(1);
    expect(setPlan).toHaveBeenCalledWith([
      { content: 'b', priority: 'high', status: 'in_progress' },
    ]);
  });
});
