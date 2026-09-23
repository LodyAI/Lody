import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useAuthClient } from '../providers/convex-provider';
import {
  readAuthBootstrapSnapshot,
  readStoredAuthToken,
  type AuthBootstrapSnapshot,
} from '@/lib/auth-bootstrap';
import {
  DEFAULT_AUTHENTICATED_SESSION_GRACE_MS,
  DEFAULT_SESSION_KEEPALIVE_REFETCH_INTERVAL_MS,
  DEFAULT_SESSION_RESUME_REFETCH_THROTTLE_MS,
  hasAuthenticatedUser,
  isUnauthorizedSessionError,
  shouldConfirmUnauthenticated,
  shouldRefetchSessionOnBrowserResume,
  shouldRetryMissingAuthenticatedSession,
  shouldRetrySessionError,
  shouldStartAuthenticatedSessionGrace,
  shouldUsePreservedAuthenticatedSession,
} from './stable-session-state';

type UseStableSessionOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  authenticatedSessionGraceMs?: number;
  resumeRefetchThrottleMs?: number;
};

export type StableSessionValue = {
  data: ReturnType<ReturnType<typeof useAuthClient>['useSession']>['data'];
  rawData: ReturnType<ReturnType<typeof useAuthClient>['useSession']>['data'];
  bootstrapSnapshot: AuthBootstrapSnapshot | null;
  hasLocalToken: boolean;
  hasRawUser: boolean;
  isOptimistic: boolean;
  isPending: boolean;
  isRetrying: boolean;
  error: Error | null;
  confirmedUnauthenticated: boolean;
  refetch: ReturnType<ReturnType<typeof useAuthClient>['useSession']>['refetch'];
};

const StableSessionContext = createContext<StableSessionValue | null>(null);

export { StableSessionContext };

function readAuthResponseError(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return null;
  return (value as { error?: unknown }).error ?? null;
}

