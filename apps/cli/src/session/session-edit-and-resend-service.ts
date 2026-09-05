import {
  buildPendingUserHistoryEntry,
  getServerNow,
  getSessionRoomId,
  isSessionGoalActive,
  normalizeSessionInputBlocks,
  resolveLatestSessionGoalFromHistory,
  resolveSessionMcpSelection,
  sessionEditAndResendFailure,
  SessionStatusFactory,
  type ACPSessionId,
  type McpServerId,
  type SessionEditAndResendResponse,
  type SessionEditAndResendSpec,
  type SessionHistoryInput,
  type SessionId,
  type SessionLegacyMetaFields,
  type SessionMeta,
  type SessionTurnInputConfig,
} from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import type { SessionExecutionService } from './session-execution-service';
import type { ISession, SessionManager } from './session-manager';
import type { SessionUserResolver } from './session-user-resolver';

type EditableTail = {
  userIndex: number;
  user: SessionHistoryInput;
  forkTurnId?: string;
};

export type SessionEditAndResendInput = Omit<SessionEditAndResendSpec, 'inputConfig'> & {
  inputConfig: SessionTurnInputConfig;
};

const findLastUserIndex = (history: readonly SessionHistoryInput[]): number => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') {
      return index;
    }
  }
  return -1;
};

const resolveEditableTail = (
  history: SessionHistoryInput[],
  expectedUserTurnId: string
): EditableTail | null => {
  const userIndex = findLastUserIndex(history);
  const user = history[userIndex];
  if (userIndex < 0 || !user || user.id !== expectedUserTurnId || user.role !== 'user') {
    return null;
  }
  if (
    user.status === 'pending_apply' ||
    (user.inputConfig as Record<string, unknown> | undefined)?._lodyDeliveryKind === 'steer'
  ) {
    return null;
  }

  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    if (entry.role === 'user') {
      // A preceding user without an intervening provider boundary is not the
      // first-message case and cannot be reconstructed safely.
      return null;
    }
    if (entry.role !== 'assistant') continue;
    if (entry.finished !== true || !entry.acpTurnId) {
      return null;
    }
    return { userIndex, user, forkTurnId: entry.acpTurnId };
  }

  return { userIndex, user };
};

export class SessionEditAndResendService {
  private readonly inFlight = new Map<string, Promise<SessionEditAndResendResponse>>();

  constructor(
    private readonly deps: {
      workspaceDocument: LoroDocumentManager;
      sessionManager: SessionManager;
      executionService: SessionExecutionService;
      userResolver: SessionUserResolver;
      logger: Logger;
      workspaceId: string;
      machineId: string;
      enqueueDispatch(sessionId: SessionId): void;
    }
  ) {}

  async editAndResend(spec: SessionEditAndResendInput): Promise<SessionEditAndResendResponse> {
    const key = `${spec.sessionId}:${spec.replacementUserTurnId}`;
    const existing = this.inFlight.get(key);
    if (existing) return await existing;
    const operation = this.editAndResendInner(spec).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return await operation;
  }

