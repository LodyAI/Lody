import { useEffect } from 'react';
import { setFavicon, type TabStatus } from '@/lib/favicon';

export type { TabStatus } from '@/lib/favicon';

const DEBOUNCE_MS = 100;

/**
 * Reflect a session's status in the document favicon (web only).
 * Pass `null` to clear (the default favicon).
 *
 * Status changes are debounced so high-frequency message arrivals don't cause
 * favicon thrash. The Electron dock badge is driven separately by
 * `useWorkspaceBadge` (workspace-scoped, not per-tab) — see that hook.
 */
export function useTabStatus(status: TabStatus, enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    let cleanup: (() => void) | null = null;
    const handle = window.setTimeout(() => {
      cleanup = setFavicon(status);
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(handle);
      if (cleanup) cleanup();
    };
  }, [status, enabled]);
}
