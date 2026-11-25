import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  resolveSessionPullRequests,
  getCurrentPullRequestsByRepository,
  type AgentConfigId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  automationInvocationSchema,
  automationOriginSchema,
  type AutomationOrigin,
  type AutomationReceipt,
  type AutomationRule,
  type ConditionObservation,
} from '@lody/shared/automations';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import {
  providerBindingFingerprint,
  type ProviderBinding,
} from '@/session/automation-observations';
import type { SessionAutomationAuthority } from '@/session/session-automation-authority';
import type { AutomationLedger } from '../storage/ledger';
import type { ActionAuthorization } from '../runtime/engine';
import { checkWorkflowEvidence } from '../sources/workflows';
import { isQuotaRecoveryReceipt } from '../conditions/evaluator';

export const sessionActionSchema = z.object({ sessionId: z.string().min(1) });
export const compactActionSchema = sessionActionSchema
  .extend({ idleTurnId: z.string().min(1), expiresAt: z.number().int().positive() })
  .strict();

const durableSessionDenials = new Set([
  'invocation_revoked',
  'authorization_revoked',
  'target_not_granted',
  'target_permission_revoked',
  'target_deleted',
  'pending_work_target_mismatch',
  'pending_work_binding_changed',
  'pending_work_superseded',
  'pending_work_ended',
  'pending_work_already_claimed',
  'workflow_target_changed',
]);

/** `'no'` verdicts only new authority or target state could lift; callers converge, never re-verify. */
export const isDurableSessionDenial = (observation: ActionAuthorization): boolean =>
  observation.terminalState !== undefined ||
  durableSessionDenials.has(observation.reason) ||
  observation.reason.startsWith('guard:');

const preparedOrigin = z.union([
  z
    .object({
      kind: z.literal('queue'),
      config: z.object({ _lodyAutomation: automationOriginSchema }),
    })
    .transform((value) => value.config._lodyAutomation),
  z
    .object({
      kind: z.literal('create'),
      input: z.object({
        userTurn: z.object({
          inputConfig: z.object({ _lodyAutomation: automationOriginSchema }),
        }),
      }),
    })
    .transform((value) => value.input.userTurn.inputConfig._lodyAutomation),
]);

export function matchesPreparedOrigin(
  receipt: AutomationReceipt,
  origin: AutomationOrigin
): boolean {
  const expected = preparedOrigin.safeParse(receipt.prepared);
  return expected.success && isDeepStrictEqual(expected.data, origin);
}

/** A revision can revoke accepted work, but cannot enlarge its original authority. */
export function retainsAutomationGrant(
  receipt: AutomationReceipt,
  current: AutomationRule | undefined
): boolean {
  if (
    !current?.enabled ||
    current.ownerUserId !== receipt.rule.ownerUserId ||
    current.ownerMachineId !== receipt.rule.ownerMachineId ||
    current.scope.workspaceId !== receipt.rule.scope.workspaceId
  )
    return false;
  const action = receipt.intent.action;
  const grants = [receipt.rule.grants, current.grants];
  if (!grants.every((grant) => grant.actions.includes(action.kind))) return false;
  if (action.kind === 'agent.invoke') {
    const invocation = automationInvocationSchema.safeParse(action.parameters);
    if (!invocation.success) return false;
    const { target, requiredCapacity } = invocation.data;
    if (
      requiredCapacity &&
      !grants.every((grant) => grant.bindingIds.includes(requiredCapacity.bindingId))
    )
      return false;
    if (target.kind === 'new')
      return grants.every((grant) => grant.agentRoleIds.includes(target.agentRoleId));
    return grants.every(
      (grant) =>
        grant.sessionIds.includes(target.sessionId) ||
        (grant.allowLinkedSession && receipt.event.scope.sessionId === target.sessionId)
    );
  }
  const sessionId = action.parameters.sessionId;
  return (
    typeof sessionId === 'string' &&
    grants.every(
      (grant) =>
        grant.sessionIds.includes(sessionId) ||
        (grant.allowLinkedSession && receipt.event.scope.sessionId === sessionId)
    )
  );
}

/**
 * Synchronous Inbox-gate admission check. Runs inside the Session Inbox gate, so
 * it must stay strictly synchronous and read only the local ledger snapshot.
 */
