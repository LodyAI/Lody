import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { lodyConnectionUiStateAtom } from '@/atoms/control-connection';
import { authTokenAtom } from '@/atoms/runtime';

/** How long the connection may sit in `loading` before the recovery hint shows. */
export const STUCK_CONNECTION_HINT_DELAY_MS = 45_000;

/**
 * True once the workspace control connection has been continuously `loading`
 * for `delayMs` while signed in. `loading` means the meta room has never
 * completed its first sync this page load; the other non-online states are
 * excluded on purpose — `offline` has nothing to recover, and `reconnecting`
 * means a previously-synced link dropped and the runtime's own reconnect loop
 * is already driving recovery.
 *
 * Purely observational: this hook never touches the connection attempt, so a
 * slow-but-succeeding first sync completes exactly as it would without it (the
 * hint simply disappears when the state leaves `loading`).
 */
export function useStuckConnectionHint(delayMs = STUCK_CONNECTION_HINT_DELAY_MS): boolean {
  const uiState = useAtomValue(lodyConnectionUiStateAtom);
  const authToken = useAtomValue(authTokenAtom);
  const [stuck, setStuck] = useState(false);

  const eligible = uiState === 'loading' && !!authToken;
  useEffect(() => {
    if (!eligible) {
      setStuck(false);
      return undefined;
    }
    const timer = setTimeout(() => setStuck(true), delayMs);
    return () => clearTimeout(timer);
  }, [eligible, delayMs]);

  return stuck;
}
