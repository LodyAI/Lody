// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  getSideChatLauncherState,
  getSidePanelTabCloseFallback,
  getSidePanelTabSelection,
  getSidePanelTabStateAfterClose,
  SessionSidePanelEmptyState,
  SessionSidePanelTabBar,
  type SessionSidePanelOption,
  type SessionSidePanelTabItem,
} from '../src/components/sessions/session-side-panel-tab-bar';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TABS: SessionSidePanelTabItem[] = [
  { id: 'files', label: 'Files', kind: 'files', closeable: true },
  { id: 'changes', label: 'All Changes', kind: 'changes', closeable: true },
  { id: 'browser', label: 'Browser', kind: 'browser', closeable: true },
  {
    id: 'file:src/app.tsx',
    label: 'app.tsx',
    kind: 'file',
    filePath: 'src/app.tsx',
    closeable: true,
  },
  {
    id: 'side-session:one',
    label: '(fork) First',
    kind: 'session',
    closeable: true,
  },
  {
    id: 'side-session:two',
    label: '(fork) Second',
    kind: 'session',
    closeable: true,
  },
];
const AVAILABLE_PANELS: SessionSidePanelOption[] = [{ id: 'pr', label: 'PR', kind: 'pr' }];

describe('getSidePanelTabCloseFallback', () => {
  const tabIds = ['files', 'changes', 'browser'];

  it('prefers the previous tab', () => {
    expect(getSidePanelTabCloseFallback(tabIds, 'browser')).toBe('changes');
    expect(getSidePanelTabCloseFallback(tabIds, 'changes')).toBe('files');
  });

  it('uses the next tab when closing the first tab', () => {
    expect(getSidePanelTabCloseFallback(tabIds, 'files')).toBe('changes');
  });

  it('returns null only when no tab remains', () => {
    expect(getSidePanelTabCloseFallback(['files'], 'files')).toBeNull();
  });
});

describe('getSidePanelTabStateAfterClose', () => {
  it('keeps the sidebar open while another tab remains', () => {
    expect(getSidePanelTabStateAfterClose(['files', 'changes'], 'changes')).toEqual({
      fallbackTabId: 'files',
      sidebarOpen: true,
    });
  });

  it('closes the sidebar with the last tab', () => {
    expect(getSidePanelTabStateAfterClose(['files'], 'files')).toEqual({
      fallbackTabId: null,
      sidebarOpen: false,
    });
  });

  it('ignores a close request for a tab that is no longer open', () => {
    expect(getSidePanelTabStateAfterClose(['files'], 'changes')).toEqual({
      fallbackTabId: null,
      sidebarOpen: true,
    });
  });
});

describe('getSidePanelTabSelection', () => {
  it('keeps fixed panels, side chats, and viewers mutually exclusive', () => {
    expect(getSidePanelTabSelection('side-session:forked')).toEqual({
      activeSidebarTabId: null,
      activeSideSessionId: 'forked',
      activeViewerTabId: null,
    });
    expect(getSidePanelTabSelection('file:README.md')).toEqual({
      activeSidebarTabId: null,
      activeSideSessionId: null,
      activeViewerTabId: 'file:README.md',
    });
    expect(getSidePanelTabSelection('files')).toEqual({
      activeSidebarTabId: 'files',
      activeSideSessionId: null,
      activeViewerTabId: null,
    });
  });
});

describe('getSideChatLauncherState', () => {
  it('hides unsupported providers and disables an offline supported provider', () => {
    expect(getSideChatLauncherState({ providerSupportsFork: false, machineOffline: false })).toBe(
      'hidden'
    );
    expect(getSideChatLauncherState({ providerSupportsFork: true, machineOffline: true })).toBe(
      'disabled'
    );
    expect(getSideChatLauncherState({ providerSupportsFork: true, machineOffline: false })).toBe(
      'enabled'
    );
  });
});

