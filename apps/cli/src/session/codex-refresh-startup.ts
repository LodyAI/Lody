import { setTimeout as delay } from 'node:timers/promises';

const CODEX_REFRESH_CONTENTION_KIND = 'codex_refresh_contention';
const CODEX_REFRESH_RETRY_DELAY_MS = 750;

export const isCodexRefreshContention = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const data = (current as Error & { data?: unknown }).data;
    if (
      data !== null &&
      typeof data === 'object' &&
      'kind' in data &&
      data.kind === CODEX_REFRESH_CONTENTION_KIND
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
};

export async function runCodexRefreshStartupWithRetry<T>(options: {
  attempt: () => Promise<T>;
  retryAttempt?: () => Promise<T>;
  cleanupFailedAttempt: () => Promise<void>;
  abortSignal?: AbortSignal;
  onRetry?: () => void;
  waitForRetry?: (signal?: AbortSignal) => Promise<void>;
}): Promise<T> {
  try {
    return await options.attempt();
  } catch (error) {
    if (!options.retryAttempt || !isCodexRefreshContention(error)) throw error;

    // The losing native process retains failed auth state. Release it before a new
    // process rereads the winner's persisted credentials; never retry in-place.
    await options.cleanupFailedAttempt();
    options.onRetry?.();
    await (
      options.waitForRetry ??
      ((signal) => delay(CODEX_REFRESH_RETRY_DELAY_MS, undefined, { signal }))
    )(options.abortSignal);
    options.abortSignal?.throwIfAborted();
    return await options.retryAttempt();
  }
}
