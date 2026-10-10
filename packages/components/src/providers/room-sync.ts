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
    isCancelled,
    onSubscription,
    firstSynced = (sub: T) => sub.firstSyncedWithRemote,
    sleep = defaultSleep,
    warn = (message: string) => {
      console.warn(message);
    },
  } = options;

  const cancelled = () => isCancelled?.() ?? false;

  if (initialDelayMs !== undefined) {
    await sleep(initialDelayMs);
    if (cancelled()) {
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
      sub = await joinRoom();
      onSubscription?.(sub);
      await firstSynced(sub);
      if (cancelled()) {
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
        await sleep(delayMs);
        continue;
      }

      warn(`[${roomId}] initial room sync unavailable, continuing offline-first: ${errMsg}`);
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Unknown error'));
}
