import { isNativePlatform } from 'better-auth-capacitor/client';

export type StoredCookieEntry = {
  value?: string;
  expires?: string | null;
};

export type StoredCookieJar = Record<string, StoredCookieEntry>;

export type CapacitorPreferencesLike = {
  get: (options: { key: string }) => Promise<{ value: string | null }>;
  set: (options: { key: string; value: string }) => Promise<void>;
  remove: (options: { key: string }) => Promise<void>;
};

export type LocalStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type CapacitorAuthHygieneOptions = {
  storagePrefix?: string;
  cookiePrefix?: string;
  isNative?: () => boolean;
  getPreferences?: () => Promise<CapacitorPreferencesLike>;
  getLocalStorage?: () => LocalStorageLike | undefined;
  now?: () => number;
};

const SECURE_COOKIE_PREFIX = '__Secure-';
const BEARER_PREFIX = 'bearer ';

let cachedPreferences: Promise<CapacitorPreferencesLike> | null = null;

function defaultGetPreferences(): Promise<CapacitorPreferencesLike> {
  if (!cachedPreferences) {
    cachedPreferences = import('@capacitor/preferences')
      .then((mod) => ({
        get: (options: { key: string }) => mod.Preferences.get(options),
        set: (options: { key: string; value: string }) => mod.Preferences.set(options),
        remove: (options: { key: string }) => mod.Preferences.remove(options),
      }))
      .catch((error: unknown) => {
        cachedPreferences = null;
        throw error;
      });
  }
  return cachedPreferences;
}

function defaultGetLocalStorage(): LocalStorageLike | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeCookieName(name: string): string {
  return name.replace(/:/g, '_');
}

function parseCookieJar(raw: string | null | undefined): StoredCookieJar | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as StoredCookieJar;
  } catch {
    return null;
  }
}

