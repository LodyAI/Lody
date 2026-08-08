import * as React from 'react';
import type { FuseConstructor } from '@/components/mentions/file-at-mention';

/**
 * Module-cached `fuse.js` constructor for mention menus.
 *
 * The constructor is loaded once per page and only after a menu actually
 * activates, so mounting a composer never pulls Fuse in. Callers keep their own
 * memoised instance; this only owns the (shared, one-shot) import.
 */
let fuseCtorCache: FuseConstructor<unknown> | null = null;
let fuseCtorPromise: Promise<void> | null = null;
const fuseCtorSubscribers = new Set<() => void>();

function loadFuseCtor(): void {
  if (fuseCtorCache || fuseCtorPromise) return;
  fuseCtorPromise = import('fuse.js')
    .then((mod) => {
      const ctor = (mod as unknown as { default?: unknown }).default ?? mod;
      fuseCtorCache = ctor as FuseConstructor<unknown>;
      fuseCtorSubscribers.forEach((callback) => {
        callback();
      });
    })
    .catch(() => {
      // fuse.js unavailable; callers fall back to substring matching.
      fuseCtorPromise = null;
    });
}

function subscribeFuseCtor(callback: () => void): () => void {
  fuseCtorSubscribers.add(callback);
  return () => {
    fuseCtorSubscribers.delete(callback);
  };
}

function getFuseCtorSnapshot(): FuseConstructor<unknown> | null {
  return fuseCtorCache;
}

export function useMentionFuseCtor<T>(enabled: boolean): FuseConstructor<T> | null {
  const ctor = React.useSyncExternalStore(
    subscribeFuseCtor,
    getFuseCtorSnapshot,
    getFuseCtorSnapshot
  );
  React.useEffect(() => {
    if (enabled) loadFuseCtor();
  }, [enabled]);
  return enabled ? (ctor as FuseConstructor<T> | null) : null;
}
