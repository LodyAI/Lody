import type { RepoRoomSubscription, RepoTransportRoomSubscription } from 'loro-repo';

/**
 * Picks the single transport binding whose sync progress defines "readiness"
 * for a room subscription.
 *
 * On a dual-homed room (local + cloud) the classic single-value members of
 * `RepoRoomSubscription` (e.g. `firstSyncedWithRemote`) THROW instead of
 * merging per-transport state, so readiness must be a SELECTION of one
 * binding, not a merge: prefer 'local' (a local-first renderer must never
 * block readiness on the cloud), otherwise the only routed transport, and only
 * fall back to 'cloud' when several non-local transports are routed.
 */
export function readinessBinding(sub: RepoRoomSubscription): RepoTransportRoomSubscription {
  const transportIds = sub.transportIds();
  if (transportIds.includes('local')) {
    return sub.subscription('local');
  }
  const [only] = transportIds;
  if (transportIds.length === 1 && only !== undefined) {
    return sub.subscription(only);
  }
  return sub.subscription('cloud');
}
