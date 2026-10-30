import type {
  AutomationContinuation,
  AutomationRuleDraft,
  AutomationSettings,
} from '@lody/shared/automations';
import type { Delivery } from '../storage/ledger';
import { automationIdentity, type AutomationLedger } from '../storage/ledger';

/** Product behavior lives here. User programs only report a condition result. */
export function internalPolicy({ rule, event }: Delivery): AutomationContinuation[] {
  const handler = rule.handler;
  const sessionId = rule.scope.sessionId;
  if (handler.kind !== 'policy' || !sessionId || event.scope.sessionId !== sessionId) return [];
  switch (handler.policy) {
    case 'archive-after-merge':
      if (typeof event.data.prUrl !== 'string') return [];
      return [
        {
          key: event.id,
          condition: { kind: 'session.group.settled', parameters: { rootId: sessionId } },
          guard: { kind: 'github.pr.is_merged', parameters: { prUrl: event.data.prUrl } },
          action: { kind: 'session.archive', parameters: { sessionId } },
        },
      ];
    case 'recover-capacity':
      if (typeof event.data.workId !== 'string') return [];
      return [
        {
          key: event.data.workId,
          ...(typeof event.data.retryAt === 'number' ? { notBefore: event.data.retryAt } : {}),
          action: {
            kind: 'agent.invoke',
            parameters: {
              target: { kind: 'existing', sessionId, onUnavailable: 'blocked' },
              input: { kind: 'pending_work', ref: event.data.workId },
              ifBusy: 'enqueue',
            },
          },
        },
      ];
    case 'compact-idle': {
      const { contextTokens, cacheTtlMs, leadTimeMs } = handler.options;
      const context = event.data.context;
      if (
        typeof contextTokens !== 'number' ||
        typeof cacheTtlMs !== 'number' ||
        typeof leadTimeMs !== 'number' ||
        event.data.outcome !== 'completed' ||
        event.data.released !== true ||
        event.data.finalized !== true ||
        !context ||
        typeof context !== 'object' ||
        Array.isArray(context) ||
        typeof context.used !== 'number' ||
        context.used < contextTokens ||
        typeof event.data.turnId !== 'string'
      )
        return [];
      return [
        {
          key: event.id,
          notBefore: event.observedAt + cacheTtlMs - leadTimeMs,
          action: {
            kind: 'session.compact',
            parameters: {
              sessionId,
              idleTurnId: event.data.turnId,
              expiresAt: event.observedAt + cacheTtlMs,
            },
          },
        },
      ];
    }
  }
  return [];
}

const policies = {
  archiveAfterMerge: {
    policy: 'archive-after-merge',
    event: 'github.pr.merged',
    action: 'session.archive',
  },
  recoverCapacity: {
    policy: 'recover-capacity',
    event: ['provider.quota.exhausted', 'provider.model.overloaded'],
    action: 'agent.invoke',
  },
  compactWhenIdle: {
    policy: 'compact-idle',
    event: 'session.turn.finalized',
    action: 'session.compact',
  },
} as const;

export function configureSessionPolicies(
  ledger: AutomationLedger,
  sessionId: string,
  userId: string,
  settings: AutomationSettings,
  now: number
): void {
  for (const key of Object.keys(policies) as (keyof typeof policies)[]) {
    const value = settings[key];
    if (value === undefined) continue;
    const policy = policies[key];
    const id = automationIdentity('session-policy', sessionId, policy.policy);
    const draft: AutomationRuleDraft = {
      id,
      name: policy.policy,
      scope: { workspaceId: ledger.workspaceId, sessionId },
      selector: { types: typeof policy.event === 'string' ? [policy.event] : [...policy.event] },
      enabled: value !== false,
      handler: {
        kind: 'policy',
        policy: policy.policy,
        options: typeof value === 'object' ? value : {},
      },
      grants: {
        actions: [policy.action],
        sessionIds: [sessionId],
        bindingIds: [],
        agentRoleIds: [],
        allowLinkedSession: false,
        allowCapacityAttempt: policy.policy === 'recover-capacity',
      },
      budget: {
        maxActionsPerEvent: 1,
        maxInvocationsPerCorrelation: 8,
        maxPendingActions: 128,
        maxDepth: 8,
      },
    };
    ledger.upsert(draft, userId, now, ledger.rule(id)?.revision ?? 0);
  }
}

/** Preserve an enabled recovery setting created before overload observations existed. */
export function upgradeCapacityPolicies(
  ledger: AutomationLedger,
  userId: string,
  now: number
): void {
  for (const rule of ledger.rules()) {
    if (
      rule.ownerUserId === userId &&
      rule.ownerMachineId === ledger.machineId &&
      rule.handler.kind === 'policy' &&
      rule.handler.policy === 'recover-capacity' &&
      rule.scope.sessionId &&
      !rule.selector.types.includes('provider.model.overloaded')
    )
      configureSessionPolicies(
        ledger,
        rule.scope.sessionId,
        userId,
        { recoverCapacity: rule.enabled },
        now
      );
  }
}

export function sessionPolicySettings(
  ledger: AutomationLedger,
  sessionId: string
): AutomationSettings {
  const result: AutomationSettings = {};
  for (const key of Object.keys(policies) as (keyof typeof policies)[]) {
    const rule = ledger.rule(automationIdentity('session-policy', sessionId, policies[key].policy));
    if (!rule?.enabled || rule.handler.kind !== 'policy') {
      result[key] = false;
      continue;
    }
    if (key === 'compactWhenIdle') {
      const { contextTokens, cacheTtlMs, leadTimeMs } = rule.handler.options;
      if (
        typeof contextTokens === 'number' &&
        typeof cacheTtlMs === 'number' &&
        typeof leadTimeMs === 'number'
      )
        result.compactWhenIdle = { contextTokens, cacheTtlMs, leadTimeMs };
    } else result[key] = true;
  }
  return result;
}
