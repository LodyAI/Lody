import { writeStoredField } from './conversation-view-fixtures';
import { describe, expect, it, vi } from 'vitest';
import { LoroDoc, type LoroMap } from 'loro-crdt';
import type { SessionHistory } from '@lody/shared';
import {
  createHistoryWriter,
  resolveSessionAcpRuntimeConfig,
  resolveSessionConversationConfig,
  resolveSessionConversationSourceFence,
} from '@lody/shared';
import {
  createLoroSessionData,
  setFieldTo,
  type LoroSessionData,
  type SessionDataChangeListener,
  type SessionHistoryReader,
  type SessionTurn,
} from '@lody/shared/session-data';
import {
  createConversationViewFromReader,
  collectConversationConfigSources,
  type ConversationView,
} from '../src/lib/conversation-view';
import {
  flushReaderChanges,
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
  type ManualIdle,
} from './conversation-view-fixtures';

/** Exercise the shipped reader against real Loro storage. */

type Backend = {
  name: string;
  create(history: SessionHistory[]): { data: LoroSessionData; teardown(): void };
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
];

it.each(['complete', 'prompt-only', 'absent'] as const)(
  'caches body-independent configuration sources with unchanged results: %s',
  async (configKind) => {
    const history = buildFixtureHistory(3);
    if (configKind === 'complete') {
      history[4]!.inputConfig = {
        ...history[4]!.inputConfig,
        agentRoleId: null,
        mcpServerIds: [],
        configOptionValues: { plan_mode: false },
      };
    } else if (configKind === 'prompt-only') {
      history[4]!.inputConfig = { prompt: 'Synthetic legacy input' };
    } else {
      delete history[4]!.inputConfig;
    }
    const doc = buildSessionDoc(history);
    const data = createLoroSessionData({ sessionId: FIXTURE_SESSION_ID, doc });
    const idle = createManualIdle();
    const view = createConversationViewFromReader(data.history, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 2,
      scheduleIdle: idle.scheduleIdle,
    });
    try {
      await flushReaderChanges();
      idle.runAll();
      await view.ready;
      const sources = collectConversationConfigSources(view, 4);
      expect(collectConversationConfigSources(view, 4)).toBe(sources);
      for (const position of [4, 5]) {
        const turn = view.turn(position)!;
        const source = sources.find((entry) => entry.id === turn.id)!;
        expect(source).toStrictEqual({
          id: turn.id,
          role: turn.role,
          inputConfig: turn.inputConfig,
        });
        expect(source).not.toBe(turn);
      }
      const complete = await data.history.readAll();
      expect(resolveSessionConversationConfig(sources)).toEqual(
        resolveSessionConversationConfig(complete)
      );
      expect(resolveSessionConversationSourceFence(sources)).toEqual(
        resolveSessionConversationSourceFence(complete)
      );
      const runtime = {
        acpSessionId: 'synthetic-agent-session',
        basedOnUserTurnId: 'u-2',
        revision: 1,
        configOptionValues: { plan_mode: false },
      };
      expect(resolveSessionAcpRuntimeConfig(sources, [], runtime)).toEqual(
        resolveSessionAcpRuntimeConfig(complete, [], runtime)
      );

      data.writer.updateEntry('u-2', (entry) => ({
        ...entry,
        inputConfig: { ...entry.inputConfig, modelId: 'updated-model', mcpServerIds: [] },
      }));
      await flushReaderChanges();
      const updated = collectConversationConfigSources(view, 4);
      expect(updated).not.toBe(sources);
      expect(resolveSessionConversationConfig(updated)).toEqual(
        resolveSessionConversationConfig(await data.history.readAll())
      );
      expect(resolveSessionConversationConfig(updated).modelId).toBe('updated-model');
      expect(collectConversationConfigSources(view, 4)).toBe(updated);
    } finally {
      view.dispose();
      data.dispose();
      doc.free();
    }
  }
);

