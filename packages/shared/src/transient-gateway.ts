/** Gateway statuses that mean the request never reached a decision; nothing else is retried. */
export const TRANSIENT_GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
/** At most three jittered retries, bounded inside the caller's own deadline. */
export const TRANSIENT_GATEWAY_RETRY_DELAYS_MS = [100, 300, 800] as const;
/** Bounded jitter in [50%, 100%] of `baseMs` so total wait stays within the sum of ceilings. */
export const transientGatewayRetryDelayMs = (
  baseMs: number,
  random: () => number = Math.random
): number => {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  const sample = random();
  const clamped = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.round(baseMs * (0.5 + clamped * 0.5));
};
export const isTransientGatewayStatus = (status: unknown): boolean =>
  typeof status === 'number' && TRANSIENT_GATEWAY_STATUSES.has(status);
