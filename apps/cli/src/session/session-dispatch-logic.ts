/**
 * Pure decision functions for session dispatch.
 *
 * These functions take a snapshot of all relevant state and return a decision —
 * no I/O, no side effects, trivially testable. The I/O shell in
 * {@link SessionDispatchWatcher} gathers snapshots, calls these functions, and
 * executes the returned actions.
 *
 * See the class-level doc on `SessionDispatchWatcher` for the full behavioral design.
 */
import {
  extractPromptPreviewFromInputBlocks,
  historyItemsToInputBlocks,
  normalizeSessionInputBlocks,
  getLocalProjectHistoryProviderKey,
  type MachineId,
  type SessionHistoryInput,
  type SessionInputBlock,
  type SessionMeta,
} from '@lody/shared';

// ── Snapshot types ──────────────────────────────────────────────────────────

/** All state needed for a dispatch decision, gathered by the I/O shell. */
export type SessionDispatchSnapshot = {
  meta: SessionMeta;
  history: SessionHistoryInput[];
  /** True only when a user turn is currently owned by the execution service. */
  hasActiveTurn: boolean;
  /** True when the active turn is still creating/restoring its ACP session. */
  hasBlockingPendingCreate: boolean;
  /** True when an ACP session object can be reused for a follow-up turn. */
  hasReusableSession: boolean;
  /** True while edit-and-resend is replacing the durable history tail. */
  hasRewriteBarrier: boolean;
};

// ── Action types ────────────────────────────────────────────────────────────

export type DispatchAction =
  | {
      type: 'noop';
      reason: 'not-owned' | 'archived' | 'rewrite-barrier' | 'pending-create' | 'active-session';
    }
  | { type: 'reset-stale-status'; statusType: string }
  | { type: 'no-dispatchable-turn' }
  | { type: 'dispatch'; mode: 'create' | 'continue'; turn: SessionHistoryInput };

export type CancelAction =
  | { type: 'noop'; reason: 'not-owned' | 'archived' | 'no-cancel-turn' | 'already-seen' }
  | { type: 'cancel'; turnId: string };

export type DispatchTurnInput = {
  inputBlocks: SessionInputBlock[];
  prompt: string;
};

function getImportedAcpSourceAcpSessionId(meta: SessionMeta): string | undefined {
  const externalHistory = meta.externalHistory;
  return externalHistory?.sourceAcpSessionId;
}

function isImportedAcpReplayUserTurn(entry: SessionHistoryInput, meta: SessionMeta): boolean {
  const provider = meta.externalHistory
    ? getLocalProjectHistoryProviderKey(meta.externalHistory.provider)
    : null;
  const sourceAcpSessionId = getImportedAcpSourceAcpSessionId(meta);
  return (
    !!provider &&
    !!sourceAcpSessionId &&
    entry.id.startsWith(`${provider}:${sourceAcpSessionId}:turn:`)
  );
}

export function resolveResumableAcpSessionId(
  meta: SessionMeta | undefined
): SessionMeta['acpSessionId'] | undefined {
  const acpSessionId = meta?.acpSessionId;
  if (!meta || !acpSessionId) {
    return undefined;
  }
  if (!meta.externalHistory) {
    return acpSessionId;
  }

  const sourceAcpSessionId = meta.externalHistory.sourceAcpSessionId;
  if (!sourceAcpSessionId) {
    return undefined;
  }
  return acpSessionId === sourceAcpSessionId ? undefined : acpSessionId;
}

export function resolveDispatchAcpSessionId(
  meta: SessionMeta | undefined
): SessionMeta['acpSessionId'] | undefined {
  const liveSessionId = resolveResumableAcpSessionId(meta);
  if (liveSessionId || !meta?.externalHistory || meta.externalHistory.status === 'sync_conflict') {
    return liveSessionId;
  }
  return meta.externalHistory.sourceAcpSessionId;
}

// ── Dispatch decision ───────────────────────────────────────────────────────

/**
 * Given a snapshot of session state, determine what dispatch action to take.
 *
 * Decision tree (matches the class-level doc on SessionDispatchWatcher):
 *
 * 1. Guard: not owned / archived / active turn / pending create → noop
 * 2. Status is active but no active turn owner → reset-stale-status
 *    Status is active with an active turn owner → noop (active-session)
 * 3. Find dispatchable turn → dispatch(create) or dispatch(continue)
 *    No turn found → no-dispatchable-turn
 */
export function resolveSessionDispatchAction(
  snapshot: SessionDispatchSnapshot,
  machineId: MachineId
): DispatchAction {
  const {
    meta,
    history,
    hasActiveTurn,
    hasBlockingPendingCreate,
    hasReusableSession,
    hasRewriteBarrier,
  } = snapshot;

  // ── Step 1: Guard checks ──
  if (!meta || meta.machineId !== machineId) {
    return { type: 'noop', reason: 'not-owned' };
  }
  if (meta.isArchived) {
    return { type: 'noop', reason: 'archived' };
  }
  if (hasRewriteBarrier) {
    return { type: 'noop', reason: 'rewrite-barrier' };
  }
  if (hasBlockingPendingCreate) {
    return { type: 'noop', reason: 'pending-create' };
  }
  if (hasActiveTurn) {
    return { type: 'noop', reason: 'active-session' };
  }

  // ── Step 2: Stale status recovery ──
  const statusType = meta.status?.type;
  if (
    statusType === 'running' ||
    statusType === 'requestPermission' ||
    statusType === 'initializing'
  ) {
    return { type: 'reset-stale-status', statusType };
  }

  // ── Step 3: Find dispatchable turn ──
  const turn = findNextDispatchableUserTurn(history, meta);
  if (!turn) {
    return { type: 'no-dispatchable-turn' };
  }

  // ── Step 4: Decide create vs continue ──
  const mode = hasReusableSession || resolveDispatchAcpSessionId(meta) ? 'continue' : 'create';
  return { type: 'dispatch', mode, turn };
}

