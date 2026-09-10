import type { SessionId, SessionMeta } from '@lody/shared';
import { formatSessionTabSearch } from './session-tab-url';

/** A routable Session plus the exact child Tab that should be restored. */
export type SessionNavigationTarget = {
  sessionId: SessionId;
  tabSessionId?: SessionId;
};

/** The route params/search needed to restore a Session navigation target. */
export const getSessionNavigationLocation = (
  target: SessionNavigationTarget
): { sessionId: SessionId; tab?: string } => ({
  sessionId: target.sessionId,
  tab: formatSessionTabSearch(target.tabSessionId ?? target.sessionId, target.sessionId),
});

/** Resolve reverse navigation only after both the exact opener and route root exist. */
export const resolveOpenedByNavigationTarget = (
  session: Pick<SessionMeta, 'openedBySessionId' | 'openedByRootSessionId'>,
  context: {
    metadataReady: boolean;
    openerSession?: Pick<SessionMeta, 'id' | 'parentSessionId'> | null;
    rootSession?: Pick<SessionMeta, 'id'> | null;
  }
): SessionNavigationTarget | null => {
  const tabSessionId = session.openedBySessionId;
  if (
    !tabSessionId ||
    !context.metadataReady ||
    context.openerSession?.id !== tabSessionId
  ) {
    return null;
  }

  const sessionId =
    session.openedByRootSessionId ?? context.openerSession.parentSessionId ?? tabSessionId;
  if (context.rootSession?.id !== sessionId) return null;
  return sessionId === tabSessionId ? { sessionId } : { sessionId, tabSessionId };
};
