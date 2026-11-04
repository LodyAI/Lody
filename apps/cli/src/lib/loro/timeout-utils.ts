/**
 * Minimum budget for a sync confirmation whose timeout fails the operation and
 * invites a retry. A shorter deadline turns a slow but healthy sync into a
 * failure that every retry repeats. Best-effort waits that continue on timeout
 * may stay shorter.
 */
export const SYNC_CONFIRMATION_TIMEOUT_MS = 30_000;

/** Recognized only for the Machine Flock freshness deadline. */
export class FlockSyncTimeoutError extends Error {}

export const readTimeoutEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};

export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string | Error
): Promise<T> => {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(message instanceof Error ? message : new Error(message)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};
