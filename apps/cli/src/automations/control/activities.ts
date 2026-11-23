import type { AutomationReceipt, PendingWork } from '@lody/shared/automations';
import type { SessionAutomationObservation } from '@/session/automation-observations';
import type { Delivery } from '../storage/ledger';

/** Tool results can enter synced history. Private launch snapshots never leave this boundary. */
export function actionActivity(receipt: AutomationReceipt) {
  return {
    kind: 'action' as const,
    id: receipt.id,
    ruleId: receipt.rule.id,
    ruleRevision: receipt.rule.revision,
    scope: receipt.rule.scope,
    state: receipt.state,
    reason: receipt.reason,
    event: { id: receipt.event.id, source: receipt.event.source, type: receipt.event.type },
    intent: receipt.intent,
    sessionId: receipt.sessionId,
    turnId: receipt.turnId,
    attempts: receipt.attempts,
    retryAt: receipt.retryAt,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
  };
}
export function workActivity(work: PendingWork) {
  return {
    kind: 'work' as const,
    id: work.id,
    sessionId: work.sessionId,
    turnId: work.turnId,
    bindingId: work.bindingId,
    modelId: work.modelId,
    inputRef: work.inputRef,
    confirmedBoundary: work.confirmedBoundary,
    unresolvedEffects: work.unresolvedEffects,
    release: work.release,
    state: work.state,
    invocationId: work.invocationId,
    notBefore: work.notBefore,
    attempts: work.attempts,
    updatedAt: work.updatedAt,
  };
}
export function publicActivity(
  activity: { kind: 'action' | 'handler' | 'work' | 'release'; id: string } & (
    | AutomationReceipt
    | Delivery
    | PendingWork
    | SessionAutomationObservation
  )
) {
  switch (activity.kind) {
    case 'action':
      return actionActivity(activity as AutomationReceipt);
    case 'work':
      return workActivity(activity as PendingWork);
    case 'handler': {
      const delivery = activity as Delivery;
      return {
        kind: 'handler' as const,
        id: delivery.id,
        ruleId: delivery.rule.id,
        ruleRevision: delivery.rule.revision,
        state: delivery.state,
        reason: delivery.reason,
        event: { id: delivery.event.id, source: delivery.event.source, type: delivery.event.type },
        updatedAt: delivery.updatedAt,
      };
    }
    case 'release': {
      const fact = activity as SessionAutomationObservation;
      return {
        kind: 'release' as const,
        id: activity.id,
        sessionId: fact.sessionId,
        turnId: fact.turnId,
        assistantTurnId: fact.assistantTurnId,
        outcome: fact.outcome,
        released: fact.released,
        finalized: fact.finalized,
        observedAt: fact.observedAt,
        reason: fact.released ? 'observation_delivery_pending' : 'execution_release_unconfirmed',
      };
    }
  }
  throw new Error('AUTOMATION_ACTIVITY_KIND_UNSUPPORTED');
}
