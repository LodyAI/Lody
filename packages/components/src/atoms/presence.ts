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

/** How long a machine stays presumed online after its last heartbeat while presence is unknown. */
export const MACHINE_RECENTLY_ONLINE_MS = 10 * 60 * 1000;

/**
 * Last time this client saw each machine online. Presence is ephemeral and durable
 * `lastSeen` is gone, so this memory lasts only as long as the renderer: a cold start
 * has no record. Clearing the presence snapshot keeps it, because a restart is exactly
 * when the record is needed.
 */
const machineLastOnlineMsAtom = atom<ReadonlyMap<MachineId, number>>(new Map());

/**
 * Display health of the workspace presence transport (the ephemeral Streams
 * room). This is the raw transport state except that a brief in-place reconnect
 * keeps the last synced state: the retained snapshot still describes every
 * machine, and clearing the pill for the reconnect would read as a status
 * change. Raw health (for recovery) lives in the runtime's room-sync registry.
 *
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
 *
 * Membership is evidence of online; absence is not evidence of offline, because
 * an unsynced room has no heartbeats. Anything that concludes "offline" or blocks
 * work must read the three-state `machineOnlineStatusAtomFamily` or check sync.
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

/**
 * Machines to treat as online when a surface must give a yes/no answer, currently
 * Role availability and machine deletion. A synced room is authoritative. While
 * presence is unknown, a machine counts as online if this client saw it within
 * {@link MACHINE_RECENTLY_ONLINE_MS}; otherwise it counts as offline.
 */
let _prevPresumedOnlineMachineIds: ReadonlySet<MachineId> = new Set();
export const presumedOnlineMachineIdsAtom = atom<ReadonlySet<MachineId>>((get) => {
  const online = get(onlineMachineIdsAtom);
  if (get(lodyPresenceSyncStateAtom) === 'synced') {
    return online;
  }
  const nowMs = get(lodyPresenceNowMsAtom);
  const next = new Set(online);
  for (const [machineId, lastOnlineMs] of get(machineLastOnlineMsAtom)) {
    if (nowMs - lastOnlineMs <= MACHINE_RECENTLY_ONLINE_MS) {
      next.add(machineId);
    }
  }
  if (setsEqual(next, _prevPresumedOnlineMachineIds)) {
    return _prevPresumedOnlineMachineIds;
  }
  _prevPresumedOnlineMachineIds = next;
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

const recordOnlineMachinesAtom = atom(null, (get, set) => {
  const online = get(onlineMachineIdsAtom);
  if (online.size === 0) return;
  const nowMs = get(lodyPresenceNowMsAtom);
  const next = new Map(get(machineLastOnlineMsAtom));
  for (const machineId of online) {
    next.set(machineId, nowMs);
  }
  set(machineLastOnlineMsAtom, next);
});

export const setLodyPresenceStatesAtom = atom(null, (_get, set, states: LodyPresenceStateMap) => {
  set(lodyPresenceNowMsAtom, getServerNow());
  set(lodyPresenceStatesAtom, states);
  set(recordOnlineMachinesAtom);
});

export const setLodyPresenceNowMsAtom = atom(null, (_get, set, nowMs?: number) => {
  set(lodyPresenceNowMsAtom, nowMs ?? getServerNow());
  set(recordOnlineMachinesAtom);
});

export const setLodyPresenceSyncStateAtom = atom(null, (_get, set, state: RoomSyncState) => {
  set(lodyPresenceSyncStateAtom, state);
});

export const clearLodyPresenceStatesAtom = atom(null, (_get, set) => {
  set(lodyPresenceNowMsAtom, getServerNow());
  set(lodyPresenceStatesAtom, {});
  set(lodyPresenceSyncStateAtom, 'idle');
});
