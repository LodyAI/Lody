import { useCallback, useEffect, useState } from 'react';
import type { PrStatus } from '@lody/shared';

/** Upper bound for holding an action pending while metadata catches up. */
export const AWAITED_PR_STATUS_TIMEOUT_MS = 15_000;

export type AwaitedPrStatus = {
  /** Target statuses still awaited for the current PR, or null. */
  awaiting: readonly PrStatus[] | null;
  awaitStatus: (targets: readonly PrStatus[]) => void;
};

/**
 * Keeps a successful PR action (merge, ready for review) pending until the
 * shared metadata status reaches its target, so the action button and the
 * status mark never contradict each other. Gives up after a bounded timeout;
 * a different PR never inherits the wait.
 */
export function useAwaitedPrStatus(url: string | null, status: PrStatus | null): AwaitedPrStatus {
  const [pending, setPending] = useState<{ url: string; targets: readonly PrStatus[] } | null>(
    null
  );
  const active =
    pending && pending.url === url && !(status && pending.targets.includes(status))
      ? pending
      : null;

  useEffect(() => {
    if (pending && !active) setPending(null);
  }, [active, pending]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setTimeout(() => setPending(null), AWAITED_PR_STATUS_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  const awaitStatus = useCallback(
    (targets: readonly PrStatus[]) => {
      if (url) setPending({ url, targets });
    },
    [url]
  );

  return { awaiting: active?.targets ?? null, awaitStatus };
}
