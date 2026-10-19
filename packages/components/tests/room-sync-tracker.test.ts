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
  sub: TransportSubscription & { readonly initializationFailed?: boolean };
  emit: (status: TransportRoomStatus) => void;
  setFirstSyncedWithRemote: (promise: Promise<void>) => void;
  setInitializationFailed: (value: boolean | undefined) => void;
} {
  let status = initialStatus;
  let firstSyncedWithRemote = Promise.resolve();
  let initializationFailed: boolean | undefined;
  const listeners = new Set<(status: TransportRoomStatus) => void>();
  return {
    sub: {
      get initializationFailed() {
        return initializationFailed;
      },
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
    setInitializationFailed: (value) => {
      initializationFailed = value;
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

  it('treats joined as syncing until first remote sync completes', () => {
    const tracker = createRoomSyncTracker('room-1');
    tracker.attach(createSubscription(['joined']));

    expect(tracker.getSyncState()).toBe('syncing');

    tracker.markFirstSynced();
    expect(tracker.getSyncState()).toBe('synced');
  });

  it('reports initial sync failure as reconnectable', () => {
    const tracker = createRoomSyncTracker('room-1');
    tracker.attach(createSubscription(['joined']));
    tracker.markFirstSyncFailed();

    expect(tracker.getSyncState()).toBe('error');
    expect(tracker.needsReconnect()).toBe(true);
    expect(tracker.hasReconnectSignal(false)).toBe(false);
    expect(tracker.hasReconnectSignal(true)).toBe(true);
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

  // The SDK ends a generation's initialization on a non-retryable error (or its
  // hard deadline) while Repo still projects the room as joining, and no SDK
  // retry follows. Only the reconnect loop's per-room sync can restart it.
  it.each(['connecting', 'reconnecting'] as const)(
    'flags a %s room whose SDK initialization ended without a retry',
    (status) => {
      const controlled = createControlledSubscription(status);
      controlled.setInitializationFailed(true);
      const tracker = createRoomSyncTracker('room-stuck');
      tracker.attach(controlled.sub);

      expect(tracker.needsReconnect()).toBe(true);
      expect(tracker.hasReconnectSignal(true)).toBe(true);

      // A repaired generation joins; the probe clears with it.
      controlled.setInitializationFailed(false);
      controlled.emit('joined');
      tracker.markFirstSynced();
      expect(tracker.needsReconnect()).toBe(false);
    }
  );

  it.each([false, undefined])(
    'leaves a connecting room to the SDK while its initialization runs or retries (probe=%s)',
    (initializationFailed) => {
      const controlled = createControlledSubscription('connecting');
      controlled.setInitializationFailed(initializationFailed);
      const tracker = createRoomSyncTracker('room-initializing');
      tracker.attach(controlled.sub);

      expect(tracker.getSyncState()).toBe('connecting');
      expect(tracker.needsReconnect()).toBe(false);
      expect(tracker.hasReconnectSignal(true)).toBe(false);
    }
  );

  it('never flags a failed initialization once the room is detached or stopped', () => {
    const controlled = createControlledSubscription('connecting');
    controlled.setInitializationFailed(true);
    const tracker = createRoomSyncTracker('room-released');
    tracker.attach(controlled.sub);
    controlled.emit('detached' as TransportRoomStatus);
    expect(tracker.needsReconnect()).toBe(false);

    controlled.emit('connecting');
    tracker.markStopped();
    expect(tracker.needsReconnect()).toBe(false);
  });
});
