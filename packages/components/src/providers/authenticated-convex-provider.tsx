import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConvexAuth } from 'convex/react';
import {
  getConvexAuthRecoveryDelayMs,
  CONVEX_AUTH_RECOVERY_MAX_ATTEMPTS,
  CONVEX_AUTH_RECOVERY_TIMEOUT_MS,
  CONVEX_AUTH_HEALTHY_RESET_MS,
  resolveAuthenticatedConvexState,
  shouldRecoverConvexAuthMismatch,
} from '@/lib/authed-convex-query';
import {
  AuthenticatedConvexContext,
  type AuthenticatedConvexContextValue,
} from '@/hooks/use-authenticated-convex';
import { useStableSession } from '@/hooks/useStableSession';
import { AuthRecoveryError } from '@/components/auth-recovery-error';
import { useRestartConvexAuth } from './convex-provider';

type PendingRecovery = {
  promise: Promise<void>;
  resolve: () => void;
  restartRequested: boolean;
  sawConvexReset: boolean;
  timeoutId: ReturnType<typeof setTimeout>;
};

function canRecoverAuthNow(): boolean {
  const online = typeof navigator === 'undefined' || navigator.onLine;
  const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  return online && visible;
}

export function AuthenticatedConvexProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated: isConvexAuthenticated, isLoading: isConvexAuthLoading } =
    useConvexAuth();
  const {
    hasLocalToken,
    hasRawUser,
    isPending: isSessionPending,
    isRetrying: isSessionRetrying,
    confirmedUnauthenticated,
    rawData,
    refetch,
  } = useStableSession();
  const restartConvexAuth = useRestartConvexAuth();
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [recoveryAllowed, setRecoveryAllowed] = useState(canRecoverAuthNow);
  const [recoveryRequested, setRecoveryRequested] = useState(false);
  const pendingRecoveryRef = useRef<PendingRecovery | null>(null);
  const authSessionId = rawData?.session?.id ?? null;
  // Raw session data can disappear while refetching. Absence is not a new
  // login and must not replenish the outage budget.
  const recoverySessionRef = useRef(authSessionId);
  if (authSessionId !== null) recoverySessionRef.current = authSessionId;
  const recoverySessionId = recoverySessionRef.current;
  const recoveryGenerationRef = useRef(0);
  const authSessionIdRef = useRef<string | null>(authSessionId);
  const automaticCommandRegistryRef = useRef({
    sessionId: authSessionIdRef.current,
    keys: new Set<string>(),
  });
  authSessionIdRef.current = authSessionId;

  const claimAutomaticCommand = useCallback((key: string): boolean => {
    const sessionId = authSessionIdRef.current;
    if (!sessionId) return false;

    const registry = automaticCommandRegistryRef.current;
    if (registry.sessionId !== sessionId) {
      registry.sessionId = sessionId;
      registry.keys.clear();
    }
    if (registry.keys.has(key)) return false;
    registry.keys.add(key);
    return true;
  }, []);

  const requestAuthRecovery = useCallback(() => {
    if (!confirmedUnauthenticated) {
      setRecoveryRequested(true);
    }
  }, [confirmedUnauthenticated]);

  const runRecovery = useCallback((): Promise<void> => {
    if (confirmedUnauthenticated) {
      return Promise.resolve();
    }
    if (pendingRecoveryRef.current) {
      return pendingRecoveryRef.current.promise;
    }

    let resolveRequest!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    const pending: PendingRecovery = {
      promise,
      resolve: resolveRequest,
      restartRequested: false,
      sawConvexReset: false,
      timeoutId: setTimeout(() => {
        if (pendingRecoveryRef.current !== pending) return;
        pendingRecoveryRef.current = null;
        pending.resolve();
      }, CONVEX_AUTH_RECOVERY_TIMEOUT_MS),
    };
    pendingRecoveryRef.current = pending;

    void Promise.resolve()
      .then(() => refetch())
      .catch(() => undefined)
      .then(() => {
        if (pendingRecoveryRef.current !== pending) return;
        pending.restartRequested = true;
        restartConvexAuth();
      });
    return promise;
  }, [confirmedUnauthenticated, refetch, restartConvexAuth]);

  useEffect(() => {
    const updateRecoveryAllowed = () => setRecoveryAllowed(canRecoverAuthNow());
    window.addEventListener('online', updateRecoveryAllowed);
    window.addEventListener('offline', updateRecoveryAllowed);
    document.addEventListener('visibilitychange', updateRecoveryAllowed);
    return () => {
      window.removeEventListener('online', updateRecoveryAllowed);
      window.removeEventListener('offline', updateRecoveryAllowed);
      document.removeEventListener('visibilitychange', updateRecoveryAllowed);
    };
  }, []);

  useEffect(() => {
    const pending = pendingRecoveryRef.current;
    if (!pending?.restartRequested) return;

    if (isConvexAuthLoading) {
      pending.sawConvexReset = true;
      return;
    }
    if (!pending.sawConvexReset) return;

    pendingRecoveryRef.current = null;
    clearTimeout(pending.timeoutId);
    if (isConvexAuthenticated) {
      setRecoveryRequested(false);
    }
    pending.resolve();
  }, [isConvexAuthLoading, isConvexAuthenticated]);

  useEffect(() => {
    if (!confirmedUnauthenticated) return;
    setRecoveryRequested(false);
    const pending = pendingRecoveryRef.current;
    if (!pending) return;
    pendingRecoveryRef.current = null;
    clearTimeout(pending.timeoutId);
    pending.resolve();
  }, [confirmedUnauthenticated]);

  // A new account/session owns a new budget. Retire old requests before their
  // callbacks can restart Convex or charge the next session's budget.
  useEffect(() => {
    setRecoveryAttempt(0);
    setRecoveryRequested(false);
    return () => {
      recoveryGenerationRef.current += 1;
      const pending = pendingRecoveryRef.current;
      pendingRecoveryRef.current = null;
      if (pending) {
        clearTimeout(pending.timeoutId);
        pending.resolve();
      }
    };
  }, [recoverySessionId]);

  const shouldRecoverMismatch = shouldRecoverConvexAuthMismatch({
    isConvexAuthenticated,
    isConvexAuthLoading,
    hasRawSessionUser: hasRawUser,
    confirmedUnauthenticated,
  });
  // Keep the outage latched through Convex's intermediate loading state.
  // Visibility/network changes pause scheduling, never reset the budget.
  useEffect(() => {
    if (shouldRecoverMismatch) setRecoveryRequested(true);
  }, [shouldRecoverMismatch, recoverySessionId]);
  const needsRecovery = !confirmedUnauthenticated && (recoveryRequested || shouldRecoverMismatch);
  const recoveryExhausted = needsRecovery && recoveryAttempt >= CONVEX_AUTH_RECOVERY_MAX_ATTEMPTS;
  const isRecovering = needsRecovery && !recoveryExhausted;

  useEffect(() => {
    if (!isRecovering || !recoveryAllowed || pendingRecoveryRef.current) return undefined;

    const generation = recoveryGenerationRef.current;
    const timeoutId = setTimeout(() => {
      void runRecovery().finally(() => {
        if (recoveryGenerationRef.current === generation) {
          setRecoveryAttempt((attempt) => attempt + 1);
        }
      });
    }, getConvexAuthRecoveryDelayMs(recoveryAttempt));

    return () => clearTimeout(timeoutId);
  }, [isRecovering, recoveryAllowed, recoveryAttempt, runRecovery, recoverySessionId]);

  // A transient "authenticated" edge is not proof of recovery: a protected
  // query can still reject the fresh JWT. Require sustained health before
  // forgiving previous attempts, so that loop is bounded too.
  useEffect(() => {
    if (needsRecovery || !isConvexAuthenticated || isConvexAuthLoading) return undefined;
    const timeoutId = setTimeout(() => setRecoveryAttempt(0), CONVEX_AUTH_HEALTHY_RESET_MS);
    return () => clearTimeout(timeoutId);
  }, [needsRecovery, isConvexAuthenticated, isConvexAuthLoading]);

  const retryAuthRecovery = useCallback(() => {
    setRecoveryAttempt(0);
    setRecoveryRequested(true);
  }, []);

  const resolvedState = resolveAuthenticatedConvexState({
    isConvexAuthenticated,
    isConvexAuthLoading,
    hasRawSessionUser: hasRawUser,
    hasLocalToken,
    isSessionPending,
    isSessionRetrying,
    confirmedUnauthenticated,
  });
  const isAuthenticated = resolvedState.isAuthenticated && !needsRecovery;
  const isLoading = !recoveryExhausted && (resolvedState.isLoading || isRecovering);
  const value = useMemo<AuthenticatedConvexContextValue>(
    () => ({
      authSessionId,
      isAuthenticated,
      isLoading,
      isRecovering,
      confirmedUnauthenticated,
      claimAutomaticCommand,
      requestAuthRecovery,
    }),
    [
      authSessionId,
      claimAutomaticCommand,
      confirmedUnauthenticated,
      isAuthenticated,
      isLoading,
      isRecovering,
      requestAuthRecovery,
    ]
  );

  return (
    <AuthenticatedConvexContext.Provider value={value}>
      {children}
      {recoveryExhausted ? <AuthRecoveryError onRetry={retryAuthRecovery} /> : null}
    </AuthenticatedConvexContext.Provider>
  );
}
