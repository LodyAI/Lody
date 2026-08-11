/**
 * "Clear cache" support shared by web, mobile (Capacitor), and desktop (Electron).
 *
 * The Loro repo IndexedDB (`lody-loro-repo-db-<workspaceId>`) is held open by the
 * live workspace runtime, and IndexedDB `deleteDatabase()` blocks while a
 * connection is open. So instead of deleting in place from the settings page, we
 * persist a flag and reload: a full reload closes every IndexedDB connection,
 * then `maybeClearLodyCacheOnBoot()` runs BEFORE the runtime reopens the repo DB
 * — at which point nothing holds a `lody*` database open and the delete succeeds.
 *
 * Two levels exist, both driven by the same boot flag:
 *
 * - **cache** (Settings → Clear cache): recoverable `lody*` caches only. The user
 *   stays signed in and keeps their preferences.
 * - **hard** (crash screen → "Clear all data and sign out"): every local trace of
 *   the install — auth token, preferences, cookies, all IndexedDB databases, all
 *   Cache Storage entries, service workers. The escape hatch for a user wedged on
 *   a crash loop that survives reloads (e.g. a poisoned sign-in state).
 */

import { LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX } from '@lody/shared';
import { workspaceInfoCache } from './local-storage-cache';
import { EAGER_SYNC_HIGH_WATER_DB_NAME } from './eager-sync-high-water-cache';
import { replaceAppWindowLocation } from './app-location';
import { getRegisteredAuthClient } from './auth-client-singleton';

/**
 * Prefix for the per-workspace meta remote-cursor startup-bypass marker.
 * Written by `create-workspace-runtime.ts` (which imports this constant);
 * defined here so the cache clear below and the writer can never drift apart.
 */
export const META_REMOTE_CURSOR_BYPASS_STORAGE_KEY_PREFIX = 'lody:loroStreamsMetaCursorBypass';

const CACHE_CLEAR_FLAG = 'lody:clearCacheOnBoot';
/** Flag value for the recoverable-cache clear. Historic value, kept as-is. */
const CACHE_CLEAR_VALUE = '1';
/** Flag value for the full local wipe. */
const HARD_RESET_VALUE = 'all';

export type PendingLocalClearMode = 'cache' | 'hard';

/** IndexedDB databases created with static names (not suffixed per workspace). */
const KNOWN_INDEXEDDB_NAMES = [
  EAGER_SYNC_HIGH_WATER_DB_NAME,
  'lody:repo-file-paths',
  'lody:repo-issues-prs',
  'lody:github-pr-cache',
  'lody:project-skills',
];

/**
 * Per-workspace IndexedDB names (`lody-loro-repo-db-<id>`,
 * `lody-loro-stream-cursors-<id>`) for every workspace the user has visited in
 * this browser, derived from the cached workspace-info map. A workspace only has
 * local databases here if it was opened here, so this covers "all workspaces" in
 * practice — and crucially on engines without `indexedDB.databases()` (Firefox),
 * where these names can't be discovered by enumeration.
 */
function knownWorkspaceDatabaseNames(): string[] {
  const names: string[] = [];
  try {
    for (const info of Object.values(workspaceInfoCache.readAll())) {
      if (info.workspaceId) {
        names.push(
          `lody-loro-repo-db-${info.workspaceId}`,
          `lody-loro-stream-cursors-${info.workspaceId}`
        );
      }
    }
  } catch {
    // Best-effort — fall back to enumeration + any explicit extraNames.
  }
  return names;
}

/**
 * localStorage entries that cache server-derived state and can poison the
 * connection across a cache clear: a cached Loro Streams JWT pins the client
 * to the gateway URL embedded in it until expiry (no re-fetch, no re-route),
 * and a stale slug→workspaceId mapping or cursor-bypass marker survives the
 * IndexedDB wipe. All of these re-download from the server on the next boot.
 *
 * This is an explicit DELETE list, not a keep-allowlist, on purpose: a newly
 * added cache key that is missing here merely survives one clear (safe),
 * whereas a preference key missing from an allowlist would be wiped (unsafe).
 * When adding a `lody:*` localStorage cache, add its key or prefix here.
 */
