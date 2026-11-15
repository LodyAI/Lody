import { describe, expect, it, vi } from 'vitest';
import {
  closedSessionHasUnreadMessages,
  sessionHasUnreadMessages,
  shouldMarkSessionRead,
} from '../src/lib/session-read-receipt';
import { getSessionRoomId, type SessionId, type SessionMeta } from '@lody/shared';
import { touchSessionActivityMeta } from '../src/hooks/use-session-actions';
import type { WorkspaceRuntime } from '../src/atoms/runtime';

describe('session-read-receipt', () => {
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
        expect(
          sessionHasUnreadMessages({ ...session, isTabClosed: false, isArchived: false })
        ).toBe(true);
      }
    );
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
});

describe('session-activity', () => {
  function createRuntime(
    metas: Record<string, SessionMeta | { deleted: true }>
  ): Pick<WorkspaceRuntime, 'repo' | 'writer'> {
    return {
      repo: {
        getDocMeta: vi.fn(async (roomId: string) => {
          const meta = metas[roomId];
          if (!meta) return undefined;
          if ('deleted' in meta) return { deleted: true, meta: {} };
          return { meta };
        }),
        upsertDocMeta: vi.fn(async () => undefined),
      } as unknown as WorkspaceRuntime['repo'],
      writer: {
        upsertDocMeta: vi.fn(async () => undefined),
      } as unknown as WorkspaceRuntime['writer'],
    };
  }

  describe('touchSessionActivityMeta', () => {
    it('rolls child tab activity up to the parent session', async () => {
      const parentId = 'parent-session' as SessionId;
      const childId = 'child-session' as SessionId;
      const parentRoomId = getSessionRoomId(parentId);
      const childRoomId = getSessionRoomId(childId);
      const runtime = createRuntime({
        [parentRoomId]: {
          id: parentId,
          machineId: 'machine-1',
          createdAt: '2026-05-24T00:00:00.000Z',
          userId: 'user-1',
          cliType: 'builtin',
          agentType: 'codex',
          lastMessageAt: 100,
          lastReadAt: 90,
        } as SessionMeta,
        [childRoomId]: {
          id: childId,
          machineId: 'machine-1',
          createdAt: '2026-05-24T00:00:00.000Z',
          userId: 'user-1',
          cliType: 'builtin',
          agentType: 'codex',
          parentSessionId: parentId,
          lastMessageAt: 120,
          lastReadAt: 110,
        } as SessionMeta,
      });

      await touchSessionActivityMeta(runtime as WorkspaceRuntime, childId, {
        lastMessageAt: 200,
        lastReadAt: 200,
      });

      expect(runtime.writer.upsertDocMeta).toHaveBeenCalledWith(childRoomId, {
        lastMessageAt: 200,
        lastReadAt: 200,
      });
      expect(runtime.writer.upsertDocMeta).toHaveBeenCalledWith(parentRoomId, {
        lastMessageAt: 200,
        lastReadAt: 200,
      });
    });

    it('does not move parent timestamps backwards', async () => {
      const parentId = 'parent-session' as SessionId;
      const childId = 'child-session' as SessionId;
      const parentRoomId = getSessionRoomId(parentId);
      const childRoomId = getSessionRoomId(childId);
      const runtime = createRuntime({
        [parentRoomId]: {
          id: parentId,
          machineId: 'machine-1',
          createdAt: '2026-05-24T00:00:00.000Z',
          userId: 'user-1',
          cliType: 'builtin',
          agentType: 'codex',
          lastMessageAt: 500,
          lastReadAt: 450,
        } as SessionMeta,
        [childRoomId]: {
          id: childId,
          machineId: 'machine-1',
          createdAt: '2026-05-24T00:00:00.000Z',
          userId: 'user-1',
          cliType: 'builtin',
          agentType: 'codex',
          parentSessionId: parentId,
          lastMessageAt: 100,
          lastReadAt: 100,
        } as SessionMeta,
      });

      await touchSessionActivityMeta(runtime as WorkspaceRuntime, childId, {
        lastMessageAt: 200,
        lastReadAt: 200,
      });

      expect(runtime.writer.upsertDocMeta).toHaveBeenCalledWith(childRoomId, {
        lastMessageAt: 200,
        lastReadAt: 200,
      });
      expect(runtime.writer.upsertDocMeta).not.toHaveBeenCalledWith(
        parentRoomId,
        expect.anything()
      );
    });
  });
});
