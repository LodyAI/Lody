import { EphemeralStore } from 'loro-crdt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLodySessionPresenceKey,
  LODY_PRESENCE_HEARTBEAT_MS,
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

const createRuntime = (logger: Logger = createLogger()): CliPresenceRuntime => {
  runtime = new CliPresenceRuntime({
    workspaceId: 'workspace-presence-1' as WorkspaceId,
    logger,
  });
  return runtime;
};

/**
 * The shared presence write queue as the transport reports it. The runtime only ever
 * reads this subscription, so a stand-in is enough to drive its delivery observability.
 */
type PresenceQueueStub = {
  pendingLocalCount: number;
  status: string;
  lastLocalAppendAtMs?: number;
  lastWriteError?: { code: string; retryable: boolean };
  waitUntilSynced: () => Promise<void>;
};

/** Attach a queue stand-in the way a successful room join would, teardown included. */
const attachPresenceQueue = (presence: CliPresenceRuntime, queue: PresenceQueueStub): void => {
  (
    presence as unknown as { subscription: PresenceQueueStub & { unsubscribe: () => void } }
  ).subscription = { unsubscribe: () => {}, ...queue };
};

const loggedLines = (fn: unknown): string[] =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls.map((call) => String(call[0]));

/** Settle the delivery probe's promise chain without touching timers. */
const flushProbe = async (): Promise<void> => {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
};

afterEach(async () => {
  await runtime?.stop();
  runtime = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CliPresenceRuntime heartbeat delivery observability', () => {
  const BASE_MS = Date.UTC(2026, 8, 20, 14, 0, 0);
  const neverSettles = (): Promise<void> => new Promise<void>(() => {});

  const freezeClock = (): void => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BASE_MS);
  };

  it('records the shared write queue alongside every heartbeat', () => {
    freezeClock();
    const logger = createLogger();
    const presence = createRuntime(logger);
    attachPresenceQueue(presence, {
      pendingLocalCount: 4000,
      status: 'joined',
      lastLocalAppendAtMs: BASE_MS - 12_000,
      lastWriteError: { code: 'auth_callback_failed', retryable: true },
      waitUntilSynced: neverSettles,
    });

    presence.setMachineOnline(MACHINE_ID);

    const written = loggedLines(logger.debug).find((line) => line.includes('heartbeat written'));
    expect(written).toBeDefined();
    // A backlog this deep is invisible without these counters: the room still says joined.
    expect(written).toContain('queued=4000');
    expect(written).toContain('room=joined');
    expect(written).toContain('sinceLastAppendMs=12000');
    expect(written).toContain('writeError=auth_callback_failed');
    expect(written).toContain('writeErrorRetryable=true');
  });

  it('omits queue counters while no transport is attached', () => {
    freezeClock();
    const logger = createLogger();
    const presence = createRuntime(logger);

    presence.setMachineOnline(MACHINE_ID);

    const written = loggedLines(logger.debug).find((line) => line.includes('heartbeat written'));
    // A real heartbeat line, so the absent counters below are a decision and not a
    // heartbeat that never happened: presence is produced with or without a transport.
    expect(written).toContain('seq=1');
    expect(written).not.toContain('queued=');
    expect(written).not.toContain('undefined');
  });

  it('warns when a heartbeat leaves this process already past its freshness window', async () => {
    freezeClock();
    const logger = createLogger();
    const presence = createRuntime(logger);
    let releaseQueue!: () => void;
    attachPresenceQueue(presence, {
      pendingLocalCount: 3,
      status: 'joined',
      waitUntilSynced: () =>
        new Promise<void>((resolve) => {
          releaseQueue = resolve;
        }),
    });

    presence.setMachineOnline(MACHINE_ID);
    // The backlog drains only after the entry outlived the window it is judged by.
    vi.setSystemTime(BASE_MS + LODY_PRESENCE_TTL_MS + 1);
    releaseQueue();
    await flushProbe();

    const warned = loggedLines(logger.warn).find((line) => line.includes('heartbeat delivered'));
    expect(warned).toBeDefined();
    expect(warned).toContain(`ageAtSendMs=${LODY_PRESENCE_TTL_MS + 1}`);
    expect(warned).toContain('readers still report this machine offline');
    // Two entries were ahead of the heartbeat in the shared queue.
    expect(warned).toContain('queuedAhead=2');
  });

  it('does not warn when the heartbeat is delivered inside the window', async () => {
    freezeClock();
    const logger = createLogger();
    const presence = createRuntime(logger);
    let releaseQueue!: () => void;
    attachPresenceQueue(presence, {
      pendingLocalCount: 1,
      status: 'joined',
      waitUntilSynced: () =>
        new Promise<void>((resolve) => {
          releaseQueue = resolve;
        }),
    });

    presence.setMachineOnline(MACHINE_ID);
    vi.setSystemTime(BASE_MS + 250);
    releaseQueue();
    await flushProbe();

    expect(loggedLines(logger.warn)).toHaveLength(0);
    const delivered = loggedLines(logger.debug).find((line) =>
      line.includes('heartbeat delivered')
    );
    expect(delivered).toContain('ageAtSendMs=250');
    expect(delivered).toContain('queuedAhead=0');
  });

  it('surfaces a heartbeat the queue never acknowledged on the next heartbeat', async () => {
    freezeClock();
    const logger = createLogger();
    const presence = createRuntime(logger);
    const waitUntilSynced = vi.fn(neverSettles);
    attachPresenceQueue(presence, {
      pendingLocalCount: 900,
      status: 'joined',
      waitUntilSynced,
    });

    presence.setMachineOnline(MACHINE_ID);
    await flushProbe();
    vi.setSystemTime(BASE_MS + LODY_PRESENCE_HEARTBEAT_MS);
    presence.writeMachineHeartbeat();

    const written = loggedLines(logger.debug).filter((line) => line.includes('heartbeat written'));
    expect(written).toHaveLength(2);
    // A stalled queue produces silence otherwise: the probe cannot report an age it
    // never reached, so the next heartbeat carries the outstanding one's age instead.
    expect(written[1]).toContain('unackedHeartbeatSeq=1');
    expect(written[1]).toContain(`unackedForMs=${LODY_PRESENCE_HEARTBEAT_MS}`);
    // And a second probe is never armed behind the first.
    expect(waitUntilSynced).toHaveBeenCalledTimes(1);
  });
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