const LOCAL_STORAGE_CACHE_KEYS = [
  // slug → workspaceId/name map (`local-storage-cache.ts`). Read by
  // `knownWorkspaceDatabaseNames()` to enumerate per-workspace databases, so
  // the localStorage pass below must run AFTER that enumeration.
  'lody:workspaceInfo',
  'lody:githubReposCache',
  'lody:githubBranchesCache',
  // Cached current-user snapshot (`auth-bootstrap.ts`); the auth token itself
  // is deliberately kept — a cache clear does not sign the user out.
  'lody:auth-bootstrap',
];

const LOCAL_STORAGE_CACHE_KEY_PREFIXES = [
  // Per-workspace Streams JWT + gateway URL (`@lody/shared` loro-streams-auth).
  `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:`,
  `${META_REMOTE_CURSOR_BYPASS_STORAGE_KEY_PREFIX}:`,
];

/** Remove the connection-state caches above. Never throws. */
function clearLodyLocalStorageCaches(): void {
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
  } catch {
    return;
  }
  for (const key of keys) {
    if (
      LOCAL_STORAGE_CACHE_KEYS.includes(key) ||
      LOCAL_STORAGE_CACHE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      try {
        localStorage.removeItem(key);
      } catch {
        // A key we cannot remove is not worth aborting the clear for.
      }
    }
  }
}

/** Bound how long boot waits on a single delete that another tab is blocking. */
const DELETE_TIMEOUT_MS = 3000;

function deleteDatabaseBestEffort(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    // If another open connection (e.g. a second tab) blocks the delete, don't
    // hang boot forever — give up after a bounded wait and move on.
    const timer = setTimeout(done, DELETE_TIMEOUT_MS);
    try {
      const request = indexedDB.deleteDatabase(name);
      request.addEventListener('success', done);
      request.addEventListener('error', done);
      request.addEventListener('blocked', () => {
        console.warn(`[Lody] deleteDatabase blocked by an open connection: ${name}`);
      });
    } catch (error) {
      console.warn(`[Lody] deleteDatabase threw for ${name}`, error);
      done();
    }
  });
}

/**
 * Delete every `lody*` IndexedDB database and Cache Storage entry, plus the
 * localStorage connection-state caches (Streams JWT/gateway, workspace-info
 * map, cursor-bypass markers — see `LOCAL_STORAGE_CACHE_KEYS`). Preserves the
 * localStorage auth token, language, and preferences — this clears recoverable
 * local cache (Loro replica, stream cursors, mention/PR/skill/eager-sync caches,
 * image caches), not the user's session or settings.
 *
 * @param extraNames Additional IndexedDB names to delete unconditionally — e.g.
 *   the current workspace's databases, in case its info isn't cached yet. All
 *   visited workspaces are already covered via the cached workspace-info map.
 */
export async function clearAllLodyLocalCache(extraNames: string[] = []): Promise<void> {
  if (typeof indexedDB !== 'undefined') {
    const names = new Set<string>([
      ...KNOWN_INDEXEDDB_NAMES,
      ...knownWorkspaceDatabaseNames(),
      ...extraNames,
    ]);
    try {
      const databases = (await indexedDB.databases?.()) ?? [];
      for (const database of databases) {
        if (database.name && database.name.startsWith('lody')) {
          names.add(database.name);
        }
      }
    } catch {
      // `indexedDB.databases()` is unsupported (e.g. Firefox) — fall back to the
      // known static names plus any per-workspace names the caller passed.
    }
    await Promise.all([...names].map(deleteDatabaseBestEffort));
  }

  if (typeof caches !== 'undefined') {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith('lody')).map((key) => caches.delete(key))
      );
    } catch (error) {
      console.warn('[Lody] failed to clear Cache Storage', error);
    }
  }

  // Last: `knownWorkspaceDatabaseNames()` above needs `lody:workspaceInfo`.
  clearLodyLocalStorageCaches();
}

