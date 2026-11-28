import type { RepoTransportRoomStatus } from 'loro-repo';
import type { RoomSyncState } from '@/lib/room-sync-state';

/**
 * Minimal structural surface a tracker observes: satisfied by both the
 * aggregate `TransportSubscription` (single-routed rooms) and the
 * per-transport `RepoTransportRoomSubscription` binding (the required source
 * on dual-homed rooms, where the aggregate members throw).
 */
export type TrackedRoomSubscription = {
  readonly status: RepoTransportRoomStatus;
  readonly onStatusChange: (listener: (status: RepoTransportRoomStatus) => void) => () => void;
  readonly firstSyncedWithRemote: Promise<void>;
};

export type ReceiveConfirmationSource = (listener: (confirmed: boolean) => void) => () => void;

export function createReceiveConfirmationHub() {
  const confirmed = new Set<string>();
  const listeners = new Map<string, Set<(confirmed: boolean) => void>>();
  return {
    publish(docId: string, next: boolean): void {
      if (confirmed.has(docId) === next) return;
      if (next) confirmed.add(docId);
      else confirmed.delete(docId);
      for (const listener of Array.from(listeners.get(docId) ?? [])) listener(next);
    },
    source(docId: string): ReceiveConfirmationSource {
      return (listener) => {
        let docListeners = listeners.get(docId);
        if (!docListeners) {
          docListeners = new Set();
          listeners.set(docId, docListeners);
        }
        docListeners.add(listener);
        listener(confirmed.has(docId));
        return () => {
          docListeners.delete(listener);
          if (docListeners.size === 0) listeners.delete(docId);
        };
      };
    },
  };
}

const isTerminalRoomStatus = (status: RepoTransportRoomStatus | null): boolean =>
  status === 'disconnected' || status === 'error';

const isReconnectStatus = (status: RepoTransportRoomStatus | null): boolean =>
  status === 'connecting' || status === 'reconnecting';

export type RoomSyncTracker = {
  readonly roomId: string;
  /** With `receive`, a joined room is `'synced'` only while that source confirms. */
  attach: (sub: TrackedRoomSubscription, receive?: ReceiveConfirmationSource) => void;
  markFirstSynced: () => void;
  markFirstSyncFailed: () => void;
  /**
   * Reset to an idle (not-joined, not-reconnectable) state because the live
   * subscription was intentionally torn down (e.g. the sync lease was released
   * and the debounced room-leave fired). The tracker is reusable: a later
   * `attach()` clears this. Without it, `unsubscribe()` leaves the last status
   * (`'joined'`) in place, so the room keeps reporting `'synced'` forever.
   */
  markStopped: () => void;
  getSyncState: () => RoomSyncState;
  subscribeSyncState: (listener: (state: RoomSyncState) => void) => () => void;
  needsReconnect: () => boolean;
  hasReconnectSignal: (localReconnectActive: boolean) => boolean;
  dispose: () => void;
};

