import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  SessionId,
  sessionForkFailure,
  SessionStatusFactory,
  type AgentConfigId,
  type MachineId,
  type MessageContent,
  type SessionForkErrorCode,
  type SessionForkResponse,
  type SessionForkSpec,
  type SessionForkOperation,
  type SessionHistoryInput,
  type SessionMeta,
  type ProjectRef,
  resolveSessionMcpSelection,
  resolveSessionTaskToolsEnabled,
  resolveSessionScheduleToolsEnabled,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { mapWithConcurrency } from '@/lib/bounded-concurrency';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { SessionManager } from './session-manager';
import type { SessionUserResolver } from './session-user-resolver';
import { listAliveRoomIds } from '@/lib/loro/repo-existence';
import {
  withForkOperationLock,
  type SessionForkOperationMarker,
  type SessionForkOperationStore,
} from './session-fork-operation-store';

type ForkWarning = SessionForkResponse['warnings'][number];
const execFileAsync = promisify(execFile);

/** Recovery opens only store-listed docs; keep even that small fan-out bounded. */
const FORK_RECOVERY_CONCURRENCY = 4;

type WorktreeForkPreparedInput = {
  spec: SessionForkSpec;
  source: SessionMeta;
  sourceTitle: string;
  targetDoc: Awaited<ReturnType<LoroDocumentManager['getOrCreateSessionDoc']>>;
  targetMeta: SessionMeta;
  marker: SessionForkOperationMarker;
  historyResult: NonNullable<ReturnType<typeof cloneHistoryThroughTurn>>;
  agentConfig: NonNullable<Awaited<ReturnType<LoroDocumentManager['getAgentConfigById']>>>;
  user: { name: string; email: string };
  operation: SessionForkOperation;
  targetWorkdir?: string;
};

class SessionForkOperationError extends Error {
  constructor(
    readonly code: SessionForkErrorCode,
    message: string,
    readonly detail: unknown
  ) {
    super(message);
    this.name = 'SessionForkOperationError';
  }
}

function rewriteAttachmentNamespace(
  item: MessageContent,
  sourceSessionId: SessionId
): MessageContent {
  if (item.type === 'image') {
    return {
      ...item,
      storageSessionId: item.storageSessionId ?? sourceSessionId,
    };
  }
  if (item.type === 'image_group') {
    return {
      ...item,
      images: item.images.map((image) => ({
        ...image,
        storageSessionId: image.storageSessionId ?? sourceSessionId,
      })),
    };
  }
  if (item.type === 'file') {
    return {
      ...item,
      storageSessionId: item.storageSessionId ?? sourceSessionId,
    };
  }
  return item;
}

export function cloneHistoryThroughTurn(
  history: SessionHistoryInput[],
  sourceTurnId: string,
  sourceSessionId: SessionId,
  sourceTitle: string,
  targetSessionId: SessionId,
  options: { allowActiveTurnSuffix?: boolean } = {}
): { history: SessionHistoryInput[]; warnings: ForkWarning[]; acpTurnId?: string } | null {
  const sourceIndex = history.findIndex((entry) => entry.id === sourceTurnId);
  if (sourceIndex < 0) return null;
  const sourceTurn = history[sourceIndex];
  if (!sourceTurn) return null;
  if (sourceTurn.role !== 'assistant' || sourceTurn.finished !== true) return null;
  // A persisted provider turn id makes an older completed assistant turn an exact
  // boundary. Without one, retain the legacy latest-completed-only rule.
  if (
    history.some(
      (entry, index) =>
        index > sourceIndex &&
        entry.role === 'assistant' &&
        (!options.allowActiveTurnSuffix || entry.finished === true) &&
        !sourceTurn.acpTurnId
    )
  )
    return null;

  const selected = history.slice(0, sourceIndex + 1);
  const warnings: ForkWarning[] = [];
  if (selected.some((entry) => entry.fileDiff.length > 0)) {
    warnings.push({
      code: 'HISTORICAL_TURN_DIFF_UNAVAILABLE',
      message: 'Historical turn diff evidence is not copied in this version.',
    });
  }
  if (
    selected.some((entry) =>
      (entry.items ?? []).some((item) => item.type === 'file' && item.transport === 'local')
    )
  ) {
    warnings.push({
      code: 'ATTACHMENT_UNAVAILABLE',
      message: 'Some local attachments remain linked to the source storage namespace.',
    });
  }

  const cloned = selected.map((entry) => ({
    ...entry,
    items: (entry.items ?? []).map((item) => rewriteAttachmentNamespace(item, sourceSessionId)),
    fileDiff: [],
    sendStatus: undefined,
    status: entry.role === 'user' ? ('handled' as const) : entry.status,
    read: true,
  }));
  cloned.push({
    id: `session-fork-origin:${targetSessionId}`,
    timestamp: new Date(getServerNow()).toISOString(),
    role: 'system',
    fileDiff: [],
    finished: true,
    read: true,
    status: undefined,
    sendStatus: undefined,
    items: [
      {
        type: 'system_notice',
        name: 'session_fork_origin',
        meta: { sourceSessionId, sourceTurnId, sourceTitle },
      },
    ],
  });
  return { history: cloned, warnings, acpTurnId: sourceTurn.acpTurnId };
}

