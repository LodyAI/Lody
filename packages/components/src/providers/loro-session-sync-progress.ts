import {
  createLoroSyncProgress,
  createSessionSyncProgressStore,
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
  const store = createSessionSyncProgressStore('Loro sync progress observer');
  const publish = store.publish;
  let owner = activeTransport();
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
    ...store.view,
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
    clear() {
      stream.clear();
      publish(null);
    },
  };
}

export type LoroSessionSyncProgress = ReturnType<typeof createLoroSessionSyncProgress>;
