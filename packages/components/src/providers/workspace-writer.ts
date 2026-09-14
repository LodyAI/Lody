import type {
  PreviewVisualCommentMutation,
  SessionId,
  SessionHistory,
  PermissionOutcome,
  TaskProposalMeta,
} from '@lody/shared';

// # WorkspaceWriter — the renderer's authored-write seam
//
// Every durable repo mutation the renderer performs goes through a
// `WorkspaceWriter` instead of calling `runtime.repo.*` / `sessionStore.setState`
// directly. Dual-author architecture (specs/local-first-two-plane.md): the
// renderer direct-authors its own durable writes against its own LoroRepo and
// uploads them over its own cloud connection; for local targets the local data
// plane converges the same ops with the CLI. The seam stays so hooks depend on
// one narrow mutation surface rather than raw repo/store handles.
export interface WorkspaceWriter {
  /** `repo.upsertDocMeta(roomId, patch)` — session/machine doc-meta write. */
  upsertDocMeta(roomId: string, patch: Record<string, unknown>): Promise<void>;

  /**
   * Author a new session's meta and first user turn as one accept unit. The
   * durable dispatch pointer stays the caller's sibling side effect
   * (`requestSessionDispatch`), matching the send hot path.
   */
  startSession(
    sessionId: string,
    meta: Record<string, unknown>,
    entry: SessionHistory,
    dispatch: {
      userTurnId: string;
      userId: string;
      timestamp: string;
      inputConfig: Record<string, unknown>;
    }
  ): Promise<void>;

  /** `repo.deleteDoc(roomId)` — hard session deletion. */
  deleteDoc(roomId: string): Promise<void>;

  /** Flock-doc row put (agent config, machine command queue, external history). */
  flockRowPut(flockDocId: string, key: readonly string[], value: unknown): Promise<void>;

  /** Compute a replacement against the current row in one local transaction.
   * Return undefined to leave the row untouched (including an absent row).
   */
  flockRowUpdate(
    flockDocId: string,
    key: readonly string[],
    update: (current: unknown) => unknown | undefined
  ): Promise<boolean>;

  /** Insert a Flock-doc row only when its key is absent in the same transaction. */
  flockRowPutIfAbsent(
    flockDocId: string,
    key: readonly string[],
    value: unknown
  ): Promise<{ inserted: boolean; value: unknown }>;

  /** Flock-doc row delete. */
  flockRowDelete(flockDocId: string, key: readonly string[]): Promise<void>;

  /**
   * Append the pending user turn to a session doc — the send hot path. Resolves
   * when the local write is ACCEPTED (accept boundary = local CRDT write, not
   * remote sync) and REJECTS when it is not, so the send path's failure branches
   * (toast, composer preserved) fire instead of silently losing the message.
   */
  appendSessionTurn(
    sessionId: string,
    entry: SessionHistory,
    dispatch?: {
      userTurnId: string;
      userId: string;
      timestamp: string;
      inputConfig: Record<string, unknown>;
    }
  ): Promise<void>;

  /** Append a history entry without coupling it to dispatch. */
  appendSessionHistory(sessionId: string, entry: SessionHistory): Promise<void>;

  /**
   * Replace an existing history entry in place (resend resets a turn to
   * pending). Callers with a functional updater resolve it to the concrete
   * replacement entry before calling this.
   */
  updateSessionHistory(sessionId: string, entryId: string, entry: SessionHistory): Promise<void>;

  /** Resolve against the latest proposal; never write back a rendered history snapshot. */
  resolveSessionTaskProposal(
    sessionId: string,
    entryId: string,
    proposalId: string,
    resolution: Pick<TaskProposalMeta, 'taskId'> & {
      outcome: NonNullable<TaskProposalMeta['outcome']>;
    }
  ): Promise<void>;

  /**
   * Author a permission response: locate the tool_call whose
   * `permissionRequest.requestId` matches and write its outcome. Sync-critical
   * (the agent turn is blocked until authored).
   */
  respondSessionPermission(
    sessionId: string,
    requestId: string,
    outcome: PermissionOutcome,
    options?: { turnId?: string }
  ): Promise<void>;

  /** Message-queue mutations (durable CRDT on the session doc). */
  enqueueSessionMessage(sessionId: string, item: Record<string, unknown>): Promise<void>;
  removeSessionMessage(sessionId: string, itemId: string): Promise<void>;
  updateSessionMessage(
    sessionId: string,
    itemId: string,
    patch: Record<string, unknown>
  ): Promise<void>;
  reorderSessionMessages(sessionId: string, orderedItemIds: readonly string[]): Promise<void>;

  /** Mutate the dedicated preview-comment doc (renderer-authored user data). */
  mutatePreviewVisualComments(
    sessionId: SessionId,
    mutation: PreviewVisualCommentMutation
  ): Promise<void>;
}
