import { describe, expect, it } from 'vitest';
import type { TransportRoomStatus, TransportSubscription } from 'loro-repo';
import { createRoomSyncTracker } from '../src/providers/room-sync-tracker';

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
});
