/**
 * The renderer's own log of important events: crashes a boundary caught,
 * failures nothing else retries, and the page lifecycle around them. It lives
 * in IndexedDB so it survives the event it explains — an iOS WebView the system
 * killed and reloaded, a renderer that crashed — and rides along a
 * machine-backed bug report as its own section (`buildClientLogUpload`).
 *
 * Only what callers pass to `recordClientLog` / `recordClientError` is kept;
 * nothing intercepts `console`. Callers record events and identifiers, never
 * prompts, conversation text, or file contents. Every string is still passed
 * through `redactClientLogText`, which strips credentials it recognizes.
 *
 * Bounded twice: entries older than 48 hours are dropped, and the newest
 * 2 MiB are kept. A cache clear keeps the log (it is what explains why the
 * clear was needed); a full reset removes it with everything else.
 *
 * This module is imported by the pre-React boot and recovery pages: keep it free
 * of schema libraries and of the app's path aliases.
 */
import {
  BUG_REPORT_CLIENT_LOG_LIMITS,
  type BugReportClientLog,
} from '@lody/shared/bug-report-client-log';
import { collectClientBuildInfo } from './client-build-info';

export type ClientLogLevel = 'error' | 'warn' | 'info';
export type ClientLogDetails = Record<string, string | number | boolean | null | undefined>;

export const CLIENT_LOG_DATABASE = 'lody-client-log';
const STORE = 'entries';

export const CLIENT_LOG_LIMITS = {
  maxBytes: BUG_REPORT_CLIENT_LOG_LIMITS.maxRawBytes,
  maxAgeMs: 48 * 60 * 60 * 1000,
  /** One entry, stack included. */
  maxEntryBytes: 16 * 1024,
  /** Entries held in memory while IndexedDB is unavailable or a write is pending. */
  maxPendingEntries: 500,
  /** Unwritten entries saved synchronously when the page hides or unloads. */
  maxSpillBytes: 128 * 1024,
} as const;

/** Device-local diagnostics, like `lody:lastActiveAt`: not in the cache-clear DELETE list. */
const BOOT_MARKERS_KEY = 'lody:clientLog:boots';
const SPILL_KEY = 'lody:clientLog:spill';
const PAGE_LOCK_PREFIX = 'lody-client-log-page:';
const MAX_BOOT_MARKERS = 20;
const FLUSH_DELAY_MS = 1000;
/** The store is pruned after this much has been written since the last prune. */
const PRUNE_AFTER_BYTES = 256 * 1024;
/** An open that has not settled by then counts as unavailable for this attempt. */
const OPEN_TIMEOUT_MS = 3000;
const OPEN_RETRY_DELAY_MS = 30_000;

type StoredEntry = { key: string; at: number; bytes: number; line: string };

type BootMarker = {
  startedAt: number;
  visibility: string;
  changedAt: number;
  /** `pagehide` ran: the page went away the ordinary way. */
  ended: boolean;
};

const encoder = new TextEncoder();

let now: () => number = Date.now;
let bootId = createBootId();
let sequence = 0;
let pending: StoredEntry[] = [];
/** Taken from `pending` into a transaction that has not committed yet. */
let inFlight: StoredEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> = Promise.resolve();
let bytesSincePrune = Number.POSITIVE_INFINITY;
let dbPromise: Promise<IDBDatabase | null> | null = null;
let openRetryAt = 0;
/** Kept when IndexedDB cannot be opened, under the same limits. */
let memoryEntries: StoredEntry[] = [];
let installed = false;

function createBootId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** This page load's id; every line carries it, so a reload reads as a new id. */
export function getClientLogBootId(): string {
  return bootId;
}

/** Parameter names whose values are credentials, wherever the word sits in the name. */
const SECRET_QUERY_NAME =
  /token|secret|passw(?:or)?d|key|sig|signature|credential|auth|session|jwt|ott|code/iu;
/** Field and header names whose values are credentials (narrower: prose is not a query). */
const SECRET_FIELD_NAME =
  /token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|signature|credential|cookie|authorization|session[_-]?id/iu;
const REDACTED = '[redacted]';

/**
 * Strip credentials a message can carry: bearer/basic headers, JWTs, and
 * credential-named query parameters, JSON fields and headers, wherever the
 * credential word sits in the name (`refresh_token`, `X-Amz-Signature`,
 * `client_secret`, `api_key`). Applied to every string the log keeps, on error
 * paths, so every pattern is bounded: names are captured with a length limit
 * and tested in a callback rather than searched by backtracking.
 */
