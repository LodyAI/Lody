import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * React projection for an external owner ("room"). The room owns its timers,
 * subscriptions and lifecycle; React only re-renders when the room publishes.
 *
 * This hook is the single adapter over `useSyncExternalStore`: business code
 * must not hand-wire that primitive per call site, because the lease ordering,
 * subscribe/re-seed sequence and snapshot-identity contract are easy to get
 * wrong and were duplicated across four modules.
 */
export type SnapshotSource<T> = {
  getSnapshot: () => T;
  subscribe: (listener: () => void) => () => void;
};

export type SnapshotLease = {
  release: () => void;
};

/** Constant source for projecting a room-absent scope as an empty snapshot. */
export function constantSnapshotSource<T>(value: T): SnapshotSource<T> {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
  };
}

/**
 * Reads the room's snapshot. When `acquire` is given it is invoked once per
 * mount inside an effect and must return the room's release handle; the lease
 * belongs to the room's lifetime, so a re-render with a fresh `acquire`
 * closure does not release and re-acquire. Omit `acquire` when the caller
 * already holds the room lease itself (e.g. a scope-dependent store resolved
 * in another effect).
 *
 * `useSyncExternalStore` already supplies every contract the projection needs:
 * it subscribes in the commit phase, re-reads `getSnapshot` after subscribing
 * to close the render/effect gap, re-renders only when the snapshot identity
 * changes (Object.is), and checks for tearing in concurrent renders. Reads go
 * straight to the room, so no subscription ordering can surface a snapshot
 * older than the room's own.
 */
export function useExternalSnapshot<T>(
  source: SnapshotSource<T>,
  acquire?: () => SnapshotLease
): T {
  // Latest acquire closure; the lease effect keys on `source` alone because
  // the lease is a property of the room's lifetime, not of the render that
  // produced the closure. Assignment happens in an effect so a concurrent
  // render that never commits cannot swap the closure a committed effect
  // later invokes.
  const acquireRef = useRef(acquire);
  useEffect(() => {
    acquireRef.current = acquire;
  });

  useEffect(() => {
    const lease = acquireRef.current?.();
    return () => lease?.release();
  }, [source]);

  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