export function createRoomSyncTracker(roomId: string): RoomSyncTracker {
  let status: RepoTransportRoomStatus | null = null;
  let firstSynced = false;
  let initialSyncFailed = false;
  let disposed = false;
  // True after markStopped() until the next attach(): the live subscription was
  // intentionally torn down, so the room is idle (not joined, not reconnectable).
  let stopped = false;
  let activeSubscription: TrackedRoomSubscription | null = null;
  let firstSyncRecovery: Promise<void> | null = null;
  let detachStatusListener: (() => void) | null = null;
  let receiveConfirmed: boolean | null = null;
  let detachReceiveListener: (() => void) | null = null;
  const listeners = new Set<(state: RoomSyncState) => void>();

  const getSyncState = (): RoomSyncState => {
    if (disposed || stopped) {
      return 'idle';
    }
    // A detached binding means the transport is deliberately absent (signed
    // out, route pending) — idle, never a reconnectable problem.
    if (status === 'detached') {
      return 'idle';
    }
    if (status === 'joined') {
      if (firstSynced) {
        return receiveConfirmed === false ? 'syncing' : 'synced';
      }
      return initialSyncFailed ? 'error' : 'syncing';
    }
    if (status === 'reconnecting') {
      return 'reconnecting';
    }
    if (status === 'disconnected') {
      return 'disconnected';
    }
    if (status === 'error' || initialSyncFailed) {
      return 'error';
    }
    return 'connecting';
  };

  const emitSyncState = () => {
    const nextState = getSyncState();
    for (const listener of Array.from(listeners)) {
      listener(nextState);
    }
  };

  const retryFirstSyncAfterReconnect = (sub: TrackedRoomSubscription) => {
    if (firstSynced || firstSyncRecovery) {
      return;
    }

    initialSyncFailed = false;
    const recovery = sub.firstSyncedWithRemote
      .then(() => {
        if (disposed || activeSubscription !== sub) {
          return;
        }
        firstSynced = true;
        initialSyncFailed = false;
        emitSyncState();
      })
      .catch(() => {
        if (disposed || activeSubscription !== sub) {
          return;
        }
        initialSyncFailed = true;
        emitSyncState();
      })
      .finally(() => {
        if (firstSyncRecovery === recovery) {
          firstSyncRecovery = null;
        }
      });
    firstSyncRecovery = recovery;
  };

  const setStatus = (nextStatus: RepoTransportRoomStatus) => {
    status = nextStatus;
    if (nextStatus === 'joined') {
      if (firstSynced) {
        initialSyncFailed = false;
      } else if (initialSyncFailed && activeSubscription) {
        retryFirstSyncAfterReconnect(activeSubscription);
      }
    }
    emitSyncState();
  };

  const detachReceive = () => {
    detachReceiveListener?.();
    detachReceiveListener = null;
    receiveConfirmed = null;
  };

  const tracker: RoomSyncTracker = {
    roomId,
    attach: (sub, receive) => {
      stopped = false;
      detachStatusListener?.();
      detachReceive();
      activeSubscription = sub;
      if (receive) {
        receiveConfirmed = false;
        detachReceiveListener = receive((confirmed) => {
          if (receiveConfirmed === confirmed) return;
          receiveConfirmed = confirmed;
          emitSyncState();
        });
      }
      detachStatusListener = sub.onStatusChange(setStatus);
      // A binding emits its status when it attaches, which is before a join
      // resolves and hands it here. Adopt it, or a previous failed join's
      // status outlives the subscription that replaced it.
      setStatus(sub.status);
    },
    markFirstSynced: () => {
      stopped = false;
      firstSynced = true;
      initialSyncFailed = false;
      if (!status) {
        status = 'joined';
      }
      emitSyncState();
    },
    markFirstSyncFailed: () => {
      stopped = false;
      initialSyncFailed = true;
      if (!status) {
        status = 'error';
      }
      emitSyncState();
    },
    markStopped: () => {
      if (disposed) {
        return;
      }
      stopped = true;
      status = null;
      initialSyncFailed = false;
      firstSyncRecovery = null;
      detachStatusListener?.();
      detachStatusListener = null;
      detachReceive();
      activeSubscription = null;
      emitSyncState();
    },
    getSyncState,
    subscribeSyncState: (listener) => {
      listeners.add(listener);
      listener(getSyncState());
      return () => {
        listeners.delete(listener);
      };
    },
    needsReconnect: () =>
      !disposed &&
      !stopped &&
      status !== 'detached' &&
      (isTerminalRoomStatus(status) || (initialSyncFailed && !isReconnectStatus(status))),
    hasReconnectSignal: (localReconnectActive) =>
      !disposed &&
      (status === 'reconnecting' || (tracker.needsReconnect() && localReconnectActive)),
    dispose: () => {
      disposed = true;
      detachStatusListener?.();
      detachStatusListener = null;
      detachReceive();
      activeSubscription = null;
      emitSyncState();
      listeners.clear();
    },
  };

  return tracker;
}
