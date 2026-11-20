import {
  createTodayPageUndo,
  openTodayOutline,
  parseTodayDocId,
  type TodayDate,
  type TodayOutline,
  type TodayPageSnapshot,
  type TodayPageUndo,
} from '@lody/shared';
import type { LoroDoc } from 'loro-crdt';

/**
 * One open Today page: its outline model, undo, and the rule that viewing a
 * day never creates it remotely. The room is joined only once the page is
 * registered (by this client's first local commit or by a peer), so opening an
 * empty day creates no server stream. Registration and joining are idempotent
 * and retried on the next local commit after a failure.
 * Behavior: specs/today-outline.md (Page stream and dates, Data ownership).
 */
export type TodayPageStore = {
  readonly docId: string;
  readonly userId: string;
  readonly date: TodayDate;
  readonly outline: TodayOutline;
  readonly undo: TodayPageUndo;
  /** Resolves once the page's room has synced with a peer; never while unregistered. */
  readonly synced: Promise<void>;
  getSnapshot(): TodayPageSnapshot;
  subscribe(listener: () => void): () => void;
  /** A peer registered this page: join its room. */
  markRegistered(): void;
  dispose(): void;
};

type RoomSubscription = { unsubscribe(): void };

export function createTodayPageStore(options: {
  docId: string;
  doc: LoroDoc;
  registered: boolean;
  join: () => Promise<RoomSubscription | null | undefined>;
  register: (meta: { userId: string; date: TodayDate }) => Promise<void>;
  setTimer: (callback: () => void, ms: number) => () => void;
  onBackgroundError?: (stage: 'register' | 'join', error: unknown) => void;
}): TodayPageStore {
  const identity = parseTodayDocId(options.docId);
  if (!identity) throw new Error('Not a Today page id');
  const { doc } = options;
  const outline = openTodayOutline(doc);
  const undo = createTodayPageUndo(doc, { setTimer: options.setTimer });
  const listeners = new Set<() => void>();
  let snapshot = outline.getSnapshot();
  let disposed = false;
  let registered = options.registered;
  let registering: Promise<void> | undefined;
  let joining: Promise<void> | undefined;
  let room: RoomSubscription | undefined;
  let markSynced: () => void = () => {};
  const synced = new Promise<void>((resolve) => {
    markSynced = resolve;
  });

  const ensureJoined = () => {
    if (disposed || room || joining) return;
    joining = options
      .join()
      .then((subscription) => {
        if (!subscription) return;
        if (disposed) subscription.unsubscribe();
        else {
          room = subscription;
          markSynced();
        }
      })
      .catch((error: unknown) => options.onBackgroundError?.('join', error))
      .finally(() => {
        joining = undefined;
      });
  };

  const ensureRegistered = () => {
    if (disposed || registered || registering) return;
    registering = options
      .register({ userId: identity.userId, date: identity.date })
      .then(() => {
        registered = true;
        ensureJoined();
      })
      .catch((error: unknown) => options.onBackgroundError?.('register', error))
      .finally(() => {
        registering = undefined;
      });
  };

  const unsubscribeDoc = doc.subscribe(() => {
    snapshot = outline.getSnapshot();
    for (const listener of listeners) listener();
  });
  const unsubscribeLocal = doc.subscribeLocalUpdates(() => {
    if (registered) ensureJoined();
    else ensureRegistered();
  });
  if (registered) ensureJoined();

  return {
    docId: options.docId,
    userId: identity.userId,
    date: identity.date,
    outline,
    undo,
    synced,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    markRegistered: () => {
      registered = true;
      ensureJoined();
    },
    dispose: () => {
      disposed = true;
      unsubscribeDoc();
      unsubscribeLocal();
      undo.dispose();
      room?.unsubscribe();
      room = undefined;
      listeners.clear();
    },
  };
}
