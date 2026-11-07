import { ConvexError } from 'convex/values';
/** Public error codes only; never expose Stripe raw responses in the interface. */
export function getBillingErrorCode(error: unknown): string | null {
  const data: unknown = error instanceof ConvexError ? error.data : error;
  if (data && typeof data === 'object' && 'code' in data && typeof data.code === 'string')
    return data.code;
  return null;
}
export function seatBillingErrorKey(error: unknown): string | null {
  const code = getBillingErrorCode(error);
  return code === 'billing_payment_method_required'
    ? 'workspace.invite.seat.methodRequired'
    : code === 'billing_payment_required'
      ? 'workspace.invite.seat.paymentRequired'
      : code === 'billing_payment_refresh_required'
        ? 'workspace.invite.seat.refreshRequired'
        : null;
}
