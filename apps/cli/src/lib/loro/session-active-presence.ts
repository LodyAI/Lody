import {
  LODY_PRESENCE_HEARTBEAT_MS,
  SessionStatusFactory,
  type SessionId,
  type SessionStatus,
} from '@lody/shared';
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Schedule,
  Scope,
} from 'effect';

// Minimum interval between `app/active_ping` emissions (spec §3.3: >= 60s).
// Mirrors ACTIVE_PING_MIN_INTERVAL_MS in commands/analytics-events.ts; kept local
// so this lib module does not depend on the commands layer.
const ACTIVE_PING_MIN_INTERVAL_MS = 60_000;
const DEFAULT_SLOW_THRESHOLD_MS = 120_000;

export type SessionActivePresencePhase =
  | 'thinking'
  | 'finalizing'
  | 'initializing'
  | 'git-clone'
  | 'managed-runtime'
  | 'acp'
  | 'resuming'
  | 'requestPermission'
  | 'image_generation';

/**
 * Per-stage budgets for the initialization stall watchdog, measured from the
 * last OBSERVABLE PROGRESS (the last phase-or-detail change), not from turn
 * start. Stages that report progress — `managed-runtime` emits download percent
 * through `formatManagedRuntimeProgressDetail` — therefore get unlimited
 * legitimate wall-clock time and only trip when the transfer goes silent.
 *
 * Budgets are derived from 923 initializations observed over a week of local
 * daemon logs (p50 0s, p90 4s, p99 13s; see the owning Agent Note):
 *
 * - `initializing` (no stage) is control-plane bookkeeping whose only
 *   intentionally-slow dependency is the user-profile query, itself bounded at
 *   `USER_PROFILE_TIMEOUT_MS` (60s). 180s is 3x that deadline, comfortably above
 *   the worst healthy observation (70s, during a cloud reconnect storm).
 * - `acp`/`resuming` spawn and hand-shake the agent process with no progress
 *   signal. The worst healthy observation was a 249s cold `codex-acp` start, so
 *   900s leaves ~3.6x headroom.
 * - `git-clone` has no progress signal AND unbounded input (arbitrary repo size
 *   over an arbitrary link). Its bound exists only to end a wedged transfer.
 */
const DEFAULT_INITIALIZING_STALL_BUDGETS_MS = {
  initializing: 180_000,
  acp: 900_000,
  resuming: 900_000,
  'managed-runtime': 900_000,
  'git-clone': 1_800_000,
} as const satisfies Record<InitializingStageKey, number>;

/** `SessionStatus.stage` for an initializing status, or `initializing` when absent. */
type InitializingStageKey = 'initializing' | 'git-clone' | 'managed-runtime' | 'acp' | 'resuming';

export type SessionInitializationStall = {
  /** The initializing stage that stopped making progress. */
  stage: InitializingStageKey;
  /** Human-readable stage description, reused verbatim in the user-visible failure. */
  description: string;
  /** Milliseconds since the last phase-or-detail change. */
  stalledMs: number;
  /** Budget that was exceeded. */
  budgetMs: number;
};

type ActivePresenceState = {
  stall: Deferred.Deferred<SessionInitializationStall>;
  phase: SessionActivePresencePhase | null;
  detail: string | undefined;
  closing: boolean;
  close: Effect.Effect<void>;
  failure?: Cause.Cause<never>;
  reportedSlowKeys: Set<string>;
  lastPhase: SessionActivePresencePhase | null | undefined;
  stageStartMs: number;
  lastActivePingAtMs: number;
  /** Last time the published status actually changed; the stall clock's origin. */
  lastProgressMs: number;
  /** Latched once the watchdog fired, so a stall is reported exactly once. */
  stallReported: boolean;
};

export type SessionActivePresenceOptions = {
  intervalMs?: number;
  slowThresholdMs?: number;
  stallBudgetsMs?: Partial<Record<InitializingStageKey, number>>;
};

const phaseToStatus = (
  phase: SessionActivePresencePhase | null,
  detail?: string
): SessionStatus => {
  switch (phase ?? 'thinking') {
    case 'thinking':
      return SessionStatusFactory.running();
    case 'finalizing':
      // One lifecycle value. No detail: a changing detail republishes every call.
      return { type: 'running', phase: 'finalizing' };
    case 'initializing':
      return SessionStatusFactory.initializing(undefined, detail);
    case 'git-clone':
      return SessionStatusFactory.initializing('git-clone', detail);
    case 'managed-runtime':
      return SessionStatusFactory.initializing('managed-runtime', detail);
    case 'acp':
      return SessionStatusFactory.initializing('acp', detail);
    case 'resuming':
      return SessionStatusFactory.initializing('resuming', detail);
    case 'requestPermission':
      return SessionStatusFactory.requestPermission();
    case 'image_generation':
      return SessionStatusFactory.running('image_generation');
  }
  return SessionStatusFactory.running();
};

