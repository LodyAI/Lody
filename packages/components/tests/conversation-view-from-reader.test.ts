import { describe, expect, it, vi } from 'vitest';
import type { LoroMap } from 'loro-crdt';
import type { SessionHistory } from '@lody/shared';
import { createHistoryWriter } from '@lody/shared';
import {
  createLoroSessionData,
  createMemorySessionData,
  setFieldTo,
  type MemorySessionData,
  type SessionData,
  type SessionDataChangeListener,
  type SessionHistoryReader,
  type SessionTurn,
} from '@lody/shared/session-data';
import {
  createConversationViewFromReader,
  type ConversationView,
} from '../src/lib/conversation-view';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
  type ManualIdle,
} from './conversation-view-fixtures';

/**
 * The same UI-facing `ConversationView`, driven over BOTH session-data
 * backends. The Loro arm builds a real doc (fixtures may touch it) and reads
 * exclusively through the port; the memory arm has no Loro/CID anywhere. Every
 * case runs against both, which is what proves the display cache no longer
 * depends on Loro.
 */

type Backend = {
  name: string;
  create(history: SessionHistory[]): { data: SessionData; teardown(): void };
};

const backends: Backend[] = [
  {
    name: 'loro',
    create: (history) => {
      const doc = buildSessionDoc(history);
      const data = createLoroSessionData({ sessionId: FIXTURE_SESSION_ID, doc });
      return { data, teardown: () => doc.free() };
    },
  },
  {
    name: 'memory',
    create: (history) => {
      const data = createMemorySessionData({
        sessionId: FIXTURE_SESSION_ID,
        initialTurns: history as SessionTurn[],
      });
      return { data, teardown: () => {} };
    },
  },
];

const customUserTurn = (): SessionHistory =>
  ({
    id: 'u-empty-mcp',
    role: 'user',
    timestamp: '2026-01-01T00:00:30.000Z',
    status: 'handled',
    read: true,
    userId: 'user-1',
    fileDiff: [],
    items: [{ type: 'text', text: 'empty selection' }],
    inputConfig: {
      prompt: 'empty selection',
      cliType: 'builtin',
      agentType: 'claude',
      inputBlocks: [{ type: 'text', text: 'empty selection' }],
      agentRoleId: 'role-empty',
      agentRoleRevision: 9,
      mcpServerIds: [],
    },
  }) as unknown as SessionHistory;

/** Fixture history with one user turn carrying an explicit empty MCP selection. */
const fixtureHistory = (rounds: number): SessionHistory[] => {
  const history = buildFixtureHistory(rounds);
  history.splice(3, 0, customUserTurn());
  return history;
};

const openView = (
  backend: Backend,
  rounds: number,
  options: { tailKeep?: number; maxHydrated?: number; hydrateChunkSize?: number; hydrateItemBudget?: number } = {}
) => {
  const history = fixtureHistory(rounds);
  const { data, teardown } = backend.create(history);
  const idle = createManualIdle();
  const view = createConversationViewFromReader(data.history, {
    sessionId: FIXTURE_SESSION_ID,
    tailKeep: options.tailKeep ?? 4,
    maxHydrated: options.maxHydrated ?? 6,
    scheduleIdle: idle.scheduleIdle,
    yieldToEventLoop: () => Promise.resolve(),
    hydrateChunkSize: options.hydrateChunkSize ?? 2,
    hydrateItemBudget: options.hydrateItemBudget ?? 10_000,
  });
  // Raw membership/order mutation (not expressible as a domain command): the
  // Loro arm goes through the shared writer, the memory arm through the peer
  // mutation hook. Both produce an observer event, not a command receipt.
  const mutateHistory = (update: (turns: SessionTurn[]) => SessionTurn[]): void => {
    const writer = (data as { writer?: { update: (updater: (history: unknown[]) => unknown[]) => void } }).writer;
    if (writer) {
      writer.update((current) => update(current as SessionTurn[]) as unknown[]);
      return;
    }
    (data as MemorySessionData).applyPeerMutation((turns) => {
      const next = update(turns);
      turns.splice(0, turns.length, ...next);
    });
  };
  return { expected: history, idle, view, data, teardown, mutateHistory };
};

/** Drain the manual idle pass until the background pass settles. */
const settle = async (idle: ManualIdle, view: ConversationView) => {
  await vi.waitFor(
    async () => {
      idle.runAll();
      const settled = await Promise.race([
        view.ready.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
      ]);
      if (!settled) throw new Error('background pass not settled yet');
    },
    { interval: 10, timeout: 10_000 }
  );
};

/** Wait until the initial directory has applied (before any idle pass runs). */
const waitTurns = async (view: ConversationView, count: number) => {
  await vi.waitFor(() => {
    expect(view.turnCount).toBe(count);
  });
};

