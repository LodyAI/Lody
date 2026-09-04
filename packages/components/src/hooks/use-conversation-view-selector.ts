import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ConversationView } from '@/lib/conversation-view';

const noopSubscribe = () => () => {};

/**
 * Derive a value from a `ConversationView` and re-render when the view
 * changes. `select` runs at most once per view version (and per `revision`,
 * for callers that hydrate turns themselves, which does not bump the view);
 * its result is reused until then, which is what `useSyncExternalStore`
 * needs from a snapshot. Pass `isEqual` for derived objects so an unchanged
 * answer keeps its identity across versions.
 *
 * With no view (flag off, or the store not loaded yet) the hook returns
 * `fallback`, which the caller derives from the doc state instead.
 */
export function useConversationViewSelector<T>(
  view: ConversationView | null | undefined,
  select: (view: ConversationView) => T,
  fallback: T,
  options: { isEqual?: (previous: T, next: T) => boolean; revision?: number } = {}
): T {
  const { isEqual = Object.is, revision = 0 } = options;
  const selectRef = useRef(select);
  selectRef.current = select;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const cacheRef = useRef<{
    view: ConversationView;
    version: number;
    revision: number;
    value: T;
  } | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (view ? view.subscribe(() => onStoreChange()) : noopSubscribe()),
    [view]
  );
  const getSnapshot = useCallback((): T => {
    if (!view) return fallback;
    const cached = cacheRef.current;
    if (
      cached &&
      cached.view === view &&
      cached.version === view.version &&
      cached.revision === revision
    ) {
      return cached.value;
    }
    const next = selectRef.current(view);
    const value =
      cached && cached.view === view && isEqualRef.current(cached.value, next)
        ? cached.value
        : next;
    cacheRef.current = { view, version: view.version, revision, value };
    return value;
  }, [fallback, revision, view]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Evaluate `computeFallback` only while there is no view, so a bridged
 * `doc.history` getter is never touched on the view path. `deps` are the
 * doc-state inputs the fallback reads.
 */
export function useViewFallback<T>(
  view: ConversationView | null | undefined,
  computeFallback: () => T,
  deps: readonly unknown[]
): T | undefined {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (view ? undefined : computeFallback()), [view, ...deps]);
}
