const KEY = 'lody:referral';
const VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const validCode = (code: string) => /^[a-f0-9]{32}$/.test(code);

/** Latest valid click wins. This is an attribution hint, never billing authority. */
export function captureReferral(
  search: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  now = Date.now()
): void {
  const code = new URLSearchParams(search).get('ref');
  if (!code || !validCode(code)) return;
  try {
    storage ??= localStorage;
    storage.setItem(KEY, JSON.stringify({ code, expiresAt: now + VALIDITY_MS }));
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('lody:referral-changed'));
  } catch {
    /* Referral storage must not block login. */
  }
}
export function readReferral(
  storage?: Pick<Storage, 'getItem' | 'removeItem'>,
  now = Date.now()
): string | undefined {
  return readReferralHint(storage, now)?.code;
}

export function readReferralHint(
  storage?: Pick<Storage, 'getItem' | 'removeItem'>,
  now = Date.now()
): { code: string; clickedAt: number } | undefined {
  try {
    storage ??= localStorage;
    const raw = storage.getItem(KEY);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === 'object' &&
      'code' in value &&
      typeof value.code === 'string' &&
      validCode(value.code) &&
      'expiresAt' in value &&
      typeof value.expiresAt === 'number' &&
      value.expiresAt > now &&
      value.expiresAt <= now + VALIDITY_MS
    )
      // Derive the click time from the existing record format, including hints
      // written by static landing pages and older clients. Reads never renew it.
      return { code: value.code, clickedAt: value.expiresAt - VALIDITY_MS };
    storage.removeItem(KEY);
  } catch {
    /* Unavailable storage is equivalent to no attribution. */
  }
  return undefined;
}

/** Wait for the latest browser choice before the server selects a Checkout lead. */
export async function attachStoredReferral(
  attach: (hint: { code: string; clickedAt: number }) => Promise<unknown>
): Promise<void> {
  const hint = readReferralHint();
  if (hint) await attach(hint);
}
export function clearReferral(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
}

/** Checkout rejections of a referral, as the copy that tells a person what to do. */
export const REFERRAL_ERROR_KEYS: Record<string, string> = {
  referral_invalid: 'referral.invalid',
  referral_already_bound: 'referral.bound',
  referral_checkout_already_started: 'referral.started',
  referral_not_new_customer: 'referral.notNew',
  referral_self_recommendation: 'referral.self',
};
