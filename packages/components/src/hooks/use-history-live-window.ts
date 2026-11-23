import { useEffect, useState } from 'react';
import type { HistoryLiveSync, HistoryLiveWindow } from '@/components/ai-gui/assistant-turn-timing';

/**
 * Opens a new live window each time `sync` becomes `live` (opening, switching
 * back, reconnecting) and closes it otherwise, so the catch-up import that
 * follows entering live sync is never read as fresh output.
 */
export function useHistoryLiveWindow(sync: HistoryLiveSync): HistoryLiveWindow {
  const [since, setSince] = useState<number | null>(() => (sync === 'live' ? Date.now() : null));
  useEffect(() => {
    setSince(sync === 'live' ? Date.now() : null);
  }, [sync]);
  return { sync, since: sync === 'live' ? since : null };
}
