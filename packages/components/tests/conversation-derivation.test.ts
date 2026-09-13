import { describe, expect, it } from 'vitest';
import { LoroMap, type ContainerID, type LoroList } from 'loro-crdt';
import {
  createHistoryWriter,
  resolveLatestSessionGoalFromHistory,
  type SessionGoalMessage,
} from '@lody/shared';
import {
  createLoroSessionData,
  createMemorySessionData,
  type SessionData,
} from '@lody/shared/session-data';
import {
  createConversationDerivation,
  createConversationViewFromDoc,
  createConversationViewFromReader,
  type ConversationView,
} from '../src/lib/conversation-view';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
  reimport,
} from './conversation-view-fixtures';

/** Drain microtasks until `done()` or the bound is hit. No timers, no sleeps. */
const drain = async (done: () => boolean, bound = 200): Promise<void> => {
  for (let i = 0; i < bound && !done(); i += 1) await Promise.resolve();
};

const immediate = () => Promise.resolve();

const openView = (
  rounds: number,
  options: { tailKeep?: number; maxHydrated?: number; hydrateChunkSize?: number } = {}
) => {
  const doc = reimport(buildSessionDoc(buildFixtureHistory(rounds)));
  const idle = createManualIdle();
  const view = createConversationViewFromDoc(doc, {
    sessionId: FIXTURE_SESSION_ID,
    tailKeep: options.tailKeep ?? 2,
    maxHydrated: options.maxHydrated ?? 4,
    hydrateChunkSize: options.hydrateChunkSize ?? 64,
    hydrateItemBudget: 10_000,
    scheduleIdle: idle.scheduleIdle,
    yieldToEventLoop: immediate,
  });
  return { doc, idle, view };
};

const turnMapAt = (doc: ReturnType<typeof openView>['doc'], index: number): LoroMap => {
  const cid = (doc.getList('history') as LoroList).getShallowValue()[index] as ContainerID;
  return doc.getContainerById(cid) as LoroMap;
};

const countHydrated = (view: ConversationView): number => {
  let hydrated = 0;
  for (let i = 0; i < view.turnCount; i += 1) if (view.isHydrated(i)) hydrated += 1;
  return hydrated;
};

/** One fact per turn: how many file diffs it carries. */
const deriveDiffCount = (turn: { fileDiff?: unknown }) => ({
  diffs: Array.isArray(turn.fileDiff) ? turn.fileDiff.length : 0,
});