/** Let queued microtask/macrotask change handling finish. */
const flush = async () => {
  for (let round = 0; round < 12; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

class Deferred {
  resolve!: () => void;
  promise = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });
}

/** A reader wrapper that records reads and can gate or fail turn reads. */
const probeReader = (base: SessionHistoryReader) => {
  const directories: Array<[number, number]> = [];
  const turns: string[] = [];
  const gates = new Map<string, Deferred>();
  let fail = false;
  const reader: SessionHistoryReader = {
    count: () => base.count(),
    readAt: (position) => base.readAt(position),
    readTurn: async (id) => {
      turns.push(id);
      if (fail) throw new Error('synthetic hydration failure');
      const gate = gates.get(id);
      if (gate) await gate.promise;
      return base.readTurn(id);
    },
    readRange: (from, to) => base.readRange(from, to),
    readDirectory: (from, to) => {
      directories.push([from, to]);
      return base.readDirectory(from, to);
    },
    observe: (listener) => base.observe(listener),
  };
  return {
    reader,
    directories,
    turns,
    gate: (id: string) => {
      const deferred = new Deferred();
      gates.set(id, deferred);
      return deferred.promise;
    },
    release: (id: string) => {
      gates.get(id)?.resolve();
      gates.delete(id);
    },
    releaseAll: () => {
      for (const gate of gates.values()) gate.resolve();
      gates.clear();
    },
    setFail: (value: boolean) => {
      fail = value;
    },
  };
};

/** A wrapper that forwards observation and can inject a `reset` signal. */
const resetWrapper = (base: SessionHistoryReader) => {
  let listener: SessionDataChangeListener | null = null;
  const observation = base.observe((change) => listener?.(change));
  const reader: SessionHistoryReader = {
    count: () => base.count(),
    readAt: (position) => base.readAt(position),
    readTurn: (id) => base.readTurn(id),
    readRange: (from, to) => base.readRange(from, to),
    readDirectory: (from, to) => base.readDirectory(from, to),
    observe: (next) => {
      listener = next;
      return observation;
    },
  };
  return { reader, triggerReset: () => listener?.({ kind: 'reset' }) };
};

const scalarsOf = (row: Record<string, unknown>) => ({
  id: row.id,
  role: row.role,
  timestamp: row.timestamp,
  status: row.status,
  finished: row.finished,
  endedAt: row.endedAt,
  sendStatus: row.sendStatus,
  userTurnId: row.userTurnId,
  acpTurnId: row.acpTurnId,
});

