import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineFlockEvent } from '@lody/shared';
import type { LoroRepo, RepoTransportRoomStatus } from 'loro-repo';

import type { Logger } from '@/utils/logger';

import { MachineFlockCommandWatcher } from './machine-flock-command-watcher';

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type FakeRoom = ReturnType<typeof createRoom>;

function createRoom(
  firstSyncedWithRemote: Promise<void> = Promise.resolve(),
  initialStatus: RepoTransportRoomStatus = 'joined'
) {
  let status = initialStatus;
  const listeners = new Set<(next: RepoTransportRoomStatus) => void>();
  const unsubscribe = vi.fn();
  const binding = {
    transportId: 'streams',
    get status() {
      return status;
    },
    firstSyncedWithRemote,
    onStatusChange: (listener: (next: RepoTransportRoomStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    unsubscribe,
    subscription: () => binding,
    emitStatus(next: RepoTransportRoomStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function createHarness(rooms: Array<FakeRoom | Error>, waitForRemoteAuthority = true) {
  let eventListener: ((batch: { events: MachineFlockEvent[] }) => void) | null = null;
  const unsubscribeFlock = vi.fn();
  const joinRoom = vi.fn(async () => {
    const attempt = rooms.shift();
    if (!attempt) throw new Error('no fake room available');
    if (attempt instanceof Error) throw attempt;
    return attempt;
  });
  const openFlockDoc = vi.fn(async () => ({
    flock: {
      subscribe: vi.fn((listener) => {
        eventListener = listener;
        return unsubscribeFlock;
      }),
    },
    joinRoom,
  }));
  const onEvents = vi.fn();
  const onReady = vi.fn();
  const watcher = new MachineFlockCommandWatcher({
    repo: { openFlockDoc } as unknown as LoroRepo,
    docId: 'workspace:mf:machine',
    logContext: 'workspaceId=workspace, machineId=machine, docId=workspace:mf:machine',
    waitForRemoteAuthority,
    logger: createLogger(),
    onEvents,
    onReady,
  });
  return {
    watcher,
    joinRoom,
    onEvents,
    onReady,
    unsubscribeFlock,
    emitEvents(events: MachineFlockEvent[]) {
      if (!eventListener) throw new Error('watcher is not subscribed');
      eventListener({ events });
    },
  };
}

describe('MachineFlockCommandWatcher', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('processes the authoritative local Flock immediately and forwards live events', async () => {
    const room = createRoom();
    const harness = createHarness([room], false);

    await harness.watcher.start();
    expect(harness.watcher.isReady).toBe(true);
    expect(harness.onReady).toHaveBeenCalledTimes(1);

    const event = { key: ['providerSetup', 'setup-1'], value: {} } as MachineFlockEvent;
    harness.emitEvents([event]);
    expect(harness.onEvents).toHaveBeenCalledWith([event], { authoritative: true });

    harness.watcher.stop();
    expect(room.unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.unsubscribeFlock).toHaveBeenCalledTimes(1);
  });

  it('retries a failed initial remote sync and becomes ready only after authority is restored', async () => {
    const firstSync = deferred<void>();
    const firstRoom = createRoom(firstSync.promise);
    const secondRoom = createRoom();
    const harness = createHarness([firstRoom, secondRoom]);

    const initialAttempt = harness.watcher.start();
    firstSync.reject(new Error('initial sync failed'));
    await initialAttempt;

    expect(harness.watcher.isReady).toBe(false);
    expect(firstRoom.unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.onReady).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(harness.joinRoom).toHaveBeenCalledTimes(2);
    expect(harness.watcher.isReady).toBe(true);
    expect(harness.onReady).toHaveBeenCalledTimes(1);
    harness.watcher.stop();
  });

  it('reports events as non-authoritative until remote authority is established', async () => {
    const firstSync = deferred<void>();
    const room = createRoom(firstSync.promise);
    const harness = createHarness([room]);

    await harness.watcher.start();
    const event = { key: ['providerSetup', 'setup-1'], value: {} } as MachineFlockEvent;
    harness.emitEvents([event]);
    expect(harness.onEvents).toHaveBeenCalledWith([event], { authoritative: false });

    firstSync.resolve();
    await vi.runAllTimersAsync();
    harness.emitEvents([event]);
    expect(harness.onEvents).toHaveBeenLastCalledWith([event], { authoritative: true });
    harness.watcher.stop();
  });

  it('retries when joining the command room fails', async () => {
    const room = createRoom();
    const harness = createHarness([new Error('join failed'), room]);

    await harness.watcher.start();
    expect(harness.watcher.isReady).toBe(false);

    await vi.runAllTimersAsync();
    expect(harness.joinRoom).toHaveBeenCalledTimes(2);
    expect(harness.watcher.isReady).toBe(true);
    expect(harness.onReady).toHaveBeenCalledTimes(1);
    harness.watcher.stop();
  });

  it('retries a room that is already disconnected when the status listener attaches', async () => {
    const disconnectedRoom = createRoom(new Promise(() => {}), 'disconnected');
    const readyRoom = createRoom();
    const harness = createHarness([disconnectedRoom, readyRoom]);

    await harness.watcher.start();
    expect(harness.watcher.isReady).toBe(false);
    expect(disconnectedRoom.unsubscribe).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(harness.joinRoom).toHaveBeenCalledTimes(2);
    expect(harness.watcher.isReady).toBe(true);
    expect(harness.onReady).toHaveBeenCalledTimes(1);
    harness.watcher.stop();
  });

  it('drops remote authority during a disconnect and rescans after rejoining', async () => {
    const firstRoom = createRoom();
    const secondRoom = createRoom();
    const harness = createHarness([firstRoom, secondRoom]);

    await harness.watcher.start();
    expect(harness.watcher.isReady).toBe(true);

    firstRoom.emitStatus('disconnected');
    expect(harness.watcher.isReady).toBe(false);
    expect(firstRoom.unsubscribe).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(harness.watcher.isReady).toBe(true);
    expect(harness.onReady).toHaveBeenCalledTimes(2);
    harness.watcher.stop();
  });
});
