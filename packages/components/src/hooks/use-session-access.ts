import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { usePlatform } from '@lody/platform/react';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import { acquireSessionAccessStore, EMPTY_SESSION_ACCESS } from '@/lib/session-access-store';
import { useLegacyWorkspaceQueryStatus } from './use-workspace-feature';
import {
  useResolvedWorkspaceScope,
  type WorkspaceScopeOptions,
} from './use-resolved-workspace-scope';

export function useSessionAccess(options: WorkspaceScopeOptions = {}) {
  const scope = useResolvedWorkspaceScope(options);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const accountId = useWorkspaceLocalAccountId();
  const platform = usePlatform();
  const port = platform.capabilities.has('teamSharing') ? platform.sessionAccess : undefined;
  const legacyStatus = useLegacyWorkspaceQueryStatus(scope.workspaceId);
  const enabled =
    (runtime?.contentMode === 'e2ee' || legacyStatus === 'allowed') &&
    scope.enabled &&
    !!accountId &&
    runtime?.workspaceId === scope.workspaceId;
  const [lease, setLease] = useState<
    | (ReturnType<typeof acquireSessionAccessStore> & {
        accountId: string;
        workspaceId: string;
        runtime: typeof runtime;
        port: typeof port;
      })
    | null
  >(null);
  useEffect(() => {
    if (!enabled || !port || !accountId || !scope.workspaceId) return;
    const acquired = acquireSessionAccessStore(port, accountId, scope.workspaceId);
    setLease({ ...acquired, accountId, workspaceId: scope.workspaceId, runtime, port });
    const refresh = () => {
      void acquired.store.refresh();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      setLease(null);
      acquired.release();
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled, port, accountId, scope.workspaceId, runtime]);
  // Scope is checked during render too, so old-account grants never survive one effect turn.
  const store =
    enabled &&
    lease?.accountId === accountId &&
    lease?.workspaceId === scope.workspaceId &&
    lease?.runtime === runtime &&
    lease?.port === port
      ? lease.store
      : null;
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => {}),
    [store]
  );
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? EMPTY_SESSION_ACCESS, [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snapshot, store, port, workspaceId: scope.workspaceId, enabled };
}
