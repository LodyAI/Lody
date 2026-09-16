import {
  hashAnalyticsId,
  LODY_PRESENCE_HEARTBEAT_MS,
  SessionStatusFactory,
  type MachineId,
  type SessionId,
  type SessionStatus,
} from '@lody/shared';
import type { LoroDocumentManager } from './doc';
import type { Logger } from '@/utils/logger';
import { captureMessage, isErrorReportingEnabled } from '@/instrument';
import { formatErrorMessage } from '@/utils/format-error';
import { captureCli } from '../analytics/posthog';

// Minimum interval between `app/active_ping` emissions (spec §3.3: >= 60s).
// Mirrors ACTIVE_PING_MIN_INTERVAL_MS in commands/analytics-events.ts; kept local
// so this lib module does not depend on the commands layer.
const ACTIVE_PING_MIN_INTERVAL_MS = 60_000;
const DEFAULT_SLOW_THRESHOLD_MS = 120_000;

export type SessionActivePresencePhase =
  | 'thinking'
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
  epoch: number;
  phase: SessionActivePresencePhase | null;
  detail: string | undefined;
  timer: NodeJS.Timeout | null;
  reportedSlowKeys: Set<string>;
  lastPhase: SessionActivePresencePhase | null | undefined;
  stageStartMs: number;
  lastActivePingAtMs: number;
  /** Last time the published status actually changed; the stall clock's origin. */
  lastProgressMs: number;
  /** Latched once the watchdog fired, so a stall is reported exactly once. */
  stallReported: boolean;
};

type SessionActivePresenceOptions = {
  intervalMs?: number;
  slowThresholdMs?: number;
  /** Injected for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
  stallBudgetsMs?: Partial<Record<InitializingStageKey, number>>;
  /**
   * Invoked once when an initializing stage exceeds its budget. The owning turn
   * is expected to fail and release its scope, which is what clears presence —
   * this controller only stops the heartbeat (see {@link tick}).
   */
  onInitializationStalled?: (sessionId: SessionId, stall: SessionInitializationStall) => void;
};

