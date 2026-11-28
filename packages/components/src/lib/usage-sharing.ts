const key = 'lody:usage-sharing';
const accountKey = 'lody:usage-sharing-account-blocked';
let sessionBlocked = false;
let accountAllowed = true;
let envDisabled = false;
let saveSeq = 0;
const inFlightAccountChoice = new Map<string, { choice: boolean; seq: number }>();
const submittedAccountChoice = new Map<string, boolean>();

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(key));
}

export function setEnvUsageSharingDisabled(disabled: boolean): void {
  if (envDisabled === disabled) return;
  envDisabled = disabled;
  notify();
}

export function isEnvUsageSharingDisabledClient(): boolean {
  return envDisabled;
}

export function claimAccountUsageSave(
  accountId: string,
  choice: boolean
): ((succeeded: boolean) => void) | null {
  if (inFlightAccountChoice.get(accountId)?.choice === choice) return null;
  const seq = ++saveSeq;
  inFlightAccountChoice.set(accountId, { choice, seq });
  submittedAccountChoice.delete(accountId);
  return (succeeded: boolean) => {
    if (inFlightAccountChoice.get(accountId)?.seq === seq) {
      inFlightAccountChoice.delete(accountId);
      if (succeeded) submittedAccountChoice.set(accountId, choice);
    }
  };
}

export function hasInFlightAccountUsageSave(accountId: string): boolean {
  return inFlightAccountChoice.has(accountId);
}

export function hasSubmittedAccountChoice(accountId: string, choice: boolean): boolean {
  return submittedAccountChoice.get(accountId) === choice;
}

export function clearSubmittedAccountChoice(accountId: string): void {
  submittedAccountChoice.delete(accountId);
}

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
  return readDeviceUsageChoice() !== false;
}

export function clearPostHogLocalStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    const toRemove: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index);
      if (storageKey && storageKey.startsWith('ph_')) {
        toRemove.push(storageKey);
      }
    }
    for (const storageKey of toRemove) {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Ignore unavailable storage.
  }
}

export function usageSharingAllowed(): boolean {
  if (envDisabled || !accountAllowed || !readDeviceUsageSharing()) return false;
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
    if (
      event.key === null ||
      event.key === key ||
      event.key === accountKey ||
      event.key.startsWith(key + ':pending:')
    ) {
      listener();
    }
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
    if (!enabled) clearPostHogLocalStorage();
    window.localStorage.setItem(key, enabled ? 'on:' + Date.now() : 'off');
    sessionBlocked = false;
  } catch {
    sessionBlocked = true;
  } finally {
    notify();
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

export function setPendingAccountChoice(accountId: string, choice: boolean | null): void {
  try {
    const name = key + ':pending:' + accountId;
    if (choice === null) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, choice ? 'allow' : '1');
  } catch {
    // Ignore unavailable storage.
  } finally {
    notify();
  }
}

export function pendingAccountChoice(accountId: string): boolean | null {
  try {
    const pending = window.localStorage.getItem(key + ':pending:' + accountId);
    return pending === 'allow' ? true : pending === '1' ? false : null;
  } catch {
    return null;
  }
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