  private async editAndResendInner(
    spec: SessionEditAndResendInput
  ): Promise<SessionEditAndResendResponse> {
    if (spec.expectedUserTurnId === spec.replacementUserTurnId) {
      return sessionEditAndResendFailure(
        spec,
        'USER_TURN_NOT_EDITABLE',
        'The replacement user turn must use a new id.'
      );
    }
    const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(spec.sessionId);
    const meta = await sessionDoc.getMetaState();
    if (!meta) {
      return sessionEditAndResendFailure(spec, 'SESSION_NOT_FOUND', 'Session was not found.');
    }
    if (meta.machineId !== this.deps.machineId) {
      return sessionEditAndResendFailure(
        spec,
        'MACHINE_ACCESS_DENIED',
        'Session belongs to another machine.'
      );
    }
    if (meta.isArchived) {
      return sessionEditAndResendFailure(
        spec,
        'SESSION_ARCHIVED',
        'Archived sessions cannot be edited.'
      );
    }
    if (meta.cliType !== 'builtin' || (meta.agentType !== 'codex' && meta.agentType !== 'claude')) {
      return sessionEditAndResendFailure(
        spec,
        'UNSUPPORTED_AGENT',
        'Edit and resend is only available for builtin Codex and Claude Code.'
      );
    }

    const history = await sessionDoc.getHistory();
    const lastUserIndex = findLastUserIndex(history);
    if (history[lastUserIndex]?.id === spec.replacementUserTurnId) {
      return this.success(spec);
    }
    if (history[lastUserIndex]?.id !== spec.expectedUserTurnId) {
      return sessionEditAndResendFailure(
        spec,
        'STALE_USER_TURN',
        'The last user message changed before the edit was applied.'
      );
    }
    const editable = resolveEditableTail(history, spec.expectedUserTurnId);
    if (!editable) {
      return sessionEditAndResendFailure(
        spec,
        'USER_TURN_NOT_EDITABLE',
        'The last user message has no safe provider turn boundary.'
      );
    }

    const legacyMeta = meta as SessionMeta & SessionLegacyMetaFields;
    const latestGoal = resolveLatestSessionGoalFromHistory(history) ?? legacyMeta.latestGoal;
    const execution = this.deps.executionService.getExecutionSnapshot(spec.sessionId);
    if (meta.autoReview || execution.hasActiveAutomation || isSessionGoalActive(latestGoal)) {
      return sessionEditAndResendFailure(
        spec,
        'ACTIVE_AUTOMATION',
        'Edit and resend is unavailable while session automation is active.'
      );
    }

    const releaseBarrier = this.deps.executionService.tryAcquireSessionRewriteBarrier(
      spec.sessionId
    );
    if (!releaseBarrier) {
      return sessionEditAndResendFailure(
        spec,
        'INTERNAL_ERROR',
        'Another edit is already being applied.'
      );
    }

    let runtime: ISession | null = null;
    let preparedSessionId: ACPSessionId | null = null;
    let oldAcpSessionId: ACPSessionId | null = null;
    let committed = false;
    let commitEditable = editable;
    let commitMeta = meta;
    try {
      runtime = await this.getOrRestoreRuntime(
        meta,
        spec.requestedByUserId,
        resolveSessionMcpSelection(history),
        spec.inputConfig.taskToolsEnabled === true,
        spec.inputConfig.scheduleToolsEnabled === true
      );
      const agentClient = runtime.agentClient;
      oldAcpSessionId = runtime.acpSessionId;
      if (!agentClient || !oldAcpSessionId) {
        return sessionEditAndResendFailure(
          spec,
          'ACP_SESSION_UNAVAILABLE',
          'The current ACP session is unavailable.'
        );
      }
      if (meta.acpSessionId && oldAcpSessionId !== meta.acpSessionId) {
        return sessionEditAndResendFailure(
          spec,
          'ACP_SESSION_UNAVAILABLE',
          'The resident ACP session does not match the durable session identity.'
        );
      }

      try {
        const prepared = await agentClient.prepareReplacementSession(editable.forkTurnId);
        preparedSessionId = prepared.sessionId as ACPSessionId;

        const [freshMeta, freshHistory] = await Promise.all([
          sessionDoc.getMetaState(),
          sessionDoc.getHistory(),
        ]);
        const freshEditable = resolveEditableTail(freshHistory, spec.expectedUserTurnId);
        if (!freshMeta || !freshEditable || freshEditable.forkTurnId !== editable.forkTurnId) {
          await this.closePrepared(runtime, preparedSessionId);
          preparedSessionId = null;
          return sessionEditAndResendFailure(
            spec,
            'STALE_USER_TURN',
            'The editable history boundary changed while the provider session was prepared.'
          );
        }
        if (
          freshMeta.machineId !== meta.machineId ||
          freshMeta.cliType !== meta.cliType ||
          freshMeta.agentType !== meta.agentType ||
          freshMeta.acpSessionId !== meta.acpSessionId
        ) {
          await this.closePrepared(runtime, preparedSessionId);
          preparedSessionId = null;
          return sessionEditAndResendFailure(
            spec,
            'STALE_USER_TURN',
            'The session provider identity changed while the replacement was prepared.'
          );
        }
        if (freshMeta.isArchived) {
          await this.closePrepared(runtime, preparedSessionId);
          preparedSessionId = null;
          return sessionEditAndResendFailure(
            spec,
            'SESSION_ARCHIVED',
            'The session was archived while the replacement was prepared.'
          );
        }
        const freshLegacyMeta = freshMeta as SessionMeta & SessionLegacyMetaFields;
        const freshGoal =
          resolveLatestSessionGoalFromHistory(freshHistory) ?? freshLegacyMeta.latestGoal;
        const freshExecution = this.deps.executionService.getExecutionSnapshot(spec.sessionId);
        if (
          freshMeta.autoReview ||
          freshExecution.hasActiveAutomation ||
          isSessionGoalActive(freshGoal)
        ) {
          await this.closePrepared(runtime, preparedSessionId);
          preparedSessionId = null;
          return sessionEditAndResendFailure(
            spec,
            'ACTIVE_AUTOMATION',
            'Session automation started before the edit could be applied.'
          );
        }
        commitEditable = freshEditable;
        commitMeta = freshMeta;

        const activeTurnId = freshExecution.activeTurnId;
        if (activeTurnId) {
          if (
            this.deps.executionService.getActiveUserTurnId(spec.sessionId) !==
            spec.expectedUserTurnId
          ) {
            await this.closePrepared(runtime, preparedSessionId);
            preparedSessionId = null;
            return sessionEditAndResendFailure(
              spec,
              'ACTIVE_AUTOMATION',
              'Another logical turn owns the active ACP session.'
            );
          }
          const cancelled = await this.deps.executionService.cancelSession({
            type: 'session/cancel',
            sessionId: spec.sessionId,
            machineId: commitMeta.machineId,
            workspaceId: this.deps.workspaceId as never,
            turnId: activeTurnId,
          });
          if (!cancelled.success) {
            await this.closePrepared(runtime, preparedSessionId);
            preparedSessionId = null;
            return sessionEditAndResendFailure(
              spec,
              'CANCEL_FAILED',
              cancelled.error ?? 'The active turn could not be cancelled.'
            );
          }
          await this.deps.executionService.waitForTurnRelease(spec.sessionId, activeTurnId);
        }

        const preCommitMeta = await sessionDoc.getMetaState();
        const preCommitExecution = this.deps.executionService.getExecutionSnapshot(spec.sessionId);
        if (
          !preCommitMeta ||
          preCommitMeta.isArchived ||
          preCommitMeta.machineId !== commitMeta.machineId ||
          preCommitMeta.cliType !== commitMeta.cliType ||
          preCommitMeta.agentType !== commitMeta.agentType ||
          preCommitMeta.acpSessionId !== commitMeta.acpSessionId
        ) {
          await this.closePrepared(runtime, preparedSessionId);
          preparedSessionId = null;
          return sessionEditAndResendFailure(
            spec,
            'STALE_USER_TURN',
            'The session changed before the replacement could be committed.'
          );
        }
        if (preCommitMeta.autoReview || preCommitExecution.hasActiveAutomation) {
          await this.closePrepared(runtime, preparedSessionId);
          preparedSessionId = null;
          return sessionEditAndResendFailure(
            spec,
            'ACTIVE_AUTOMATION',
            'Session automation started before the replacement could be committed.'
          );
        }
        commitMeta = preCommitMeta;

        const inputConfig = this.buildReplacementInputConfig(
          commitMeta,
          commitEditable.user,
          spec.inputConfig,
          preparedSessionId
        );
        const inputBlocks = normalizeSessionInputBlocks(
          inputConfig.inputBlocks,
          inputConfig.prompt ?? ''
        );
        const pending = buildPendingUserHistoryEntry({
          userId: commitEditable.user.userId ?? spec.requestedByUserId,
          inputBlocks,
          timestamp: spec.timestamp,
          inputConfig,
        });
        if (!pending) {
          await this.closePrepared(runtime, preparedSessionId);
          preparedSessionId = null;
          return sessionEditAndResendFailure(
            spec,
            'USER_TURN_NOT_EDITABLE',
            'The replacement message is empty.'
          );
        }

        const replacement: SessionHistoryInput = {
          ...pending,
          id: spec.replacementUserTurnId,
        };
        let historyBeforeWrite: SessionHistoryInput[] | null = null;
        let previousUserId: string | undefined;
        await sessionDoc.updateHistory((currentHistory) => {
          const currentGoal =
            resolveLatestSessionGoalFromHistory(currentHistory) ??
            (commitMeta as SessionMeta & SessionLegacyMetaFields).latestGoal;
          if (isSessionGoalActive(currentGoal)) {
            throw new Error(
              '[ACTIVE_AUTOMATION] A session goal started before history replacement.'
            );
          }
          const currentEditable = resolveEditableTail(currentHistory, spec.expectedUserTurnId);
          if (!currentEditable || currentEditable.forkTurnId !== commitEditable.forkTurnId) {
            throw new Error(
              '[STALE_USER_TURN] The editable history boundary changed before commit.'
            );
          }
          historyBeforeWrite = currentHistory;
          const prefix = currentHistory.slice(0, currentEditable.userIndex);
          previousUserId = [...prefix].reverse().find((entry) => entry.role === 'user')?.id;
          return [...prefix, replacement];
        });
        try {
          await this.deps.workspaceDocument.repo.upsertDocMeta(getSessionRoomId(spec.sessionId), {
            acpSessionId: preparedSessionId,
            status: SessionStatusFactory.idle(),
            latestUserMsgId: spec.replacementUserTurnId,
            lastHandledUserMsgId: previousUserId,
            processingUserMsgId: undefined,
            lastCanceledTurn: undefined,
            lastMissingHistoryUserMsgId: undefined,
            lastMessageAt: getServerNow(),
          });
          await this.deps.workspaceDocument.persistPendingChanges('session-edit-and-resend-commit');
        } catch (error) {
          if (historyBeforeWrite) {
            await sessionDoc
              .updateHistory(() => historyBeforeWrite ?? [])
              .catch((rollbackError) => {
                this.deps.logger.error(
                  `[${spec.sessionId}] Failed to restore history after commit failure: ${formatErrorMessage(rollbackError)}`
                );
              });
          }
          await this.deps.workspaceDocument.repo
            .upsertDocMeta(getSessionRoomId(spec.sessionId), {
              acpSessionId: commitMeta.acpSessionId,
              status: commitMeta.status,
              latestUserMsgId: commitMeta.latestUserMsgId,
              lastHandledUserMsgId: commitMeta.lastHandledUserMsgId,
              processingUserMsgId: commitMeta.processingUserMsgId,
              lastCanceledTurn: commitMeta.lastCanceledTurn,
              lastMissingHistoryUserMsgId: commitMeta.lastMissingHistoryUserMsgId,
              lastMessageAt: commitMeta.lastMessageAt,
            })
            .catch((rollbackError) => {
              this.deps.logger.error(
                `[${spec.sessionId}] Failed to restore meta after commit failure: ${formatErrorMessage(rollbackError)}`
              );
            });
          await this.deps.workspaceDocument
            .persistPendingChanges('session-edit-and-resend-rollback')
            .catch(() => {});
          throw error;
        }

        agentClient.adoptPreparedSession(prepared);
        runtime.acpSessionId = preparedSessionId;
        committed = true;
      } catch (error) {
        if (preparedSessionId && runtime) {
          await this.closePrepared(runtime, preparedSessionId);
          preparedSessionId = null;
        }
        const message = formatErrorMessage(error);
        const code = message.includes('ACTIVE_AUTOMATION')
          ? 'ACTIVE_AUTOMATION'
          : message.includes('STALE_USER_TURN')
            ? 'STALE_USER_TURN'
            : message.includes('ACP_SESSION_UNAVAILABLE')
              ? 'ACP_SESSION_UNAVAILABLE'
              : message.includes('ACP_')
                ? 'ACP_FORK_FAILED'
                : 'HISTORY_WRITE_FAILED';
        this.deps.logger.error(`[${spec.sessionId}] Edit and resend failed: ${message}`);
        return sessionEditAndResendFailure(spec, code, message);
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      this.deps.logger.error(`[${spec.sessionId}] ACP runtime restore failed: ${message}`);
      return sessionEditAndResendFailure(spec, 'ACP_SESSION_UNAVAILABLE', message);
    } finally {
      releaseBarrier();
      // A watcher may have reached its final ownership check while the barrier
      // was held. Wake it on both success and failure so an unchanged old turn
      // or queue cannot remain pending without a new doc mutation.
      this.deps.enqueueDispatch(spec.sessionId);
    }

    if (!committed || !runtime || !preparedSessionId) {
      return sessionEditAndResendFailure(spec, 'INTERNAL_ERROR', 'Replacement was not committed.');
    }
    if (oldAcpSessionId && oldAcpSessionId !== preparedSessionId) {
      void runtime.agentClient?.closeDetachedSession(oldAcpSessionId).catch((error: unknown) => {
        this.deps.logger.debug(
          `[${spec.sessionId}] Failed to close replaced ACP session: ${formatErrorMessage(error)}`
        );
      });
    }
    return this.success(spec);
  }

  private buildReplacementInputConfig(
    meta: SessionMeta,
    original: SessionHistoryInput,
    replacement: SessionTurnInputConfig,
    preparedSessionId: ACPSessionId
  ): SessionTurnInputConfig {
    return {
      ...original.inputConfig,
      ...replacement,
      cliType: meta.cliType,
      agentType: meta.agentType,
      resume: preparedSessionId,
    };
  }

  private async getOrRestoreRuntime(
    meta: SessionMeta,
    requestedByUserId: string,
    mcpServerIds: McpServerId[],
    taskToolsEnabled: boolean,
    scheduleToolsEnabled: boolean
  ): Promise<ISession> {
    const existing = this.deps.sessionManager.getSession(meta.id);
    if (existing) return existing;
    if (!meta.acpSessionId || !meta.agentConfigId) {
      throw new Error('The session has no resumable ACP runtime identity.');
    }
    const [agentConfig, user] = await Promise.all([
      this.deps.workspaceDocument.getAgentConfigById(meta.agentConfigId, meta.machineId),
      this.deps.userResolver.resolve(requestedByUserId),
    ]);
    if (!agentConfig) {
      throw new Error('The session agent configuration is unavailable.');
    }
    return await this.deps.sessionManager.createSession(
      {
        workspaceId: this.deps.workspaceId as never,
        requesterUserId: requestedByUserId,
        machineId: meta.machineId,
        agentConfigId: meta.agentConfigId,
        agentCliType: meta.cliType,
        agentType: meta.agentType,
        mcpServerIds,
        taskToolsEnabled,
        scheduleToolsEnabled,
        customAcp: agentConfig.customAcp,
        runtimeOverrides: agentConfig.runtimeOverrides,
        env: agentConfig.env,
        project: meta.project,
        sessionId: meta.id,
        assumeDocExisting: true,
        resume: true,
        title: meta.title,
        githubRepo: meta.repoFullName,
        branch: meta.baseBranch,
        restoreBranchName: meta.branchName,
        parentSessionId: meta.parentSessionId,
        userName: user.name,
        userEmail: user.email,
      },
      {
        resumeSessionId: meta.acpSessionId,
        deferAcpSessionIdPersistence: true,
      }
    );
  }

  private async closePrepared(runtime: ISession, sessionId: ACPSessionId): Promise<void> {
    await runtime.agentClient?.closeDetachedSession(sessionId).catch(() => false);
  }

  private success(spec: SessionEditAndResendInput): SessionEditAndResendResponse {
    return {
      type: 'session/edit-and-resend_response',
      sessionId: spec.sessionId,
      replacementUserTurnId: spec.replacementUserTurnId,
      success: true,
    };
  }
}