describe('SessionSidePanelTabBar', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const onTabSelect = vi.fn();
  const onTabClose = vi.fn();
  const onPanelOpen = vi.fn();

  beforeEach(() => {
    onTabSelect.mockClear();
    onTabClose.mockClear();
    onPanelOpen.mockClear();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  async function renderTabBar() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(SessionSidePanelTabBar, {
          tabs: TABS,
          activeTabId: 'files',
          availablePanels: AVAILABLE_PANELS,
          onTabSelect,
          onTabClose,
          onPanelOpen,
          addPanelLabel: 'Add panel',
          closeTabLabel: (label: string) => `Close ${label}`,
        })
      );
    });
  }

  it('closes both functional and dynamic viewer tabs', async () => {
    await renderTabBar();

    const closeFilesButton = container?.querySelector('[aria-label="Close Files"]');
    const closeChangesButton = container?.querySelector('[aria-label="Close All Changes"]');
    const closeBrowserButton = container?.querySelector('[aria-label="Close Browser"]');
    expect(closeFilesButton).toBeInstanceOf(HTMLButtonElement);
    expect(closeChangesButton).toBeInstanceOf(HTMLButtonElement);
    expect(closeBrowserButton).toBeInstanceOf(HTMLButtonElement);

    const closeFileButton = container?.querySelector('[aria-label="Close app.tsx"]');
    expect(closeFileButton).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (closeFilesButton as HTMLButtonElement).click();
      (closeFileButton as HTMLButtonElement).click();
    });
    expect(onTabClose.mock.calls).toEqual([['files'], ['file:src/app.tsx']]);
    expect(onTabSelect).not.toHaveBeenCalled();
  });

  it('selects fixed and dynamic tabs through the same tablist', async () => {
    await renderTabBar();

    const tabs = Array.from(container?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    await act(async () => tabs.find((tab) => tab.textContent?.includes('All Changes'))?.click());
    await act(async () => tabs.find((tab) => tab.textContent?.includes('Browser'))?.click());
    await act(async () => tabs.find((tab) => tab.textContent?.includes('app.tsx'))?.click());

    expect(onTabSelect.mock.calls).toEqual([['changes'], ['browser'], ['file:src/app.tsx']]);
  });

  it('keeps multiple side-session tabs independently selectable and closeable', async () => {
    await renderTabBar();

    const tabs = Array.from(container?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    await act(async () => tabs.find((tab) => tab.textContent?.includes('(fork) Second'))?.click());
    const closeFirstButton = container?.querySelector('[aria-label="Close (fork) First"]');
    await act(async () => (closeFirstButton as HTMLButtonElement).click());

    expect(onTabSelect).toHaveBeenCalledWith('side-session:two');
    expect(onTabClose).toHaveBeenCalledWith('side-session:one');
  });

  it('offers only unopened functional panels from the add button', async () => {
    await renderTabBar();

    const addButton = container?.querySelector('[aria-label="Add panel"]');
    expect(addButton).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      addButton?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
      );
    });

    const menuItems = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(menuItems.map((item) => item.textContent)).toEqual(['PR']);

    await act(async () => menuItems[0]?.click());
    expect(onPanelOpen).toHaveBeenCalledWith('pr');
  });

  it('opens a functional panel from the empty state', async () => {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => {
      root?.render(
        createElement(SessionSidePanelEmptyState, {
          panels: [
            { id: 'side-session', label: 'Side Chat', kind: 'session' },
            { id: 'files', label: 'Files', kind: 'files' },
            { id: 'changes', label: 'All Changes', kind: 'changes' },
          ],
          onPanelOpen,
          title: 'Open a panel',
          description: 'Choose what to show.',
        })
      );
    });

    const changesButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('All Changes')
    );
    await act(async () => changesButton?.click());
    expect(onPanelOpen).toHaveBeenCalledWith('changes');
    const sideSessionButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Side Chat')
    );
    await act(async () => sideSessionButton?.click());
    expect(onPanelOpen).toHaveBeenCalledWith('side-session');
  });
});
