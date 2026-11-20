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
 * registered (by this client's first content or by a peer), so opening an
 * empty day creates no server stream.
 *
 * Registration and joining follow the session rooms: a join that produced a
 * subscription keeps it (the SDK heals it, even when its first sync failed);
 * a step that failed outright retries with backoff while the page is open.
 * A local edit retries a failed registration (a local write) at once, but
 * never cuts a join's backoff short: typing must not hammer a failing
 * backend. A page opened with local content that
 * never got registered registers then, so a failed registration cannot leave
 * notes local-only.
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

/**
 * A joined room. `synced` resolves once the room has synced with a peer: at
 * once for a normal join, later for a subscription whose first sync failed
 * and that healed inside the SDK; never if it does not.
 */
export type TodayRoomJoin = { room: RoomSubscription; synced: Promise<void> };

export function createTodayPageStore(options: {
  docId: string;
  doc: LoroDoc;
  registered: boolean;
  /**
   * Join the page's room; `signal` aborts when the page is released. Rejects
   * only when no subscription was produced.
   */
  join: (signal: AbortSignal) => Promise<TodayRoomJoin | null | undefined>;
  register: (meta: { userId: string; date: TodayDate }) => Promise<void>;
  setTimer: (callback: () => void, ms: number) => () => void;
  /** Backoff before retry number `attempt` (0-based) of a failed register or join. */
  retryDelayMs: (attempt: number) => number;
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
  const releaseSignal = new AbortController();
  let registered = options.registered;
  let registering: Promise<void> | undefined;
  let joining: Promise<void> | undefined;
  let room: RoomSubscription | undefined;
  let failures = 0;
  let cancelRetry: (() => void) | undefined;
  let retryStage: 'register' | 'join' | undefined;
  let markSynced: () => void = () => {};
  const synced = new Promise<void>((resolve) => {
    markSynced = resolve;
  });

  const clearRetry = () => {
    cancelRetry?.();
    cancelRetry = undefined;
    retryStage = undefined;
  };
  // One pending retry at a time; it re-runs whichever step is still missing.
  const retryLater = (stage: 'register' | 'join', error: unknown) => {
    options.onBackgroundError?.(stage, error);
    if (disposed || cancelRetry) return;
    const delay = options.retryDelayMs(failures);
    failures += 1;
    retryStage = stage;
    cancelRetry = options.setTimer(() => {
      cancelRetry = undefined;
      retryStage = undefined;
      advance();
    }, delay);
  };

  const ensureJoined = () => {
    if (disposed || room || joining) return;
    joining = options
      .join(releaseSignal.signal)
      .then((joined) => {
        if (!joined) return;
        if (disposed) {
          joined.room.unsubscribe();
          return;
        }
        room = joined.room;
        failures = 0;
        void joined.synced.then(() => {
          if (!disposed) markSynced();
        });
      })
      .catch((error: unknown) => retryLater('join', error))
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
        failures = 0;
        ensureJoined();
      })
      .catch((error: unknown) => retryLater('register', error))
      .finally(() => {
        registering = undefined;
      });
  };

  /**
   * Take the next missing step. Unregistered pages register only once they
   * hold content: an empty line (a click on the empty day) is not yet input.
   */
  function advance() {
    if (disposed) return;
    if (registered) ensureJoined();
    else if (!outline.getSnapshot().isEmpty) ensureRegistered();
  }

  const refresh = () => {
    snapshot = outline.getSnapshot();
    for (const listener of listeners) listener();
  };
  const unsubscribeDoc = doc.subscribe(refresh);
  // A fold this viewer kept while a peer changed it can be rewritten to the
  // document's value without a document change.
  const unsubscribeView = outline.onViewChange(refresh);
  const unsubscribeLocal = doc.subscribeLocalUpdates(() => {
    // A join waits out its backoff; a registration retries on the edit.
    if (retryStage === 'join') return;
    clearRetry();
    advance();
  });
  advance();

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
      clearRetry();
      ensureJoined();
    },
    dispose: () => {
      disposed = true;
      clearRetry();
      releaseSignal.abort();
      unsubscribeDoc();
      unsubscribeView();
      outline.dispose();
      unsubscribeLocal();
      undo.dispose();
      room?.unsubscribe();
      room = undefined;
      listeners.clear();
    },
  };
}
