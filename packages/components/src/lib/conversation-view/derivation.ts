import type { SessionHistory } from '@lody/shared';
import type { ConversationView, TurnIndexRow } from './types';

/**
 * A per-turn fact table over a `ConversationView`, for the readers that used
 * to scan the whole materialized history ("the latest goal item anywhere",
 * "every scheduled-task tool call", "every turn's file diffs").
 *
 * Facts are derived once per turn object: turns the renderer or the tail
 * already hold are derived from the view's change events, and everything
 * else is filled by one background pass that hydrates a chunk, derives, and
 * releases it, from the tail backwards so the newest facts land first. A turn
 * that changes is re-derived because its object identity changes.
 */
export type ConversationDerivation<F> = {
  /** Facts by turn id. Read after `subscribe` fired or `version` changed. */
  readonly facts: ReadonlyMap<string, F>;
  /** True once every turn present when the pass finished has a fact. */
  readonly complete: boolean;
  readonly version: number;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

export type DeriveTurnFact<F> = (turn: SessionHistory, row: TurnIndexRow, index: number) => F;

export type CreateConversationDerivationOptions = {
  /** Turns hydrated per background chunk. */
  chunkSize?: number;
  /** Yield between chunks; defaults to a macrotask. */
  yieldToEventLoop?: () => Promise<void>;
};

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function createConversationDerivation<F>(
  view: ConversationView,
  derive: DeriveTurnFact<F>,
  options: CreateConversationDerivationOptions = {}
): ConversationDerivation<F> {
  const chunkSize = options.chunkSize ?? 32;
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
  const facts = new Map<string, F>();
  const derivedFrom = new Map<string, SessionHistory>();
  const listeners = new Set<() => void>();
  let version = 0;
  let complete = false;
  let disposed = false;
  let passRunning = false;
  let passRequested = false;
  let lastTurnCount = view.turnCount;

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  /**
   * Derive every hydrated, not-yet-derived (or changed) turn in `[from, to)`.
   *
   * `dropStale` is passed only for a range the view reported as CHANGED. A turn
   * that changed while nothing holds it hydrated cannot be re-derived here and
   * its cached fact is now stale — an older assistant turn gaining a file diff
   * is the case that matters — so the fact is dropped and the background pass
   * is asked to run again. The speculative tail window must NOT drop, or every
   * index event would discard the facts of every turn past the hydrated tail.
   */
  const deriveRange = (from: number, to: number, dropStale = false): boolean => {
    let changed = false;
    for (let i = Math.max(0, from); i < Math.min(to, view.turnCount); i += 1) {
      const row = view.index(i);
      if (!row) continue;
      const turn = view.turn(i);
      if (turn) {
        if (derivedFrom.get(row.id) === turn) continue;
        facts.set(row.id, derive(turn, row, i));
        derivedFrom.set(row.id, turn);
        changed = true;
      } else if (dropStale && facts.delete(row.id)) {
        derivedFrom.delete(row.id);
        changed = true;
        requestPass();
      }
    }
    return changed;
  };

  const pruneRemoved = (): boolean => {
    let changed = false;
    for (const id of facts.keys()) {
      if (view.indexOf(id) >= 0) continue;
      facts.delete(id);
      derivedFrom.delete(id);
      changed = true;
    }
    return changed;
  };

  const unsubscribe = view.subscribe((change) => {
    if (disposed) return;
    let changed = false;
    if (change.kind === 'index') {
      if (view.turnCount < lastTurnCount) changed = pruneRemoved() || changed;
      lastTurnCount = view.turnCount;
      // Appended turns land in the hydrated tail; derive whatever is there.
      changed = deriveRange(Math.max(0, view.turnCount - 64), view.turnCount) || changed;
    } else if (change.from !== undefined && change.to !== undefined) {
      changed = deriveRange(change.from, change.to, true) || changed;
    }
    if (changed) notify();
  });

  const runBackgroundPass = async () => {
    let end = view.turnCount;
    while (end > 0) {
      if (disposed) return;
      // Next chunk of turns (from the tail backwards) that still lack a fact.
      const pending: number[] = [];
      let cursor = end;
      while (cursor > 0 && pending.length < chunkSize) {
        cursor -= 1;
        const row = view.index(cursor);
        if (row && !facts.has(row.id)) pending.push(cursor);
      }
      end = cursor;
      if (pending.length === 0) continue;
      const lo = pending[pending.length - 1]!;
      const hi = pending[0]! + 1;
      // `ensureRange` pins before its first await, so the release has to run
      // even when this derivation is disposed mid-hydration: the view outlives
      // it in the warm store cache, and a leaked pin makes those turns
      // permanently un-evictable.
      await view.ensureRange(lo, hi);
      try {
        if (disposed) return;
        if (deriveRange(lo, hi)) notify();
      } finally {
        view.release(lo, hi);
      }
      await yieldToEventLoop();
    }
  };

  /**
   * Run background passes until no invalidation is outstanding. A pass that
   * finishes while another was requested (a turn's fact was dropped while it
   * ran) starts over rather than declaring the table complete.
   */
  const runPasses = async () => {
    if (passRunning) return;
    passRunning = true;
    try {
      while (passRequested) {
        // `disposed` flips from `dispose()` while this loop is awaiting.
        if (disposed) return;
        passRequested = false;
        await runBackgroundPass();
      }
      if (disposed) return;
      complete = true;
      notify();
    } finally {
      passRunning = false;
    }
  };

  function requestPass(): void {
    passRequested = true;
    complete = false;
    if (!passRunning && !disposed) void runPasses();
  }

  // Facts for what is already hydrated come for free before the pass starts.
  deriveRange(0, view.turnCount);
  requestPass();

  return {
    get facts() {
      return facts;
    },
    get complete() {
      return complete;
    },
    get version() {
      return version;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