/**
 * Delete EVERY local database, cache, and stored value for this origin, not just
 * the `lody*` ones, and drop any registered service worker. This is the hard
 * reset: it also removes the auth token and preferences, so the app comes back
 * signed out and factory-fresh.
 */
export async function clearAllLodyLocalData(extraNames: string[] = []): Promise<void> {
  clearWebStorage();
  clearCookies();

  if (typeof indexedDB !== 'undefined') {
    const names = new Set<string>([
      ...KNOWN_INDEXEDDB_NAMES,
      ...knownWorkspaceDatabaseNames(),
      ...extraNames,
    ]);
    try {
      const databases = (await indexedDB.databases?.()) ?? [];
      for (const database of databases) {
        // Unprefixed too: a hard reset is meant to leave nothing behind, and on
        // the app origin every database belongs to the app.
        if (database.name) {
          names.add(database.name);
        }
      }
    } catch {
      // `indexedDB.databases()` is unsupported (e.g. Firefox) — fall back to the
      // known static names plus any per-workspace names the caller passed.
    }
    await Promise.all([...names].map(deleteDatabaseBestEffort));
  }

  if (typeof caches !== 'undefined') {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch (error) {
      console.warn('[Lody] failed to clear Cache Storage', error);
    }
  }

  await unregisterServiceWorkers();
}

/** Wipe both synchronous web stores. Removes the auth token and preferences. */
function clearWebStorage(): void {
  for (const read of [() => localStorage, () => sessionStorage]) {
    try {
      read().clear();
    } catch (error) {
      console.warn('[Lody] failed to clear web storage', error);
    }
  }
}

/**
 * Expire every cookie readable from script, for the current path and each parent
 * domain. `HttpOnly` cookies are invisible here by design — the sign-out path
 * that matters for recovery is the locally stored token, which `clearWebStorage`
 * removes.
 */
