import { EMPTY_SESSION_TAB_ID } from '@/lib/session-tab-url';

export type SessionTabFocusRegion = 'conversation' | 'side-panel';

export type SessionTabCloseTarget =
  | { kind: 'conversation'; tabId: string }
  | { kind: 'side-panel'; tabId: string }
  | { kind: 'window' };

export function getSessionTabCloseTarget({
  focusRegion,
  sidePanelOpen,
  activeSidePanelTabId,
  activeConversationTabId,
  conversationTabCount,
}: {
  focusRegion: SessionTabFocusRegion;
  sidePanelOpen: boolean;
  activeSidePanelTabId: string | null;
  activeConversationTabId: string;
  parentConversationTabId: string;
  conversationTabCount: number;
}): SessionTabCloseTarget | null {
  if (focusRegion === 'side-panel' && sidePanelOpen) {
    if (activeSidePanelTabId) return { kind: 'side-panel', tabId: activeSidePanelTabId };
    return activeConversationTabId === EMPTY_SESSION_TAB_ID ? { kind: 'window' } : null;
  }
  if (activeConversationTabId !== EMPTY_SESSION_TAB_ID) {
    if (conversationTabCount === 1) return { kind: 'window' };
    return { kind: 'conversation', tabId: activeConversationTabId };
  }
  if (sidePanelOpen && activeSidePanelTabId) {
    return { kind: 'side-panel', tabId: activeSidePanelTabId };
  }
  return { kind: 'window' };
}
