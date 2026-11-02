import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceId } from '@lody/shared';
import type {
  LoroRepo,
  TransportConnectionStatus,
  TransportRoomStatus,
  TransportSubscription,
} from 'loro-repo';

import type { Logger } from '@/utils/logger';
import { LoroConnectionRecoveryController } from './connection-recovery';

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

type FakeMetaSub = TransportSubscription & {
  emitStatus: (status: TransportRoomStatus) => void;
};

const createMetaSub = (initialStatus: TransportRoomStatus = 'joined'): FakeMetaSub => {
  const listeners = new Set<(status: TransportRoomStatus) => void>();
  const sub = {
    status: initialStatus,
    firstSyncedWithRemote: Promise.resolve(),
    waitUntilSynced: vi.fn(async () => {}),
    unsubscribe: vi.fn(),
    rejoin: vi.fn(),
    onStatusChange: (listener: (status: TransportRoomStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitStatus: (status: TransportRoomStatus) => {
      sub.status = status;
      for (const listener of listeners) listener(status);
    },
    // The production code reads room state through the per-transport
    // 'streams' binding, never the classic surface. A fake without this
    // would silently exercise a different code path than production.
    subscription: (transportId: string) => ({
      transportId,
      get status() {
        return sub.status;
      },
      firstSyncedWithRemote: sub.firstSyncedWithRemote,
      waitUntilSynced: sub.waitUntilSynced,
      rejoin: sub.rejoin,
      onStatusChange: sub.onStatusChange,
    }),
    subscriptions: () => [],
    transportIds: () => ['streams'],
  };
  return sub as unknown as FakeMetaSub;
};

describe('LoroConnectionRecoveryController watchdog room sweep', () => {
  let controller: LoroConnectionRecoveryController | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(async () => {
    await controller?.cleanUp();
    controller = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const createController = (
    repo: Partial<LoroRepo>,
    metaSub: FakeMetaSub | null,
    options: {
      readonly initialTransportStatus?: TransportConnectionStatus;
      readonly initialMetaSyncCompleted?: boolean;
    } = {}
  ) => {
    const initialMetaSyncCompleted = options.initialMetaSyncCompleted ?? true;
    controller = new LoroConnectionRecoveryController({
      repo: repo as LoroRepo,
      workspaceId: 'ws-recovery-test' as WorkspaceId,
      logger: createLogger(),
      initialMetaSub: metaSub,
      initialTransportStatus: options.initialTransportStatus ?? 'connected',
      initialMetaSyncPromise: Promise.resolve(initialMetaSyncCompleted),
      initialMetaSyncCompleted,
      onMetaRoomReady: vi.fn(),
    });
    return controller;
  };

  it('sweeps rooms via repo.reconnect() even while transport and meta are healthy', async () => {
    // Regression guard for the "stuck until daemon restart" bug class: a
    // doc/flock room can sit in 'error' after a non-retriable stream failure
    // while transport + meta stay healthy. The watchdog previously early-
    // returned on isStreamsHealthy() and never rejoined such rooms.
    let resolveReconnectCalled: () => void = () => {};
    const reconnectCalled = new Promise<void>((resolve) => {
      resolveReconnectCalled = resolve;
    });
    const reconnect = vi.fn(async () => {
      resolveReconnectCalled();
    });
    const metaSub = createMetaSub('joined');
    createController({ reconnect, joinMetaRoom: vi.fn() }, metaSub);

    expect(reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await reconnectCalled;
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith({ resetBackoff: false, timeout: 10_000 });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it('does not re-fire meta-synced listeners or rejoin meta on a healthy sweep', async () => {
    const reconnect = vi.fn(async () => {});
    const joinMetaRoom = vi.fn();
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom }, metaSub);

    const metaSynced = vi.fn();
    instance.onMetaRoomSynced(metaSynced);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    // The healthy sweep must stay side-effect free: no meta room rejoin and no
    // meta-synced fan-out (those listeners trigger metadata recovery work).
    expect(joinMetaRoom).not.toHaveBeenCalled();
    expect(metaSynced).not.toHaveBeenCalled();
  });

  it('keeps the full recovery path when the meta room degrades', async () => {
    const reconnect = vi.fn(async () => {});
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom: vi.fn() }, metaSub);

    metaSub.emitStatus('error');
    // scheduleReconnect uses jittered exponential backoff starting at ~1s;
    // 5s comfortably covers attempt 0 including jitter.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reconnect).toHaveBeenCalled();
    expect(instance.isRecovering()).toBe(true);

    metaSub.emitStatus('joined');
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.isRecovering()).toBe(false);
  });

  it('treats an aggregate "connecting" caused by joining rooms as healthy', async () => {
    // `TransportConnectionStatus` aggregates every joined room, so lazily
    // joining a session room flips it to 'connecting' and back. In a workspace
    // with thousands of rooms that happens continuously. Each flip used to
    // count as a recovery episode: it re-emitted meta-synced, whose listeners
    // run O(rooms) recovery scans, which join more rooms, which flip the
    // aggregate again — a self-sustaining loop, ~one full scan every 2-4s.
    const reconnect = vi.fn(async () => {});
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom: vi.fn() }, metaSub);
    const metaSynced = vi.fn();
    instance.onMetaRoomSynced(metaSynced);

    expect(instance.getStreamsHealth()).toBe('connected');

    for (let round = 0; round < 10; round++) {
      instance.setTransportStatus('connecting');
      expect(instance.getStreamsHealth()).toBe('joining-rooms');
      expect(instance.isRecovering()).toBe(false);
      instance.setTransportStatus('connected');
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(metaSynced).not.toHaveBeenCalled();
    expect(metaSub.waitUntilSynced).not.toHaveBeenCalled();

    // No reconnect was scheduled either: the backoff timer would have fired
    // well before the 30s watchdog sweep.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('keeps one failed doc room from starting a transport-wide recovery', async () => {
    // #2194: a cross-machine read joined a room whose initial sync never
    // finished. Each failure made the aggregate 'disconnected', and treating
    // that as an outage reconnected the workspace and rescanned every session
    // about every two minutes. The meta room never left 'joined'.
    const reconnect = vi.fn(async () => {});
    const joinMetaRoom = vi.fn();
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom }, metaSub);
    const metaSynced = vi.fn();
    const streamsOnline = vi.fn();
    instance.onMetaRoomSynced(metaSynced);
    instance.onStreamsOnline(streamsOnline);

    instance.setTransportStatus('disconnected');
    expect(instance.getStreamsHealth()).toBe('rooms-degraded');
    expect(instance.isRecovering()).toBe(false);
    expect(instance.isTransportConnected()).toBe(true);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(reconnect).not.toHaveBeenCalled();

    // The failed room is retried by the per-room watchdog sweep only.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith({ resetBackoff: false, timeout: 10_000 });
    expect(joinMetaRoom).not.toHaveBeenCalled();
    expect(metaSynced).not.toHaveBeenCalled();
    expect(streamsOnline).not.toHaveBeenCalled();
  });

  it('confirms meta writes while an unrelated room is disconnected', async () => {
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect: vi.fn(async () => {}) }, metaSub);

    instance.setTransportStatus('disconnected');
    await expect(instance.waitUntilMetaSynced({ reason: 'test' })).resolves.toBe(true);
    expect(metaSub.waitUntilSynced).toHaveBeenCalledTimes(1);
  });

  it('treats a disconnected transport without a joined meta room as offline', async () => {
    const reconnect = vi.fn(async () => {});
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom: vi.fn() }, metaSub);

    metaSub.emitStatus('reconnecting');
    instance.setTransportStatus('disconnected');
    expect(instance.getStreamsHealth()).toBe('recovering');
    expect(instance.isTransportConnected()).toBe(false);
    await expect(instance.waitUntilMetaSynced({ reason: 'test' })).resolves.toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconnect).toHaveBeenCalledWith({ resetBackoff: false, timeout: 10_000 });
  });

  it('reports each real meta-room recovery generation exactly once', async () => {
    const reconnect = vi.fn(async () => {});
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom: vi.fn() }, metaSub);
    const metaSynced = vi.fn();
    instance.onMetaRoomSynced(metaSynced);

    metaSub.emitStatus('error');
    metaSub.emitStatus('joined');
    await vi.advanceTimersByTimeAsync(0);

    expect(metaSub.waitUntilSynced).toHaveBeenCalledTimes(1);
    expect(metaSynced).toHaveBeenCalledTimes(1);

    metaSub.emitStatus('joined');
    await vi.advanceTimersByTimeAsync(0);
    expect(metaSynced).toHaveBeenCalledTimes(1);

    metaSub.emitStatus('disconnected');
    metaSub.emitStatus('joined');
    await vi.advanceTimersByTimeAsync(0);
    expect(metaSub.waitUntilSynced).toHaveBeenCalledTimes(2);
    expect(metaSynced).toHaveBeenCalledTimes(2);
  });

  it('ignores transport-only flaps while the meta room stays joined', async () => {
    // `meta-room-synced` drives O(rooms) rescans. A flap that never took the
    // meta room down cannot have missed metadata, so it is not a recovery edge.
    const reconnect = vi.fn(async () => {});
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom: vi.fn() }, metaSub);
    const metaSynced = vi.fn();
    const streamsOnline = vi.fn();
    instance.onMetaRoomSynced(metaSynced);
    instance.onStreamsOnline(streamsOnline);

    for (let round = 0; round < 5; round++) {
      instance.setTransportStatus('disconnected');
      instance.setTransportStatus('connected');
      await vi.advanceTimersByTimeAsync(0);
    }

    await vi.advanceTimersByTimeAsync(29_000);
    expect(metaSynced).not.toHaveBeenCalled();
    expect(streamsOnline).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('does not throttle a fan-out after the meta room actually degraded', async () => {
    // A real meta-room outage may have missed remote metadata, so its rescan
    // must not be held behind the transport-flap floor.
    const reconnect = vi.fn(async () => {});
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom: vi.fn() }, metaSub);
    const metaSynced = vi.fn();
    instance.onMetaRoomSynced(metaSynced);

    metaSub.emitStatus('error');
    metaSub.emitStatus('joined');
    await vi.advanceTimersByTimeAsync(0);
    expect(metaSynced).toHaveBeenCalledTimes(1);

    // Immediately again, well inside the 30s floor.
    metaSub.emitStatus('error');
    metaSub.emitStatus('joined');
    await vi.advanceTimersByTimeAsync(0);
    expect(metaSynced).toHaveBeenCalledTimes(2);
  });

  it('reports a newly joined replacement meta room', async () => {
    const replacementMetaSub = createMetaSub('joined');
    const reconnect = vi.fn(async () => {});
    const joinMetaRoom = vi.fn(async () => replacementMetaSub);
    const instance = createController({ reconnect, joinMetaRoom }, null, {
      initialTransportStatus: 'connected',
    });
    const metaSynced = vi.fn();
    instance.onMetaRoomSynced(metaSynced);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(joinMetaRoom).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(metaSynced).toHaveBeenCalledTimes(1));
    expect(replacementMetaSub.waitUntilSynced).toHaveBeenCalledTimes(1);
  });

  it('drops a stale joined event when the meta room degrades before sync handling', async () => {
    const reconnect = vi.fn(async () => {});
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom: vi.fn() }, metaSub);
    const metaSynced = vi.fn();
    instance.onMetaRoomSynced(metaSynced);

    metaSub.emitStatus('error');
    metaSub.emitStatus('joined');
    metaSub.emitStatus('error');
    await vi.advanceTimersByTimeAsync(0);

    expect(metaSub.waitUntilSynced).not.toHaveBeenCalled();
    expect(metaSynced).not.toHaveBeenCalled();

    metaSub.emitStatus('joined');
    await vi.advanceTimersByTimeAsync(0);
    expect(metaSynced).toHaveBeenCalledTimes(1);
  });
});
