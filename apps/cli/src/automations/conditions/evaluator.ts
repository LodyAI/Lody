import type { AgentConfigId, MachineId, SessionId } from '@lody/shared';
import type {
  AutomationCondition,
  AutomationReceipt,
  ConditionObservation,
} from '@lody/shared/automations';
import type { Lody } from '@/lib/lody';
import type { Logger } from '@/utils/logger';
import { createSessionBackend } from '@/session/session-backend';
import { providerBindingFingerprint } from '@/session/automation-observations';
import type { SessionAutomationAuthority } from '@/session/session-automation-authority';
import type { AutomationLedger } from '../storage/ledger';
import { evaluateCapacity } from '../runtime/capacity';
import { deliveryStepCurrent } from '../policies/delivery';

export type ConditionEvaluatorDeps = {
  ledger: AutomationLedger;
  lody: Lody;
  authority: SessionAutomationAuthority;
  machineId: MachineId;
  logger: Logger;
  currentPr(receipt: AutomationReceipt, prUrl: string): Promise<ConditionObservation>;
};

export const isQuotaRecoveryReceipt = (receipt: AutomationReceipt): boolean =>
  receipt.event.type === 'provider.quota.exhausted' &&
  receipt.rule.handler.kind === 'policy' &&
  receipt.rule.handler.policy === 'recover-capacity';

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
  const estimatedReset = receipt.event.data.retryAt;
  return {
    ...observation,
    retryAt:
      typeof estimatedReset === 'number' && estimatedReset > now
        ? estimatedReset
        : Number.MAX_SAFE_INTEGER,
  };
}

export async function evaluateAutomationCondition(
  deps: ConditionEvaluatorDeps,
  spec: AutomationCondition,
  receipt: AutomationReceipt
): Promise<ConditionObservation> {
  const { ledger, lody, authority, machineId, logger } = deps;
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
      const doc = await lody.documentManager.getOrCreateSessionDoc(
        parameters.sessionId as SessionId
      );
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
      return deps.currentPr(receipt, parameters.prUrl);
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
      const config = await lody.documentManager.getAgentConfigForMachineLaunch(
        bindingId as AgentConfigId,
        machineId
      );
      if (!config)
        return withQuotaRecoveryRetryAt(
          { value: 'unknown', reason: 'capacity_binding_unavailable' },
          receipt,
          Date.now()
        );
      const fingerprint = providerBindingFingerprint(config);
      const modelId = typeof parameters.modelId === 'string' ? parameters.modelId : undefined;
      const read = () => ledger.capacity(bindingId, modelId) ?? ledger.capacity(bindingId);
      const now = Date.now();
      let observed = evaluateCapacity(read(), { bindingId, fingerprint, modelId }, now);
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
        observed = evaluateCapacity(read(), { bindingId, fingerprint, modelId }, Date.now());
      }
      return withQuotaRecoveryRetryAt(observed, receipt, Date.now());
    }
    default:
      return { value: 'unknown', reason: `condition_unsupported:${spec.kind}` };
  }
}
