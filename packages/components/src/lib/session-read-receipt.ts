/**
 * Decides whether a mounted conversation surface may clear a session's unread
 * state.
 *
 * Session tabs and side chats stay MOUNTED while hidden so switching between
 * them is instant. A mounted surface is therefore not evidence that the user
 * saw the conversation: without the visibility gate, opening a parent session
 * silently marks every one of its sub-sessions read.
 */
export type SessionReadReceiptInput = {
  /** False for split-header/toolbar instances that never render the transcript. */
  rendersConversation: boolean;
  /** The surface is on screen right now (active tab, panel not collapsed). */
  isVisible: boolean;
  /** Parsed `SessionMeta.lastMessageAt`; null when nothing has been recorded. */
  lastMessageAt: number | null;
  /** Parsed `SessionMeta.lastReadAt`; null when the session was never read. */
  lastReadAt: number | null;
};

export function shouldMarkSessionRead({
  rendersConversation,
  isVisible,
  lastMessageAt,
  lastReadAt,
}: SessionReadReceiptInput): boolean {
  if (!rendersConversation) return false;
  if (!isVisible) return false;
  if (lastMessageAt === null) return false;
  if (lastReadAt === null) return true;
  return lastMessageAt > lastReadAt;
}

/**
 * Does this session have output the user has not seen yet?
 *
 * The same comparison `shouldMarkSessionRead` uses to DECIDE a read receipt,
 * exported so the surfaces that ANNOUNCE unread state (desktop session tabs,
 * conversation status slots) cannot drift from it. Sub-session tabs are the
 * load-bearing case: a child Session with `childSessionPlacement: 'side-panel'`
 * or a top-strip child tab has no sidebar row of its own, so the tab is the
 * only place its unread state can surface.
 */
export function sessionHasUnreadMessages(session: {
  lastMessageAt?: number;
  lastReadAt?: number;
}): boolean {
  const lastMessageAt = typeof session.lastMessageAt === 'number' ? session.lastMessageAt : null;
  if (lastMessageAt === null) return false;
  const lastReadAt = typeof session.lastReadAt === 'number' ? session.lastReadAt : null;
  return lastReadAt === null || lastMessageAt > lastReadAt;
}