export function redactClientLogText(text: string): string {
  return (
    text
      .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/giu, `$1 ${REDACTED}`)
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, '[jwt]')
      // Query and fragment parameters, including short names (`code`, `sig`, `key`, `ott`).
      .replace(/([?&#;])([^=&#\s"']{1,96})=([^&#\s"']+)/gu, (match, lead, name, value) =>
        SECRET_QUERY_NAME.test(name) && value !== REDACTED ? `${lead}${name}=${REDACTED}` : match
      )
      // `"name": "value"`, `name: value`, `name=value` outside a query string.
      .replace(
        /([A-Za-z0-9_.-]{1,64})(["']?\s{0,4}[:=]\s{0,4}["']?)([^\s"',;&}]+)/gu,
        (match, name: string, separator: string, value: string) =>
          SECRET_FIELD_NAME.test(name) && value !== REDACTED
            ? `${name}${separator}${REDACTED}`
            : match
      )
  );
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  const marker = '…[truncated]';
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && encoder.encode(text.slice(0, end)).byteLength + marker.length > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  return `${text.slice(0, end)}${marker}`;
}

function formatLine(
  at: number,
  level: ClientLogLevel,
  event: string,
  message: string | undefined,
  details: ClientLogDetails | undefined,
  stack: string | undefined
): string {
  const fields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (value === undefined) continue;
    fields[key] = typeof value === 'string' ? redactClientLogText(value) : value;
  }
  let line = `${new Date(at).toISOString()} ${level.toUpperCase().padEnd(5)} ${bootId} ${event}`;
  if (message) line += ` ${redactClientLogText(message)}`;
  if (Object.keys(fields).length > 0) line += ` ${JSON.stringify(fields)}`;
  if (stack) {
    line += `\n${redactClientLogText(stack)
      .split('\n')
      .map((stackLine) => `    ${stackLine.trim()}`)
      .join('\n')}`;
  }
  return truncateToBytes(line, CLIENT_LOG_LIMITS.maxEntryBytes);
}

/**
 * Record one important event. Synchronous and never throws: it is called from
 * error paths, which must not fail because diagnostics did.
 */
export function recordClientLog(
  level: ClientLogLevel,
  event: string,
  message?: string,
  details?: ClientLogDetails,
  stack?: string
): void {
  try {
    const at = now();
    const line = formatLine(at, level, event, message, details, stack);
    sequence += 1;
    pending.push({
      key: `${bootId}:${String(sequence).padStart(8, '0')}`,
      at,
      line,
      bytes: encoder.encode(line).byteLength + 1,
    });
    if (pending.length > CLIENT_LOG_LIMITS.maxPendingEntries) {
      pending = pending.slice(-CLIENT_LOG_LIMITS.maxPendingEntries);
    }
    scheduleFlush(level === 'error' ? 0 : FLUSH_DELAY_MS);
  } catch {
    // Diagnostics only.
  }
}

/** Record a caught error with its name, message and stack. */
export function recordClientError(
  event: string,
  error: unknown,
  details?: ClientLogDetails,
  level: ClientLogLevel = 'error'
): void {
  const name =
    typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string'
      ? error.name
      : typeof error;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  recordClientLog(level, event, `${name}: ${message}`, details, stack);
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer !== null) {
    if (delayMs > 0) return;
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushClientLog();
  }, delayMs);
}

/**
 * Open the log database. An open that errors or does not settle in time
 * (WebKit can leave one pending after its storage process restarts) counts as
 * unavailable for this attempt and is retried later; a late success is closed
 * rather than leaked, so it cannot block a full reset's delete.
 */
function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (now() < openRetryAt || typeof indexedDB === 'undefined') return Promise.resolve(null);
  let attempt: Promise<IDBDatabase | null>;
  attempt = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null): void => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (!db) {
        if (dbPromise === attempt) dbPromise = null;
        openRetryAt = now() + OPEN_RETRY_DELAY_MS;
      }
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS);
    try {
      const request = indexedDB.open(CLIENT_LOG_DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { autoIncrement: true });
      };
      request.onsuccess = () => {
        const db = request.result;
        // A full reset deletes this database; let it.
        db.onversionchange = () => {
          db.close();
          if (dbPromise === attempt) dbPromise = null;
        };
        finish(db);
      };
      request.onerror = () => finish(null);
      // `blocked` is not a failure: the open completes once the other
      // connection closes. The timeout above bounds the wait.
    } catch {
      finish(null);
    }
  });
  dbPromise = attempt;
  return attempt;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function compareEntries(left: StoredEntry, right: StoredEntry): number {
  return left.at - right.at || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

/** One copy of each entry, oldest first, within the age and byte limits. */
function normalizeEntries(entries: StoredEntry[]): StoredEntry[] {
  const byKey = new Map<string, StoredEntry>();
  for (const entry of entries) {
    if (entry && typeof entry.key === 'string') byKey.set(entry.key, entry);
  }
  const sorted = [...byKey.values()].sort(compareEntries);
  const cutoff = now() - CLIENT_LOG_LIMITS.maxAgeMs;
  const kept: StoredEntry[] = [];
  let bytes = 0;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const entry = sorted[index];
    if (!entry || entry.at < cutoff || bytes + entry.bytes > CLIENT_LOG_LIMITS.maxBytes) break;
    bytes += entry.bytes;
    kept.push(entry);
  }
  return kept.reverse();
}

