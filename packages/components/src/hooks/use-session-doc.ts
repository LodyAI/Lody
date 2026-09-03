import { useCallback, useEffect, useMemo, useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import {
  getServerNow,
  normalizeSessionTurnInputConfig,
  type MessageQueueItem,
  type MessageQueueItemInput,
} from '@lody/shared';
import type { SessionHistory, SessionHistoryInput, SessionId, SessionMeta } from '@lody/shared';
import { v4 as uuidv4 } from 'uuid';
import { useAtomValue } from 'jotai';
import {
  activeWorkspaceRuntimeAtom,
  type SessionDocInput,
  type SessionDocState,
  type SessionDocStore,
} from '@/atoms/runtime';
import { browserOnlineAtom } from '@/atoms/control-connection';
import type { ConversationView } from '@/lib/conversation-view';
import type { RoomSyncState } from '@/lib/room-sync-state';
import { subscribeLatestOnAnimationFrame } from '@/lib/latest-frame-subscription';
import { readSessionHistoryEntry, readSessionHistoryLength } from '@/lib/session-store-history';
import { readSessionDocHistoryRevision } from '@/providers/session-doc-state-source';

declare global {
  interface Window {
    currentMirror?: () => SessionDocState;
    currentSessionDoc?: unknown;
    sessionState?: SessionDocState;
  }
}

export type PushMessageQueueInput = Omit<
  MessageQueueItemInput,
  '$cid' | 'timestamp' | 'userTurnId' | 'isEditing' | 'editingStartedAt'
> & {
  isEditing?: boolean;
  editingStartedAt?: number;
  timestamp?: string;
  userTurnId?: string;
};

export type UseSessionDocResult = {
  doc: SessionDocState;
  /**
   * Windowed history reader for this session, once the store is loaded and
   * the store runs on the control-plane Mirror; `null` on the full-Mirror
   * rollback path. Prefer it over `doc.history`, which on the view path is a
   * lazy bridge that materializes the whole transcript on first access.
   */
  conversationView: ConversationView | null;
  addHistory: (
    history: Omit<SessionHistoryInput, 'id'> & { id?: string },
    options?: { dispatch?: boolean }
  ) => Promise<{ entry: SessionHistory }>;
  pushMessageQueue: (item: PushMessageQueueInput) => Promise<void>;
  removeMessageQueueItem: (cid: string) => Promise<void>;
  updateMessageQueueItem: (
    cid: string,
    updater: (item: MessageQueueItem) => MessageQueueItem
  ) => Promise<void>;
  reorderMessageQueueItem: (activeCid: string, overCid: string) => Promise<void>;
  updateHistoryEntry: (
    historyId: string,
    updater: (entry: SessionHistoryInput) => SessionHistoryInput
  ) => Promise<void>;
  /** Resolves when all pending local CRDT changes have been flushed to the server. */
  waitUntilSynced: () => Promise<void>;
  ready: boolean;
  synced: boolean;
  /** Raw room sync state; `synced` collapses this + browser online into a boolean. */
  syncState: RoomSyncState;
};

export type UseSessionDocOptions = {
  enabled?: boolean;
  syncEnabled?: boolean;
};

export type UseSessionDocSyncStateResult = {
  ready: boolean;
  synced: boolean;
  syncState: RoomSyncState;
  hasLocalHistory: boolean;
};

type SessionHistoryHint = Pick<
  SessionMeta,
  'lastMessageAt' | 'latestUserMsgId' | 'lastHandledUserMsgId' | 'processingUserMsgId'
>;

export function sessionMetaSuggestsHistory(session: SessionHistoryHint | null | undefined) {
  return Boolean(
    session?.latestUserMsgId ||
    session?.lastHandledUserMsgId ||
    session?.processingUserMsgId ||
    typeof session?.lastMessageAt === 'number'
  );
}

// Compared through the revision marker, never `history` itself: on the view
// path that property is a getter whose first read hydrates the transcript.
const updateOnlyChangesHistory = (
  previous: SessionDocState | undefined,
  next: SessionDocState
): boolean =>
  previous !== undefined &&
  readSessionDocHistoryRevision(previous) !== readSessionDocHistoryRevision(next) &&
  previous.session === next.session &&
  previous.mq === next.mq &&
  previous.forkOperation === next.forkOperation &&
  previous.preview === next.preview &&
  previous.externalHistoryCursor === next.externalHistoryCursor &&
  previous.acpRuntimeConfig === next.acpRuntimeConfig;

export function useSessionDoc(
  sessionId: SessionId,
  options: UseSessionDocOptions = {}
): UseSessionDocResult {
  const enabled = options.enabled ?? true;
  const syncEnabled = options.syncEnabled ?? enabled;
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const browserOnline = useAtomValue(browserOnlineAtom);
  const [loadedStore, setLoadedStore] = useState<SessionDocStore | null>(null);
  const [ready, setReady] = useState(false);
  const [syncState, setSyncState] = useState<RoomSyncState>('idle');
  const fallbackDoc = useMemo<SessionDocInput>(
    () => ({
      session: { id: sessionId },
      history: [],
      mq: [],
      forkOperation: undefined,
      preview: undefined,
      externalHistoryCursor: undefined,
      acpRuntimeConfig: undefined,
    }),
    [sessionId]
  );
  const [state, setState] = useState<SessionDocState>(fallbackDoc as SessionDocState);
  useEffect(() => {
    let cancelled = false;
    let acquiredStore = false;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeSyncState: (() => void) | null = null;
    // Dev-only debug globals would pin the doc in production; track what this
    // effect instance published so cleanup only clears its own values.
    let debugStore: SessionDocStore | null = null;
    let debugSessionState: SessionDocState | null = null;
    setReady(false);
    setSyncState('idle');
    setState(fallbackDoc as SessionDocState);

    if (!enabled) {
      setLoadedStore(null);
      return () => {
        // no-op
      };
    }

    if (!runtime) {
      setLoadedStore(null);
      return () => {
        // no-op
      };
    }

    void (async () => {
      try {
        const store = await runtime.acquireSessionStore(sessionId);
        acquiredStore = true;
        if (cancelled) {
          runtime.releaseSessionStoreRef(sessionId);
          acquiredStore = false;
          return;
        }
        if (import.meta.env.DEV) {
          debugStore = store;
          window.currentSessionDoc = store.doc;
          window.currentMirror = () => store.getState();
        }
        setLoadedStore(store);
        const initialState = store.getState();
        const initialSyncState = store.getSyncState();
        setState(initialState);
        setSyncState(initialSyncState);
        setReady(true);
        unsubscribeSyncState = store.subscribeSyncState((nextState) => {
          if (!cancelled) {
            setSyncState((prev) => (prev === nextState ? prev : nextState));
          }
        });
        unsubscribe = subscribeLatestOnAnimationFrame<SessionDocState>({
          subscribe: (listener) => store.subscribe(listener),
          initialValue: initialState,
          shouldDefer: updateOnlyChangesHistory,
          onValue: (nextState) => {
            if (cancelled) return;
            setState((prev) => (prev === nextState ? prev : nextState));
            if (import.meta.env.DEV) {
              debugSessionState = nextState;
              window.sessionState = nextState;
            }
          },
        });
      } catch (error) {
        console.error('Failed to load session doc', { sessionId, error });
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) {
        unsubscribe();
      }
      if (unsubscribeSyncState) {
        unsubscribeSyncState();
      }
      if (import.meta.env.DEV) {
        // Identity-checked clears: a newer session's effect may already have
        // repointed these globals; never clobber that, but never leave a stale
        // doc pinned either.
        if (debugStore && window.currentSessionDoc === debugStore.doc) {
          window.currentSessionDoc = undefined;
          window.currentMirror = undefined;
        }
        if (debugSessionState && window.sessionState === debugSessionState) {
          window.sessionState = undefined;
        }
      }
      setLoadedStore(null);
      if (acquiredStore) {
        runtime.releaseSessionStoreRef(sessionId);
      }
    };
  }, [enabled, fallbackDoc, runtime, sessionId]);

  useEffect(() => {
    if (!enabled || !syncEnabled || !loadedStore) {
      return undefined;
    }
    return loadedStore.acquireSync();
  }, [enabled, loadedStore, syncEnabled]);

  const withStore = useCallback(
    async <T>(fn: (store: SessionDocStore) => Promise<T> | T): Promise<T> => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      // Always go through the ref-counted runtime helper. Do not shortcut via a
      // locally cached store: in-flight async callbacks can outlive unmount, at
      // which point the effect's ref is already released and the store may be
      // disposed + unloaded under us.
      return runtime.withSessionStore(sessionId, fn);
    },
    [runtime, sessionId]
  );

  const addHistory = useCallback(
    async (
      item: Omit<SessionHistoryInput, 'id'> & { id?: string },
      writeOptions?: { dispatch?: boolean }
    ) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const entry = { ...item, id: item.id ?? uuidv4() } as SessionHistory;
      if (writeOptions?.dispatch) {
        const inputConfig = normalizeSessionTurnInputConfig(entry.inputConfig);
        const userId = entry.userId?.trim();
        const timestamp = entry.timestamp?.trim();
        if (!userId || !timestamp || !inputConfig) {
          throw new Error(`Cannot dispatch invalid user history entry (sessionId=${sessionId})`);
        }
        await runtime.writer.appendSessionTurn(
          sessionId,
          entry as unknown as Record<string, unknown>,
          {
            userTurnId: entry.id,
            userId,
            timestamp,
            inputConfig: inputConfig as unknown as Record<string, unknown>,
          }
        );
      } else {
        await runtime.writer.appendSessionHistory(
          sessionId,
          entry as unknown as Record<string, unknown>
        );
      }
      return { entry };
    },
    [runtime, sessionId]
  );

  const pushMessageQueue = useCallback(
    async (item: PushMessageQueueInput) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const entry: Omit<MessageQueueItemInput, '$cid' | 'timestamp' | 'isEditing'> & {
        isEditing: boolean;
        timestamp: string;
      } = {
        ...item,
        isEditing: item.isEditing ?? false,
        editingStartedAt: item.editingStartedAt,
        userTurnId: item.userTurnId ?? undefined,
        timestamp: item.timestamp ?? new Date(getServerNow()).toISOString(),
      };

      await runtime.writer.enqueueSessionMessage(
        sessionId,
        entry as unknown as Record<string, unknown>
      );
    },
    [runtime, sessionId]
  );

  const removeMessageQueueItem = useCallback(
    async (cid: string) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      await runtime.writer.removeSessionMessage(sessionId, cid);
    },
    [runtime, sessionId]
  );

  const updateMessageQueueItem = useCallback(
    async (cid: string, updater: (item: MessageQueueItem) => MessageQueueItem) => {
      // Updaters may return the same reference to signal a no-op; in that case we
      // skip the CRDT write AND the messageQueueUpdatedAt bump so the dispatch
      // watcher isn't woken for a write that didn't change anything. The updater
      // is a function that can't cross the intent wire, so we apply it against the
      // current snapshot renderer-side and send the resulting full item as a
      // replacement patch.
      const mq = await withStore((store) => (store.getState().mq ?? []) as MessageQueueItem[]);
      const idx = mq.findIndex((item) => item.$cid === cid);
      if (idx < 0) {
        return;
      }
      const current = mq[idx] as MessageQueueItem;
      const next = updater(current);
      if (next === current) {
        return;
      }
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      await runtime.writer.updateSessionMessage(
        sessionId,
        cid,
        next as unknown as Record<string, unknown>
      );
    },
    [withStore, runtime, sessionId]
  );

  const reorderMessageQueueItem = useCallback(
    async (activeCid: string, overCid: string) => {
      if (activeCid === overCid) {
        return;
      }
      const mq = await withStore((store) => (store.getState().mq ?? []) as MessageQueueItem[]);
      const fromIndex = mq.findIndex((item) => item.$cid === activeCid);
      const toIndex = mq.findIndex((item) => item.$cid === overCid);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
        return;
      }
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      // Full-order is idempotent and robust across the intent wire; compute the
      // resulting `$cid` order renderer-side.
      const orderedItemIds = arrayMove(mq, fromIndex, toIndex).map((item) => item.$cid);
      await runtime.writer.reorderSessionMessages(sessionId, orderedItemIds);
    },
    [withStore, runtime, sessionId]
  );

  const updateHistoryEntry = useCallback(
    async (historyId: string, updater: (entry: SessionHistoryInput) => SessionHistoryInput) => {
      // The updater is a function that can't cross the intent wire; resolve it to
      // the concrete replacement entry against the current snapshot and send that
      // through the writer seam. Preserve the "not found → no-op" short-circuit.
      const current = await withStore((store) => readSessionHistoryEntry(store, historyId));
      if (!current) {
        return;
      }
      const nextEntry = updater(current as SessionHistoryInput);
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      await runtime.writer.updateSessionHistory(
        sessionId,
        historyId,
        nextEntry as unknown as Record<string, unknown>
      );
    },
    [withStore, runtime, sessionId]
  );

  const waitUntilSynced = useCallback(async () => {
    await withStore((store) => store.waitUntilSynced());
  }, [withStore]);

  return {
    doc: state,
    conversationView: loadedStore?.conversationView ?? null,
    addHistory,
    pushMessageQueue,
    removeMessageQueueItem,
    updateMessageQueueItem,
    reorderMessageQueueItem,
    updateHistoryEntry,
    waitUntilSynced,
    ready,
    synced: browserOnline && syncState === 'synced',
    syncState,
  };
}