describe.each(backends)('createConversationViewFromReader over $name', (backend) => {
  it('indexes every turn from directory scalars and answers synchronously by turnId', async () => {
    const harness = openView(backend, 12);
    const { view, expected } = harness;
    try {
      // The snapshot is empty until the port's initial directory lands...
      expect(view.turnCount).toBe(0);
      expect(view.version).toBe(0);
      await waitTurns(view, expected.length);
      await flush();
      // ...then every accessor is synchronous and does no I/O. The tail is
      // hydrated eagerly (as in the doc-backed view); the rest waits for a lease.
      expected.forEach((entry, i) => {
        const row = view.index(i)!;
        expect(scalarsOf(row as unknown as Record<string, unknown>)).toEqual(
          scalarsOf(entry as unknown as Record<string, unknown>)
        );
        expect(view.indexOf(entry.id)).toBe(i);
        const inTail = i >= expected.length - 4;
        expect(view.isHydrated(i)).toBe(inTail);
        expect(view.turn(i)).toEqual(inTail ? expected[i] : undefined);
      });
      expect(view.indexOf('missing')).toBe(-1);
      expect(view.version).toBeGreaterThan(0);
      view.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('exposes send-critical Role/MCP config from directory rows before ready and before body hydration', async () => {
    const harness = openView(backend, 6, { tailKeep: 2 });
    const { view, idle, expected } = harness;
    try {
      await waitTurns(view, expected.length);
      const at = view.indexOf('u-empty-mcp');
      expect(at).toBe(3);
      // Not hydrated (outside the tail) and the background pass has not run.
      expect(view.isHydrated(at)).toBe(false);
      let ready = false;
      void view.ready.then(() => {
        ready = true;
      });
      expect(ready).toBe(false);
      const config = view.index(at)?.inputConfig;
      expect(config).toMatchObject({ agentRoleId: 'role-empty', agentRoleRevision: 9 });
      // The explicit empty MCP selection survives the directory projection.
      expect(config?.mcpServerIds).toEqual([]);
      expect(view.index(0)?.inputConfig).toMatchObject({ modelId: 'sonnet' });
      await settle(idle, view);
      expect(ready).toBe(true);
      // The idle pass filled summaries/counts without hydrating the turn body.
      expect(view.index(at)?.summary?.headText).toContain('empty selection');
      expect(view.index(at)?.itemCount).toBe(1);
      expect(view.isHydrated(at)).toBe(false);
      view.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('hydrates the tail and acquired ranges on demand, matching the stored turns', async () => {
    const harness = openView(backend, 12, { tailKeep: 4 });
    const { view, idle, expected } = harness;
    try {
      await settle(idle, view);
      const n = expected.length;
      for (let i = 0; i < n; i += 1) expect(view.isHydrated(i)).toBe(i >= n - 4);
      expect(view.turn(n - 1)).toEqual(expected[n - 1]);
      expect(view.turn(0)).toBeUndefined();

      const range = view.acquireRange(0, 5);
      await range.ready;
      for (let i = 0; i < 5; i += 1) expect(view.turn(i)).toEqual(expected[i]);
      expect(view.index(0)?.summary?.headText).toContain('Round 0');
      expect(view.index(1)?.summary?.toolCalls).toBe(1);
      expect(view.index(2)?.inputConfig).toMatchObject({ modeId: 'plan', modelId: 'sonnet' });
      range.release();
      view.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('pins by turnId: an insert shifts positions but not another lease, and release frees only its own', async () => {
    const harness = openView(backend, 20, { tailKeep: 2, maxHydrated: 6 });
    const { view, idle, mutateHistory } = harness;
    try {
      await settle(idle, view);
      const captured = Array.from({ length: 8 }, (_, i) => view.index(i)!.id);
      const range = view.acquireRange(0, 8);
      await range.ready;
      const overlap = view.acquireRange(0, 4);
      await overlap.ready;
      overlap.release();
      for (let i = 0; i < 8; i += 1) expect(view.isHydrated(i)).toBe(true);

      // A structural insert at the head: every captured id stays hydrated at its
      // NEW position, keyed by turnId rather than the old position.
      mutateHistory((turns) => [
        { ...turns[0]!, id: 'u-inserted' } as SessionTurn,
        ...turns,
      ]);
      await flush();
      expect(view.indexOf('u-inserted')).toBe(0);
      expect(view.indexOf('u-0')).toBe(1);
      for (const id of captured) {
        const pos = view.indexOf(id);
        expect(pos).toBeGreaterThanOrEqual(1);
        expect(view.isHydrated(pos)).toBe(true);
      }
      range.release();
      let hydrated = 0;
      for (let i = 0; i < view.turnCount; i += 1) if (view.isHydrated(i)) hydrated += 1;
      expect(hydrated).toBeLessThanOrEqual(6);
      expect(view.isHydrated(view.turnCount - 1)).toBe(true);
      view.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('stops pending chunked hydration when its lease is released', async () => {
    const harness = openView(backend, 20, { tailKeep: 2 });
    const { idle, data } = harness;
    const probe = probeReader(data.history);
    const probeView = createConversationViewFromReader(probe.reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 2,
      maxHydrated: 6,
      scheduleIdle: idle.scheduleIdle,
      yieldToEventLoop: () => Promise.resolve(),
      hydrateChunkSize: 2,
      hydrateItemBudget: 10_000,
    });
    try {
      await settle(idle, probeView);
      probe.setFail(false);
      void probe.gate('u-0');
      const range = probeView.acquireRange(0, 4);
      await flush();
      expect(probeView.isHydrated(0)).toBe(false);
      range.release();
      probe.release('u-0');
      await flush();
      expect(probeView.isHydrated(0)).toBe(false);
      expect(probeView.turn(0)).toBeUndefined();
      await range.ready;
      expect(probeView.turn(0)).toBeUndefined();
      probeView.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('releases pins and leaves no phantom row when hydration fails', async () => {
    const harness = openView(backend, 12, { tailKeep: 4 });
    const { idle, data, expected } = harness;
    const probe = probeReader(data.history);
    const probeView = createConversationViewFromReader(probe.reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 4,
      maxHydrated: 6,
      scheduleIdle: idle.scheduleIdle,
      yieldToEventLoop: () => Promise.resolve(),
      hydrateChunkSize: 2,
      hydrateItemBudget: 10_000,
    });
    try {
      await settle(idle, probeView);
      probe.setFail(true);
      const failing = probeView.acquireRange(0, 2);
      await expect(failing.ready).rejects.toThrow('synthetic hydration failure');
      expect(probeView.turn(0)).toBeUndefined();
      expect(probeView.index(0)?.id).toBe(expected[0]!.id);
      probe.setFail(false);
      const retried = probeView.acquireRange(0, 2);
      await retried.ready;
      expect(probeView.turn(0)).toEqual(expected[0]);
      retried.release();
      probeView.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('discards a lease response that resolves after a newer structural change', async () => {
    const harness = openView(backend, 12, { tailKeep: 4 });
    const { idle, data } = harness;
    const probe = probeReader(data.history);
    const probeView = createConversationViewFromReader(probe.reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 4,
      maxHydrated: 6,
      scheduleIdle: idle.scheduleIdle,
      yieldToEventLoop: () => Promise.resolve(),
      hydrateChunkSize: 2,
      hydrateItemBudget: 10_000,
    });
    try {
      await settle(idle, probeView);
      void probe.gate('u-0');
      const range = probeView.acquireRange(0, 2);
      await flush();
      // A structural change lands while the first chunk's reads are gated.
      await data.commands.appendTurn(
        { ...customUserTurn(), id: 'u-discard' } as unknown as SessionTurn
      );
      await flush();
      probe.release('u-0');
      await flush();
      await range.ready;
      // The stale response was discarded, then the still-active lease re-read
      // and refilled it with the current body (fc rule: dropping an outdated
      // response must not leave an active lease with a hole).
      expect(probeView.isHydrated(0)).toBe(true);
      expect(probeView.turn(0)?.id).toBe('u-0');
      expect(probeView.turnCount).toBe(harness.expected.length + 1);
      probeView.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('applies a ranged change by re-reading only the affected range', async () => {
    const harness = openView(backend, 12, { tailKeep: 4 });
    const { idle, data } = harness;
    const probe = probeReader(data.history);
    const probeView = createConversationViewFromReader(probe.reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 4,
      maxHydrated: 6,
      scheduleIdle: idle.scheduleIdle,
      yieldToEventLoop: () => Promise.resolve(),
      hydrateChunkSize: 2,
      hydrateItemBudget: 10_000,
    });
    try {
      await settle(idle, probeView);
      const last = probeView.turnCount - 1;
      const lastId = probeView.index(last)!.id;
      expect(probeView.isHydrated(last)).toBe(true);
      probe.directories.length = 0;
      probe.turns.length = 0;

      await data.commands.setTurnField(lastId, 'finished', setFieldTo(false));
      await flush();

      // Exactly the affected raw range was re-read — never a full reload.
      expect(probe.directories).toEqual([[last, last + 1]]);
      expect(probe.turns).toEqual([lastId]);
      expect(probeView.index(last)?.finished).toBe(false);
      probeView.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('patches a streamed tail update from its ranged event without a whole-history read', async () => {
    const harness = openView(backend, 12, { tailKeep: 4 });
    const { idle, data } = harness;
    const probe = probeReader(data.history);
    const probeView = createConversationViewFromReader(probe.reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 4,
      maxHydrated: 6,
      scheduleIdle: idle.scheduleIdle,
      yieldToEventLoop: () => Promise.resolve(),
      hydrateChunkSize: 2,
      hydrateItemBudget: 10_000,
    });
    try {
      await settle(idle, probeView);
      const last = probeView.turnCount - 1;
      const before = probeView.turn(last)!;
      const untouched = probeView.turn(last - 1)!;
      const changes: Array<{ kind: string; from?: number; to?: number }> = [];
      probeView.subscribe((change) => changes.push(change));
      probe.directories.length = 0;
      probe.turns.length = 0;

      const lastId = before.id;
      await data.commands.replaceTurn(lastId, {
        ...(before as unknown as SessionTurn),
        items: [...(before.items ?? []), { type: 'text', text: ' streamed' }],
      } as unknown as SessionTurn);
      await flush();

      const after = probeView.turn(last)!;
      expect(after).not.toBe(before);
      expect(after.items!.length).toBe((before.items?.length ?? 0) + 1);
      expect(probeView.turn(last - 1)).toBe(untouched);
      expect(changes.some((change) => change.kind === 'tail' && change.from === last)).toBe(true);
      // The ranged event re-read only the affected turn's directory row and body.
      expect(probe.directories.every(([from, to]) => to - from === 1 && from === last)).toBe(true);
      expect(probe.turns).toEqual([lastId]);
      probeView.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('emits structure for membership/order changes including same-length replacement', async () => {
    const harness = openView(backend, 12, { tailKeep: 4 });
    const { view, idle, mutateHistory } = harness;
    try {
      await settle(idle, view);
      const changes: Array<{ kind: string; from?: number; to?: number }> = [];
      view.subscribe((change) => changes.push(change));

      mutateHistory((turns) => {
        const next = turns.slice();
        next[2] = { ...next[2]!, id: 'u-1-replaced' } as SessionTurn;
        return next;
      });
      await flush();

      expect(view.indexOf('u-1-replaced')).toBe(2);
      expect(view.indexOf('u-1')).toBe(-1);
      const structure = changes.filter((change) => change.kind === 'structure');
      expect(structure.length).toBeGreaterThan(0);
      expect(structure[0]).toMatchObject({ from: 2, to: view.turnCount });
      view.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('sees appended turns and hydrates them into the tail from a ranged event', async () => {
    const harness = openView(backend, 12, { tailKeep: 4 });
    const { view, idle, data } = harness;
    try {
      await settle(idle, view);
      const before = view.turnCount;
      const appended = { ...customUserTurn(), id: 'u-appended' } as unknown as SessionTurn;
      await data.commands.appendTurn(appended);
      await flush();

      expect(view.turnCount).toBe(before + 1);
      expect(view.indexOf('u-appended')).toBe(before);
      expect(view.isHydrated(before)).toBe(true);
      expect(view.turn(before)?.id).toBe('u-appended');
      expect(view.index(before)?.inputConfig).toMatchObject({ agentRoleId: 'role-empty' });
      view.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('rebuilds the whole snapshot on reset, keeping later reads as no-ops after dispose', async () => {
    const harness = openView(backend, 12, { tailKeep: 4 });
    const { idle, data } = harness;
    const wrapped = resetWrapper(data.history);
    const wrappedView = createConversationViewFromReader(wrapped.reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 4,
      maxHydrated: 6,
      scheduleIdle: idle.scheduleIdle,
      yieldToEventLoop: () => Promise.resolve(),
      hydrateChunkSize: 2,
      hydrateItemBudget: 10_000,
    });
    try {
      await settle(idle, wrappedView);
      const changes: Array<{ kind: string; from?: number; to?: number }> = [];
      wrappedView.subscribe((change) => changes.push(change));
      const tailTurnBefore = wrappedView.turn(wrappedView.turnCount - 1)!;

      wrapped.triggerReset();
      await flush();

      expect(changes.some((change) => change.kind === 'structure')).toBe(true);
      expect(wrappedView.turnCount).toBe(harness.expected.length);
      // Continuity was lost: the tail was re-read, not trusted.
      const tailTurnAfter = wrappedView.turn(wrappedView.turnCount - 1)!;
      expect(tailTurnAfter).not.toBe(tailTurnBefore);
      expect(tailTurnAfter).toEqual(tailTurnBefore);

      wrappedView.dispose();
      expect(wrappedView.turnCount).toBe(0);
      const versionAfterDispose = wrappedView.version;
      await data.commands.appendTurn(
        { ...customUserTurn(), id: 'u-after-dispose' } as unknown as SessionTurn
      );
      await flush();
      expect(wrappedView.turnCount).toBe(0);
      expect(wrappedView.version).toBe(versionAfterDispose);
      const late = wrappedView.acquireRange(0, 2);
      await late.ready;
      expect(wrappedView.isHydrated(0)).toBe(false);
      wrappedView.dispose();
    } finally {
      harness.teardown();
    }
  });

  it('chunks a large acquireRange and emits range changes per chunk', async () => {
    const harness = openView(backend, 30, { tailKeep: 2, maxHydrated: 500, hydrateChunkSize: 8 });
    const { view, idle, expected } = harness;
    try {
      await settle(idle, view);
      const changes: string[] = [];
      view.subscribe((change) => changes.push(change.kind));
      const range = view.acquireRange(0, expected.length);
      await range.ready;
      for (let i = 0; i < expected.length; i += 1) expect(view.turn(i)).toEqual(expected[i]);
      expect(changes.filter((kind) => kind === 'range').length).toBeGreaterThan(1);
      range.release();
      view.dispose();
    } finally {
      harness.teardown();
    }
  });
});

describe('createConversationViewFromReader Loro-only wiring', () => {
  it('windowed createConversationSession builds its history from the session-data port', async () => {
    // The Loro arm of the shared suite proves the port reads; this pins the
    // production composition: the windowed session's `history` reads through
    // `sessionData.history`, never the raw doc.
    const { createConversationSession } = await import('../src/lib/conversation-view/create-conversation-session');
    const doc = buildSessionDoc(buildFixtureHistory(2));
    const idle = createManualIdle();
    const session = createConversationSession(doc, {
      sessionId: FIXTURE_SESSION_ID,
      windowed: true,
      scheduleIdle: idle.scheduleIdle,
    });
    try {
      await vi.waitFor(
        async () => {
          idle.runAll();
          const settled = await Promise.race([
            session.history.ready.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
          ]);
          if (!settled) throw new Error('not settled');
        },
        { interval: 10, timeout: 10_000 }
      );
      expect(session.history.turnCount).toBe(4);
      expect(session.history.index(0)?.id).toBe('u-0');
      expect(session.history.turn(3)?.id).toBe('a-1');
      // A domain write surfaces through the reader view's subscription.
      const updates: number[] = [];
      session.history.subscribe((change) => updates.push(change.kind));
      await session.sessionData.commands.setTurnField('a-1', 'finished', setFieldTo(false));
      await vi.waitFor(() => {
        expect(session.history.index(3)?.finished).toBe(false);
      });
      expect(updates.length).toBeGreaterThan(0);
    } finally {
      session.history.dispose();
      session.mirror.dispose();
      doc.free();
    }
  });

  it('keeps the raw writer for targeted writes and forwards peer edits', async () => {
    const doc = buildSessionDoc(buildFixtureHistory(1));
    const idle = createManualIdle();
    const { createConversationSession } = await import('../src/lib/conversation-view/create-conversation-session');
    const session = createConversationSession(doc, {
      sessionId: FIXTURE_SESSION_ID,
      windowed: true,
      scheduleIdle: idle.scheduleIdle,
    });
    try {
      await vi.waitFor(
        async () => {
          idle.runAll();
          const settled = await Promise.race([
            session.history.ready.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
          ]);
          if (!settled) throw new Error('not settled');
        },
        { interval: 10, timeout: 10_000 }
      );
      // A peer (second writer over the same doc) streams into the tail turn.
      const peer = createHistoryWriter(doc);
      const entry = buildFixtureHistory(1)[1]!;
      peer.update((history) => {
        const next = history.slice();
        next[1] = { ...next[1]!, items: [...(next[1]!.items ?? []), { type: 'text', text: ' peer' }] } as SessionHistory;
        return next;
      });
      await vi.waitFor(() => {
        expect(session.history.turn(1)?.items?.length).toBeGreaterThan(entry.items?.length ?? 0);
      });
    } finally {
      session.history.dispose();
      session.mirror.dispose();
      doc.free();
    }
  });
});

/**
 * Regressions pinned by the 8c reader audit. The first two also ran against the
 * previous raw `createConversationViewFromDoc` as a same-document control, so
 * the asserted behavior is "the display cache must not be worse than the raw
 * view", not new product behavior.
 */
describe('createConversationViewFromReader audit regressions', () => {
  const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('a scalar change to an early turn preserves the later directory rows', async () => {
    // `to` from the ranged event is a local endpoint, not the list length; a
    // narrow content change must never truncate the visible directory.
    const history = buildFixtureHistory(3);
    const doc = buildSessionDoc(history);
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    const view = createConversationViewFromReader(data.history, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      await checkpoint();
      expect(view.turnCount).toBe(6);
      const result = await data.commands.setTurnField('a-0', 'finished', setFieldTo(false));
      expect(result.status).toBe('accepted');
      await checkpoint();
      expect(await data.history.count()).toBe(6);
      expect(Array.from({ length: view.turnCount }, (_, i) => view.index(i)?.id)).toEqual(
        history.map((turn) => turn.id)
      );
    } finally {
      view.dispose();
      doc.free();
    }
  });

  it('a mixed structural batch refreshes bodies of surviving hydrated turns', async () => {
    const history = buildFixtureHistory(3);
    const doc = buildSessionDoc(history);
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    const view = createConversationViewFromReader(data.history, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      await checkpoint();
      await view.acquireRange(0, 6).ready;
      // One commit: an early content change plus a tail append.
      const list = doc.getList('history');
      (list.get(1) as LoroMap).set('finished', false);
      list.push({ ...history[0], id: 'new' } as never);
      doc.commit();
      await checkpoint();
      expect(view.turnCount).toBe(7);
      expect(view.turn(1)?.finished).toBe(false);
    } finally {
      view.dispose();
      doc.free();
    }
  });

  it('an idle summary read cannot overwrite a row after a head insertion', async () => {
    const history = buildFixtureHistory(3);
    const doc = buildSessionDoc(history);
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (started = resolve));
    const tasks: Array<(deadline: { timeRemaining(): number }) => void> = [];
    let shouldBlock = true;
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurn: async (id) => {
        const value = await data.history.readTurn(id);
        if (id === 'a-2' && shouldBlock) {
          shouldBlock = false;
          started();
          await blocked;
        }
        return value;
      },
    };
    const view = createConversationViewFromReader(reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: (task) => {
        tasks.push(task);
        return () => {};
      },
    });
    try {
      await checkpoint();
      tasks.shift()!({ timeRemaining: () => 100 });
      await entered;
      doc.getList('history').insert(0, { ...history[0], id: 'new' } as never);
      doc.commit();
      await checkpoint();
      expect(view.index(5)?.id).toBe('u-2');
      release();
      await checkpoint();
      // The delayed summary for a-2 must not be written through position 5,
      // which now belongs to u-2.
      expect(view.index(5)?.id).toBe('u-2');
    } finally {
      release();
      view.dispose();
      doc.free();
    }
  });

  it('refreshes first, middle, and tail content updates without truncating, and shrinks on tail deletion', async () => {
    const history = buildFixtureHistory(3);
    const doc = buildSessionDoc(history);
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    const view = createConversationViewFromReader(data.history, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      await checkpoint();
      const allIds = history.map((turn) => turn.id);
      for (const id of ['a-0', 'a-1', 'a-2']) {
        // `turn(a-0)`'s fixture value differs per turn; setting a new value must
        // update only its row and leave the six-row directory intact.
        const result = await data.commands.setTurnField(id, 'finished', setFieldTo(false));
        expect(result.status).toBe('accepted');
        await checkpoint();
        expect(view.turnCount).toBe(6);
        expect(Array.from({ length: view.turnCount }, (_, i) => view.index(i)?.id)).toEqual(allIds);
      }
      // A real structural shrink: deleting the tail row must reduce the count.
      doc.getList('history').delete(5, 1);
      doc.commit();
      await checkpoint();
      expect(view.turnCount).toBe(5);
      expect(Array.from({ length: view.turnCount }, (_, i) => view.index(i)?.id)).toEqual(
        allIds.slice(0, 5)
      );
    } finally {
      view.dispose();
      doc.free();
    }
  });

  it('a gated same-turn content update is not overwritten by the stale summary write', async () => {
    const history = buildFixtureHistory(3);
    const doc = buildSessionDoc(history);
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (started = resolve));
    const tasks: Array<(deadline: { timeRemaining(): number }) => void> = [];
    let shouldBlock = true;
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurn: async (id) => {
        const value = await data.history.readTurn(id);
        if (id === 'a-2' && shouldBlock) {
          shouldBlock = false;
          started();
          await blocked;
        }
        return value;
      },
    };
    const view = createConversationViewFromReader(reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: (task) => {
        tasks.push(task);
        return () => {};
      },
    });
    try {
      await checkpoint();
      tasks.shift()!({ timeRemaining: () => 100 });
      await entered;
      // Same turn, no positional shift: the row object is replaced, so the
      // delayed summary must not write its stale capture back.
      const result = await data.commands.setTurnField('a-2', 'finished', setFieldTo(false));
      expect(result.status).toBe('accepted');
      release();
      await checkpoint();
      expect(view.index(5)?.id).toBe('a-2');
      expect(view.index(5)?.finished).toBe(false);
    } finally {
      release();
      view.dispose();
      doc.free();
    }
  });

  it('a leased body read must not overwrite a content update received while it was pending', async () => {
    // fc neighbor: the per-turn token fences a pending body read, and the still
    // active lease is re-read so the range does not end with a hole.
    const doc = buildSessionDoc(buildFixtureHistory(3));
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    let block = true;
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurn: async (id) => {
        const result = await data.history.readTurn(id);
        if (id === 'a-2' && block) {
          block = false;
          entered();
          await gate;
        }
        return result;
      },
    };
    const view = createConversationViewFromReader(reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      await checkpoint();
      const lease = view.acquireRange(5, 6);
      await started;
      expect((await data.commands.setTurnField('a-2', 'finished', setFieldTo(false))).status).toBe(
        'accepted'
      );
      await checkpoint();
      expect(view.index(5)?.finished).toBe(false);
      release();
      await lease.ready;
      await checkpoint();
      expect(view.turn(5)?.finished).toBe(false);
      lease.release();
    } finally {
      release();
      view.dispose();
      doc.free();
    }
  });

  it('a count from a later revision must not truncate rows read before an append', async () => {
    // fc neighbor: the directory and count are one observation, so a structural
    // change between them re-reads instead of pairing old rows with a new length.
    const original = buildFixtureHistory(3);
    const doc = buildSessionDoc(original);
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    let block = true;
    const reader: SessionHistoryReader = {
      ...data.history,
      count: async () => {
        if (block) {
          block = false;
          entered();
          await gate;
        }
        return data.history.count();
      },
    };
    const view = createConversationViewFromReader(reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      await checkpoint();
      await data.commands.setTurnField('a-0', 'finished', setFieldTo(false));
      await started;
      doc.getList('history').push({ ...original[0], id: 'new' } as never);
      doc.commit();
      release();
      await checkpoint();
      expect(view.turnCount).toBe(7);
      expect(Array.from({ length: 7 }, (_, i) => view.index(i)?.id)).toEqual([
        ...original.map((turn) => turn.id),
        'new',
      ]);
    } finally {
      release();
      view.dispose();
      doc.free();
    }
  });

  it('a leased body read is invalidated by a streaming text update with unchanged index scalars', async () => {
    // 71 neighbor: a body-only edit (same item count, same scalars) must
    // invalidate the pending read by the event's identity, not by comparing the
    // shallow directory row.
    const doc = buildSessionDoc(buildFixtureHistory(3));
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    let block = true;
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurn: async (id) => {
        const result = await data.history.readTurn(id);
        if (id === 'a-2' && block) {
          block = false;
          entered();
          await gate;
        }
        return result;
      },
    };
    const view = createConversationViewFromReader(reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      await checkpoint();
      const lease = view.acquireRange(5, 6);
      await started;
      data.writer.updateEntry('a-2', (turn) => {
        turn.items![2] = { type: 'text', text: 'NEW CONTENT' } as never;
        return turn;
      });
      await checkpoint();
      expect(view.index(5)?.finished).toBe(true);
      release();
      await lease.ready;
      await checkpoint();
      expect(
        (view.turn(5)?.items?.[2] as { text?: string } | undefined)?.text
      ).toBe('NEW CONTENT');
      lease.release();
    } finally {
      release();
      view.dispose();
      doc.free();
    }
  });

  it('an inputConfig-only change invalidates the pending body read for that turn', async () => {
    const doc = buildSessionDoc(buildFixtureHistory(3));
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    let block = true;
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurn: async (id) => {
        const result = await data.history.readTurn(id);
        if (id === 'u-2' && block) {
          block = false;
          entered();
          await gate;
        }
        return result;
      },
    };
    const view = createConversationViewFromReader(reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      await checkpoint();
      const lease = view.acquireRange(4, 5);
      await started;
      data.writer.updateEntry('u-2', (turn) => {
        turn.inputConfig = {
          ...(turn.inputConfig as Record<string, unknown>),
          modelId: 'model-new',
        } as never;
        return turn;
      });
      await checkpoint();
      release();
      await lease.ready;
      await checkpoint();
      expect(
        (view.turn(4)?.inputConfig as { modelId?: string } | undefined)?.modelId
      ).toBe('model-new');
      lease.release();
    } finally {
      release();
      view.dispose();
      doc.free();
    }
  });

  it('an active lease still fills after three successive invalidations and then quiescence', async () => {
    // 71 neighbor: no fixed retry cap may silently resolve an unfilled lease.
    const doc = buildSessionDoc(buildFixtureHistory(3));
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    let writes = 0;
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurn: async (id) => {
        const result = await data.history.readTurn(id);
        if (id === 'a-2' && writes < 3) {
          writes += 1;
          await data.commands.setTurnField('a-2', 'finished', setFieldTo(writes % 2 === 0));
          await checkpoint();
        }
        return result;
      },
    };
    const view = createConversationViewFromReader(reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      await checkpoint();
      const lease = view.acquireRange(5, 6);
      await lease.ready;
      expect(view.turn(5)?.finished).toBe(false);
      lease.release();
    } finally {
      view.dispose();
      doc.free();
    }
  });

  it('invalidates only the touched turn and leaves an unrelated pending read accepted', async () => {
    const doc = buildSessionDoc(buildFixtureHistory(3));
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    const reads = new Map<string, number>();
    let releaseA2!: () => void;
    let enteredA2!: () => void;
    const gateA2 = new Promise<void>((resolve) => (releaseA2 = resolve));
    const startedA2 = new Promise<void>((resolve) => (enteredA2 = resolve));
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurn: async (id) => {
        reads.set(id, (reads.get(id) ?? 0) + 1);
        const result = await data.history.readTurn(id);
        if (id === 'a-2') {
          enteredA2();
          await gateA2;
        }
        return result;
      },
    };
    const view = createConversationViewFromReader(reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      // One id per chunk so u-2 can settle while a-2 is still gated.
      hydrateChunkSize: 1,
      scheduleIdle: () => () => {},
    });
    try {
      await checkpoint();
      const lease = view.acquireRange(4, 6);
      await startedA2;
      // u-2 hydration completes and is accepted while a-2 is still pending.
      await vi.waitFor(() => expect(view.turn(4)?.id).toBe('u-2'));
      // A u-2 content update must not invalidate the pending a-2 read.
      data.writer.updateEntry('u-2', (turn) => {
        turn.items![2] = { type: 'text', text: 'U2 NEW' } as never;
        return turn;
      });
      await checkpoint();
      releaseA2();
      await lease.ready;
      await checkpoint();
      expect(reads.get('a-2')).toBe(1);
      expect(
        (view.turn(4)?.items?.[2] as { text?: string } | undefined)?.text
      ).toBe('U2 NEW');
      lease.release();
    } finally {
      releaseA2();
      view.dispose();
      doc.free();
    }
  });

  it('releasing a lease stops its in-flight hydration request', async () => {
    const doc = buildSessionDoc(buildFixtureHistory(3));
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
      durability: 'unavailable',
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const reads: string[] = [];
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurn: async (id) => {
        reads.push(id);
        const result = await data.history.readTurn(id);
        if (id === 'a-2') {
          entered();
          await gate;
        }
        return result;
      },
    };
    const view = createConversationViewFromReader(reader, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      await checkpoint();
      const lease = view.acquireRange(5, 6);
      await started;
      lease.release();
      release();
      await lease.ready;
      await checkpoint();
      expect(reads.filter((id) => id === 'a-2')).toHaveLength(1);
      expect(view.isHydrated(5)).toBe(false);
    } finally {
      release();
      view.dispose();
      doc.free();
    }
  });
});