const describeStage = (status: SessionStatus): string => {
  switch (status.type) {
    case 'initializing':
      if (status.stage) {
        switch (status.stage) {
          case 'git-clone':
            return `cloning ${status.detail ?? 'repository'}`;
          case 'managed-runtime':
            return status.detail ?? 'downloading managed agent runtime';
          case 'acp':
            return `initializing ${status.detail ?? 'the ACP agent'}`;
          case 'resuming':
            return 'resuming session';
        }
      }
      return 'initializing';
    case 'running':
      return 'processing';
    case 'requestPermission':
      return 'waiting for permission';
    case 'idle':
      return 'idle';
  }
  return 'unknown';
};

/** Stage key for the stall watchdog, or null when the status is not initializing. */
const initializingStageKey = (status: SessionStatus): InitializingStageKey | null =>
  status.type === 'initializing' ? (status.stage ?? 'initializing') : null;

export type SessionPresenceDiagnostic =
  | { readonly kind: 'active-ping'; readonly sessionId: SessionId }
  | {
      readonly kind: 'slow';
      readonly sessionId: SessionId;
      readonly status: SessionStatus;
      readonly elapsedMs: number;
      readonly thresholdMs: number;
      readonly message: string;
    }
  | {
      readonly kind: 'stall';
      readonly sessionId: SessionId;
      readonly stall: SessionInitializationStall;
    }
  | {
      readonly kind: 'heartbeat-failed';
      readonly sessionId: SessionId;
      readonly cause: Cause.Cause<never>;
    };

/** Synchronous local-origin publication and diagnostic admission, with no remote flush. */
export class SessionPresenceHost extends Context.Service<
  SessionPresenceHost,
  {
    readonly publish: (sessionId: SessionId, status: SessionStatus) => void;
    readonly clear: (sessionId: SessionId) => void;
    readonly report: (event: SessionPresenceDiagnostic) => void;
  }
>()('lody/loro/SessionPresenceHost') {}

export class SessionPresenceUnavailable extends Data.TaggedError('SessionPresenceUnavailable')<{
  readonly sessionId?: SessionId;
  readonly reason: 'closed' | 'already-held' | 'release-pending';
}> {}

export interface SessionActivePresenceLease {
  readonly awaitInitializationStall: Effect.Effect<SessionInitializationStall>;
}

export interface SessionActivePresenceService {
  readonly hold: (
    sessionId: SessionId,
    phase?: SessionActivePresencePhase | null,
    detail?: string
  ) => Effect.Effect<SessionActivePresenceLease, SessionPresenceUnavailable, Scope.Scope>;
  readonly setPhase: (
    sessionId: SessionId,
    phase: SessionActivePresencePhase | null,
    detail?: string
  ) => void;
  readonly has: (sessionId: SessionId) => boolean;
  readonly getStatus: (sessionId: SessionId) => SessionStatus | null;
  readonly activeSessionCount: () => number;
  /** Failed clear retains the generation and Cause. Retry never closes the old Scope twice. */
  readonly retryRelease: (sessionId: SessionId) => Effect.Effect<void>;
  /** Waits only for leases; timeout retains their original owners and blocks teardown. */
  readonly awaitIdle: (timeoutMs: number) => Effect.Effect<void, SessionPresenceUnavailable>;
  readonly retire: () => void;
}

export class SessionActivePresence extends Context.Service<
  SessionActivePresence,
  SessionActivePresenceService
>()('lody/loro/SessionActivePresence') {}

