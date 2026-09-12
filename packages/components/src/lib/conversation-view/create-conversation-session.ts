import {
  createHistoryWriter,
  createSessionMirror,
  type SessionHistory,
  type SessionId,
} from '@lody/shared';
import { createLoroSessionData } from '@lody/shared/session-data';
import type { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { createControlPlaneDoc } from './control-plane-doc';
import { CONTROL_PLANE_IGNORED_ROOT_KEYS, sessionControlPlaneSchema } from './control-plane-schema';
import type { CreateConversationViewFromDocOptions } from './create-conversation-view-from-doc';
import { createConversationViewFromHistory } from './create-conversation-view-from-history';
import { createConversationViewFromReader } from './create-conversation-view-from-reader';

/** The switch changes readers only. Both modes use the shared history writer. */
export function createConversationSession(
  doc: LoroDoc,
  options: CreateConversationViewFromDocOptions & {
    windowed: boolean;
    sessionId: SessionId;
    /**
     * Local persistence barrier for this doc (the renderer passes `repo.flush`).
     * Omitting it declares the store has no local durability, so `waitDurable`
     * rejects instead of treating local acceptance as persistence.
     */
    durable?: () => Promise<void>;
  }
) {
  const durability = options.durable
    ? ({ durable: options.durable } as const)
    : ({ durability: 'unavailable' } as const);
  if (!options.windowed) {
    const mirror = createSessionMirror({
      doc,
      initialState: { session: { id: options.sessionId }, history: [] },
    });
    const history = createConversationViewFromHistory({
      sessionId: options.sessionId,
      getHistory: () => mirror.getState().history as unknown as SessionHistory[],
      subscribe: (listener) => mirror.subscribe(() => listener()),
    });
    const sessionData = createLoroSessionData({
      sessionId: options.sessionId,
      doc,
      writer: mirror.historyWriter,
      ...durability,
    });
    return {
      mirror,
      history,
      historyWriter: mirror.historyWriter,
      sessionData,
      dispose: () => {
        sessionData.snapshots.closeSource();
        history.dispose();
        mirror.dispose();
      },
    };
  }
  const mirror = new Mirror({
    doc: createControlPlaneDoc(doc, { ignoredRootKeys: CONTROL_PLANE_IGNORED_ROOT_KEYS }),
    schema: sessionControlPlaneSchema,
    ignoreUnknownProperties: true,
    validateUpdates: false,
    initialState: { session: { id: options.sessionId } },
  });
  // No full-history reader callback: local commands read their target directly.
  const historyWriter = createHistoryWriter(doc);
  const sessionData = createLoroSessionData({
    sessionId: options.sessionId,
    doc,
    writer: historyWriter,
    ...durability,
  });
  // The display cache reads through the CRDT-neutral session-data port, not
  // the raw doc; the raw `createConversationViewFromDoc` remains only for the
  // non-windowed/rollback path.
  const history = createConversationViewFromReader(sessionData.history, options);
  return {
    mirror,
    history,
    historyWriter,
    sessionData,
    dispose: () => {
      sessionData.snapshots.closeSource();
      history.dispose();
      mirror.dispose();
    },
  };
}
