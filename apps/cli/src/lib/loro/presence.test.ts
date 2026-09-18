import { EphemeralStore } from 'loro-crdt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLodySessionPresenceKey,
  LODY_PRESENCE_TTL_MS,
  parseLodyPresenceStates,
  SessionStatusFactory,
  type LodyPresenceInstanceId,
  type LodyPresenceStateMap,
  type LodySessionPresenceState,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import type { Logger } from '@/utils/logger';
import { CliPresenceRuntime } from './presence';

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const SESSION_ID = 'session-presence-1' as SessionId;
const MACHINE_ID = 'machine-presence-1' as MachineId;
const REMOTE_SESSION_ID = 'session-presence-remote' as SessionId;
const REMOTE_MACHINE_ID = 'machine-presence-remote' as MachineId;
const REMOTE_INSTANCE_ID = 'remote-instance' as LodyPresenceInstanceId;
const getPresenceStore = (
  presence: CliPresenceRuntime
): {
  getAllStates: () => Record<string, unknown>;
  apply: (update: Uint8Array) => void;
} => {
  return (
    presence as unknown as {
      store: {
        getAllStates: () => Record<string, unknown>;
        apply: (update: Uint8Array) => void;
      };
    }
  ).store;
};

/**
 * Replicate a peer's entry into the runtime's workspace replica the way the
 * cloud presence room does — the CLI never authors these.
 */
const replicatePeerFromPresenceRoom = (presence: CliPresenceRuntime): void => {
  const peer = new EphemeralStore(LODY_PRESENCE_TTL_MS);
  peer.set(getLodySessionPresenceKey(REMOTE_SESSION_ID, REMOTE_INSTANCE_ID), {
    kind: 'session',
    sessionId: REMOTE_SESSION_ID,
    machineId: REMOTE_MACHINE_ID,
    instanceId: REMOTE_INSTANCE_ID,
    status: SessionStatusFactory.initializing(),
    updatedAt: Date.now(),
  });
  try {
    getPresenceStore(presence).apply(peer.encodeAll());
  } finally {
    peer.destroy();
  }
};

/** Decode what the local data plane would push to a renderer. */
const decodeLocalOriginSnapshot = (presence: CliPresenceRuntime): LodyPresenceStateMap => {
  const decoded = new EphemeralStore(LODY_PRESENCE_TTL_MS);
  try {
    decoded.apply(presence.encodeLocalOriginPresence());
    return parseLodyPresenceStates(decoded.getAllStates() as Record<string, unknown>);
  } finally {
    decoded.destroy();
  }
};
const getSessionPresenceState = (
  presence: CliPresenceRuntime
): LodySessionPresenceState | undefined => {
  const store = getPresenceStore(presence);
  const states = parseLodyPresenceStates(store.getAllStates());
  return Object.values(states).find(
    (state): state is LodySessionPresenceState =>
      state.kind === 'session' && state.sessionId === SESSION_ID
  );
};

let runtime: CliPresenceRuntime | null = null;

const createRuntime = (): CliPresenceRuntime => {
  runtime = new CliPresenceRuntime({
    workspaceId: 'workspace-presence-1' as WorkspaceId,
    logger: createLogger(),
  });
  return runtime;
};

