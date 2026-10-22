const KEY = 'lody:referral';
const VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const validCode = (code: string) => /^[a-f0-9]{32}$/.test(code);

/** First valid click wins. This is an attribution hint, never billing authority. */
export function captureReferral(
  search: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  now = Date.now()
): void {
  const code = new URLSearchParams(search).get('ref');
  if (!code || !validCode(code)) return;
  try {
    storage ??= localStorage;
    if (readReferral(storage, now)) return;
    storage.setItem(KEY, JSON.stringify({ code, expiresAt: now + VALIDITY_MS }));
  } catch {
    /* Referral storage must not block login. */
  }
}
export function readReferral(
  storage?: Pick<Storage, 'getItem' | 'removeItem'>,
  now = Date.now()
): string | undefined {
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
      return value.code;
    storage.removeItem(KEY);
  } catch {
    /* Unavailable storage is equivalent to no attribution. */
  }
  return undefined;
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
