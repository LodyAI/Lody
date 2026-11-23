// The sign-in method this browser last completed, so the login page can mark it
// "Last used". It is a preference of this device, not a cache: it names only the
// method (never the account or email), survives sign-out on purpose, and is
// kept by cache clearing like other preferences.
const LAST_LOGIN_METHOD_STORAGE_KEY = 'lody.auth.last_login_method';

export const LAST_LOGIN_METHODS = ['github', 'google', 'apple', 'discord', 'email'] as const;

export type LastLoginMethod = (typeof LAST_LOGIN_METHODS)[number];

function isLastLoginMethod(value: unknown): value is LastLoginMethod {
  return typeof value === 'string' && (LAST_LOGIN_METHODS as readonly string[]).includes(value);
}

export function readLastLoginMethod(): LastLoginMethod | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const value = window.localStorage?.getItem(LAST_LOGIN_METHOD_STORAGE_KEY);
    return isLastLoginMethod(value) ? value : null;
  } catch {
    // Storage can be unavailable (private mode, sandboxed frame); the badge is
    // a hint and simply does not show.
    return null;
  }
}

export function writeLastLoginMethod(method: string): void {
  if (typeof window === 'undefined' || !isLastLoginMethod(method)) {
    return;
  }
  try {
    window.localStorage?.setItem(LAST_LOGIN_METHOD_STORAGE_KEY, method);
  } catch {
    // Best-effort, as above.
  }
}
