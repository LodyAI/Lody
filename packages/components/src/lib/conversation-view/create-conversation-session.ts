import { createHistoryWriter, type SessionId } from '@lody/shared';
import { createLoroSessionData } from '@lody/shared/session-data';
import type { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import {
  createControlPlaneDoc,
  CONTROL_PLANE_IGNORED_ROOT_KEYS,
  sessionControlPlaneSchema,
} from '@lody/shared';
import type { CreateConversationViewFromReaderOptions } from './create-conversation-view-from-reader';
import { createConversationViewFromReader } from './create-conversation-view-from-reader';

/** Windowed reads and the one shared history writer over the same document. */
export function createConversationSession(
  doc: LoroDoc,
  options: CreateConversationViewFromReaderOptions & {
    sessionId: SessionId;
  }
) {
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
