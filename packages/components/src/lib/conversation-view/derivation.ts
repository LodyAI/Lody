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
  let lastTurnCount = view.turnCount;

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  /** Derive every hydrated, not-yet-derived (or changed) turn in `[from, to)`. */
  const deriveHydratedRange = (from: number, to: number): boolean => {
    let changed = false;
    for (let i = Math.max(0, from); i < Math.min(to, view.turnCount); i += 1) {
      const turn = view.turn(i);
      const row = view.index(i);
      if (!turn || !row) continue;
      if (derivedFrom.get(row.id) === turn) continue;
      facts.set(row.id, derive(turn, row, i));
      derivedFrom.set(row.id, turn);
      changed = true;
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
      changed = deriveHydratedRange(Math.max(0, view.turnCount - 64), view.turnCount) || changed;
    } else if (change.from !== undefined && change.to !== undefined) {
      changed = deriveHydratedRange(change.from, change.to) || changed;
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
      await view.ensureRange(lo, hi);
      if (disposed) return;
      const changed = deriveHydratedRange(lo, hi);
      view.release(lo, hi);
      if (changed) notify();
      await yieldToEventLoop();
    }
    if (disposed) return;
    complete = true;
    notify();
  };

  // Facts for what is already hydrated come for free before the pass starts.
  deriveHydratedRange(0, view.turnCount);
  void runBackgroundPass();

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
