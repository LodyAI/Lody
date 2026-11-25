import {
  getCurrentPullRequestsByRepository,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  parseGitHubPullRequestUrl,
  resolveSessionPullRequests,
  type AgentConfigId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  automationInvocationSchema,
  automationOriginSchema,
  type AutomationCondition,
  type AutomationOrigin,
  type AutomationReceipt,
  type AutomationRule,
  type ConditionObservation,
} from '@lody/shared/automations';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { Lody } from '@/lib/lody';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import { createSessionBackend } from '@/session/session-backend';
import {
  providerBindingFingerprint,
  type ProviderBinding,
} from '@/session/automation-observations';
import type { SessionAutomationAuthority } from '@/session/session-automation-authority';
import type { AutomationLedger } from '../storage/ledger';
import { TERMINAL_WORK_STATES } from '../storage/schema';
import type { ActionAuthorization } from '../runtime/engine';
import { evaluateCapacity } from '../runtime/capacity';
import { isQuotaRecoveryReceipt, quotaRecoveryRetryAt } from '../policies/session';
import { deliveryStepCurrent } from '../policies/delivery';
import { pullRequestCheckpointId } from '../sources/pull-requests';
import { checkWorkflowEvidence } from '../sources/workflows';

export const sessionActionSchema = z.object({ sessionId: z.string().min(1) });
export const compactActionSchema = sessionActionSchema
  .extend({ idleTurnId: z.string().min(1), expiresAt: z.number().int().positive() })
  .strict();

