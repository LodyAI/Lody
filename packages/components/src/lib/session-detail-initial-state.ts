import type { SessionId } from '@lody/shared';
import {
  readStoredLastActiveTabState,
  type PersistedLastActiveTabState,
  type PersistedSidePanelState,
  type PersistedViewerTab,
} from './session-draft-tabs';
import { parseSessionTabSearch } from './session-tab-url';

const DEFAULT_SIDE_PANEL_STATE: PersistedSidePanelState = {
  open: false,
  tab: null,
  tabs: [],
  sideSessionId: null,
};

export type SessionDetailInitialTabState = {
  readonly viewerTabs: PersistedViewerTab[];
  readonly activeViewerTabId: string | null;
  readonly sidePanel: PersistedSidePanelState;
};

export type SessionDetailInitialTabStateOptions = {
  /**
   * Mobile shows ONE active surface: an explicit conversation deep link
   * (`?tab=session:<id>` / `?tab=draft:<id>`) must not arrive under a
   * restored full-screen viewer, so the viewer restores as an open-but-idle
   * tab there. Desktop viewers live in the side panel and stay active.
   */
  readonly oneActiveSurface?: boolean;
  readonly readPersistedState?: (parentSessionId: SessionId) => PersistedLastActiveTabState | null;
};

/**
 * Per-session local UI restored on entering `SessionDetail`. The active
 * conversation tab is NOT part of this state: the `?tab` search value owns it,
 * and the session route's entry restoration fills an absent value in before
 * this component renders. Local storage owns the side panel and viewer tabs,
 * so they restore regardless of how `?tab` arrived (restored or deep link).
 */
export const getSessionDetailInitialTabState = (
  parentSessionId: SessionId,
  urlTab?: string,
  options: SessionDetailInitialTabStateOptions = {}
): SessionDetailInitialTabState => {
  const persistedState =
    options.readPersistedState?.(parentSessionId) ?? readStoredLastActiveTabState(parentSessionId);
  const viewerTab = persistedState?.viewerTab ?? null;
  const parsedUrlTab = parseSessionTabSearch(urlTab);
  const urlNamesConversationTab = parsedUrlTab.kind === 'session' || parsedUrlTab.kind === 'draft';

  return {
    viewerTabs: viewerTab ? [viewerTab] : [],
    activeViewerTabId:
      options.oneActiveSurface && urlNamesConversationTab ? null : (viewerTab?.id ?? null),
    sidePanel: persistedState?.sidePanel ?? DEFAULT_SIDE_PANEL_STATE,
  };
};