afterEach(async () => {
  await runtime?.stop();
  runtime = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CliPresenceRuntime session presence', () => {
  it('falls back to the local machine identity when session meta has no machineId yet', () => {
    const presence = createRuntime();
    presence.setMachineOnline(MACHINE_ID);

    presence.setSessionPresence({
      sessionId: SESSION_ID,
      machineId: undefined,
      status: SessionStatusFactory.running(),
    });

    expect(getSessionPresenceState(presence)).toMatchObject({
      sessionId: SESSION_ID,
      machineId: MACHINE_ID,
      status: SessionStatusFactory.running(),
    });
  });

  it('skips the write when no machine identity is known at all', () => {
    const presence = createRuntime();

    presence.setSessionPresence({
      sessionId: SESSION_ID,
      machineId: undefined,
      status: SessionStatusFactory.running(),
    });

    expect(getSessionPresenceState(presence)).toBeUndefined();
  });

  it('clears the entry when an idle status is forwarded', () => {
    const presence = createRuntime();
    presence.setMachineOnline(MACHINE_ID);

    presence.setSessionPresence({
      sessionId: SESSION_ID,
      machineId: MACHINE_ID,
      status: SessionStatusFactory.initializing(),
    });
    expect(getSessionPresenceState(presence)).toBeDefined();

    presence.setSessionPresence({
      sessionId: SESSION_ID,
      machineId: MACHINE_ID,
      status: SessionStatusFactory.idle(),
    });
    expect(getSessionPresenceState(presence)).toBeUndefined();
  });

  it('republishes local session presence when the initial room join completes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const presence = createRuntime();
    presence.setMachineOnline(MACHINE_ID);

    presence.setSessionPresence({
      sessionId: SESSION_ID,
      machineId: MACHINE_ID,
      status: SessionStatusFactory.running(),
    });
    const before = getSessionPresenceState(presence);

    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    (
      presence as unknown as {
        handleRoomStatus: (status: string) => void;
      }
    ).handleRoomStatus('joined');

    expect(getSessionPresenceState(presence)?.updatedAt).toBeGreaterThan(before?.updatedAt ?? 0);
  });

  it('republishes local session presence after an internal room reconnect', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const presence = createRuntime();
    presence.setMachineOnline(MACHINE_ID);
    presence.setSessionPresence({
      sessionId: SESSION_ID,
      machineId: MACHINE_ID,
      status: SessionStatusFactory.running(),
    });
    const handleRoomStatus = (
      presence as unknown as {
        handleRoomStatus: (status: string) => void;
      }
    ).handleRoomStatus.bind(presence);

    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    handleRoomStatus('joined');
    const afterInitialJoin = getSessionPresenceState(presence);

    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
    handleRoomStatus('reconnecting');
    handleRoomStatus('joined');

    expect(getSessionPresenceState(presence)?.updatedAt).toBeGreaterThan(
      afterInitialJoin?.updatedAt ?? 0
    );
  });
});

describe('CliPresenceRuntime local-origin plane payload', () => {
  it('carries this process own machine and session entries', () => {
    const presence = createRuntime();
    presence.setMachineOnline(MACHINE_ID);
    presence.setSessionPresence({
      sessionId: SESSION_ID,
      machineId: MACHINE_ID,
      status: SessionStatusFactory.initializing(),
    });

    expect(Object.values(decodeLocalOriginSnapshot(presence))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'machine', machineId: MACHINE_ID }),
        expect.objectContaining({ kind: 'session', sessionId: SESSION_ID }),
      ])
    );
  });

  it('excludes peers replicated from the workspace presence room', () => {
    const presence = createRuntime();
    presence.setMachineOnline(MACHINE_ID);
    replicatePeerFromPresenceRoom(presence);

    // The replica sees the peer; the local plane must not carry it, or the
    // renderer would read a remote machine's status as local-origin.
    expect(
      Object.values(parseLodyPresenceStates(getPresenceStore(presence).getAllStates())).some(
        (state) => state.kind === 'session' && state.sessionId === REMOTE_SESSION_ID
      )
    ).toBe(true);
    expect(
      Object.values(decodeLocalOriginSnapshot(presence)).some(
        (state) => state.kind === 'session' && state.sessionId === REMOTE_SESSION_ID
      )
    ).toBe(false);
  });

  it('notifies local-plane subscribers on own writes but not on peer replication', () => {
    const presence = createRuntime();
    const onLocalOriginChange = vi.fn();
    presence.subscribeLocalOriginPresence(onLocalOriginChange);

    presence.setMachineOnline(MACHINE_ID);
    expect(onLocalOriginChange).toHaveBeenCalledTimes(1);

    replicatePeerFromPresenceRoom(presence);
    expect(onLocalOriginChange).toHaveBeenCalledTimes(1);

    presence.setSessionPresence({
      sessionId: SESSION_ID,
      machineId: MACHINE_ID,
      status: SessionStatusFactory.running(),
    });
    expect(onLocalOriginChange).toHaveBeenCalledTimes(2);
  });

  it('drops a cleared session entry so the renderer stops showing it as working', () => {
    const presence = createRuntime();
    presence.setMachineOnline(MACHINE_ID);
    presence.setSessionPresence({
      sessionId: SESSION_ID,
      machineId: MACHINE_ID,
      status: SessionStatusFactory.running(),
    });

    presence.clearSessionPresence(SESSION_ID);

    const snapshot = decodeLocalOriginSnapshot(presence);
    expect(
      Object.values(snapshot).some(
        (state) => state.kind === 'session' && state.sessionId === SESSION_ID
      )
    ).toBe(false);
    // The machine entry must survive the session clear.
    expect(
      Object.values(snapshot).some(
        (state) => state.kind === 'machine' && state.machineId === MACHINE_ID
      )
    ).toBe(true);
  });
});
