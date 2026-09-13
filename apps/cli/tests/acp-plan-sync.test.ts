import { SessionDocument } from '../src/lib/loro/doc';
import { composeTestSessionDoc } from './session-doc-fixture';
import { withHistoryPort } from './history-port-fixture';
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
  it('surfaces refused and unknown plan writes without reporting success', async () => {
    const doc = new SessionDocument({} as never, 'plan-session' as SessionId);
    composeTestSessionDoc(doc, {
      history: [
        {
          id: 'a',
          role: 'assistant',
          timestamp: '2026-01-01T00:00:00Z',
          items: [],
          fileDiff: [],
          plan: [],
        },
      ],
    });
    await expect(
      doc.setPlan([{ content: 'bad', priority: 'invalid', status: 'pending' }] as never)
    ).rejects.toThrow('Session write rejected: invalid_input');
    expect((await doc.sessionData.history.readAll())[0]?.plan).toEqual([]);
    const cause = new Error('storage outcome unknown');
    const stub = vi
      .spyOn(doc, 'agentWrites', 'get')
      .mockReturnValue({
        ...doc.agentWrites,
        setTurnField: async () => ({ status: 'indeterminate', cause }),
      });
    await expect(doc.setPlan([])).rejects.toBe(cause);
    stub.mockRestore();
    await expect(
      doc.setPlan([{ content: 'valid', priority: 'low', status: 'pending' }])
    ).resolves.toBeUndefined();
    expect((await doc.sessionData.history.readAll())[0]?.plan).toEqual([
      { content: 'valid', priority: 'low', status: 'pending' },
    ]);
    expect(await doc.getDocState()).not.toHaveProperty('history');
  });

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

    const doc = withHistoryPort({
      updateHistory,
      setPlan,
      agentWrites: { applyAgentBatch },
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