const durableSessionDenials: ReadonlySet<string> = new Set([
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

export const isDurableSessionDenialReason = (reason: string): boolean =>
  durableSessionDenials.has(reason) || reason.startsWith('guard:');

/** `'no'` verdicts only new authority or target state could lift; callers converge, never re-verify. */
export const isDurableSessionDenial = (observation: ActionAuthorization): boolean =>
  observation.value !== 'yes' &&
  (observation.terminalState !== undefined || isDurableSessionDenialReason(observation.reason));

export type SessionMetaRead =
  | { status: 'deleted' }
  | { status: 'missing' }
  | { status: 'ok'; meta: SessionMeta };

export async function readSessionMeta(
  manager: LoroDocumentManager,
  sessionId: SessionId
): Promise<SessionMetaRead> {
  const record = await manager.repo.getDocMeta(getSessionRoomId(sessionId));
  if (record && isLoroRepoDocDeleted(record)) return { status: 'deleted' };
  const meta = record?.meta as SessionMeta | undefined;
  return meta ? { status: 'ok', meta } : { status: 'missing' };
}

export async function evaluateBindingCapacity(
  deps: { manager: LoroDocumentManager; ledger: AutomationLedger; machineId: MachineId },
  bindingId: string,
  modelId: string | undefined,
  now: number
): Promise<
  | { status: 'unavailable' }
  | { status: 'evaluated'; fingerprint: string; observation: ConditionObservation }
> {
  const config = await deps.manager.getAgentConfigForMachineLaunch(
    bindingId as AgentConfigId,
    deps.machineId
  );
  if (!config) return { status: 'unavailable' };
  const fingerprint = providerBindingFingerprint(config);
  const snapshot = deps.ledger.capacity(bindingId, modelId) ?? deps.ledger.capacity(bindingId);
  return {
    status: 'evaluated',
    fingerprint,
    observation: evaluateCapacity(snapshot, { bindingId, fingerprint, modelId }, now),
  };
}

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
 * Synchronous Inbox-gate admission check. Runs inside `SessionExecutionService`'s
 * Inbox gate, so it must stay strictly synchronous and read only the local ledger.
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
      TERMINAL_WORK_STATES.has(work.state) ||
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

export async function canAcceptPendingWork(
  deps: {
    ledger: AutomationLedger;
    manager: LoroDocumentManager;
    authority: SessionAutomationAuthority;
    machineId: MachineId;
  },
  args: { sessionId: SessionId; turnId: string; userId: string; origin: AutomationOrigin }
): Promise<boolean> {
  const { ledger, manager, authority, machineId } = deps;
  const { sessionId, turnId, userId, origin } = args;
  const work = origin.workIntentId && ledger.work(origin.workIntentId);
  if (!work || !canSubmitAutomationInput(ledger, sessionId, turnId, origin)) return false;
  const read = await readSessionMeta(manager, sessionId);
  if (read.status !== 'ok') return false;
  const { meta } = read;
  return (
    meta.machineId === machineId &&
    !meta.isArchived &&
    !meta.collaborationStopped &&
    meta.acpSessionId === work.nativeSessionId &&
    (meta.latestUserMsgId === work.turnId || meta.latestUserMsgId === turnId) &&
    (await authority.canEdit(sessionId, userId)) === 'yes'
  );
}

export async function observeCurrentPr(
  deps: { manager: LoroDocumentManager; ledger: AutomationLedger },
  receipt: AutomationReceipt,
  prUrl: string
): Promise<ConditionObservation> {
  const sessionId = receipt.event.scope.sessionId;
  if (!sessionId) return { value: 'unknown', reason: 'source_session_unlinked' };
  const read = await readSessionMeta(deps.manager, sessionId as SessionId);
  if (read.status !== 'ok') return { value: 'unknown', reason: 'source_session_unavailable' };
  const linked = resolveSessionPullRequests(read.meta);
  const repository = parseGitHubPullRequestUrl(prUrl)?.repoFullName.toLowerCase();
  const pr = linked
    .filter(
      (item) => parseGitHubPullRequestUrl(item.url)?.repoFullName.toLowerCase() === repository
    )
    .at(-1);
  if (!repository || !pr) return { value: 'unknown', reason: 'pr_link_unconfirmed' };
  if (pr.url !== prUrl) return { value: 'no', reason: 'pr_superseded' };
  const observation = deps.ledger.checkpoint(pullRequestCheckpointId(sessionId, prUrl));
  if (!observation) return { value: 'unknown', reason: 'pr_observation_missing' };
  // Merged is terminal provider evidence; a busy group must not hold that stale forever.
  if (observation.data.status === 'merged' && pr.status === 'merged')
    return { value: 'yes', reason: 'merged' };
  if (Date.now() - observation.observedAt > 5 * 60_000)
    return { value: 'unknown', reason: 'pr_observation_stale' };
  return { value: 'no', reason: String(observation.data.status) };
}

function withQuotaRecoveryRetryAt(
  observation: ConditionObservation,
  receipt: AutomationReceipt,
  now: number
): ConditionObservation {
  if (
    observation.value === 'yes' ||
    observation.retryAt !== undefined ||
    !isQuotaRecoveryReceipt(receipt) ||
    !observation.reason.startsWith('capacity_')
  ) {
    return observation;
  }
  return { ...observation, retryAt: quotaRecoveryRetryAt(receipt, now) };
}

export type AdmissionDeps = {
  ledger: AutomationLedger;
  lody: Lody;
  manager: LoroDocumentManager;
  authority: SessionAutomationAuthority;
  machineId: MachineId;
  userId: string;
  workspaceId: string;
  logger: Logger;
};

/** Evaluates all built-in automation conditions and guards without circular action trampolines. */
export async function evaluateAutomationCondition(
  deps: AdmissionDeps,
  spec: AutomationCondition,
  receipt: AutomationReceipt
): Promise<ConditionObservation> {
  const { ledger, lody, manager, authority, machineId, logger } = deps;
  const parameters = spec.parameters;
  switch (spec.kind) {
    case 'automation.wait.ready': {
      const wait =
        typeof parameters.waitId === 'string' ? ledger.wait(parameters.waitId) : undefined;
      if (!wait || wait.state !== 'matched' || wait.invocationId !== receipt.id)
        return { value: 'no', reason: 'wait_revoked' };
      return { value: 'yes', reason: 'wait_matched' };
    }
    case 'session.group.settled':
      if (typeof parameters.rootId !== 'string') throw new Error('AUTOMATION_CONDITION_INVALID');
      return authority.settled(
        parameters.rootId as SessionId,
        receipt.rule.ownerUserId,
        receipt.id
      );
    case 'session.turn.finalized': {
      if (typeof parameters.sessionId !== 'string' || typeof parameters.turnId !== 'string')
        throw new Error('AUTOMATION_CONDITION_INVALID');
      const doc = await manager.getOrCreateSessionDoc(parameters.sessionId as SessionId);
      const backend = await createSessionBackend(doc);
      const read = await backend.readTurn(parameters.turnId);
      if (read.state !== 'ready') return { value: 'unknown', reason: 'turn_unavailable' };
      const ended =
        ['handled', 'failed', 'canceled'].includes(read.turn.status ?? '') ||
        read.turn.finished === true;
      return {
        value:
          ended && !lody.hasAutomationSessionWork(parameters.sessionId as SessionId) ? 'yes' : 'no',
        reason: 'turn_finalization',
      };
    }
    case 'session.delivery.current':
      if (typeof parameters.sessionId !== 'string' || typeof parameters.eventId !== 'string')
        throw new Error('AUTOMATION_CONDITION_INVALID');
      return deliveryStepCurrent(ledger, parameters.sessionId, parameters.eventId);
    case 'github.pr.is_merged':
      if (typeof parameters.prUrl !== 'string') throw new Error('AUTOMATION_CONDITION_INVALID');
      return observeCurrentPr({ manager, ledger }, receipt, parameters.prUrl);
    case 'provider.capacity.can_dispatch': {
      if (typeof parameters.bindingId !== 'string') throw new Error('AUTOMATION_CONDITION_INVALID');
      const bindingId = parameters.bindingId;
      const recovery =
        receipt.rule.handler.kind === 'policy' &&
        receipt.rule.handler.policy === 'recover-capacity';
      const workRef = receipt.intent.action.parameters.input;
      const work =
        recovery &&
        workRef &&
        typeof workRef === 'object' &&
        !Array.isArray(workRef) &&
        typeof workRef.ref === 'string'
          ? ledger.work(workRef.ref)
          : undefined;
      const recoveryBinding =
        work && work.bindingId === bindingId && work.sessionId === receipt.rule.scope.sessionId;
      if (
        !recoveryBinding &&
        ![receipt.rule.grants, ledger.rule(receipt.rule.id)?.grants].every((grant) =>
          grant?.bindingIds.includes(bindingId)
        )
      )
        return withQuotaRecoveryRetryAt(
          { value: 'no', reason: 'capacity_binding_not_granted' },
          receipt,
          Date.now()
        );
      const modelId = typeof parameters.modelId === 'string' ? parameters.modelId : undefined;
      const initial = await evaluateBindingCapacity(
        { manager, ledger, machineId },
        bindingId,
        modelId,
        Date.now()
      );
      if (initial.status === 'unavailable')
        return withQuotaRecoveryRetryAt(
          { value: 'unknown', reason: 'capacity_binding_unavailable' },
          receipt,
          Date.now()
        );
      let observed = initial.observation;
      const quotaRecovery = isQuotaRecoveryReceipt(receipt);
      const quotaResetDue =
        quotaRecovery &&
        observed.value === 'no' &&
        observed.reason === 'capacity_exhausted' &&
        observed.retryAt === undefined;
      if (observed.value === 'unknown' || quotaResetDue) {
        try {
          await authority.refreshCapacity(bindingId);
        } catch (cause) {
          if (!quotaRecovery) throw cause;
          logger.warn('Automation capacity refresh failed', cause);
          return withQuotaRecoveryRetryAt(observed, receipt, Date.now());
        }
        const refreshed = ledger.capacity(bindingId, modelId) ?? ledger.capacity(bindingId);
        observed = evaluateCapacity(
          refreshed,
          { bindingId, fingerprint: initial.fingerprint, modelId },
          Date.now()
        );
      }
      return withQuotaRecoveryRetryAt(observed, receipt, Date.now());
    }
    default:
      return { value: 'unknown', reason: `condition_unsupported:${spec.kind}` };
  }
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
  let cachedMeta: SessionMeta | undefined;
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
        TERMINAL_WORK_STATES.has(work.state) ||
        (work.invocationId && work.invocationId !== receipt.id)
      )
        return { value: 'no', reason: 'pending_work_ended', terminalState: 'superseded' };
      const config = await manager.getAgentConfigForMachineLaunch(
        work.bindingId as AgentConfigId,
        machineId
      );
      if (!config || providerBindingFingerprint(config) !== work.fingerprint)
        return { value: 'no', reason: 'pending_work_binding_changed' };
      const targetRead = await readSessionMeta(manager, work.sessionId as SessionId);
      if (targetRead.status !== 'ok') return { value: 'unknown', reason: 'target_unavailable' };
      cachedMeta = targetRead.meta;
      if (
        cachedMeta.acpSessionId !== work.nativeSessionId ||
        (cachedMeta.latestUserMsgId !== work.turnId &&
          cachedMeta.latestUserMsgId !== receipt.turnId)
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
      if (invocation.target.machineId !== machineId)
        return { value: 'unknown', reason: 'target_owner_unavailable' };
      return { value: 'yes', reason: 'role_granted' };
    }
    sessionId = invocation.target.sessionId;
    unavailableFails = invocation.target.onUnavailable === 'fail';
  } else {
    sessionId = sessionActionSchema.parse(action.parameters).sessionId;
  }

  const meta =
    cachedMeta ??
    (await readSessionMeta(manager, sessionId as SessionId).then((res) =>
      res.status === 'ok' ? res.meta : undefined
    ));
  if (!meta)
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

/** Re-runs authorization and guard (with `guard:` namespace) at resource admission. */
export async function recheckAdmission(
  deps: AdmissionDeps,
  receipt: AutomationReceipt
): Promise<ActionAuthorization> {
  const authorization = await authorizeAutomationReceipt(
    {
      ...deps,
      capacity: (bindingId, modelId, item) =>
        evaluateAutomationCondition(
          deps,
          {
            kind: 'provider.capacity.can_dispatch',
            parameters: { bindingId, ...(modelId ? { modelId } : {}) },
          },
          item
        ),
    },
    receipt
  );
  if (authorization.value !== 'yes' || authorization.reason === 'archive_already_committed')
    return authorization;
  if (receipt.intent.guard) {
    const guard = await evaluateAutomationCondition(deps, receipt.intent.guard, receipt);
    if (guard.value !== 'yes') return { ...guard, reason: `guard:${guard.reason}` };
  }
  return { value: 'yes', reason: 'authorized' };
}

/** Full admission check including pre-queue condition when receipt has not been queued yet. */
export async function recheckReceipt(
  deps: AdmissionDeps,
  receipt: AutomationReceipt
): Promise<ActionAuthorization> {
  const admission = await recheckAdmission(deps, receipt);
  if (admission.value !== 'yes' || admission.reason === 'archive_already_committed')
    return admission;
  if (receipt.intent.condition && !['queued', 'running', 'unknown'].includes(receipt.state)) {
    const predicate = await evaluateAutomationCondition(deps, receipt.intent.condition, receipt);
    if (predicate.value !== 'yes') return predicate;
  }
  return admission;
}
