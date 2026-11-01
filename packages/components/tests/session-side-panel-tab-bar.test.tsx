// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  getSideChatLauncherState,
  getSidePanelTabCloseFallback,
  getSidePanelTabSelection,
  getSidePanelTabStateAfterClose,
  getEffectiveSidePanelTabSplit,
  resolveSidePanelTabDropIntent,
  SessionSidePanelEmptyState,
  SessionSidePanelTabBar,
  type SessionSidePanelOption,
  type SessionSidePanelTabItem,
} from '../src/components/sessions/session-side-panel-tab-bar';
import { SidePanelSplitHandle } from '../src/components/sessions/side-panel-split-handle';

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

describe('resolveSidePanelTabDropIntent', () => {
  // ios [100, 200], browser [210, 300], android [310, 400]
  const targets = [
    { id: 'ios-simulator', left: 100, right: 200 },
    { id: 'android-emulator', left: 310, right: 400 },
  ];

  it('pairs a dragged device tab with the target on the side it lands', () => {
    const base = { draggedTabId: 'android-emulator', split: null, targets, group: null };
    expect(resolveSidePanelTabDropIntent({ ...base, pointerX: 120 })).toEqual({
      kind: 'split',
      split: ['android-emulator', 'ios-simulator'],
    });
    expect(resolveSidePanelTabDropIntent({ ...base, pointerX: 180 })).toEqual({
      kind: 'split',
      split: ['ios-simulator', 'android-emulator'],
    });
  });

  it('snaps back when released away from a splittable tab', () => {
    expect(
      resolveSidePanelTabDropIntent({
        draggedTabId: 'android-emulator',
        pointerX: 250,
        split: null,
        targets,
        group: null,
      })
    ).toBeNull();
  });

  it('swaps group members across the middle and detaches past the margin', () => {
    const base = {
      draggedTabId: 'ios-simulator',
      split: ['ios-simulator', 'android-emulator'] as const,
      targets: [],
      group: { left: 100, right: 300 },
    };
    expect(resolveSidePanelTabDropIntent({ ...base, pointerX: 150 })).toBeNull();
    expect(resolveSidePanelTabDropIntent({ ...base, pointerX: 250 })).toEqual({
      kind: 'split',
      split: ['android-emulator', 'ios-simulator'],
    });
    // Inside the margin it is still a swap, not a detach.
    expect(resolveSidePanelTabDropIntent({ ...base, pointerX: 310 })?.kind).toBe('split');
    expect(resolveSidePanelTabDropIntent({ ...base, pointerX: 330 })).toEqual({
      kind: 'unsplit',
      tabId: 'ios-simulator',
    });
    expect(resolveSidePanelTabDropIntent({ ...base, pointerX: 60 })).toEqual({
      kind: 'unsplit',
      tabId: 'ios-simulator',
    });
  });
});

describe('getEffectiveSidePanelTabSplit', () => {
  it('drops a split once either member leaves the strip', () => {
    const split = ['ios-simulator', 'android-emulator'] as const;
    expect(getEffectiveSidePanelTabSplit(split, ['files', ...split])).toBe(split);
    expect(getEffectiveSidePanelTabSplit(split, ['files', 'ios-simulator'])).toBeNull();
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
      await new Promise((resolve) => setTimeout(resolve, 40));
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
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const menuItems = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(menuItems.map((item) => item.textContent)).toEqual(['PR']);

    await act(async () => menuItems[0]?.click());
    expect(onPanelOpen).toHaveBeenCalledWith('pr');
  });

  it('draws a split pair as one group in split order that still selects each member', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(SessionSidePanelTabBar, {
          tabs: [
            { id: 'files', label: 'Files', kind: 'files', closeable: true },
            { id: 'ios-simulator', label: 'iOS', kind: 'ios-simulator', closeable: true },
            { id: 'browser', label: 'Browser', kind: 'browser', closeable: true },
            { id: 'android-emulator', label: 'Android', kind: 'android-emulator', closeable: true },
          ],
          activeTabId: 'ios-simulator',
          onTabSelect,
          onTabClose,
          closeTabLabel: (label: string) => `Close ${label}`,
          split: ['android-emulator', 'ios-simulator'],
          onTabsSplit: () => undefined,
          onTabUnsplit: () => undefined,
        })
      );
    });

    const strip = Array.from(
      container.querySelectorAll<HTMLElement>('[role="tablist"] > *'),
      (element) =>
        element.getAttribute('role') === 'group'
          ? `[${Array.from(element.querySelectorAll('[role="tab"]'), (tab) => tab.textContent).join('|')}]`
          : element.textContent
    );
    expect(strip).toEqual(['Files', '[Android|iOS]', 'Browser']);

    const android = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (tab) => tab.textContent === 'Android'
    );
    await act(async () => android?.click());
    expect(onTabSelect).toHaveBeenCalledWith('android-emulator');
    await act(async () =>
      container?.querySelector<HTMLButtonElement>('[aria-label="Close Android"]')?.click()
    );
    expect(onTabClose).toHaveBeenCalledWith('android-emulator');
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

describe('SidePanelSplitHandle', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  async function renderHandle(initialRatio: number) {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      width: 400,
    } as DOMRect);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    const ratios: number[] = [];
    let ratio = initialRatio;
    root = createRoot(container);
    const render = async () =>
      act(async () => {
        root?.render(
          createElement(SidePanelSplitHandle, {
            ratio,
            label: 'Resize split view',
            onRatioChange: (next: number) => {
              ratio = next;
              ratios.push(next);
              void render();
            },
          })
        );
      });
    await render();
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    return { handle, ratios };
  }

  const pointer = (type: string, clientX: number) =>
    Object.assign(new MouseEvent(type, { bubbles: true, button: 0, clientX }), { pointerId: 1 });

  it('follows the pointer across the panel within the quarter bounds, behind a drag shield', async () => {
    const { handle, ratios } = await renderHandle(0.5);
    await act(async () => handle.dispatchEvent(pointer('pointerdown', 300)));
    expect(container?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    await act(async () => handle.dispatchEvent(pointer('pointermove', 220)));
    await act(async () => handle.dispatchEvent(pointer('pointermove', 120)));
    await act(async () => handle.dispatchEvent(pointer('pointerup', 120)));
    await act(async () => handle.dispatchEvent(pointer('pointermove', 480)));

    expect(ratios).toEqual([0.3, 0.25]);
    expect(handle.getAttribute('aria-valuenow')).toBe('25');
    expect(container?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  });

  it('steps with the arrow keys and resets on double click', async () => {
    const { handle, ratios } = await renderHandle(0.7);
    const key = (name: string) =>
      act(async () => {
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
      });
    await key('ArrowRight');
    await key('ArrowRight');
    await key('Home');
    await act(async () => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));

    expect(ratios.map((value) => Math.round(value * 100))).toEqual([75, 75, 25, 50]);
  });
});
