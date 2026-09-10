// @vitest-environment jsdom

import React from 'react';
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

  it('offers workspace context actions without switching the selected workspace', () => {
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
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      const target = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
      ).find((item) => item.textContent?.includes('Second workspace'));
      expect(target).toBeDefined();
      expect(document.body.textContent).toContain('click to open in a new window');
      flushSync(() => {
        target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      });
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

  it('keeps the desktop collapse toggle hover-revealed in browsers', () => {
    renderSidebar({ onRequestCollapse: vi.fn() });

    const button = container?.querySelector('button[aria-label="Collapse sidebar"]');
    expect(button).not.toBeNull();
    expect(button?.className).toContain('opacity-0');
    expect(button?.className).toContain('pointer-events-none');
    expect(button?.className).toContain('group-hover/sidebar-header:opacity-100');
  });

  it('shows the desktop collapse toggle by default in Electron', () => {
    renderSidebar({ isElectron: true, onRequestCollapse: vi.fn() });

    const button = container?.querySelector('button[aria-label="Collapse sidebar"]');
    expect(button).not.toBeNull();
    expect(button?.className).not.toContain('opacity-0');
    expect(button?.className).not.toContain('pointer-events-none');
    expect(button?.className).toContain('focus-visible:outline-hidden');
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
    expect(pinnedRow?.querySelector('.lucide-pin')).toBeNull();
    expect(
      pinnedRow?.compareDocumentPosition(regularRow as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
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
    const chevron = header?.querySelector('.lucide-chevron-down');
    expect(chevron?.classList.contains('opacity-100')).toBe(true);
    expect(chevron?.classList.contains('-rotate-90')).toBe(true);

    header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onTogglePinnedSection).toHaveBeenCalledOnce();
  });
});
