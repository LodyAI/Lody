import { getServerNow, statusViewUnread } from '@lody/shared';

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
  /** The host window/tab is active in the foreground (visible, focused, not suspended/locked). */
  isWindowActive: boolean;
  /** The user has interacted with the page during the current active window visit. */
  hasPageInteraction: boolean;
  /** Parsed `SessionMeta.lastMessageAt`; null when nothing has been recorded. */
  lastMessageAt: number | null;
  /** Parsed `SessionMeta.lastReadAt`; null when the session was never read. */
  lastReadAt: number | null;
};

export function shouldMarkSessionRead({
  rendersConversation,
  isVisible,
  isWindowActive,
  hasPageInteraction,
  lastMessageAt,
  lastReadAt,
}: SessionReadReceiptInput): boolean {
  if (!rendersConversation) return false;
  if (!isVisible) return false;
  if (!isWindowActive) return false;
  if (!hasPageInteraction) return false;
  if (lastMessageAt === null) return false;
  if (lastReadAt === null) return true;
  return lastMessageAt > lastReadAt;
}

export type ReadReceiptSnapshot = {
  sessionId: string;
  isVisible: boolean;
  lastMessageAt: number | null;
  lastReadAt: number | null;
};

/**
 * Tracks whether the user explicitly marked the currently open session unread
 * so subsequent clicks or window focus transitions on that visit do not
 * immediately undo "Mark as unread". Clears when switching sessions, leaving
 * and returning to the surface, or receiving a newer message.
 */
export function resolveManualUnreadLatch(
  prev: ReadReceiptSnapshot | null,
  next: ReadReceiptSnapshot,
  latchedMessageAt: number | null
): number | null {
  if (!prev || prev.sessionId !== next.sessionId) {
    return null;
  }
  if (!prev.isVisible && next.isVisible) {
    return null;
  }
  if (
    latchedMessageAt !== null &&
    next.lastMessageAt !== null &&
    next.lastMessageAt > latchedMessageAt
  ) {
    return null;
  }
  const movedReadBackwardsWhileVisible =
    prev.isVisible &&
    next.isVisible &&
    prev.lastMessageAt !== null &&
    next.lastMessageAt !== null &&
    next.lastMessageAt === prev.lastMessageAt &&
    prev.lastReadAt !== null &&
    prev.lastReadAt >= prev.lastMessageAt &&
    next.lastReadAt !== null &&
    next.lastReadAt < next.lastMessageAt;
  if (movedReadBackwardsWhileVisible) {
    return next.lastMessageAt;
  }
  return latchedMessageAt;
}

type SessionUnreadInput = {
  lastMessageAt?: number;
  lastReadAt?: number;
  snoozedUntil?: number;
  isTabClosed?: boolean;
  isArchived?: boolean;
};

/**
 * Computes the effective activity timestamp that determines whether a session
 * has unread state: the latest message timestamp or an expired snooze wake-up,
 * whichever is newer.
 */
export function getEffectiveSessionLastMessageAt(
  session: {
    lastMessageAt?: number | null;
    snoozedUntil?: number | null;
  },
  nowMs: number = getServerNow()
): number | null {
  const lastMessageAt =
    typeof session.lastMessageAt === 'number' && Number.isFinite(session.lastMessageAt)
      ? session.lastMessageAt
      : null;
  const expiredSnoozeAt =
    typeof session.snoozedUntil === 'number' &&
    Number.isFinite(session.snoozedUntil) &&
    session.snoozedUntil <= nowMs
      ? session.snoozedUntil
      : null;
  if (lastMessageAt !== null && expiredSnoozeAt !== null) {
    return Math.max(lastMessageAt, expiredSnoozeAt);
  }
  return lastMessageAt ?? expiredSnoozeAt;
}

/** Closed and archived conversations suppress unread indicators without changing read receipts. */
export function sessionHasUnreadMessages(
  session: SessionUnreadInput,
  nowMs: number = getServerNow()
): boolean {
  if (session.isTabClosed === true || session.isArchived === true) {
    return false;
  }
  return hasUnreadOutput(session, nowMs);
}

/**
 * Unread output in a closed or archived conversation. Only the closed-conversations
 * list surfaces it; tabs, sidebar summaries, and badges stay quiet.
 */
export function closedSessionHasUnreadMessages(
  session: SessionUnreadInput,
  nowMs: number = getServerNow()
): boolean {
  if (session.isTabClosed !== true && session.isArchived !== true) return false;
  return hasUnreadOutput(session, nowMs);
}

function hasUnreadOutput(session: SessionUnreadInput, nowMs: number): boolean {
  return statusViewUnread(session, nowMs);
}
