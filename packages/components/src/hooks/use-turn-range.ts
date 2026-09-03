import { useEffect, useState } from 'react';
import type { ConversationView } from '@/lib/conversation-view';
import { subscribeLatestOnAnimationFrame } from '@/lib/latest-frame-subscription';

/**
 * Keep `[from, to)` of `view` hydrated and retained while mounted, and
 * re-render when the view changes. Returns a revision that bumps once per
 * animation frame of view changes (history bursts coalesce, exactly like
 * `use-session-doc.ts`) and once when a requested range finishes hydrating,
 * which the view does not announce on its own. With no view it is inert.
 */
export function useTurnRange(view: ConversationView | null, from: number, to: number): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!view) return undefined;
    return subscribeLatestOnAnimationFrame<number>({
      subscribe: (listener) => view.subscribe(() => listener(view.version)),
      onValue: () => setRevision((current) => current + 1),
    });
  }, [view]);

  useEffect(() => {
    if (!view || to <= from) return undefined;
    const release = view.retain(from, to);
    let cancelled = false;
    void view.ensureRange(from, to).then(() => {
      if (!cancelled) setRevision((current) => current + 1);
    });
    return () => {
      cancelled = true;
      release();
    };
  }, [from, to, view]);

  return revision;
}
