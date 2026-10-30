import type { SessionHistoryInput, SessionId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

/**
 * TurnHistoryGate — ordering barrier for RPC fast-path turn output.
 *
 * ## Problem
 *
 * `session/dispatch-turn` (the chat fast path) pushes the full turn payload over
 * Machine RPC so the CLI can start the agent before the session-doc history CRDT
 * syncs. The user's history entry is written by the web client into ITS replica;
 * the CLI never writes that entry itself. If the CLI persists turn output (the
 * assistant entry and streamed ACP content) while the user entry has not synced
 * here yet, the two list insertions are CONCURRENT at the same anchor, and the
 * Loro merge tiebreak can permanently order the agent's reply BEFORE the user's
 * message on every device.
 *
 * ## Contract
 *
 * - Agent execution starts immediately (the fast path's latency win is kept).
 * - Turn-scoped history LIST writes (assistant entry creation, ACP update
 *   flushes, finalization, failure notices) wait until the user turn entry is
 *   visible in the CLI-local history doc, so they are causally ordered after it.
 * - The wait is bounded: after `timeoutMs` the gate opens anyway (degrades to
 *   the pre-gate behavior — possible misorder — instead of holding output
 *   hostage to a broken uplink). A timeout implies the web→CLI doc sync is
 *   stalled, in which case that client cannot see our output either way.
 * - Metadata/status writes are NOT gated: they are map-keyed (no list-order
 *   race) and some sit on the prompt-start critical path.
 *
 * Turns whose payload arrived via the history CRDT or the message queue never
 * need a gate — their user entry is already local by construction.
 */

export type TurnHistoryGateOpenReason = 'user-turn-synced' | 'timeout' | 'disposed';

export type TurnHistoryGateArgs = {
  logger: Logger;
  sessionId: SessionId;
  userTurnId: string;
  /** Check the selected identity without materializing the transcript. */
  hasUserTurn?: (turnId: string) => Promise<boolean>;
  /** Compatibility for existing gate owners. */
  readHistory?: () => Promise<SessionHistoryInput[]>;
  /** Subscribe to local doc changes (remote imports included); returns unsubscribe. */
  subscribeHistory: (listener: () => void) => (() => void) | undefined;
  /**
   * Runs exactly once, right before waiters are released (skipped on dispose).
   * Used to create the turn's assistant entry so every gated writer resumes
   * against an existing, correctly-ordered entry. Errors are logged and do not
   * keep the gate closed — downstream flushes self-create the entry by id.
   */
  onBeforeOpen?: (reason: TurnHistoryGateOpenReason) => Promise<void>;
  timeoutMs?: number;
};

/**
 * Bounded wait for the user turn entry to sync. Doc sync and Machine RPC both
 * ride Loro Streams, so "RPC delivered but the entry never syncs" implies a
 * degraded transport; 20s covers slow room join + catch-up without making a
 * genuinely broken uplink freeze turn output forever.
 */
export const DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS = 20_000;

export class TurnHistoryGate {
  private open = false;
  private readonly opened: Promise<void>;
  private releaseWaiters: () => void = () => {};
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checking = false;
  private recheckRequested = false;
  private readonly createdAtMs = Date.now();

  private constructor(private readonly args: TurnHistoryGateArgs | null) {
    if (!args) {
      this.open = true;
      this.opened = Promise.resolve();
      return;
    }
    this.opened = new Promise<void>((resolve) => {
      this.releaseWaiters = resolve;
    });
    const timeoutMs = args.timeoutMs ?? DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.openGate('timeout');
    }, timeoutMs);
    this.timer.unref?.();
    this.unsubscribe = args.subscribeHistory(() => this.scheduleCheck());
    if (!this.unsubscribe) {
      args.logger.debug(
        `[${args.sessionId}] Turn history gate has no doc subscription; relying on timeout`
      );
    }
    this.scheduleCheck();
  }

  /** Gate that is already open (turn payload came from local history / queue). */
  static alreadyOpen(): TurnHistoryGate {
    return new TurnHistoryGate(null);
  }

  /** Gate that opens once the user turn entry is present locally (or on timeout). */
  static waitForUserTurn(args: TurnHistoryGateArgs): TurnHistoryGate {
    return new TurnHistoryGate(args);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Resolves when turn-scoped history writes may proceed. Never rejects. */
  waitUntilOpen(): Promise<void> {
    return this.opened;
  }

  /**
   * Release waiters without running `onBeforeOpen` (turn teardown / session
   * eviction). Late flushes self-create the assistant entry when needed.
   */
  dispose(): void {
    void this.openGate('disposed');
  }

  /** Serialized, coalescing presence check — one read at a time per gate. */
  private scheduleCheck(): void {
    const args = this.args;
    if (this.open || !args) {
      return;
    }
    if (this.checking) {
      this.recheckRequested = true;
      return;
    }
    this.checking = true;
    void (async () => {
      try {
        do {
          this.recheckRequested = false;
          if (this.open) {
            return;
          }
          const present = args.hasUserTurn
            ? await args.hasUserTurn(args.userTurnId)
            : (await args.readHistory!()).some(
                (entry) => entry.role === 'user' && entry.id === args.userTurnId
              );
          if (present) {
            await this.openGate('user-turn-synced');
            return;
          }
        } while (this.recheckRequested);
      } catch (error) {
        args.logger.debug(
          `[${args.sessionId}] Turn history gate check failed: ${formatErrorMessage(error)}`
        );
      } finally {
        this.checking = false;
      }
    })();
  }

  private async openGate(reason: TurnHistoryGateOpenReason): Promise<void> {
    if (this.open) {
      return;
    }
    this.open = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    const args = this.args;
    if (args) {
      const waitedMs = Date.now() - this.createdAtMs;
      if (reason === 'timeout') {
        args.logger.warn(
          `[${args.sessionId}] User turn ${args.userTurnId} did not sync within ${waitedMs}ms; releasing turn history writes (output may order before the user message)`
        );
      } else {
        args.logger.debug(
          `[${args.sessionId}] Turn history gate opened (${reason}) after ${waitedMs}ms`
        );
      }
      if (reason !== 'disposed' && args.onBeforeOpen) {
        try {
          await args.onBeforeOpen(reason);
        } catch (error) {
          args.logger.error(
            `[${args.sessionId}] Turn history gate onBeforeOpen failed: ${formatErrorMessage(error)}`
          );
        }
      }
    }
    this.releaseWaiters();
  }
}
