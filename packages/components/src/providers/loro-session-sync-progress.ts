import {
  createLoroSyncProgress,
  observeLoroBootstrap,
  type LoroTailDeadline,
  type SessionSyncProgress,
} from '@lody/shared';
import type { RoomSyncState } from '@/lib/room-sync-state';

type ReadTail = (signal: AbortSignal) => Promise<string | undefined>;

export function createLoroSessionSyncProgress(
  activeTransport: () => 'local' | 'cloud' | undefined,
  options: { tailDeadline?: LoroTailDeadline } = {}
) {
  let snapshot: SessionSyncProgress | null = null;
  let owner = activeTransport();
  const listeners = new Set<() => void>();
  const publish = (next: SessionSyncProgress | null) => {
    if (
      snapshot?.kind === next?.kind &&
      snapshot?.received === next?.received &&
      snapshot?.total === next?.total
    )
      return;
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Loro sync progress observer failed', error);
      }
    }
  };
  const stream = createLoroSyncProgress((value) => {
    if (activeTransport() === 'cloud') publish(value);
  }, options.tailDeadline);
  let state: RoomSyncState = 'idle';
  let lastOffset: string | undefined;
  let readTail: ReadTail | undefined;
  const refreshOwner = () => {
    const next = activeTransport();
    if (next !== owner) {
      owner = next;
      stream.clear();
      publish(null);
    }
    return next;
  };
  const catchingUp = () =>
    activeTransport() === 'cloud' &&
    ['idle', 'connecting', 'syncing', 'reconnecting'].includes(state);
  const discardCursor = () => {
    lastOffset = undefined;
    stream.clear();
  };
  const fetchBootstrap = observeLoroBootstrap(
    (input, init) => fetch(input, init),
    stream.beginBootstrap,
    discardCursor
  );

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    local(value: SessionSyncProgress | null) {
      if (refreshOwner() === 'local') publish(value);
    },
    loaded(offset: string | undefined, head: ReadTail) {
      refreshOwner();
      lastOffset = offset;
      readTail = head;
      if (offset !== undefined && catchingUp()) stream.catchUp(offset, head);
    },
    saved(offset: string) {
      lastOffset = offset;
      if (catchingUp()) stream.advance(offset);
    },
    fetch(input: string, init?: RequestInit) {
      refreshOwner();
      if (!catchingUp()) {
        // A synced room can still lose its cursor; forget it so a later
        // reconnect does not measure catch-up from the retired offset.
        const retired = init?.method === 'GET' && new URL(input).searchParams.has('offset');
        return fetch(input, init).then((response) => {
          if (retired && response.status === 410) discardCursor();
          return response;
        });
      }
      if (init?.method === 'GET' && readTail) {
        const parameters = new URL(input).searchParams;
        const offset = parameters.get('offset');
        if (offset !== null && !parameters.has('live')) stream.catchUp(offset, readTail);
      }
      return fetchBootstrap(input, init);
    },
    updateState(next: RoomSyncState) {
      const previous = state;
      state = next;
      const transport = refreshOwner();
      if (
        transport === 'cloud' &&
        (next === 'synced' || next === 'disconnected' || next === 'error')
      ) {
        stream.clear();
      } else if (
        transport === 'cloud' &&
        next === 'reconnecting' &&
        previous !== next &&
        readTail &&
        lastOffset !== undefined
      ) {
        stream.clear();
        stream.catchUp(lastOffset, readTail);
      }
    },
    /** Hides progress without touching `state`: that mirrors the room tracker,
     *  which keeps a released-but-still-joined room synced until it stops. */
    clear() {
      stream.clear();
      publish(null);
    },
  };
}

export type LoroSessionSyncProgress = ReturnType<typeof createLoroSessionSyncProgress>;
