import { Mirror } from 'loro-mirror';
import type { LoroDoc } from 'loro-crdt';
import { sessionDocSchema, type SessionId } from '@lody/shared';
import type { SessionDocState, SessionDocUpdater } from '../atoms/runtime';
import {
  createConversationViewFromDoc,
  createSessionControlMirror,
  type ConversationView,
} from '../lib/conversation-view';

/**
 * The part of a `SessionDocStore` that turns a Loro doc into React-readable
 * state: `getState` / `setState` / `subscribe`, plus the `ConversationView`
 * when history is read through it.
 *
 * Two compositions, selected once at store creation:
 *
 * - **full Mirror** (`conversationViewEnabled: false`): one `Mirror` over the
 *   whole `sessionDocSchema`, exactly what every client ran before. This is
 *   the rollback path and must stay byte-for-byte the old behavior.
 * - **control Mirror + view** (`conversationViewEnabled: true`): the Mirror is
 *   built with `sessionControlDocSchema`, so it never materializes history,
 *   and `history` on the returned state is a lazy getter over
 *   `conversationView.readAll()`. Readers that still take `doc.history` keep
 *   working and pay one incremental full read on first access instead of the
 *   Mirror init; readers on the view pay nothing. History WRITES must go
 *   through `lib/conversation-view/history-writer`: an ignored field is
 *   memory-only in loro-mirror, so a `setState` that reaches `history` would
 *   silently persist nothing. The guard below turns that into an error.
 */
export type SessionDocStateSource = {
  readonly conversationView: ConversationView | null;
  getState: () => SessionDocState;
  setState: (updater: SessionDocUpdater) => void;
  subscribe: (listener: (state: SessionDocState) => void) => () => void;
  dispose: () => void;
};

/**
 * Non-enumerable marker on a bridged state: the view version its `history`
 * getter is bound to. `use-session-doc.ts` compares this instead of touching
 * `history`, because reading the getter is what materializes the transcript.
 */
export const SESSION_DOC_HISTORY_REVISION: unique symbol = Symbol('sessionDocHistoryRevision');

type BridgedSessionDocState = SessionDocState & {
  readonly [SESSION_DOC_HISTORY_REVISION]?: number;
};

/**
 * What distinguishes two session-doc snapshots as far as history goes: the
 * bridged revision when present, else the `history` array identity the full
 * Mirror keeps stable across unrelated updates.
 */
export function readSessionDocHistoryRevision(state: SessionDocState): unknown {
  const revision = (state as BridgedSessionDocState)[SESSION_DOC_HISTORY_REVISION];
  return revision !== undefined ? revision : state.history;
}

export class SessionHistoryWriteThroughMirrorError extends Error {
  constructor() {
    super(
      'Session history cannot be written through setState while ConversationView is enabled: ' +
        'the control-plane Mirror ignores `history`, so the write would only change memory. ' +
        'Use appendHistoryEntry / replaceHistoryEntry / respondHistoryPermission from ' +
        '@/lib/conversation-view (WorkspaceWriter routes there).'
    );
    this.name = 'SessionHistoryWriteThroughMirrorError';
  }
}

const HISTORY_KEY = 'history';

/**
 * Wrap a mutable draft so any touch of `history` throws before loro-mirror can
 * swallow it. Reads throw too: `draft.history.push(...)` would otherwise fail
 * with an unrelated "cannot read property of undefined".
 */
const guardHistoryOnDraft = <T extends object>(draft: T): T =>
  new Proxy(draft, {
    get(target, property, receiver) {
      if (property === HISTORY_KEY) throw new SessionHistoryWriteThroughMirrorError();
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (property === HISTORY_KEY) throw new SessionHistoryWriteThroughMirrorError();
      return Reflect.set(target, property, value, receiver);
    },
    deleteProperty(target, property) {
      if (property === HISTORY_KEY) throw new SessionHistoryWriteThroughMirrorError();
      return Reflect.deleteProperty(target, property);
    },
  });

const touchesHistory = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && HISTORY_KEY in value;

/** Same own keys with identical values: the Mirror root did not change. */
const shallowEqualRoot = (left: object, right: object): boolean => {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(right, key) ||
      (left as Record<string, unknown>)[key] !== (right as Record<string, unknown>)[key]
    ) {
      return false;
    }
  }
  return true;
};

export function createSessionDocStateSource(options: {
  doc: LoroDoc;
  sessionId: SessionId;
  conversationViewEnabled: boolean;
}): SessionDocStateSource {
  const { doc, sessionId } = options;

  if (!options.conversationViewEnabled) {
    const mirror = new Mirror({
      doc,
      schema: sessionDocSchema,
      // Tolerate root keys written by peers running a newer schema version.
      ignoreUnknownProperties: true,
      // Plan is now stored per-turn on history entries, not at root level
      initialState: { session: { id: sessionId }, history: [] },
      debug: false,
    });
    return {
      conversationView: null,
      getState: () => mirror.getState(),
      setState: (updater) => {
        mirror.setState(updater as never);
      },
      subscribe: (listener) => mirror.subscribe(listener),
      dispose: () => {
        mirror.dispose();
      },
    };
  }

  const mirror = createSessionControlMirror(doc, sessionId);
  const view = createConversationViewFromDoc(doc, { sessionId });
  const listeners = new Set<(state: SessionDocState) => void>();

  // The Mirror notifies on every doc batch, including history-only ones its
  // control schema does not reflect. Only a root whose own values changed is
  // a control-plane change; the rest reuse the current control snapshot.
  let controlState: object = mirror.getState() as object;
  let cached: { control: object; version: number; value: SessionDocState } | null = null;

  const bridge = (control: object, version: number): SessionDocState => {
    const state = { ...(control as Record<string, unknown>) };
    let history: SessionDocState['history'] | undefined;
    Object.defineProperty(state, HISTORY_KEY, {
      enumerable: true,
      configurable: false,
      get: () => {
        // Bound once per snapshot: a held snapshot never changes underneath
        // its reader, and repeated access within a render is free.
        history ??= view.readAll() as SessionDocState['history'];
        return history;
      },
    });
    Object.defineProperty(state, SESSION_DOC_HISTORY_REVISION, {
      enumerable: false,
      configurable: false,
      value: version,
    });
    return state as unknown as SessionDocState;
  };

  const getState = (): SessionDocState => {
    const version = view.version;
    if (cached && cached.control === controlState && cached.version === version) {
      return cached.value;
    }
    const value = bridge(controlState, version);
    cached = { control: controlState, version, value };
    return value;
  };

  const notify = () => {
    const state = getState();
    for (const listener of listeners) listener(state);
  };

  const unsubscribeMirror = mirror.subscribe((next) => {
    if (shallowEqualRoot(controlState, next as object)) return;
    controlState = next as object;
    notify();
  });
  const unsubscribeView = view.subscribe(() => {
    notify();
  });

  return {
    conversationView: view,
    getState,
    setState: (updater) => {
      if (typeof updater !== 'function') {
        if (touchesHistory(updater)) throw new SessionHistoryWriteThroughMirrorError();
        mirror.setState(updater as never);
        return;
      }
      mirror.setState(((draft: object) => {
        const guarded = guardHistoryOnDraft(draft);
        const result = (updater as (state: object) => unknown)(guarded);
        // A mutative updater that returns its own draft is still mutative.
        if (result === undefined || result === guarded || result === draft) return undefined;
        if (touchesHistory(result)) throw new SessionHistoryWriteThroughMirrorError();
        return result;
      }) as never);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      unsubscribeMirror();
      unsubscribeView();
      listeners.clear();
      view.dispose();
      mirror.dispose();
    },
  };
}
