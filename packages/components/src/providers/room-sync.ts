import { createLoroSyncErrorTools } from '@lody/shared/loro-sync-errors';
import { RepoSyncError, RepoTransportError } from 'loro-repo';

const { formatLoroSyncError } = createLoroSyncErrorTools({ RepoSyncError, RepoTransportError });

export type SyncRoomSubscription = {
  firstSyncedWithRemote: Promise<void>;
  unsubscribe: () => void;
};

type WaitForRoomSyncOptions<T extends SyncRoomSubscription> = {
  roomId: string;
  maxJoinRetries?: number;
  retryBaseDelayMs?: number;
  /**
   * `0` intentionally yields to the next task so callers can finish immediate
   * local writes before the first remote bootstrap starts.
   */
  initialDelayMs?: number;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  onSubscription?: (sub: T) => void;
  /**
   * Selects which first-sync promise gates the wait. Dual-homed rooms must
   * pick one plane's binding here — the aggregate room subscription throws on
   * multi-transport rooms (selection, not merging).
   */
  firstSynced?: (sub: T) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
};

const DEFAULT_MAX_JOIN_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const raceAbortSignal = async <R>(
  promise: Promise<R>,
  signal: AbortSignal | undefined
): Promise<{ aborted: true } | { aborted: false; value: R }> => {
  if (!signal) {
    return { aborted: false, value: await promise };
  }
  if (signal.aborted) {
    void promise.catch(() => {});
    return { aborted: true };
  }
  let onAbort: (() => void) | null = null;
  const abortedPromise = new Promise<{ aborted: true }>((resolve) => {
    onAbort = () => resolve({ aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([
      promise.then((value) => ({ aborted: false as const, value })),
      abortedPromise,
    ]);
    if (outcome.aborted) {
      void promise.catch(() => {});
    }
    return outcome;
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
};

const formatErrorMessage = (error: unknown): string => {
  const syncError = formatLoroSyncError(error);
  if (syncError) return syncError;
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export async function waitForRoomToSync<T extends SyncRoomSubscription>(
  joinRoom: () => Promise<T>,
  options: WaitForRoomSyncOptions<T>
): Promise<T | null> {
  const {
    roomId,
    maxJoinRetries = DEFAULT_MAX_JOIN_RETRIES,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    initialDelayMs,
    signal,
    isCancelled,
    onSubscription,
    firstSynced = (sub: T) => sub.firstSyncedWithRemote,
    sleep = defaultSleep,
    warn = (message: string) => {
      console.warn(message);
    },
  } = options;

  const cancelled = () => Boolean(signal?.aborted) || (isCancelled?.() ?? false);

  if (initialDelayMs !== undefined) {
    const delayed = await raceAbortSignal(sleep(initialDelayMs), signal);
    if (delayed.aborted || cancelled()) {
      return null;
    }
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxJoinRetries; attempt++) {
    if (cancelled()) {
      return null;
    }

    let sub: T | null = null;
    try {
      const joinPromise = joinRoom();
      void joinPromise.catch(() => {});
      const joinedOutcome = await raceAbortSignal(joinPromise, signal);
      if (joinedOutcome.aborted) {
        void joinPromise.then(
          (lateSub) => {
            lateSub.unsubscribe();
          },
          () => {}
        );
        return null;
      }
      sub = joinedOutcome.value;
      if (cancelled()) {
        sub.unsubscribe();
        return null;
      }
      onSubscription?.(sub);
      const syncedOutcome = await raceAbortSignal(firstSynced(sub), signal);
      if (syncedOutcome.aborted || cancelled()) {
        sub.unsubscribe();
        return null;
      }
      return sub;
    } catch (error) {
      lastError = error;
      const errMsg = formatErrorMessage(error);

      if (cancelled()) {
        sub?.unsubscribe();
        return null;
      }

      if (sub) {
        warn(`[${roomId}] initial room sync unavailable, continuing offline-first: ${errMsg}`);
        throw error;
      }

      if (attempt < maxJoinRetries - 1) {
        const delayMs = retryBaseDelayMs * Math.pow(2, attempt);
        warn(
          `[${roomId}] joinRoom failed (attempt ${attempt + 1}/${maxJoinRetries}), retrying in ${delayMs}ms: ${errMsg}`
        );
        const backoff = await raceAbortSignal(sleep(delayMs), signal);
        if (backoff.aborted || cancelled()) {
          return null;
        }
        continue;
      }

      warn(`[${roomId}] initial room sync unavailable, continuing offline-first: ${errMsg}`);
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Unknown error'));
}