it('keeps older configuration sources lazy while reusing their index rows', async () => {
  const history = buildFixtureHistory(3);
  history[4]!.inputConfig = { ...history[4]!.inputConfig, agentRoleId: null };
  const doc = buildSessionDoc(history);
  const data = createLoroSessionData({ sessionId: FIXTURE_SESSION_ID, doc });
  const idle = createManualIdle();
  const view = createConversationViewFromReader(data.history, {
    sessionId: FIXTURE_SESSION_ID,
    tailKeep: 2,
    scheduleIdle: idle.scheduleIdle,
  });
  try {
    await flushReaderChanges();
    idle.runAll();
    await view.ready;
    const expected = resolveSessionConversationConfig(await data.history.readAll());
    for (const position of [0, 2]) {
      Object.defineProperty(view.index(position)!, 'inputConfig', {
        get() {
          throw new Error('Older configuration must remain unread');
        },
      });
    }
    const sources = collectConversationConfigSources(view, 4);
    expect(sources[0]).toBe(view.index(0));
    expect(sources[1]).toBe(view.index(2));
    expect(resolveSessionConversationConfig(sources)).toEqual(expected);
    expect(collectConversationConfigSources(view, 4)).toBe(sources);
  } finally {
    view.dispose();
    data.dispose();
    doc.free();
  }
});

