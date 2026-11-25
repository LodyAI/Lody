const key = 'lody:usage-sharing';
const accountKey = 'lody:usage-sharing-account-blocked';
let sessionBlocked = false;
let accountAllowed = true;

export function readDeviceUsageChoice(): boolean | null {
  if (typeof window === 'undefined' || sessionBlocked) return false;
  try {
    const choice = window.localStorage.getItem(key);
    return choice === null ? null : /^on:\d+$/.test(choice);
  } catch {
    return false;
  }
}

export function readDeviceUsageSharing(): boolean {
  return readDeviceUsageChoice() ?? !window.__LODY_ELECTRON__;
}

export function usageSharingAllowed(): boolean {
  if (!accountAllowed || !readDeviceUsageSharing()) return false;
  try {
    return window.localStorage.getItem(accountKey) !== 'true';
  } catch {
    return false;
  }
}

export function setAccountUsageAllowed(allowed: boolean): void {
  accountAllowed = allowed;
}

export function subscribeUsageSharing(listener: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === key) listener();
  };
  window.addEventListener(key, listener);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(key, listener);
    window.removeEventListener('storage', storage);
  };
}

export function writeDeviceUsageSharing(enabled: boolean): void {
  sessionBlocked = !enabled;
  try {
    window.localStorage.setItem(key, enabled ? 'on:' + Date.now() : 'off');
    sessionBlocked = false;
  } catch (error) {
    sessionBlocked = true;
    throw error;
  } finally {
    window.dispatchEvent(new Event(key));
  }
}

export function usageSharingSince(): number {
  try {
    const choice = window.localStorage.getItem(key);
    const account = window.localStorage.getItem(accountKey);
    return Math.max(
      choice?.startsWith('on:') ? Number(choice.slice(3)) : 0,
      account?.startsWith('on:') ? Number(account.slice(3)) : 0
    );
  } catch {
    return Infinity;
  }
}

// Remember the last authenticated refusal for pre-React diagnostics on the next boot.
export function rememberAccountUsageSharing(enabled: boolean): void {
  try {
    const blocked = window.localStorage.getItem(accountKey) === 'true';
    if (enabled === blocked)
      window.localStorage.setItem(accountKey, enabled ? 'on:' + Date.now() : 'true');
  } catch {
    if (!enabled) sessionBlocked = true;
  }
}

export function markUsageOptOutPending(accountId: string, pending: boolean): void {
  const name = key + ':pending:' + accountId;
  if (pending) window.localStorage.setItem(name, '1');
  else window.localStorage.removeItem(name);
}

export function hasPendingUsageOptOut(accountId: string): boolean {
  try {
    return window.localStorage.getItem(key + ':pending:' + accountId) === '1';
  } catch {
    return false;
  }
}

export function rememberDesktopAccountChoice(accountId: string, enabled: boolean): void {
  if (!enabled) markUsageOptOutPending(accountId, true);
  else window.localStorage.setItem(key + ':pending:' + accountId, 'allow');
}

export function pendingAccountChoice(accountId: string): boolean | null {
  const pending = window.localStorage.getItem(key + ':pending:' + accountId);
  return pending === 'allow' ? true : pending === '1' ? false : null;
}

// Only reverse an SDK opt-out that this application set.
export function syncSdkUsageSharing(
  client: {
    has_opted_out_capturing(): boolean;
    opt_in_capturing(): void;
    opt_out_capturing(): void;
  },
  enabled: boolean
): void {
  const marker = 'lody:usage-sharing-sdk-paused';
  if (!enabled && !client.has_opted_out_capturing()) {
    client.opt_out_capturing();
    try {
      window.localStorage.setItem(marker, '1');
    } catch {
      // Leave the SDK opted out if its owner cannot be remembered.
    }
  } else if (enabled) {
    try {
      if (window.localStorage.getItem(marker) !== '1') return;
      if (client.has_opted_out_capturing()) client.opt_in_capturing();
      window.localStorage.removeItem(marker);
    } catch {
      // Unavailable storage keeps the previous SDK preference.
    }
  }
}
