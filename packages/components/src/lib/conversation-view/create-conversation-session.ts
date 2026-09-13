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
import type { CreateConversationViewFromReaderOptions } from './create-conversation-view-from-reader';
import { createConversationViewFromHistory } from './create-conversation-view-from-history';
import { createConversationViewFromReader } from './create-conversation-view-from-reader';

/** The switch changes readers only. Both modes use the shared history writer. */
export function createConversationSession(
  doc: LoroDoc,
  options: CreateConversationViewFromReaderOptions & {
    windowed: boolean;
    sessionId: SessionId;
  }
) {
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
    });
    return {
      mirror,
      history,
      historyWriter: mirror.historyWriter,
      sessionData,
      dispose: () => {
        sessionData.dispose();
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
  });
  // One windowed implementation for production, stories and benchmarks.
  const history = createConversationViewFromReader(sessionData.history, options);
  return {
    mirror,
    history,
    historyWriter,
    sessionData,
    dispose: () => {
      sessionData.dispose();
      history.dispose();
      mirror.dispose();
    },
  };
}
