import { describe, expect, it } from 'vitest';
import { LoroMap, type ContainerID, type LoroList } from 'loro-crdt';
import {
  createConversationDerivation,
  createConversationViewFromDoc,
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
  });

  it('releases its hydration pin when disposed mid-chunk', async () => {
    // Every suspension of the view's chunked hydration, so the test can dispose
    // while one is pending and then let `ensureRange` run to completion.
    const pendingYields: Array<() => void> = [];
    const doc = reimport(buildSessionDoc(buildFixtureHistory(12)));
    const idle = createManualIdle();
    const maxHydrated = 4;
    const tailKeep = 2;
    const view = createConversationViewFromDoc(doc, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep,
      maxHydrated,
      // Forces `ensureRange` to chunk, so it suspends inside the derivation's await.
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

    // Let the in-flight `ensureRange` finish its remaining chunks.
    for (let guard = 0; guard < 50 && pendingYields.length > 0; guard += 1) {
      pendingYields.shift()!();
      await drain(() => pendingYields.length > 0, 20);
    }

    // An unrelated hydrate/release runs the LRU without touching the pass's
    // range: a pin the disposed derivation never released would keep its whole
    // chunk hydrated past the cap forever.
    await view.ensureRange(0, 1);
    view.release(0, 1);
    expect(countHydrated(view)).toBeLessThanOrEqual(maxHydrated + tailKeep);
    view.dispose();
  });
});
