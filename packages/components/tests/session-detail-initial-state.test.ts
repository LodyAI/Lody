import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import { getSessionDetailInitialTabState } from '../src/lib/session-detail-initial-state';
import type { PersistedLastActiveTabState } from '../src/lib/session-draft-tabs';

const parentSessionId = 'parent-session' as SessionId;

const persistedProviderFileState: PersistedLastActiveTabState = {
  sessionTabId: 'child-session',
  viewerTab: {
    id: 'file:file-1',
    type: 'file',
    filePath: 'src/renamed.ts',
    fileId: 'file-1',
    label: 'renamed.ts',
    startLine: 4,
    endLine: 8,
    focusRequestSeq: 2,
  },
  sidePanel: {
    open: true,
    tab: 'browser',
    tabs: ['files', 'browser'],
    sideSessionId: 'side-session-1',
  },
};

describe('getSessionDetailInitialTabState', () => {
  it('restores the persisted viewer and side-panel state', () => {
    // The active conversation tab is NOT part of this state: the `?tab`
    // search value owns it, and the session route's entry restoration fills
    // an absent value in before the component renders. Local storage owns the
    // panels, which restore regardless of how `?tab` arrived.
    expect(
      getSessionDetailInitialTabState(parentSessionId, undefined, {
        readPersistedState: () => persistedProviderFileState,
      })
    ).toEqual({
      viewerTabs: [persistedProviderFileState.viewerTab],
      activeViewerTabId: 'file:file-1',
      sidePanel: {
        open: true,
        tab: 'browser',
        tabs: ['files', 'browser'],
        sideSessionId: 'side-session-1',
      },
    });
  });

  it('keeps the restored viewer idle for an explicit conversation deep link on one-active-surface hosts', () => {
    // Mobile shows one surface at a time: an opened-by or shared link naming
    // `session:<child>` must land on that conversation, not under the
    // restored full-screen viewer. The viewer stays as an open tab.
    expect(
      getSessionDetailInitialTabState(parentSessionId, 'session:url-child', {
        oneActiveSurface: true,
        readPersistedState: () => persistedProviderFileState,
      })
    ).toEqual({
      viewerTabs: [persistedProviderFileState.viewerTab],
      activeViewerTabId: null,
      sidePanel: persistedProviderFileState.sidePanel,
    });
    expect(
      getSessionDetailInitialTabState(parentSessionId, 'draft:draft-uuid', {
        oneActiveSurface: true,
        readPersistedState: () => persistedProviderFileState,
      }).activeViewerTabId
    ).toBeNull();
    // No explicit conversation target (entry restoration will fill the tab):
    // the viewer stays active exactly as the user left it.
    expect(
      getSessionDetailInitialTabState(parentSessionId, undefined, {
        oneActiveSurface: true,
        readPersistedState: () => persistedProviderFileState,
      }).activeViewerTabId
    ).toBe('file:file-1');
  });

  it('keeps the viewer active for explicit deep links on desktop (side panel is a second surface)', () => {
    expect(
      getSessionDetailInitialTabState(parentSessionId, 'session:url-child', {
        readPersistedState: () => persistedProviderFileState,
      }).activeViewerTabId
    ).toBe('file:file-1');
  });

  it('defaults everything when nothing is persisted', () => {
    expect(
      getSessionDetailInitialTabState(parentSessionId, undefined, {
        readPersistedState: () => null,
      })
    ).toEqual({
      viewerTabs: [],
      activeViewerTabId: null,
      sidePanel: {
        open: false,
        tab: null,
        tabs: [],
        sideSessionId: null,
      },
    });
  });

  it('defaults the side panel state when older persisted state has no side panel entry', () => {
    expect(
      getSessionDetailInitialTabState(parentSessionId, undefined, {
        readPersistedState: () => ({
          sessionTabId: 'child-session',
          viewerTab: null,
        }),
      })
    ).toEqual({
      viewerTabs: [],
      activeViewerTabId: null,
      sidePanel: {
        open: false,
        tab: null,
        tabs: [],
        sideSessionId: null,
      },
    });
  });
});
