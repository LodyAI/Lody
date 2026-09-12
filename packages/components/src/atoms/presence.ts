import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import {
  collectOnlineMachineIdsFromPresence,
  findFreshSessionPresenceState,
  getServerNow,
  type LodyPresenceStateMap,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import type { RoomSyncState } from '@/lib/room-sync-state';

export const lodyPresenceStatesAtom = atom<LodyPresenceStateMap>({});
export const lodyPresenceNowMsAtom = atom(getServerNow());

/**
 * Health of the workspace presence transport (the ephemeral Streams room).
 * Machine online/offline is only trustworthy while this is 'synced'; any other
 * state means we cannot distinguish "machine offline" from "we are not
 * receiving presence".
 */
export const lodyPresenceSyncStateAtom = atom<RoomSyncState>('idle');

export const sessionLivePresenceAtomFamily = atomFamily((sessionId: SessionId) =>
  atom(
    (get) =>
      findFreshSessionPresenceState(
        get(lodyPresenceStatesAtom),
        sessionId,
        get(lodyPresenceNowMsAtom)
      ) ?? null
  )
);

export const sessionLiveStatusAtomFamily = atomFamily((sessionId: SessionId) =>
  atom((get) => get(sessionLivePresenceAtomFamily(sessionId))?.status ?? null)
);

const setsEqual = (a: ReadonlySet<MachineId>, b: ReadonlySet<MachineId>): boolean => {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
};

/**
 * Machine ids with a fresh ephemeral presence heartbeat. This is the single
 * source of truth for machine online status; durable `MachineMeta.lastSeen`
 * is legacy registration-time data and must not be consulted.
 *
 * Recomputes on every presence snapshot and on the 30s presence-now tick, so
 * consumers do not need their own recheck timers.
 */
let _prevOnlineMachineIds: ReadonlySet<MachineId> = new Set();
export const onlineMachineIdsAtom = atom<ReadonlySet<MachineId>>((get) => {
  const next = collectOnlineMachineIdsFromPresence(
    get(lodyPresenceStatesAtom),
    get(lodyPresenceNowMsAtom)
  );
  if (setsEqual(next, _prevOnlineMachineIds)) {
    return _prevOnlineMachineIds;
  }
  _prevOnlineMachineIds = next;
  return next;
});

export type MachineOnlineStatus = 'online' | 'offline' | 'unknown';

/**
 * Three-state machine liveness:
 * - 'online': fresh presence heartbeat seen.
 * - 'offline': presence transport is healthy and no fresh heartbeat exists.
 * - 'unknown': presence transport is not synced — do not claim the machine is
 *   offline in UI copy; we simply cannot see it.
 */
export const machineOnlineStatusAtomFamily = atomFamily((machineId?: MachineId) =>
  atom<MachineOnlineStatus>((get) => {
    if (!machineId) {
      return 'unknown';
    }
    if (get(onlineMachineIdsAtom).has(machineId)) {
      return 'online';
    }
    return get(lodyPresenceSyncStateAtom) === 'synced' ? 'offline' : 'unknown';
  })
);

export const setLodyPresenceStatesAtom = atom(null, (_get, set, states: LodyPresenceStateMap) => {
  set(lodyPresenceNowMsAtom, getServerNow());
  set(lodyPresenceStatesAtom, states);
});

export const setLodyPresenceNowMsAtom = atom(null, (_get, set, nowMs?: number) => {
  set(lodyPresenceNowMsAtom, nowMs ?? getServerNow());
});

export const setLodyPresenceSyncStateAtom = atom(null, (_get, set, state: RoomSyncState) => {
  set(lodyPresenceSyncStateAtom, state);
});

export const clearLodyPresenceStatesAtom = atom(null, (_get, set) => {
  set(lodyPresenceNowMsAtom, getServerNow());
  set(lodyPresenceStatesAtom, {});
  set(lodyPresenceSyncStateAtom, 'idle');
});
