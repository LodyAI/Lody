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
  /**
   * Run or hold the background pass. Facts and view subscription survive a
   * hold, so a table that is re-acquired resumes instead of starting over.
   */
  setActive(active: boolean): void;
  dispose(): void;
};

export type DeriveTurnFact<F> = (turn: SessionHistory, row: TurnIndexRow, index: number) => F;

export type CreateConversationDerivationOptions = {
  /** Turns hydrated per background chunk. */
  chunkSize?: number;
  /** Yield between chunks; defaults to a macrotask. */
  yieldToEventLoop?: () => Promise<void>;
};

/**
 * Background chunks yield to real idle time where the platform has it.
 *
 * Back-to-back macrotasks kept the pass at the head of the queue, so filling a
 * long conversation's facts held the main thread for as long as it ran. The
 * timeout keeps it progressing on a busy tab.
 */
const defaultYield = (): Promise<void> =>
  typeof requestIdleCallback === 'function'
    ? new Promise((resolve) => {
        requestIdleCallback(() => resolve(), { timeout: 200 });
      })
    : new Promise((resolve) => setTimeout(resolve, 0));

export function createConversationDerivation<F>(
  view: ConversationView,
  derive: DeriveTurnFact<F>,
  options: CreateConversationDerivationOptions = {}
): ConversationDerivation<F> {
  const chunkSize = options.chunkSize ?? 32;
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
  const facts = new Map<string, F>();
  // Identity is only a reuse hint, never ownership of a released turn.
  const derivedFrom = new Map<string, WeakRef<SessionHistory>>();
  const listeners = new Set<() => void>();
  let version = 0;
  let complete = false;
  let disposed = false;
  let active = true;
  let passRunning = false;
  let passRequested = false;
  let activeRange: ReturnType<ConversationView['acquireRange']> | undefined;

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
        if (derivedFrom.get(row.id)?.deref() === turn) continue;
        facts.set(row.id, derive(turn, row, i));
        derivedFrom.set(row.id, new WeakRef(turn));
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
    if (change.kind === 'structure') {
      changed = pruneRemoved();
      changed = deriveRange(change.from ?? 0, change.to ?? view.turnCount, true) || changed;
      requestPass();
    } else {
      for (const id of change.ids) {
        changed = facts.delete(id) || changed;
        derivedFrom.delete(id);
        const position = view.indexOf(id);
        if (position >= 0) {
          changed = deriveRange(position, position + 1) || changed;
          if (!view.isHydrated(position)) requestPass();
        }
      }
    }
    if (changed) notify();
  });

  const runBackgroundPass = async () => {
    let end = view.turnCount;
    while (end > 0) {
      if (disposed || !active) return;
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
      // `acquireRange` pins before its first await, so the release has to run
      // even when this derivation is disposed mid-hydration: the view outlives
      // it in the warm store cache, and a leaked pin makes those turns
      // permanently un-evictable.
      const range = view.acquireRange(lo, hi);
      activeRange = range;
      try {
        await range.ready;
        if (disposed) return;
        if (deriveRange(lo, hi)) notify();
      } finally {
        range.release();
        activeRange = undefined;
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
        // `disposed` flips from `dispose()` while this loop is awaiting, and
        // `active` from the last consumer releasing.
        if (disposed || !active) return;
        passRequested = false;
        await runBackgroundPass();
        // A pass that stopped because it was held has not covered everything.
        if (!active) {
          passRequested = true;
          return;
        }
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
    if (active && !passRunning && !disposed) void runPasses();
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
    setActive: (next: boolean) => {
      if (active === next || disposed) return;
      active = next;
      if (active && passRequested && !passRunning) void runPasses();
    },
    dispose: () => {
      disposed = true;
      activeRange?.release();
      unsubscribe();
      listeners.clear();
      facts.clear();
      derivedFrom.clear();
    },
  };
}

const sharedDerivations = new WeakMap<
  ConversationView,
  Map<DeriveTurnFact<unknown>, { table: ConversationDerivation<unknown>; users: number }>
>();

/**
 * Borrow a fact table; hold its background scan after the last consumer.
 *
 * The table is NOT disposed on the last release. Deriving a fact needs the
 * turn's body, so a table that discarded its facts re-materialized the whole
 * conversation the next time the session was opened — which is what closing
 * and reopening a tab does. It stays keyed by the view instead, so it is
 * collected with the view when the session store evicts it, and a re-acquire
 * resumes with the facts it already has.
 */
export function acquireConversationDerivation<F>(
  view: ConversationView,
  derive: DeriveTurnFact<F>
) {
  // Key and subscribe on the conversation's own view. A projection wrapper is
  // rebuilt whenever an optimistic entry appears or resolves; giving each one a
  // table left every released wrapper subscribed through the base view, so a
  // later token derived once per wrapper ever created and none of them could be
  // collected.
  const owner = view.factSource ?? view;
  let tables = sharedDerivations.get(owner);
  if (!tables) sharedDerivations.set(owner, (tables = new Map()));
  let entry = tables.get(derive);
  if (!entry) {
    entry = { table: createConversationDerivation(owner, derive), users: 0 };
    tables.set(derive, entry);
  }
  entry.users++;
  entry.table.setActive(true);
  let held = true;
  return {
    table: entry.table as ConversationDerivation<F>,
    release() {
      if (!held) return;
      held = false;
      if (--entry.users === 0) entry.table.setActive(false);
    },
  };
}