/** Keep only what `normalizeEntries` keeps; everything else in the store is deleted. */
async function pruneDatabase(db: IDBDatabase): Promise<void> {
  const transaction = db.transaction(STORE, 'readwrite');
  const store = transaction.objectStore(STORE);
  const keysRequest = store.getAllKeys();
  const valuesRequest = store.getAll();
  valuesRequest.onsuccess = () => {
    const values = valuesRequest.result as StoredEntry[];
    const keep = new Set(normalizeEntries(values).map((entry) => entry.key));
    const seen = new Set<string>();
    (keysRequest.result as IDBValidKey[]).forEach((primaryKey, index) => {
      const entry = values[index];
      const entryKey = entry?.key;
      if (typeof entryKey !== 'string' || !keep.has(entryKey) || seen.has(entryKey)) {
        store.delete(primaryKey);
      } else {
        seen.add(entryKey);
      }
    });
  };
  await transactionDone(transaction);
}

function clearSpill(): void {
  try {
    localStorage.removeItem(SPILL_KEY);
  } catch {
    // Diagnostics only.
  }
}

/** Write pending entries now. Bug reports and page hides call this; it never rejects. */
export function flushClientLog(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushing = flushing.then(async () => {
    if (pending.length === 0) return;
    inFlight = pending;
    pending = [];
    const batch = inFlight;
    try {
      const db = await openDatabase();
      if (!db) {
        memoryEntries = normalizeEntries([...memoryEntries, ...batch]);
        return;
      }
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      for (const entry of batch) store.add(entry);
      await transactionDone(transaction);
      bytesSincePrune += batch.reduce((total, entry) => total + entry.bytes, 0);
      if (bytesSincePrune >= PRUNE_AFTER_BYTES) {
        bytesSincePrune = 0;
        await pruneDatabase(db);
      }
      if (pending.length === 0) clearSpill();
    } catch {
      memoryEntries = normalizeEntries([...memoryEntries, ...batch]);
    } finally {
      inFlight = [];
    }
  });
  return flushing;
}

/** `flushClientLog`, but give up waiting after `timeoutMs`; the write continues. */
export function flushClientLogWithin(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void flushClientLog().then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Save entries not yet committed to IndexedDB, synchronously. A reload or a
 * kill does not wait for an IndexedDB transaction, so these would otherwise be
 * lost — and they are usually the ones that explain the reload. The next page
 * imports them; reads drop duplicates by key.
 */
function spillUnwrittenEntries(): void {
  const unwritten = [...inFlight, ...pending, ...memoryEntries];
  if (unwritten.length === 0) return;
  const kept: StoredEntry[] = [];
  let bytes = 0;
  for (let index = unwritten.length - 1; index >= 0; index -= 1) {
    const entry = unwritten[index];
    if (!entry || bytes + entry.bytes > CLIENT_LOG_LIMITS.maxSpillBytes) break;
    bytes += entry.bytes;
    kept.push(entry);
  }
  try {
    localStorage.setItem(SPILL_KEY, JSON.stringify(kept.reverse()));
  } catch {
    // Diagnostics only.
  }
}

function importSpilledEntries(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SPILL_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      const entry = value as Partial<StoredEntry>;
      if (
        typeof entry.key === 'string' &&
        typeof entry.at === 'number' &&
        typeof entry.bytes === 'number' &&
        typeof entry.line === 'string'
      ) {
        pending.push({ key: entry.key, at: entry.at, bytes: entry.bytes, line: entry.line });
      }
    }
    scheduleFlush(0);
  } catch {
    clearSpill();
  }
}

async function readStoredEntries(): Promise<StoredEntry[]> {
  await flushClientLog();
  const db = await openDatabase();
  let stored: StoredEntry[] = [];
  if (db) {
    try {
      const transaction = db.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).getAll();
      await transactionDone(transaction);
      stored = request.result as StoredEntry[];
    } catch {
      stored = [];
    }
  }
  return normalizeEntries([...stored, ...memoryEntries, ...pending]);
}

