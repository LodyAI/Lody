import type { SessionId, SessionMeta } from '@lody/shared';
import { formatSessionTabSearch } from './session-tab-url';

/** A routable Session plus the exact child Tab that should be restored. */
export type SessionNavigationTarget = {
  sessionId: SessionId;
  tabSessionId?: SessionId;
};

/**
 * Resolve a navigation target that already belongs to the mounted Session
 * workspace. Operation cards only persist the created Session id, so a child
 * target arrives as `{ sessionId: childId }` rather than the root + tab pair.
 * Recognizing it locally lets the caller restore a closed tab before selecting
 * it instead of routing through the child's root URL and immediately falling
 * back when the parent sees the shared close flag.
 */
export const resolveCurrentWorkspaceTabNavigation = (
  target: SessionNavigationTarget,
  currentSessionId: SessionId,
  currentTabSessionIds: ReadonlySet<string>,
  closedTabSessionIds: ReadonlySet<string>
): { tabSessionId: SessionId; shouldReopen: boolean } | null => {
  let tabSessionId: SessionId | null = null;
  if (target.sessionId === currentSessionId) {
    tabSessionId = target.tabSessionId ?? currentSessionId;
  } else if (target.tabSessionId === undefined && currentTabSessionIds.has(target.sessionId)) {
    tabSessionId = target.sessionId;
  }
  return tabSessionId
    ? { tabSessionId, shouldReopen: closedTabSessionIds.has(tabSessionId) }
    : null;
};

export type SessionTabRestoreNavigationResolution =
  | { kind: 'wait' }
  | { kind: 'cancel' }
  | { kind: 'navigate'; tabSessionId: SessionId };

/**
 * A reopen write can resolve before its projected Session metadata reaches the
 * mounted workspace. Wait for that projection before selecting the target;
 * otherwise the shared-close reconciliation sees the stale close flag and
 * replaces the requested URL with an open neighbour.
 */
export const resolveSessionTabRestoreNavigation = (
  tabSessionId: SessionId,
  sourceSessionId: SessionId,
  currentSessionId: SessionId,
  sourceUrlTab: string | undefined,
  currentUrlTab: string | undefined,
  writeCompleted: boolean,
  closedTabSessionIds: ReadonlySet<string>
): SessionTabRestoreNavigationResolution => {
  if (currentSessionId !== sourceSessionId) return { kind: 'cancel' };
  if (currentUrlTab !== sourceUrlTab) return { kind: 'cancel' };
  if (!writeCompleted || closedTabSessionIds.has(tabSessionId)) return { kind: 'wait' };
  return { kind: 'navigate', tabSessionId };
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
