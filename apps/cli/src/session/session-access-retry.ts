import { Data, Duration, Effect, Schedule } from 'effect';
import type { MachineAccessCheckResult } from '@/lib/workspace';
import { formatErrorWithCauses } from '@/utils/format-error';

const DEFAULT_BOUNDED_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const RETRYABLE_NETWORK_ERROR_MESSAGE =
  /\b(fetch failed|failed to fetch|network error|socket hang up|connection (?:reset|refused)|timed? out|econnrefused|econnreset|enetdown|enetunreach|enotfound|eai_again|etimedout)\b/iu;

type ErrorRecord = {
  cause?: unknown;
  code?: unknown;
  errors?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

const isRetryableHttpStatus = (value: unknown): boolean =>
  typeof value === 'number' && (value === 408 || value === 429 || value >= 500);

const isRetryableMachineAccessCause = (
  error: unknown,
  seen: ReadonlySet<unknown> = new Set()
): boolean => {
  if (seen.has(error) || (typeof error !== 'object' && typeof error !== 'string')) {
    return false;
  }
  if (typeof error === 'string') {
    return RETRYABLE_NETWORK_ERROR_MESSAGE.test(error);
  }

  const nextSeen = new Set(seen);
  nextSeen.add(error);
  const record = error as ErrorRecord;
  if (typeof record.code === 'string' && RETRYABLE_NETWORK_ERROR_CODES.has(record.code)) {
    return true;
  }
  if (isRetryableHttpStatus(record.status) || isRetryableHttpStatus(record.statusCode)) {
    return true;
  }
  if (typeof record.message === 'string' && RETRYABLE_NETWORK_ERROR_MESSAGE.test(record.message)) {
    return true;
  }
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      if (isRetryableMachineAccessCause(nested, nextSeen)) return true;
    }
  }
  return record.cause !== undefined && isRetryableMachineAccessCause(record.cause, nextSeen);
};

export class MachineAccessVerificationError extends Error {
  readonly code: 'MACHINE_ACCESS_UNAVAILABLE' | 'MACHINE_ACCESS_CHECK_FAILED';

  constructor(
    readonly retryable: boolean,
    readonly attempts: number,
    cause: unknown
  ) {
    const attemptSuffix = attempts > 1 ? ` after ${attempts} attempts` : '';
    super(`Could not verify machine access${attemptSuffix}: ${formatErrorWithCauses(cause)}`, {
      cause,
    });
    this.name = 'MachineAccessVerificationError';
    this.code = retryable ? 'MACHINE_ACCESS_UNAVAILABLE' : 'MACHINE_ACCESS_CHECK_FAILED';
  }
}

export interface BoundedMachineAccessRetryOptions {
  readonly verify: () => Promise<MachineAccessCheckResult>;
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly onRetry?: (event: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: string;
  }) => void;
}

/**
 * Retry an idempotent command-boundary access query for a short, bounded window.
 * Definitive access results return immediately; only transport-shaped failures retry.
 */
export async function readMachineAccessWithBoundedRetry(
  options: BoundedMachineAccessRetryOptions
): Promise<MachineAccessCheckResult> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_BOUNDED_RETRY_DELAYS_MS;
  const maxAttempts = retryDelaysMs.length + 1;
  const sleep =
    options.sleep ??
    (async (delayMs: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await options.verify();
    } catch (error) {
      const retryable = isRetryableMachineAccessCause(error);
      const delayMs = retryDelaysMs[attempt - 1];
      if (!retryable || delayMs === undefined) {
        throw new MachineAccessVerificationError(retryable, attempt, error);
      }
      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        error: formatErrorWithCauses(error),
      });
      await sleep(delayMs);
    }
  }

  throw new Error('Machine access retry loop exited without a result.');
}

/**
 * Verifying whether a requester may run a turn on this machine has three
 * outcomes, and the distinction is load-bearing:
 *
 * - `allowed` / `denied` are definitive answers from the backend. A `denied`
 *   answer will not change on retry, so the turn is failed.
 * - `indeterminate` means we could NOT reach a verdict (network blip, backend
 *   unreachable, or an auth-looking transport error). Treating this like a deny
 *   permanently drops the user's turn on a transient outage — the bug this
 *   module exists to prevent. Instead we retry with backoff (see
 *   {@link verifyMachineAccessWithRetry}).
 */
export type MachineAccessDenyReason = Extract<
  MachineAccessCheckResult,
  { allowed: false }
>['reason'];

export type MachineAccessVerification =
  | { outcome: 'allowed' }
  | { outcome: 'denied'; reason: MachineAccessDenyReason }
  // `cause` separates a network/transport failure (retry forever) from an
  // auth-looking failure (retry, then escalate to the machine-level handler).
  | { outcome: 'indeterminate'; cause: 'network' | 'auth'; error: string };

/** A definitive authorization denial. Surfaced so the caller can fail the turn. */
export class AccessDenied extends Data.TaggedError('AccessDenied')<{
  readonly reason: MachineAccessDenyReason;
}> {}

