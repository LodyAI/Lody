import { describe, expect, it } from 'vitest';
import { getSessionTabCloseTarget } from '../src/components/sessions/session-tab-close-target';

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

  it('closes the active child conversation when the conversation region has focus', () => {
    expect(getSessionTabCloseTarget(BASE_INPUT)).toEqual({
      kind: 'conversation',
      tabId: 'child-session',
    });
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

  it('does nothing when the focused side panel is open but has no tabs', () => {
    expect(
      getSessionTabCloseTarget({
        ...BASE_INPUT,
        focusRegion: 'side-panel',
        activeSidePanelTabId: null,
      })
    ).toBeNull();
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

  it('closes the window when the last-focused panel is hidden and one conversation remains', () => {
    expect(
      getSessionTabCloseTarget({
        ...BASE_INPUT,
        focusRegion: 'side-panel',
        sidePanelOpen: false,
        conversationTabCount: 1,
      })
    ).toEqual({ kind: 'window' });
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
