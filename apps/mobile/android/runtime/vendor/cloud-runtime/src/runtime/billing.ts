import {
  FREE_SESSION_LIMIT_PER_WORKSPACE,
  FREE_SESSION_TURN_LIMIT,
} from '../models/billing';

export {
  FREE_SESSION_LIMIT_PER_WORKSPACE,
  FREE_SESSION_TURN_LIMIT,
} from '../models/billing';

export type BillingEntitlement = {
  effectivePlanTier?: string;
  checkoutPending?: boolean;
};

export type BillingQuotaReason =
  | 'workspace_payment_required'
  | 'free_session_limit_reached'
  | 'free_session_turn_limit_reached';

export function quotaReason(
  kind: 'session' | 'turn',
  entitlement: BillingEntitlement | null | undefined,
  current: number | null,
): BillingQuotaReason | undefined {
  if (entitlement?.checkoutPending) return 'workspace_payment_required';
  // Match the shared client's cooperative, fail-open policy while either the
  // entitlement or the synchronized Flock count is unavailable.
  if (entitlement?.effectivePlanTier !== 'free' || current === null)
    return undefined;
  if (kind === 'session' && current >= FREE_SESSION_LIMIT_PER_WORKSPACE)
    return 'free_session_limit_reached';
  if (kind === 'turn' && current >= FREE_SESSION_TURN_LIMIT)
    return 'free_session_turn_limit_reached';
  return undefined;
}

export function billableTurnCount(value: {
  history?: unknown;
  mq?: unknown;
}): number {
  const history = Array.isArray(value.history) ? value.history : [];
  const queue = Array.isArray(value.mq) ? value.mq : [];
  return (
    history.filter((entry) => entry?.role === 'user').length + queue.length
  );
}

export function workspaceSessionCount(
  rows: readonly { key: unknown[]; value?: unknown }[],
): number {
  return rows.filter(
    ({ key, value }) =>
      key.length === 2 &&
      key[0] === 'e' &&
      typeof key[1] === 'string' &&
      key[1].startsWith('session-') &&
      !key[1].startsWith('session-comment-') &&
      value === true,
  ).length;
}