/**
 * A non-definitive verification failure. This is retried internally and never
 * surfaces from {@link verifyMachineAccessWithRetry} at runtime; it only appears
 * in the static error type because the type system cannot prove the retry policy
 * loops forever on it.
 */
export class AccessIndeterminate extends Data.TaggedError('AccessIndeterminate')<{
  readonly cause: 'network' | 'auth';
  readonly error: string;
}> {}

export interface AccessRetryOptions {
  /**
   * Performs one verification. Must NOT reject — classify failures into
   * `indeterminate` (the CLI's `canUseMachine` wrapper already does this). A
   * rejection is defensively treated as `indeterminate/network`.
   */
  readonly verify: () => Promise<MachineAccessVerification>;
  /**
   * Invoked exactly once when verification keeps failing with an auth-looking
   * error (likely an invalid/revoked token). A backstop to the authoritative
   * workspace-list detector; retries continue afterward so a token refresh
   * recovers the turn without the user resending.
   */
  readonly onAuthEscalation: () => void;
  /** Consecutive auth-cause failures before escalating. Default 5. */
  readonly escalateAfter?: number;
  /** First backoff delay. Default 2s. */
  readonly baseDelay?: Duration.DurationInput;
  /** Backoff cap. Default 1m. */
  readonly maxDelay?: Duration.DurationInput;
  /** Per-attempt timeout for the verify call. Default 10s. */
  readonly verifyTimeout?: Duration.DurationInput;
  /**
   * Add randomness to delays (anti-thundering-herd). Default true; tests set
   * false for exact, deterministic timing under TestClock.
   */
  readonly jitter?: boolean;
}

/**
 * Verify machine access, retrying transient failures with exponential backoff
 * until the answer is definitive or the fiber is interrupted.
 *
 * - Succeeds (`void`) when access is **allowed**.
 * - Fails with {@link AccessDenied} when the backend **definitively denies**.
 * - Retries forever (capped backoff) while **indeterminate**; escalates once via
 *   `onAuthEscalation` after `escalateAfter` consecutive auth-cause failures.
 *
 * Interruption (e.g. the turn is superseded or the session is unwatched) simply
 * stops the fiber — no failure, no side effects.
 */
export const verifyMachineAccessWithRetry = (
  opts: AccessRetryOptions
): Effect.Effect<void, AccessDenied> =>
  Effect.gen(function* () {
    const escalateAfter = opts.escalateAfter ?? 5;
    // Single-fiber context — no concurrent access, plain `let` suffices over Ref.
    let authFailures = 0;

    const attempt = Effect.tryPromise({
      try: () => opts.verify(),
      // Defensive: the contract says `verify` never rejects, but if it does we
      // treat it as a transient network failure rather than crashing the fiber.
      catch: (error): AccessIndeterminate =>
        new AccessIndeterminate({ cause: 'network', error: String(error) }),
    }).pipe(
      Effect.timeout(opts.verifyTimeout ?? Duration.seconds(10)),
      // A hung verify is just another transient failure → retry.
      Effect.catchTag('TimeoutException', () =>
        Effect.fail(new AccessIndeterminate({ cause: 'network', error: 'verify timed out' }))
      ),
      Effect.flatMap((verification): Effect.Effect<void, AccessDenied | AccessIndeterminate> => {
        if (verification.outcome === 'allowed') {
          return Effect.void;
        }
        if (verification.outcome === 'denied') {
          return Effect.fail(new AccessDenied({ reason: verification.reason }));
        }
        return Effect.fail(
          new AccessIndeterminate({ cause: verification.cause, error: verification.error })
        );
      }),
      // Escalate once after sustained auth failures; keep retrying afterward.
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error._tag === 'AccessIndeterminate' && error.cause === 'auth') {
            authFailures += 1;
            if (authFailures === escalateAfter) {
              opts.onAuthEscalation();
            }
          }
        })
      )
    );

    const cappedBackoff = Schedule.union(
      Schedule.exponential(opts.baseDelay ?? Duration.seconds(2)),
      // union takes the SHORTER delay, so once the exponential exceeds this it
      // settles into a steady interval — i.e. a cap.
      Schedule.spaced(opts.maxDelay ?? Duration.minutes(1))
    );
    const jittered = opts.jitter === false ? cappedBackoff : Schedule.jittered(cappedBackoff);
    // Retry while the failure is indeterminate; a definitive AccessDenied makes
    // `whileInput` false, which stops the schedule and propagates the denial.
    const policy = Schedule.whileInput(
      jittered,
      (error: AccessDenied | AccessIndeterminate) => error._tag === 'AccessIndeterminate'
    );

    yield* Effect.retry(attempt, policy).pipe(
      // The retry policy loops forever on AccessIndeterminate (whileInput), so
      // this is unreachable at runtime. Absorb it here so callers only handle
      // the definitive AccessDenied — no dead branches in the watcher.
      Effect.catchTag('AccessIndeterminate', () => Effect.void)
    );
  });
