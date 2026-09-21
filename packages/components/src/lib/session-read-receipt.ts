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

/** Closed conversations suppress unread indicators without changing read receipts. */
export function sessionHasUnreadMessages(session: {
  lastMessageAt?: number;
  lastReadAt?: number;
  isTabClosed?: boolean;
  isArchived?: boolean;
}): boolean {
  if (session.isTabClosed === true || session.isArchived === true) return false;
  const lastMessageAt = typeof session.lastMessageAt === 'number' ? session.lastMessageAt : null;
  if (lastMessageAt === null) return false;
  const lastReadAt = typeof session.lastReadAt === 'number' ? session.lastReadAt : null;
  return lastReadAt === null || lastMessageAt > lastReadAt;
}
