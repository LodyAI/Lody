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
 *
 * On the desktop the same two levels can also be armed from outside the app with
 * `lody app reset-cache`, for a renderer too wedged to click either. That request
 * reaches the boot path below through the Electron main process instead of the
 * flag; see `apps/electron/src/main/services/local-reset-service.ts`.
 */

import { LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX } from '@lody/shared';
import { workspaceInfoCache } from './local-storage-cache';
import { EAGER_SYNC_HIGH_WATER_DB_NAME } from './eager-sync-high-water-cache';
import { EAGER_SYNC_CACHE_DB } from '../providers/eager-sync-snapshot-cache';
import { replaceAppWindowLocation } from './app-location';
import { getRegisteredAuthClient } from './auth-client-singleton';
import { getIpcServices } from './electron-ipc-client';
import { isWarmWindow } from './desktop-window';
import { PROMPT_SHORTCUT_DATA_PREFIX } from './prompt-shortcut-storage';
import { ROOST_HISTORY_CACHE_DB } from './roost-history-cache';
import { SESSION_INPUT_DATABASE } from './session-input-storage';
import {
  CLIENT_LOG_DATABASE,
  flushClientLog,
  recordClientError,
  recordClientLog,
} from './client-log';

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
/**
 * Legacy flag values written by builds that kept a durable session-send journal
 * (`force-cache` / `force-all` meant "clear even if sends are pending"). Every
 * clear is unconditional now, so they are read as their plain modes, which lets
 * a clear armed by such a build still complete on the first boot after upgrade.
 * Nothing writes them any more; drop them after one release.
 */
const LEGACY_FORCED_CACHE_CLEAR_VALUE = 'force-cache';
const LEGACY_FORCED_HARD_RESET_VALUE = 'force-all';

export type PendingLocalClearMode = 'cache' | 'hard';