function isExpiredEntry(entry: StoredCookieEntry | undefined, nowMs: number): boolean {
  if (!entry || !entry.expires) return false;
  const expiresAt = Date.parse(entry.expires);
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

function getSessionTokenKeys(cookiePrefix: string): [string, string] {
  const baseKey = `${cookiePrefix}.session_token`;
  return [`${SECURE_COOKIE_PREFIX}${baseKey}`, baseKey];
}

function readActiveSessionEntry(
  jar: StoredCookieJar | null,
  cookiePrefix: string,
  nowMs: number
): StoredCookieEntry | null {
  if (!jar) return null;
  for (const key of getSessionTokenKeys(cookiePrefix)) {
    const entry = jar[key];
    if (entry && typeof entry.value === 'string' && entry.value.length > 0) {
      if (!isExpiredEntry(entry, nowMs)) return entry;
    }
  }
  return null;
}

function readStoredSessionTokenValue(
  jar: StoredCookieJar | null,
  cookiePrefix: string
): string | null {
  if (!jar) return null;
  const [secureKey, baseKey] = getSessionTokenKeys(cookiePrefix);
  const selected = jar[secureKey] ? jar[secureKey] : jar[baseKey];
  return selected && typeof selected.value === 'string' && selected.value.length > 0
    ? selected.value
    : null;
}

function readBearerToken(headers: unknown): string | null {
  if (!headers) return null;
  try {
    const auth = new Headers(headers as HeadersInit).get('authorization');
    if (!auth || auth.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
      return null;
    }
    const token = auth.slice(BEARER_PREFIX.length).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function isGetSessionUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string' && !(rawUrl instanceof URL)) return false;
  try {
    const parsed = new URL(String(rawUrl), 'https://lody.invalid');
    return parsed.pathname.endsWith('/get-session');
  } catch {
    return false;
  }
}

function stripLegacySessionKeys(storage: LocalStorageLike, cookieKey: string): void {
  try {
    const parsed = parseCookieJar(storage.getItem(cookieKey));
    if (!parsed) return;
    const preserved: StoredCookieJar = {};
    let removed = false;
    for (const [key, value] of Object.entries(parsed)) {
      if (
        key.includes('session_token') ||
        key.includes('session_data') ||
        key.includes('convex_jwt')
      ) {
        removed = true;
      } else {
        preserved[key] = value;
      }
    }
    if (!removed) return;
    if (Object.keys(preserved).length === 0) {
      storage.removeItem(cookieKey);
    } else {
      storage.setItem(cookieKey, JSON.stringify(preserved));
    }
  } catch {
    // Ignore restricted storage; native Preferences owns auth state.
  }
}

/**
 * Native Capacitor session hygiene layered around `better-auth-capacitor@0.3.6`:
 * 1. One-shot migration of legacy `localStorage['better-auth_cookie']` email-password
 *    sessions into Capacitor Preferences before dropping `crossDomainClient()`.
 * 2. Prunes locally expired `session_token` entries before `capacitorClient` reads them.
 * 3. Clears revoked/expired tokens from Preferences when `/get-session` settles to `null`,
 *    fenced against the exact Bearer token that was sent so concurrent sign-in is preserved.
 */
export function createCapacitorAuthHygienePlugin(options: CapacitorAuthHygieneOptions = {}) {
  const storagePrefix = options.storagePrefix ?? 'better-auth';
  const cookiePrefix = options.cookiePrefix ?? 'better-auth';
  const cookieKey = normalizeCookieName(`${storagePrefix}_cookie`);
  const localCacheKey = normalizeCookieName(`${storagePrefix}_session_data`);
  const isNative = options.isNative ?? isNativePlatform;
  const getPreferences = options.getPreferences ?? defaultGetPreferences;
  const getLocalStorage = options.getLocalStorage ?? defaultGetLocalStorage;
  const now = options.now ?? Date.now;

  let migrationDone = false;
  let migrationInFlight: Promise<void> | null = null;

  async function migrateLegacyCookieOnce(): Promise<void> {
    if (migrationDone) return;
    if (migrationInFlight) return migrationInFlight;

    migrationInFlight = (async () => {
      const storage = getLocalStorage();
      if (!storage) {
        migrationDone = true;
        return;
      }

      let legacyRaw: string | null = null;
      try {
        legacyRaw = storage.getItem(cookieKey);
      } catch {
        migrationDone = true;
        return;
      }

      const legacyJar = parseCookieJar(legacyRaw);
      if (!legacyJar) {
        migrationDone = true;
        return;
      }

      const nowMs = now();
      const legacyEntry = readActiveSessionEntry(legacyJar, cookiePrefix, nowMs);
      if (!legacyEntry || !legacyEntry.value) {
        stripLegacySessionKeys(storage, cookieKey);
        migrationDone = true;
        return;
      }

      const preferences = await getPreferences();
      const nativeJar = parseCookieJar((await preferences.get({ key: cookieKey }))?.value) ?? {};
      const existingNative = readActiveSessionEntry(nativeJar, cookiePrefix, nowMs);

      if (!existingNative) {
        const [secureKey, baseKey] = getSessionTokenKeys(cookiePrefix);
        const migrated: StoredCookieEntry = {
          value: legacyEntry.value,
          expires: legacyEntry.expires ?? null,
        };
        const nextJar: StoredCookieJar = {
          ...nativeJar,
          [baseKey]: migrated,
          [secureKey]: migrated,
        };
        await preferences.set({ key: cookieKey, value: JSON.stringify(nextJar) });
      }

      stripLegacySessionKeys(storage, cookieKey);
      migrationDone = true;
    })()
      .catch(() => {
        // Retry migration on the next request if native Preferences failed transiently.
      })
      .finally(() => {
        migrationInFlight = null;
      });

    return migrationInFlight;
  }

  async function pruneExpiredNativeTokens(): Promise<void> {
    try {
      const preferences = await getPreferences();
      const nativeJar = parseCookieJar((await preferences.get({ key: cookieKey }))?.value);
      if (!nativeJar) return;

      const nowMs = now();
      let changed = false;
      const nextJar: StoredCookieJar = { ...nativeJar };
      for (const key of getSessionTokenKeys(cookiePrefix)) {
        if (key in nextJar && isExpiredEntry(nextJar[key], nowMs)) {
          delete nextJar[key];
          changed = true;
        }
      }
      if (!changed) return;

      if (Object.keys(nextJar).length === 0) {
        await preferences.remove({ key: cookieKey });
      } else {
        await preferences.set({ key: cookieKey, value: JSON.stringify(nextJar) });
      }
    } catch {
      // Best-effort pruning must not block auth requests.
    }
  }

  return {
    id: 'lody-capacitor-auth-hygiene',
    fetchPlugins: [
      {
        id: 'lody-capacitor-auth-hygiene',
        name: 'Lody Capacitor Auth Hygiene',
        async init(url: string, requestOptions?: Record<string, unknown>) {
          if (!isNative()) {
            return { url, options: requestOptions };
          }
          await migrateLegacyCookieOnce();
          await pruneExpiredNativeTokens();
          return { url, options: requestOptions };
        },
        hooks: {
          async onSuccess(context: {
            data: unknown;
            request?: { url?: unknown; headers?: unknown };
          }) {
            if (!isNative()) return;
            if (context.data !== null || !isGetSessionUrl(context.request?.url)) return;

            const sentBearer = readBearerToken(context.request?.headers);
            if (!sentBearer) return;

            try {
              const preferences = await getPreferences();
              const nativeJar = parseCookieJar((await preferences.get({ key: cookieKey }))?.value);
              const currentToken = readStoredSessionTokenValue(nativeJar, cookiePrefix);
              if (currentToken !== sentBearer) return;

              await preferences.remove({ key: cookieKey });
              await preferences.remove({ key: localCacheKey });
            } catch {
              // Best-effort cleanup; signOut recovery still clears credentials.
            }
          },
        },
      },
    ],
  };
}