export function canSubmitAutomationInput(
  ledger: AutomationLedger,
  sessionId: SessionId,
  turnId: string,
  origin: AutomationOrigin,
  binding?: ProviderBinding | null
): boolean {
  const receipt = ledger.receipt(origin.invocationId);
  const rule = receipt && ledger.rule(receipt.rule.id);
  const work = origin.workIntentId ? ledger.work(origin.workIntentId) : undefined;
  // Credential-derived launch fingerprints stay in this private ledger, never queued history.
  if (
    origin.workIntentId &&
    (!work ||
      work.invocationId !== origin.invocationId ||
      ['settled', 'cancelled', 'failed', 'unknown'].includes(work.state) ||
      (binding !== undefined &&
        (!binding ||
          binding.bindingId !== work.bindingId ||
          binding.fingerprint !== work.fingerprint)))
  )
    return false;
  return (
    !!receipt &&
    checkWorkflowEvidence(ledger, receipt.evidence ?? [], Date.now()).value === 'yes' &&
    retainsAutomationGrant(receipt, rule) &&
    matchesPreparedOrigin(receipt, origin) &&
    (!origin.maintenance || origin.maintenance.expiresAt > Date.now()) &&
    receipt.sessionId === sessionId &&
    receipt.turnId === turnId &&
    receipt.rule.ownerUserId === origin.authorizationUserId &&
    receipt.rule.id === origin.ruleId &&
    receipt.rule.revision === origin.ruleRevision &&
    ['submitting', 'queued', 'running', 'resolved', 'blocked'].includes(receipt.state)
  );
}

export type ReceiptAuthorizationDeps = {
  ledger: AutomationLedger;
  manager: LoroDocumentManager;
  authority: SessionAutomationAuthority;
  machineId: MachineId;
  userId: string;
  workspaceId: string;
  capacity(
    bindingId: string,
    modelId: string | undefined,
    receipt: AutomationReceipt
  ): Promise<ConditionObservation>;
};