export function useSessionDocSyncState(
  sessionId: SessionId,
  options: UseSessionDocOptions = {}
): UseSessionDocSyncStateResult {
  const enabled = options.enabled ?? true;
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const browserOnline = useAtomValue(browserOnlineAtom);
  const [ready, setReady] = useState(false);
  const [syncState, setSyncState] = useState<RoomSyncState>('idle');
  const [hasLocalHistory, setHasLocalHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let acquiredStore = false;
    let releaseSync: (() => void) | null = null;
    let unsubscribeStore: (() => void) | null = null;
    let unsubscribeSyncState: (() => void) | null = null;
    setReady(false);
    setSyncState('idle');
    setHasLocalHistory(false);

    if (!enabled || !runtime) {
      return () => {
        // no-op
      };
    }

    void (async () => {
      try {
        const store = await runtime.acquireSessionStore(sessionId);
        acquiredStore = true;
        if (cancelled) {
          runtime.releaseSessionStoreRef(sessionId);
          acquiredStore = false;
          return;
        }

        const readHasLocalHistory = () => readSessionHistoryLength(store) > 0;
        setHasLocalHistory(readHasLocalHistory());
        setSyncState(store.getSyncState());
        setReady(true);
        releaseSync = store.acquireSync();
        unsubscribeStore = store.subscribe(() => {
          if (!cancelled) {
            const nextHasLocalHistory = readHasLocalHistory();
            setHasLocalHistory((prev) =>
              prev === nextHasLocalHistory ? prev : nextHasLocalHistory
            );
          }
        });
        unsubscribeSyncState = store.subscribeSyncState((nextState) => {
          if (!cancelled) {
            setSyncState((prev) => (prev === nextState ? prev : nextState));
          }
        });
      } catch (error) {
        console.error('Failed to load session doc sync state', { sessionId, error });
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribeSyncState) {
        unsubscribeSyncState();
      }
      if (unsubscribeStore) {
        unsubscribeStore();
      }
      if (releaseSync) {
        releaseSync();
      }
      if (acquiredStore) {
        runtime.releaseSessionStoreRef(sessionId);
      }
    };
  }, [enabled, runtime, sessionId]);

  return {
    ready,
    syncState,
    synced: browserOnline && syncState === 'synced',
    hasLocalHistory,
  };
}
