import { isDraftSessionTabId, type DraftSessionTabId } from './session-draft-tabs';

const SESSION_TAB_SEARCH_PREFIX = 'session:';
const DRAFT_TAB_SEARCH_PREFIX = 'draft:';
export const EMPTY_SESSION_TAB_ID = 'empty';

export const isSessionTabClosed = (meta: {
  isArchived?: boolean;
  isTabClosed?: boolean;
}): boolean => meta.isArchived === true || meta.isTabClosed === true;

/** Keep closed ids in the order so remote closes choose the same neighbour as local closes. */
export function getSessionTabFallback(
  tabId: string,
  orderedIds: readonly string[],
  openIds: readonly string[],
  metadataReady = true
): string {
  // Partial replica scans cannot establish the next open neighbour (or emptiness).
  if (!metadataReady) return tabId;
  const open = new Set(openIds);
  const index = orderedIds.indexOf(tabId);
  return (
    orderedIds.slice(index + 1).find((id) => open.has(id)) ??
    orderedIds
      .slice(0, Math.max(0, index))
      .reverse()
      .find((id) => open.has(id)) ??
    openIds[0] ??
    EMPTY_SESSION_TAB_ID
  );
}

/**
 * The `?tab` search value is the single source of truth for the active
 * conversation tab in `SessionDetail`. It encodes a child Session as
 * `session:<sessionId>` and a draft tab as its full `draft:<id>` tab id;
 * the ABSENT value means "no explicit choice" and is reserved for external
 * entries, which the session route restores from the last-active store.
 * `SessionDetail` derives the active tab from this value instead of mirroring
 * it into local state, which is what makes URL/state feedback loops
 * structurally impossible (#193).
 */
export type ParsedSessionTabSearch =
  | { kind: 'empty' }
  | { kind: 'missing' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'draft'; draftId: DraftSessionTabId }
  | { kind: 'invalid' };

export const parseSessionTabSearch = (tab: string | undefined): ParsedSessionTabSearch => {
  if (tab === undefined) {
    return { kind: 'missing' };
  }

  const normalized = tab.trim();
  if (normalized === EMPTY_SESSION_TAB_ID) return { kind: 'empty' };
  if (isDraftSessionTabId(normalized)) {
    if (normalized.length === DRAFT_TAB_SEARCH_PREFIX.length) {
      return { kind: 'invalid' };
    }
    return { kind: 'draft', draftId: normalized };
  }
  if (!normalized.startsWith(SESSION_TAB_SEARCH_PREFIX)) {
    return { kind: 'invalid' };
  }

  const sessionId = normalized.slice(SESSION_TAB_SEARCH_PREFIX.length).trim();
  if (!sessionId) {
    return { kind: 'invalid' };
  }

  return { kind: 'session', sessionId };
};

/**
 * Encoding for "navigate to a Session, optionally onto a specific tab":
 * the parent maps to the ABSENT value, so the session route restores the
 * viewer's last active tab. Used by cross-surface navigations (sidebar,
 * settings, opened-by links) that carry no explicit in-session choice.
 */
export const formatSessionTabSearch = (
  tabId: string,
  parentSessionId: string
): string | undefined => {
  if (tabId === EMPTY_SESSION_TAB_ID) return EMPTY_SESSION_TAB_ID;
  if (!tabId || tabId === parentSessionId) {
    return undefined;
  }
  if (isDraftSessionTabId(tabId)) {
    return tabId;
  }

  return `${SESSION_TAB_SEARCH_PREFIX}${tabId}`;
};

/**
 * Encoding for IN-SESSION tab activation: every tab, the parent included,
 * encodes explicitly (`session:<parentId>`). A user's return to the parent tab
 * must stay distinguishable from an external entry with no tab choice — an
 * absent value would be re-restored by the route's entry restoration.
 */
export const formatExplicitSessionTabSearch = (tabId: string): string =>
  tabId === EMPTY_SESSION_TAB_ID || isDraftSessionTabId(tabId)
    ? tabId
    : `${SESSION_TAB_SEARCH_PREFIX}${tabId}`;

export type SessionTabResolutionContext = {
  parentSessionId: string;
  /**
   * Side-panel children render in the right panel, never a top-tab surface.
   * Closure is resolved separately against the complete ordered open-tab set.
   */
  childSessionIdsResolvedToParent: readonly string[];
  draftTabIds: readonly string[];
  /**
   * Promotion aliases: draft tab id → the child Session it durably became.
   * A URL still naming the draft resolves to that child, so the send instant
   * has no frame in which the active tab falls back to the parent.
   */
  promotedChildSessionIdsByDraftId: Readonly<Partial<Record<string, string>>>;
};

/**
 * Resolve the active conversation tab from the URL alone. The rule is total
 * and takes the URL at its word: a `session:` tab the local replicas have not
 * caught up with yet stays ACTIVE (the caller renders a pending surface until
 * its meta arrives) instead of falling back to the parent — treating a
 * transient replica gap as "this tab does not exist" is exactly what made a
 * fresh child tab bounce back to the parent conversation. Only positive
 * evidence resolves away from the named tab: a side-panel child
 * renders the parent, and a draft absent from local state is provably gone
 * (drafts are device-local) unless a promotion alias redirects it to its
 * child. Pure:
 * activating a tab is the caller's navigation concern, and nothing here ever
 * writes the URL back.
 */
export const resolveActiveSessionTab = (
  parsed: ParsedSessionTabSearch,
  context: SessionTabResolutionContext
): string => {
  if (parsed.kind === 'empty') return EMPTY_SESSION_TAB_ID;
  if (parsed.kind === 'session') {
    if (parsed.sessionId === context.parentSessionId) {
      return context.parentSessionId;
    }
    if (context.childSessionIdsResolvedToParent.includes(parsed.sessionId)) {
      return context.parentSessionId;
    }
    return parsed.sessionId;
  }
  if (parsed.kind === 'draft') {
    if (context.draftTabIds.includes(parsed.draftId)) {
      return parsed.draftId;
    }
    const promotedChildSessionId = context.promotedChildSessionIdsByDraftId[parsed.draftId];
    if (promotedChildSessionId) {
      return promotedChildSessionId;
    }
    return context.parentSessionId;
  }
  return context.parentSessionId;
};