describe('createConversationDerivation', () => {
  it('fills all facts after a completed pass receives a bulk remote append', async () => {
    const { doc, view, idle } = openView(1);
    const derivation = createConversationDerivation(view, deriveDiffCount, {
      yieldToEventLoop: immediate,
    });
    await drain(() => derivation.complete);
    const peer = reimport(doc);
    const writer = createHistoryWriter(peer);
    for (const entry of buildFixtureHistory(51).slice(2)) writer.append(entry);
    doc.import(peer.export({ mode: 'update', from: doc.version() }));
    idle.runAll();
    await drain(() => derivation.complete, 1000);
    expect(derivation.complete).toBe(true);
    expect(derivation.facts.size).toBe(102);
    expect(derivation.facts.get('a-2')).toEqual({ diffs: 1 });
    derivation.dispose();
    view.dispose();
  });

  it('invalidates same-id replacements and prunes removed facts in a same-length rewrite', async () => {
    const { doc, view } = openView(50);
    const derivation = createConversationDerivation(view, deriveDiffCount, {
      yieldToEventLoop: immediate,
    });
    await drain(() => derivation.complete, 1000);
    expect(view.isHydrated(21)).toBe(false);
    const list = doc.getList('history');
    list.delete(20, 2);
    for (const id of ['replacement-user', 'a-10']) {
      const turn = list.insertContainer(id === 'a-10' ? 21 : 20, new LoroMap());
      turn.set('id', id);
      turn.set('role', 'assistant');
      turn.set('fileDiff', []);
    }
    doc.commit();
    await drain(() => derivation.complete, 1000);
    expect(derivation.facts.has('u-10')).toBe(false);
    expect(derivation.facts.get('a-10')).toEqual({ diffs: 0 });
    expect(derivation.facts.size).toBe(view.turnCount);
    derivation.dispose();
    view.dispose();
  });

  it('drops and re-derives a fact when an evicted turn changes', async () => {
    const { doc, view } = openView(12, { tailKeep: 2, maxHydrated: 4 });
    const derivation = createConversationDerivation(view, deriveDiffCount, {
      chunkSize: 8,
      yieldToEventLoop: immediate,
    });
    await drain(() => derivation.complete);
    expect(derivation.complete).toBe(true);

    // `a-0` carries one file diff and, at this cache size, is long evicted.
    const target = view.indexOf('a-0');
    expect(target).toBeGreaterThanOrEqual(0);
    expect(view.isHydrated(target)).toBe(false);
    expect(derivation.facts.get('a-0')).toEqual({ diffs: 1 });

    let notifications = 0;
    derivation.subscribe(() => {
      notifications += 1;
    });

    // A later file diff on that turn: the CLI writes this under a turn nothing
    // holds hydrated, and it touches no index scalar.
    const fileDiff = turnMapAt(doc, target).get('fileDiff') as LoroList;
    const added = fileDiff.insertContainer(fileDiff.length, new LoroMap());
    added.set('path', 'src/later.ts');
    added.set('add', 3);
    added.set('del', 0);
    doc.commit();

    // Never served stale: the fact is dropped on the change event, and the
    // restarted pass re-hydrates the turn to derive it again.
    expect(derivation.facts.get('a-0')).not.toEqual({ diffs: 1 });
    await drain(() => derivation.complete);
    expect(derivation.facts.get('a-0')).toEqual({ diffs: 2 });
    expect(notifications).toBeGreaterThan(0);
    derivation.dispose();
    expect(derivation.facts.size).toBe(0);
    view.dispose();
  });

  it.each(['loro', 'memory'] as const)(
    'refreshes evicted goal and diff facts through the shipped reader (%s)',
    async (backend) => {
      const history = buildFixtureHistory(50);
      const goal: SessionGoalMessage = {
        type: 'goal',
        threadId: 'goal-thread',
        objective: 'Finish the task',
        status: 'active',
      };
      history[1]!.items.push(goal);
      const doc = buildSessionDoc(history);
      const data: SessionData =
        backend === 'loro'
          ? createLoroSessionData({ sessionId: FIXTURE_SESSION_ID, doc, durability: 'unavailable' })
          : createMemorySessionData({ sessionId: FIXTURE_SESSION_ID, initialTurns: history });
      const idle = createManualIdle();
      const view = createConversationViewFromReader(data.history, {
        sessionId: FIXTURE_SESSION_ID,
        tailKeep: 2,
        maxHydrated: 4,
        scheduleIdle: idle.scheduleIdle,
        yieldToEventLoop: immediate,
      });
      await drain(() => view.turnCount === history.length, 1000);
      const derivation = createConversationDerivation(
        view,
        (turn) => ({
          goal: resolveLatestSessionGoalFromHistory([turn]),
          ...deriveDiffCount(turn),
        }),
        { chunkSize: 8, yieldToEventLoop: immediate }
      );
      await drain(() => derivation.complete, 10000);
      expect(derivation.complete).toBe(true);
      const target = view.indexOf('a-0');
      expect(view.isHydrated(target)).toBe(false);
      expect(derivation.facts.get('a-0')?.goal?.status).toBe('active');
      for (const status of ['paused', 'active', 'cleared'] as const) {
        const eviction = view.acquireRange(20, 28);
        await eviction.ready;
        eviction.release();
        expect(view.isHydrated(target)).toBe(false);
        const result = await data.commands.applyHistoryAction(
          status === 'cleared'
            ? { kind: 'clear-goal', threadId: goal.threadId, updatedAt: 10 }
            : { kind: 'upsert-goal', goal: { ...goal, status }, fallback: history[1]! }
        );
        expect(result.status).toBe('accepted');
        await drain(
          () => derivation.complete && derivation.facts.get('a-0')?.goal?.status === status,
          10000
        );
        expect(derivation.facts.get('a-0')?.goal?.status).toBe(status);
      }
      const result = await data.commands.setTurnField('a-0', 'fileDiff', {
        kind: 'set',
        value: [
          { filePath: 'src/new.ts', add: 1, del: 0 },
          { filePath: 'src/another.ts', add: 2, del: 0 },
        ],
      });
      expect(result.status).toBe('accepted');
      await drain(() => derivation.complete && derivation.facts.get('a-0')?.diffs === 2, 10000);
      expect(derivation.facts.get('a-0')?.diffs).toBe(2);
      expect(derivation.facts.size).toBe(history.length);
      derivation.dispose();
      view.dispose();
    }
  );

  it('releases its hydration pin when disposed mid-chunk', async () => {
    // Every suspension of the view's chunked hydration, so the test can dispose
    // while one is pending and then let `acquireRange` run to completion.
    const pendingYields: Array<() => void> = [];
    const doc = reimport(buildSessionDoc(buildFixtureHistory(12)));
    const idle = createManualIdle();
    const maxHydrated = 4;
    const tailKeep = 2;
    const view = createConversationViewFromDoc(doc, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep,
      maxHydrated,
      // Forces `acquireRange` to chunk, so it suspends inside the derivation's await.
      hydrateChunkSize: 2,
      hydrateItemBudget: 10_000,
      scheduleIdle: idle.scheduleIdle,
      yieldToEventLoop: () => new Promise<void>((resolve) => pendingYields.push(resolve)),
    });
    const derivation = createConversationDerivation(view, deriveDiffCount, {
      chunkSize: 8,
      yieldToEventLoop: immediate,
    });

    await drain(() => pendingYields.length > 0);
    expect(pendingYields.length).toBeGreaterThan(0);

    // The session view stays warm in the store cache; only the consumer goes.
    derivation.dispose();

    // Let the in-flight `acquireRange` finish its remaining chunks.
    for (let guard = 0; guard < 50 && pendingYields.length > 0; guard += 1) {
      pendingYields.shift()!();
      await drain(() => pendingYields.length > 0, 20);
    }

    // An unrelated hydrate/release runs the LRU without touching the pass's
    // range: a pin the disposed derivation never released would keep its whole
    // chunk hydrated past the cap forever.
    const range = view.acquireRange(0, 1);
    await range.ready;
    range.release();
    expect(countHydrated(view)).toBeLessThanOrEqual(maxHydrated + tailKeep);
    view.dispose();
  });
});
