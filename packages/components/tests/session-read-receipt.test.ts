// @vitest-environment jsdom

import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronPowerState } from '@lody/shared/electron-ipc';
import {
  closedSessionHasUnreadMessages,
  getEffectiveSessionLastMessageAt,
  resolveManualUnreadLatch,
  sessionHasUnreadMessages,
  shouldMarkSessionRead,
  type ReadReceiptSnapshot,
} from '../src/lib/session-read-receipt';
import {
  ACTIVATION_INTERACTION_COALESCE_MS,
  createWindowReadEngagementTracker,
  READ_INTERACTION_IDLE_MS,
  useObserveWindowReadEngagement,
  useWindowReadEngagement,
  type WindowReadEngagementEnvironment,
} from '../src/lib/window-read-engagement';
import { getSessionRoomId, type SessionId, type SessionMeta } from '@lody/shared';
import { touchSessionActivityMeta } from '../src/hooks/use-session-actions';
import type { WorkspaceRuntime } from '../src/atoms/runtime';

describe('session-read-receipt', () => {
  const visibleUnread = {
    rendersConversation: true,
    isVisible: true,
    isWindowActive: true,
    hasPageInteraction: true,
    lastMessageAt: 200,
    lastReadAt: 100,
  };

  describe('shouldMarkSessionRead', () => {
    it('clears unread when the visible conversation is in an active, interacted window', () => {
      expect(shouldMarkSessionRead(visibleUnread)).toBe(true);
    });

    it('treats a never-read session with messages as unread', () => {
      expect(shouldMarkSessionRead({ ...visibleUnread, lastReadAt: null })).toBe(true);
    });

    it('keeps a hidden sub-session unread while its parent tab is open', () => {
      expect(shouldMarkSessionRead({ ...visibleUnread, isVisible: false })).toBe(false);
    });

    it('does not report a receipt from a surface that renders no transcript', () => {
      expect(shouldMarkSessionRead({ ...visibleUnread, rendersConversation: false })).toBe(false);
    });

    it('keeps a session unread when the host window is not active in the foreground', () => {
      expect(shouldMarkSessionRead({ ...visibleUnread, isWindowActive: false })).toBe(false);
    });

    it('keeps a session unread when the active window has not received page interaction', () => {
      expect(shouldMarkSessionRead({ ...visibleUnread, hasPageInteraction: false })).toBe(false);
    });

    it('marks an expired-snooze session read even when lastMessageAt is already read or absent', () => {
      const expiredSnoozeAt = 500;
      const nowMs = 600;
      expect(
        sessionHasUnreadMessages(
          { lastMessageAt: 200, lastReadAt: 200, snoozedUntil: expiredSnoozeAt },
          nowMs
        )
      ).toBe(true);
      const effectiveWithMessage = getEffectiveSessionLastMessageAt(
        { lastMessageAt: 200, snoozedUntil: expiredSnoozeAt },
        nowMs
      );
      expect(effectiveWithMessage).toBe(expiredSnoozeAt);
      expect(
        shouldMarkSessionRead({
          ...visibleUnread,
          lastMessageAt: effectiveWithMessage,
          lastReadAt: 200,
        })
      ).toBe(true);

      const effectiveWithoutMessage = getEffectiveSessionLastMessageAt(
        { lastMessageAt: null, snoozedUntil: expiredSnoozeAt },
        nowMs
      );
      expect(effectiveWithoutMessage).toBe(expiredSnoozeAt);
      expect(
        shouldMarkSessionRead({
          ...visibleUnread,
          lastMessageAt: effectiveWithoutMessage,
          lastReadAt: null,
        })
      ).toBe(true);

      // Future snooze does not count as unread or trigger a receipt.
      expect(
        getEffectiveSessionLastMessageAt({ lastMessageAt: 200, snoozedUntil: 900 }, nowMs)
      ).toBe(200);
    });
  });

  describe('resolveManualUnreadLatch', () => {
    const readSnapshot: ReadReceiptSnapshot = {
      sessionId: 's1',
      isVisible: true,
      lastMessageAt: 200,
      lastReadAt: 200,
    };

    it('latches when lastReadAt moves backwards while visible without a newer message', () => {
      const latched = resolveManualUnreadLatch(
        readSnapshot,
        { ...readSnapshot, lastReadAt: 199 },
        null
      );
      expect(latched).toBe(200);
      expect(
        resolveManualUnreadLatch(
          { ...readSnapshot, lastReadAt: 199 },
          { ...readSnapshot, lastReadAt: 199 },
          latched
        )
      ).toBe(200);
    });

    it('does not latch pre-existing unread state on mount or initial sync', () => {
      expect(resolveManualUnreadLatch(null, { ...readSnapshot, lastReadAt: 100 }, null)).toBeNull();
      expect(
        resolveManualUnreadLatch(
          { ...readSnapshot, lastReadAt: 100 },
          { ...readSnapshot, lastReadAt: 150 },
          null
        )
      ).toBeNull();
    });

    it('clears the latch on session switch, leaving and returning, or a newer message', () => {
      expect(
        resolveManualUnreadLatch(readSnapshot, { ...readSnapshot, sessionId: 's2' }, 200)
      ).toBe(null);
      expect(
        resolveManualUnreadLatch(
          { ...readSnapshot, isVisible: false },
          { ...readSnapshot, isVisible: true },
          200
        )
      ).toBe(null);
      expect(
        resolveManualUnreadLatch(readSnapshot, { ...readSnapshot, lastMessageAt: 250 }, 200)
      ).toBe(null);
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

describe('window-read-engagement', () => {
  function createHarness(initialForeground = true) {
    let foreground = initialForeground;
    let now = 1_000;
    const listeners = {
      onFocusChange: () => {},
      onInput: (_type: string) => {},
      onPowerState: (_state: ElectronPowerState) => {},
    };
    const env: WindowReadEngagementEnvironment = {
      isForeground: () => foreground,
      now: () => now,
      subscribe: (next) => {
        Object.assign(listeners, next);
        return () => {};
      },
    };
    return {
      env,
      setForeground(value: boolean) {
        foreground = value;
        listeners.onFocusChange();
      },
      input(type: string) {
        listeners.onInput(type);
      },
      power(state: ElectronPowerState) {
        listeners.onPowerState(state);
      },
      advance(ms: number) {
        now += ms;
        vi.advanceTimersByTime(ms);
      },
      bumpClockOnly(ms: number) {
        now += ms;
      },
    };
  }

  it('requires page interaction even when the window starts active in the foreground', () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(true);
      const tracker = createWindowReadEngagementTracker(harness.env);
      const states: Array<{ isWindowActive: boolean; hasPageInteraction: boolean }> = [];
      tracker.subscribe((s) => states.push(s));

      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: false });

      harness.input('pointerdown');
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: true });
      expect(states).toEqual([{ isWindowActive: true, hasPageInteraction: true }]);
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets interaction on blur/hide and keeps Cmd+Tab focus unengaged until interaction', () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(true);
      const tracker = createWindowReadEngagementTracker(harness.env);
      harness.input('keydown');
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: true });

      // Switching to another app clears interaction.
      harness.setForeground(false);
      expect(tracker.getState()).toEqual({ isWindowActive: false, hasPageInteraction: false });

      // Scrolling over an unfocused window does not count as active engagement.
      harness.input('wheel');
      expect(tracker.getState()).toEqual({ isWindowActive: false, hasPageInteraction: false });

      // Alt/Cmd+Tab restores focus without DOM input -> still waits for page interaction.
      harness.setForeground(true);
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: false });

      harness.input('wheel');
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: true });
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a click inside an inactive window that immediately focuses it', () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(false);
      const tracker = createWindowReadEngagementTracker(harness.env);

      harness.input('pointerdown');
      harness.bumpClockOnly(ACTIVATION_INTERACTION_COALESCE_MS - 50);
      harness.setForeground(true);
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: true });

      // A stale pointerdown from much earlier does not carry over into a later focus.
      harness.setForeground(false);
      harness.input('pointerdown');
      harness.advance(ACTIVATION_INTERACTION_COALESCE_MS + 100);
      harness.setForeground(true);
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: false });
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('withdraws engagement on OS sleep/lock and after the interaction idle window', () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(true);
      const tracker = createWindowReadEngagementTracker(harness.env);
      const states: Array<{ isWindowActive: boolean; hasPageInteraction: boolean }> = [];
      tracker.subscribe((s) => states.push(s));

      harness.input('pointerdown');
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: true });

      harness.power('lock-screen');
      expect(tracker.getState()).toEqual({ isWindowActive: false, hasPageInteraction: false });
      harness.power('unlock-screen');
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: false });

      // Re-engage, then wait past idle timeout.
      harness.input('keydown');
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: true });
      harness.advance(READ_INTERACTION_IDLE_MS);
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: false });

      // Even if the clock jumped ahead of the timer callback, a new interaction re-emits.
      harness.input('click');
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: true });
      harness.bumpClockOnly(READ_INTERACTION_IDLE_MS + 10_000);
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: false });
      harness.input('pointerdown');
      expect(states.at(-1)).toEqual({ isWindowActive: true, hasPageInteraction: true });
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers from a missed unlock/resume power event when foreground user input arrives', () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(true);
      const tracker = createWindowReadEngagementTracker(harness.env);
      const states: Array<{ isWindowActive: boolean; hasPageInteraction: boolean }> = [];
      tracker.subscribe((s) => states.push(s));

      harness.power('lock-screen');
      expect(tracker.getState()).toEqual({ isWindowActive: false, hasPageInteraction: false });

      // Background input while not foreground must not clear locked state.
      harness.setForeground(false);
      harness.input('pointerdown');
      expect(tracker.getState()).toEqual({ isWindowActive: false, hasPageInteraction: false });

      // Foreground input proves the OS is awake and unlocked even if unlock-screen was missed.
      harness.setForeground(true);
      expect(tracker.getState()).toEqual({ isWindowActive: false, hasPageInteraction: false });
      harness.input('pointerdown');
      expect(tracker.getState()).toEqual({ isWindowActive: true, hasPageInteraction: true });
      expect(states.at(-1)).toEqual({ isWindowActive: true, hasPageInteraction: true });
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('browser hook & navigation lifecycle', () => {
    let root: Root | undefined;
    let container: HTMLDivElement | undefined;
    let hasFocusSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    afterEach(() => {
      hasFocusSpy?.mockRestore();
      hasFocusSpy = undefined;
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      if (root) {
        act(() => {
          root?.unmount();
        });
        root = undefined;
      }
      container?.remove();
      container = undefined;
    });

    function SessionReadProbe({
      sessionId,
      isVisible,
      lastMessageAt,
      lastReadAt,
      snoozedUntil,
      onMarkRead,
    }: {
      sessionId: string;
      isVisible: boolean;
      lastMessageAt: number | null;
      lastReadAt: number | null;
      snoozedUntil?: number | null;
      onMarkRead: (sessionId: string, at: number | null) => void;
    }) {
      const { isWindowActive, hasPageInteraction, engagementRevision, getLatestState } =
        useWindowReadEngagement();
      const prevRef = useRef<ReadReceiptSnapshot | null>(null);
      const latchedRef = useRef<number | null>(null);

      useEffect(() => {
        const effectiveLastMessageAt = getEffectiveSessionLastMessageAt({
          lastMessageAt,
          snoozedUntil,
        });
        const snapshot: ReadReceiptSnapshot = {
          sessionId,
          isVisible,
          lastMessageAt: effectiveLastMessageAt,
          lastReadAt,
        };
        const latched = resolveManualUnreadLatch(prevRef.current, snapshot, latchedRef.current);
        prevRef.current = snapshot;
        latchedRef.current = latched;
        if (
          latched !== null &&
          effectiveLastMessageAt !== null &&
          effectiveLastMessageAt <= latched
        ) {
          return;
        }

        const live = getLatestState();
        if (
          !shouldMarkSessionRead({
            rendersConversation: true,
            isVisible,
            isWindowActive: isWindowActive && live.isWindowActive,
            hasPageInteraction: hasPageInteraction && live.hasPageInteraction,
            lastMessageAt: effectiveLastMessageAt,
            lastReadAt,
          })
        ) {
          return;
        }
        onMarkRead(sessionId, effectiveLastMessageAt);
      }, [
        engagementRevision,
        getLatestState,
        hasPageInteraction,
        isVisible,
        isWindowActive,
        lastMessageAt,
        lastReadAt,
        onMarkRead,
        sessionId,
        snoozedUntil,
      ]);

      return null;
    }

    function WorkspaceShell({
      showSession,
      lastMessageAt,
      lastReadAt,
      snoozedUntil,
      onMarkRead,
    }: {
      showSession: boolean;
      lastMessageAt: number;
      lastReadAt: number | null;
      snoozedUntil?: number | null;
      onMarkRead: (sessionId: string, at: number | null) => void;
    }) {
      useObserveWindowReadEngagement();
      return showSession
        ? React.createElement(SessionReadProbe, {
            sessionId: 's1',
            isVisible: true,
            lastMessageAt,
            lastReadAt,
            snoozedUntil,
            onMarkRead,
          })
        : null;
    }

    it('does not mark an unread session read on window open/focus until page interaction, and keeps manual unread intact', () => {
      const onMarkRead = vi.fn();
      root = createRoot(container!);

      // 1. Session opens while window is active but untouched -> stays unread.
      act(() => {
        root!.render(
          React.createElement(WorkspaceShell, {
            showSession: true,
            lastMessageAt: 200,
            lastReadAt: 100,
            onMarkRead,
          })
        );
      });
      expect(onMarkRead).not.toHaveBeenCalled();

      // 2. User interacts with the page -> now marked read.
      act(() => {
        window.dispatchEvent(new Event('pointerdown'));
      });
      expect(onMarkRead).toHaveBeenCalledWith('s1', 200);
      onMarkRead.mockClear();

      // 3. Re-render with read receipt updated, then user manually marks unread.
      act(() => {
        root!.render(
          React.createElement(WorkspaceShell, {
            showSession: true,
            lastMessageAt: 200,
            lastReadAt: 200,
            onMarkRead,
          })
        );
      });
      act(() => {
        root!.render(
          React.createElement(WorkspaceShell, {
            showSession: true,
            lastMessageAt: 200,
            lastReadAt: 199,
            onMarkRead,
          })
        );
      });
      act(() => {
        window.dispatchEvent(new Event('click'));
      });
      expect(onMarkRead).not.toHaveBeenCalled();

      // 4. Window blurs and receives a newer message while in background -> stays unread.
      hasFocusSpy?.mockReturnValue(false);
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      act(() => {
        root!.render(
          React.createElement(WorkspaceShell, {
            showSession: true,
            lastMessageAt: 300,
            lastReadAt: 199,
            onMarkRead,
          })
        );
      });
      expect(onMarkRead).not.toHaveBeenCalled();

      // 5. Window regains focus (e.g. Cmd+Tab) without interaction -> still unread.
      hasFocusSpy?.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(onMarkRead).not.toHaveBeenCalled();

      // 6. User scrolls/clicks inside the now-active window -> clears unread.
      act(() => {
        window.dispatchEvent(new Event('wheel'));
      });
      expect(onMarkRead).toHaveBeenCalledWith('s1', 300);
    });

    it('carries a sidebar navigation click from Home into the newly mounted session', () => {
      const onMarkRead = vi.fn();
      root = createRoot(container!);

      // User starts on Home (no session surface mounted).
      act(() => {
        root!.render(
          React.createElement(WorkspaceShell, {
            showSession: false,
            lastMessageAt: 200,
            lastReadAt: 100,
            onMarkRead,
          })
        );
      });

      // Clicking a sidebar row triggers pointerdown before navigation mounts the session.
      act(() => {
        window.dispatchEvent(new Event('pointerdown'));
      });
      act(() => {
        root!.render(
          React.createElement(WorkspaceShell, {
            showSession: true,
            lastMessageAt: 200,
            lastReadAt: 100,
            onMarkRead,
          })
        );
      });
      expect(onMarkRead).toHaveBeenCalledWith('s1', 200);
    });

    it('marks a session read on subsequent click after a clock-jump idle expiry', () => {
      let nowMs = 10_000;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      try {
        const onMarkRead = vi.fn();
        root = createRoot(container!);

        act(() => {
          root!.render(
            React.createElement(WorkspaceShell, {
              showSession: true,
              lastMessageAt: 200,
              lastReadAt: 200,
              onMarkRead,
            })
          );
        });
        act(() => {
          window.dispatchEvent(new Event('pointerdown'));
        });
        expect(onMarkRead).not.toHaveBeenCalled();

        // Advance Date.now() past idle window without running the idle timer so
        // React's boolean hook state still reads hasPageInteraction=true.
        nowMs += READ_INTERACTION_IDLE_MS + 5_000;
        act(() => {
          root!.render(
            React.createElement(WorkspaceShell, {
              showSession: true,
              lastMessageAt: 300,
              lastReadAt: 200,
              onMarkRead,
            })
          );
        });
        expect(onMarkRead).not.toHaveBeenCalled();

        // Clicking inside the foreground window must re-trigger the effect via engagementRevision.
        act(() => {
          window.dispatchEvent(new Event('pointerdown'));
        });
        expect(onMarkRead).toHaveBeenCalledWith('s1', 300);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('marks an expired-snooze session read when clicked in the sidebar', () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        const onMarkRead = vi.fn();
        root = createRoot(container!);

        act(() => {
          root!.render(
            React.createElement(WorkspaceShell, {
              showSession: false,
              lastMessageAt: 200,
              lastReadAt: 200,
              snoozedUntil: 800,
              onMarkRead,
            })
          );
        });
        act(() => {
          window.dispatchEvent(new Event('pointerdown'));
        });
        act(() => {
          root!.render(
            React.createElement(WorkspaceShell, {
              showSession: true,
              lastMessageAt: 200,
              lastReadAt: 200,
              snoozedUntil: 800,
              onMarkRead,
            })
          );
        });
        expect(onMarkRead).toHaveBeenCalledWith('s1', 800);
      } finally {
        nowSpy.mockRestore();
      }
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
