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

    // The failed room is swept about as soon as a reconnect would have run, so
    // this Machine's own room recovers quickly, but only as a per-room sweep.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith({ resetBackoff: false, timeout: 10_000 });
    expect(joinMetaRoom).not.toHaveBeenCalled();

    // While it keeps failing, sweeps back off instead of repeating every second.
    instance.setTransportStatus('disconnected');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(reconnect).toHaveBeenLastCalledWith({ resetBackoff: false, timeout: 10_000 });
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
    // At most one per-room sweep, never a transport reconnect.
    expect(reconnect.mock.calls).toEqual([[{ resetBackoff: false, timeout: 10_000 }]]);
  });

  it('keeps the room sweep when an unrelated room reports connected', async () => {
    // loro-repo sets the aggregate to 'connected' on any join start or
    // successful sync without re-aggregating, while the failed room stays failed.
    const reconnect = vi.fn(async () => {});
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom: vi.fn() }, metaSub);

    instance.setTransportStatus('disconnected');
    instance.setTransportStatus('connected');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconnect).toHaveBeenCalledWith({ resetBackoff: false, timeout: 10_000 });
  });

  it('backs off room sweeps while failures repeat and resets after they stop', async () => {
    const reconnect = vi.fn(async () => {});
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, joinMetaRoom: vi.fn() }, metaSub);
    const sweepAfter = async (failure: () => void) => {
      const before = reconnect.mock.calls.length;
      failure();
      let waited = 0;
      while (reconnect.mock.calls.length === before) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      return waited;
    };
    const fail = () => {
      instance.setTransportStatus('disconnected');
      instance.setTransportStatus('connected');
    };

    const delays = [];
    for (let round = 0; round < 4; round++) delays.push(await sweepAfter(fail));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);

    // A failure after a quiet minute is a new episode and is swept quickly again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await sweepAfter(fail)).toBe(1_000);
  });
});
