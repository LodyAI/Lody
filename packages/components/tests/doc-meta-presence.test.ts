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
  patchDocMetaByRoomIdAtom,
  setDocMetaByRoomIdAtom,
  sessionListAtom,
  sessionMetaAtomFamily,
  sessionMetaCacheAtom,
} from '../src/atoms/doc-meta';
import {
  lodyPresenceStatesAtom,
  lodyPresenceSyncStateAtom,
  machineOnlineStatusAtomFamily,
  onlineMachineIdsAtom,
  sessionLiveStatusAtomFamily,
  setLodyPresenceNowMsAtom,
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

  it('preserves session references when only sibling presence changes', () => {
    const store = createStore();
    const now = getServerNow();
    const machineId = 'stable-machine-1' as MachineId;
    const sessionId = 'stable-session-1' as SessionId;
    const childSessionId = 'stable-child-session-1' as SessionId;
    const siblingSessionId = 'stable-sibling-session-1' as SessionId;
    const instanceId = 'stable-instance-1' as LodyPresenceInstanceId;
    const siblingInstanceId = 'stable-instance-2' as LodyPresenceInstanceId;
    const sessionRoomId = getSessionRoomId(sessionId);
    const childSessionRoomId = getSessionRoomId(childSessionId);
    const sessionMetaAtom = sessionMetaAtomFamily(sessionRoomId);
    const childSessionsAtom = childSessionsAtomFamily(sessionId);
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

    store.set(sessionMetaCacheAtom, {
      [sessionRoomId]: session,
      [childSessionRoomId]: childSession,
    });
    store.set(lodyPresenceStatesAtom, {
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

    const firstSession = store.get(sessionMetaAtom);
    const firstChildren = store.get(childSessionsAtom);
    const firstAllActiveSessions = store.get(allActiveSessionsAtom);

    store.set(lodyPresenceStatesAtom, {
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
      [getLodySessionPresenceKey(siblingSessionId, siblingInstanceId)]: {
        kind: 'session',
        sessionId: siblingSessionId,
        machineId,
        instanceId: siblingInstanceId,
        status: { type: 'running', activity: 'image_generation' },
        updatedAt: now + 1,
      },
    });

    expect(store.get(sessionMetaAtom)).toBe(firstSession);
    expect(store.get(childSessionsAtom)).toBe(firstChildren);
    expect(store.get(allActiveSessionsAtom)).toBe(firstAllActiveSessions);

    store.set(lodyPresenceStatesAtom, {
      [getLodySessionPresenceKey(sessionId, instanceId)]: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        status: { type: 'running' },
        updatedAt: now + 2,
      },
    });

    expect(store.get(sessionMetaAtom)).toBe(firstSession);
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

  it('keeps metadata cache references stable for equivalent writes', () => {
    const store = createStore();
    const sessionId = 'stable-doc-meta-session-1' as SessionId;
    const roomId = getSessionRoomId(sessionId);
    const session: SessionMeta = {
      id: sessionId,
      machineId: 'machine-1' as MachineId,
      createdAt: '2026-04-24T00:00:00.000Z',
      userId: 'user-1',
      status: { type: 'idle' },
      cliType: 'builtin',
      agentType: 'codex',
      env: { CODEX_SANDBOX: 'workspace-write' },
    };

    store.set(setDocMetaByRoomIdAtom, roomId, session);
    const firstCache = store.get(sessionMetaCacheAtom);

    store.set(setDocMetaByRoomIdAtom, roomId, {
      ...session,
      env: { CODEX_SANDBOX: 'workspace-write' },
    });
    expect(store.get(sessionMetaCacheAtom)).toBe(firstCache);

    store.set(patchDocMetaByRoomIdAtom, roomId, {
      env: { CODEX_SANDBOX: 'workspace-write' },
    });
    expect(store.get(sessionMetaCacheAtom)).toBe(firstCache);

    store.set(patchDocMetaByRoomIdAtom, roomId, {
      status: { type: 'running' },
    });
    expect(store.get(sessionMetaCacheAtom)).not.toBe(firstCache);
  });
});