const phaseToStatus = (
  phase: SessionActivePresencePhase | null,
  detail?: string
): SessionStatus => {
  switch (phase ?? 'thinking') {
    case 'thinking':
      return SessionStatusFactory.running();
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

/**
 * Owns CLI session active presence for this process.
 *
 * This is the only business-level module that publishes or clears session
 * presence. Other code may update durable SessionMeta.status or set a phase
 * here, but must not write presence directly.
 */
export class SessionActivePresenceController {
  private readonly active = new Map<SessionId, ActivePresenceState>();
  private nextEpoch = 1;

  constructor(
    private readonly workspaceDocument: LoroDocumentManager,
    private readonly machineId: MachineId,
    private readonly logger: Logger,
    private readonly options: SessionActivePresenceOptions = {}
  ) {}

  start(
    sessionId: SessionId,
    phase: SessionActivePresencePhase | null = 'thinking',
    detail?: string
  ): void {
    const existing = this.active.get(sessionId);
    if (existing) {
      this.setPhase(sessionId, phase, detail);
      return;
    }

    const nowMs = this.now();
    const state: ActivePresenceState = {
      epoch: this.nextEpoch++,
      phase,
      detail,
      timer: setInterval(() => {
        this.tick(sessionId, state.epoch);
      }, this.options.intervalMs ?? LODY_PRESENCE_HEARTBEAT_MS),
      reportedSlowKeys: new Set(),
      lastPhase: undefined,
      stageStartMs: nowMs,
      lastActivePingAtMs: nowMs,
      lastProgressMs: nowMs,
      stallReported: false,
    };
    state.timer?.unref?.();
    this.active.set(sessionId, state);
    this.tick(sessionId, state.epoch);
  }

  setPhase(sessionId: SessionId, phase: SessionActivePresencePhase | null, detail?: string): void {
    const state = this.active.get(sessionId);
    if (!state) return;
    if (state.phase === phase && state.detail === detail) return;
    state.phase = phase;
    state.detail = detail;
    // Any published change — including a `managed-runtime` download percent that
    // keeps the phase constant — is proof of progress and restarts the stall clock.
    state.lastProgressMs = this.now();
    this.tick(sessionId, state.epoch);
  }

  clear(sessionId: SessionId): void {
    const state = this.active.get(sessionId);
    if (!state) return;
    this.stopHeartbeat(state);
    this.active.delete(sessionId);
    this.workspaceDocument.clearSessionPresence(sessionId);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private stopHeartbeat(state: ActivePresenceState): void {
    if (!state.timer) return;
    clearInterval(state.timer);
    state.timer = null;
  }

  clearAll(): void {
    for (const sessionId of Array.from(this.active.keys())) {
      this.clear(sessionId);
    }
  }

  has(sessionId: SessionId): boolean {
    return this.active.has(sessionId);
  }

  getStatus(sessionId: SessionId): SessionStatus | null {
    const state = this.active.get(sessionId);
    return state ? phaseToStatus(state.phase, state.detail) : null;
  }

  activeSessionCount(): number {
    return this.active.size;
  }

  private tick(sessionId: SessionId, epoch: number): void {
    const state = this.active.get(sessionId);
    if (!state || state.epoch !== epoch) return;

    if (this.maybeReportInitializationStall(sessionId, state)) return;

    this.publish(sessionId, state);
    void this.updateMonitoring(sessionId, state).catch((error: unknown) => {
      this.logger.debug(
        `[${sessionId}] Session active presence monitoring failed: ${formatErrorMessage(error)}`
      );
    });
  }

  /**
   * Fail-stop for an initializing stage that stopped making progress.
   *
   * Returns true once the stall has been reported, which also suppresses this
   * and every later heartbeat: an unbounded `initializing` heartbeat keeps the
   * session pinned against GC (`MessageHandler.hasActiveTurn` reads active
   * presence) and wakes every presence subscriber every 10s for nothing. The
   * presence ENTRY is still removed by the owning turn's scope release, which is
   * the only writer allowed to clear it.
   */
  private maybeReportInitializationStall(
    sessionId: SessionId,
    state: ActivePresenceState
  ): boolean {
    if (state.stallReported) return true;
    const status = phaseToStatus(state.phase, state.detail);
    const stage = initializingStageKey(status);
    if (!stage) return false;

    const budgetMs =
      this.options.stallBudgetsMs?.[stage] ?? DEFAULT_INITIALIZING_STALL_BUDGETS_MS[stage];
    const stalledMs = this.now() - state.lastProgressMs;
    if (stalledMs < budgetMs) return false;

    state.stallReported = true;
    this.stopHeartbeat(state);

    const stall: SessionInitializationStall = {
      stage,
      description: describeStage(status),
      stalledMs,
      budgetMs,
    };
    this.logger.warn(
      `[${sessionId}] Session initialization stalled at "${stall.description}" for ${Math.round(
        stalledMs / 1000
      )}s (budget ${Math.round(budgetMs / 1000)}s); failing the turn`
    );
    this.options.onInitializationStalled?.(sessionId, stall);
    return true;
  }

  private publish(sessionId: SessionId, state: ActivePresenceState): void {
    const status = phaseToStatus(state.phase, state.detail);
    this.workspaceDocument.publishSessionPresence(sessionId, this.machineId, status);
  }

  private async updateMonitoring(sessionId: SessionId, state: ActivePresenceState): Promise<void> {
    const status = phaseToStatus(state.phase, state.detail);
    const nowMs = this.now();

    if (state.lastPhase !== state.phase) {
      state.lastPhase = state.phase;
      state.stageStartMs = nowMs;
    }

    this.maybeEmitActivePing(sessionId, state, status, nowMs);
    await this.maybeReportSlow(sessionId, state, status);
  }

  private maybeEmitActivePing(
    sessionId: SessionId,
    state: ActivePresenceState,
    status: SessionStatus,
    nowMs: number
  ): void {
    if (status.type !== 'running') return;
    if (nowMs - state.lastActivePingAtMs < ACTIVE_PING_MIN_INTERVAL_MS) return;
    state.lastActivePingAtMs = nowMs;
    captureCli(
      'app/active_ping',
      {
        active_context: 'session_turn',
        session_id_hash: hashAnalyticsId(sessionId),
      },
      { tier: 'C' }
    );
  }

  private async maybeReportSlow(
    sessionId: SessionId,
    state: ActivePresenceState,
    status: SessionStatus
  ): Promise<void> {
    if (status.type !== 'initializing') return;

    const elapsedMs = this.now() - state.stageStartMs;
    const thresholdMs = this.options.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
    if (elapsedMs < thresholdMs) return;

    const stageKey = status.stage ?? 'unknown';
    const key = `${sessionId}:${stageKey}`;
    if (state.reportedSlowKeys.has(key)) return;
    state.reportedSlowKeys.add(key);

    const stage = describeStage(status);
    const message = `Pre-agent stage exceeded ${Math.round(thresholdMs / 1000)}s: ${stage}`;
    this.logger.debug(`[${sessionId}] ${message}`);

    if (isErrorReportingEnabled()) {
      await captureMessage(message, {
        component: 'session_active_presence',
        level: 'error',
        extra: {
          sessionId,
          status,
          elapsedMs,
          thresholdMs,
        },
      });
    }
  }
}
