/**
 * Storage crisis: the renderer's Loro repo IndexedDB is full or dead.
 *
 * When the disk (or the origin's Chromium storage quota) runs out, IndexedDB
 * first rejects writes with `QuotaExceededError` and then usually kills the
 * connection outright — every later `db.transaction()` throws
 * `InvalidStateError: ... The database connection is closing.` That state is
 * NOT recoverable inside the page: freeing disk space does not reopen the dying
 * connection, so the app keeps failing (and, before this module, kept pasting
 * the raw DOMException text into a fresh toast on every retry) until the
 * process is restarted.
 *
 * So this is a one-way, fail-closed circuit breaker, not a retry policy:
 *
 * - The FIRST classified failure latches the crisis for the rest of the page
 *   lifetime. Later reports never overwrite it, so the recovery UI keeps naming
 *   the original cause.
 * - Once latched, `CrisisAwareStorageAdapter` refuses every repo IndexedDB call
 *   without touching the database, and replaces the raw engine error with
 *   `StorageCrisisError` so no caller can surface a raw `IDBDatabase` string.
 * - Recovery is quit/relaunch, driven by the user from `StorageCrisisDialog`.
 *
 * Deliberately NOT mirrored from `ResilientRemoteCursorStore`: that store falls
 * back to memory because Loro Streams cursors are rebuildable checkpoints. Repo
 * documents are the user's data, so an in-memory stand-in would silently accept
 * writes it can never persist.
 */

/** Why the repo IndexedDB is unusable. */
export type StorageCrisisKind =
  /** A write was rejected for lack of space. */
  | 'quota'
  /** The connection is closing/dead; nothing can be read or written. */
  | 'unavailable';

export type StorageCrisisState = {
  readonly kind: StorageCrisisKind;
  /** Storage-adapter method that first failed, e.g. `loadDoc`. */
  readonly operation: string;
  /** One-line engine text, for the dialog's technical details only. */
  readonly detail: string;
};

/**
 * Message shown wherever a crisis-time failure still reaches ordinary error
 * copy. It is deliberately generic and stable: the blocking dialog owns the
 * real explanation, and a raw DOMException must never take its place.
 */
export const STORAGE_CRISIS_ERROR_MESSAGE =
  'Local storage is full or unavailable. Free up disk space, then restart Lody.';

const STORAGE_CRISIS_ERROR_NAME = 'StorageCrisisError';

/** Thrown instead of the raw IndexedDB failure once a crisis is classified. */
export class StorageCrisisError extends Error {
  readonly kind: StorageCrisisKind;
  readonly operation: string;

  constructor(kind: StorageCrisisKind, operation: string, options?: ErrorOptions) {
    super(STORAGE_CRISIS_ERROR_MESSAGE, options);
    this.name = STORAGE_CRISIS_ERROR_NAME;
    this.kind = kind;
    this.operation = operation;
  }
}

export function isStorageCrisisError(error: unknown): error is StorageCrisisError {
  if (error instanceof StorageCrisisError) return true;
  // Name check as well: the renderer and a lazily loaded chunk can hold two
  // copies of this module, and `instanceof` would then miss.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === STORAGE_CRISIS_ERROR_NAME
  );
}

/** How deep to walk `cause` chains. loro-repo wraps at most two levels. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Chromium keeps the `IDBDatabase` object alive but refuses new transactions on
 * it after the backing store dies. This is the sticky aftermath error users
 * actually see, and it is thrown by a bare `db.transaction()` — outside every
 * request/abort handler loro-repo wraps — so it arrives unwrapped.
 */
const CONNECTION_CLOSING_PATTERN = /database connection is closing/i;
/** Chromium's disk-full failure when OPENING the database. */
const BACKING_STORE_PATTERN = /internal error opening backing store/i;

function readErrorField(value: unknown, field: 'name' | 'message'): string {
  if (typeof value !== 'object' || value === null) return '';
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' ? raw : '';
}

function classifyOne(value: unknown): StorageCrisisKind | null {
  const name = readErrorField(value, 'name');
  const message = readErrorField(value, 'message');

  // loro-repo's `createError()` flattens a DOMException into
  // `new Error(\`${context}: ${cause.message}\`, { cause })`, which drops the
  // name from the text. So match on the name AND on the text: the name catches
  // the wrapped cause, the text catches engines that only spell it in prose.
  if (name === 'QuotaExceededError') return 'quota';
  if (/quota/i.test(message) && /exceed/i.test(message)) return 'quota';

  if (CONNECTION_CLOSING_PATTERN.test(message)) return 'unavailable';
  if (BACKING_STORE_PATTERN.test(message)) return 'unavailable';

  return null;
}

/**
 * Classify a repo IndexedDB failure, walking the `cause` chain.
 *
 * Returns `null` for everything else. An unclassified failure keeps its
 * existing behavior — a transient or logic error must not latch the app into a
 * state whose only exit is a restart.
 */
export function classifyStorageFailure(error: unknown): StorageCrisisKind | null {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current != null; depth += 1) {
    const kind = classifyOne(current);
    if (kind) return kind;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** One-line `Name: message` summary for the dialog's technical details. */
export function describeStorageFailure(error: unknown): string {
  const name = readErrorField(error, 'name');
  const message = readErrorField(error, 'message');
  if (name && message) return `${name}: ${message}`;
  if (message) return message;
  if (name) return name;
  return String(error);
}

let crisisState: StorageCrisisState | null = null;
const listeners = new Set<() => void>();

/** Current crisis, or `null` while the repo IndexedDB is healthy. */
export function getStorageCrisisState(): StorageCrisisState | null {
  return crisisState;
}

export function subscribeToStorageCrisis(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyStorageCrisisListeners(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[Lody] storage crisis listener threw', error);
    }
  }
}

/**
 * Latch the crisis. Idempotent and one-way for the page lifetime: the first
 * failure is the one that gets explained, and nothing here can clear it —
 * recovery is a process restart.
 */
export function enterStorageCrisis(state: StorageCrisisState): void {
  if (crisisState) return;
  crisisState = state;
  console.error(
    `[Lody] local storage crisis (${state.kind}) during ${state.operation}: ${state.detail}`
  );
  notifyStorageCrisisListeners();
}

/** Test-only: drop the latch so each case starts from a healthy store. */
export function resetStorageCrisisForTests(): void {
  crisisState = null;
  notifyStorageCrisisListeners();
}
