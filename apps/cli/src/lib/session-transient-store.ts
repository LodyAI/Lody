/**
 * SessionTransientStore — single source of truth for all per-session in-memory state.
 *
 * ## Why This Exists
 *
 * Previously, MessageHandler maintained 15+ independent `Map<SessionId, ...>` fields
 * for buffering ACP updates, tracking conversation turns, etc.
 * Every cleanup path (turn end, idle shutdown, GC sweep) had to manually enumerate
 * which Maps to clear. Missing any Map in any path was a silent memory/process leak.
 *
 * This module aggregates all per-session transient state into a single `SessionState`
 * value per session. Cleanup becomes calling one of two methods:
 *
 * - `clearTurnState(id)` — after a conversation turn completes
 * - `deleteSession(id)` — when the session is evicted (idle shutdown or GC)
 *
 * It is impossible to "forget" a field because adding a new field to `SessionState`
 * automatically includes it in both cleanup paths.
 *
 * ## Turn State Model
 *
 * The previous code tracked `turnId` and `activeTurnId` as two independent Maps,
 * even though they represent phases of the same concept:
 *
 *   beginConversationTurn → sets turnId/activeTurnId
 *   prompt() starts       → turn begins owning ACP update routing
 *   prompt() returns      → clears activeTurnId (prompt no longer cancellable)
 *   finalizeTurn          → clears turnId (turn fully done)
 *
 * This module replaces them with a single `TurnPhase` discriminated union:
 *
 *   'idle'       — no active turn
 *   'prompting'  — turn started, prompt in flight (cancellable)
 *   'finalizing' — prompt returned, post-processing in progress
 *
 * The turn ID is available in both 'prompting' and 'finalizing' phases.
 * Cancellation is only possible during 'prompting'.
 */