/** IndexedDB databases created with static names (not suffixed per workspace). */
const KNOWN_INDEXEDDB_NAMES = [
  SESSION_INPUT_DATABASE,
  CLIENT_LOG_DATABASE,
  ROOST_HISTORY_CACHE_DB,
  // Durable session-send journal of earlier builds; no longer written, but an
  // upgraded install may still hold it, and a cache clear should remove it.
  'lody-session-send-v1',
  EAGER_SYNC_HIGH_WATER_DB_NAME,
  EAGER_SYNC_CACHE_DB,
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
 * `lody:session-share-secret:v1:*` is deliberately excluded: these are device-local
 * credentials that cannot be recovered from the server. Only a hard reset clears
 * them; an ordinary cache repair must not force every share link to be reset.
 */
const LOCAL_STORAGE_CACHE_KEYS = [
  // slug → workspaceId/name map (`local-storage-cache.ts`). Read by
  // `knownWorkspaceDatabaseNames()` to enumerate per-workspace databases, so
  // the localStorage pass below must run AFTER that enumeration.
  'lody:workspaceInfo',
  'lody:githubReposCache',
  'lody:githubBranchesCache',
  'lody:usageDayDetails',
  // Cached current-user snapshot (`auth-bootstrap.ts`); the auth token itself
  // is deliberately kept — a cache clear does not sign the user out.
  'lody:auth-bootstrap',
  // `@session:` slug → sessionId map (`mention-session-source.ts`); rebuilt from
  // the live session list as soon as a composer mounts.
  'lody:session-mention-slugs',
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

/** `blocked` means another connection still held the database when the wait ended. */
type DeleteOutcome = 'deleted' | 'failed' | 'blocked';

function deleteDatabaseBestEffort(name: string): Promise<DeleteOutcome> {
  return new Promise<DeleteOutcome>((resolve) => {
    let settled = false;
    const done = (outcome: DeleteOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // If another open connection (e.g. a second tab) blocks the delete, don't
    // hang boot forever — give up after a bounded wait and move on.
    const timer = setTimeout(() => done('blocked'), DELETE_TIMEOUT_MS);
    try {
      const request = indexedDB.deleteDatabase(name);
      request.addEventListener('success', () => done('deleted'));
      request.addEventListener('error', () => {
        // A storage backend that cannot open the database usually cannot delete
        // it either. Say so: a silent failure here reads as "clear did nothing".
        console.warn(`[Lody] deleteDatabase failed for ${name}`, request.error);
        done('failed');
      });
      request.addEventListener('blocked', () => {
        console.warn(`[Lody] deleteDatabase blocked by an open connection: ${name}`);
      });
    } catch (error) {
      console.warn(`[Lody] deleteDatabase threw for ${name}`, error);
      done('failed');
    }
  });
}

/** What a clear could not delete. Empty when every targeted database is gone. */
export type LocalClearReport = { failed: string[] };

/**
 * Delete `names`, then re-enumerate where the engine can: a database that still
 * exists afterwards was not cleared, whatever its request reported.
 */
async function deleteDatabases(names: string[]): Promise<string[]> {
  const outcomes = await Promise.all(names.map(deleteDatabaseBestEffort));
  const failed = new Set(names.filter((_, index) => outcomes[index] !== 'deleted'));
  try {
    const remaining = new Set(
      ((await indexedDB.databases?.()) ?? []).map((database) => database.name)
    );
    for (const name of names) if (remaining.has(name)) failed.add(name);
  } catch {
    // No enumeration (e.g. Firefox): the request outcomes are all there is.
  }
  return [...failed];
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
export async function clearAllLodyLocalCache(extraNames: string[] = []): Promise<LocalClearReport> {
  let failed: string[] = [];
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
    // A Shortcut outbox may contain the only copy of an offline save. Only the
    // explicitly destructive hard reset below may remove these databases. The
    // client log is what explains why a clear was needed, so it stays too.
    failed = await deleteDatabases(
      [...names].filter(
        (name) =>
          !name.startsWith(PROMPT_SHORTCUT_DATA_PREFIX) &&
          name !== SESSION_INPUT_DATABASE &&
          name !== CLIENT_LOG_DATABASE
      )
    );
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
  return { failed };
}

/**
 * Delete EVERY local database, cache, and stored value for this origin, not just
 * the `lody*` ones, and drop any registered service worker. This is the hard
 * reset: it also removes the auth token and preferences, so the app comes back
 * signed out and factory-fresh.
 */
export async function clearAllLodyLocalData(extraNames: string[] = []): Promise<LocalClearReport> {
  clearWebStorage();
  clearCookies();

  let failed: string[] = [];
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
    failed = await deleteDatabases([...names]);
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
  return { failed };
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

/**
 * Restart into the recoverable-cache clear: set the boot flag and reload this
 * window, as the settings action always has. Returns false when the flag could
 * not be persisted, so the caller can say so instead of reloading into the same
 * state.
 *
 * `relaunch` is for a retry after a clear that could not delete everything: a
 * renderer reload keeps the desktop's main process and Chromium's storage
 * backend, which may be what failed. The desktop then relaunches through the
 * one-shot request `lody app reset-cache` writes, running the clear in a fresh
 * process. That quits the whole app, including the embedded CLI and its running
 * agents, so it is never the default; the quit asks every window first, and a
 * Stay answer returns false with nothing armed.
 */
export async function restartIntoCacheClear(
  options: { relaunch?: boolean } = {}
): Promise<boolean> {
  const services = getIpcServices();
  if (options.relaunch === true && services) {
    try {
      return (await services.app.relaunchIntoLocalReset('cache')) === 'quitting';
    } catch (error) {
      console.warn('[Lody] relaunch into a cache clear failed; reloading instead', error);
    }
  }
  markCacheClearPending();
  if (readPendingLocalClearMode() === null) return false;
  reloadApp();
  return true;
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
 * root signed out. Resolves false when the desktop quit for the native wipe was
 * cancelled and nothing was wiped.
 *
 * Storage is cleared BEFORE the flag is written, otherwise `clearWebStorage`
 * would remove the flag we just set and boot would skip the IndexedDB pass.
 * Navigating to `/` first means the reload does not land back on the route that
 * crashed.
 */
export async function startHardReset(): Promise<boolean> {
  await revokeServerSessionBestEffort();
  const native = await startNativeHardReset();
  if (native === 'started') return true;
  // The desktop quit was answered Stay (or its cleanup failed): the person
  // chose to keep the app running, so do not wipe it from under them.
  if (native === 'cancelled') return false;
  clearWebStorage();
  clearCookies();
  writePendingFlag(HARD_RESET_VALUE);
  replaceAppWindowLocation('/');
  reloadApp();
  return true;
}

/**
 * Installed by a native mobile shell as `window.__LODY_NATIVE_RESET__`.
 * `resetAllData` removes every website data type of the WebView's data store at
 * the file level, clears the shell's own credential storage and cookies, and
 * reloads the WebView at the app root — the in-app equivalent of reinstalling.
 * It may never resolve, because the page it was called from goes away.
 */
export type LodyNativeResetBridge = {
  version: 1;
  resetAllData: () => Promise<void>;
};

/**
 * The hard reset done by the host instead of through web APIs, which can only
 * delete what the storage backend will still open. Electron relaunches into the
 * native wipe the CLI's `--hard` uses; a mobile shell uses its bridge.
 * `unavailable` (neither exists, or the host refused) falls back to the web
 * wipe; `cancelled` means the desktop quit was answered Stay.
 */
async function startNativeHardReset(): Promise<'started' | 'cancelled' | 'unavailable'> {
  const services = getIpcServices();
  const bridge =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { __LODY_NATIVE_RESET__?: LodyNativeResetBridge })
          .__LODY_NATIVE_RESET__;
  try {
    if (services) {
      return (await services.app.relaunchIntoLocalReset('hard')) === 'quitting'
        ? 'started'
        : 'cancelled';
    }
    if (bridge?.version === 1) {
      await bridge.resetAllData();
      return 'started';
    }
  } catch (error) {
    console.warn('[Lody] native hard reset failed; wiping through web storage', error);
  }
  return 'unavailable';
}

/**
 * What the last boot-time clear did, kept outside the cache-clear DELETE list
 * (and rewritten after a hard wipe) so the recovery screen can tell a clear
 * that ran from one that could not delete what it targeted. Nothing re-runs a
 * clear on its own: a retry deletes everything again, which after the person
 * signed back in would sign them out again. Whether to retry is theirs.
 */
const LAST_LOCAL_CLEAR_KEY = 'lody:lastLocalClear';
/** A clear older than this says nothing about the wait in front of the person. */
export const LOCAL_CLEAR_RECORD_RELEVANCE_MS = 24 * 60 * 60 * 1000;

export type LocalClearRecord = {
  mode: PendingLocalClearMode;
  atMs: number;
  ok: boolean;
  failedCount: number;
};

/** The last clear if it ran within `LOCAL_CLEAR_RECORD_RELEVANCE_MS`. */
export function readRecentLocalClear(nowMs: number): LocalClearRecord | null {
  const record = readLastLocalClear();
  if (!record) return null;
  const ageMs = nowMs - record.atMs;
  return ageMs >= 0 && ageMs < LOCAL_CLEAR_RECORD_RELEVANCE_MS ? record : null;
}

export function readLastLocalClear(): LocalClearRecord | null {
  try {
    const raw = localStorage.getItem(LAST_LOCAL_CLEAR_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value: Partial<Record<keyof LocalClearRecord, unknown>> = parsed;
    if (
      (value.mode !== 'cache' && value.mode !== 'hard') ||
      typeof value.atMs !== 'number' ||
      typeof value.ok !== 'boolean'
    ) {
      return null;
    }
    return {
      mode: value.mode,
      atMs: value.atMs,
      ok: value.ok,
      failedCount: typeof value.failedCount === 'number' ? value.failedCount : 0,
    };
  } catch {
    return null;
  }
}

function writeLastLocalClear(record: LocalClearRecord): void {
  try {
    localStorage.setItem(LAST_LOCAL_CLEAR_KEY, JSON.stringify(record));
  } catch (error) {
    console.warn('[Lody] failed to record the local clear result', error);
  }
}

/** The clear this page load ran at boot, handed once to the outcome reporter. */
let bootClearRecord: LocalClearRecord | null = null;

export function takeBootLocalClear(): LocalClearRecord | null {
  const record = bootClearRecord;
  bootClearRecord = null;
  return record;
}

export function readPendingLocalClearMode(): PendingLocalClearMode | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CACHE_CLEAR_FLAG);
  } catch {
    return null;
  }
  if (raw === HARD_RESET_VALUE || raw === LEGACY_FORCED_HARD_RESET_VALUE) return 'hard';
  if (raw === CACHE_CLEAR_VALUE || raw === LEGACY_FORCED_CACHE_CLEAR_VALUE) return 'cache';
  return null;
}

/** Cap on how long boot waits for the desktop to answer whether a reset is armed. */
const NATIVE_PENDING_CLEAR_TIMEOUT_MS = 2000;

/**
 * Ask the desktop whether `lody app reset-cache` armed a clear for this launch.
 *
 * A user whose renderer is wedged cannot press Settings → Clear cache, so the CLI
 * arms it out of band and the Electron main process reports it here — once, so a
 * later reload of the same window does not repeat the clear. Bounded because this
 * runs on every desktop boot: a main process that never answers must delay the
 * first render, not prevent it. Web and mobile have no bridge and skip it.
 */
async function readNativePendingClearMode(): Promise<PendingLocalClearMode | null> {
  const services = getIpcServices();
  if (!services) return null;
  try {
    return await Promise.race([
      services.app.consumePendingLocalClear(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), NATIVE_PENDING_CLEAR_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.warn('[Lody] failed to read a CLI-armed cache clear', error);
    return null;
  }
}

// One clear per page load, shared by every caller. `AppInitializer` kicks it off
// so a user wedged before any workspace exists (e.g. stuck signing in) still
// gets the wipe, while `RuntimeProvider` awaits the same promise so the repo DB
// is never reopened mid-delete.
let bootClearPromise: Promise<PendingLocalClearMode | null> | null = null;

async function runPendingClearOnBoot(): Promise<PendingLocalClearMode | null> {
  const mode = readPendingLocalClearMode() ?? (await readNativePendingClearMode());
  if (!mode) return null;
  await getIpcServices()?.app.prepareCacheClear();

  let failed: string[] = ['unknown'];
  try {
    ({ failed } = mode === 'hard' ? await clearAllLodyLocalData() : await clearAllLodyLocalCache());
  } catch (error) {
    console.warn('[Lody] local clear threw', error);
    recordClientError('cache.clear_on_boot_threw', error, { mode });
  }
  const record: LocalClearRecord = {
    mode,
    atMs: Date.now(),
    ok: failed.length === 0,
    failedCount: failed.length,
  };
  writeLastLocalClear(record);
  bootClearRecord = record;
  if (!record.ok) console.warn('[Lody] local clear left databases behind', record);
  recordClientLog(record.ok ? 'info' : 'error', 'cache.clear_on_boot', undefined, {
    mode,
    ok: record.ok,
    failedCount: record.failedCount,
  });
  try {
    localStorage.removeItem(CACHE_CLEAR_FLAG);
  } catch (error) {
    console.warn('[Lody] failed to clear cache-clear flag', error);
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
  // The hidden warm spare boots the same providers; it must never consume a
  // clear armed for the window the user will actually see.
  if (isWarmWindow()) return;
  bootClearPromise ??= runPendingClearOnBoot();
  const mode = await bootClearPromise;
  // Nothing was pending, or this caller has no extra databases to contribute.
  if (!mode || extraNames.length === 0) return;
  const failed = await deleteDatabases(
    extraNames.filter(
      (name) =>
        mode === 'hard' ||
        (!name.startsWith(PROMPT_SHORTCUT_DATA_PREFIX) && name !== SESSION_INPUT_DATABASE)
    )
  );
  if (failed.length > 0) recordLateClearFailures(failed.length);
}

/** Fold failures from a caller's extra databases into this boot's clear record. */
function recordLateClearFailures(count: number): void {
  const record = readLastLocalClear();
  if (!record) return;
  const updated = { ...record, ok: false, failedCount: record.failedCount + count };
  writeLastLocalClear(updated);
  if (bootClearRecord) bootClearRecord = updated;
}

/** Test-only: forget the per-page-load memo so each case starts clean. */
export function resetBootClearMemoForTests(): void {
  bootClearPromise = null;
  bootClearRecord = null;
}

/**
 * Reload the app consistently across surfaces. Electron reloads through the main
 * process (preserves the window); web and mobile (Capacitor WebView) reload the
 * page directly. The current URL is preserved, so navigate to the destination
 * before calling this.
 */
export function reloadApp(): void {
  if (typeof window === 'undefined') return;
  // The reload will not wait for IndexedDB; the page-hide spill keeps this entry.
  recordClientLog('warn', 'app.reload_requested', undefined, { path: window.location.pathname });
  void flushClientLog();
  if (window.__LODY_ELECTRON__ === true) {
    if (getIpcServices()) {
      void getIpcServices()!.app.requestRendererReload();
      return;
    }
  }
  window.location.reload();
}
