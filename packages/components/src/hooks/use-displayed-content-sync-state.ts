import { useEffect, useRef, useState } from 'react';
import type { SessionContentSyncState } from '@/lib/session-content-sync-state';

/** A status must persist this long before it is shown (routine switches stay quiet). */
export const CONTENT_SYNC_SHOW_AFTER_MS = 400;
/** Once shown, a status stays at least this long so it never flashes. */
export const CONTENT_SYNC_MIN_VISIBLE_MS = 500;

/**
 * The content-sync state to present. `cold` (the skeleton) shows at once: the
 * alternative is a blank pane. Other states show only after persisting for
 * {@link CONTENT_SYNC_SHOW_AFTER_MS}, and every shown state stays for at least
 * {@link CONTENT_SYNC_MIN_VISIBLE_MS}. Switching between two shown states
 * (catching up → offline) is immediate.
 */
export function useDisplayedContentSyncState(
  state: SessionContentSyncState
): SessionContentSyncState {
  const [displayed, setDisplayed] = useState<SessionContentSyncState>(
    state === 'cold' ? 'cold' : 'current'
  );
  const shownAtRef = useRef(state === 'cold' ? Date.now() : 0);

  useEffect(() => {
    if (state === displayed) return undefined;

    if (state === 'current') {
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
      setDisplayed(state);
    };
    if (displayed !== 'current' || state === 'cold') {
      show();
      return undefined;
    }
    const timer = setTimeout(show, CONTENT_SYNC_SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [displayed, state]);

  return displayed;
}
