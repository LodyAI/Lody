import {
  getSessionRoomId,
  hasPendingUserTurnActivation,
  isLoroRepoDocDeleted,
  readSessionOperationTargets,
  type SessionId,
  type SessionMeta,
  type SessionTurnInputConfig,
} from '@lody/shared';
import type { AutomationOrigin, ConditionObservation } from '@lody/shared/automations';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { buildSessionArchiveMetaPatch } from '@/commands/session';
import { createSessionBackend } from './session-backend';
import type { SessionExecutionService } from './session-execution-service';

export type AutomationSessionAdmission = {
  sessionId: SessionId;
  turnId: string;
  userId: string;
  origin: AutomationOrigin;
};

/** Existing Session owner; Automations cannot commit lifecycle changes through metadata alone. */
export class SessionAutomationAuthority {
  constructor(
    private readonly deps: {
      manager: LoroDocumentManager;
      execution: SessionExecutionService;
      machineId: string;
      hasOtherWork(sessionId: SessionId): boolean;
      hasGoal(sessionId: SessionId): Promise<boolean>;
      nativeActivity(sessionId: SessionId): 'idle' | 'running' | 'background' | 'unknown';
      author(sessionId: SessionId): string | undefined;
    }
  ) {}

  private pendingAutomationWork:
    | ((sessionId: string, excludingInvocationId?: string) => boolean)
    | undefined;
  setPendingWork(check: SessionAutomationAuthority['pendingAutomationWork']): void {
    this.pendingAutomationWork = check;
  }
  setObservations(
    sink: import('./automation-observations').AutomationObservationSink | undefined
  ): void {
    this.deps.execution.setAutomationObservations(sink);
  }
  refreshCapacity(bindingId: string) {
    return this.deps.execution.refreshProviderRateLimits(
      bindingId as import('@lody/shared').AgentConfigId
    );
  }
  author(sessionId: SessionId): string | undefined {
    return this.deps.author(sessionId);
  }
  setAdmission(
    admit: ((args: AutomationSessionAdmission) => Promise<boolean>) | undefined,
    canSubmit?: (
      sessionId: SessionId,
      turnId: string,
      origin: AutomationOrigin,
      binding: import('./automation-observations').ProviderBinding | null
    ) => boolean,
    beforeAccept?: (args: AutomationSessionAdmission) => Promise<boolean>
  ): void {
    this.deps.execution.setAutomationAdmission(admit, canSubmit, beforeAccept);
  }
  acceptInput(args: {
    sessionId: SessionId;
    turnId: string;
    userId: string;
    config: SessionTurnInputConfig;
  }): Promise<boolean> {
    return this.deps.execution.acceptAutomationInput(args);
  }
  executionRelease(sessionId: SessionId, executionId: string, userId: string) {
    return this.deps.execution.automationExecutionRelease(sessionId, executionId, userId);
  }
  inputDisposition(sessionId: SessionId, turnId: string) {
    return this.deps.execution.automationInputDisposition(sessionId, turnId);
  }
  inputAccepted(sessionId: SessionId, userId: string, turnId: string): boolean {
    return this.deps.execution.automationInputAccepted(sessionId, userId, turnId);
  }
  guardInput<A>(sessionId: SessionId, userId: string, body: () => Promise<A>): Promise<A> {
    return this.deps.execution.guardAutomationAction([sessionId], userId, body);
  }
  async cancelInput(sessionId: SessionId, turnId: string): Promise<boolean> {
    const doc = await this.deps.manager.getOrCreateSessionDoc(sessionId);
    const backend = await createSessionBackend(doc);
    for (const item of await backend.getMessageQueue()) {
      if (item.userTurnId === turnId) await backend.removeMessageQueueItem(item.$cid);
    }
    const cancelled = await this.deps.execution.cancelAutomationInput(sessionId, turnId);
    await this.deps.manager.repo.flush();
    return cancelled;
  }
  private async inspect(
    meta: SessionMeta,
    userId: string,
    ignoreBarrier = false,
    excludingInvocationId?: string
  ): Promise<ConditionObservation> {
    if (meta.machineId !== this.deps.machineId)
      return { value: 'unknown', reason: 'owner_unavailable' };
    if (meta.userId !== userId) return { value: 'no', reason: 'permission_denied' };
    const execution = this.deps.execution.getExecutionSnapshot(meta.id);
    if (this.deps.execution.hasBlockedAutomationExecution(meta.id) || execution.releaseBlocked)
      return { value: 'unknown', reason: 'execution_release_unconfirmed' };
    if (
      execution.hasActiveTurn ||
      execution.hasBlockingPendingCreate ||
      (!ignoreBarrier && execution.hasRewriteBarrier) ||
      this.deps.hasOtherWork(meta.id)
    )
      return { value: 'no', reason: 'session_work_active' };
    if (hasPendingUserTurnActivation(meta)) return { value: 'no', reason: 'input_pending' };
    const doc = await this.deps.manager.getOrCreateSessionDoc(meta.id);
    const backend = await createSessionBackend(doc, meta);
    if ((await backend.getMessageQueue()).length) return { value: 'no', reason: 'queue_pending' };
    if (await this.deps.hasGoal(meta.id)) return { value: 'no', reason: 'goal_active' };
    if (this.pendingAutomationWork?.(meta.id, excludingInvocationId))
      return { value: 'no', reason: 'automation_work_pending' };
    const native = this.deps.nativeActivity(meta.id);
    if (native === 'unknown') return { value: 'unknown', reason: 'native_activity_unobserved' };
    if (native !== 'idle') return { value: 'no', reason: 'native_work_active' };
    return { value: 'yes', reason: 'session_settled' };
  }
  async settled(
    rootId: SessionId,
    userId: string,
    excludingInvocationId?: string
  ): Promise<ConditionObservation> {
    const group = await readSessionOperationTargets(this.deps.manager.repo, rootId, 'archive-tree');
    for (const meta of group) {
      const result = await this.inspect(meta, userId, false, excludingInvocationId);
      if (result.value !== 'yes') return result;
    }
    return { value: 'yes', reason: 'group_settled' };
  }
  async archived(rootId: SessionId): Promise<boolean> {
    const targets = await readSessionOperationTargets(this.deps.manager.repo, rootId, 'archive');
    return targets.every((meta) => meta.isArchived);
  }
  async archive(
    rootId: SessionId,
    userId: string,
    guard: () => Promise<ConditionObservation>,
    excludingInvocationId?: string
  ): Promise<ConditionObservation> {
    const group = await readSessionOperationTargets(this.deps.manager.repo, rootId, 'archive-tree');
    return this.deps.execution.guardAutomationAction(
      group.map((meta) => meta.id),
      userId,
      async () => {
        const releases: Array<() => void> = [];
        try {
          for (const meta of group) {
            const result = await this.inspect(meta, userId, false, excludingInvocationId);
            if (result.value !== 'yes') return result;
            const release = this.deps.execution.tryAcquireSessionRewriteBarrier(meta.id);
            if (!release) return { value: 'no', reason: 'session_admission_busy' };
            releases.push(release);
          }
          const guarded = await guard();
          if (guarded.value !== 'yes') return guarded;
          const current = await readSessionOperationTargets(
            this.deps.manager.repo,
            rootId,
            'archive-tree'
          );
          if (
            current
              .map((meta) => meta.id)
              .sort()
              .join('\0') !==
            group
              .map((meta) => meta.id)
              .sort()
              .join('\0')
          )
            return { value: 'unknown', reason: 'group_membership_changed' };
          for (const meta of current) {
            const result = await this.inspect(meta, userId, true, excludingInvocationId);
            if (result.value !== 'yes') return result;
          }
          const targets = await readSessionOperationTargets(
            this.deps.manager.repo,
            rootId,
            'archive'
          );
          // Commit the root last: it must not attest completion of a partial group write.
          for (const meta of [...targets.slice(1), targets[0]]) {
            const fresh = await this.deps.manager.repo.getDocMeta(getSessionRoomId(meta.id));
            if (
              !fresh?.meta ||
              isLoroRepoDocDeleted(fresh) ||
              hasPendingUserTurnActivation(fresh.meta as SessionMeta)
            )
              return { value: 'unknown', reason: 'session_changed' };
            await this.deps.manager.repo.upsertDocMeta(
              getSessionRoomId(meta.id),
              buildSessionArchiveMetaPatch()
            );
          }
          await this.deps.manager.repo.flush();
          return { value: 'yes', reason: 'session_archived' };
        } finally {
          for (const release of releases.reverse()) release();
        }
      }
    );
  }
}
