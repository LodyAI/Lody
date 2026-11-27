'use client';

import { scheduleAfterLoadIdle } from '@site/lib/after-first-paint';
import {
  PUBLIC_PROMO_RETRY_BASE_MS,
  computeNextPublicPromoRefreshDelayMs,
  parsePublicPromoSnapshot,
  resolvePublicPromoEndpoint,
  selectLivePublicPromo,
  type PublicPromoActive,
  type PublicPromoSnapshot,
} from '@site/lib/public-promo';
import { useEffect, useState } from 'react';

type CachedState = {
  snapshot: PublicPromoSnapshot;
  clockOffsetMs: number;
  fetchedAtMs: number;
};

let cached: CachedState | null = null;
let inflight: Promise<CachedState | null> | null = null;
let inflightBypassCache = false;
let consecutiveRetryCount = 0;
let lastAttemptAtMs = 0;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

function getEndpoint(): string | null {
  return resolvePublicPromoEndpoint(
    import.meta.env.VITE_PUBLIC_PROMO_URL,
    import.meta.env.VITE_CONVEX_SITE_URL
  );
}

async function fetchPublicPromo(endpoint: string, bypassCache = false): Promise<CachedState | null> {
  if (inflight && (!bypassCache || inflightBypassCache)) return inflight;
  lastAttemptAtMs = Date.now();
  inflightBypassCache = bypassCache;
  const request = fetch(endpoint, {
    method: 'GET',
    cache: bypassCache ? 'no-store' : 'default',
  })
    .then(async (response) => {
      if (!response.ok) {
        consecutiveRetryCount += 1;
        return null;
      }
      const json: unknown = await response.json();
      const snapshot = parsePublicPromoSnapshot(json);
      const now = Date.now();
      const clockOffsetMs = snapshot.serverNow - now;
      const nextBoundary = snapshot.nextChangeAt ?? snapshot.active?.endsAt ?? null;
      if (nextBoundary !== null && nextBoundary <= now + clockOffsetMs) {
        consecutiveRetryCount += 1;
      } else {
        consecutiveRetryCount = 0;
      }
      const nextState: CachedState = {
        snapshot,
        clockOffsetMs,
        fetchedAtMs: now,
      };
      cached = nextState;
      notifyListeners();
      return nextState;
    })
    .catch(() => {
      consecutiveRetryCount += 1;
      return null;
    })
    .finally(() => {
      if (inflight === request) {
        inflight = null;
        inflightBypassCache = false;
      }
    });
  inflight = request;
  return request;
}

export function usePublicPromo(options?: { deferUntilIdle?: boolean }): PublicPromoActive | null {
  const [, setTick] = useState(0);

  useEffect(() => {
    const endpoint = getEndpoint();
    if (!endpoint) return undefined;

    const rerender = () => setTick((value) => value + 1);
    listeners.add(rerender);

    let cancelIdle: (() => void) | undefined;
    let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const scheduleNextBoundary = () => {
      if (boundaryTimer !== undefined) clearTimeout(boundaryTimer);
      if (disposed || !cached) return;
      const delayMs = computeNextPublicPromoRefreshDelayMs({
        snapshot: cached.snapshot,
        clockOffsetMs: cached.clockOffsetMs,
        nowMs: Date.now(),
        consecutiveRetryCount,
      });
      if (delayMs === null) return;
      boundaryTimer = setTimeout(() => {
        if (disposed) return;
        // Immediately hide an ended campaign before network refresh completes.
        rerender();
        void fetchPublicPromo(endpoint, true).then(() => {
          if (!disposed) scheduleNextBoundary();
        });
      }, delayMs);
    };

    const startFetch = (bypassCache = false) => {
      void fetchPublicPromo(endpoint, bypassCache).then(() => {
        if (!disposed) scheduleNextBoundary();
      });
    };

    if (cached && Date.now() - cached.fetchedAtMs < 20_000 && consecutiveRetryCount === 0) {
      scheduleNextBoundary();
    } else if (options?.deferUntilIdle) {
      cancelIdle = scheduleAfterLoadIdle(() => startFetch(false), { timeoutMs: 1_500 });
    } else {
      startFetch(false);
    }

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'hidden') return;
      rerender();
      const now = Date.now();
      if (consecutiveRetryCount > 0 && now - lastAttemptAtMs < PUBLIC_PROMO_RETRY_BASE_MS) {
        return;
      }
      if (!cached) {
        startFetch(false);
        return;
      }
      const estimatedServerNow = now + cached.clockOffsetMs;
      const boundary = cached.snapshot.nextChangeAt ?? cached.snapshot.active?.endsAt ?? null;
      if (
        (boundary !== null && estimatedServerNow >= boundary) ||
        now - cached.fetchedAtMs >= 60_000
      ) {
        startFetch(true);
      }
    };

    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);

    return () => {
      disposed = true;
      listeners.delete(rerender);
      cancelIdle?.();
      if (boundaryTimer !== undefined) clearTimeout(boundaryTimer);
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
    };
  }, [options?.deferUntilIdle]);

  if (!cached) return null;
  return selectLivePublicPromo(cached.snapshot, cached.clockOffsetMs, Date.now());
}
