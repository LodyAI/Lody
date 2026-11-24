import { useConvexAuth } from 'convex/react';
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import {
  AuthenticatedConvexContext,
  type AuthenticatedConvexContextValue,
} from '@/hooks/use-authenticated-convex';
import { AuthRecoveryError } from '@/components/auth-recovery-error';
import { AuthRecoveryEntryProvider } from '@/components/auth-recovery-entry';
import { useStableSessionSupervisor } from '@/hooks/useStableSession';
import {
  acquireAuthRecoverySupervisor,
  getAuthRecoverySupervisor,
} from '@/lib/auth-recovery-supervisor';
import { useRestartConvexAuth } from './convex-provider';

export function AuthenticatedConvexProvider({ children }: { children: ReactNode }) {
  const convexAuth = useConvexAuth();
  const sessionSupervisor = useStableSessionSupervisor();
  const restartConvexAuth = useRestartConvexAuth();
  const supervisor = useMemo(
    () => getAuthRecoverySupervisor(sessionSupervisor, restartConvexAuth),
    [restartConvexAuth, sessionSupervisor]
  );
  const recovery = useSyncExternalStore(
    supervisor.subscribe,
    supervisor.getSnapshot,
    supervisor.getSnapshot
  );

  useEffect(() => {
    const lease = acquireAuthRecoverySupervisor(sessionSupervisor, restartConvexAuth);
    return lease.release;
  }, [restartConvexAuth, sessionSupervisor, supervisor]);

  useEffect(() => {
    supervisor.updateConvexAuth(convexAuth);
  }, [convexAuth.isAuthenticated, convexAuth.isLoading, supervisor]);

  const value: AuthenticatedConvexContextValue = {
    authSessionId: recovery.authSessionId,
    isAuthenticated: recovery.isAuthenticated,
    isLoading: recovery.isLoading,
    isRecovering: recovery.isRecovering,
    confirmedUnauthenticated: recovery.confirmedUnauthenticated,
    claimAutomaticCommand: recovery.claimAutomaticCommand,
    requestAuthRecovery: recovery.requestAuthRecovery,
  };

  return (
    <AuthenticatedConvexContext.Provider value={value}>
      <AuthRecoveryEntryProvider
        notice={
          recovery.needsRecovery ? (
            <AuthRecoveryError
              key={recovery.recoverySessionId ?? 'no-session'}
              onRetry={recovery.retryAuthRecovery}
              isRecovering={recovery.isRecovering}
              isOffline={recovery.isOffline}
            />
          ) : null
        }
      >
        {children}
      </AuthRecoveryEntryProvider>
    </AuthenticatedConvexContext.Provider>
  );
}