// ── Cancel decision ─────────────────────────────────────────────────────────

/**
 * Given cancel-related state, determine whether to send a cancel request.
 *
 * The web client writes `meta.lastCanceledTurn` to request cancellation.
 * This function deduplicates by comparing against `lastSeenCancelTurn`.
 */
export function resolveSessionCancelAction(
  meta: SessionMeta | undefined,
  lastSeenCancelTurn: string | undefined,
  machineId: MachineId
): CancelAction {
  if (!meta || meta.machineId !== machineId) {
    return { type: 'noop', reason: 'not-owned' };
  }
  if (meta.isArchived) {
    return { type: 'noop', reason: 'archived' };
  }

  const lastCanceledTurn = meta.lastCanceledTurn;
  if (typeof lastCanceledTurn !== 'string' || !lastCanceledTurn) {
    return { type: 'noop', reason: 'no-cancel-turn' };
  }
  if (lastCanceledTurn === lastSeenCancelTurn) {
    return { type: 'noop', reason: 'already-seen' };
  }

  return { type: 'cancel', turnId: lastCanceledTurn };
}

// ── Turn finding ────────────────────────────────────────────────────────────

/**
 * Find the first user turn in history that needs to be dispatched.
 *
 * A user turn is considered "dispatchable" if any of these conditions is true:
 *
 * 1. **New status field** (`entry.status`): 'pending', 'seen', or 'processing'.
 *    Lifecycle: `pending` → `seen` → `processing` → `handled`.
 *    `pending_apply` is guide intent and is deliberately not dispatched here,
 *    unless `latestUserMsgId` explicitly names it — that is a guide the agent
 *    refused, re-aimed at ordinary dispatch.
 *
 * 2. **Legacy read field** (`entry.read === false`): Older sessions without the
 *    `status` field.
 *
 * 3. **Meta pointer: processingUserMsgId**: Interrupted processing (crash recovery).
 *
 * 4. **Meta pointer: latestUserMsgId ≠ lastHandledUserMsgId**: Legacy dispatch
 *    mechanism.
 *
 * Returns the first matching entry (chronological scan), or null.
 */
export function findNextDispatchableUserTurn(
  history: SessionHistoryInput[],
  meta: SessionMeta
): SessionHistoryInput | null {
  for (const entry of history) {
    if (entry.role !== 'user') {
      continue;
    }
    if (isImportedAcpReplayUserTurn(entry, meta)) {
      continue;
    }

    // Path 1: New status field — explicit lifecycle state
    if (typeof entry.status === 'string') {
      if (entry.status === 'pending' || entry.status === 'seen' || entry.status === 'processing') {
        return entry;
      }
      // `pending_apply` is steer intent, not a dispatch request — with one
      // exception: a steer the agent refused gets the dispatch pointer re-aimed
      // at it (`SessionExecutionService.requeueUndeliveredSteer`, or the Web
      // client's own promotion). That pointer is a later and more explicit
      // signal than the status, and honoring it here is what lets the message
      // run after a restart even if the status flip never reached this machine.
      if (
        entry.status === 'pending_apply' &&
        entry.id === meta.latestUserMsgId &&
        entry.id !== meta.lastHandledUserMsgId
      ) {
        return entry;
      }
      continue; // 'handled', 'error', etc. — skip
    }

    // Path 2: Legacy read field
    if (entry.read === false) {
      return entry;
    }

    // Path 3: Interrupted processing (CRA crash recovery)
    if (entry.id === meta.processingUserMsgId) {
      return entry;
    }

    // Path 4: Legacy meta pointer dispatch
    if (entry.id === meta.latestUserMsgId && entry.id !== meta.lastHandledUserMsgId) {
      return entry;
    }
  }

  return null;
}

export function resolveDispatchTurnInput(entry: SessionHistoryInput): DispatchTurnInput {
  const historyBlocks = historyItemsToInputBlocks(entry.items);
  const configuredBlocks = normalizeSessionInputBlocks(entry.inputConfig?.inputBlocks, '');
  const fallbackBlocks = normalizeSessionInputBlocks(undefined, entry.inputConfig?.prompt ?? '');
  const inputBlocks =
    configuredBlocks.length > 0
      ? configuredBlocks
      : historyBlocks.length > 0
        ? historyBlocks
        : fallbackBlocks;
  const prompt =
    entry.inputConfig?.prompt ??
    extractPromptPreviewFromInputBlocks(inputBlocks.length > 0 ? inputBlocks : historyBlocks);

  return { inputBlocks, prompt };
}
