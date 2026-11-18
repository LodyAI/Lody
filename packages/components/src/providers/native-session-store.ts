import type {
  MessageQueueItem,
  MessageQueueItemInput,
  SessionId,
  SessionHistory,
} from '@lody/shared';
import type {
  NativeSessionDomainTransport,
  NativeSessionFrontiers,
} from '@lody/shared/native-session-domain';
import type { SessionDocState, SessionDocStore } from '../atoms/runtime';
import { createConversationViewFromReader } from '../lib/conversation-view/create-conversation-view-from-reader';
import {
  createNativeSessionIpcSource,
  NativeSessionSourceError,
  type NativeSessionIpcSource,
} from './native-session-ipc';

/** Explicit producer intents. Native stores reject arbitrary control drafts. */
export type NativeSessionRendererCommands = {
  recordHumanInputReceipt(inputId: string, userId: string): Promise<void>;
  dispatchUserTurn(turn: SessionHistory): Promise<void>;
  enqueue(item: MessageQueueItemInput): Promise<NativeSessionFrontiers>;
  remove(cid: string): Promise<NativeSessionFrontiers>;
  update(cid: string, patch: Partial<MessageQueueItem>): Promise<NativeSessionFrontiers>;
  reorder(cids: readonly string[]): Promise<NativeSessionFrontiers>;
  cancel(id: string, turnId: string): Promise<void>;
};
export async function createNativeSessionDocStore(
  source: NativeSessionIpcSource,
  principalId: string
): Promise<SessionDocStore> {
  await source.ready;
  const history = createConversationViewFromReader(source.sessionData.history, {
    sessionId: source.sessionData.sessionId,
  });
  let disposed = false;
  const openedAt = Date.now();
  const empty = Object.freeze({
    session: { id: source.sessionData.sessionId },
    mq: [],
  }) as unknown as SessionDocState;
  const state = () => {
    const value = source.getSnapshot();
    if (!value) return empty;
    return value as SessionDocState;
  };
  const nativeBody: NativeSessionRendererCommands = {
    async recordHumanInputReceipt(inputId, userId) {
      if (userId !== principalId) throw new NativeSessionSourceError('access_denied');
      await source.execute({ kind: 'humanReceipt', inputId });
    },
    dispatchUserTurn: async (turn) => {
      await source.execute({ kind: 'dispatchUserTurn', turn });
    },
    enqueue: (item) => source.execute({ kind: 'queuePush', item }),
    remove: (cid) => source.execute({ kind: 'queueRemove', cid }),
    update: (cid, patch) => source.execute({ kind: 'queueUpdate', cid, patch }),
    reorder: (cids) => source.execute({ kind: 'queueReorder', cids }),
    cancel: (id, turnId) => source.execute({ kind: 'cancel', id, turnId }),
  };
  return {
    sessionId: source.sessionData.sessionId,
    roomId: `session-${source.sessionData.sessionId}`,
    historyBackend: 'loro',
    doc: undefined,
    nativeBody,
    firstSynced: source.ready,
    acquireSync: () => () => {},
    getSyncState: () => (source.available ? 'synced' : 'error'),
    subscribeSyncState: (listener) =>
      source.subscribe(() => listener(source.available ? 'synced' : 'error')),
    getState: state,
    setState() {
      throw new Error('Native Session requires an explicit domain command');
    },
    subscribe: (listener) => source.subscribe(() => listener(state())),
    history,
    sessionData: source.sessionData,
    // The surrounding source owner retains and awaits the actual cleanup receipt.
    // This synchronous view release cannot turn a lost remote ACK into success.
    dispose() {
      if (disposed) return;
      disposed = true;
      history.dispose();
    },
    async waitUntilSynced(signal) {
      signal?.throwIfAborted();
      await source.read({ kind: 'flush' });
      signal?.throwIfAborted();
    },
    inspectSync: async () => ({
      transportId: 'local-native-session',
      bindingStatus: source.available ? 'connected' : 'unavailable',
      syncState: source.available ? 'synced' : 'error',
      openedAt,
      lastRemoteImportAt: null,
      pendingUploadProbe: null,
    }),
  };
}
/** A workspace owner keeps failed/pending exact-room cleanup after the display
 * cache drops its view. Reopening that room waits for its real release receipt;
 * independent Session rooms remain usable. */
export function createNativeSessionStoreOwner(options: {
  readonly registrationId: string;
  readonly principalId: string;
  readonly transport: NativeSessionDomainTransport;
  requestId(): string;
  route(sessionId: SessionId): Promise<'legacy' | 'frozen' | 'native'>;
  onFailure?(error: unknown): void;
}) {
  const sources = new Map<
    SessionId,
    {
      source: NativeSessionIpcSource;
      store?: SessionDocStore;
      opening?: Promise<SessionDocStore>;
      retiring: boolean;
    }
  >();
  let closed = false;
  const route = async (sessionId: SessionId) => {
    if (closed) throw new NativeSessionSourceError('restart_required');
    const value = await options.route(sessionId);
    if (closed) throw new NativeSessionSourceError('restart_required');
    return value;
  };
  const closeRoom = async (sessionId: SessionId) => {
    const entry = sources.get(sessionId);
    if (!entry) return;
    entry.retiring = true;
    entry.store?.dispose();
    await entry.source.close();
    if (sources.get(sessionId) === entry) sources.delete(sessionId);
  };
  return {
    async open(sessionId: SessionId): Promise<SessionDocStore | undefined> {
      if (closed) throw new NativeSessionSourceError('restart_required');
      const selected = await route(sessionId);
      if (closed) throw new NativeSessionSourceError('restart_required');
      const prior = sources.get(sessionId);
      if (prior) {
        if (selected === 'native' && !prior.retiring) {
          if (prior.store) {
            if (!prior.source.available) await prior.source.reacquire();
            return prior.store;
          }
          if (prior.opening) return prior.opening;
        }
        await closeRoom(sessionId);
      }
      if (selected === 'legacy') return undefined;
      if (selected !== 'native') throw new NativeSessionSourceError('restart_required');
      const source = createNativeSessionIpcSource({
        ...options,
        sessionId,
        requestId: options.requestId(),
      });
      const entry = {
        source,
        store: undefined as SessionDocStore | undefined,
        opening: undefined as Promise<SessionDocStore> | undefined,
        retiring: false,
      };
      sources.set(sessionId, entry);
      const opening = (async () => {
        try {
          const store = await createNativeSessionDocStore(source, options.principalId);
          if (closed || entry.retiring || sources.get(sessionId) !== entry)
            throw new NativeSessionSourceError('restart_required');
          entry.store = store;
          return store;
        } catch (error) {
          entry.retiring = true;
          try {
            await closeRoom(sessionId);
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              'Native Session acquisition cleanup unconfirmed'
            );
          }
          throw error;
        }
      })();
      entry.opening = opening;
      return opening;
    },
    route,
    owns(sessionId: SessionId) {
      return sources.has(sessionId);
    },
    closeRoom,
    async close() {
      closed = true;
      const result = await Promise.allSettled([...sources.keys()].map(closeRoom));
      const failures = result.flatMap((value) =>
        value.status === 'rejected' ? [value.reason] : []
      );
      if (failures.length)
        throw new AggregateError(failures, 'Native Session sources cleanup unconfirmed');
    },
  };
}
