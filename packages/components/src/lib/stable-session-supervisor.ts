import { recordBootRequestResult } from './boot-request-failures';
import {
  readAuthBootstrapSnapshot,
  readStoredAuthToken,
  type AuthBootstrapSnapshot,
} from './auth-bootstrap';
import { subscribeLocalAuthStateCleared, type LodyAuthClient } from './auth';
import { acquireAuthSessionStore, type AuthSessionSnapshot } from './auth-session-store';
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
} from '../hooks/stable-session-state';

export type StableSessionOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  authenticatedSessionGraceMs?: number;
  resumeRefetchThrottleMs?: number;
};

export type StableSessionValue = {
  data: AuthSessionSnapshot['data'];
  rawData: AuthSessionSnapshot['data'];
  bootstrapSnapshot: AuthBootstrapSnapshot | null;
  hasLocalToken: boolean;
  hasRawUser: boolean;
  isOptimistic: boolean;
  isPending: boolean;
  isRetrying: boolean;
  error: AuthSessionSnapshot['error'];
  confirmedUnauthenticated: boolean;
  refetch: AuthSessionSnapshot['refetch'];
};

export type StableSessionSupervisor = {
  getSnapshot: () => StableSessionValue;
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  stop: () => void;
  refetch: AuthSessionSnapshot['refetch'];
};

export type StableSessionSupervisorLease = {
  supervisor: StableSessionSupervisor;
  release: () => void;
};

type StableSessionSupervisorRoom = {
  supervisor: StableSessionSupervisor;
  refs: number;
};

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

function readAuthResponseError(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return null;
  return (value as { error?: unknown }).error ?? null;
}

