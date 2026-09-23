import { Clock, Duration, Effect, Fiber, Runtime } from 'effect';

const LOCAL_RECONNECT_BASE_DELAY_MS = 1_000;
const LOCAL_RECONNECT_MAX_DELAY_MS = 30_000;
const LOCAL_RECONNECT_JITTER_FRACTION = 0.2;
// Backoff is only forgiven after the problem stays cleared for this long. A
// reconnect attempt briefly cycles rooms through 'connecting' (during which
// hasProblem() reads false); resetting the attempt counter on that transient
// window let a persistent failure retry at full speed forever (the offline
// local-first reconnect storm). Matches the max delay: a recovery shorter than
// the largest backoff step earns no refund.
const LOCAL_RECONNECT_HEALTHY_RESET_MS = LOCAL_RECONNECT_MAX_DELAY_MS;

export type LocalReconnectTriggerReason = 'visibility-wake' | 'network-online' | 'token-refresh';

export const computeLocalReconnectDelayMs = (
  attempt: number,
  random: () => number = Math.random
): number => {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const exponentialDelay = Math.min(
    LOCAL_RECONNECT_MAX_DELAY_MS,
    LOCAL_RECONNECT_BASE_DELAY_MS * 2 ** safeAttempt
  );
  const jitter =
    exponentialDelay *
    LOCAL_RECONNECT_JITTER_FRACTION *
    (Math.min(1, Math.max(0, random())) * 2 - 1);
  return Math.min(LOCAL_RECONNECT_MAX_DELAY_MS, Math.max(0, Math.round(exponentialDelay + jitter)));
};

export const waitForLocalReconnectDelayEffect = (options: {
  attempt: number;
  random?: () => number;
  computeDelayMs?: (attempt: number, random?: () => number) => number;
}): Effect.Effect<number> => {
  const computeDelayMs = options.computeDelayMs ?? computeLocalReconnectDelayMs;
  const delayMs = computeDelayMs(options.attempt, options.random);

  return Effect.as(Clock.sleep(Duration.millis(delayMs)), delayMs);
};

type LocalReconnectLoopOptions = {
  canRun: () => boolean;
  hasProblem: () => boolean;
  /**
   * Reconcile callback. `force` is true for externally triggered runs
   * (visibility/online/token-refresh via `trigger()`): those may revive
   * connections whose failure is invisible to `hasProblem()`. Scheduled
   * retries pass `force: false` and should only touch known-unhealthy state.
   */
  reconnect: (context: {
    force: boolean;
    triggerReason?: LocalReconnectTriggerReason;
  }) => Promise<void>;
  onStateChange: () => void;
  onError?: (error: unknown) => void;
  computeDelayMs?: (attempt: number) => number;
  /**
   * Effect runtime used for the retry waits (Clock.sleep + fiber interrupt).
   * Production omits it (default runtime, live clock — compatible with vi
   * fake timers); tests inject a TestClock-backed runtime via
   * `Effect.runtime()` under `TestContext` for deterministic virtual time.
   */
  runtime?: Runtime.Runtime<never>;
};

export type LocalReconnectLoop = {
  isActive: () => boolean;
  update: () => void;
  trigger: (reason?: LocalReconnectTriggerReason) => void;
  stop: () => void;
};

/**
 * A pending retry wait. `settled` (not the fiber handle) is the source of
 * truth for cancellation/dedupe: under TestClock a zero-length sleep completes
 * synchronously inside runFork, i.e. before the fiber handle is even assigned,
 * so the continuation and cancelers consult the token instead of the fiber.
 */
type PendingWait = {
  fiber: Fiber.RuntimeFiber<void> | null;
  settled: boolean;
};

