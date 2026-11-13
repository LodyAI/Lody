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
  /** Check whether the expected user turn is present. */
  hasUserTurn?: (turnId: string) => Promise<boolean>;
  /** History source used when hasUserTurn is absent. */
  readHistory?: () => Promise<SessionHistoryInput[]>;
  /** Subscribe to local doc changes (remote imports included); returns unsubscribe. */
  subscribeHistory: (listener: () => void) => (() => void) | undefined;
  /**
   * Runs exactly once, right before waiters are released (skipped on dispose).
   * Used to create the turn's assistant entry so every gated writer resumes
   * against an existing, correctly-ordered entry. Errors are logged. The original
   * deadline releases waiters even if this callback never returns, but lets it
   * finish adding author/model metadata while the turn is live. Only disposal
   * aborts later callback steps; it cannot undo an already-issued write.
   */
  onBeforeOpen?: (reason: TurnHistoryGateOpenReason, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
};

/**
 * Bounded wait for the user turn entry to sync. Opening early lets a concurrent
 * Loro insert order the reply before the user message permanently (#1753); a
 * longer wait holds the turn's visible output and finalization. One minute
 * covers reconnect-length sync stalls while keeping a stuck turn short.
 * Roost sessions are unaffected: the owner appends the user turn itself.
 */
export const DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS = 60_000;

export class TurnHistoryGate {
  private readonly beforeOpenAbort = new AbortController();
  private phase: 'waiting' | 'opening' | 'open' = 'waiting';
  private readonly opened: Promise<void>;
  private releaseWaiters: () => void = () => {};
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checking = false;
  private recheckRequested = false;
  private readonly createdAtMs = Date.now();

  private constructor(private readonly args: TurnHistoryGateArgs | null) {
    if (!args) {
      this.phase = 'open';
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
    try {
      this.unsubscribe = args.subscribeHistory(() => this.scheduleCheck());
    } catch (error) {
      this.log('debug', `Turn history subscription failed: ${formatErrorMessage(error)}`);
    }
    if (!this.unsubscribe) {
      this.log('debug', 'Turn history gate has no doc subscription; relying on timeout');
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
    return this.phase === 'open';
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
    // Timeout may already have opened the gate while its callback is pending.
    this.beforeOpenAbort.abort();
    void this.openGate('disposed');
  }

  /** Serialized, coalescing presence check — one read at a time per gate. */
  private scheduleCheck(): void {
    const args = this.args;
    if (this.phase !== 'waiting' || !args) {
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
          if (this.phase !== 'waiting') {
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
        this.log('debug', `Turn history gate check failed: ${formatErrorMessage(error)}`);
      } finally {
        this.checking = false;
      }
    })();
  }

  /** Diagnostics are best effort; a broken sink cannot hold a conversation. */
  private log(level: 'debug' | 'warn' | 'error', message: string): void {
    try {
      this.args?.logger[level](`[${this.args.sessionId}] ${message}`);
    } catch {
      // The gate's deadline and release remain authoritative if logging fails.
    }
  }

  private detachHistory(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    try {
      unsubscribe?.();
    } catch (error) {
      this.log('debug', `Turn history unsubscribe failed: ${formatErrorMessage(error)}`);
    }
  }

  private release(): void {
    if (this.phase === 'open') return;
    this.phase = 'open';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.detachHistory();
    this.releaseWaiters();
  }

  private async openGate(reason: TurnHistoryGateOpenReason): Promise<void> {
    if (this.phase === 'open') return;
    if (reason === 'disposed') {
      this.release();
      return;
    }
    if (reason === 'timeout') {
      this.log(
        'warn',
        `Turn history deadline reached after ${Date.now() - this.createdAtMs}ms; releasing writes even if the user entry or its assistant-entry write is still pending`
      );
    }
    if (this.phase === 'opening') {
      if (reason === 'timeout') this.release();
      return;
    }
    this.phase = 'opening';
    this.detachHistory();
    try {
      this.log('debug', `Turn history gate opening (${reason})`);
      const beforeOpen = this.args?.onBeforeOpen?.(reason, this.beforeOpenAbort.signal);
      // The original deadline covers the callback too. At the deadline start
      // its best-effort write, observe its outcome, and release without awaiting it.
      if (reason === 'timeout') this.release();
      await beforeOpen;
    } catch (error) {
      this.log('error', `Turn history gate onBeforeOpen failed: ${formatErrorMessage(error)}`);
    } finally {
      // Late completion belongs only to this gate, never to its successor.
      this.release();
    }
  }
}