export function createStableSessionSupervisor(
  authClient: LodyAuthClient,
  options: StableSessionOptions = {}
): StableSessionSupervisor {
  const authSession = acquireAuthSessionStore(authClient);
  const listeners = new Set<() => void>();
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 3000;
  const authenticatedSessionGraceMs =
    options.authenticatedSessionGraceMs ?? DEFAULT_AUTHENTICATED_SESSION_GRACE_MS;
  const resumeRefetchThrottleMs =
    options.resumeRefetchThrottleMs ?? DEFAULT_SESSION_RESUME_REFETCH_THROTTLE_MS;
  const bootstrapSnapshot = typeof window === 'undefined' ? null : readAuthBootstrapSnapshot();
  const rawRefetch = (queryParams?: Parameters<AuthSessionSnapshot['refetch']>[0]) =>
    authSession.refetch(queryParams);

  let rawSession = authSession.getSnapshot();
  let snapshot!: StableSessionValue;
  let started = false;
  let retryTimer: Timer | null = null;
  let preserveTimer: Timer | null = null;
  let keepaliveInterval: Interval | null = null;
  let unsubscribeAuthSession: (() => void) | null = null;
  let unsubscribeLocalAuthState: (() => void) | null = null;
  let retryCount = 0;
  let preserveUntilMs: number | null = null;
  let confirmedUnauthorizedError: unknown = null;
  let dismissedUnauthorizedError: unknown = null;
  let isForcedUnauthorizedRefreshPending = false;
  let unauthorizedCheckSequence = 0;
  let unauthorizedVerificationKey: {
    error: unknown;
    localToken: string | null;
    retryCount: number;
  } | null = null;
  let hasForcedUnauthorizedRefresh = false;
  let lastAuthenticatedData = rawSession.data;
  let previousHadRawUser = hasAuthenticatedUser(rawSession.data);
  let hasConsumedInitialBootstrapGrace = false;
  let lastResumeRefetchAt: number | null = null;
  let recordedError: unknown = Symbol('unrecorded');

  const publish = (next: StableSessionValue) => {
    if (
      snapshot &&
      snapshot.data === next.data &&
      snapshot.rawData === next.rawData &&
      snapshot.bootstrapSnapshot === next.bootstrapSnapshot &&
      snapshot.hasLocalToken === next.hasLocalToken &&
      snapshot.hasRawUser === next.hasRawUser &&
      snapshot.isOptimistic === next.isOptimistic &&
      snapshot.isPending === next.isPending &&
      snapshot.isRetrying === next.isRetrying &&
      snapshot.error === next.error &&
      snapshot.confirmedUnauthenticated === next.confirmedUnauthenticated &&
      snapshot.refetch === next.refetch
    ) {
      return;
    }
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const clearPreserveTimer = () => {
    if (!preserveTimer) return;
    clearTimeout(preserveTimer);
    preserveTimer = null;
  };

  const updatePreserveTimer = () => {
    if (preserveUntilMs === null) {
      clearPreserveTimer();
      return;
    }

    const remainingMs = preserveUntilMs - Date.now();
    if (remainingMs <= 0) {
      preserveUntilMs = null;
      clearPreserveTimer();
      return;
    }
    if (preserveTimer) return;

    const expectedUntilMs = preserveUntilMs;
    preserveTimer = setTimeout(() => {
      preserveTimer = null;
      if (!started || preserveUntilMs !== expectedUntilMs) return;
      preserveUntilMs = null;
      reconcile();
    }, remainingMs);
  };

  const updateKeepalive = (hasLocalToken: boolean) => {
    if (!started || !hasLocalToken) {
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      keepaliveInterval = null;
      return;
    }
    if (!keepaliveInterval) {
      keepaliveInterval = setInterval(
        refetchIfNeeded,
        DEFAULT_SESSION_KEEPALIVE_REFETCH_INTERVAL_MS
      );
    }
  };

  const refetchIfNeeded = () => {
    if (!started) return;
    const now = Date.now();
    if (
      !shouldRefetchSessionOnBrowserResume({
        now,
        lastRefetchAtMs: lastResumeRefetchAt,
        throttleMs: resumeRefetchThrottleMs,
        isDocumentVisible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
        isBrowserOnline: typeof navigator === 'undefined' || navigator.onLine,
        isPending: snapshot.isPending,
      })
    ) {
      return;
    }

    lastResumeRefetchAt = now;
    void rawRefetch();
  };

  const installBrowserListeners = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refetchIfNeeded();
    };
    window.addEventListener('focus', refetchIfNeeded);
    window.addEventListener('online', refetchIfNeeded);
    window.addEventListener('pageshow', refetchIfNeeded);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    browserCleanup = () => {
      window.removeEventListener('focus', refetchIfNeeded);
      window.removeEventListener('online', refetchIfNeeded);
      window.removeEventListener('pageshow', refetchIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  };

  let browserCleanup: (() => void) | null = null;

  const startUnauthorizedVerification = ({
    error,
    localToken,
    retryCountAtStart,
  }: {
    error: unknown;
    localToken: string | null;
    retryCountAtStart: number;
  }) => {
    const verificationKey = unauthorizedVerificationKey;
    if (
      verificationKey &&
      verificationKey.error === error &&
      verificationKey.localToken === localToken &&
      verificationKey.retryCount === retryCountAtStart
    ) {
      return;
    }
    unauthorizedVerificationKey = { error, localToken, retryCount: retryCountAtStart };
    const sequence = ++unauthorizedCheckSequence;

    void Promise.resolve()
      .then(() => authClient.getSession({ fetchOptions: { throw: false } }))
      .then(
        (result) => {
          if (!started || unauthorizedCheckSequence !== sequence) return;

          const tokenChanged = readStoredAuthToken() !== localToken;
          const verificationError = readAuthResponseError(result);
          const verificationRejected = isUnauthorizedSessionError(verificationError);
          if (!tokenChanged && verificationRejected) {
            confirmedUnauthorizedError = error;
            reconcile();
            return;
          }

          dismissedUnauthorizedError = error;
          if (
            (tokenChanged || verificationError === null) &&
            retryCountAtStart >= maxRetries &&
            !hasForcedUnauthorizedRefresh
          ) {
            hasForcedUnauthorizedRefresh = true;
            isForcedUnauthorizedRefreshPending = true;
            reconcile();
            void rawRefetch().finally(() => {
              if (!started || unauthorizedCheckSequence !== sequence) return;
              isForcedUnauthorizedRefreshPending = false;
              reconcile();
            });
            return;
          }
          reconcile();
        },
        () => {
          if (!started || unauthorizedCheckSequence !== sequence) return;
          dismissedUnauthorizedError = error;
          reconcile();
        }
      );
  };

  function reconcile() {
    if (!started) return;
    rawSession = authSession.getSnapshot();
    const { data, error } = rawSession;
    const isPending =
      rawSession.isPending || (rawSession.isRefetching && !hasAuthenticatedUser(data));
    const hasLocalToken = Boolean(readStoredAuthToken());
    const hasRawUser = hasAuthenticatedUser(data);
    const hasUnauthorizedSessionError = isUnauthorizedSessionError(error);

    if (recordedError !== error) {
      recordedError = error;
      recordBootRequestResult('session', error);
    }

    if (!hasUnauthorizedSessionError) {
      ++unauthorizedCheckSequence;
      confirmedUnauthorizedError = null;
      dismissedUnauthorizedError = null;
      isForcedUnauthorizedRefreshPending = false;
      hasForcedUnauthorizedRefresh = false;
      unauthorizedVerificationKey = null;
    }

    const hadRawUser = previousHadRawUser;
    const rawUserChanged = hadRawUser !== hasRawUser;
    if (hasRawUser) {
      // React's original effect depended on the boolean, not every session
      // atom update. Cached user data plus a new transport error must still
      // consume the bounded retry budget.
      if (rawUserChanged) retryCount = 0;
      lastAuthenticatedData = data;
      preserveUntilMs = null;
      hasConsumedInitialBootstrapGrace = true;
    }

    if (!hasLocalToken) {
      lastAuthenticatedData = data;
      preserveUntilMs = null;
      hasConsumedInitialBootstrapGrace = false;
    }

    previousHadRawUser = hasRawUser;
    const hasLastAuthenticatedUser = hasAuthenticatedUser(lastAuthenticatedData);
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

    if (
      shouldStartAuthenticatedSessionGrace({
        hasLocalToken,
        hasRawUser,
        hasLastAuthenticatedUser,
        previousHadRawUser: hadRawUser,
        hasBootstrapSnapshot: bootstrapSnapshot !== null,
        hasConsumedInitialBootstrapGrace,
        isPending,
        shouldRetry:
          shouldScheduleRetry ||
          isConfirmingSessionUnauthorized ||
          isForcedUnauthorizedRefreshPending,
        hasFinalError: finalError !== null,
        preserveUntilMs,
      })
    ) {
      preserveUntilMs = Date.now() + authenticatedSessionGraceMs;
      if (!hadRawUser && bootstrapSnapshot !== null) {
        hasConsumedInitialBootstrapGrace = true;
      }
    }

    updatePreserveTimer();
    const now = Date.now();
    const confirmedUnauthenticated = shouldConfirmUnauthenticated({
      hasLocalToken,
      hasRawUser,
      isPending,
      shouldRetry:
        shouldScheduleRetry ||
        isConfirmingSessionUnauthorized ||
        isForcedUnauthorizedRefreshPending,
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
    const optimisticBootstrapSnapshot: AuthBootstrapSnapshot | null =
      hasLocalToken && bootstrapSnapshot ? bootstrapSnapshot : null;
    const shouldUseOptimisticBootstrap =
      !shouldUsePreservedSession &&
      !hasRawUser &&
      optimisticBootstrapSnapshot !== null &&
      !confirmedUnauthenticated;
    const stableData = confirmedUnauthenticated
      ? null
      : shouldUsePreservedSession
        ? lastAuthenticatedData
        : shouldUseOptimisticBootstrap
          ? ({ user: optimisticBootstrapSnapshot.user } as typeof data)
          : data;

    publish({
      data: stableData,
      rawData: data,
      bootstrapSnapshot: optimisticBootstrapSnapshot,
      hasLocalToken,
      hasRawUser,
      isOptimistic: shouldUseOptimisticBootstrap,
      isPending,
      isRetrying:
        shouldScheduleRetry ||
        isConfirmingSessionUnauthorized ||
        isForcedUnauthorizedRefreshPending,
      error: finalError,
      confirmedUnauthenticated,
      refetch: rawRefetch,
    });

    if (!started) return;
    updateKeepalive(hasLocalToken);

    if (isPending) {
      ++unauthorizedCheckSequence;
      unauthorizedVerificationKey = null;
    }

    if (
      hasUnauthorizedSessionError &&
      !isPending &&
      !isConfirmedSessionUnauthorized &&
      !isDismissedSessionUnauthorized
    ) {
      startUnauthorizedVerification({
        error,
        localToken: readStoredAuthToken(),
        retryCountAtStart: retryCount,
      });
    }

    if (!shouldScheduleRetry) {
      clearRetryTimer();
    } else if (!retryTimer) {
      const delayMs = Math.min(baseDelayMs * 2 ** retryCount, maxDelayMs);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!started) return;
        retryCount += 1;
        reconcile();
        void rawRefetch();
      }, delayMs);
    }
  }

  // The initial snapshot is synchronous for the first React frame. Network,
  // timers and browser listeners begin only when the external owner starts.
  started = false;
  rawSession = authSession.getSnapshot();
  const initialData = rawSession.data;
  const initialHasRawUser = hasAuthenticatedUser(initialData);
  const initialHasLocalToken = Boolean(readStoredAuthToken());
  const initialBootstrap = initialHasLocalToken && bootstrapSnapshot ? bootstrapSnapshot : null;
  snapshot = {
    data:
      !initialHasRawUser && initialBootstrap
        ? ({ user: initialBootstrap.user } as typeof initialData)
        : initialData,
    rawData: initialData,
    bootstrapSnapshot: initialBootstrap,
    hasLocalToken: initialHasLocalToken,
    hasRawUser: initialHasRawUser,
    isOptimistic: !initialHasRawUser && initialBootstrap !== null,
    isPending:
      rawSession.isPending || (rawSession.isRefetching && !hasAuthenticatedUser(initialData)),
    isRetrying: false,
    error: null,
    confirmedUnauthenticated: false,
    refetch: rawRefetch,
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (started) return;
      started = true;
      unsubscribeAuthSession = authSession.subscribe(() => {
        rawSession = authSession.getSnapshot();
        reconcile();
      });
      unsubscribeLocalAuthState = subscribeLocalAuthStateCleared(() => reconcile());
      authSession.start();
      installBrowserListeners();
      reconcile();
    },
    stop() {
      if (!started) return;
      started = false;
      ++unauthorizedCheckSequence;
      clearRetryTimer();
      clearPreserveTimer();
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      keepaliveInterval = null;
      browserCleanup?.();
      browserCleanup = null;
      unsubscribeLocalAuthState?.();
      unsubscribeLocalAuthState = null;
      unsubscribeAuthSession?.();
      unsubscribeAuthSession = null;
      authSession.stop();
      listeners.clear();
    },
    refetch: rawRefetch,
  };
}