export class SessionForkService {
  private readonly inFlight = new Map<
    string,
    { spec: SessionForkSpec; promise: Promise<SessionForkResponse> }
  >();
  /**
   * Operation ids this process is currently driving (accept → background saga).
   * This — never a timestamp — is how recovery tells a live fork from one
   * whose owning process died.
   */
  private readonly activeOperations = new Set<string>();

  constructor(
    private readonly deps: {
      workspaceDocument: LoroDocumentManager;
      sessionManager: SessionManager;
      userResolver: SessionUserResolver;
      logger: Logger;
      workspaceId: string;
      machineId: string;
      forkOperationStore: SessionForkOperationStore;
      isSourceBusy(sessionId: SessionId): boolean;
      inspectGitWorkdir?: (workdir: string) => Promise<{ dirty: boolean; headSha: string }>;
      resolveGitBranch?: (workdir: string) => Promise<string | undefined>;
    }
  ) {}

  async fork(spec: SessionForkSpec): Promise<SessionForkResponse> {
    const key = spec.targetSessionId;
    const existing = this.inFlight.get(key);
    if (existing) {
      if (
        existing.spec.sourceSessionId !== spec.sourceSessionId ||
        existing.spec.sourceTurnId !== spec.sourceTurnId ||
        existing.spec.requestedByUserId !== spec.requestedByUserId ||
        existing.spec.targetContext?.kind !== spec.targetContext?.kind ||
        existing.spec.targetPlacement !== spec.targetPlacement
      ) {
        return sessionForkFailure(
          spec,
          'TARGET_SESSION_CONFLICT',
          'Target session id is already reserved by another fork.'
        );
      }
      return await existing.promise;
    }
    const operation = this.forkInner(spec).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, { spec, promise: operation });
    return await operation;
  }

  /**
   * Recover fork operations interrupted by a process restart.
   *
   * Discovery reads the machine-local operation store and nothing else. A
   * preparing fork target deliberately publishes no Session meta until its
   * final commit, so the repo meta index cannot substitute for the store; and
   * opening every historical Session Doc to inspect `forkOperation` would join
   * each room and pull each stream (see ../lib/loro/AGENTS.md). Recovery stays
   * O(in-flight forks), never O(session docs).
   *
   * Race discipline (same rules as the speculative-worktree sweep): every
   * candidate is re-read under `withForkOperationLock`, and liveness comes from
   * `activeOperations`, never from timestamps — a same-target retry that
   * already restarted must never be rolled back as "interrupted".
   */
  async recoverPendingForks(): Promise<void> {
    let markers: SessionForkOperationMarker[];
    try {
      markers = await this.deps.forkOperationStore.list();
    } catch (error) {
      this.deps.logger.error(
        `[session-fork] Failed to list fork operation markers: ${formatErrorMessage(error)}`
      );
      return;
    }
    const candidates = markers.filter(
      (marker) =>
        marker.workspaceId === this.deps.workspaceId && marker.machineId === this.deps.machineId
    );
    if (candidates.length === 0) {
      return;
    }

    // The store is written before the target doc exists, so a crash can leave a
    // marker without a doc. Skip those instead of recreating an empty doc by
    // opening it.
    const candidateRoomIds = new Set(
      candidates.map((marker) => getSessionRoomId(marker.targetSessionId as SessionId))
    );
    const aliveRoomIds = new Set(
      await listAliveRoomIds(this.deps.workspaceDocument, (roomId) =>
        candidateRoomIds.has(roomId)
      ).catch(() => [])
    );

    await mapWithConcurrency(candidates, FORK_RECOVERY_CONCURRENCY, async (candidate) => {
      const targetSessionId = candidate.targetSessionId as SessionId;
      try {
        await withForkOperationLock(targetSessionId, async () => {
          // Re-read under the lock: an accept/retry may have rewritten the
          // marker while this sweep waited on the directory-listing snapshot.
          const marker = await this.deps.forkOperationStore.read(targetSessionId);
          if (!marker || marker.operationId !== candidate.operationId) {
            return;
          }
          if (
            marker.workspaceId !== this.deps.workspaceId ||
            marker.machineId !== this.deps.machineId
          ) {
            return;
          }
          if (this.activeOperations.has(marker.operationId)) {
            return;
          }
          await this.recoverForkCandidate(marker, aliveRoomIds);
        });
      } catch (error) {
        this.deps.logger.error(
          `[session-fork] Failed to recover fork ${candidate.operationId} (target=${targetSessionId}): ${formatErrorMessage(error)}`
        );
      }
    });
  }

  private async recoverForkCandidate(
    marker: SessionForkOperationMarker,
    aliveRoomIds: ReadonlySet<string>
  ): Promise<void> {
    const targetSessionId = marker.targetSessionId as SessionId;
    const roomId = getSessionRoomId(targetSessionId);
    if (!aliveRoomIds.has(roomId)) {
      // Marker outlived its doc (crash between marker record and doc creation,
      // i.e. before the saga could produce anything). Nothing to compensate.
      await this.deps.forkOperationStore.clear(targetSessionId).catch(() => {});
      return;
    }

    const targetDoc = await this.deps.workspaceDocument
      .getOrCreateSessionDoc(targetSessionId)
      .catch(() => null);
    if (!targetDoc) {
      // Transient open failure — keep the marker for the next startup.
      return;
    }
    // Judge from the doc itself, with the same terminal criteria the client's
    // PendingWorktreeForkObserver uses (a failed receipt, or a cleared flag
    // plus the cloned history's origin notice). The meta record is never
    // positive proof of completion: its write is not flush-atomic with the
    // doc's, so a durable acpSessionId can precede the history it certifies.
    const operation = targetDoc.getForkOperation();
    if (operation && operation.id !== marker.operationId) {
      // Doc and marker disagree — leave both for the next startup to re-check.
      return;
    }
    if (operation?.state === 'failed') {
      // The saga already compensated and left the durable receipt.
      await this.deps.forkOperationStore.clear(targetSessionId).catch(() => {});
      return;
    }

    const history = await targetDoc.getHistory();
    const hasOriginNotice = history.some((entry) =>
      (entry.items ?? []).some(
        (item) => item.type === 'system_notice' && item.name === 'session_fork_origin'
      )
    );
    if (!hasOriginNotice) {
      if (!operation) {
        // Neither the prepare persist nor any commit write landed (the flag
        // clear is ordered after the history write, and both are flush-atomic
        // doc writes), so nothing durable references this operation.
        await this.deps.forkOperationStore.clear(targetSessionId).catch(() => {});
        return;
      }
      // Genuinely interrupted mid-saga: the process that owned it is gone.
      // Compensate the worktree from the marker payload (no source doc needed),
      // then leave the durable failed receipt for same-target retries to read.
      await this.deps.sessionManager
        .cleanupForkWorktree({
          workspaceId: this.deps.workspaceId as never,
          requesterUserId: marker.cleanup.requesterUserId,
          machineId: this.deps.machineId,
          agentConfigId: marker.cleanup.agentConfigId as never,
          agentCliType: marker.cleanup.cliType,
          agentType: marker.cleanup.agentType as never,
          mcpServerIds: resolveSessionMcpSelection(history),
          taskToolsEnabled: false,
          scheduleToolsEnabled: false,
          project: marker.cleanup.project as ProjectRef,
          sessionId: targetSessionId,
          githubRepo: marker.cleanup.repoFullName,
          branch: marker.cleanup.branch,
          ...(marker.cleanup.workdir ? { workdir: marker.cleanup.workdir } : {}),
          userName: 'Lody',
          userEmail: 'noreply@lody.ai',
        })
        .catch(() => {});
      targetDoc.setForkOperation({
        ...operation,
        state: 'failed',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The worktree fork was interrupted by a machine restart. Please try again.',
        },
        updatedAt: new Date(getServerNow()).toISOString(),
      });
      try {
        await this.deps.workspaceDocument.persistPendingChanges('session-fork-rollback');
        await this.deps.forkOperationStore.clear(targetSessionId).catch(() => {});
      } catch {
        // Keep the marker so the next startup retries the compensation.
      }
      return;
    }

    // The commit's doc writes landed. That is not enough: the saga publishes
    // meta last, so a crash in the gap leaves a session whose history is
    // complete but which has no meta record — invisible everywhere, with the
    // client observer reporting success into a void. Check the meta record
    // (no room join) and repair from the marker payload when it is missing.
    const record = await this.deps.workspaceDocument.repo.getDocMeta(roomId);
    const meta = isLoroRepoDocDeleted(record)
      ? undefined
      : (record?.meta as SessionMeta | undefined);
    const needsRepair = operation !== undefined || !meta?.acpSessionId;
    if (!needsRepair) {
      await this.deps.forkOperationStore.clear(targetSessionId).catch(() => {});
      return;
    }
    if (operation) {
      // The flag clear itself did not persist — clear it now or the client's
      // observer reaches neither terminal branch and waits forever.
      targetDoc.setForkOperation(undefined);
    }
    if (!meta?.acpSessionId) {
      // The ACP session id is unrecoverable; leaving it absent means the next
      // prompt starts a fresh ACP session against the cloned history.
      const republishedMeta: SessionMeta = {
        id: targetSessionId,
        machineId: marker.machineId as MachineId,
        createdAt: marker.createdAt,
        lastMessageAt: getServerNow(),
        title: marker.title,
        titleSource: 'generated',
        userId: marker.cleanup.requesterUserId,
        status: SessionStatusFactory.idle(),
        isArchived: false,
        cliType: marker.cleanup.cliType,
        agentType: marker.cleanup.agentType,
        agentConfigId: marker.cleanup.agentConfigId as AgentConfigId,
        project: marker.cleanup.project as ProjectRef,
        repoFullName: marker.cleanup.repoFullName,
        baseBranch: marker.cleanup.branch,
        ...(marker.branchName ? { branchName: marker.branchName } : {}),
        isWorktree: true,
      };
      await this.deps.workspaceDocument.repo.upsertDocMeta(roomId, republishedMeta);
    }
    try {
      await this.deps.workspaceDocument.persistPendingChanges('session-fork-commit');
      await this.deps.forkOperationStore.clear(targetSessionId).catch(() => {});
    } catch {
      // Keep the marker so the next startup retries; the repair is idempotent.
    }
  }

  private async forkInner(spec: SessionForkSpec): Promise<SessionForkResponse> {
    const { sourceSessionId, targetSessionId } = spec;
    const sourceDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sourceSessionId);
    const source = await sourceDoc.getMetaState();
    if (!source)
      return sessionForkFailure(spec, 'SOURCE_SESSION_NOT_FOUND', 'Source session was not found.');
    if (source.machineId !== this.deps.machineId) {
      return sessionForkFailure(
        spec,
        'MACHINE_ACCESS_DENIED',
        'Source session belongs to another machine.'
      );
    }
    if (source.isArchived) {
      return sessionForkFailure(
        spec,
        'SOURCE_SESSION_ARCHIVED',
        'Archived sessions cannot be forked.'
      );
    }
    const sourceBusy = this.deps.isSourceBusy(sourceSessionId);
    if (!source.acpSessionId || !source.agentConfigId) {
      return sessionForkFailure(
        spec,
        'FORK_UNAVAILABLE',
        'The source session has no forkable ACP runtime identity.'
      );
    }
    const reusedUser = this.deps.sessionManager
      .getSession(sourceSessionId)
      ?.getGitIdentityForUser?.(spec.requestedByUserId);

    const targetRoomId = getSessionRoomId(targetSessionId);
    const worktreeFork = spec.targetContext?.kind === 'new-worktree';
    // These four reads are independent, and two of them are slow: the merged
    // agent-config lookup scans the machine flock and user resolution is a
    // Convex query. Awaiting them in sequence put their sum on the fork click
    // path; the rejection order below is unchanged.
    const [targetExisting, sourceHistory, agentConfig, user] = await Promise.all([
      this.deps.workspaceDocument.repo.getDocMeta(targetRoomId),
      sourceDoc.getHistory(),
      this.deps.workspaceDocument.getAgentConfigById(source.agentConfigId, source.machineId),
      reusedUser ?? this.deps.userResolver.resolve(spec.requestedByUserId),
    ]);
    if (worktreeFork) {
      const targetDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(targetSessionId);
      const existingOperation = targetDoc.getForkOperation();
      if (existingOperation) {
        if (
          existingOperation.sourceSessionId !== sourceSessionId ||
          existingOperation.sourceTurnId !== spec.sourceTurnId ||
          existingOperation.requestedByUserId !== spec.requestedByUserId ||
          existingOperation.targetContext !== 'new-worktree'
        ) {
          return sessionForkFailure(
            spec,
            'TARGET_SESSION_CONFLICT',
            'Target session id is already reserved by another fork.'
          );
        }
        if (existingOperation.state === 'failed' && existingOperation.error) {
          return {
            ...sessionForkFailure(
              spec,
              existingOperation.error.code,
              existingOperation.error.message
            ),
            disposition: 'failed',
            operationId: existingOperation.id,
          };
        }
        return {
          type: 'session/fork_response',
          sourceSessionId,
          targetSessionId,
          success: true,
          partial: false,
          warnings: [],
          disposition: 'accepted',
          operationId: existingOperation.id,
        };
      }
      if (targetExisting && !('deletedAt' in targetExisting)) {
        const targetMeta = targetExisting.meta as SessionMeta | undefined;
        if (targetMeta?.acpSessionId) {
          return {
            type: 'session/fork_response',
            sourceSessionId,
            targetSessionId,
            success: true,
            partial: false,
            warnings: [],
            disposition: 'completed',
            operationId: `session-fork:${targetSessionId}`,
          };
        }
        return sessionForkFailure(
          spec,
          'TARGET_SESSION_CONFLICT',
          'Target session id already exists.'
        );
      }
    }
    if (targetExisting && !('deletedAt' in targetExisting)) {
      return sessionForkFailure(
        spec,
        'TARGET_SESSION_CONFLICT',
        'Target session id already exists.'
      );
    }

    const sourceTitle = source.title?.trim() || 'Untitled session';
    // One expression shared by the target meta and the recovery marker so a
    // repaired session can never drift from a normally-forked one's title.
    const forkTitle = `(fork) ${sourceTitle}`;
    const historyResult = cloneHistoryThroughTurn(
      sourceHistory,
      spec.sourceTurnId,
      sourceSessionId,
      sourceTitle,
      targetSessionId,
      { allowActiveTurnSuffix: sourceBusy }
    );
    if (!historyResult) {
      return sessionForkFailure(
        spec,
        'SOURCE_TURN_NOT_FORKABLE',
        'This assistant message has no ACP turn boundary.'
      );
    }

    if (!agentConfig) {
      return sessionForkFailure(
        spec,
        'FORK_UNAVAILABLE',
        'The source agent configuration is unavailable.'
      );
    }

    const forkSessionTurnId = historyResult.acpTurnId;
    if (sourceBusy) {
      const sourceRuntime = this.deps.sessionManager.getSession(sourceSessionId);
      const sourceAgent = sourceRuntime?.agentClient;
      if (
        !sourceRuntime?.acpSessionId ||
        sourceRuntime.acpSessionId !== source.acpSessionId ||
        !sourceAgent?.supportsActiveTurnFork() ||
        !forkSessionTurnId
      ) {
        return sessionForkFailure(
          spec,
          'SOURCE_SESSION_BUSY',
          'The active agent cannot fork before its current turn.'
        );
      }
    }

    if (worktreeFork) {
      if (
        !source.project ||
        (source.project.kind !== 'local' && source.project.kind !== 'github')
      ) {
        return sessionForkFailure(
          spec,
          'SOURCE_PROJECT_NOT_WORKTREE_CAPABLE',
          'This session is not attached to a Git worktree-capable project.'
        );
      }
      let sourceWorkdir: string;
      try {
        sourceWorkdir = await this.deps.sessionManager.resolveSessionWorkdir(sourceSessionId);
      } catch (error) {
        return sessionForkFailure(
          spec,
          'SOURCE_PROJECT_NOT_WORKTREE_CAPABLE',
          error instanceof Error ? error.message : 'The source workspace is unavailable.'
        );
      }
      let sourceWasDirty: boolean;
      let capturedHeadSha: string;
      try {
        const gitState = await (this.deps.inspectGitWorkdir
          ? this.deps.inspectGitWorkdir(sourceWorkdir)
          : this.inspectGitWorkdir(sourceWorkdir));
        sourceWasDirty = gitState.dirty;
        if (
          sourceWasDirty &&
          !(
            spec.targetContext?.kind === 'new-worktree' &&
            spec.targetContext.acknowledgeDirtySource === true
          )
        ) {
          return {
            ...sessionForkFailure(
              spec,
              'SOURCE_WORKTREE_DIRTY',
              'Uncommitted and untracked files will not be copied to the new worktree.'
            ),
            disposition: 'confirmation-required',
            reason: 'SOURCE_WORKTREE_DIRTY',
          };
        }
        capturedHeadSha = gitState.headSha;
        if (!/^[0-9a-f]{40,64}$/u.test(capturedHeadSha)) {
          throw new Error('Git returned an invalid commit id.');
        }
      } catch (error) {
        return sessionForkFailure(
          spec,
          'SOURCE_HEAD_UNAVAILABLE',
          error instanceof Error ? error.message : 'The source HEAD could not be captured.'
        );
      }

      const nowIso = new Date(getServerNow()).toISOString();
      const operation: SessionForkOperation = {
        id: `session-fork:${targetSessionId}`,
        sourceSessionId,
        sourceTurnId: spec.sourceTurnId,
        requestedByUserId: spec.requestedByUserId,
        targetContext: 'new-worktree',
        capturedHeadSha,
        sourceWasDirty,
        state: 'preparing',
        phase: 'preparing-worktree',
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const targetProject: ProjectRef =
        source.project.kind === 'local' ? { ...source.project, useWorktree: true } : source.project;
      const targetRepoFullName =
        source.repoFullName ??
        (targetProject.kind === 'github'
          ? targetProject.repoFullName
          : targetProject.githubRepoFullName);
      const targetWorkdir =
        targetProject.kind === 'local'
          ? await this.deps.sessionManager.resolveLocalProjectRootPath(targetProject.localProjectId)
          : undefined;
      if (targetProject.kind === 'local' && !targetWorkdir) {
        return sessionForkFailure(
          spec,
          'SOURCE_PROJECT_NOT_WORKTREE_CAPABLE',
          'The local project root is unavailable on this machine.'
        );
      }
      const now = getServerNow();
      const targetMeta: SessionMeta = {
        id: targetSessionId,
        machineId: source.machineId,
        createdAt: new Date(now).toISOString(),
        lastMessageAt: now,
        title: forkTitle,
        titleSource: 'generated',
        userId: spec.requestedByUserId,
        status: SessionStatusFactory.initializing(undefined, 'Creating fork worktree'),
        isArchived: false,
        cliType: source.cliType,
        agentType: source.agentType,
        agentConfigId: source.agentConfigId,
        project: targetProject,
        repoFullName: targetRepoFullName,
        baseBranch: source.branchName ?? source.baseBranch,
        isWorktree: true,
      };
      const branch = source.branchName ?? source.baseBranch;
      const marker: SessionForkOperationMarker = {
        version: 1,
        workspaceId: this.deps.workspaceId,
        machineId: this.deps.machineId,
        targetSessionId,
        operationId: operation.id,
        createdAt: operation.createdAt,
        title: forkTitle,
        cleanup: {
          project: targetProject,
          ...(targetRepoFullName ? { repoFullName: targetRepoFullName } : {}),
          ...(branch ? { branch } : {}),
          ...(targetWorkdir ? { workdir: targetWorkdir } : {}),
          requesterUserId: spec.requestedByUserId,
          agentConfigId: source.agentConfigId,
          cliType: source.cliType,
          agentType: source.agentType,
        },
      };
      // Fail-closed: record the recovery marker before the target doc exists,
      // so every durable preparing operation stays discoverable after a
      // restart. The lock pairs with startup recovery — whichever side holds
      // it sees the other's writes.
      const acceptFailure = await withForkOperationLock(targetSessionId, async () => {
        try {
          await this.deps.forkOperationStore.record(marker);
        } catch (error) {
          return sessionForkFailure(
            spec,
            'TARGET_WRITE_FAILED',
            error instanceof Error ? error.message : 'The fork operation could not be persisted.'
          );
        }
        this.activeOperations.add(operation.id);
        let doc: WorktreeForkPreparedInput['targetDoc'] | undefined;
        try {
          doc = await this.deps.workspaceDocument.getOrCreateSessionDoc(targetSessionId);
          doc.setForkOperation(operation);
          await this.deps.workspaceDocument.persistPendingChanges('session-fork-prepare');
        } catch (error) {
          doc?.setForkOperation(undefined);
          this.activeOperations.delete(operation.id);
          await this.deps.forkOperationStore.clear(targetSessionId).catch(() => {});
          return sessionForkFailure(
            spec,
            'TARGET_WRITE_FAILED',
            error instanceof Error ? error.message : 'The fork operation could not be persisted.'
          );
        }
        return undefined;
      });
      if (acceptFailure) {
        return acceptFailure;
      }
      const targetDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(targetSessionId);

      const preparedInput: WorktreeForkPreparedInput = {
        spec,
        source,
        sourceTitle,
        targetDoc,
        targetMeta,
        marker,
        historyResult,
        agentConfig,
        user,
        operation,
        ...(targetWorkdir ? { targetWorkdir } : {}),
      };
      setImmediate(() => {
        void this.executeWorktreeFork(preparedInput);
      });
      return {
        type: 'session/fork_response',
        sourceSessionId,
        targetSessionId,
        success: true,
        partial: false,
        warnings: [],
        disposition: 'accepted',
        operationId: operation.id,
      };
    }

    const now = getServerNow();
    const parentSessionId = source.parentSessionId ?? source.id;
    const targetMeta: SessionMeta = {
      id: targetSessionId,
      machineId: source.machineId,
      createdAt: new Date(now).toISOString(),
      lastMessageAt: now,
      title: forkTitle,
      titleSource: 'generated',
      userId: spec.requestedByUserId,
      status: SessionStatusFactory.initializing(),
      isArchived: false,
      cliType: source.cliType,
      agentType: source.agentType,
      agentConfigId: source.agentConfigId,
      project: source.project,
      repoFullName: source.repoFullName,
      baseBranch: source.baseBranch,
      branchName: source.branchName,
      isWorktree: source.isWorktree,
      parentSessionId,
      ...(spec.targetPlacement ? { childSessionPlacement: spec.targetPlacement } : {}),
    };

    let targetPrepared = false;
    try {
      await this.deps.workspaceDocument.repo.upsertDocMeta(targetRoomId, targetMeta);
      const targetDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(targetSessionId);
      await this.deps.workspaceDocument.persistPendingChanges('session-fork-prepare');
      targetPrepared = true;

      try {
        await this.deps.sessionManager.createSession(
          {
            workspaceId: this.deps.workspaceId as never,
            requesterUserId: spec.requestedByUserId,
            machineId: source.machineId,
            agentConfigId: source.agentConfigId,
            agentCliType: source.cliType,
            agentType: source.agentType,
            mcpServerIds: resolveSessionMcpSelection(historyResult.history),
            taskToolsEnabled: resolveSessionTaskToolsEnabled(historyResult.history),
            scheduleToolsEnabled: resolveSessionScheduleToolsEnabled(historyResult.history),
            customAcp: agentConfig.customAcp,
            runtimeOverrides: agentConfig.runtimeOverrides,
            env: agentConfig.env,
            project: source.project,
            sessionId: targetSessionId,
            assumeDocExisting: true,
            title: targetMeta.title,
            githubRepo: source.repoFullName,
            branch: source.baseBranch,
            parentSessionId,
            userName: user.name,
            userEmail: user.email,
          },
          {
            forkSessionId: source.acpSessionId,
            forkSessionTurnId,
            deferAcpSessionIdPersistence: true,
          }
        );
      } catch (error) {
        throw new SessionForkOperationError(
          'ACP_FORK_FAILED',
          'The ACP session could not be forked.',
          error
        );
      }
      const targetSession = this.deps.sessionManager.getSession(targetSessionId);
      if (!targetSession?.acpSessionId) {
        throw new SessionForkOperationError(
          'ACP_FORK_FAILED',
          'The ACP fork did not return a target session id.',
          null
        );
      }
      try {
        await this.deps.workspaceDocument.repo.upsertDocMeta(targetRoomId, {
          acpSessionId: targetSession.acpSessionId,
          status: SessionStatusFactory.idle(),
        });
        await targetDoc.updateHistory(() => historyResult.history);
        await this.deps.workspaceDocument.persistPendingChanges('session-fork-commit');
      } catch (error) {
        throw new SessionForkOperationError(
          'TARGET_WRITE_FAILED',
          'The forked session could not be saved locally.',
          error
        );
      }
      return {
        type: 'session/fork_response',
        sourceSessionId: spec.sourceSessionId,
        targetSessionId: spec.targetSessionId,
        success: true,
        partial: historyResult.warnings.length > 0,
        warnings: historyResult.warnings,
      };
    } catch (error) {
      if (targetPrepared) {
        await this.deps.sessionManager.terminateSession(targetSessionId, true).catch(() => {});
      }
      await this.deps.workspaceDocument.repo.deleteDoc(targetRoomId).catch(() => {});
      await this.deps.workspaceDocument
        .persistPendingChanges('session-fork-rollback')
        .catch(() => {});
      const publicError =
        error instanceof SessionForkOperationError
          ? error
          : new SessionForkOperationError(
              'TARGET_WRITE_FAILED',
              'The fork target could not be prepared locally.',
              error
            );
      const detail = publicError.detail ?? error;
      this.deps.logger.error(
        `[${spec.sourceSessionId}] ACP session fork failed: ${
          detail instanceof Error ? detail.message : String(detail)
        }`
      );
      return sessionForkFailure(spec, publicError.code, publicError.message);
    }
  }

  private async inspectGitWorkdir(workdir: string): Promise<{ dirty: boolean; headSha: string }> {
    const status = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: workdir,
      windowsHide: true,
      timeout: 10_000,
    });
    const head = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: workdir,
      windowsHide: true,
      timeout: 10_000,
    });
    return { dirty: status.stdout.trim().length > 0, headSha: head.stdout.trim() };
  }

  private async executeWorktreeFork(input: WorktreeForkPreparedInput): Promise<void> {
    const {
      spec,
      source,
      targetDoc,
      targetMeta,
      marker,
      historyResult,
      agentConfig,
      user,
      operation,
      targetWorkdir,
    } = input;
    const targetSessionId = spec.targetSessionId;
    const targetRoomId = getSessionRoomId(targetSessionId);
    const targetProject = targetMeta.project;
    const config = {
      workspaceId: this.deps.workspaceId as never,
      requesterUserId: spec.requestedByUserId,
      machineId: source.machineId,
      agentConfigId: source.agentConfigId,
      agentCliType: source.cliType,
      agentType: source.agentType,
      mcpServerIds: resolveSessionMcpSelection(historyResult.history),
      taskToolsEnabled: resolveSessionTaskToolsEnabled(historyResult.history),
      scheduleToolsEnabled: resolveSessionScheduleToolsEnabled(historyResult.history),
      customAcp: agentConfig.customAcp,
      runtimeOverrides: agentConfig.runtimeOverrides,
      env: agentConfig.env,
      project: targetProject,
      sessionId: targetSessionId,
      assumeDocExisting: true,
      title: targetMeta.title,
      githubRepo: targetMeta.repoFullName,
      branch: source.branchName ?? source.baseBranch,
      worktreeStartPoint: operation.capturedHeadSha,
      deferWorktreeMetaPersistence: true,
      ...(targetWorkdir ? { workdir: targetWorkdir } : {}),
      userName: user.name,
      userEmail: user.email,
    };
    try {
      await this.deps.sessionManager.createSession(config, {
        forkSessionId: source.acpSessionId!,
        forkSessionTurnId: historyResult.acpTurnId,
        deferAcpSessionIdPersistence: true,
      });
      const targetSession = this.deps.sessionManager.getSession(targetSessionId);
      if (!targetSession?.acpSessionId) {
        throw new SessionForkOperationError(
          'ACP_FORK_FAILED',
          'The ACP fork did not return a target session id.',
          null
        );
      }
      const sessionWorkdir = targetSession.getWorkdir();
      const resolvedBranch = this.deps.resolveGitBranch
        ? await this.deps.resolveGitBranch(sessionWorkdir)
        : (
            await execFileAsync('git', ['branch', '--show-current'], {
              cwd: sessionWorkdir,
              windowsHide: true,
              timeout: 10_000,
            })
          ).stdout.trim() || undefined;
      const branchName = resolvedBranch ?? targetMeta.baseBranch;
      // Record the real branch name so a crash inside the commit block can
      // still republish complete meta from the marker. Best-effort: the marker
      // stays valid without it.
      await withForkOperationLock(targetSessionId, async () => {
        await this.deps.forkOperationStore.record({ ...marker, branchName }).catch(() => {});
      });
      await withForkOperationLock(targetSessionId, async () => {
        targetDoc.setForkOperation({
          ...operation,
          phase: 'committing',
          updatedAt: new Date(getServerNow()).toISOString(),
        });
        // Ordering contract: history BEFORE the flag clear (recovery's
        // no-operation branch relies on flag-clear being flush-atomic with a
        // landed history), meta record LAST (repo flushes are whole-repo, so a
        // durable acpSessionId then implies the doc writes are durable too).
        await targetDoc.updateHistory(() => historyResult.history);
        targetDoc.setForkOperation(undefined);
        await this.deps.workspaceDocument.repo.upsertDocMeta(targetRoomId, {
          ...targetMeta,
          acpSessionId: targetSession.acpSessionId,
          status: SessionStatusFactory.idle(),
          branchName,
        });
        await this.deps.workspaceDocument.persistPendingChanges('session-fork-commit');
        await this.deps.forkOperationStore.clear(targetSessionId).catch(() => {});
      });
    } catch (error) {
      await this.deps.sessionManager.terminateSession(targetSessionId, true).catch(() => {});
      await this.deps.sessionManager.cleanupForkWorktree(config).catch((cleanupError: unknown) => {
        this.deps.logger.error(
          `[${targetSessionId}] Failed to compensate fork worktree: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      });
      const publicError =
        error instanceof SessionForkOperationError
          ? error
          : new SessionForkOperationError(
              'WORKTREE_CREATE_FAILED',
              'The new worktree session could not be created.',
              error
            );
      await withForkOperationLock(targetSessionId, async () => {
        targetDoc.setForkOperation({
          ...operation,
          state: 'failed',
          error: { code: publicError.code, message: publicError.message },
          updatedAt: new Date(getServerNow()).toISOString(),
        });
        try {
          await this.deps.workspaceDocument.persistPendingChanges('session-fork-rollback');
          await this.deps.forkOperationStore.clear(targetSessionId).catch(() => {});
        } catch {
          // Keep the marker: the failed receipt may not be durable, so the next
          // startup re-runs this (idempotent) compensation.
        }
      });
      this.deps.logger.error(
        `[${spec.sourceSessionId}] Worktree session fork failed: ${
          publicError.detail instanceof Error
            ? publicError.detail.message
            : String(publicError.detail ?? error)
        }`
      );
    } finally {
      this.activeOperations.delete(operation.id);
    }
  }
}
