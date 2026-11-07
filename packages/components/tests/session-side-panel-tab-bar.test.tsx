// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { frame, visualElementStore } from 'framer-motion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  getSidePanelTabCloseFallback,
  getSidePanelTabSelection,
  getSidePanelTabStateAfterClose,
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

async function settleLayout() {
  await act(async () => {
    await new Promise<void>((resolve) => frame.postRender(() => resolve()));
    await new Promise<void>((resolve) => frame.postRender(() => resolve()));
  });
}

function getProjection(element: Element) {
  const projection = visualElementStore.get(element)?.projection;
  if (!projection) throw new Error('Expected the real tab Motion projection');
  return projection;
}

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

  it('keeps multiple side-session tabs independently selectable and closeable', async () => {
    await renderTabBar();

    const tabs = Array.from(container?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    await act(async () => tabs.find((tab) => tab.textContent?.includes('(fork) Second'))?.click());
    const closeFirstButton = container?.querySelector('[aria-label="Close (fork) First"]');
    await act(async () => (closeFirstButton as HTMLButtonElement).click());

    expect(onTabSelect).toHaveBeenCalledWith('side-session:two');
    expect(onTabClose).toHaveBeenCalledWith('side-session:one');
  });

  it('releases Review tab layout ownership after close and repeated session unmounts', async () => {
    function ReviewTabs() {
      const [tabs, setTabs] = useState<SessionSidePanelTabItem[]>([
        { id: 'changes', label: 'All Changes', kind: 'changes', closeable: true },
        { id: 'diff:all-changes', label: 'Review diff', kind: 'diff', closeable: true },
      ]);
      return createElement(SessionSidePanelTabBar, {
        tabs,
        activeTabId: tabs.at(-1)?.id ?? null,
        onTabSelect: () => undefined,
        onTabClose: (id: string) => setTabs((current) => current.filter((tab) => tab.id !== id)),
        closeTabLabel: (label: string) => `Close ${label}`,
      });
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    for (let cycle = 0; cycle < 3; cycle++) {
      await act(async () => root?.render(createElement(ReviewTabs)));
      await settleLayout();
      const [changes, diff] = Array.from(container.querySelectorAll('[role="tab"]'), getProjection);
      const projectionRoot = changes.root!;
      const changesId = changes.options.layoutId!;
      const diffId = diff.options.layoutId!;
      expect(projectionRoot.sharedNodes.get(changesId)?.members).toContain(changes);
      expect(projectionRoot.sharedNodes.get(diffId)?.members).toContain(diff);

      await act(async () =>
        container?.querySelector<HTMLButtonElement>('[aria-label="Close Review diff"]')?.click()
      );
      await settleLayout();
      expect(projectionRoot.sharedNodes.has(diffId)).toBe(false);
      expect(projectionRoot.sharedNodes.get(changesId)?.members).toContain(changes);

      await act(async () => root?.render(null));
      await settleLayout();
      expect(projectionRoot.sharedNodes.has(changesId)).toBe(false);
    }
  });

  it('preserves device tab shared-layout handoff and releases the completed owner', async () => {
    const devices: SessionSidePanelTabItem[] = [
      { id: 'ios-simulator', label: 'iOS', kind: 'ios-simulator', closeable: true },
      { id: 'android-emulator', label: 'Android', kind: 'android-emulator', closeable: true },
    ];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const renderDevices = (split: readonly [string, string] | null) =>
      act(() =>
        root?.render(
          createElement(SessionSidePanelTabBar, {
            tabs: devices,
            activeTabId: 'ios-simulator',
            split,
            onTabSelect,
            onTabClose,
            onTabsSplit: () => undefined,
            onTabUnsplit: () => undefined,
            closeTabLabel: (label: string) => `Close ${label}`,
          })
        )
      );
    renderDevices(null);
    await settleLayout();
    const previous = getProjection(container.querySelector('[role="tab"]')!);
    const projectionRoot = previous.root!;
    const layoutId = previous.options.layoutId!;

    renderDevices(['ios-simulator', 'android-emulator']);
    const next = getProjection(container.querySelector('[role="group"] [role="tab"]')!);
    expect(next).not.toBe(previous);
    expect(next.options.layoutId).toBe(layoutId);
    expect(projectionRoot.sharedNodes.get(layoutId)?.lead).toBe(next);
    expect(next.resumeFrom).toBe(previous);
    await settleLayout();
    expect(projectionRoot.sharedNodes.get(layoutId)?.members).toContain(next);

    const layoutIds = Array.from(
      container.querySelectorAll('[role="tab"]'),
      (tab) => getProjection(tab).options.layoutId!
    );
    await act(async () => root?.render(null));
    await settleLayout();
    for (const id of layoutIds) expect(projectionRoot.sharedNodes.has(id)).toBe(false);
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
});