export function createLocalReconnectLoop(options: LocalReconnectLoopOptions): LocalReconnectLoop {
  const runFork = Runtime.runFork(options.runtime ?? Runtime.defaultRuntime);
  let pendingWait: PendingWait | null = null;
  let backoffResetWait: PendingWait | null = null;
  let retryAttempt = 0;
  let inFlight = false;
  let pendingForcedRun = false;
  let pendingTriggerReason: LocalReconnectTriggerReason | undefined;

  const computeDelayMs = options.computeDelayMs ?? computeLocalReconnectDelayMs;

  const recordPendingTrigger = (reason?: LocalReconnectTriggerReason) => {
    pendingForcedRun = true;
    if (!reason) {
      return;
    }
    // If multiple external edges arrive while a reconnect is already running,
    // prefer the wake/online reasons because they carry stronger transport
    // refresh semantics than a token-only refresh.
    if (pendingTriggerReason === 'visibility-wake' || pendingTriggerReason === 'network-online') {
      return;
    }
    pendingTriggerReason = reason;
  };

  const clearPendingTrigger = () => {
    pendingForcedRun = false;
    pendingTriggerReason = undefined;
  };

  const cancelPendingWait = () => {
    if (!pendingWait) {
      return;
    }
    const current = pendingWait;
    pendingWait = null;
    current.settled = true;
    if (current.fiber) {
      runFork(Fiber.interrupt(current.fiber));
    }
  };

  const cancelBackoffResetWait = () => {
    if (!backoffResetWait) {
      return;
    }
    const current = backoffResetWait;
    backoffResetWait = null;
    current.settled = true;
    if (current.fiber) {
      runFork(Fiber.interrupt(current.fiber));
    }
  };

  // Forgive accumulated backoff only after the problem stays cleared for a full
  // healthy dwell. Never restarted while already pending (frequent healthy
  // update() calls must not push the reset out indefinitely); cancelled the
  // moment a problem is observed again.
  const scheduleBackoffResetWait = () => {
    if (backoffResetWait || retryAttempt === 0) {
      return;
    }
    const current: PendingWait = { fiber: null, settled: false };
    backoffResetWait = current;
    const fiber = runFork(
      Effect.andThen(
        Clock.sleep(Duration.millis(LOCAL_RECONNECT_HEALTHY_RESET_MS)),
        Effect.sync(() => {
          if (current.settled) {
            return;
          }
          current.settled = true;
          if (backoffResetWait === current) {
            backoffResetWait = null;
          }
          if (!inFlight && !options.hasProblem()) {
            retryAttempt = 0;
          }
        })
      )
    );
    if (!current.settled) {
      current.fiber = fiber;
    }
  };

  const isActive = (): boolean => inFlight || pendingWait !== null;

  const update = () => {
    if (!options.canRun() || !options.hasProblem()) {
      cancelPendingWait();
      // No immediate forgiveness: a cleared problem may just be the transient
      // 'connecting' window of the reconnect we triggered. The dwell wait
      // resets the counter only if the problem stays away.
      if (!inFlight) {
        scheduleBackoffResetWait();
      }
      return;
    }

    cancelBackoffResetWait();
    if (pendingWait || inFlight) {
      return;
    }

    const delayMs = retryAttempt === 0 ? 0 : computeDelayMs(retryAttempt - 1);
    const current: PendingWait = { fiber: null, settled: false };
    pendingWait = current;
    const fiber = runFork(
      Effect.andThen(
        Clock.sleep(Duration.millis(delayMs)),
        Effect.sync(() => {
          if (current.settled) {
            return;
          }
          current.settled = true;
          if (pendingWait === current) {
            pendingWait = null;
          }
          void run(false);
        })
      )
    );
    if (!current.settled) {
      current.fiber = fiber;
    }
  };

  const run = async (force: boolean) => {
    if (!options.canRun()) {
      if (force) {
        clearPendingTrigger();
      }
      update();
      options.onStateChange();
      return;
    }
    if (!force && !options.hasProblem()) {
      update();
      options.onStateChange();
      return;
    }
    if (inFlight) {
      return;
    }

    const triggerReason = force ? pendingTriggerReason : undefined;
    if (force) {
      clearPendingTrigger();
    }

    const hadProblemAtStart = options.hasProblem();
    inFlight = true;
    options.onStateChange();
    try {
      await options.reconnect(triggerReason === undefined ? { force } : { force, triggerReason });
    } catch (error) {
      options.onError?.(error);
    } finally {
      inFlight = false;
      // An attempt against a problem always costs a backoff step, even when
      // hasProblem() reads false right now — the reconnect we just ran leaves
      // rooms in a transient 'connecting' window, and treating that as
      // recovery let a persistent failure retry with zero delay forever. Only
      // the healthy dwell (below) forgives the counter.
      if (hadProblemAtStart || options.hasProblem()) {
        retryAttempt += 1;
      }
      if (options.hasProblem()) {
        cancelBackoffResetWait();
      } else {
        scheduleBackoffResetWait();
      }
      if (pendingForcedRun) {
        void run(true);
      } else {
        update();
      }
      options.onStateChange();
    }
  };

  return {
    isActive,
    update,
    trigger: (reason) => {
      recordPendingTrigger(reason);
      cancelPendingWait();
      cancelBackoffResetWait();
      // A forced edge gets an immediate attempt, but it is still part of the
      // current outage. Only a sustained healthy dwell may forgive the retry
      // history; otherwise repeated token/online/visibility signals can pin a
      // broken connection to the first backoff step forever.
      void run(true);
    },
    stop: () => {
      clearPendingTrigger();
      cancelPendingWait();
      cancelBackoffResetWait();
      if (!inFlight) {
        retryAttempt = 0;
      }
    },
  };
}
