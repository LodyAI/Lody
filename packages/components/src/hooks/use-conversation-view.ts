import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionHistory, SessionId } from '@lody/shared';
import {
  collectHydratedRange,
  createConversationDerivation,
  findLastIndex,
  resolveTailStart,
  subscribeConversationViewOnFrame,
  type ConversationDerivation,
  type ConversationView,
  type DeriveTurnFact,
  type TurnIndexRow,
} from '@/lib/conversation-view';
import { useSessionDoc, type UseSessionDocOptions } from './use-session-doc';

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

const frameScheduler = {
  request: (callback: () => void): number =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => callback())
      : (setTimeout(callback, 0) as unknown as number),
  cancel: (id: number): void => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    else clearTimeout(id);
  },
};

/** The view's version, updated at most once per frame. -1 without a view. */
export function useConversationVersion(view: ConversationView | null | undefined): number {
  const subscribe = useCallback(
    (onChange: () => void) => (view ? subscribeConversationViewOnFrame(view, onChange) : () => {}),
    [view]
  );
  const read = useCallback(() => view?.version ?? -1, [view]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The session's conversation view, with accepted projections overlaid. */
export function useConversationView(
  sessionId: SessionId,
  options: UseSessionDocOptions = {}
): ConversationView | null {
  return useSessionDoc(sessionId, options).history;
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
  options: { extendToPrecedingUserTurn?: boolean } = {}
): void {
  const extend = options.extendToPrecedingUserTurn === true;
  useEffect(() => {
    if (!view || to <= from) return undefined;
    let start = Math.max(0, from);
    if (extend && start > 0) {
      const scan = { turnCount: start, index: (i: number) => view.index(i) };
      const user = findLastIndex(scan, (row) => row.role === 'user', { limit: 50 });
      if (user >= 0) start = user;
    }
    const end = Math.min(view.turnCount, to);
    if (end <= start) return undefined;
    void view.ensureRange(start, end);
    return () => view.release(start, end);
  }, [view, from, to, extend]);
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
  return useMemo(() => {
    if (!view) return EMPTY_ROWS;
    const rows: TurnIndexRow[] = [];
    for (let i = 0; i < view.turnCount; i += 1) {
      const row = view.index(i);
      if (row) rows.push(row);
    }
    return rows;
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
    const next = createConversationDerivation(view, derive);
    setDerivation(next);
    return () => {
      next.dispose();
      setDerivation((current) => (current === next ? null : current));
    };
  }, [view, derive]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!derivation) return () => {};
      let frame: number | null = null;
      const unsubscribe = derivation.subscribe(() => {
        if (frame !== null) return;
        frame = frameScheduler.request(() => {
          frame = null;
          onChange();
        });
      });
      return () => {
        unsubscribe();
        if (frame !== null) frameScheduler.cancel(frame);
      };
    },
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