it('reveals adjacent reverse pages without replacing retained rows or bodies and keeps edits observable', async () => {
  const history = buildFixtureHistory(60);
  const doc = buildSessionDoc(history);
  const data = createLoroSessionData({ sessionId: FIXTURE_SESSION_ID, doc });
  const page = async (end: number, limit: number) => {
    const start = Math.max(0, end - limit);
    return {
      startPosition: start,
      totalCount: history.length,
      rows: await data.history.readDirectory(start, end),
      hasMoreOlder: start > 0,
      cursor: start > 0 ? String(start) : null,
    };
  };
  const reader: SessionHistoryReader = {
    ...data.history,
    readLatestDirectoryPage: (limit) => page(history.length, limit),
    readOlderDirectoryPage: (cursor, limit) => page(Number(cursor), limit),
    observe(listener) {
      const observation = data.history.observe(listener);
      return { ...observation, initialPage: page(history.length, 40) };
    },
  };
  const idle = createManualIdle();
  const view = createConversationViewFromReader(reader, {
    sessionId: FIXTURE_SESSION_ID,
    tailKeep: 2,
    scheduleIdle: idle.scheduleIdle,
    yieldToEventLoop: () => Promise.resolve(),
  });
  try {
    await flushReaderChanges();
    idle.runAll();
    await view.ready;
    const retained = view.acquireRange(118, 120);
    await retained.ready;
    try {
      const row = view.index(119);
      const body = view.turn(119);
      const changes: { from: number; to: number }[] = [];
      const unsubscribe = view.subscribe((change) => {
        if (change.kind === 'structure') changes.push(change);
      });
      expect(await view.loadOlder?.()).toBe(true);
      expect(view.indexOf('u-20')).toBe(40);
      expect(view.index(119)).toBe(row);
      expect(view.turn(119)).toBe(body);
      expect(await view.loadOlder?.()).toBe(true);
      expect(view.hasMoreOlder).toBe(false);
      expect(changes).toEqual([
        { kind: 'structure', from: 40, to: 80 },
        { kind: 'structure', from: 0, to: 40 },
      ]);
      for (let index = 0; index < history.length; index += 1)
        expect(view.indexOf(history[index]!.id)).toBe(index);
      data.writer.updateEntry('a-59', (entry) => {
        entry.items = [{ type: 'text', text: 'still streaming after reverse paging' }];
        return entry;
      });
      doc.commit();
      await flushReaderChanges();
      expect(view.turn(119)?.items).toEqual([
        { type: 'text', text: 'still streaming after reverse paging' },
      ]);
      unsubscribe();
    } finally {
      retained.release();
    }
  } finally {
    view.dispose();
    data.dispose();
    doc.free();
  }
});

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
  options: {
    tailKeep?: number;
    maxHydrated?: number;
    hydrateChunkSize?: number;
    hydrateItemBudget?: number;
    now?: () => number;
  } = {}
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
    ...(options.now ? { now: options.now } : {}),
  });
  // Raw membership/order mutation (not expressible as a domain command): the
  // Loro arm goes through the shared writer, the memory arm through the peer
  // mutation hook. Both produce an observer event, not a command receipt.
  const mutateHistory = (update: (turns: SessionTurn[]) => SessionTurn[]): void => {
    const writer = (
      data as { writer?: { update: (updater: (history: unknown[]) => unknown[]) => void } }
    ).writer;
    if (writer) {
      writer.update((current) => update(current as SessionTurn[]) as unknown[]);
      return;
    }
    throw new Error('fixture requires its Loro writer');
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
  return {
    reader,
    triggerReset: () => listener?.({ kind: 'structure', from: 0, to: Number.MAX_SAFE_INTEGER }),
  };
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
      // Idle work does not read offscreen bodies for outline previews.
      expect(view.index(at)?.summary).toBeUndefined();
      expect(view.isHydrated(at)).toBe(false);
      const preview = view.acquireRange(at, at + 1);
      await preview.ready;
      expect(view.index(at)?.summary?.headText).toContain('empty selection');
      expect(view.index(at)?.itemCount).toBe(1);
      preview.release();
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
      mutateHistory((turns) => [{ ...turns[0]!, id: 'u-inserted' } as SessionTurn, ...turns]);
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
      await data.commands.appendTurn({
        ...customUserTurn(),
        id: 'u-discard',
      } as unknown as SessionTurn);
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

  it("refreshes an unhydrated user turn's send configuration when it changes", async () => {
    const harness = openView(backend, 12, { tailKeep: 2, maxHydrated: 4 });
    const { idle, data } = harness;
    try {
      await settle(idle, harness.view);
      const position = harness.view.indexOf('u-1');
      expect(position).toBeGreaterThanOrEqual(0);
      // Outside every window: the index row is all a caller can read, and the
      // sticky send-config resolver reads exactly this.
      expect(harness.view.isHydrated(position)).toBe(false);
      expect(harness.view.index(position)?.inputConfig?.modelId).toBe('sonnet');

      data.writer.updateEntry('u-1', (entry) => ({
        ...entry,
        inputConfig: {
          ...(entry.inputConfig as Record<string, unknown>),
          modelId: 'opus',
          agentRoleId: 'role-reassigned',
          agentRoleRevision: 42,
          mcpServerIds: [],
        },
      }));
      await flush();

      const row = harness.view.index(position);
      expect(row?.inputConfig?.modelId).toBe('opus');
      expect(row?.inputConfig?.agentRoleId).toBe('role-reassigned');
      expect(row?.inputConfig?.agentRoleRevision).toBe(42);
      expect(row?.inputConfig?.mcpServerIds).toEqual([]);
    } finally {
      harness.view.dispose();
      harness.teardown();
    }
  });

  it('stamps lastUpdateAt from backend changes only, never from opening or hydration', async () => {
    let clock = 1_000;
    const harness = openView(backend, 12, { tailKeep: 4, now: () => clock });
    const { view, idle, data } = harness;
    try {
      await settle(idle, view);
      const older = view.acquireRange(0, 5);
      await older.ready;
      older.release();
      // Opening and hydrating read stored history; nothing arrived yet.
      expect(view.lastUpdateAt).toBeNull();

      clock = 5_000;
      const last = view.turn(view.turnCount - 1)!;
      await data.commands.replaceTurn(last.id, {
        ...(last as unknown as SessionTurn),
        items: [...(last.items ?? []), { type: 'text', text: ' streamed' }],
      } as unknown as SessionTurn);
      await flush();
      expect(view.lastUpdateAt).toBe(5_000);

      clock = 9_000;
      const again = view.acquireRange(4, 8);
      await again.ready;
      again.release();
      expect(view.lastUpdateAt).toBe(5_000);
      view.dispose();
    } finally {
      harness.teardown();
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

  it.each(['rename', 'remove'] as const)(
    're-keys a cached turn when a synchronized peer edits its identity: %s',
    async (edit) => {
      const doc = buildSessionDoc(buildFixtureHistory(3));
      const peer = new LoroDoc();
      peer.import(doc.export({ mode: 'snapshot' }));
      const data = createLoroSessionData({ sessionId: FIXTURE_SESSION_ID, doc });
      const view = createConversationViewFromReader(data.history, {
        sessionId: FIXTURE_SESSION_ID,
        tailKeep: 0,
        scheduleIdle: () => () => {},
        yieldToEventLoop: () => Promise.resolve(),
      });
      try {
        await checkpoint();
        const lease = view.acquireRange(0, 6);
        await lease.ready;
        expect(view.turn(1)?.id).toBe('a-0');
        const sibling = view.turn(0);
        const remoteTurn = peer.getList('history').get(1) as LoroMap;
        if (edit === 'rename') remoteTurn.set('id', 'renamed');
        else remoteTurn.delete('id');
        peer.commit();
        doc.import(peer.export({ mode: 'update', from: doc.version() }));
        await flushReaderChanges();
        await checkpoint();

        expect(view.turnCount).toBe(6);
        expect(view.indexOf('a-0')).toBe(-1);
        expect(view.turn(0)).toBe(sibling);
        expect(view.index(2)?.id).toBe('u-1');
        expect(data.history.readTurn('a-0')).toEqual({ state: 'missing' });
        if (edit === 'rename') {
          expect(view.indexOf('renamed')).toBe(1);
          const renamed = view.acquireRange(1, 2);
          await renamed.ready;
          expect(view.turn(1)?.id).toBe('renamed');
          renamed.release();
        } else {
          expect(view.turn(1)).toBeUndefined();
          expect(data.history.readDirectory(1, 2)).toEqual([{ position: 1, state: 'invalid' }]);
        }
        lease.release();
      } finally {
        view.dispose();
        data.dispose();
        peer.free();
        doc.free();
      }
    }
  );

  it('a mixed structural batch refreshes bodies of surviving hydrated turns', async () => {
    const history = buildFixtureHistory(3);
    const doc = buildSessionDoc(history);
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
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
      await flushReaderChanges();
      await checkpoint();
      expect(view.turnCount).toBe(7);
      expect(view.turn(1)?.finished).toBe(false);
    } finally {
      view.dispose();
      doc.free();
    }
  });

  it('an on-demand preview read cannot overwrite a row after a head insertion', async () => {
    const history = buildFixtureHistory(3);
    const doc = buildSessionDoc(history);
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
    });
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (started = resolve));
    const tasks: Array<(deadline: { timeRemaining(): number }) => void> = [];
    let shouldBlock = true;
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurnForDisplay: async (id) => {
        const value = await data.history.readTurnForDisplay(id);
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
      const preview = view.acquireRange(5, 6);
      void preview.ready.catch(() => {});
      await entered;
      doc.getList('history').insert(0, { ...history[0], id: 'new' } as never);
      doc.commit();
      await flushReaderChanges();
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
        const result = await writeStoredField(data, id, 'finished', setFieldTo(false));
        expect(result.status).toBe('accepted');
        await checkpoint();
        expect(view.turnCount).toBe(6);
        expect(Array.from({ length: view.turnCount }, (_, i) => view.index(i)?.id)).toEqual(allIds);
      }
      // A real structural shrink: deleting the tail row must reduce the count.
      doc.getList('history').delete(5, 1);
      doc.commit();
      await flushReaderChanges();
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

  it('a count from a later revision must not truncate rows read before an append', async () => {
    // fc neighbor: the directory and count are one observation, so a structural
    // change between them re-reads instead of pairing old rows with a new length.
    const original = buildFixtureHistory(3);
    const doc = buildSessionDoc(original);
    const data = createLoroSessionData({
      sessionId: FIXTURE_SESSION_ID,
      doc,
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
      await writeStoredField(data, 'a-0', 'finished', setFieldTo(false));
      await started;
      doc.getList('history').push({ ...original[0], id: 'new' } as never);
      doc.commit();
      await flushReaderChanges();
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
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    let block = true;
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurnForDisplay: async (id) => {
        const result = await data.history.readTurnForDisplay(id);
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
      expect((view.turn(5)?.items?.[2] as { text?: string } | undefined)?.text).toBe('NEW CONTENT');
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
    });
    let writes = 0;
    const reader: SessionHistoryReader = {
      ...data.history,
      readTurnForDisplay: async (id) => {
        const result = await data.history.readTurnForDisplay(id);
        if (id === 'a-2' && writes < 3) {
          writes += 1;
          await writeStoredField(data, 'a-2', 'finished', setFieldTo(writes % 2 === 0));
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
});

it('keeps child bodies out of display hydration while full reads and opened run reads remain complete', async () => {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  const body = 'CHILD_TRANSCRIPT_BODY '.repeat(1000);
  writer.append({
    id: 'owner',
    role: 'assistant',
    timestamp: 'synthetic',
    items: ['a', 'b'].map((taskId) => ({
      type: 'subagent_task',
      taskId,
      status: 'in_progress',
      run: {
        sessionId: 'root',
        snapshot: {
          state: 'running',
          support: {
            stream: ['text'],
            progress: false,
            cancel: false,
            outputRead: 'none',
          },
        },
        items: [
          { type: 'text', text: body },
          { type: 'text', text: 'Latest ' + taskId },
        ],
      },
    })),
  });
  doc.commit();
  const data = createLoroSessionData({ doc, sessionId: FIXTURE_SESSION_ID, writer });
  const idle = createManualIdle();
  const view = createConversationViewFromReader(data.history, {
    sessionId: FIXTURE_SESSION_ID,
    scheduleIdle: idle.scheduleIdle,
  });
  try {
    await new Promise<void>((resolve) => {
      const unsubscribe = view.subscribe((event) => {
        if (event.kind === 'structure') {
          unsubscribe();
          resolve();
        }
      });
    });
    idle.runAll();
    await view.ready;
    const task = view.turn(0)
      ?.items[0] as import('../src/components/ai-gui/subagent-task-state').SubagentTask;
    expect(task.run?.items).toEqual([{ type: 'text', text: 'Latest a' }]);
    expect(JSON.stringify(view.turn(0))).not.toContain(body);
    const opened = await task.history?.read();
    expect(opened?.items[0]).toEqual({ type: 'text', text: body });
    expect(JSON.stringify(await view.readAll())).toContain(body);
    const changed = new Promise<void>((resolve) => {
      const unsubscribe = view.subscribe(() => {
        const latest = (view.turn(0)?.items[0] as typeof task)?.run?.items[0];
        if (latest?.type === 'text' && latest.text === 'Live next step') {
          unsubscribe();
          resolve();
        }
      });
    });
    writer.updateEntry('owner', (turn) => {
      const first = turn.items?.[0] as typeof task;
      first.run!.items.push({ type: 'text', text: 'Live next step' });
      return turn;
    });
    doc.commit();
    await changed;
    const updated = view.turn(0)?.items[0] as typeof task;
    expect(updated.run?.items).toEqual([{ type: 'text', text: 'Live next step' }]);
    expect((await updated.history?.read())?.items.at(-1)).toEqual({
      type: 'text',
      text: 'Live next step',
    });
    view.dispose();
    expect(await updated.history?.read()).toBeUndefined();
  } finally {
    view.dispose();
    data.dispose();
  }
});
