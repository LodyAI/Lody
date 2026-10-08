import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionHistory } from '@lody/shared';
import {
  collectHydratedRange,
  acquireConversationDerivation,
  findLastIndex,
  resolveTailStart,
  subscribeOnFrame,
  isUnloadedTurnId,
  type ConversationDerivation,
  type ConversationView,
  type DeriveTurnFact,
  type TurnIndexRow,
} from '@/lib/conversation-view';

/**
 * React bindings for `ConversationView`.
 *
 * Every hook here re-renders through ONE subscription per view coalesced to
 * animation frames, and reads the view synchronously in render. Ranges are
 * explicit: a component that renders turns says which ones through
 * `useTurnRange`, and the view keeps them hydrated until the effect cleans up.
 */

const EMPTY_TURNS: readonly SessionHistory[] = [];
const EMPTY_ROWS: readonly TurnIndexRow[] = [];

/** The view's version, updated at most once per frame. -1 without a view. */
export function useConversationVersion(view: ConversationView | null | undefined): number {
  const subscribe = useCallback(
    (onChange: () => void) =>
      view ? subscribeOnFrame((listener) => view.subscribe(listener), onChange) : () => {},
    [view]
  );
  const read = useCallback(() => view?.version ?? -1, [view]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Keeps `[from, to)` hydrated while mounted. `extendToPrecedingUserTurn` also
 * pulls in the nearest user turn before `from` (bounded), which assistant
 * headers need for inherited run configuration.
 */
export function useTurnRange(
  view: ConversationView | null | undefined,
  from: number,
  to: number,
  options: {
    extendToPrecedingUserTurn?: boolean;
    loadOlderAtStart?: boolean;
    /** Absolute viewport position used to decide whether the older edge is visible. */
    loadOlderAtPosition?: number;
  } = {}
): boolean {
  const extend = options.extendToPrecedingUserTurn === true;
  const loadOlderAtStart = options.loadOlderAtStart === true;
  const loadOlderAtPosition = options.loadOlderAtPosition;
  const [settled, setSettled] = useState<{
    view: ConversationView;
    from: number;
    to: number;
    extend: boolean;
  } | null>(null);
  useEffect(() => {
    if (!view || to <= from) return undefined;
    let range: ReturnType<ConversationView['acquireRange']> | undefined;
    let disposed = false;
    let loadingOlder = false;
    const loadOlder = async () => {
      if (loadingOlder) return;
      loadingOlder = true;
      try {
        for (;;) {
          if (disposed || !shouldLoadOlder(view, loadOlderAtStart, loadOlderAtPosition ?? from))
            break;
          const before = view.structureVersion;
          const loaded = await view.loadOlder?.();
          if (!loaded && view.structureVersion === before) break;
        }
      } catch (error) {
        console.error('Failed to load older conversation history', error);
      } finally {
        loadingOlder = false;
      }
    };
    const acquire = () => {
      const next = view.acquireRange(
        resolveRangeStart(view, from, extend),
        Math.min(view.turnCount, to)
      );
      range?.release();
      range = next;
      const settle = () => {
        if (!disposed && range === next) {
          setSettled((previous) =>
            previous?.view === view &&
            previous.from === from &&
            previous.to === to &&
            previous.extend === extend
              ? previous
              : { view, from, to, extend }
          );
        }
      };
      void next.ready.then(settle, (error) => {
        console.error('Failed to load conversation range', error);
        settle();
      });
    };
    const unsubscribe = view.subscribe((change) => {
      if (change.kind !== 'structure') return;
      acquire();
      void loadOlder();
    });
    acquire();
    void loadOlder();
    return () => {
      disposed = true;
      unsubscribe();
      range?.release();
    };
  }, [view, from, to, extend, loadOlderAtPosition, loadOlderAtStart]);
  if (
    settled &&
    settled.view === view &&
    settled.from === from &&
    settled.to === to &&
    settled.extend === extend
  ) {
    return true;
  }
  // Already hydrated (a cached conversation reopening): ready in this render,
  // not one promise tick later, so its first frame is not a hidden one. The
  // effect above still takes the lease that keeps these turns hydrated.
  return !!view && to > from && isRangeHydrated(view, resolveRangeStart(view, from, extend), to);
}

function shouldLoadOlder(view: ConversationView, enabled: boolean, position: number): boolean {
  if (!enabled || !view.hasMoreOlder || !view.loadOlder) return false;
  const anchor = Math.max(0, Math.min(position, view.turnCount));
  if (anchor <= 2) return true;
  return isUnloadedTurnId(view.index(anchor - 1)?.id ?? '');
}

function resolveRangeStart(view: ConversationView, from: number, extend: boolean): number {
  let start = Math.max(0, from);
  if (extend && start > 0) {
    const scan = { turnCount: start, index: (i: number) => view.index(i) };
    const user = findLastIndex(scan, (row) => row.role === 'user', { limit: 50 });
    if (user >= 0) start = user;
  }
  return start;
}

function isRangeHydrated(view: ConversationView, from: number, to: number): boolean {
  const end = Math.min(view.turnCount, to);
  for (let i = from; i < end; i++) {
    const row = view.index(i);
    if (row && isUnloadedTurnId(row.id)) continue;
    if (!view.isHydrated(i)) return false;
  }
  return true;
}

/** One turn by id, hydrated while mounted. */
export function useTurn(
  view: ConversationView | null | undefined,
  turnId: string | null | undefined
): SessionHistory | undefined {
  useConversationVersion(view);
  const index = view && turnId ? view.indexOf(turnId) : -1;
  useTurnRange(view, index, index + 1);
  return index >= 0 ? view?.turn(index) : undefined;
}

/** All index rows, as one array whose identity follows the view's version. */
export function useConversationIndexRows(
  view: ConversationView | null | undefined
): readonly TurnIndexRow[] {
  const version = useConversationVersion(view);
  useEffect(() => {
    const directory = view?.acquireDirectory?.();
    return () => directory?.release();
  }, [view]);
  const previousRef = useRef<readonly TurnIndexRow[]>(EMPTY_ROWS);
  return useMemo(() => {
    if (!view) {
      previousRef.current = EMPTY_ROWS;
      return EMPTY_ROWS;
    }
    const rows: TurnIndexRow[] = [];
    for (let i = 0; i < view.turnCount; i += 1) {
      const row = view.index(i);
      if (row && !isUnloadedTurnId(row.id)) rows.push(row);
    }
    // The view hands back the same row object for a turn whose index facts did
    // not change, so an array of identical rows is the previous array. Every
    // consumer of this list recomputes on its identity, and the version bumps
    // at token rate.
    const previous = previousRef.current;
    const reusable =
      previous.length === rows.length && previous.every((row, index) => row === rows[index]);
    const result = reusable ? previous : rows;
    previousRef.current = result;
    return result;
    // `version` is the change signal for the view's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, version]);
}

/**
 * The hydrated tail as a contiguous array, identity-stable while its turns are
 * unchanged. This is what the "latest turn" readers that used to scan the whole
 * history read instead.
 */
export function useConversationTail(
  view: ConversationView | null | undefined,
  options: { extendToLastUserTurn?: boolean } = {}
): { turns: readonly SessionHistory[]; from: number } {
  const version = useConversationVersion(view);
  const extend = options.extendToLastUserTurn === true;
  const from = view ? resolveTailStart(view, { extendToLastUserTurn: extend }) : 0;
  const to = view?.turnCount ?? 0;
  useTurnRange(view, from, to);
  const previousRef = useRef<{ from: number; turns: readonly SessionHistory[] }>({
    from: 0,
    turns: EMPTY_TURNS,
  });
  return useMemo(() => {
    if (!view) return { turns: EMPTY_TURNS, from: 0 };
    const next = collectHydratedRange(view, from, to);
    const previous = previousRef.current;
    const same =
      previous.from === from &&
      previous.turns.length === next.length &&
      previous.turns.every((turn, i) => turn === next[i]);
    const turns = same ? previous.turns : next;
    previousRef.current = { from, turns };
    return { turns, from };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, from, to, version]);
}

/**
 * A per-turn fact table over the whole conversation (see
 * `createConversationDerivation`). `derive` must be referentially stable
 * (module level): a new function restarts the background pass.
 */
export function useConversationDerivation<F>(
  view: ConversationView | null | undefined,
  derive: DeriveTurnFact<F>
): { facts: ReadonlyMap<string, F>; complete: boolean; version: number } {
  const [derivation, setDerivation] = useState<ConversationDerivation<F> | null>(null);
  useEffect(() => {
    if (!view) {
      setDerivation(null);
      return undefined;
    }
    const lease = acquireConversationDerivation(view, derive);
    const next = lease.table;
    setDerivation(next);
    return () => {
      lease.release();
      setDerivation((current) => (current === next ? null : current));
    };
  }, [view, derive]);
  const subscribe = useCallback(
    (onChange: () => void) =>
      derivation
        ? subscribeOnFrame((listener) => derivation.subscribe(listener), onChange)
        : () => {},
    [derivation]
  );
  const read = useCallback(() => derivation?.version ?? -1, [derivation]);
  const version = useSyncExternalStore(subscribe, read, read);
  return useMemo(
    () => ({
      facts: derivation?.facts ?? EMPTY_FACTS,
      complete: derivation?.complete ?? false,
      version,
    }),
    [derivation, version]
  );
}

const EMPTY_FACTS: ReadonlyMap<string, never> = new Map<string, never>();
