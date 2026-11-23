import { Cause, Clock, Effect, Exit, Scope } from 'effect';
import { hashAnalyticsId, type MachineId, type SessionId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { captureMessage, isErrorReportingEnabled } from '@/instrument';
import { formatErrorMessage } from '@/utils/format-error';
import { captureCli } from '../analytics/posthog';
import type { LoroDocumentManager } from './doc';
import {
  makeSessionActivePresence,
  SessionPresenceHost,
  SessionPresenceUnavailable,
  type SessionActivePresenceOptions,
  type SessionActivePresencePhase,
  type SessionActivePresenceService,
  type SessionPresenceDiagnostic,
} from './session-active-presence';

export class SessionPresenceLegacyFailure extends Error {
  constructor(readonly effectCause: Cause.Cause<unknown>) {
    super('Session presence release failed');
    this.name = 'SessionPresenceLegacyFailure';
  }
}

/** @deprecated MessageHandler execution/observability entry. Remove when its owner is native.
 * Visible Turns compose `hold` directly; synchronous callbacks only update that lease.
 */
export class SessionActivePresenceControllerLegacy {
  private readonly scope = Effect.runSync(Scope.make());
  private readonly legacyScopes = new Map<SessionId, Scope.Closeable>();
  private readonly monitoring = new Set<Promise<void>>();
  private closing?: Promise<void>;
  readonly native: SessionActivePresenceService;

  constructor(
    workspaceDocument: Pick<LoroDocumentManager, 'publishSessionPresence' | 'clearSessionPresence'>,
    machineId: MachineId,
    private readonly logger: Logger,
    options: SessionActivePresenceOptions & {
      now?: () => number;
    } = {}
  ) {
    const host = SessionPresenceHost.of({
      publish: (id, status) => workspaceDocument.publishSessionPresence(id, machineId, status),
      clear: (id) => workspaceDocument.clearSessionPresence(id),
      report: (event) => this.report(event),
    });
    const program = Scope.provide(makeSessionActivePresence(options), this.scope).pipe(
      Effect.provideService(SessionPresenceHost, host)
    );
    // The injected clock preserves existing deterministic Legacy integration fixtures.
    this.native = Effect.runSync(
      options.now
        ? Effect.flatMap(Clock.Clock, (clock) =>
            program.pipe(
              Effect.provideService(Clock.Clock, {
                monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
                monotonicTimeNanos: clock.monotonicTimeNanos,
                currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
                currentTimeNanos: clock.currentTimeNanos,
                sleep: (duration) => clock.sleep(duration),
                currentTimeMillisUnsafe: options.now ?? clock.currentTimeMillisUnsafe,
                currentTimeMillis: Effect.sync(options.now ?? clock.currentTimeMillisUnsafe),
              })
            )
          )
        : program
    );
  }

  /** @deprecated Only pre-migration entries and test harnesses acquire an imperative lease. */
  start(
    sessionId: SessionId,
    phase: SessionActivePresencePhase | null = 'thinking',
    detail?: string
  ): void {
    if (this.legacyScopes.has(sessionId)) {
      this.setPhase(sessionId, phase, detail);
      return;
    }
    const scope = Effect.runSync(Scope.make());
    try {
      Effect.runSync(Scope.provide(this.native.hold(sessionId, phase, detail), scope));
      this.legacyScopes.set(sessionId, scope);
    } catch (error) {
      Effect.runSync(Scope.close(scope, Exit.void));
      throw error;
    }
  }

  /** An exit/archive/GC callback cannot release a visible Turn's native lease. */
  clearUnleased(sessionId: SessionId): void {
    const scope = this.legacyScopes.get(sessionId);
    if (!scope) return;
    Effect.runSync(Scope.close(scope, Exit.void));
    this.legacyScopes.delete(sessionId);
  }

  clearAllUnleased(): void {
    for (const sessionId of this.legacyScopes.keys()) this.clearUnleased(sessionId);
  }

  setPhase(sessionId: SessionId, phase: SessionActivePresencePhase | null, detail?: string): void {
    this.native.setPhase(sessionId, phase, detail);
  }
  has(sessionId: SessionId): boolean {
    return this.native.has(sessionId);
  }
  getStatus(sessionId: SessionId) {
    return this.native.getStatus(sessionId);
  }
  activeSessionCount(): number {
    return this.native.activeSessionCount();
  }

  /** Concurrent close joins one receipt. Timeout keeps the original leases/monitoring owner. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.native.retire();
    this.clearAllUnleased();
    const program = Effect.gen({ self: this }, function* () {
      yield* this.native.awaitIdle(5_000);
      yield* Effect.promise(() => Promise.all(this.monitoring)).pipe(
        Effect.timeoutOrElse({
          duration: 5_000,
          orElse: () => Effect.fail(new SessionPresenceUnavailable({ reason: 'release-pending' })),
        })
      );
      yield* Scope.close(this.scope, Exit.void);
    });
    this.closing = Effect.runPromiseExit(program).then((exit) => {
      if (Exit.isFailure(exit)) {
        this.closing = undefined;
        throw new SessionPresenceLegacyFailure(exit.cause);
      }
    });
    return this.closing;
  }

  private report(event: SessionPresenceDiagnostic): void {
    const sessionId = event.sessionId;
    switch (event.kind) {
      case 'stall':
        this.logger.warn(
          `[${sessionId}] Session initialization stalled at "${event.stall.description}" for ${Math.round(event.stall.stalledMs / 1000)}s (budget ${Math.round(event.stall.budgetMs / 1000)}s); failing the turn`
        );
        break;
      case 'active-ping':
        captureCli(
          'app/active_ping',
          { active_context: 'session_turn', session_id_hash: hashAnalyticsId(sessionId) },
          { tier: 'C' }
        );
        break;
      case 'slow': {
        this.logger.debug(`[${sessionId}] ${event.message}`);
        if (!isErrorReportingEnabled()) return;
        // Existing analytics orchestration stays explicitly Legacy. Retain its actual Promise.
        const pending = captureMessage(event.message, {
          component: 'session_active_presence',
          level: 'error',
          extra: {
            sessionId,
            status: event.status,
            elapsedMs: event.elapsedMs,
            thresholdMs: event.thresholdMs,
          },
        }).catch((error: unknown) => {
          this.logger.debug(
            `[${sessionId}] Session active presence monitoring failed: ${formatErrorMessage(error)}`
          );
        });
        this.monitoring.add(pending);
        void pending.then(() => this.monitoring.delete(pending));
        break;
      }
      case 'heartbeat-failed':
        this.logger.debug(`[${sessionId}] Session active presence heartbeat failed`);
        break;
    }
  }
}
