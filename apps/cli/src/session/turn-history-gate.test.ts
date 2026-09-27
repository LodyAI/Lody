import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHistoryInput, SessionId } from '@lody/shared';
import type { Logger } from '@/utils/logger';

import {
  DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS,
  TurnHistoryGate,
  type TurnHistoryGateOpenReason,
} from './turn-history-gate';

const sessionId = 'session-1' as SessionId;
const userTurnId = 'user-turn-1';

const logger = {
  debug: () => {},
  trace: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

function userEntry(id: string): SessionHistoryInput {
  return {
    id,
    role: 'user',
    timestamp: '2026-07-03T00:00:00.000Z',
    read: undefined,
    userId: 'user-1',
    fileDiff: [],
    items: [] as unknown as SessionHistoryInput['items'],
  };
}

function assistantEntry(id: string): SessionHistoryInput {
  return { ...userEntry(id), role: 'assistant', userId: undefined };
}

/** Minimal fake of the session doc surface the gate consumes. */
function createFakeDoc(initialHistory: SessionHistoryInput[] = []) {
  let history = initialHistory;
  const listeners = new Set<() => void>();
  const unsubscribed: Array<() => void> = [];
  return {
    setHistory(next: SessionHistoryInput[]) {
      history = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    get subscriberCount() {
      return listeners.size;
    },
    unsubscribed,
    readHistory: () => Promise.resolve(history),
    subscribeHistory: (listener: () => void) => {
      listeners.add(listener);
      const unsubscribe = () => {
        listeners.delete(listener);
      };
      unsubscribed.push(unsubscribe);
      return unsubscribe;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('TurnHistoryGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('alreadyOpen() resolves immediately and never runs hooks', async () => {
    const gate = TurnHistoryGate.alreadyOpen();
    expect(gate.isOpen).toBe(true);
    await expect(gate.waitUntilOpen()).resolves.toBeUndefined();
  });

  it('opens immediately when the user turn entry is already local', async () => {
    const doc = createFakeDoc([userEntry(userTurnId)]);
    const reasons: TurnHistoryGateOpenReason[] = [];
    const gate = TurnHistoryGate.waitForUserTurn({
      logger,
      sessionId,
      userTurnId,
      readHistory: doc.readHistory,
      subscribeHistory: doc.subscribeHistory,
      onBeforeOpen: async (reason) => {
        reasons.push(reason);
      },
    });
    await flushMicrotasks();
    expect(gate.isOpen).toBe(true);
    expect(reasons).toEqual(['user-turn-synced']);
    await expect(gate.waitUntilOpen()).resolves.toBeUndefined();
    expect(doc.subscriberCount).toBe(0);
  });

  it('stays pending until the user turn entry syncs, then releases waiters after onBeforeOpen', async () => {
    // An assistant entry for a DIFFERENT turn must not satisfy the gate.
    const doc = createFakeDoc([assistantEntry('assistant:old-turn')]);
    const order: string[] = [];
    const gate = TurnHistoryGate.waitForUserTurn({
      logger,
      sessionId,
      userTurnId,
      readHistory: doc.readHistory,
      subscribeHistory: doc.subscribeHistory,
      onBeforeOpen: async () => {
        order.push('hook');
      },
    });
    const waiter = gate.waitUntilOpen().then(() => {
      order.push('waiter');
    });
    await flushMicrotasks();
    expect(gate.isOpen).toBe(false);

    // A history change without the entry does not open the gate.
    doc.setHistory([assistantEntry('assistant:old-turn'), userEntry('some-other-turn')]);
    await flushMicrotasks();
    expect(gate.isOpen).toBe(false);

    doc.setHistory([userEntry('some-other-turn'), userEntry(userTurnId)]);
    await flushMicrotasks();
    await waiter;
    expect(gate.isOpen).toBe(true);
    expect(order).toEqual(['hook', 'waiter']);
    expect(doc.subscriberCount).toBe(0);
  });

  it('opens on timeout when the entry never syncs (bounded degradation)', async () => {
    const doc = createFakeDoc([]);
    const reasons: TurnHistoryGateOpenReason[] = [];
    const gate = TurnHistoryGate.waitForUserTurn({
      logger,
      sessionId,
      userTurnId,
      readHistory: doc.readHistory,
      subscribeHistory: doc.subscribeHistory,
      onBeforeOpen: async (reason) => {
        reasons.push(reason);
      },
    });
    await flushMicrotasks();
    expect(gate.isOpen).toBe(false);

    await vi.advanceTimersByTimeAsync(DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS);
    await flushMicrotasks();
    expect(gate.isOpen).toBe(true);
    // The assistant entry is still created on timeout so downstream writes
    // have a target — only the ordering guarantee is degraded.
    expect(reasons).toEqual(['timeout']);
    await expect(gate.waitUntilOpen()).resolves.toBeUndefined();
  });

  it('respects a custom timeout', async () => {
    const doc = createFakeDoc([]);
    const gate = TurnHistoryGate.waitForUserTurn({
      logger,
      sessionId,
      userTurnId,
      readHistory: doc.readHistory,
      subscribeHistory: doc.subscribeHistory,
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(gate.isOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(gate.isOpen).toBe(true);
  });

  it('dispose releases waiters without running onBeforeOpen', async () => {
    const doc = createFakeDoc([]);
    const reasons: TurnHistoryGateOpenReason[] = [];
    const gate = TurnHistoryGate.waitForUserTurn({
      logger,
      sessionId,
      userTurnId,
      readHistory: doc.readHistory,
      subscribeHistory: doc.subscribeHistory,
      onBeforeOpen: async (reason) => {
        reasons.push(reason);
      },
    });
    const waiter = gate.waitUntilOpen();
    gate.dispose();
    await flushMicrotasks();
    await waiter;
    expect(gate.isOpen).toBe(true);
    expect(reasons).toEqual([]);
    expect(doc.subscriberCount).toBe(0);
    // A late sync after dispose must not run the hook either.
    doc.setHistory([userEntry(userTurnId)]);
    await flushMicrotasks();
    expect(reasons).toEqual([]);
  });

  it('still opens when onBeforeOpen throws (fail open)', async () => {
    const doc = createFakeDoc([userEntry(userTurnId)]);
    const gate = TurnHistoryGate.waitForUserTurn({
      logger,
      sessionId,
      userTurnId,
      readHistory: doc.readHistory,
      subscribeHistory: doc.subscribeHistory,
      onBeforeOpen: async () => {
        throw new Error('boom');
      },
    });
    await flushMicrotasks();
    expect(gate.isOpen).toBe(true);
    await expect(gate.waitUntilOpen()).resolves.toBeUndefined();
  });

  it('survives readHistory failures and opens once a later check succeeds', async () => {
    let failNext = true;
    const doc = createFakeDoc([]);
    const gate = TurnHistoryGate.waitForUserTurn({
      logger,
      sessionId,
      userTurnId,
      readHistory: () => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('doc unavailable'));
        }
        return doc.readHistory();
      },
      subscribeHistory: doc.subscribeHistory,
    });
    await flushMicrotasks();
    expect(gate.isOpen).toBe(false);

    doc.setHistory([userEntry(userTurnId)]);
    await flushMicrotasks();
    expect(gate.isOpen).toBe(true);
  });

  it('coalesces overlapping checks and re-reads after a mid-check change', async () => {
    let resolveRead: ((history: SessionHistoryInput[]) => void) | null = null;
    const reads: number[] = [];
    const listeners = new Set<() => void>();
    const gate = TurnHistoryGate.waitForUserTurn({
      logger,
      sessionId,
      userTurnId,
      readHistory: () => {
        reads.push(reads.length);
        return new Promise<SessionHistoryInput[]>((resolve) => {
          resolveRead = resolve;
        });
      },
      subscribeHistory: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    await flushMicrotasks();
    expect(reads.length).toBe(1);

    // Notifications while a read is in flight coalesce into one follow-up read.
    for (const listener of [...listeners]) listener();
    for (const listener of [...listeners]) listener();
    await flushMicrotasks();
    expect(reads.length).toBe(1);

    // First read misses; the coalesced re-check runs and finds the entry.
    const firstResolve = resolveRead as unknown as (history: SessionHistoryInput[]) => void;
    firstResolve([]);
    await flushMicrotasks();
    expect(reads.length).toBe(2);
    const secondResolve = resolveRead as unknown as (history: SessionHistoryInput[]) => void;
    secondResolve([userEntry(userTurnId)]);
    await flushMicrotasks();
    expect(gate.isOpen).toBe(true);
  });

  it('relies on the timeout when no doc subscription is available', async () => {
    const gate = TurnHistoryGate.waitForUserTurn({
      logger,
      sessionId,
      userTurnId,
      readHistory: () => Promise.resolve([]),
      subscribeHistory: () => undefined,
      timeoutMs: 1_000,
    });
    await flushMicrotasks();
    expect(gate.isOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(gate.isOpen).toBe(true);
  });
});
