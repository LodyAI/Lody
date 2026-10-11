import {
  createHistoryWriter,
  type HistoryWriter,
  type SessionHistoryBackendKind,
  type SessionId,
} from '@lody/shared';
import { createLoroSessionData, type SessionData } from '@lody/shared/session-data';
import type { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import {
  createControlPlaneDoc,
  CONTROL_PLANE_IGNORED_ROOT_KEYS,
  sessionControlPlaneSchema,
} from '@lody/shared';
import type { CreateConversationViewFromReaderOptions } from './create-conversation-view-from-reader';
import { createConversationViewFromReader } from './create-conversation-view-from-reader';

export type ConversationSessionData = SessionData & {
  /** Optional storage-owned cleanup for composed backend data. */
  readonly dispose?: () => void;
};

export type ConversationSessionDataFactory = (options: {
  sessionId: SessionId;
  doc: LoroDoc;
  /** Present only for the built-in Loro composition. Roost owns history writes. */
  writer?: HistoryWriter;
  backendKind: SessionHistoryBackendKind;
}) => ConversationSessionData;

/** Windowed reads and the backend-owned session data over the control document. */
export function createConversationSession(
  doc: LoroDoc,
  options: CreateConversationViewFromReaderOptions & {
    sessionId: SessionId;
    backendKind?: SessionHistoryBackendKind;
    createSessionData?: ConversationSessionDataFactory;
  }
) {
  const mirror = new Mirror({
    doc: createControlPlaneDoc(doc, { ignoredRootKeys: CONTROL_PLANE_IGNORED_ROOT_KEYS }),
    schema: sessionControlPlaneSchema,
    ignoreUnknownProperties: true,
    validateUpdates: false,
    initialState: { session: { id: options.sessionId } },
  });
  const backendKind = options.backendKind ?? 'loro';
  let historyWriter: HistoryWriter | undefined;
  let sessionData: ConversationSessionData | undefined;
  let history: ReturnType<typeof createConversationViewFromReader> | undefined;
  try {
    if (backendKind === 'roost' && !options.createSessionData) {
      throw new Error('Session backend "roost" requires a renderer SessionData factory');
    }
    // Do not construct a Loro history writer for an injected backend. The
    // renderer control document remains available to the adapter, but history
    // ownership must stay entirely inside the selected SessionData factory.
    historyWriter = options.createSessionData ? undefined : createHistoryWriter(doc);
    sessionData = options.createSessionData
      ? options.createSessionData({
          sessionId: options.sessionId,
          doc,
          writer: historyWriter,
          backendKind,
        })
      : createLoroSessionData({
          sessionId: options.sessionId,
          doc,
          writer: historyWriter as HistoryWriter,
        });
    // One windowed implementation for production, stories and benchmarks.
    history = createConversationViewFromReader(sessionData.history, options);
  } catch (error) {
    history?.dispose();
    sessionData?.dispose?.();
    mirror.dispose();
    throw error;
  }
  if (!sessionData || !history) {
    mirror.dispose();
    throw new Error('Session data composition did not produce a history view');
  }
  return {
    mirror,
    history,
    ...(historyWriter ? { historyWriter } : {}),
    sessionData,
    dispose: () => {
      sessionData.dispose?.();
      history.dispose();
      mirror.dispose();
    },
  };
}
