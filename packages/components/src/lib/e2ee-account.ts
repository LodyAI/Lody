import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { usePlatform, usePlatformSession } from '@lody/platform/react';
import { userAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { readStoredAuthToken } from './auth-bootstrap';

/** Select local E2EE data only; this identity grants no cloud/ledger permission.
 * Callers outside an E2EE route pass enabled=false to avoid opening E2EE IPC. */
export function useE2eeAccountId(enabled = true): string | null {
  const session = usePlatformSession();
  const user = useAtomValue(userAtom);
  const runtime = usePlatform().e2eeWorkspaces?.runtime;
  const token = enabled ? readStoredAuthToken() : null;
  const signedOut = session.status === 'unauthenticated' && !session.uncertain;
  const onlineId = session.status === 'authenticated' ? session.user.id : null;
  const cachedId = signedOut ? null : (user?.id ?? null);
  const [offline, setOffline] = useState<{ token: string | null; id: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!enabled || onlineId || signedOut || !runtime?.account) {
      setOffline(null);
      return undefined;
    }
    // Even a renderer bootstrap user needs the bearer bound in main before a
    // cookie-less restart can open the account's custody. This does not delay
    // selecting the already cached local directory.
    void runtime.account(token ? { token } : undefined).then(
      (account) => {
        if (!cancelled) setOffline(account ? { token, id: account.userId } : null);
      },
      () => {
        if (!cancelled) setOffline(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, onlineId, cachedId, signedOut, runtime, token]);
  if (!enabled || signedOut) return null;
  return onlineId ?? cachedId ?? (offline?.token === token ? offline.id : null);
}

/** Local visibility only. The active E2EE owner already resolved this identity
 * through useE2eeAccountId and main; never use this as cloud authorization. */
export function useWorkspaceLocalAccountId(): string | null {
  const userId = useAtomValue(userAtom)?.id ?? null;
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  if (runtime?.contentMode !== 'e2ee') return userId;
  if (userId && runtime.accountId !== userId) return null;
  return runtime.accountId ?? null;
}
