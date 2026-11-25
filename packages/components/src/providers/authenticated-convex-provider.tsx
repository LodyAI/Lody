import { useConvexAuth } from 'convex/react';
import { useCallback, useEffect, type ReactNode } from 'react';
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
import { useExternalSnapshot } from '@/lib/external-snapshot';
import { useRestartConvexAuth } from './convex-provider';

export function AuthenticatedConvexProvider({ children }: { children: ReactNode }) {
  const convexAuth = useConvexAuth();
  const sessionSupervisor = useStableSessionSupervisor();
  const restartConvexAuth = useRestartConvexAuth();
  const supervisor = getAuthRecoverySupervisor(sessionSupervisor, restartConvexAuth);
  const acquire = useCallback(
    () => acquireAuthRecoverySupervisor(sessionSupervisor, restartConvexAuth),
    [sessionSupervisor, restartConvexAuth]
  );
  const recovery = useExternalSnapshot(supervisor, acquire);

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
