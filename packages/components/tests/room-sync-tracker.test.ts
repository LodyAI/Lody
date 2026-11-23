import { describe, expect, it, vi } from 'vitest';
import type { TransportRoomStatus, TransportSubscription, RepoRoomSubscription } from 'loro-repo';
import { createRoomSyncTracker } from '../src/providers/room-sync-tracker';
import { readinessBinding } from '../src/lib/room-readiness';
import { waitForRoomToSync, type SyncRoomSubscription } from '../src/providers/room-sync';

describe('room-sync-tracker', () => {
  function createSubscription(statuses: TransportRoomStatus[]): TransportSubscription {
    let status = statuses[0] ?? 'connecting';
    return {
      unsubscribe: () => undefined,
      firstSyncedWithRemote: Promise.resolve(),
      waitUntilSynced: async () => undefined,
      get status() {
        return status;
      },
      onStatusChange: (listener) => {
        for (const nextStatus of statuses) {
          status = nextStatus;
          listener(nextStatus);
        }
        return () => undefined;
      },
    };
  }

  function createDeferred() {
    let resolve: (() => void) | undefined;
    let reject: ((error?: unknown) => void) | undefined;
    const promise = new Promise<void>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    if (!resolve || !reject) {
      throw new Error('Failed to create deferred promise');
    }
    return { promise, resolve, reject };
  }

  function createControlledSubscription(initialStatus: TransportRoomStatus): {
    sub: TransportSubscription;
    emit: (status: TransportRoomStatus) => void;
    setFirstSyncedWithRemote: (promise: Promise<void>) => void;
  } {
    let status = initialStatus;
    let firstSyncedWithRemote = Promise.resolve();
    const listeners = new Set<(status: TransportRoomStatus) => void>();
    return {
      sub: {
        unsubscribe: () => undefined,
        get firstSyncedWithRemote() {
          return firstSyncedWithRemote;
        },
        waitUntilSynced: () => firstSyncedWithRemote,
        get status() {
          return status;
        },
        onStatusChange: (listener) => {
          listeners.add(listener);
          listener(status);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      emit: (nextStatus) => {
        status = nextStatus;
        for (const listener of Array.from(listeners)) {
          listener(nextStatus);
        }
      },
      setFirstSyncedWithRemote: (promise) => {
        firstSyncedWithRemote = promise;
      },
    };
  }

  describe('createRoomSyncTracker', () => {
    it('treats a detached binding as idle, never reconnectable', () => {
      // 'detached' means the transport is deliberately absent (signed out, route
      // pending) — the reconnect loop must not spin on it, and the room must not
      // read as broken.
      const controlled = createControlledSubscription('joined');
      const tracker = createRoomSyncTracker('room-detached');
      tracker.attach(controlled.sub);
      controlled.emit('detached' as TransportRoomStatus);
      expect(tracker.getSyncState()).toBe('idle');
      expect(tracker.needsReconnect()).toBe(false);
      // Even a failed first sync must not make a detached room reconnectable.
      tracker.markFirstSyncFailed();
      expect(tracker.needsReconnect()).toBe(false);
      // Re-attach after the transport returns resumes normal tracking.
      controlled.emit('joined');
      tracker.markFirstSynced();
      expect(tracker.getSyncState()).toBe('synced');
    });

    it('rechecks first sync after reconnecting from an initial sync failure', async () => {
      const tracker = createRoomSyncTracker('room-1');
      const subscription = createControlledSubscription('joined');
      tracker.attach(subscription.sub);
      tracker.markFirstSyncFailed();

      expect(tracker.getSyncState()).toBe('error');
      expect(tracker.needsReconnect()).toBe(true);

      const recovered = createDeferred();
      subscription.setFirstSyncedWithRemote(recovered.promise);
      subscription.emit('reconnecting');
      expect(tracker.getSyncState()).toBe('reconnecting');
      expect(tracker.needsReconnect()).toBe(false);

      subscription.emit('joined');
      expect(tracker.getSyncState()).toBe('syncing');
      expect(tracker.needsReconnect()).toBe(false);

      recovered.resolve();
      await recovered.promise;
      await Promise.resolve();

      expect(tracker.getSyncState()).toBe('synced');
      expect(tracker.needsReconnect()).toBe(false);
    });

    it('keeps a recovered join reconnectable when first sync still fails', async () => {
      const tracker = createRoomSyncTracker('room-1');
      const subscription = createControlledSubscription('joined');
      tracker.attach(subscription.sub);
      tracker.markFirstSyncFailed();

      const failed = createDeferred();
      subscription.setFirstSyncedWithRemote(failed.promise);
      subscription.emit('reconnecting');
      subscription.emit('joined');
      expect(tracker.getSyncState()).toBe('syncing');

      failed.reject(new Error('still unavailable'));
      await failed.promise.catch(() => undefined);
      await Promise.resolve();

      expect(tracker.getSyncState()).toBe('error');
      expect(tracker.needsReconnect()).toBe(true);
    });

    it('clears the stopped latch when a subsequent re-join fails before attaching', () => {
      const tracker = createRoomSyncTracker('room-stopped-retry');
      const subscription = createControlledSubscription('joined');
      tracker.attach(subscription.sub);
      tracker.markFirstSynced();
      expect(tracker.getSyncState()).toBe('synced');

      tracker.markStopped();
      expect(tracker.getSyncState()).toBe('idle');

      tracker.markFirstSyncFailed();
      expect(tracker.getSyncState()).toBe('error');
      expect(tracker.needsReconnect()).toBe(true);
    });
  });
});

describe('room-readiness', () => {
  const makeSub = (transportIds: string[]): RepoRoomSubscription => {
    const bindings = new Map<string, { transportId: string }>();
    const subscription = (transportId: string) => {
      let binding = bindings.get(transportId);
      if (!binding) {
        binding = { transportId };
        bindings.set(transportId, binding);
      }
      return binding;
    };
    return {
      transportIds: () => transportIds,
      subscription,
      subscriptions: () => transportIds.map(subscription),
    } as unknown as RepoRoomSubscription;
  };

  describe('readinessBinding', () => {
    it('prefers the local plane on dual-homed rooms', () => {
      expect(readinessBinding(makeSub(['local', 'cloud'])).transportId).toBe('local');
    });

    it('falls back to cloud for multi-transport routes without local', () => {
      expect(readinessBinding(makeSub(['a', 'cloud'])).transportId).toBe('cloud');
    });
  });
});

describe('room-sync', () => {
  const createSubscription = (
    firstSyncedWithRemote: Promise<void> = Promise.resolve()
  ): SyncRoomSubscription & { unsubscribe: ReturnType<typeof vi.fn> } => ({
    firstSyncedWithRemote,
    unsubscribe: vi.fn(),
  });

  describe('waitForRoomToSync', () => {
    it('keeps a returned room subscription when initial sync fails', async () => {
      const failedFirstSync = Promise.reject(new Error('bootstrap failed with status 404'));
      void failedFirstSync.catch(() => {});
      const badSub = createSubscription(failedFirstSync);
      const joinRoom = vi.fn().mockResolvedValueOnce(badSub);
      const sleep = vi.fn().mockResolvedValue(undefined);
      const warn = vi.fn();

      await expect(
        waitForRoomToSync(joinRoom, {
          roomId: 'session-1',
          sleep,
          warn,
        })
      ).rejects.toThrow('bootstrap failed with status 404');

      expect(joinRoom).toHaveBeenCalledTimes(1);
      expect(badSub.unsubscribe).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        '[session-1] initial room sync unavailable, continuing offline-first: bootstrap failed with status 404'
      );
    });
  });

  describe('waitForRoomToSync firstSynced selector', () => {
    it('gates on the selected binding promise, not the aggregate', async () => {
      // Dual-homed rooms must select one plane's first-sync promise: the
      // aggregate getter throws there, so the selector is the only legal gate.
      const bindingFirstSynced = Promise.resolve();
      const sub = {
        get firstSyncedWithRemote(): Promise<void> {
          throw new Error('aggregate first-sync must not be read on dual-homed rooms');
        },
        unsubscribe: () => undefined,
      };
      const result = await waitForRoomToSync(async () => sub, {
        roomId: 'room-selector',
        firstSynced: () => bindingFirstSynced,
      });
      expect(result).toBe(sub);
    });
  });

  describe('waitForRoomToSync abort signal', () => {
    it('unsubscribes and resolves null immediately when aborted while firstSynced is pending', async () => {
      const neverSettled = new Promise<void>(() => {});
      const sub = createSubscription(neverSettled);
      const controller = new AbortController();
      let observedSub: SyncRoomSubscription | null = null;

      const waiting = waitForRoomToSync(async () => sub, {
        roomId: 'room-abort-first-sync',
        signal: controller.signal,
        onSubscription: (joined) => {
          observedSub = joined;
          controller.abort();
        },
      });

      await expect(waiting).resolves.toBeNull();
      expect(observedSub).toBe(sub);
      expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes when signal aborts synchronously inside joinRoom for an already-fulfilled lease', async () => {
      const sub = createSubscription();
      const controller = new AbortController();

      const result = await waitForRoomToSync(
        () => {
          controller.abort();
          return Promise.resolve(sub);
        },
        {
          roomId: 'room-abort-during-sync-join',
          signal: controller.signal,
        }
      );

      expect(result).toBeNull();
      await Promise.resolve();
      expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