export function useStableSessionInternal(options?: UseStableSessionOptions): StableSessionValue {
  const authClient = useAuthClient();
  const { data, isPending, error, refetch } = authClient.useSession();
  const maxRetries = options?.maxRetries ?? 2;
  const baseDelayMs = options?.baseDelayMs ?? 300;
  const maxDelayMs = options?.maxDelayMs ?? 3000;
  const authenticatedSessionGraceMs =
    options?.authenticatedSessionGraceMs ?? DEFAULT_AUTHENTICATED_SESSION_GRACE_MS;
  const resumeRefetchThrottleMs =
    options?.resumeRefetchThrottleMs ?? DEFAULT_SESSION_RESUME_REFETCH_THROTTLE_MS;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastResumeRefetchAtRef = useRef<number | null>(null);
  const isPendingRef = useRef(isPending);
  const [retryCount, setRetryCount] = useState(0);
  const [preserveUntilMs, setPreserveUntilMs] = useState<number | null>(null);
  const [confirmedUnauthorizedError, setConfirmedUnauthorizedError] = useState<unknown>(null);
  const [dismissedUnauthorizedError, setDismissedUnauthorizedError] = useState<unknown>(null);
  const [isForcedUnauthorizedRefreshPending, setIsForcedUnauthorizedRefreshPending] =
    useState(false);
  const unauthorizedCheckSequenceRef = useRef(0);
  const hasForcedUnauthorizedRefreshRef = useRef(false);
  const lastAuthenticatedDataRef = useRef(data);
  const previousHadRawUserRef = useRef(hasAuthenticatedUser(data));
  const hasConsumedInitialBootstrapGraceRef = useRef(false);
  isPendingRef.current = isPending;

  // Lazy-init: read bootstrap snapshot once, not on every render.
  const [bootstrapSnapshot] = useState<AuthBootstrapSnapshot | null>(() =>
    typeof window === 'undefined' ? null : readAuthBootstrapSnapshot()
  );
  const localToken = readStoredAuthToken();
  const hasLocalToken = Boolean(localToken);
  const hasRawUser = hasAuthenticatedUser(data);
  const hasUnauthorizedSessionError = isUnauthorizedSessionError(error);
  const isConfirmedSessionUnauthorized =
    hasUnauthorizedSessionError && confirmedUnauthorizedError === error;
  const isDismissedSessionUnauthorized =
    hasUnauthorizedSessionError && dismissedUnauthorizedError === error;
  const isConfirmingSessionUnauthorized =
    hasUnauthorizedSessionError &&
    !isPending &&
    !isConfirmedSessionUnauthorized &&
    !isDismissedSessionUnauthorized;
  const isSessionUnauthorized = hasUnauthorizedSessionError && !isDismissedSessionUnauthorized;
  const shouldRetryMissingSession = shouldRetryMissingAuthenticatedSession({
    hasLocalToken,
    hasRawUser,
    isPending,
    hasError: Boolean(error),
    retryCount,
    maxRetries,
  });
  const shouldScheduleRetry =
    shouldRetrySessionError({
      hasError: Boolean(error),
      isPending,
      isSessionUnauthorized,
      retryCount,
      maxRetries,
    }) || shouldRetryMissingSession;
  const finalError =
    isConfirmedSessionUnauthorized ||
    (Boolean(error) &&
      retryCount >= maxRetries &&
      !isConfirmingSessionUnauthorized &&
      !isForcedUnauthorizedRefreshPending)
      ? error
      : null;
  const hasLastAuthenticatedUser = hasAuthenticatedUser(lastAuthenticatedDataRef.current);
  const hasBootstrapSnapshot = bootstrapSnapshot !== null;

  useEffect(() => {
    if (!hasUnauthorizedSessionError) {
      setConfirmedUnauthorizedError(null);
      setDismissedUnauthorizedError(null);
      setIsForcedUnauthorizedRefreshPending(false);
      hasForcedUnauthorizedRefreshRef.current = false;
      return undefined;
    }
    if (isPending || isConfirmedSessionUnauthorized || isDismissedSessionUnauthorized) {
      return undefined;
    }

    const tokenAtStart = localToken;
    const sequence = unauthorizedCheckSequenceRef.current + 1;
    unauthorizedCheckSequenceRef.current = sequence;
    let cancelled = false;

    void authClient.getSession({ fetchOptions: { throw: false } }).then(
      (result) => {
        if (cancelled || unauthorizedCheckSequenceRef.current !== sequence) return;

        const tokenChanged = readStoredAuthToken() !== tokenAtStart;
        const verificationError = readAuthResponseError(result);
        const verificationRejected = isUnauthorizedSessionError(verificationError);
        if (!tokenChanged && verificationRejected) {
          setConfirmedUnauthorizedError(error);
          return;
        }

        // The 401 belonged to an older credential, or the current credential
        // now succeeds. Let the ordinary retry lane refresh the session atom.
        setDismissedUnauthorizedError(error);
        if (
          (tokenChanged || verificationError === null) &&
          retryCount >= maxRetries &&
          !hasForcedUnauthorizedRefreshRef.current
        ) {
          hasForcedUnauthorizedRefreshRef.current = true;
          setIsForcedUnauthorizedRefreshPending(true);
          void refetch().finally(() => setIsForcedUnauthorizedRefreshPending(false));
        }
      },
      () => {
        if (cancelled || unauthorizedCheckSequenceRef.current !== sequence) return;
        // A transport failure cannot confirm credential rejection.
        setDismissedUnauthorizedError(error);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [
    authClient,
    error,
    hasUnauthorizedSessionError,
    isConfirmedSessionUnauthorized,
    isDismissedSessionUnauthorized,
    isPending,
    localToken,
    maxRetries,
    refetch,
    retryCount,
  ]);

  useEffect(() => {
    if (!shouldScheduleRetry) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return undefined;
    }

    if (timerRef.current) {
      return undefined;
    }

    const delayMs = Math.min(baseDelayMs * 2 ** retryCount, maxDelayMs);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setRetryCount((prev) => prev + 1);
      void refetch();
    }, delayMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [baseDelayMs, maxDelayMs, maxRetries, refetch, retryCount, shouldScheduleRetry]);

  useEffect(() => {
    if (hasRawUser) {
      setRetryCount(0);
    }
  }, [hasRawUser]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    const refetchIfNeeded = () => {
      const isDocumentVisible = document.visibilityState !== 'hidden';
      const isBrowserOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
      const now = Date.now();

      if (
        !shouldRefetchSessionOnBrowserResume({
          now,
          lastRefetchAtMs: lastResumeRefetchAtRef.current,
          throttleMs: resumeRefetchThrottleMs,
          isDocumentVisible,
          isBrowserOnline,
          isPending: isPendingRef.current,
        })
      ) {
        return;
      }

      lastResumeRefetchAtRef.current = now;
      void refetch();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refetchIfNeeded();
      }
    };

    window.addEventListener('focus', refetchIfNeeded);
    window.addEventListener('online', refetchIfNeeded);
    window.addEventListener('pageshow', refetchIfNeeded);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const keepaliveIntervalId = hasLocalToken
      ? setInterval(refetchIfNeeded, DEFAULT_SESSION_KEEPALIVE_REFETCH_INTERVAL_MS)
      : null;

    return () => {
      window.removeEventListener('focus', refetchIfNeeded);
      window.removeEventListener('online', refetchIfNeeded);
      window.removeEventListener('pageshow', refetchIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (keepaliveIntervalId) {
        clearInterval(keepaliveIntervalId);
      }
    };
  }, [hasLocalToken, refetch, resumeRefetchThrottleMs]);

  useEffect(() => {
    if (!hasRawUser) {
      return;
    }

    lastAuthenticatedDataRef.current = data;
    setPreserveUntilMs(null);
    hasConsumedInitialBootstrapGraceRef.current = true;
  }, [data, hasRawUser]);

  useEffect(() => {
    if (hasLocalToken) {
      return;
    }

    lastAuthenticatedDataRef.current = data;
    setPreserveUntilMs(null);
    hasConsumedInitialBootstrapGraceRef.current = false;
  }, [data, hasLocalToken]);

  useEffect(() => {
    const previousHadRawUser = previousHadRawUserRef.current;
    previousHadRawUserRef.current = hasRawUser;

    if (
      !shouldStartAuthenticatedSessionGrace({
        hasLocalToken,
        hasRawUser,
        hasLastAuthenticatedUser,
        previousHadRawUser,
        hasBootstrapSnapshot,
        hasConsumedInitialBootstrapGrace: hasConsumedInitialBootstrapGraceRef.current,
        isPending,
        shouldRetry:
          shouldScheduleRetry ||
          isConfirmingSessionUnauthorized ||
          isForcedUnauthorizedRefreshPending,
        hasFinalError: finalError !== null,
        preserveUntilMs,
      })
    ) {
      return;
    }

    setPreserveUntilMs(Date.now() + authenticatedSessionGraceMs);

    if (!previousHadRawUser && hasBootstrapSnapshot) {
      hasConsumedInitialBootstrapGraceRef.current = true;
    }
  }, [
    authenticatedSessionGraceMs,
    finalError,
    hasBootstrapSnapshot,
    hasLastAuthenticatedUser,
    hasLocalToken,
    hasRawUser,
    isPending,
    isConfirmingSessionUnauthorized,
    isForcedUnauthorizedRefreshPending,
    preserveUntilMs,
    shouldScheduleRetry,
  ]);

  useEffect(() => {
    if (preserveUntilMs === null) {
      return undefined;
    }

    const remainingMs = preserveUntilMs - Date.now();
    if (remainingMs <= 0) {
      setPreserveUntilMs(null);
      return undefined;
    }

    const timeoutId = setTimeout(() => {
      setPreserveUntilMs((current) => (current === preserveUntilMs ? null : current));
    }, remainingMs);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [preserveUntilMs]);

  const optimisticBootstrapSnapshot: AuthBootstrapSnapshot | null =
    hasLocalToken && bootstrapSnapshot ? bootstrapSnapshot : null;
  const now = Date.now();
  const confirmedUnauthenticated = shouldConfirmUnauthenticated({
    hasLocalToken,
    hasRawUser,
    isPending,
    shouldRetry:
      shouldScheduleRetry || isConfirmingSessionUnauthorized || isForcedUnauthorizedRefreshPending,
    hasFinalError: finalError !== null,
    isSessionUnauthorized: isConfirmedSessionUnauthorized,
    preserveUntilMs,
    now,
  });
  const shouldUsePreservedSession =
    !confirmedUnauthenticated &&
    shouldUsePreservedAuthenticatedSession({
      hasLocalToken,
      hasRawUser,
      hasLastAuthenticatedUser,
      preserveUntilMs,
      now,
    });
  const shouldUseOptimisticBootstrap =
    !shouldUsePreservedSession &&
    !hasRawUser &&
    optimisticBootstrapSnapshot !== null &&
    !confirmedUnauthenticated;
  const stableData = confirmedUnauthenticated
    ? null
    : shouldUsePreservedSession
      ? lastAuthenticatedDataRef.current
      : shouldUseOptimisticBootstrap
        ? ({ user: optimisticBootstrapSnapshot.user } as typeof data)
        : data;

  return {
    data: stableData,
    rawData: data,
    bootstrapSnapshot: optimisticBootstrapSnapshot,
    hasLocalToken,
    hasRawUser,
    isOptimistic: shouldUseOptimisticBootstrap,
    isPending,
    isRetrying:
      shouldScheduleRetry || isConfirmingSessionUnauthorized || isForcedUnauthorizedRefreshPending,
    error: finalError,
    confirmedUnauthenticated,
    refetch,
  };
}

export function useStableSession(): StableSessionValue {
  const ctx = useContext(StableSessionContext);
  if (!ctx) {
    throw new Error('useStableSession must be used within a StableSessionProvider');
  }
  return ctx;
}