function clearCookies(): void {
  if (typeof document === 'undefined') return;
  let cookies: string[];
  try {
    cookies = document.cookie ? document.cookie.split(';') : [];
  } catch {
    return;
  }
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  const domains = new Set<string>(['']);
  if (hostname && hostname !== 'localhost') {
    const labels = hostname.split('.');
    for (let index = 0; index < labels.length - 1; index += 1) {
      domains.add(labels.slice(index).join('.'));
    }
  }

  for (const cookie of cookies) {
    const name = cookie.split('=')[0]?.trim();
    if (!name) continue;
    for (const domain of domains) {
      try {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${
          domain ? `; domain=${domain}` : ''
        }`;
      } catch {
        // A cookie we cannot overwrite is not worth aborting the reset for.
      }
    }
  }
}

async function unregisterServiceWorkers(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch (error) {
    console.warn('[Lody] failed to unregister service workers', error);
  }
}

function writePendingFlag(value: string): void {
  try {
    localStorage.setItem(CACHE_CLEAR_FLAG, value);
  } catch (error) {
    console.warn('[Lody] failed to set cache-clear flag', error);
  }
}

/** Mark that the cache should be cleared on the next boot, before reloading. */
export function markCacheClearPending(): void {
  writePendingFlag(CACHE_CLEAR_VALUE);
}

/** Cap on how long the escape hatch waits for the server to revoke the session. */
const SIGN_OUT_TIMEOUT_MS = 1500;

/**
 * Ask the server to end the session before the local wipe, so a server-side
 * session (or a cookie script cannot touch) cannot sign the user straight back
 * into the state they are trying to escape.
 *
 * Bounded and never rethrows: the local wipe is the part that has to happen, and
 * "stuck" users are often stuck precisely because the network is unhappy. The
 * local-only desktop build has no account and registers no client, so this is a
 * no-op there.
 */
async function revokeServerSessionBestEffort(): Promise<void> {
  const authClient = getRegisteredAuthClient();
  if (!authClient) return;
  try {
    await Promise.race([
      authClient.signOut(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SIGN_OUT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.warn('[Lody] sign-out during hard reset failed; wiping locally anyway', error);
  }
}

/**
 * Wipe everything reachable synchronously (auth token, preferences, cookies),
 * arm the boot-time wipe for the asynchronous stores, and reload into the app
 * root signed out.
 *
 * Storage is cleared BEFORE the flag is written, otherwise `clearWebStorage`
 * would remove the flag we just set and boot would skip the IndexedDB pass.
 * Navigating to `/` first means the reload does not land back on the route that
 * crashed.
 */
export async function startHardReset(): Promise<void> {
  await revokeServerSessionBestEffort();
  clearWebStorage();
  clearCookies();
  writePendingFlag(HARD_RESET_VALUE);
  replaceAppWindowLocation('/');
  reloadApp();
}

export function readPendingLocalClearMode(): PendingLocalClearMode | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CACHE_CLEAR_FLAG);
  } catch {
    return null;
  }
  if (raw === HARD_RESET_VALUE) return 'hard';
  if (raw === CACHE_CLEAR_VALUE) return 'cache';
  return null;
}

// One clear per page load, shared by every caller. `AppInitializer` kicks it off
// so a user wedged before any workspace exists (e.g. stuck signing in) still
// gets the wipe, while `RuntimeProvider` awaits the same promise so the repo DB
// is never reopened mid-delete.
let bootClearPromise: Promise<PendingLocalClearMode | null> | null = null;

async function runPendingClearOnBoot(): Promise<PendingLocalClearMode | null> {
  const mode = readPendingLocalClearMode();
  if (!mode) return null;

  try {
    if (mode === 'hard') {
      await clearAllLodyLocalData();
    } else {
      await clearAllLodyLocalCache();
    }
  } finally {
    try {
      localStorage.removeItem(CACHE_CLEAR_FLAG);
    } catch (error) {
      console.warn('[Lody] failed to clear cache-clear flag', error);
    }
  }
  return mode;
}

/**
 * If a clear was requested before the last reload, run it now and clear the
 * flag. No-op (a single synchronous localStorage read) on normal boots. Call
 * this from `RuntimeProvider` before the workspace runtime opens the repo
 * IndexedDB.
 *
 * @param extraNames Additional IndexedDB names to delete when a clear is
 *   pending — e.g. the current workspace's databases, in case its info isn't
 *   cached yet.
 */
export async function maybeClearLodyCacheOnBoot(extraNames: string[] = []): Promise<void> {
  bootClearPromise ??= runPendingClearOnBoot();
  const mode = await bootClearPromise;
  // Nothing was pending, or this caller has no extra databases to contribute.
  if (!mode || extraNames.length === 0) return;
  await Promise.all(extraNames.map(deleteDatabaseBestEffort));
}

/** Test-only: forget the per-page-load memo so each case starts clean. */
export function resetBootClearMemoForTests(): void {
  bootClearPromise = null;
}

/**
 * Reload the app consistently across surfaces. Electron reloads through the main
 * process (preserves the window); web and mobile (Capacitor WebView) reload the
 * page directly. The current URL is preserved, so navigate to the destination
 * before calling this.
 */
export function reloadApp(): void {
  if (typeof window === 'undefined') return;
  if (window.__LODY_ELECTRON__ === true) {
    const api = window.api as
      | (typeof window.api & { requestRendererReload?: () => void })
      | undefined;
    const requestRendererReload = api?.requestRendererReload;
    if (typeof requestRendererReload === 'function') {
      requestRendererReload();
      return;
    }
  }
  window.location.reload();
}
