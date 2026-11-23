// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { LoroSidebar, type LoroSidebarProps } from '../src/components/loro-sidebar';
import { initI18n } from '../src/i18n';
import { moveRowIntoSection } from '../src/components/pinned-rows-dnd';
import {
  armSessionMentionDrag,
  clearSessionMentionDrag,
  getInFlightSessionMentionDragId,
} from '../src/lib/session-mention-drag';
import { endPinnedDropSettle } from '../src/lib/pinned-drop-settle';

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

  it('renders user pin sections after the default one, keeping the manual order of their rows', () => {
    const chat = (id: string, minutesAgo: number) => ({
      id,
      kind: 'chat' as const,
      title: id,
      sectionLabel: 'Chats',
      latestMessageAt: new Date(Date.UTC(2026, 6, 14, 9, 60 - minutesAgo)),
      isPinned: true,
    });
    renderSidebar({
      pinnedItems: [chat('loose', 1), chat('weekly-mirror', 50), chat('deps-bump', 2)],
      pinnedSections: [
        { id: null, name: 'Pinned', items: [chat('loose', 1)] },
        {
          id: 'maintenance',
          name: 'Maintenance',
          // Manual order: the older conversation stays first.
          items: [chat('weekly-mirror', 50), chat('deps-bump', 2)],
        },
        { id: 'empty', name: 'Empty section', items: [] },
      ],
    });

    const sections = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-pin-section]') ?? []
    ).map((section) => [
      section.getAttribute('data-pin-section'),
      Array.from(section.querySelectorAll('[data-sidebar-updated-id]')).map((row) =>
        row.getAttribute('data-sidebar-updated-id')
      ),
    ]);
    expect(sections).toEqual([
      ['default', ['loose']],
      ['maintenance', ['weekly-mirror', 'deps-bump']],
      ['empty', []],
    ]);
    expect(container?.textContent).toContain('Maintenance');
    expect(container?.textContent).toContain('Empty section');
  });

  it('collapses one user section without folding the others', () => {
    const onTogglePinSection = vi.fn();
    renderSidebar({
      pinnedSections: [
        { id: null, name: 'Pinned', items: [pinnedItem] },
        { id: 'maintenance', name: 'Maintenance', items: [] },
      ],
      collapsedPinSectionIds: { maintenance: true },
      onTogglePinSection,
    });
    expect(container?.querySelector('[data-sidebar-updated-id="pinned-session"]')).not.toBeNull();
    const header = container?.querySelector(
      '[data-pin-section="maintenance"] [role="button"][aria-expanded="false"]'
    );
    header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onTogglePinSection).toHaveBeenCalledWith('maintenance');
  });

  it('hides pin sections on this device and toggles them back from the first header menu', async () => {
    const actions = {
      onDropItem: () => {},
      onMoveSection: () => {},
      onCreateSection: () => {},
      onRenameSection: () => {},
      onDeleteSection: () => {},
    };
    const sections = [
      { id: null, name: 'Pinned', items: [pinnedItem] },
      { id: 'maintenance', name: 'Maintenance', items: [] },
    ];
    function Harness() {
      const [hidden, setHidden] = useState<Record<string, boolean>>({});
      return (
        <LoroSidebar
          {...baseProps}
          pinnedSections={sections}
          pinSectionActions={actions}
          hiddenPinSectionKeys={hidden}
          onSetPinSectionHidden={(key, value) => setHidden((prev) => ({ ...prev, [key]: value }))}
        />
      );
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(<Harness />));
    const renderedSections = () =>
      Array.from(container?.querySelectorAll('[data-pin-section]') ?? []).map((section) =>
        section.getAttribute('data-pin-section')
      );
    const menuItem = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) =>
        item.textContent?.startsWith(label)
      );
    const click = async (target: Element | null | undefined) => {
      flushSync(() => (target as HTMLElement | null | undefined)?.click());
      await flushFrame();
    };
    const headerMenu = () => container?.querySelectorAll('[aria-label="Section actions"]') ?? [];

    const toggle = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')).find((item) =>
        item.textContent?.startsWith(label)
      );

    await click(headerMenu()[0]);
    await click(menuItem('Visible Sections'));
    expect(toggle('Maintenance')?.getAttribute('aria-checked')).toBe('true');
    await click(toggle('Maintenance'));
    expect(renderedSections()).toEqual(['default']);
    expect(container?.textContent).not.toContain('Maintenance');
    expect(toggle('Maintenance')?.getAttribute('aria-checked')).toBe('false');
    await click(toggle('Pinned'));
    expect(renderedSections()).toEqual([]);
    expect(container?.querySelector('[data-sidebar-updated-id="pinned-session"]')).toBeNull();
    expect(headerMenu()).toHaveLength(1);
    expect(toggle('Pinned')?.getAttribute('aria-checked')).toBe('false');
    await click(toggle('Maintenance'));
    expect(renderedSections()).toEqual(['maintenance']);
    expect(toggle('Maintenance')?.getAttribute('aria-checked')).toBe('true');
    await click(menuItem('Show All'));
    expect(renderedSections()).toEqual(['default', 'maintenance']);
  });

  it('names the rows a scope hides inside an expanded pin section', () => {
    renderSidebar({
      pinnedItems: [pinnedItem],
      pinnedSections: [
        { id: null, name: 'Pinned', items: [pinnedItem] },
        { id: 'maintenance', name: 'Maintenance', items: [] },
      ],
      pinnedHiddenCounts: { default: 1, maintenance: 3 },
    });
    const sections = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-pin-section]') ?? []
    ).map((section) => [
      section.getAttribute('data-pin-section'),
      section.querySelector('[data-pin-section-hidden-count]')?.textContent,
    ]);
    expect(sections).toEqual([
      ['default', '1 session hidden'],
      ['maintenance', '3 sessions hidden'],
    ]);
  });

  it('hides the hidden-row count inside a folded pin section', () => {
    renderSidebar({
      pinnedItems: [pinnedItem],
      pinnedSections: [
        { id: null, name: 'Pinned', items: [pinnedItem] },
        { id: 'maintenance', name: 'Maintenance', items: [] },
      ],
      pinnedHiddenCounts: { maintenance: 3 },
      collapsedPinSectionIds: { maintenance: true },
    });
    expect(container?.querySelector('[data-pin-section-hidden-count]')).toBeNull();
  });

  it('moves a pinned conversation to another section from its context menu', async () => {
    const onDropItem = vi.fn();
    renderSidebar({
      pinnedSections: [
        { id: null, name: 'Pinned', items: [pinnedItem] },
        { id: 'maintenance', name: 'Maintenance', items: [] },
      ],
      onToggleUpdatedItemPinned: () => {},
      pinSectionActions: {
        onDropItem,
        onMoveSection: () => {},
        onCreateSection: () => {},
        onRenameSection: () => {},
        onDeleteSection: () => {},
      },
    });
    const row = container?.querySelector('[data-sidebar-updated-id="pinned-session"]');
    flushSync(() => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    });
    await flushFrame();
    const trigger = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent === 'Move to Section'
    );
    expect(trigger).toBeDefined();
    flushSync(() => trigger?.click());
    await flushFrame();
    const target = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent === 'Maintenance'
    );
    expect(target).toBeDefined();
    flushSync(() => target?.click());
    // "Move to Section" puts it at the top of that section.
    expect(onDropItem).toHaveBeenCalledWith('pinned-session', 'maintenance', 0);
  });

  it('keeps rows a pinned root opened at any depth in its section, without Move to Section', async () => {
    const chat = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      kind: 'chat' as const,
      title: id,
      sectionLabel: 'Chats',
      latestMessageAt: new Date(Date.UTC(2026, 6, 14, 9, 0)),
      ...extra,
    });
    const root = chat('root', { isPinned: true });
    const child = chat('child', { openedByRowSessionId: 'root' });
    const grandchild = chat('grandchild', { openedByRowSessionId: 'child' });
    renderSidebar({
      pinnedItems: [root, child, grandchild],
      pinnedSections: [
        { id: null, name: 'Pinned', items: [] },
        { id: 'maintenance', name: 'Maintenance', items: [root, child, grandchild] },
      ],
      onToggleUpdatedItemPinned: () => {},
      pinSectionActions: {
        onDropItem: () => {},
        onMoveSection: () => {},
        onCreateSection: () => {},
        onRenameSection: () => {},
        onDeleteSection: () => {},
      },
    });

    const section = container?.querySelector('[data-pin-section="maintenance"]');
    expect(
      Array.from(section?.querySelectorAll('[data-sidebar-updated-id]') ?? []).map((row) =>
        row.getAttribute('data-sidebar-updated-id')
      )
    ).toEqual(['root', 'child', 'grandchild']);

    const row = container?.querySelector('[data-sidebar-updated-id="grandchild"]');
    flushSync(() => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    });
    await flushFrame();
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
      (item) => item.textContent
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items).not.toContain('Move to Section');
  });

  it('places Status rows by the clock the layout was planned at', () => {
    const wakeAt = Date.now() + 60 * 60_000;
    renderSidebar({
      organizeMode: 'status',
      updatedItems: [
        {
          id: 'snoozed',
          kind: 'chat',
          title: 'snoozed',
          sectionLabel: 'Chats',
          latestMessageAt: new Date(Date.now() - 60_000),
          snoozedUntil: wakeAt,
        },
      ],
      updatedBucketsCollapsed: { later: false },
      onDropFocusItem: () => {},
      statusNow: new Date(wakeAt + 60_000),
    });

    const focus = container?.querySelector('[data-pin-section="__status_focus__"]');
    expect(focus?.querySelector('[data-sidebar-updated-id="snoozed"]')).not.toBeNull();
  });

  describe('dragging a conversation into a pin section', () => {
    const chat = (id: string) => ({
      id,
      kind: 'chat' as const,
      title: id,
      sectionLabel: 'Chats',
      latestMessageAt: new Date('2026-07-14T08:00:00.000Z'),
      isPinned: true,
    });
    const actions = () => ({
      onDropItem: vi.fn(),
      onMoveSection: vi.fn(),
      onCreateSection: () => {},
      onRenameSection: () => {},
      onDeleteSection: () => {},
    });
    const drag = (
      target: Element | null | undefined,
      type: 'dragover' | 'drop' | 'dragleave',
      clientY = 0
    ) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, {
        clientX: 20,
        clientY,
        relatedTarget: null,
        dataTransfer: { dropEffect: 'none', types: [] },
      });
      flushSync(() => target?.dispatchEvent(event));
      return event as Event & { dataTransfer: { dropEffect: string } };
    };

    afterEach(() => {
      clearSessionMentionDrag();
      endPinnedDropSettle();
    });

    /** jsdom has no layout: give each row slot of a section a 40px height on a 41px pitch. */
    const layoutRows = (sectionId: string) => {
      const nodes = container?.querySelectorAll<HTMLElement>(
        `[data-pin-section="${sectionId}"] [data-pin-node]`
      );
      nodes?.forEach((node, index) => {
        Object.defineProperty(node, 'offsetTop', { configurable: true, value: index * 41 });
        Object.defineProperty(node, 'offsetHeight', { configurable: true, value: 40 });
      });
    };
    const node = (id: string) =>
      container?.querySelector<HTMLElement>(`[data-pin-node="${id}"]`) ?? null;
    const shiftOf = (id: string) => {
      const match = /translateY\((-?\d+)px\)/.exec(node(id)?.style.transform ?? '');
      return match ? Number(match[1]) : 0;
    };

    it('opens a gap under the pointer in another section and drops into it', () => {
      const pinSectionActions = actions();
      renderSidebar({
        pinnedSections: [
          { id: null, name: 'Pinned', items: [chat('mover')] },
          { id: 'maintenance', name: 'Maintenance', items: [chat('m1'), chat('m2')] },
        ],
        pinSectionActions,
      });
      layoutRows('maintenance');
      armSessionMentionDrag('mover');
      const target = container?.querySelector('[data-sidebar-updated-id="m2"]');
      // Below m1's middle (20px), above m2's (61px).
      expect(drag(target, 'dragover', 50).defaultPrevented).toBe(true);
      expect(shiftOf('m1')).toBe(0);
      expect(shiftOf('m2')).toBeGreaterThan(0);
      // The section the row left gives back its slot as the target opens one.
      const rowsOf = (sectionId: string) =>
        container?.querySelector<HTMLElement>(`[data-pin-section="${sectionId}"] [data-pin-node]`)
          ?.parentElement;
      expect(Number.parseFloat(rowsOf('default')?.style.marginBottom ?? '0')).toBeLessThan(0);
      expect(Number.parseFloat(rowsOf('maintenance')?.style.paddingBottom ?? '0')).toBeGreaterThan(
        0
      );
      const drop = drag(target, 'drop', 50);
      expect(drop.defaultPrevented).toBe(true);
      expect(pinSectionActions.onDropItem).toHaveBeenCalledWith('mover', 'maintenance', 1);
    });

    it('keeps the gap and a move cursor while the pointer crosses rows inside the section', () => {
      renderSidebar({
        pinnedSections: [
          { id: null, name: 'Pinned', items: [chat('mover')] },
          { id: 'maintenance', name: 'Maintenance', items: [chat('m1'), chat('m2')] },
        ],
        pinSectionActions: actions(),
      });
      layoutRows('maintenance');
      const section = container?.querySelector<HTMLElement>('[data-pin-section="maintenance"]');
      if (section) {
        section.getBoundingClientRect = () => new DOMRect(0, -30, 280, 140);
      }
      armSessionMentionDrag('mover');
      const target = container?.querySelector('[data-sidebar-updated-id="m2"]');
      expect(drag(target, 'dragover', 50).dataTransfer.dropEffect).toBe('move');
      // Chrome reports no relatedTarget when the pointer moves onto a child row.
      drag(target, 'dragleave', 50);
      expect(shiftOf('m2')).toBeGreaterThan(0);
    });

    it('holds the gap until the moved row arrives, then flies it into its slot', () => {
      const props = (ids: string[]): Partial<LoroSidebarProps> => ({
        pinnedSections: [{ id: null, name: 'Pinned', items: ids.map(chat) }],
        pinSectionActions: actions(),
      });
      renderSidebar(props(['a', 'b', 'c']));
      layoutRows('default');
      armSessionMentionDrag('a');
      const target = container?.querySelector('[data-sidebar-updated-id="c"]');
      drag(target, 'dragover', 110);
      drag(target, 'drop', 110);
      // No dragend may follow: the source row can unmount when the drop moves it.
      expect(getInFlightSessionMentionDragId()).toBeNull();
      // The move has not been written yet, so nothing may snap back.
      expect(shiftOf('b')).toBeLessThan(0);
      expect(document.querySelector('[data-pin-drop-flight]')).toBeNull();

      flushSync(() => {
        root?.render(<LoroSidebar {...baseProps} {...props(['b', 'c', 'a'])} />);
      });
      expect(shiftOf('b')).toBe(0);
      expect(shiftOf('c')).toBe(0);
      // The row waits under its flying copy, then takes its place.
      expect(node('a')?.style.opacity).toBe('0');
      const flight = document.querySelector('[data-pin-drop-flight]');
      expect(flight).not.toBeNull();
      flushSync(() => flight?.dispatchEvent(new Event('transitionend', { bubbles: true })));
      expect(document.querySelector('[data-pin-drop-flight]')).toBeNull();
      expect(node('a')?.style.opacity ?? '').toBe('');
    });

    it('gives up waiting for a move that never lands', async () => {
      renderSidebar({
        pinnedSections: [{ id: null, name: 'Pinned', items: [chat('a'), chat('b')] }],
        pinSectionActions: actions(),
      });
      layoutRows('default');
      armSessionMentionDrag('a');
      const target = container?.querySelector('[data-sidebar-updated-id="b"]');
      drag(target, 'dragover', 70);
      drag(target, 'drop', 70);
      expect(node('a')?.style.opacity).toBe('0');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(node('a')?.style.opacity ?? '').toBe('');
      expect(shiftOf('b')).toBe(0);
    });

    it('closes the dragged row’s slot and lets the rows it passes move up', () => {
      const pinSectionActions = actions();
      renderSidebar({
        pinnedSections: [{ id: null, name: 'Pinned', items: [chat('a'), chat('b'), chat('c')] }],
        pinSectionActions,
      });
      layoutRows('default');
      armSessionMentionDrag('a');
      const target = container?.querySelector('[data-sidebar-updated-id="c"]');
      // Past c's middle (102px): the end of the list.
      drag(target, 'dragover', 110);
      expect(node('a')?.style.opacity).toBe('0');
      expect(shiftOf('b')).toBeLessThan(0);
      expect(shiftOf('c')).toBeLessThan(0);
      drag(target, 'drop', 110);
      expect(pinSectionActions.onDropItem).toHaveBeenCalledWith('a', null, 2);
    });

    it('drops at the top of an empty section through its header', () => {
      const pinSectionActions = actions();
      renderSidebar({
        pinnedSections: [
          { id: null, name: 'Pinned', items: [chat('mover')] },
          { id: 'empty', name: 'Empty', items: [] },
        ],
        onTogglePinSection: () => {},
        pinSectionActions,
      });
      armSessionMentionDrag('mover');
      const header = container?.querySelector('[data-pin-section="empty"] [role="button"]');
      drag(header, 'dragover');
      drag(header, 'drop');
      expect(pinSectionActions.onDropItem).toHaveBeenCalledWith('mover', 'empty', 0);
    });

    it('leaves drags that are not conversations alone', () => {
      const pinSectionActions = actions();
      renderSidebar({
        pinnedSections: [{ id: null, name: 'Pinned', items: [chat('a')] }],
        pinSectionActions,
      });
      const row = container?.querySelector('[data-sidebar-updated-id="a"]');
      expect(drag(row, 'dragover').defaultPrevented).toBe(false);
      drag(row, 'drop');
      expect(pinSectionActions.onDropItem).not.toHaveBeenCalled();
    });
  });

  it('folds a draggable section from the keyboard', () => {
    const onTogglePinSection = vi.fn();
    renderSidebar({
      pinnedSections: [
        { id: null, name: 'Pinned', items: [pinnedItem] },
        { id: 'maintenance', name: 'Maintenance', items: [] },
      ],
      onTogglePinSection,
      pinSectionActions: {
        onDropItem: () => {},
        onMoveSection: () => {},
        onCreateSection: () => {},
        onRenameSection: () => {},
        onDeleteSection: () => {},
      },
    });
    const header = container?.querySelector<HTMLElement>(
      '[data-pin-section="maintenance"] [role="button"][aria-expanded]'
    );
    // The drag handle wraps the header but must not add a second button role.
    expect(header?.closest('[data-pin-section-handle]')?.getAttribute('role')).toBeNull();
    flushSync(() =>
      header?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    );
    expect(onTogglePinSection).toHaveBeenCalledWith('maintenance');
  });

  it('drags pinned rows with the pointer and leaves other rows on native drag', () => {
    renderSidebar({
      organizeMode: 'updated',
      pinnedSections: [{ id: null, name: 'Pinned', items: [pinnedItem] }],
      updatedItems: [
        {
          id: 'updated-session',
          kind: 'chat',
          title: 'Recently updated conversation',
          sectionLabel: 'Chats',
          latestMessageAt: new Date('2026-07-14T09:00:00.000Z'),
        },
      ],
      pinSectionActions: {
        onDropItem: () => {},
        onMoveSection: () => {},
        onCreateSection: () => {},
        onRenameSection: () => {},
        onDeleteSection: () => {},
      },
    });
    const pinned = container?.querySelector('[data-sidebar-updated-id="pinned-session"]');
    const updated = container?.querySelector('[data-sidebar-updated-id="updated-session"]');
    expect(pinned?.getAttribute('draggable')).toBe('false');
    expect(pinned?.closest('[data-pin-sortable]')).not.toBeNull();
    expect(updated?.getAttribute('draggable')).toBe('true');
  });

  it('starts a new chat from a user section menu, not from the default one', async () => {
    const onNewChat = vi.fn();
    renderSidebar({
      pinnedSections: [
        { id: null, name: 'Pinned', items: [pinnedItem] },
        { id: 'maintenance', name: 'Maintenance', items: [] },
      ],
      pinSectionActions: {
        onDropItem: () => {},
        onMoveSection: () => {},
        onCreateSection: () => {},
        onRenameSection: () => {},
        onDeleteSection: () => {},
        onNewChat,
      },
    });
    const openMenu = async (section: string) => {
      const trigger = container?.querySelector<HTMLElement>(
        `[data-pin-section="${section}"] button[aria-label="Section actions"]`
      );
      expect(trigger).not.toBeNull();
      flushSync(() => {
        trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        trigger?.click();
      });
      await flushFrame();
      return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (entry) => entry.textContent === 'New Chat in This Section'
      );
    };
    expect(await openMenu('default')).toBeUndefined();
    flushSync(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flushFrame();
    const item = await openMenu('maintenance');
    expect(item).toBeDefined();
    flushSync(() => item?.click());
    expect(onNewChat).toHaveBeenCalledWith('maintenance');
  });

  it('creates an empty section from the Pinned header menu', async () => {
    const onCreateSection = vi.fn();
    renderSidebar({
      pinnedSections: [{ id: null, name: 'Pinned', items: [pinnedItem] }],
      pinSectionActions: {
        onDropItem: () => {},
        onMoveSection: () => {},
        onCreateSection,
        onRenameSection: () => {},
        onDeleteSection: () => {},
      },
    });
    const trigger = container?.querySelector<HTMLElement>(
      '[data-pin-section="default"] button[aria-label="Section actions"]'
    );
    expect(trigger).not.toBeNull();
    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger?.click();
    });
    await flushFrame();
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (entry) => entry.textContent === 'New Section…'
    );
    expect(item).toBeDefined();
    flushSync(() => item?.click());
    await flushFrame();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Section name"]');
    expect(input).not.toBeNull();
    flushSync(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, 'Routine');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    flushSync(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flushFrame();
    expect(onCreateSection).toHaveBeenCalledWith('Routine', undefined);
  });

  it('keeps the section menu and folded activity mark in the same end slot', () => {
    const onTogglePinSection = vi.fn();
    const unreadItem = {
      ...pinnedItem,
      id: 'unread-in-ops',
      title: 'Unread ops item',
      hasUnreadMessages: true,
    };
    renderSidebar({
      pinnedSections: [
        { id: null, name: 'Pinned', items: [{ ...pinnedItem, hasUnreadMessages: true }] },
        { id: 'ops', name: 'Ops', items: [unreadItem] },
      ],
      pinnedSectionCollapsed: true,
      collapsedPinSectionIds: { ops: true },
      onTogglePinSection,
      pinSectionActions: {
        onDropItem: () => {},
        onMoveSection: () => {},
        onCreateSection: () => {},
        onRenameSection: () => {},
        onDeleteSection: () => {},
      },
    });

    const opsHeader = container?.querySelector<HTMLElement>(
      '[data-pin-section="ops"] [data-sidebar-section-header]'
    );
    const opsMenuSlot = opsHeader?.querySelector('[data-sidebar-section-menu]');
    const opsMenu = opsMenuSlot?.querySelector('button[aria-label="Section actions"]');
    const opsMark = opsMenuSlot?.querySelector('[data-sidebar-group-activity]');
    expect(opsMenu).not.toBeNull();
    expect(opsMark).not.toBeNull();
    expect(opsMark?.querySelector('[data-session-row-indicator]')).not.toBeNull();

    flushSync(() => {
      opsMark?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onTogglePinSection).toHaveBeenCalledWith('ops');

    const defaultHeader = container?.querySelector<HTMLElement>(
      '[data-pin-section="default"] [data-sidebar-section-header]'
    );
    const defaultMenuSlot = defaultHeader?.querySelector('[data-sidebar-section-menu]');
    const defaultMark = defaultMenuSlot?.querySelector('[data-sidebar-group-activity]');
    const filterButton = defaultHeader?.querySelector('button[aria-label="Filter sidebar"]');
    expect(defaultMark).not.toBeNull();
    expect(filterButton).not.toBeNull();
    expect(
      defaultMenuSlot!.compareDocumentPosition(filterButton!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

describe('pinned row drag planning', () => {
  const order = () => ({ default: ['a', 'b'], maintenance: ['m1', 'm2', 'm3'] });

  it('moves a row into another section at the dropped index', () => {
    expect(moveRowIntoSection(order(), 'a', 'maintenance', 1)).toEqual({
      default: ['b'],
      maintenance: ['m1', 'a', 'm2', 'm3'],
    });
    expect(moveRowIntoSection(order(), 'a', 'maintenance', 3)).toEqual({
      default: ['b'],
      maintenance: ['m1', 'm2', 'm3', 'a'],
    });
  });

  it('reorders within a section, counting the index among the other rows', () => {
    expect(moveRowIntoSection(order(), 'm1', 'maintenance', 2)).toEqual({
      default: ['a', 'b'],
      maintenance: ['m2', 'm3', 'm1'],
    });
  });
});
