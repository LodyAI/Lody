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

type ActivePresenceState = {
  epoch: number;
  phase: SessionActivePresencePhase | null;
  detail: string | undefined;
  timer: NodeJS.Timeout;
  reportedSlowKeys: Set<string>;
  lastPhase: SessionActivePresencePhase | null | undefined;
  stageStartMs: number;
  lastActivePingAtMs: number;
};

type SessionActivePresenceOptions = {
  intervalMs?: number;
  slowThresholdMs?: number;
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

    const nowMs = Date.now();
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
    };
    state.timer.unref?.();
    this.active.set(sessionId, state);
    this.tick(sessionId, state.epoch);
  }

  setPhase(sessionId: SessionId, phase: SessionActivePresencePhase | null, detail?: string): void {
    const state = this.active.get(sessionId);
    if (!state) return;
    if (state.phase === phase && state.detail === detail) return;
    state.phase = phase;
    state.detail = detail;
    this.tick(sessionId, state.epoch);
  }

  clear(sessionId: SessionId): void {
    const state = this.active.get(sessionId);
    if (!state) return;
    clearInterval(state.timer);
    this.active.delete(sessionId);
    this.workspaceDocument.clearSessionPresence(sessionId);
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

    this.publish(sessionId, state);
    void this.updateMonitoring(sessionId, state).catch((error: unknown) => {
      this.logger.debug(
        `[${sessionId}] Session active presence monitoring failed: ${formatErrorMessage(error)}`
      );
    });
  }

  private publish(sessionId: SessionId, state: ActivePresenceState): void {
    const status = phaseToStatus(state.phase, state.detail);
    this.workspaceDocument.publishSessionPresence(sessionId, this.machineId, status);
  }

  private async updateMonitoring(sessionId: SessionId, state: ActivePresenceState): Promise<void> {
    const status = phaseToStatus(state.phase, state.detail);
    const nowMs = Date.now();

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

    const elapsedMs = Date.now() - state.stageStartMs;
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
