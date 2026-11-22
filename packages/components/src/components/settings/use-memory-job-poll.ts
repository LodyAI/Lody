import { useEffect, useRef } from 'react';

/**
 * Asks after work the machine is doing — an install, a sign-in, a connect —
 * while `active`. One request at a time: a tick is shorter than the call behind
 * it, and overlapping asks redeemed a device code twice. It stops once `endsAt`
 * passes or the owner stops or unmounts. When to start and what a reply means
 * stay with each card.
 */
export function useMemoryJobPoll<T>({
  active,
  intervalMs,
  endsAt,
  ask,
  onReply,
  onExpire,
}: {
  active: boolean;
  intervalMs: number;
  /** Epoch milliseconds past which the card stops waiting. */
  endsAt: number;
  ask: () => Promise<T>;
  onReply: (reply: T) => void;
  onExpire: () => void;
}) {
  // The hook hands back fresh closures each render; the interval reads the
  // current ones instead of restarting every time the card re-renders.
  const latest = useRef({ endsAt, ask, onReply, onExpire });
  latest.current = { endsAt, ask, onReply, onExpire };
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let asking = false;
    const timer = window.setInterval(() => {
      if (Date.now() > latest.current.endsAt) {
        window.clearInterval(timer);
        latest.current.onExpire();
        return;
      }
      if (asking) return;
      asking = true;
      void latest.current
        .ask()
        .finally(() => {
          asking = false;
        })
        .then((reply) => {
          if (!cancelled) latest.current.onReply(reply);
        });
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, intervalMs]);
}
