import type { AuthenticatedConvexState } from './authed-convex-query';
import {
  CONVEX_AUTH_HEALTHY_RESET_MS,
  CONVEX_AUTH_RECOVERY_MAX_ATTEMPTS,
  CONVEX_AUTH_RECOVERY_TIMEOUT_MS,
  getConvexAuthRecoveryDelayMs,
  resolveAuthenticatedConvexState,
  shouldRecoverConvexAuthMismatch,
} from './authed-convex-query';
import type { StableSessionSupervisor, StableSessionValue } from './stable-session-supervisor';

export type AuthRecoverySnapshot = AuthenticatedConvexState & {
  authSessionId: string | null;
  recoverySessionId: string | null;
  confirmedUnauthenticated: boolean;
  isRecovering: boolean;
  claimAutomaticCommand: (key: string) => boolean;
  requestAuthRecovery: () => void;
  retryAuthRecovery: () => void;
  needsRecovery: boolean;
  recoveryExhausted: boolean;
  isOffline: boolean;
};

type ConvexAuthSnapshot = {
  isAuthenticated: boolean;
  isLoading: boolean;
};

type PendingRecovery = {
  promise: Promise<void>;
  resolve: () => void;
  restartRequested: boolean;
  sawConvexReset: boolean;
  timeoutId: ReturnType<typeof setTimeout>;
};

type Timer = ReturnType<typeof setTimeout>;

function canRecoverAuthNow(): boolean {
  const online = typeof navigator === 'undefined' || navigator.onLine;
  const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  return online && visible;
}

export type AuthRecoverySupervisor = {
  getSnapshot: () => AuthRecoverySnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  stop: () => void;
  updateConvexAuth: (value: ConvexAuthSnapshot) => void;
};

export type AuthRecoverySupervisorLease = {
  supervisor: AuthRecoverySupervisor;
  release: () => void;
};

type AuthRecoverySupervisorRoom = {
  supervisor: AuthRecoverySupervisor;
  refs: number;
};