export const makeSessionActivePresence = (options: SessionActivePresenceOptions = {}) =>
  Effect.gen(function* () {
    const host = yield* SessionPresenceHost;
    const clock = yield* Clock.Clock;
    const parent = yield* Scope.Scope;
    const active = new Map<SessionId, ActivePresenceState>();
    let idle = yield* Deferred.make<void>();
    yield* Deferred.succeed(idle, undefined);
    let retired = false;
    const now = () => clock.currentTimeMillisUnsafe();

    const tick = (sessionId: SessionId, state: ActivePresenceState): void => {
      if (active.get(sessionId) !== state || state.closing || state.stallReported) return;
      const status = phaseToStatus(state.phase, state.detail);
      const nowMs = now();
      const stage = initializingStageKey(status);
      const budgetMs = stage
        ? (options.stallBudgetsMs?.[stage] ?? DEFAULT_INITIALIZING_STALL_BUDGETS_MS[stage])
        : 0;
      const stalledMs = nowMs - state.lastProgressMs;
      if (stage && stalledMs >= budgetMs) {
        state.stallReported = true;
        const stall = { stage, description: describeStage(status), stalledMs, budgetMs };
        Deferred.doneUnsafe(state.stall, Effect.succeed(stall));
        host.report({ kind: 'stall', sessionId, stall });
        return;
      }
      host.publish(sessionId, status);
      if (state.lastPhase !== state.phase) {
        state.lastPhase = state.phase;
        state.stageStartMs = nowMs;
      }
      if (
        status.type === 'running' &&
        nowMs - state.lastActivePingAtMs >= ACTIVE_PING_MIN_INTERVAL_MS
      ) {
        state.lastActivePingAtMs = nowMs;
        host.report({ kind: 'active-ping', sessionId });
      }
      if (status.type === 'initializing') {
        const elapsedMs = nowMs - state.stageStartMs;
        const thresholdMs = options.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
        const key = status.stage ?? 'unknown';
        if (elapsedMs >= thresholdMs && !state.reportedSlowKeys.has(key)) {
          state.reportedSlowKeys.add(key);
          host.report({
            kind: 'slow',
            sessionId,
            status,
            elapsedMs,
            thresholdMs,
            message: `Pre-agent stage exceeded ${Math.round(thresholdMs / 1000)}s: ${describeStage(status)}`,
          });
        }
      }
    };

    const clear = (sessionId: SessionId, state: ActivePresenceState) =>
      Effect.sync(() => {
        if (active.get(sessionId) !== state) return;
        host.clear(sessionId);
        active.delete(sessionId);
        if (active.size === 0) Deferred.doneUnsafe(idle, Effect.void);
      });

    const hold = Effect.fnUntraced(function* (
      sessionId: SessionId,
      phase: SessionActivePresencePhase | null = 'thinking',
      detail?: string
    ): Effect.fn.Return<SessionActivePresenceLease, SessionPresenceUnavailable, Scope.Scope> {
      // Admission and finalizer registration share acquireRelease's interrupt mask.
      const leaseState = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          if (retired)
            return yield* new SessionPresenceUnavailable({ sessionId, reason: 'closed' });
          if (active.has(sessionId))
            return yield* new SessionPresenceUnavailable({ sessionId, reason: 'already-held' });
          const scope = yield* Scope.fork(parent);
          const nowMs = now();
          const state: ActivePresenceState = {
            stall: yield* Deferred.make<SessionInitializationStall>(),
            phase,
            detail,
            closing: false,
            close: Effect.void,
            reportedSlowKeys: new Set(),
            lastPhase: undefined,
            stageStartMs: nowMs,
            lastActivePingAtMs: nowMs,
            lastProgressMs: nowMs,
            stallReported: false,
          };
          if (active.size === 0) idle = Deferred.makeUnsafe<void>();
          active.set(sessionId, state);
          yield* Scope.addFinalizer(
            scope,
            clear(sessionId, state).pipe(
              Effect.catchCause((cause) => {
                state.failure = cause;
                return Effect.failCause(cause);
              })
            )
          );
          state.close = yield* Effect.cached(
            Effect.gen(function* () {
              state.closing = true;
              yield* Scope.close(scope, Exit.void);
            })
          );
          // First publication is synchronous; subsequent ticks belong to the lease.
          yield* Effect.forkIn(
            Effect.sync(() => tick(sessionId, state)).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => host.report({ kind: 'heartbeat-failed', sessionId, cause }))
              ),
              Effect.repeat({
                schedule: Schedule.spaced(options.intervalMs ?? LODY_PRESENCE_HEARTBEAT_MS),
                while: () => !state.stallReported && !state.closing,
              }),
              Effect.asVoid,
              Effect.delay(options.intervalMs ?? LODY_PRESENCE_HEARTBEAT_MS)
            ),
            scope,
            { startImmediately: true, uninterruptible: false }
          );
          return state;
        }),
        (acquired) => acquired.close
      );
      yield* Effect.sync(() => tick(sessionId, leaseState));
      return { awaitInitializationStall: Deferred.await(leaseState.stall) };
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        retired = true;
      })
    );
    return SessionActivePresence.of({
      hold,
      setPhase: (sessionId, phase, detail) => {
        const state = active.get(sessionId);
        if (
          !state ||
          state.closing ||
          state.stallReported ||
          (state.phase === phase && state.detail === detail)
        )
          return;
        state.phase = phase;
        state.detail = detail;
        state.lastProgressMs = now();
        tick(sessionId, state);
      },
      has: (sessionId) => active.has(sessionId),
      getStatus: (sessionId) => {
        const state = active.get(sessionId);
        return state ? phaseToStatus(state.phase, state.detail) : null;
      },
      activeSessionCount: () => active.size,
      retire: () => {
        retired = true;
      },
      retryRelease: (sessionId) =>
        Effect.suspend(() => {
          const state = active.get(sessionId);
          return state?.failure ? clear(sessionId, state) : Effect.void;
        }),
      awaitIdle: (timeoutMs) =>
        Effect.suspend(() => Deferred.await(idle)).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.fail(new SessionPresenceUnavailable({ reason: 'release-pending' })),
          })
        ),
    });
  });

export const SessionActivePresenceLive = (options?: SessionActivePresenceOptions) =>
  Layer.effect(SessionActivePresence, makeSessionActivePresence(options));