const stableSessionSupervisorRooms = new WeakMap<object, StableSessionSupervisorRoom>();

export function getStableSessionSupervisor(
  authClient: LodyAuthClient,
  options: StableSessionOptions = {}
): StableSessionSupervisor {
  const key = authClient as object;
  const existing = stableSessionSupervisorRooms.get(key);
  if (existing) return existing.supervisor;

  const room: StableSessionSupervisorRoom = {
    supervisor: createStableSessionSupervisor(authClient, options),
    refs: 0,
  };
  stableSessionSupervisorRooms.set(key, room);
  return room.supervisor;
}

export function acquireStableSessionSupervisor(
  authClient: LodyAuthClient,
  options: StableSessionOptions = {}
): StableSessionSupervisorLease {
  const key = authClient as object;
  const existing = stableSessionSupervisorRooms.get(key);
  const room =
    existing ??
    (() => {
      const created: StableSessionSupervisorRoom = {
        supervisor: createStableSessionSupervisor(authClient, options),
        refs: 0,
      };
      stableSessionSupervisorRooms.set(key, created);
      return created;
    })();

  room.refs += 1;
  if (room.refs === 1) room.supervisor.start();

  let released = false;
  return {
    supervisor: room.supervisor,
    release() {
      if (released) return;
      released = true;
      room.refs -= 1;
      if (room.refs === 0) room.supervisor.stop();
    },
  };
}
