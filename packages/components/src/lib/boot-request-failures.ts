import { useSyncExternalStore } from 'react';

/**
 * The requests a route waits on before a workspace can open. A session check
 * that keeps failing (offline, a 5xx, a timeout) is deliberately not treated as
 * a sign-out, so without this record the person only ever sees a spinner; the
 * recovery screen reads it to say what actually failed.
 */
export type BootRequestSource =
  | 'session'
  | 'organizations'
  | 'active_organization'
  | 'switch_organization';

export type BootRequestFailureKind =
  | 'network'
  | 'server'
  | 'rate_limited'
  | 'unauthorized'
  | 'other';

export type BootRequestFailure = {
  source: BootRequestSource;
  kind: BootRequestFailureKind;
  status: number | null;
  /** Better Auth's error code, e.g. `FAILED_TO_GET_SESSION`. */
  code: string | null;
  /** Shortened, with long opaque strings (tokens) removed. */
  message: string | null;
  atMs: number;
};

const MESSAGE_LIMIT = 160;

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function redact(message: string): string {
  const cleaned = message
    .replace(/Bearer\s+\S+/gi, 'Bearer …')
    .replace(/[A-Za-z0-9_\-.]{32,}/g, '…');
  return cleaned.length > MESSAGE_LIMIT ? `${cleaned.slice(0, MESSAGE_LIMIT)}…` : cleaned;
}

/**
 * Normalize what Better Auth's client, `fetch` or a thrown `Error` reports. A
 * missing or zero status with a fetch-style message is a network failure: the
 * request never got an HTTP answer.
 */
export function describeBootRequestError(
  error: unknown
): Pick<BootRequestFailure, 'kind' | 'status' | 'code' | 'message'> {
  const status =
    readNumber(field(error, 'status')) ??
    readNumber(field(error, 'statusCode')) ??
    readNumber(field(field(error, 'response'), 'status')) ??
    readNumber(field(field(error, 'error'), 'status'));
  const code = readString(field(error, 'code')) ?? readString(field(field(error, 'error'), 'code'));
  const rawMessage =
    readString(field(error, 'message')) ??
    readString(field(error, 'statusText')) ??
    (typeof error === 'string' ? readString(error) : null);
  const name = readString(field(error, 'name'));
  const kind: BootRequestFailureKind =
    status === null || status === 0
      ? name === 'TypeError' ||
        name === 'AbortError' ||
        name === 'TimeoutError' ||
        /fetch|network|load failed|timed? ?out|offline/i.test(rawMessage ?? '')
        ? 'network'
        : 'other'
      : status === 429
        ? 'rate_limited'
        : status === 401 || status === 403
          ? 'unauthorized'
          : status >= 500
            ? 'server'
            : 'other';
  return {
    kind,
    status: status === 0 ? null : status,
    code,
    message: rawMessage === null ? null : redact(rawMessage),
  };
}

const failures = new Map<BootRequestSource, BootRequestFailure>();
const listeners = new Set<() => void>();
let snapshot: BootRequestFailure | null = null;

function publish(): void {
  let latest: BootRequestFailure | null = null;
  for (const failure of failures.values()) {
    if (latest === null || failure.atMs >= latest.atMs) latest = failure;
  }
  if (latest === snapshot) return;
  snapshot = latest;
  for (const listener of listeners) listener();
}

/** `error` is whatever the request reported; null or undefined clears the source. */
export function recordBootRequestResult(
  source: BootRequestSource,
  error: unknown,
  nowMs: number = Date.now()
): void {
  if (error === null || error === undefined) {
    if (!failures.delete(source)) return;
  } else {
    failures.set(source, { source, ...describeBootRequestError(error), atMs: nowMs });
  }
  publish();
}

/** The most recent request that is still failing, if any. */
export function readLatestBootRequestFailure(): BootRequestFailure | null {
  return snapshot;
}

export function useLatestBootRequestFailure(): BootRequestFailure | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readLatestBootRequestFailure,
    readLatestBootRequestFailure
  );
}

/** Test-only. */
export function resetBootRequestFailuresForTests(): void {
  failures.clear();
  snapshot = null;
}
