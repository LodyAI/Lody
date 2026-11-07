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
  });

  function renderSidebar(props: Partial<LoroSidebarProps>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(<LoroSidebar {...baseProps} {...props} />);
    });
  }

  // Base UI defers the menu's portal mount to a frame; jsdom's rAF is a real
  // timer, so give it a beat after opening.
  const flushFrame = async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
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
    flushSync(() => {
      target?.click();
    });
    expect(selected).toBe('second');
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

  it('expands and collapses pinned conversations through the section control', () => {
    let collapsed = true;
    const onTogglePinnedSection = () => {
      collapsed = !collapsed;
      root?.render(
        <LoroSidebar
          {...baseProps}
          pinnedSectionCollapsed={collapsed}
          onTogglePinnedSection={onTogglePinnedSection}
        />
      );
    };
    renderSidebar({
      pinnedSectionCollapsed: true,
      onTogglePinnedSection,
    });

    expect(container?.querySelector('[data-sidebar-updated-id="pinned-session"]')).toBeNull();
    const header = container?.querySelector('[role="button"][aria-expanded="false"]');
    expect(header?.getAttribute('aria-label')).toBe('Pinned');

    flushSync(() => header?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelector('[data-sidebar-updated-id="pinned-session"]')).not.toBeNull();

    flushSync(() => header?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('[data-sidebar-updated-id="pinned-session"]')).toBeNull();
  });

  it.each([false, true])(
    'keeps the desktop collapse toggle directly actionable (Electron=%s)',
    (isElectron) => {
      let collapsed = false;
      renderSidebar({
        isElectron,
        onRequestCollapse: () => {
          collapsed = true;
        },
      });

      const button = container?.querySelector<HTMLButtonElement>(
        'button[aria-label="Toggle Sidebar"]'
      );
      expect(button).not.toBeNull();
      flushSync(() => button?.click());
      expect(collapsed).toBe(true);
    }
  );
});
