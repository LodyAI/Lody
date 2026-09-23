import { describe, expect, it } from 'vitest';
import {
  closedSessionHasUnreadMessages,
  sessionHasUnreadMessages,
  shouldMarkSessionRead,
} from '../src/lib/session-read-receipt';

const visibleUnread = {
  rendersConversation: true,
  isVisible: true,
  lastMessageAt: 200,
  lastReadAt: 100,
};

describe('shouldMarkSessionRead', () => {
  it('clears unread for the conversation the user is looking at', () => {
    expect(shouldMarkSessionRead(visibleUnread)).toBe(true);
  });

  it('treats a never-read session with messages as unread', () => {
    expect(shouldMarkSessionRead({ ...visibleUnread, lastReadAt: null })).toBe(true);
  });

  it('keeps a hidden sub-session unread while its parent tab is open', () => {
    // Every child tab stays mounted behind the active one; only the visible tab
    // may report a read receipt.
    expect(shouldMarkSessionRead({ ...visibleUnread, isVisible: false })).toBe(false);
  });

  it('does not report a receipt from a surface that renders no transcript', () => {
    expect(shouldMarkSessionRead({ ...visibleUnread, rendersConversation: false })).toBe(false);
  });

  it('stays read when nothing arrived after the last read', () => {
    expect(shouldMarkSessionRead({ ...visibleUnread, lastMessageAt: 100 })).toBe(false);
  });

  it('reports nothing for a session with no messages', () => {
    expect(shouldMarkSessionRead({ ...visibleUnread, lastMessageAt: null, lastReadAt: null })).toBe(
      false
    );
  });
});

describe('sessionHasUnreadMessages', () => {
  it.each([{ isTabClosed: true }, { isArchived: true }])(
    'suppresses closed output without modifying receipts: %o',
    (closure) => {
      const session = { lastMessageAt: 200, lastReadAt: 100, ...closure };
      expect(sessionHasUnreadMessages(session)).toBe(false);
      session.lastMessageAt = 300;
      expect(sessionHasUnreadMessages(session)).toBe(false);
      expect(session.lastReadAt).toBe(100);
      expect(sessionHasUnreadMessages({ ...session, isTabClosed: false, isArchived: false })).toBe(
        true
      );
    }
  );

  it('keeps the normal read comparison for open conversations', () => {
    expect(sessionHasUnreadMessages({ lastMessageAt: 200 })).toBe(true);
    expect(sessionHasUnreadMessages({ lastMessageAt: 200, lastReadAt: 100 })).toBe(true);
    expect(sessionHasUnreadMessages({ lastMessageAt: 200, lastReadAt: 200 })).toBe(false);
    expect(sessionHasUnreadMessages({})).toBe(false);
  });
});

describe('closedSessionHasUnreadMessages', () => {
  it.each([{ isTabClosed: true }, { isArchived: true }])(
    'reports unread output of a closed conversation: %o',
    (closure) => {
      expect(
        closedSessionHasUnreadMessages({ lastMessageAt: 200, lastReadAt: 100, ...closure })
      ).toBe(true);
      expect(closedSessionHasUnreadMessages({ lastMessageAt: 200, ...closure })).toBe(true);
      expect(
        closedSessionHasUnreadMessages({ lastMessageAt: 200, lastReadAt: 200, ...closure })
      ).toBe(false);
      expect(closedSessionHasUnreadMessages({ ...closure })).toBe(false);
    }
  );

  it('ignores open conversations, which surface unread on their own tab', () => {
    expect(closedSessionHasUnreadMessages({ lastMessageAt: 200, lastReadAt: 100 })).toBe(false);
  });
});
