import {
  automationInvocationSchema,
  automationOriginSchema,
  type AutomationOrigin,
  type AutomationReceipt,
  type AutomationRule,
} from '@lody/shared/automations';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

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