/** The kept log, oldest first, within the age and byte limits. */
export async function readClientLog(): Promise<string> {
  const entries = await readStoredEntries();
  return entries.map((entry) => `${entry.line}\n`).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const body = new Response(buffer).body;
  if (!body) throw new Error('No readable body to compress.');
  return new Uint8Array(
    await new Response(body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  );
}

/**
 * The log as a bug report carries it, or `null` when there is nothing to send
 * or this engine cannot compress. Keeps the newest lines that fit both the raw
 * and the compressed budget.
 */
export async function buildClientLogUpload(): Promise<BugReportClientLog | null> {
  if (typeof CompressionStream === 'undefined') return null;
  let entries = await readStoredEntries();
  while (entries.length > 0) {
    const raw = encoder.encode(entries.map((entry) => `${entry.line}\n`).join(''));
    if (raw.byteLength <= BUG_REPORT_CLIENT_LOG_LIMITS.maxRawBytes) {
      const compressed = await gzip(raw);
      if (compressed.byteLength <= BUG_REPORT_CLIENT_LOG_LIMITS.maxCompressedBytes) {
        return {
          encoding: 'gzip-base64',
          data: bytesToBase64(compressed),
          rawBytes: raw.byteLength,
          compressedBytes: compressed.byteLength,
        };
      }
    }
    // Over a budget: drop the older half and try again.
    entries = entries.slice(Math.ceil(entries.length / 2));
  }
  return null;
}

/**
 * `buildClientLogUpload` for a caller that must not wait on storage: a bug
 * report is filed without the log rather than never.
 */
export function buildClientLogUploadWithin(timeoutMs: number): Promise<BugReportClientLog | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    buildClientLogUpload().then(
      (upload) => {
        clearTimeout(timer);
        resolve(upload);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

function readBootMarkers(): Record<string, BootMarker> {
  try {
    const raw = localStorage.getItem(BOOT_MARKERS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const markers: Record<string, BootMarker> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, Partial<BootMarker>>)) {
      if (typeof value.startedAt !== 'number' || typeof value.changedAt !== 'number') continue;
      markers[id] = {
        startedAt: value.startedAt,
        visibility: typeof value.visibility === 'string' ? value.visibility : 'unknown',
        changedAt: value.changedAt,
        ended: value.ended === true,
      };
    }
    return markers;
  } catch {
    return {};
  }
}

/**
 * Read-modify-write of the shared marker map. Each page changes only its own
 * entry (or removes one it has just reported), so pages of the same origin do
 * not overwrite each other's state.
 */
function updateBootMarkers(update: (markers: Record<string, BootMarker>) => void): void {
  try {
    const markers = readBootMarkers();
    update(markers);
    const cutoff = now() - CLIENT_LOG_LIMITS.maxAgeMs;
    const kept = Object.entries(markers)
      .filter(([, marker]) => !(marker.ended && marker.changedAt < cutoff))
      .sort(([, left], [, right]) => right.changedAt - left.changedAt)
      .slice(0, MAX_BOOT_MARKERS);
    localStorage.setItem(BOOT_MARKERS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Diagnostics only.
  }
}

export type ClientLogLockManager = {
  request: (name: string, callback: () => Promise<void>) => Promise<unknown>;
  query: () => Promise<{ held?: Array<{ name?: string }> }>;
};

function readLockManager(): ClientLogLockManager | null {
  const locks = (globalThis.navigator as { locks?: ClientLogLockManager } | undefined)?.locks;
  return locks && typeof locks.request === 'function' && typeof locks.query === 'function'
    ? locks
    : null;
}

/**
 * Report earlier pages that never reached `pagehide`. A page still running in
 * another window or tab holds its page lock and is skipped; without the Locks
 * API, liveness is unknown and the report says so.
 */
async function reportPagesEndedWithoutUnload(locks: ClientLogLockManager | null): Promise<void> {
  const candidates = Object.entries(readBootMarkers()).filter(
    ([id, marker]) => id !== bootId && !marker.ended
  );
  if (candidates.length === 0) return;
  let held: Set<string> | null = null;
  if (locks) {
    try {
      const snapshot = await locks.query();
      held = new Set((snapshot.held ?? []).map((lock) => lock.name ?? ''));
    } catch {
      held = null;
    }
  }
  const reported: string[] = [];
  for (const [id, marker] of candidates) {
    if (held?.has(`${PAGE_LOCK_PREFIX}${id}`)) continue;
    recordClientLog('warn', 'page.previous_ended_without_unload', undefined, {
      previousBootId: id,
      previousStartedAt: new Date(marker.startedAt).toISOString(),
      lastVisibility: marker.visibility,
      lastVisibilityAt: new Date(marker.changedAt).toISOString(),
      liveness: held ? 'not-running' : 'unknown',
    });
    reported.push(id);
  }
  if (reported.length > 0) {
    updateBootMarkers((markers) => {
      for (const id of reported) delete markers[id];
    });
  }
}

function readNavigationType(): string | null {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type ?? null;
  } catch {
    return null;
  }
}

function stripQuery(url: string | undefined): string | undefined {
  return url?.split(/[?#]/u)[0];
}

/**
 * Mounted once per page, by `AppInitializer` or the pre-React failure page,
 * whichever runs first; later calls are no-ops. Records the boot, reports
 * earlier pages that never reached `pagehide` (the WebView or renderer was
 * killed), imports the entries the last page saved on its way out, and logs
 * uncaught errors and the visibility changes around them.
 */
export function installClientLog(): () => void {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }
  installed = true;

  importSpilledEntries();
  const startedAt = now();
  updateBootMarkers((markers) => {
    markers[bootId] = {
      startedAt,
      visibility: document.visibilityState,
      changedAt: startedAt,
      ended: false,
    };
  });
  const updateOwnMarker = (patch: Partial<BootMarker>) => {
    updateBootMarkers((markers) => {
      const own = markers[bootId];
      markers[bootId] = {
        startedAt: own?.startedAt ?? startedAt,
        visibility: own?.visibility ?? document.visibilityState,
        changedAt: now(),
        ended: own?.ended ?? false,
        ...patch,
      };
    });
  };

  // Held for the page's life: tells later pages this one is still running.
  const locks = readLockManager();
  let releasePageLock: (() => void) | null = null;
  if (locks) {
    void locks
      .request(
        `${PAGE_LOCK_PREFIX}${bootId}`,
        () =>
          new Promise<void>((resolve) => {
            releasePageLock = resolve;
          })
      )
      .catch(() => undefined);
  }
  void reportPagesEndedWithoutUnload(locks);

  const build = collectClientBuildInfo();
  recordClientLog('info', 'page.boot', undefined, {
    navigationType: readNavigationType(),
    visibility: document.visibilityState,
    path: window.location.pathname,
    appVersion: build.appVersion,
    build: build.build,
    userAgent: navigator.userAgent,
  });

  const onError = (event: ErrorEvent) => {
    recordClientLog(
      'error',
      'window.error',
      event.message,
      {
        source: stripQuery(event.filename),
        line: event.lineno,
        column: event.colno,
      },
      event.error instanceof Error ? event.error.stack : undefined
    );
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    recordClientError('window.unhandled_rejection', event.reason);
  };
  const onVisibilityChange = () => {
    updateOwnMarker({ visibility: document.visibilityState });
    recordClientLog('info', 'page.visibility', document.visibilityState);
    if (document.visibilityState === 'hidden') {
      // A hidden page may be killed without another event.
      spillUnwrittenEntries();
      void flushClientLog();
    }
  };
  const onPageHide = (event: PageTransitionEvent) => {
    recordClientLog('info', 'page.hide', undefined, { persisted: event.persisted });
    updateOwnMarker({ ended: true });
    spillUnwrittenEntries();
    void flushClientLog();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    // Restored from the back/forward cache: the same page is alive again.
    updateOwnMarker({ ended: false });
    recordClientLog('info', 'page.restored');
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  return () => {
    installed = false;
    releasePageLock?.();
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  };
}

/**
 * Test-only: start a new page load. The database, boot markers and any spill
 * stay, as they would across a real reload; unwritten entries are dropped, as
 * a kill would drop them.
 */
export async function simulateClientLogReloadForTests(clock?: () => number): Promise<void> {
  await flushing;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  const db = await dbPromise;
  db?.close();
  dbPromise = null;
  openRetryAt = 0;
  pending = [];
  inFlight = [];
  memoryEntries = [];
  bytesSincePrune = Number.POSITIVE_INFINITY;
  sequence = 0;
  installed = false;
  bootId = createBootId();
  if (clock) now = clock;
}

/** Test-only: forget everything, including the database. */
export async function resetClientLogForTests(clock: () => number = Date.now): Promise<void> {
  await simulateClientLogReloadForTests(clock);
  try {
    localStorage.removeItem(BOOT_MARKERS_KEY);
    localStorage.removeItem(SPILL_KEY);
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(CLIENT_LOG_DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
