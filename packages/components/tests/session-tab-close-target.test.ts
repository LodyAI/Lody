import { describe, expect, it } from 'vitest';
import { getSessionTabCloseTarget } from '../src/components/sessions/session-tab-close-target';
import {
  resolveActiveSessionTab,
  getSessionTabFallback,
  isSessionTabClosed,
} from '../src/lib/session-tab-url';
import {
  ACTIVE_TAB_MIN_WIDTH,
  allocateAdaptiveTabStripLayout,
  type AdaptiveTabStripLayout,
} from '../src/components/sessions/adaptive-tab-strip';

describe('session-tab-close-target', () => {
  const BASE_INPUT = {
    focusRegion: 'conversation' as const,
    sidePanelOpen: true,
    activeSidePanelTabId: 'changes',
    activeConversationTabId: 'child-session',
    parentConversationTabId: 'parent-session',
    conversationTabCount: 2,
  };

  describe('getSessionTabCloseTarget', () => {
    it('closes the active side-panel tab when that region has focus', () => {
      expect(
        getSessionTabCloseTarget({
          ...BASE_INPUT,
          focusRegion: 'side-panel',
        })
      ).toEqual({ kind: 'side-panel', tabId: 'changes' });
    });

    it('falls back to the child conversation when the last-focused side panel is hidden', () => {
      expect(
        getSessionTabCloseTarget({
          ...BASE_INPUT,
          focusRegion: 'side-panel',
          sidePanelOpen: false,
        })
      ).toEqual({ kind: 'conversation', tabId: 'child-session' });
    });

    it('closes the parent conversation tab even with siblings', () => {
      expect(
        getSessionTabCloseTarget({
          ...BASE_INPUT,
          activeConversationTabId: 'parent-session',
        })
      ).toEqual({ kind: 'conversation', tabId: 'parent-session' });
    });

    it.each(['parent-session', 'child-session', 'draft:local'])(
      'closes the window for the last conversation tab (%s)',
      (activeConversationTabId) => {
        expect(
          getSessionTabCloseTarget({
            ...BASE_INPUT,
            activeConversationTabId,
            conversationTabCount: 1,
          })
        ).toEqual({ kind: 'window' });
      }
    );

    it('keeps side-panel close priority with only one conversation tab', () => {
      expect(
        getSessionTabCloseTarget({
          ...BASE_INPUT,
          focusRegion: 'side-panel',
          conversationTabCount: 1,
        })
      ).toEqual({ kind: 'side-panel', tabId: 'changes' });
    });

    it('yields the window close accelerator on the empty surface', () => {
      expect(
        getSessionTabCloseTarget({
          ...BASE_INPUT,
          activeConversationTabId: 'empty',
          sidePanelOpen: false,
          conversationTabCount: 0,
        })
      ).toEqual({ kind: 'window' });
    });
    it('closes an available side-panel tab before yielding window close on the empty surface', () => {
      expect(
        getSessionTabCloseTarget({
          ...BASE_INPUT,
          activeConversationTabId: 'empty',
          conversationTabCount: 0,
        })
      ).toEqual({ kind: 'side-panel', tabId: 'changes' });
    });
  });
});

