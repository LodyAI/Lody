// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { LoroSidebar, type LoroSidebarProps } from '../src/components/loro-sidebar';
import { initI18n } from '../src/i18n';

const pinnedItem = {
  id: 'pinned-session',
  kind: 'github' as const,
  title: 'Pinned conversation',
  sectionLabel: 'loro-dev/lody',
  repoFullName: 'loro-dev/lody',
  branchName: 'fix/pinned-section',
  latestMessageAt: new Date('2026-07-14T08:00:00.000Z'),
  isPinned: true,
};

const baseProps: LoroSidebarProps = {
  workspaceName: 'Lody',
  userEmail: 'zixuan@loro.dev',
  workspaces: [{ id: 'workspace', name: 'Lody' }],
  currentWorkspaceId: 'workspace',
  repoSections: [],
  chats: [],
  pinnedItems: [pinnedItem],
  updatedSelectedItemId: null,
};

describe('LoroSidebar pinned section', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    vi.useFakeTimers();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function renderSidebar(props: Partial<LoroSidebarProps>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(<LoroSidebar {...baseProps} {...props} />);
    });
  }

  const flushFrame = async () => {
    await vi.advanceTimersByTimeAsync(40);
  };

  it('offers workspace context actions without switching the selected workspace', async () => {
    const previous = window.__LODY_ELECTRON__;
    window.__LODY_ELECTRON__ = true;
    try {
      let selected = 'workspace';
      renderSidebar({
        workspaces: [
          { id: 'workspace', name: 'Lody', slug: 'lody' },
          { id: 'second', name: 'Second workspace', slug: 'second' },
        ],
        onWorkspaceSelected: (value) => {
          selected = value;
        },
      });
      const trigger = container?.querySelector('[data-workspace-switcher-trigger]');
      flushSync(() => {
        trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      });
      await flushFrame();
      const target = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
      ).find((item) => item.textContent?.includes('Second workspace'));
      expect(target).toBeDefined();
      // The modifier-click hint is not a standing line; it explains itself on
      // the other workspace's row.
      expect(document.body.textContent).not.toContain('click to open in a new window');
      flushSync(() => {
        target?.focus();
      });
      expect(document.body.textContent).toContain('click to open in a new window');
      flushSync(() => {
        target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      });
      await flushFrame();
      expect(
        Array.from(document.querySelectorAll('[role="menuitem"]')).some(
          (item) => item.textContent === 'Open in new window'
        )
      ).toBe(true);
      expect(selected).toBe('workspace');
      flushSync(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      flushSync(() => {
        target?.click();
      });
      expect(selected).toBe('second');
    } finally {
      window.__LODY_ELECTRON__ = previous;
    }
  });

  it.each([
    { os: 'darwin', modifier: { metaKey: true } },
    { os: 'win32', modifier: { ctrlKey: true } },
    { os: 'linux', modifier: { ctrlKey: true } },
  ])('opens a separate workspace window on $os', async ({ os, modifier }) => {
    const previousElectron = window.__LODY_ELECTRON__;
    const previousPlatform = window.__LODY_PLATFORM__;
    const previousIpc = window.ipc;
    const windows: unknown[] = [];
    window.__LODY_ELECTRON__ = true;
    window.__LODY_PLATFORM__ = { os, homeDir: '/home/example' };
    window.ipc = {
      invoke: async (channel, target) => {
        if (channel === 'app.openWindow') windows.push(target);
      },
      on: () => () => {},
      send: () => {},
    };
    try {
      let selected = 'workspace';
      renderSidebar({
        workspaces: [
          { id: 'workspace', name: 'Lody', slug: 'lody' },
          { id: 'second', name: 'Second workspace', slug: 'second' },
        ],
        onWorkspaceSelected: (value) => {
          selected = value;
        },
      });
      flushSync(() => {
        container
          ?.querySelector('[data-workspace-switcher-trigger]')
          ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      });
      await flushFrame();
      const rows = document.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const click = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ...modifier,
        });
        flushSync(() => row.dispatchEvent(click));
        expect(click.defaultPrevented).toBe(true);
        expect(selected).toBe('workspace');
      }
      expect(windows).toEqual([
        { workspace: 'lody', sessionId: undefined },
        { workspace: 'second', sessionId: undefined },
      ]);
    } finally {
      window.__LODY_ELECTRON__ = previousElectron;
      window.__LODY_PLATFORM__ = previousPlatform;
      window.ipc = previousIpc;
    }
  });

  it('keeps workspace rows selectable in browsers', async () => {
    let selected = 'workspace';
    renderSidebar({
      workspaces: [
        { id: 'workspace', name: 'Lody', slug: 'lody' },
        { id: 'second', name: 'Second workspace', slug: 'second' },
      ],
      onWorkspaceSelected: (value) => {
        selected = value;
      },
    });
    const trigger = container?.querySelector('[data-workspace-switcher-trigger]');
    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await flushFrame();
    const target = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    ).find((item) => item.textContent?.includes('Second workspace'));
    expect(target).toBeDefined();
    // `data-disabled` is what the shared menu item styling turns into
    // `pointer-events-none`, so a row carrying it cannot be clicked at all.
    expect(target?.hasAttribute('data-disabled')).toBe(false);
    expect(target?.tagName).toBe('A');
    expect(target?.getAttribute('href')).toBe('/second/chat');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    flushSync(() => {
      target?.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(selected).toBe('second');
  });

  it.each([
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { metaKey: true, shiftKey: true },
    { button: 1 },
  ])('preserves native workspace link actions for %j', async (modifiers) => {
    let selected = 'workspace';
    renderSidebar({
      workspaces: [
        { id: 'workspace', name: 'Lody', slug: 'lody' },
        { id: 'second', name: 'Second workspace', slug: 'second' },
      ],
      onWorkspaceSelected: (value) => {
        selected = value;
      },
    });
    flushSync(() => {
      container
        ?.querySelector('[data-workspace-switcher-trigger]')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await flushFrame();
    const rows = document.querySelectorAll<HTMLAnchorElement>('a[role="menuitemradio"]');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const click = new MouseEvent(modifiers.button === 1 ? 'auxclick' : 'click', {
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      // Observe the uncancelled native action without making jsdom navigate.
      let nativeAction = false;
      const observe = (event: Event) => {
        nativeAction = !event.defaultPrevented;
        event.preventDefault();
      };
      window.addEventListener(click.type, observe, { once: true });
      flushSync(() => row.dispatchEvent(click));
      window.removeEventListener(click.type, observe);
      // Capture stops propagation for modified primary clicks; auxiliary clicks
      // reach the native action observer directly.
      expect(nativeAction || !click.defaultPrevented).toBe(true);
      expect(selected).toBe('workspace');
      expect(document.querySelector('a[role="menuitemradio"]')).not.toBeNull();
    }
  });

  it('keeps the current workspace location on ordinary selection', async () => {
    let destination = '/lody/session/current';
    renderSidebar({
      workspaces: [{ id: 'workspace', name: 'Lody', slug: 'lody' }],
      onWorkspaceSelected: () => {
        destination = '/lody/chat';
      },
    });
    flushSync(() => {
      container
        ?.querySelector('[data-workspace-switcher-trigger]')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await flushFrame();
    const row = document.querySelector<HTMLAnchorElement>('a[role="menuitemradio"]');
    expect(row).not.toBeNull();
    flushSync(() => row?.click());
    expect(destination).toBe('/lody/session/current');
  });

  it('keeps Help and Settings around the Archive exit while Archive is open', () => {
    let destination = 'archive';
    renderSidebar({
      activeNav: 'archive',
      onHomeClicked: () => {
        destination = 'home';
      },
    });

    const buttons = Array.from(container?.querySelectorAll('button') ?? []);
    expect(buttons.some((button) => button.textContent?.trim() === 'More')).toBe(false);
    const exit = buttons.find((button) => button.textContent?.trim() === 'Leave Archive');
    expect(exit).toBeDefined();
    expect(
      Array.from(exit!.closest('[data-sidebar-footer]')!.querySelectorAll('button'))
        .filter((button) => button.getAttribute('aria-label'))
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Help', 'Leave Archive', 'Settings']);
    expect(exit?.getAttribute('aria-current')).toBe('page');

    // No history to return to in the test window: leaving goes Home.
    flushSync(() => {
      exit?.click();
    });
    expect(destination).toBe('home');
  });

  it('renders pinned conversations before Workspace groups', () => {
    renderSidebar({
      organizeMode: 'workspace',
      sessionListProps: {
        sessions: [
          {
            sessionId: 'regular-session',
            title: 'Regular conversation',
            repoFullName: 'loro-dev/lody',
            branchName: 'fix/regular-session',
            latestMessageAt: new Date('2026-07-14T09:00:00.000Z'),
            addedLines: 0,
            deletedLines: 0,
            isWorking: false,
            hasUnreadMessages: false,
            isOffline: false,
            isWaitingPermission: false,
          },
        ],
        repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
      },
    });

    const pinnedRow = container?.querySelector('[data-sidebar-updated-id="pinned-session"]');
    const regularRow = container?.querySelector('[data-sidebar-session-id="regular-session"]');
    expect(pinnedRow).not.toBeNull();
    expect(regularRow).not.toBeNull();
    expect(
      pinnedRow?.compareDocumentPosition(regularRow as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('keeps the filter reachable when the workspace scope hides every section', () => {
    const onChatScopeChange = vi.fn();
    renderSidebar({
      organizeMode: 'workspace',
      chatScope: 'my',
      pinnedItems: [],
      topContent: undefined,
      onChatScopeChange,
      sessionListProps: {
        sessions: [],
        repos: [],
      },
    });

    expect(container?.querySelectorAll('button[aria-label="Filter sidebar"]')).toHaveLength(1);
    expect(container?.querySelector('[data-sidebar-empty-state="my"]')?.textContent).toContain(
      'No tasks match this view'
    );
    const showAllButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Show all tasks'
    );
    expect(showAllButton).toBeDefined();
    flushSync(() => showAllButton?.click());
    expect(onChatScopeChange).toHaveBeenCalledWith('team');
  });

  it('gives a genuinely empty All Tasks workspace its own neutral state', () => {
    renderSidebar({
      organizeMode: 'workspace',
      chatScope: 'team',
      pinnedItems: [],
      topContent: undefined,
      sessionListProps: {
        sessions: [],
        repos: [],
      },
    });

    const emptyState = container?.querySelector('[data-sidebar-empty-state="team"]');
    expect(emptyState?.textContent).toContain('No tasks yet');
    expect(emptyState?.textContent).not.toContain('Show all tasks');
  });

  it('renders pinned conversations before the Updated section', () => {
    renderSidebar({
      organizeMode: 'updated',
      updatedItems: [
        {
          id: 'updated-session',
          kind: 'chat',
          title: 'Recently updated conversation',
          sectionLabel: 'Chats',
          latestMessageAt: new Date('2026-07-14T09:00:00.000Z'),
        },
      ],
    });

    const pinnedRow = container?.querySelector('[data-sidebar-updated-id="pinned-session"]');
    const updatedRow = container?.querySelector('[data-sidebar-updated-id="updated-session"]');
    expect(pinnedRow).not.toBeNull();
    expect(updatedRow).not.toBeNull();
    expect(
      pinnedRow?.compareDocumentPosition(updatedRow as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      pinnedRow?.querySelector('[data-sidebar-updated-project="github"]')?.textContent
    ).toContain('loro-dev/lody');
    expect(
      updatedRow?.querySelector('[data-sidebar-updated-project="chat"]')?.textContent
    ).toContain('Chats');
  });

  it('does not show project context on pinned rows in Workspace mode', () => {
    renderSidebar({ organizeMode: 'workspace' });
    const pinnedRow = container?.querySelector('[data-sidebar-updated-id="pinned-session"]');
    expect(pinnedRow).not.toBeNull();
    expect(pinnedRow?.querySelector('[data-sidebar-updated-project]')).toBeNull();
  });

  it('hides project context throughout Updated mode when Project names is off', () => {
    renderSidebar({
      organizeMode: 'updated',
      showUpdatedProjectNames: false,
      updatedItems: [
        {
          id: 'updated-session',
          kind: 'chat',
          title: 'Recently updated conversation',
          sectionLabel: 'Chats',
          latestMessageAt: new Date('2026-07-14T09:00:00.000Z'),
        },
      ],
    });

    expect(container?.querySelector('[data-sidebar-updated-project]')).toBeNull();
  });

  it('collapses pinned conversations and keeps the folded chevron visible', () => {
    const onTogglePinnedSection = vi.fn();
    renderSidebar({
      pinnedSectionCollapsed: true,
      onTogglePinnedSection,
    });

    expect(container?.querySelector('[data-sidebar-updated-id="pinned-session"]')).toBeNull();
    const header = container?.querySelector('[role="button"][aria-expanded="false"]');
    expect(header?.getAttribute('aria-label')).toBe('Pinned');

    header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onTogglePinnedSection).toHaveBeenCalledOnce();
  });
});
