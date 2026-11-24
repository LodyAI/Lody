import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import {
  getLodyMachinePresenceKey,
  getLodySessionPresenceKey,
  LODY_PRESENCE_TTL_MS,
  getMachineRoomId,
  getServerNow,
  getSessionRoomId,
  type LodyPresenceInstanceId,
  type MachineId,
  type MachineMeta,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  allActiveSessionsAtom,
  childSessionsAtomFamily,
  docMetaCacheAtom,
  machineMetaAtomFamily,
  machineMetaCacheAtom,
  sessionListAtom,
  sessionMetaAtomFamily,
  sessionMetaCacheAtom,
} from '../src/atoms/doc-meta';
import {
  clearLodyPresenceStatesAtom,
  lodyPresenceStatesAtom,
  lodyPresenceSyncStateAtom,
  MACHINE_RECENTLY_ONLINE_MS,
  machineOnlineStatusAtomFamily,
  onlineMachineIdsAtom,
  presumedOnlineMachineIdsAtom,
  sessionLiveStatusAtomFamily,
  setLodyPresenceNowMsAtom,
  setLodyPresenceStatesAtom,
} from '../src/atoms/presence';

describe('doc meta presence overlay', () => {
  it('keeps session metadata durable while exposing fresh live session status', () => {
    const store = createStore();
    const now = getServerNow();
    const machineId = 'machine-1' as MachineId;
    const sessionId = 'session-1' as SessionId;
    const childSessionId = 'session-child-1' as SessionId;
    const instanceId = 'instance-1' as LodyPresenceInstanceId;
    const machineRoomId = getMachineRoomId(machineId);
    const sessionRoomId = getSessionRoomId(sessionId);
    const childSessionRoomId = getSessionRoomId(childSessionId);
    const machine: MachineMeta = {
      id: machineId,
      name: 'Machine 1',
      cliVersion: '0.1.0',
      os: 'linux',
      sessions: [],
      lastSeen: now - 240_000,
      raceLimits: {},
    };
    const session: SessionMeta = {
      id: sessionId,
      machineId,
      createdAt: '2026-04-24T00:00:00.000Z',
      userId: 'user-1',
      status: { type: 'idle' },
      cliType: 'builtin',
      agentType: 'codex',
      lastRunningSeen: now - 240_000,
    };
    const childSession: SessionMeta = {
      ...session,
      id: childSessionId,
      parentSessionId: sessionId,
    };

    store.set(machineMetaCacheAtom, { [machineRoomId]: machine });
    store.set(sessionMetaCacheAtom, {
      [sessionRoomId]: session,
      [childSessionRoomId]: childSession,
    });
    store.set(lodyPresenceStatesAtom, {
      [getLodyMachinePresenceKey(machineId, instanceId)]: {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: now,
      },
      [getLodySessionPresenceKey(sessionId, instanceId)]: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        status: { type: 'running' },
        updatedAt: now,
      },
      [getLodySessionPresenceKey(childSessionId, instanceId)]: {
        kind: 'session',
        sessionId: childSessionId,
        machineId,
        instanceId,
        status: { type: 'initializing', stage: 'acp' },
        updatedAt: now,
      },
    });

    // Machine meta stays durable — no presence overlay onto lastSeen. Machine
    // liveness is exposed through the presence atoms instead.
    expect(store.get(machineMetaAtomFamily(machineRoomId))?.lastSeen).toBe(now - 240_000);
    expect(store.get(onlineMachineIdsAtom).has(machineId)).toBe(true);
    store.set(lodyPresenceSyncStateAtom, 'synced');
    expect(store.get(machineOnlineStatusAtomFamily(machineId))).toBe('online');
    expect(store.get(machineOnlineStatusAtomFamily('missing-machine' as MachineId))).toBe(
      'offline'
    );
    store.set(lodyPresenceSyncStateAtom, 'disconnected');
    expect(store.get(machineOnlineStatusAtomFamily('missing-machine' as MachineId))).toBe(
      'unknown'
    );
    expect(store.get(sessionMetaAtomFamily(sessionRoomId))?.status?.type).toBe('idle');
    expect((store.get(docMetaCacheAtom)[sessionRoomId] as SessionMeta).lastRunningSeen).toBe(
      now - 240_000
    );
    expect(store.get(sessionListAtom)[0]?.status?.type).toBe('idle');
    expect(
      store.get(allActiveSessionsAtom).find((meta) => meta.id === childSessionId)?.status?.type
    ).toBe('idle');
    expect(store.get(childSessionsAtomFamily(sessionId))[0]?.status?.type).toBe('idle');
    expect(store.get(sessionLiveStatusAtomFamily(sessionId))?.type).toBe('running');
    expect(store.get(sessionLiveStatusAtomFamily(childSessionId))?.type).toBe('initializing');
  });

  it('expires live session status when the presence clock advances past TTL', () => {
    const store = createStore();
    const now = getServerNow();
    const machineId = 'ttl-machine-1' as MachineId;
    const sessionId = 'ttl-session-1' as SessionId;
    const instanceId = 'ttl-instance-1' as LodyPresenceInstanceId;

    store.set(lodyPresenceStatesAtom, {
      [getLodySessionPresenceKey(sessionId, instanceId)]: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        status: { type: 'running' },
        updatedAt: now,
      },
    });

    expect(store.get(sessionLiveStatusAtomFamily(sessionId))?.type).toBe('running');

    store.set(setLodyPresenceNowMsAtom, now + LODY_PRESENCE_TTL_MS + 1);

    expect(store.get(sessionLiveStatusAtomFamily(sessionId))).toBeNull();
  });
});