import {
  getServerNow,
  type AcpSessionNotification,
  type MessageContent,
  type SessionContextWindowUsage,
  type SessionId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { TurnHistoryGate } from '@/session/turn-history-gate';

type AssistantTurnACPUpdateTargetSource = 'active_turn' | 'finalized_turn';

export type AssistantTurnACPUpdateTarget = {
  kind: 'assistant_entry';
  assistantEntryId: string;
  turnId: string;
  turnEpoch: number;
  source: AssistantTurnACPUpdateTargetSource;
  userTurnId?: string;
  finalizedAtMs?: number;
};

export type ACPUpdateTarget = AssistantTurnACPUpdateTarget;

/**
 * Identity of one turn. Carried by finalizers as a compare-and-set token so a
 * commit can be refused when the turn it names is no longer the current one.
 */
export type TurnRef = {
  turnId: string;
  turnEpoch: number;
  assistantEntryId: string;
};

export type BufferedACPUpdate = {
  notification: AcpSessionNotification;
  target: ACPUpdateTarget;
  /**
   * Rich content is uploaded/materialized before its history write. Preserve
   * that result across a failed doc write so retries do not create orphaned
   * uploads with a new file id.
   */
  materializedContents?: MessageContent[];
};

// ---------------------------------------------------------------------------
// Turn state model
// ---------------------------------------------------------------------------

export type TurnPhase =
  | { phase: 'idle' }
  | {
      phase: 'prompting';
      turnId: string;
      assistantEntryId: string;
      turnEpoch: number;
      ownsACPUpdates: boolean;
      userTurnId?: string;
    }
  | {
      phase: 'finalizing';
      turnId: string;
      assistantEntryId: string;
      turnEpoch: number;
      ownsACPUpdates: boolean;
      userTurnId?: string;
    };

// ---------------------------------------------------------------------------
// Per-session state bag
// ---------------------------------------------------------------------------

export interface SessionState {
  // ── Turn state ──────────────────────────────────────────────────────────
  turn: TurnPhase;
  /**
   * Ordering barrier for RPC fast-path turns: turn-scoped history list writes
   * await this gate so they land after the user turn entry has synced locally.
   * Null when the current turn's payload came from local history / the queue.
   */
  turnHistoryGate: TurnHistoryGate | null;
  nextTurnEpoch: number;
  lateACPUpdateTarget: AssistantTurnACPUpdateTarget | undefined;
  suppressAcpReplayUntilTurnStart: boolean;
  suppressedAcpReplayCount: number;

  // ── ACP update buffering ────────────────────────────────────────────────
  acpUpdateBuffer: BufferedACPUpdate[];
  acpFlushInFlight: Promise<void> | null;
  acpFlushTimer: NodeJS.Timeout | null;
  acpFlushCountInTurn: number;
  acpFlushConsecutiveFailures: number;

  // ── Context window usage (throttled) ────────────────────────────────────
  contextWindowUsageBuffer: SessionContextWindowUsage | null;
  contextWindowUsageTimer: NodeJS.Timeout | null;
  pendingContextWindowHandlers: Set<Promise<void>>;

  // ── Usage tracking ──────────────────────────────────────────────────────
  pendingUsageHandlers: Set<Promise<void>>;

  // ── Session notice history persistence (goals, agent warnings) ───────────
  pendingHistoryNoticeHandlers: Set<Promise<void>>;
  historyNoticePersistChain: Promise<void>;

  // ── Codex image generation uploads ──────────────────────────────────────
  // Session-scoped on purpose: image_generation_end may arrive after prompt return,
  // and clearing this with turn state would detach the generated image from its turn.
  imageGenerationTurnIds: Map<string, string | null>;
  // callId -> in-flight upload promise. Doubles as the dedupe set (callId presence
  // means an upload is in flight) and the drainable set (values() for flush).
  imageGenerationUploads: Map<string, Promise<void>>;
  imageGenerationUploadedCallIds: Set<string>;
  imageGenerationActiveCallIds: Set<string>;
  imageGenerationActivityStatusChain: Promise<void>;

  // ── Permission timing (per-turn, accumulated) ───────────────────────────
  permissionWaitMs: number;

  // ── Unread tracking ─────────────────────────────────────────────────────
  pendingUnread: boolean;

  // ── Session-scoped (survives turn boundaries) ───────────────────────────
  lastActivityMs: number;
  logger: Logger | null;
}

// ---------------------------------------------------------------------------
// Factory for fresh state
// ---------------------------------------------------------------------------

function createSessionState(): SessionState {
  return {
    turn: { phase: 'idle' },
    turnHistoryGate: null,
    nextTurnEpoch: 1,
    lateACPUpdateTarget: undefined,
    suppressAcpReplayUntilTurnStart: false,
    suppressedAcpReplayCount: 0,
    acpUpdateBuffer: [],
    acpFlushInFlight: null,
    acpFlushTimer: null,
    acpFlushCountInTurn: 0,
    acpFlushConsecutiveFailures: 0,
    contextWindowUsageBuffer: null,
    contextWindowUsageTimer: null,
    pendingContextWindowHandlers: new Set(),
    pendingUsageHandlers: new Set(),
    pendingHistoryNoticeHandlers: new Set(),
    historyNoticePersistChain: Promise.resolve(),
    imageGenerationTurnIds: new Map(),
    imageGenerationUploads: new Map(),
    imageGenerationUploadedCallIds: new Set(),
    imageGenerationActiveCallIds: new Set(),
    imageGenerationActivityStatusChain: Promise.resolve(),
    permissionWaitMs: 0,
    pendingUnread: false,
    lastActivityMs: Date.now(),
    logger: null,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SessionTransientStore {
  private readonly sessions = new Map<SessionId, SessionState>();

  /** Get state for a session, creating it lazily if absent. */
  get(sessionId: SessionId): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = createSessionState();
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Check whether a session has state (without creating). */
  has(sessionId: SessionId): boolean {
    return this.sessions.has(sessionId);
  }

  /** Return all tracked session IDs. */
  sessionIds(): SessionId[] {
    return Array.from(this.sessions.keys());
  }

  // ── Turn lifecycle ──────────────────────────────────────────────────────

  /**
   * Begin a new conversation turn. Transitions turn from 'idle' → 'prompting'.
   * Returns the generated turn ID.
   */
  beginTurn(
    sessionId: SessionId,
    args: {
      turnId: string;
      assistantEntryId?: string;
      userTurnId?: string;
      ownsACPUpdates?: boolean;
    }
  ): number {
    const state = this.get(sessionId);
    const turnEpoch = state.nextTurnEpoch;
    const ownsACPUpdates = args.ownsACPUpdates ?? true;
    state.nextTurnEpoch += 1;
    state.turn = {
      phase: 'prompting',
      turnId: args.turnId,
      assistantEntryId: args.assistantEntryId ?? args.turnId,
      turnEpoch,
      ownsACPUpdates,
      ...(args.userTurnId ? { userTurnId: args.userTurnId } : {}),
    };
    if (ownsACPUpdates) {
      state.lateACPUpdateTarget = undefined;
    }
    return turnEpoch;
  }

  activateTurnACPUpdateTarget(sessionId: SessionId, turnId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.turn.phase === 'idle' || state.turn.turnId !== turnId) {
      return;
    }
    if (!state.turn.ownsACPUpdates) {
      state.turn = { ...state.turn, ownsACPUpdates: true };
    }
    state.lateACPUpdateTarget = undefined;
  }

  /**
   * Mark the prompt as returned. Transitions turn from 'prompting' → 'finalizing'.
   * After this, the turn is no longer cancellable but still needs finalization.
   */
  markPromptReturned(sessionId: SessionId, turnId: string): void {
    const state = this.get(sessionId);
    if (state.turn.phase === 'prompting' && state.turn.turnId === turnId) {
      state.turn = { ...state.turn, phase: 'finalizing' };
    }
  }

  /**
   * Get the current turn ID, if any (available in both 'prompting' and 'finalizing').
   */
  getTurnId(sessionId: SessionId): string | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    return state.turn.phase === 'idle' ? undefined : state.turn.turnId;
  }

  getTurnPhase(sessionId: SessionId): TurnPhase['phase'] {
    return this.sessions.get(sessionId)?.turn.phase ?? 'idle';
  }

  /**
   * Identity of the turn currently in flight, for use as a compare-and-set token.
   * Returns undefined unless `turnId` names the current turn.
   *
   * This is the ONLY thing a finalizer may carry across its awaits. It is an
   * EXPECTED value handed back to `finalizeIfCurrent`, never a routing decision:
   * the target that actually gets remembered is read at commit time, inside the
   * CAS, from live state.
   */
  getTurnRef(sessionId: SessionId, turnId: string): TurnRef | undefined {
    const state = this.sessions.get(sessionId);
    if (!state || state.turn.phase === 'idle' || state.turn.turnId !== turnId) {
      return undefined;
    }
    return {
      turnId: state.turn.turnId,
      turnEpoch: state.turn.turnEpoch,
      assistantEntryId: state.turn.assistantEntryId,
    };
  }

  /**
   * Identity of whatever turn is current, for a finalizer that has no turn id of
   * its own (teardown paths: archive, delete, child cleanup, shutdown drain).
   *
   * Those paths must still commit through the CAS rather than clearing blindly,
   * or the turn's routing target is lost and its late updates are dropped. Note
   * that a store turn can exist with no registered execution runtime — an
   * auto-prompt turn runs inside the visible turn's runtime under its own store
   * turn id — so "no active turn runtime" is not "no turn to finalize".
   */
  getCurrentTurnRef(sessionId: SessionId): TurnRef | undefined {
    const state = this.sessions.get(sessionId);
    if (!state || state.turn.phase === 'idle') {
      return undefined;
    }
    return {
      turnId: state.turn.turnId,
      turnEpoch: state.turn.turnEpoch,
      assistantEntryId: state.turn.assistantEntryId,
    };
  }

  /**
   * True unless a DIFFERENT turn currently owns this assistant entry.
   *
   * A redispatch reuses `assistant:<userTurnId>`, so a late finalizer for turn
   * epoch N can otherwise stamp `finished=true` on the entry that epoch N+1 is
   * still streaming into — the web renderer then folds a live turn into a
   * "Worked for …" summary. An entry owned by nobody is finalizable: that is the
   * ordinary path where the turn already released its state.
   *
   * Do not rely on `writeAssistantEntryForTurn`'s reopen branch to undo a wrong
   * stamp. It only runs at genuine turn (re)start via `openAssistantEntry`, so
   * it covers the restore fallback and nothing else.
   */
  isAssistantEntryFinalizable(sessionId: SessionId, ref: TurnRef): boolean {
    const state = this.sessions.get(sessionId);
    if (!state || state.turn.phase === 'idle') {
      return true;
    }
    if (state.turn.assistantEntryId !== ref.assistantEntryId) {
      return true;
    }
    return state.turn.turnEpoch === ref.turnEpoch;
  }

  /**
   * Compare-and-set finalization: if `ref` still names the current turn, remember
   * its routing target for late updates and clear turn state, atomically.
   *
   * Lookup and commit are one synchronous operation on purpose. The previous
   * shape read the routing target before a long await chain and committed that
   * stale value in a `finally`, so a turn that claimed ACP routing during the
   * await was finalized against `undefined` and every subsequent update was
   * dropped for having no target. There is no way to express that bug through
   * this API: callers hold an identity token, not a target.
   *
   * Returns whether the CAS matched.
   */
  finalizeIfCurrent(sessionId: SessionId, ref: TurnRef): boolean {
    const state = this.sessions.get(sessionId);
    if (
      !state ||
      state.turn.phase === 'idle' ||
      state.turn.turnId !== ref.turnId ||
      state.turn.turnEpoch !== ref.turnEpoch
    ) {
      return false;
    }
    if (state.turn.ownsACPUpdates) {
      // Read at commit time, from live state — never from a caller's snapshot.
      state.lateACPUpdateTarget = {
        kind: 'assistant_entry',
        assistantEntryId: state.turn.assistantEntryId,
        turnId: state.turn.turnId,
        turnEpoch: state.turn.turnEpoch,
        source: 'finalized_turn',
        finalizedAtMs: getServerNow(),
        ...(state.turn.userTurnId ? { userTurnId: state.turn.userTurnId } : {}),
      };
    }
    this.clearTurnState(sessionId);
    return true;
  }

  /**
   * Route ACP notifications that arrive just after finalization back to the turn
   * that produced them. Cleared when the next turn owns ACP updates, so
   * unauthorized/pre-prompt turns cannot steal late output.
   */
  rememberFinalizedTurnForLateACPUpdates(
    sessionId: SessionId,
    target: AssistantTurnACPUpdateTarget
  ): void {
    const state = this.get(sessionId);
    state.lateACPUpdateTarget = {
      ...target,
      source: 'finalized_turn',
      finalizedAtMs: getServerNow(),
    };
  }

  getLateACPUpdateTargetAssistantEntryId(sessionId: SessionId): string | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    return this.getFreshLateACPUpdateTarget(state)?.assistantEntryId;
  }

  getCurrentACPUpdateTarget(sessionId: SessionId): ACPUpdateTarget | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    if (state.turn.phase !== 'idle' && state.turn.ownsACPUpdates) {
      return {
        kind: 'assistant_entry',
        assistantEntryId: state.turn.assistantEntryId,
        turnId: state.turn.turnId,
        turnEpoch: state.turn.turnEpoch,
        source: 'active_turn',
        ...(state.turn.userTurnId ? { userTurnId: state.turn.userTurnId } : {}),
      };
    }
    return this.getFreshLateACPUpdateTarget(state);
  }

  private getFreshLateACPUpdateTarget(
    state: SessionState
  ): AssistantTurnACPUpdateTarget | undefined {
    // The finalized-turn routing target intentionally never expires by time: agent
    // sessions can stay alive and emit events long after a turn's stopReason (cron
    // jobs, ScheduleWakeup, other deferred/background work). Those late updates must
    // still be routed to the owning assistant entry and written to the Loro doc.
    // The target is only cleared when a new turn starts (beginTurn) or when ACP
    // replay suppression begins — never on a wall-clock deadline.
    return state.lateACPUpdateTarget;
  }

  /**
   * Drop ACP updates emitted by native `loadSession()` replay until a new turn starts.
   * Those replay notifications belong to previously persisted history and must not be
   * re-attached to the next user turn.
   */
  beginAcpReplaySuppression(sessionId: SessionId): void {
    const state = this.get(sessionId);
    state.lateACPUpdateTarget = undefined;
    state.suppressAcpReplayUntilTurnStart = true;
    state.suppressedAcpReplayCount = 0;
  }

  endAcpReplaySuppression(sessionId: SessionId): number {
    const state = this.sessions.get(sessionId);
    if (!state) return 0;
    const droppedCount = state.suppressedAcpReplayCount;
    state.suppressAcpReplayUntilTurnStart = false;
    state.suppressedAcpReplayCount = 0;
    return droppedCount;
  }

  recordSuppressedAcpReplay(sessionId: SessionId): boolean {
    const state = this.get(sessionId);
    if (!state.suppressAcpReplayUntilTurnStart) {
      return false;
    }
    state.suppressedAcpReplayCount += 1;
    return true;
  }

  /**
   * Get the turn ID only if the turn is in 'prompting' phase (i.e. cancellable).
   */
  getActiveTurnId(sessionId: SessionId): string | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    return state.turn.phase === 'prompting' ? state.turn.turnId : undefined;
  }

  /**
   * Check whether a given turn is currently prompting (used for cancel matching).
   */
  isPrompting(sessionId: SessionId, turnId: string): boolean {
    const state = this.sessions.get(sessionId);
    return state?.turn.phase === 'prompting' && state.turn.turnId === turnId;
  }

  /**
   * Check whether a session has any pending turn work that needs finalization.
   * Used by flushAllACPUpdates to skip idle sessions with no pending state.
   */
  hasPendingTurnWork(sessionId: SessionId): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    return (
      state.turn.phase !== 'idle' ||
      state.acpUpdateBuffer.length > 0 ||
      state.acpFlushInFlight !== null ||
      state.acpFlushTimer !== null ||
      state.contextWindowUsageBuffer !== null ||
      state.contextWindowUsageTimer !== null ||
      state.pendingContextWindowHandlers.size > 0 ||
      state.pendingHistoryNoticeHandlers.size > 0 ||
      state.imageGenerationUploads.size > 0 ||
      state.pendingUnread
    );
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * Clear turn-scoped state. Called after a conversation turn finishes
   * (either successfully or on error).
   *
   * Preserves session-scoped state: lastActivityMs, logger.
   */
  clearTurnState(sessionId: SessionId): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    state.turn = { phase: 'idle' };
    state.turnHistoryGate?.dispose();
    state.turnHistoryGate = null;
    state.suppressAcpReplayUntilTurnStart = false;
    state.suppressedAcpReplayCount = 0;
    // The ACP update buffer is NOT turn-scoped: every entry carries the target
    // it was enqueued against, so entries buffered during the finalization tail
    // (agents keep emitting after cancel) must survive the turn clear and flush
    // to their stamped targets. Wiping them here silently dropped the last
    // window of streamed output at the Stop boundary. Only drop the batch timer
    // when there is nothing left to flush.
    if (state.acpUpdateBuffer.length === 0 && state.acpFlushTimer) {
      clearTimeout(state.acpFlushTimer);
      state.acpFlushTimer = null;
    }
    state.acpFlushCountInTurn = 0;
    if (state.acpUpdateBuffer.length === 0) {
      state.acpFlushConsecutiveFailures = 0;
    }
    // Note: acpFlushInFlight is NOT nulled here. In-flight flushes must complete
    // naturally (they self-clean in their finally callback). cleanup() relies on
    // collecting these promises to await them before shutdown. Only full session
    // deletion (deleteSession) should discard them.
    if (state.contextWindowUsageTimer) {
      clearTimeout(state.contextWindowUsageTimer);
      state.contextWindowUsageTimer = null;
    }
    state.contextWindowUsageBuffer = null;
    // Note: pending async handlers are NOT cleared here. They are drained explicitly by
    // finalizeACPState()/flushSessionUsage(). Clearing them prematurely would drop writes.
    state.imageGenerationActiveCallIds.clear();
    state.permissionWaitMs = 0;
    state.pendingUnread = false;
  }

  /**
   * Remove all state for a session. Called when the session is fully evicted
   * (GC sweep or explicit cleanup).
   *
   * Callers must release any session-scoped side effects before calling this.
   */
  deleteSession(sessionId: SessionId): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // Cancel any lingering timer
    state.turnHistoryGate?.dispose();
    if (state.contextWindowUsageTimer) {
      clearTimeout(state.contextWindowUsageTimer);
    }
    if (state.acpFlushTimer) {
      clearTimeout(state.acpFlushTimer);
    }
    this.sessions.delete(sessionId);
  }
}