export function createAuthRecoverySupervisor(
  sessionSupervisor: StableSessionSupervisor,
  restartConvexAuth: () => void
): AuthRecoverySupervisor {
  const listeners = new Set<() => void>();
  let session: StableSessionValue = sessionSupervisor.getSnapshot();
  let convexAuth: ConvexAuthSnapshot = { isAuthenticated: false, isLoading: true };
  let snapshot!: AuthRecoverySnapshot;
  let started = false;
  let recoveryAttempt = 0;
  let recoveryAllowed = canRecoverAuthNow();
  let recoveryRequested = false;
  let isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  let pendingRecovery: PendingRecovery | null = null;
  let recoverySessionId: string | null = session.rawData?.session?.id ?? null;
  let sessionGeneration = 0;
  let recoveryTimer: Timer | null = null;
  let healthyResetTimer: Timer | null = null;
  let unsubscribeSession: (() => void) | null = null;
  let browserCleanup: (() => void) | null = null;
  const authSessionIdRef = { current: session.rawData?.session?.id ?? null };
  const automaticCommandRegistry = {
    sessionId: authSessionIdRef.current,
    keys: new Set<string>(),
  };

  const publish = (next: AuthRecoverySnapshot) => {
    if (
      snapshot &&
      snapshot.authSessionId === next.authSessionId &&
      snapshot.recoverySessionId === next.recoverySessionId &&
      snapshot.isAuthenticated === next.isAuthenticated &&
      snapshot.isLoading === next.isLoading &&
      snapshot.confirmedUnauthenticated === next.confirmedUnauthenticated &&
      snapshot.isRecovering === next.isRecovering &&
      snapshot.needsRecovery === next.needsRecovery &&
      snapshot.recoveryExhausted === next.recoveryExhausted &&
      snapshot.isOffline === next.isOffline
    ) {
      return;
    }
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const clearRecoveryTimer = () => {
    if (!recoveryTimer) return;
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const clearHealthyResetTimer = () => {
    if (!healthyResetTimer) return;
    clearTimeout(healthyResetTimer);
    healthyResetTimer = null;
  };

  const finishPendingRecovery = (pending: PendingRecovery) => {
    if (pendingRecovery !== pending) return;
    pendingRecovery = null;
    clearTimeout(pending.timeoutId);
    pending.resolve();
  };

  const runRecovery = (): Promise<void> => {
    if (session.confirmedUnauthenticated) return Promise.resolve();
    if (pendingRecovery) return pendingRecovery.promise;

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
        finishPendingRecovery(pending);
      }, CONVEX_AUTH_RECOVERY_TIMEOUT_MS),
    };
    pendingRecovery = pending;

    void Promise.resolve()
      .then(() => sessionSupervisor.refetch())
      .catch(() => undefined)
      .then(() => {
        if (pendingRecovery !== pending) return;
        pending.restartRequested = true;
        restartConvexAuth();
        reconcile();
      });
    return promise;
  };

  const claimAutomaticCommand = (key: string): boolean => {
    const sessionId = authSessionIdRef.current;
    if (!sessionId) return false;
    if (automaticCommandRegistry.sessionId !== sessionId) {
      automaticCommandRegistry.sessionId = sessionId;
      automaticCommandRegistry.keys.clear();
    }
    if (automaticCommandRegistry.keys.has(key)) return false;
    automaticCommandRegistry.keys.add(key);
    return true;
  };

  const requestAuthRecovery = () => {
    if (session.confirmedUnauthenticated) return;
    recoveryRequested = true;
    reconcile();
  };

  const retryAuthRecovery = () => {
    recoveryAttempt = 0;
    recoveryRequested = true;
    reconcile();
  };

  const scheduleRecovery = (isRecovering: boolean) => {
    if (!isRecovering || !recoveryAllowed || pendingRecovery) {
      clearRecoveryTimer();
      return;
    }
    if (recoveryTimer) return;

    const generation = sessionGeneration;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (!started || generation !== sessionGeneration) return;
      void runRecovery().finally(() => {
        if (started && generation === sessionGeneration) {
          recoveryAttempt += 1;
          reconcile();
        }
      });
    }, getConvexAuthRecoveryDelayMs(recoveryAttempt));
  };

  const scheduleHealthyReset = (needsRecovery: boolean) => {
    if (needsRecovery || !convexAuth.isAuthenticated || convexAuth.isLoading) {
      clearHealthyResetTimer();
      return;
    }
    if (healthyResetTimer) return;

    healthyResetTimer = setTimeout(() => {
      healthyResetTimer = null;
      if (!started) return;
      recoveryAttempt = 0;
      reconcile();
    }, CONVEX_AUTH_HEALTHY_RESET_MS);
  };

  function reconcile() {
    if (!started) return;
    const authSessionId = session.rawData?.session?.id ?? null;
    authSessionIdRef.current = authSessionId;
    if (authSessionId !== null && recoverySessionId !== authSessionId) {
      recoverySessionId = authSessionId;
      sessionGeneration += 1;
      recoveryAttempt = 0;
      recoveryRequested = false;
      clearRecoveryTimer();
      clearHealthyResetTimer();
      if (pendingRecovery) finishPendingRecovery(pendingRecovery);
      automaticCommandRegistry.sessionId = authSessionId;
      automaticCommandRegistry.keys.clear();
    }

    if (session.confirmedUnauthenticated) {
      recoveryRequested = false;
      if (pendingRecovery) finishPendingRecovery(pendingRecovery);
    }

    const shouldRecoverMismatch = shouldRecoverConvexAuthMismatch({
      isConvexAuthenticated: convexAuth.isAuthenticated,
      isConvexAuthLoading: convexAuth.isLoading,
      hasRawSessionUser: session.hasRawUser,
      confirmedUnauthenticated: session.confirmedUnauthenticated,
    });
    if (shouldRecoverMismatch) recoveryRequested = true;

    const needsRecovery =
      !session.confirmedUnauthenticated && (recoveryRequested || shouldRecoverMismatch);
    const recoveryExhausted = needsRecovery && recoveryAttempt >= CONVEX_AUTH_RECOVERY_MAX_ATTEMPTS;
    const isRecovering = needsRecovery && !recoveryExhausted;
    const resolvedState = resolveAuthenticatedConvexState({
      isConvexAuthenticated: convexAuth.isAuthenticated,
      isConvexAuthLoading: convexAuth.isLoading,
      hasRawSessionUser: session.hasRawUser,
      hasLocalToken: session.hasLocalToken,
      isSessionPending: session.isPending,
      isSessionRetrying: session.isRetrying,
      confirmedUnauthenticated: session.confirmedUnauthenticated,
    });

    publish({
      authSessionId,
      recoverySessionId,
      isAuthenticated: resolvedState.isAuthenticated && !needsRecovery,
      isLoading: !recoveryExhausted && (resolvedState.isLoading || isRecovering),
      confirmedUnauthenticated: session.confirmedUnauthenticated,
      isRecovering,
      claimAutomaticCommand,
      requestAuthRecovery,
      retryAuthRecovery,
      needsRecovery,
      recoveryExhausted,
      isOffline,
    });

    scheduleRecovery(isRecovering);
    scheduleHealthyReset(needsRecovery);

    if (pendingRecovery?.restartRequested) {
      if (convexAuth.isLoading) {
        pendingRecovery.sawConvexReset = true;
      } else if (pendingRecovery.sawConvexReset) {
        const pending = pendingRecovery;
        if (convexAuth.isAuthenticated) recoveryRequested = false;
        finishPendingRecovery(pending);
        reconcile();
      }
    }
  }

  snapshot = {
    authSessionId: session.rawData?.session?.id ?? null,
    recoverySessionId,
    isAuthenticated: false,
    isLoading: true,
    confirmedUnauthenticated: session.confirmedUnauthenticated,
    isRecovering: false,
    claimAutomaticCommand,
    requestAuthRecovery,
    retryAuthRecovery,
    needsRecovery: false,
    recoveryExhausted: false,
    isOffline,
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
      session = sessionSupervisor.getSnapshot();
      recoveryAllowed = canRecoverAuthNow();
      isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      unsubscribeSession = sessionSupervisor.subscribe(() => {
        session = sessionSupervisor.getSnapshot();
        reconcile();
      });
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const updateRecoveryAllowed = () => {
          recoveryAllowed = canRecoverAuthNow();
          isOffline = !navigator.onLine;
          reconcile();
        };
        window.addEventListener('online', updateRecoveryAllowed);
        window.addEventListener('offline', updateRecoveryAllowed);
        document.addEventListener('visibilitychange', updateRecoveryAllowed);
        browserCleanup = () => {
          window.removeEventListener('online', updateRecoveryAllowed);
          window.removeEventListener('offline', updateRecoveryAllowed);
          document.removeEventListener('visibilitychange', updateRecoveryAllowed);
        };
      }
      reconcile();
    },
    stop() {
      if (!started) return;
      started = false;
      clearRecoveryTimer();
      clearHealthyResetTimer();
      if (pendingRecovery) finishPendingRecovery(pendingRecovery);
      unsubscribeSession?.();
      unsubscribeSession = null;
      browserCleanup?.();
      browserCleanup = null;
      listeners.clear();
    },
    updateConvexAuth(value) {
      convexAuth = value;
      reconcile();
    },
  };
}