describe('presumed machine liveness while presence is unknown', () => {
  const machineId = 'machine-recent' as MachineId;

  const storeWithHeartbeat = () => {
    const store = createStore();
    const now = getServerNow();
    const instanceId = 'instance-recent' as LodyPresenceInstanceId;
    store.set(setLodyPresenceStatesAtom, {
      [getLodyMachinePresenceKey(machineId, instanceId)]: {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: now,
      },
    });
    return { store, now };
  };

  it('keeps a machine online for ten minutes after its last heartbeat, then offline', () => {
    const { store, now } = storeWithHeartbeat();
    store.set(lodyPresenceSyncStateAtom, 'disconnected');

    store.set(setLodyPresenceNowMsAtom, now + MACHINE_RECENTLY_ONLINE_MS - 1_000);
    expect(store.get(presumedOnlineMachineIdsAtom).has(machineId)).toBe(true);

    store.set(setLodyPresenceNowMsAtom, now + MACHINE_RECENTLY_ONLINE_MS + LODY_PRESENCE_TTL_MS);
    expect(store.get(presumedOnlineMachineIdsAtom).has(machineId)).toBe(false);
  });

  it('remembers the heartbeat across a presence restart that clears the snapshot', () => {
    const { store } = storeWithHeartbeat();

    store.set(clearLodyPresenceStatesAtom);

    expect(store.get(onlineMachineIdsAtom).has(machineId)).toBe(false);
    expect(store.get(presumedOnlineMachineIdsAtom).has(machineId)).toBe(true);
  });

  it('treats a machine never seen online as offline', () => {
    const store = createStore();
    store.set(lodyPresenceSyncStateAtom, 'disconnected');

    expect(store.get(presumedOnlineMachineIdsAtom).has(machineId)).toBe(false);
  });

  it('trusts a synced room over the remembered heartbeat', () => {
    const { store, now } = storeWithHeartbeat();
    store.set(lodyPresenceSyncStateAtom, 'synced');

    store.set(setLodyPresenceNowMsAtom, now + LODY_PRESENCE_TTL_MS + 1);

    expect(store.get(presumedOnlineMachineIdsAtom).has(machineId)).toBe(false);
  });
});
