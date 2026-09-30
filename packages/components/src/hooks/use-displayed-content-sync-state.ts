import { useEffect, useRef, useState } from 'react';
import type { SessionContentSyncState } from '@/lib/session-content-sync-state';

/** A status must persist this long before it is shown (routine switches stay quiet). */
export const CONTENT_SYNC_SHOW_AFTER_MS = 400;
/** Once shown, a status stays at least this long so it never flashes. */
export const CONTENT_SYNC_MIN_VISIBLE_MS = 500;

/** What the page renders; `opening` is never shown as itself. */
export type DisplayedContentSyncState = Exclude<SessionContentSyncState, 'opening'>;

/**
 * The content-sync state to present. `cold` (the skeleton) shows at once: the
 * local copy is known to be empty and the alternative is a blank pane.
 * `opening` (the local copy is still being read) shows the skeleton only if the
 * read outlasts {@link CONTENT_SYNC_SHOW_AFTER_MS}, so a cached conversation
 * opens without a skeleton flash. Other states also show only after persisting
 * that long, and every shown state stays for at least
 * {@link CONTENT_SYNC_MIN_VISIBLE_MS}. Switching between two shown states is
 * immediate, except into `opening`, which always waits.
 */
export function useDisplayedContentSyncState(
  state: SessionContentSyncState
): DisplayedContentSyncState {
  const [displayed, setDisplayed] = useState<DisplayedContentSyncState>(
    state === 'cold' ? 'cold' : 'current'
  );
  const shownAtRef = useRef(state === 'cold' ? Date.now() : 0);
  const target: DisplayedContentSyncState = state === 'opening' ? 'cold' : state;

  useEffect(() => {
    if (target === displayed) return undefined;

    if (target === 'current') {
      const remaining = CONTENT_SYNC_MIN_VISIBLE_MS - (Date.now() - shownAtRef.current);
      if (remaining <= 0) {
        setDisplayed('current');
        return undefined;
      }
      const timer = setTimeout(() => setDisplayed('current'), remaining);
      return () => clearTimeout(timer);
    }

    const show = () => {
      if (displayed === 'current') shownAtRef.current = Date.now();
      setDisplayed(target);
    };
    // `opening` always waits: a cached conversation must not flash a skeleton
    // even when the previous one was showing a status.
    if (state === 'cold' || (displayed !== 'current' && state !== 'opening')) {
      show();
      return undefined;
    }
    const timer = setTimeout(show, CONTENT_SYNC_SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [displayed, state, target]);

  return displayed;
}