/** Full asynchronous authorization check shared by engine checks, submit, and admission recheck. */
export async function authorizeAutomationReceipt(
  deps: ReceiptAuthorizationDeps,
  receipt: AutomationReceipt
): Promise<ActionAuthorization> {
  const { ledger, manager, authority, machineId, userId, workspaceId } = deps;
  const latest = ledger.receipt(receipt.id);
  if (latest && ['cancelling', 'cancelled', 'superseded'].includes(latest.state))
    return { value: 'no', reason: 'invocation_revoked' };
  const current = ledger.rule(receipt.rule.id);
  if (
    !current?.enabled ||
    current.ownerMachineId !== machineId ||
    current.scope.workspaceId !== workspaceId ||
    !retainsAutomationGrant(receipt, current)
  )
    return { value: 'no', reason: 'authorization_revoked' };
  const action = receipt.intent.action;
  let sessionId: string;
  let unavailableFails = false;
  if (action.kind === 'agent.invoke') {
    const invocation = automationInvocationSchema.parse(action.parameters);
    const work =
      invocation.input.kind === 'pending_work' ? ledger.work(invocation.input.ref) : undefined;
    const quotaRecovery = isQuotaRecoveryReceipt(receipt);
    if (invocation.input.kind === 'pending_work') {
      if (
        !work ||
        invocation.target.kind !== 'existing' ||
        invocation.target.sessionId !== work.sessionId
      )
        return { value: 'no', reason: 'pending_work_target_mismatch' };
      if (work.unresolvedEffects || work.release !== 'released')
        return { value: 'unknown', reason: 'pending_work_boundary_unconfirmed' };
      if (
        ['cancelled', 'settled', 'failed', 'unknown'].includes(work.state) ||
        (work.invocationId && work.invocationId !== receipt.id)
      )
        return { value: 'no', reason: 'pending_work_ended', terminalState: 'superseded' };
      const config = await manager.getAgentConfigForMachineLaunch(
        work.bindingId as AgentConfigId,
        machineId
      );
      if (!config || providerBindingFingerprint(config) !== work.fingerprint)
        return { value: 'no', reason: 'pending_work_binding_changed' };
      const target = await manager.repo.getDocMeta(getSessionRoomId(work.sessionId as SessionId));
      const meta = target?.meta as SessionMeta | undefined;
      if (!target || !meta || isLoroRepoDocDeleted(target))
        return { value: 'unknown', reason: 'target_unavailable' };
      if (
        meta.acpSessionId !== work.nativeSessionId ||
        (meta.latestUserMsgId !== work.turnId && meta.latestUserMsgId !== receipt.turnId)
      )
        return { value: 'no', reason: 'pending_work_superseded', terminalState: 'superseded' };
      if (!quotaRecovery && work.notBefore !== undefined && work.notBefore > Date.now())
        return { value: 'no', reason: 'capacity_reset_not_due', retryAt: work.notBefore };
    }
    const capacity = work
      ? { bindingId: work.bindingId, modelId: work.modelId }
      : invocation.requiredCapacity;
    if (capacity) {
      const available = await deps.capacity(capacity.bindingId, capacity.modelId, receipt);
      if (available.value !== 'yes') {
        const attemptGranted =
          work &&
          !quotaRecovery &&
          available.value === 'unknown' &&
          [receipt.rule.grants, current.grants].every((grant) => grant.allowCapacityAttempt) &&
          work.notBefore !== undefined &&
          work.notBefore <= Date.now();
        if (!attemptGranted) return available;
      }
    }
    if (invocation.target.kind === 'new') {
      if (current.ownerUserId !== userId)
        return { value: 'no', reason: 'target_permission_revoked' };
      if (
        !current.grants.agentRoleIds.includes(invocation.target.agentRoleId) ||
        invocation.target.machineId !== machineId
      )
        return { value: 'unknown', reason: 'target_owner_unavailable' };
      return { value: 'yes', reason: 'role_granted' };
    }
    sessionId = invocation.target.sessionId;
    unavailableFails = invocation.target.onUnavailable === 'fail';
  } else {
    sessionId = sessionActionSchema.parse(action.parameters).sessionId;
  }
  if (
    !current.grants.sessionIds.includes(sessionId) &&
    !(current.grants.allowLinkedSession && receipt.event.scope.sessionId === sessionId)
  )
    return { value: 'no', reason: 'target_not_granted' };
  const record = await manager.repo.getDocMeta(getSessionRoomId(sessionId as SessionId));
  const meta = record?.meta as SessionMeta | undefined;
  if (!record || !meta || isLoroRepoDocDeleted(record))
    return {
      value: 'unknown',
      reason: 'target_unavailable',
      ...(unavailableFails ? { terminalState: 'failed' } : {}),
    };
  if (meta.machineId !== machineId) return { value: 'unknown', reason: 'target_owner_unavailable' };
  const access = await authority.canEdit(sessionId as SessionId, current.ownerUserId);
  if (access === 'no') return { value: 'no', reason: 'target_permission_revoked' };
  if (access === 'unknown') return { value: 'unknown', reason: 'target_permission_unconfirmed' };
  if (receipt.evidence?.length) {
    const linked = new Set(
      getCurrentPullRequestsByRepository(resolveSessionPullRequests(meta)).map((pr) => pr.url)
    );
    if (receipt.evidence.some((item) => item.sessionId !== sessionId || !linked.has(item.prUrl)))
      return { value: 'no', reason: 'workflow_target_changed', terminalState: 'superseded' };
    const evidence = checkWorkflowEvidence(ledger, receipt.evidence, Date.now());
    if (evidence.value !== 'yes')
      return {
        ...evidence,
        ...(evidence.value === 'no' ? { terminalState: 'superseded' as const } : {}),
      };
  }
  if (action.kind === 'session.compact') {
    const compact = compactActionSchema.parse(action.parameters);
    if (compact.expiresAt <= Date.now())
      return { value: 'no', reason: 'guard:maintenance_deadline_expired' };
    if (
      (meta.latestUserMsgId !== compact.idleTurnId && meta.latestUserMsgId !== receipt.turnId) ||
      meta.lastHandledUserMsgId !== compact.idleTurnId
    )
      return { value: 'no', reason: 'guard:maintenance_input_changed' };
  }
  if (meta.isArchived) {
    if (action.kind === 'session.archive' && (await authority.archived(sessionId as SessionId)))
      return { value: 'yes', reason: 'archive_already_committed' };
    return {
      value: 'no',
      reason: 'target_archived',
      ...(unavailableFails ? { terminalState: 'failed' } : {}),
    };
  }
  // Stop stays transient even when `onUnavailable === 'fail'` (2026-10-30 Stop contract).
  if (meta.collaborationStopped) return { value: 'no', reason: 'target_stopped' };
  return { value: 'yes', reason: 'authorized' };
}