describe('session-tab-url', () => {
  const parentSessionId = 'parent-session-id';

  describe('shared tab closure', () => {
    it('retains the requested tab until the replica can establish its open neighbour', () => {
      expect(getSessionTabFallback('parent', ['parent'], [], false)).toBe('parent');
      expect(getSessionTabFallback('parent', ['parent', 'child'], ['child'], false)).toBe('parent');
      expect(getSessionTabFallback('parent', ['parent', 'child'], ['child'], true)).toBe('child');
      expect(getSessionTabFallback('parent', ['parent'], [], true)).toBe('empty');
    });
    it('keeps tab closure independent of archive', () => {
      const liveWorkspace = false;
      const archivedWorkspace = true;
      expect(isSessionTabClosed({}, liveWorkspace)).toBe(false);
      expect(isSessionTabClosed({ isTabClosed: true }, liveWorkspace)).toBe(true);
      // Reviewing an archived workspace shows every tab it had open.
      expect(isSessionTabClosed({ isArchived: true }, archivedWorkspace)).toBe(false);
      expect(isSessionTabClosed({ isArchived: true, isTabClosed: true }, archivedWorkspace)).toBe(
        true
      );
      // A live workspace keeps archived children out of its strip.
      expect(isSessionTabClosed({ isArchived: true, isTabClosed: false }, liveWorkspace)).toBe(
        true
      );
      expect(isSessionTabClosed({ isArchived: false, isTabClosed: false }, liveWorkspace)).toBe(
        false
      );
    });
    it('chooses the right open neighbour, then the left, then empty', () => {
      const order = ['parent', 'a', 'b', 'c'];
      expect(getSessionTabFallback('a', order, ['parent', 'c'])).toBe('c');
      expect(getSessionTabFallback('c', order, ['parent', 'a'])).toBe('a');
      expect(getSessionTabFallback('parent', order, [])).toBe('empty');
      expect(getSessionTabFallback('absent', order, ['a'])).toBe('a');
    });
  });

  describe('resolveActiveSessionTab', () => {
    const context = {
      parentSessionId,
      childSessionIdsResolvedToParent: ['child-archived', 'side-chat-1'],
      draftTabIds: ['draft:d1'],
      promotedChildSessionIdsByDraftId: {},
    };
    it('keeps an explicitly empty surface empty when new tabs arrive', () => {
      expect(resolveActiveSessionTab({ kind: 'empty' }, context)).toBe('empty');
    });

    it('resolves a missing tab to the parent (external navigation stripping ?tab converges)', () => {
      // #193: navigation that removes `?tab` while a child was active must
      // settle at the parent with no bounce-back write.
      expect(resolveActiveSessionTab({ kind: 'missing' }, context)).toBe(parentSessionId);
    });

    it('takes the URL at its word for a child the replica has not delivered yet', () => {
      // A just-promoted draft or a tab syncing from another device: the tab
      // stays ACTIVE (the caller renders a pending surface) instead of bouncing
      // back to the parent conversation. Treating a transient replica gap as
      // "this tab does not exist" is the bug this rule replaces.
      expect(
        resolveActiveSessionTab({ kind: 'session', sessionId: 'child-syncing' }, context)
      ).toBe('child-syncing');
    });

    it('resolves an archived or side-panel child to the parent (positive evidence only)', () => {
      expect(
        resolveActiveSessionTab({ kind: 'session', sessionId: 'child-archived' }, context)
      ).toBe(parentSessionId);
      // A side chat renders in the right panel and never owns a top tab, so a
      // URL addressing one (an opened-by link) must not hold a pending surface.
      expect(resolveActiveSessionTab({ kind: 'session', sessionId: 'side-chat-1' }, context)).toBe(
        parentSessionId
      );
    });

    it('follows a promotion alias when the draft is gone', () => {
      // The send instant: the draft leaves local state before the router commits
      // `session:<child>`. The alias keeps the new conversation active through
      // that window with zero frames on the parent.
      expect(
        resolveActiveSessionTab(
          { kind: 'draft', draftId: 'draft:sent' },
          { ...context, promotedChildSessionIdsByDraftId: { 'draft:sent': 'child-new' } }
        )
      ).toBe('child-new');
    });

    it('prefers a live draft over its promotion alias', () => {
      // A failed send keeps the draft; retrying reuses the same ids. The live
      // draft must win so the user stays on the composer, not a dead child.
      expect(
        resolveActiveSessionTab(
          { kind: 'draft', draftId: 'draft:d1' },
          { ...context, promotedChildSessionIdsByDraftId: { 'draft:d1': 'child-new' } }
        )
      ).toBe('draft:d1');
    });

    it('resolves an unknown draft and invalid values to the parent', () => {
      // Drafts are device-local, so absence (with no alias) is positive
      // evidence, unlike a session id.
      expect(resolveActiveSessionTab({ kind: 'draft', draftId: 'draft:gone' }, context)).toBe(
        parentSessionId
      );
      expect(resolveActiveSessionTab({ kind: 'invalid' }, context)).toBe(parentSessionId);
    });
  });
});

describe('adaptive-tab-strip', () => {
  const DEFAULT_OPTIONS = {
    gap: 6,
    paddingLeft: 4,
    paddingRight: 8,
    activeMinWidth: ACTIVE_TAB_MIN_WIDTH,
  } as const;

  function allocatedWidth(layout: AdaptiveTabStripLayout): number {
    return (
      layout.paddingLeft +
      layout.paddingRight +
      layout.items.reduce((total, item) => total + item.width + item.marginRight, 0)
    );
  }

  describe('allocateAdaptiveTabStripLayout', () => {
    it('evenly divides all tabs when every tab can be at least the minimum width', () => {
      const layout = allocateAdaptiveTabStripLayout({
        ...DEFAULT_OPTIONS,
        viewportWidth: 1000,
        itemIds: ['parent', 'one', 'two', 'three'],
        activeItemId: 'two',
      });

      const widths = layout.items.map((item) => item.width);

      expect(allocatedWidth(layout)).toBe(1000);
      expect(widths.every((width) => width >= ACTIVE_TAB_MIN_WIDTH)).toBe(true);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    });

    it('keeps the active minimum width in a narrow multi-tab viewport', () => {
      const layout = allocateAdaptiveTabStripLayout({
        ...DEFAULT_OPTIONS,
        viewportWidth: 280,
        itemIds: ['parent', 'one', 'two', 'three'],
        activeItemId: 'one',
      });

      const active = layout.items.find((item) => item.id === 'one')!;
      const inactiveWidths = layout.items
        .filter((item) => item.id !== 'one')
        .map((item) => item.width);

      expect(allocatedWidth(layout)).toBe(280);
      expect(active.width).toBe(ACTIVE_TAB_MIN_WIDTH);
      expect(inactiveWidths.every((width) => active.width > width)).toBe(true);
      expect(inactiveWidths.every((width) => width > 0)).toBe(true);
      expect(Math.max(...inactiveWidths) - Math.min(...inactiveWidths)).toBeLessThanOrEqual(1);
    });
  });
});
