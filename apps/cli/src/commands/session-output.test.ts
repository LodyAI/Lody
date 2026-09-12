import { withHistoryPort } from '../../tests/history-port-fixture';
import { describe, expect, it, vi } from 'vitest';
import type { SessionHistoryInput, SessionId } from '@lody/shared';
import {
  SessionTurnWaitError,
  calculateTurnDurationMs,
  findAssistantEntryForUserTurn,
  waitForTurnCompletion,
} from './session-output';

type MirrorState = {
  history?: SessionHistoryInput[];
};

const createHistoryEntry = (overrides: Partial<SessionHistoryInput>): SessionHistoryInput => ({
  id: 'entry-id',
  role: 'assistant',
  timestamp: '2026-03-27T00:00:00.000Z',
  items: [],
  fileDiff: [],
  ...overrides,
});

const createMirror = (initialState: MirrorState) => {
  let state = initialState;
  const listeners = new Set<(next: MirrorState) => void>();

  return {
    getState: () => state,
    subscribe: (listener: (next: MirrorState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState: (next: MirrorState) => {
      state = next;
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
};

const createSessionDoc = (mirror: ReturnType<typeof createMirror>) =>
  withHistoryPort({
    sessionId: 'session-1' as SessionId,
    readHistorySnapshot: () => mirror.getState().history ?? [],
    subscribeAll: (listener: () => void) => mirror.subscribe(() => listener()),
  });

describe('session output helpers', () => {
  it('finds the assistant entry linked to the target user turn', () => {
    const history = [
      createHistoryEntry({
        id: 'assistant-before',
        role: 'assistant',
      }),
      createHistoryEntry({
        id: 'user-1',
        role: 'user',
      }),
      createHistoryEntry({
        id: 'assistant-unrelated',
        role: 'assistant',
        userTurnId: 'user-2',
      }),
      createHistoryEntry({
        id: 'assistant-target',
        role: 'assistant',
        userTurnId: 'user-1',
      }),
    ];

    expect(findAssistantEntryForUserTurn(history, 'user-1')?.id).toBe('assistant-target');
  });

  it('streams updated assistant items and resolves when the turn finishes', async () => {
    const userTurn = createHistoryEntry({
      id: 'user-1',
      role: 'user',
      status: 'processing',
      items: [{ type: 'text', text: 'hello' }],
    });
    const mirror = createMirror({ history: [userTurn] });
    const events: Array<Record<string, unknown>> = [];
    const completion = waitForTurnCompletion({
      sessionDoc: createSessionDoc(mirror),
      userTurnId: 'user-1',
      outputMode: 'jsonl',
      timeoutMs: 5_000,
      onEvent: (event) => {
        events.push(event);
      },
    });

    mirror.setState({
      history: [
        userTurn,
        createHistoryEntry({
          id: 'assistant-1',
          role: 'assistant',
          userTurnId: 'user-1',
          items: [{ type: 'text', text: 'working' }],
        }),
      ],
    });
    mirror.setState({
      history: [
        userTurn,
        createHistoryEntry({
          id: 'assistant-1',
          role: 'assistant',
          userTurnId: 'user-1',
          items: [{ type: 'text', text: 'working harder' }],
        }),
      ],
    });
    mirror.setState({
      history: [
        createHistoryEntry({
          ...userTurn,
          status: 'handled',
        }),
        createHistoryEntry({
          id: 'assistant-1',
          role: 'assistant',
          userTurnId: 'user-1',
          items: [{ type: 'text', text: 'working harder' }],
          finished: true,
          endedAt: Date.parse('2026-03-27T00:00:02.000Z'),
        }),
      ],
    });

    const completedTurn = await completion;
    expect(completedTurn.turnId).toBe('assistant-1');
    expect(completedTurn.content).toEqual([{ type: 'text', text: 'working harder' }]);
    expect(events).toEqual([
      {
        type: 'update',
        sessionId: 'session-1',
        turnId: 'assistant-1',
        content: { type: 'text', text: 'working' },
      },
      {
        type: 'update',
        sessionId: 'session-1',
        turnId: 'assistant-1',
        content: { type: 'text', text: 'working harder' },
      },
      {
        type: 'done',
        sessionId: 'session-1',
        turnId: 'assistant-1',
        durationMs: 2_000,
      },
    ]);
  });

  it('surfaces chat failure notices from history', async () => {
    const userTurn = createHistoryEntry({
      id: 'user-1',
      role: 'user',
      status: 'processing',
    });
    const mirror = createMirror({ history: [userTurn] });
    const completion = waitForTurnCompletion({
      sessionDoc: createSessionDoc(mirror),
      userTurnId: 'user-1',
      outputMode: 'json',
      timeoutMs: 5_000,
    });

    mirror.setState({
      history: [
        createHistoryEntry({
          ...userTurn,
          status: 'failed',
        }),
        createHistoryEntry({
          id: 'system-notice-1',
          role: 'system',
          items: [
            {
              type: 'system_notice',
              name: 'chat_failed',
              meta: {
                reason: 'acp_internal_error',
                message: 'agent failed',
              },
            },
          ],
        }),
      ],
    });

    await expect(completion).rejects.toEqual(
      expect.objectContaining({
        code: 'failed',
        message: 'agent failed',
      })
    );
  });

  it('ignores unrelated assistant turns until the linked turn completes', async () => {
    const userTurn = createHistoryEntry({
      id: 'user-1',
      role: 'user',
      status: 'processing',
      items: [{ type: 'text', text: 'hello' }],
    });
    const unrelatedAssistant = createHistoryEntry({
      id: 'assistant-auto',
      role: 'assistant',
      items: [{ type: 'text', text: 'auto prompt' }],
      finished: true,
      endedAt: Date.parse('2026-03-27T00:00:01.000Z'),
    });
    const mirror = createMirror({ history: [userTurn] });
    const completion = waitForTurnCompletion({
      sessionDoc: createSessionDoc(mirror),
      userTurnId: 'user-1',
      outputMode: 'json',
      timeoutMs: 5_000,
    });

    mirror.setState({
      history: [userTurn, unrelatedAssistant],
    });
    mirror.setState({
      history: [
        userTurn,
        unrelatedAssistant,
        createHistoryEntry({
          id: 'assistant-1',
          role: 'assistant',
          userTurnId: 'user-1',
          items: [{ type: 'text', text: 'actual response' }],
        }),
      ],
    });
    mirror.setState({
      history: [
        createHistoryEntry({
          ...userTurn,
          status: 'handled',
        }),
        unrelatedAssistant,
        createHistoryEntry({
          id: 'assistant-1',
          role: 'assistant',
          userTurnId: 'user-1',
          items: [{ type: 'text', text: 'actual response' }],
          finished: true,
          endedAt: Date.parse('2026-03-27T00:00:03.000Z'),
        }),
      ],
    });

    await expect(completion).resolves.toEqual(
      expect.objectContaining({
        turnId: 'assistant-1',
        content: [{ type: 'text', text: 'actual response' }],
      })
    );
  });

  it('rejects canceled turns even if the assistant entry already ended', async () => {
    const userTurn = createHistoryEntry({
      id: 'user-1',
      role: 'user',
      status: 'processing',
      items: [{ type: 'text', text: 'hello' }],
    });
    const mirror = createMirror({ history: [userTurn] });
    const completion = waitForTurnCompletion({
      sessionDoc: createSessionDoc(mirror),
      userTurnId: 'user-1',
      outputMode: 'json',
      timeoutMs: 5_000,
    });

    mirror.setState({
      history: [
        userTurn,
        createHistoryEntry({
          id: 'assistant-1',
          role: 'assistant',
          userTurnId: 'user-1',
          items: [{ type: 'text', text: 'partial response' }],
          finished: true,
          endedAt: Date.parse('2026-03-27T00:00:02.000Z'),
        }),
      ],
    });
    mirror.setState({
      history: [
        createHistoryEntry({
          ...userTurn,
          status: 'canceled',
        }),
        createHistoryEntry({
          id: 'assistant-1',
          role: 'assistant',
          userTurnId: 'user-1',
          items: [{ type: 'text', text: 'partial response' }],
          finished: true,
          endedAt: Date.parse('2026-03-27T00:00:02.000Z'),
        }),
      ],
    });

    await expect(completion).rejects.toMatchObject({
      code: 'canceled',
      message: 'Session turn was canceled.',
    });
  });

  it('times out when the turn never finishes', async () => {
    vi.useFakeTimers();
    try {
      const mirror = createMirror({
        history: [
          createHistoryEntry({
            id: 'user-1',
            role: 'user',
            status: 'processing',
          }),
        ],
      });

      const completion = waitForTurnCompletion({
        sessionDoc: createSessionDoc(mirror),
        userTurnId: 'user-1',
        outputMode: 'json',
        timeoutMs: 1_000,
      });
      const rejection = expect(completion).rejects.toMatchObject({
        code: 'timeout',
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      await expect(completion).rejects.toBeInstanceOf(SessionTurnWaitError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calculates turn durations from timestamp and endedAt', () => {
    expect(
      calculateTurnDurationMs({
        timestamp: '2026-03-27T00:00:00.000Z',
        endedAt: Date.parse('2026-03-27T00:00:03.000Z'),
      })
    ).toBe(3_000);
  });
});
