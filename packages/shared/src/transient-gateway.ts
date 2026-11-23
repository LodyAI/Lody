/** Gateway statuses that mean the request never reached a decision; nothing else is retried. */
export const TRANSIENT_GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
/** At most two short retries, inside the caller's own deadline. */
export const TRANSIENT_GATEWAY_RETRY_DELAYS_MS = [60, 150] as const;
export const isTransientGatewayStatus = (status: unknown): boolean =>
  typeof status === 'number' && TRANSIENT_GATEWAY_STATUSES.has(status);
