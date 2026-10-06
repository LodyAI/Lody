/**
 * The `?checkout=success` marker is a hint, not durable state. The billing page
 * strips it on first parse, and the desktop deep-link hand-off or an ordinary
 * reload can land without it. Keep a per-tab intent so the page can still
 * confirm the Stripe session against the server instead of falling back to the
 * pre-checkout free overview.
 */

const STORAGE_KEY_PREFIX = 'lody:billing-checkout-return:';

/** Stripe Checkout Sessions expire after 24 hours; an older marker is stale. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function markBillingCheckoutReturn(workspaceId: string, nowMs = Date.now()): void {
  const store = billingReturnStorage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY_PREFIX + workspaceId, String(nowMs));
  } catch {
    // Storage can be unavailable (private mode); the URL marker still works.
  }
}

export function readBillingCheckoutReturn(workspaceId: string, nowMs = Date.now()): number | null {
  const store = billingReturnStorage();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY_PREFIX + workspaceId);
  } catch {
    return null;
  }
  if (raw === null || raw === '') return null;

  const startedAtMs = Number(raw);
  if (!Number.isFinite(startedAtMs) || nowMs - startedAtMs > MAX_AGE_MS) {
    clearBillingCheckoutReturn(workspaceId);
    return null;
  }
  return startedAtMs;
}

export function clearBillingCheckoutReturn(workspaceId: string): void {
  const store = billingReturnStorage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY_PREFIX + workspaceId);
  } catch {
    // Best effort: a stale marker only costs one extra confirmation poll.
  }
}

/**
 * Whether the reactive entitlement already proves a just-finished checkout
 * landed. Gift/promotional setup keeps the Plus tier from the start, so it is
 * only settled once the scheduled renewal exists and the setup flag clears.
 */
export function isBillingActivationSettled(
  overview:
    | {
        effectivePlanTier: 'free' | 'plus' | 'enterprise';
        entitlementSource: 'free' | 'stripe' | 'stripe_gift' | 'enterprise';
        checkoutPending: boolean;
        subscriptionSetupPending: boolean;
        autoRenewAfterGift: boolean;
      }
    | null
    | undefined
): boolean {
  if (!overview) return false;
  if (overview.checkoutPending || overview.subscriptionSetupPending) return false;
  if (overview.entitlementSource === 'stripe_gift') return overview.autoRenewAfterGift;
  return overview.effectivePlanTier !== 'free';
}

function billingReturnStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