const authRecoverySupervisorRooms = new WeakMap<
  object,
  WeakMap<object, AuthRecoverySupervisorRoom>
>();

function getAuthRecoverySupervisorRoom(
  sessionSupervisor: StableSessionSupervisor,
  restartConvexAuth: () => void
): AuthRecoverySupervisorRoom {
  const sessionKey = sessionSupervisor as object;
  const restartKey = restartConvexAuth as object;
  let restartRooms = authRecoverySupervisorRooms.get(sessionKey);
  if (!restartRooms) {
    restartRooms = new WeakMap();
    authRecoverySupervisorRooms.set(sessionKey, restartRooms);
  }

  const existing = restartRooms.get(restartKey);
  if (existing) return existing;

  const room: AuthRecoverySupervisorRoom = {
    supervisor: createAuthRecoverySupervisor(sessionSupervisor, restartConvexAuth),
    refs: 0,
  };
  restartRooms.set(restartKey, room);
  return room;
}

export function getAuthRecoverySupervisor(
  sessionSupervisor: StableSessionSupervisor,
  restartConvexAuth: () => void
): AuthRecoverySupervisor {
  return getAuthRecoverySupervisorRoom(sessionSupervisor, restartConvexAuth).supervisor;
}

export function acquireAuthRecoverySupervisor(
  sessionSupervisor: StableSessionSupervisor,
  restartConvexAuth: () => void
): AuthRecoverySupervisorLease {
  const room = getAuthRecoverySupervisorRoom(sessionSupervisor, restartConvexAuth);
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
