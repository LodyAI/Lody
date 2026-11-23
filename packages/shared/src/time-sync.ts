import { z } from 'zod';

/**
 * Zod schema for the /api/time response.
 */
export const serverTimeResponseSchema = z.object({
  serverTime: z.number(),
});

export type ServerTimeResponse = z.infer<typeof serverTimeResponseSchema>;

/**
 * Time synchronization module for aligning client clocks with server time.
 *
 * This module solves the problem of clock drift between CLI agents, Web clients,
 * and servers that can cause incorrect online status detection.
 *
 * ## Algorithm
 *
 * Uses a simple round-trip midpoint estimation:
 * 1. Record local time before request (localBefore)
 * 2. Fetch server time (serverTime)
 * 3. Record local time after response (localAfter)
 * 4. Estimate local time when server generated timestamp: localMid = (localBefore + localAfter) / 2
 * 5. Calculate and round the offset to integer milliseconds:
 *    serverTimeOffset = round(serverTime - localMid)
 *
 * ## Accuracy
 *
 * The algorithm assumes symmetric network latency (request and response take equal time).
 * The error is bounded by the asymmetry in round-trip time:
 *
 * - Best case (symmetric RTT): ~0ms error
 * - Typical case (100ms RTT, slight asymmetry): ~10ms error
 * - Worst case (200ms RTT, severe asymmetry like 20ms/180ms): ~80ms error
 *
 * For online status detection with 60-second TTL, even worst-case error (0.17% of TTL)
 * is negligible. This simple algorithm is sufficient for the current use case.
 *
 * For higher precision requirements, consider:
 * - Multiple samples with median filtering
 * - Discarding outliers (high RTT samples)
 * - Using the sample with minimum RTT
 *
 * ## Usage
 *
 * 1. Long-lived cloud applications maintain calibration with maintainTimeSync().
 *    One-shot commands may call syncTime() directly.
 * 2. Use getServerNow() instead of Date.now() for all time-sensitive operations
 */

/** Integer offset in milliseconds: serverTime - localTime */
let serverTimeOffset = 0;

/** Whether time sync has been completed */
let isSynced = false;

export type ServerTimeFetcher = (signal?: AbortSignal) => Promise<number>;

// A wall-clock correction during the request makes the midpoint meaningless.
const CLOCK_DISCONTINUITY_MS = 1_000;

/**
 * Synchronize local time with server time.
 * Failed and cancelled samples preserve the last calibration.
 *
 * @param getServerTime - A function that returns a Promise resolving to the server timestamp in milliseconds
 */
export async function syncTime(
  getServerTime: ServerTimeFetcher,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const localBefore = Date.now();
  const elapsedBefore = performance.now();
  const serverTime = await getServerTime(signal);
  const localAfter = Date.now();
  const elapsed = performance.now() - elapsedBefore;
  signal?.throwIfAborted();
  if (Math.abs(localAfter - localBefore - elapsed) > CLOCK_DISCONTINUITY_MS) {
    throw new Error('System clock changed during time synchronization');
  }

  // Use round-trip midpoint to approximate when server generated timestamp
  const localMid = (localBefore + localAfter) / 2;
  // Date.now() returns integer epoch milliseconds. Keeping the calibrated
  // offset integral preserves that contract for RPC and persisted timestamps.
  serverTimeOffset = Math.round(serverTime - localMid);
  isSynced = true;
}

/**
 * Get the current time adjusted to server time.
 * If time sync has not been performed, returns local time.
 *
 * @returns Current integer timestamp in milliseconds, adjusted to server time
 */
export function getServerNow(): number {
  return Date.now() + serverTimeOffset;
}

/**
 * Check if time synchronization has been completed.
 *
 * @returns true if syncTime() has been successfully called
 */
export function isTimeSynced(): boolean {
  return isSynced;
}

/**
 * Get the current time offset from server.
 * Positive value means local clock is behind server.
 * Negative value means local clock is ahead of server.
 *
 * @returns Offset in milliseconds (serverTime - localTime)
 */
export function getServerTimeOffset(): number {
  return serverTimeOffset;
}

/**
 * Reset time sync state. Mainly useful for testing.
 */
export function resetTimeSync(): void {
  serverTimeOffset = 0;
  isSynced = false;
}

/**
 * Default timeout for time sync fetch in milliseconds.
 */
const DEFAULT_TIME_SYNC_TIMEOUT_MS = 5000;

/**
 * Create a function that fetches server time from the given URL.
 * Uses Zod for response validation and includes a timeout.
 *
 * @param url - The URL of the time sync endpoint
 * @param timeoutMs - Timeout in milliseconds (default: 5000ms)
 * @returns A function that returns a Promise resolving to the server timestamp
 */
export function createServerTimeFetcher(
  url: string,
  timeoutMs: number = DEFAULT_TIME_SYNC_TIMEOUT_MS
): ServerTimeFetcher {
  return async (signal) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Time sync failed: ${response.status} ${response.statusText}`);
      }
      const data: unknown = await response.json();
      const parsed = serverTimeResponseSchema.parse(data);
      return parsed.serverTime;
    } finally {
      clearTimeout(timeoutId);
      controller.abort();
    }
  };
}
