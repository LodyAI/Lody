// @vitest-environment jsdom

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import {
  SidebarUpdatedSessionList,
  type SidebarUpdatedItem,
} from '../src/components/sidebar-updated-session-list';
import { sidebarShowBranchNamesAtom } from '../src/atoms/sidebar-state';
import { initI18n } from '../src/i18n';

function makeItem(overrides: Partial<SidebarUpdatedItem> & { id: string }): SidebarUpdatedItem {
  return {
    kind: 'chat',
    title: `Session ${overrides.id}`,
    sectionLabel: 'Chats',
    latestMessageAt: '2026-04-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('SidebarUpdatedSessionList project context', () => {
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
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function render(
    items: SidebarUpdatedItem[],
    showProjectContext = true,
    selectedItemId?: string,
    options?: { branchNames?: boolean }
  ) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const store = createStore();
    if (options?.branchNames !== undefined) {
      store.set(sidebarShowBranchNamesAtom, options.branchNames);
    }
    flushSync(() => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(SidebarUpdatedSessionList, {
            items,
            now: new Date('2026-04-22T12:00:00.000Z'),
            showProjectContext,
            selectedItemId,
          })
        )
      );
    });
  }

  it('places resting PRs on the branch line while keeping unread and archive on the title line', () => {
    render(
      [
        makeItem({
          id: 'pr',
          kind: 'github',
          branchName: 'feature',
          prUrl: 'https://github.com/example/repo/pull/42',
        }),
        makeItem({
          id: 'unread',
          kind: 'github',
          branchName: 'feature',
          prUrl: 'https://github.com/example/repo/pull/43',
          hasUnreadMessages: true,
        }),
        makeItem({
          id: 'no-branch',
          kind: 'github',
          prUrl: 'https://github.com/example/repo/pull/44',
        }),
      ],
      false,
      undefined,
      { branchNames: true }
    );
    const slot = (id: string) =>
      container!.querySelector(`[data-sidebar-updated-id="${id}"] [data-session-row-end-slot]`)!;
    expect(slot('pr').classList.contains('items-end')).toBe(true);
    expect(slot('pr').querySelector('[aria-label="Open pull request #42"]')).not.toBeNull();
    expect(slot('unread').querySelector('[data-session-row-indicator]')).not.toBeNull();
    expect(slot('unread').querySelector('[aria-label="Open pull request #43"]')).not.toBeNull();
    expect(slot('no-branch').classList.contains('items-center')).toBe(true);
  });

  it('does not show a project line unless Updated mode asks for it', () => {
    render(
      [
        makeItem({
          id: 'local',
          kind: 'local',
          title: 'Local session',
          subtitle: 'lody',
          sectionLabel: 'Local Projects · lody',
        }),
      ],
      false
    );
    expect(container?.querySelector('[data-sidebar-updated-project]')).toBeNull();
  });

  it('hides the project line on nested opened Sessions', () => {
    render([
      makeItem({
        id: 'opener',
        kind: 'local',
        title: 'Opener',
        subtitle: 'lody',
        sectionLabel: 'Local Projects · lody',
        latestMessageAt: '2026-04-22T11:00:00.000Z',
      }),
      makeItem({
        id: 'opened',
        kind: 'local',
        title: 'Opened child',
        subtitle: 'lody',
        sectionLabel: 'Local Projects · lody',
        openedBySessionId: 'opener',
        latestMessageAt: '2026-04-22T10:00:00.000Z',
      }),
    ]);

    expect(
      container
        ?.querySelector('[data-sidebar-updated-id="opener"]')
        ?.querySelector('[data-sidebar-updated-project]')
    ).not.toBeNull();
    expect(
      container
        ?.querySelector('[data-sidebar-updated-id="opened"]')
        ?.querySelector('[data-sidebar-updated-project]')
    ).toBeNull();
  });

  it('appends the branch segment to a repo row when the preference is on', () => {
    render(
      [
        makeItem({
          id: 'github',
          kind: 'github',
          title: 'GitHub session',
          subtitle: 'loro-dev/lody',
          repoFullName: 'loro-dev/lody',
          branchName: 'feat/repository-identity',
          sectionLabel: 'loro-dev/lody',
        }),
      ],
      true,
      undefined,
      { branchNames: true }
    );

    const meta = container
      ?.querySelector('[data-sidebar-updated-id="github"]')
      ?.querySelector('[data-sidebar-session-meta]');
    expect(meta?.textContent).toContain('feat/repository-identity');
    expect(meta?.querySelector('.lucide-git-branch')).not.toBeNull();
  });

  it('omits the branch segment on rows without a branch and on nested children', () => {
    render([
      makeItem({
        id: 'chat',
        kind: 'chat',
        title: 'Chat session',
        subtitle: null,
        sectionLabel: 'Chats',
      }),
      makeItem({
        id: 'opener',
        kind: 'github',
        title: 'Opener',
        subtitle: 'loro-dev/lody',
        repoFullName: 'loro-dev/lody',
        branchName: 'main',
        sectionLabel: 'loro-dev/lody',
      }),
      makeItem({
        id: 'opened',
        kind: 'github',
        title: 'Opened child',
        subtitle: 'loro-dev/lody',
        repoFullName: 'loro-dev/lody',
        branchName: 'feat/child',
        openedBySessionId: 'opener',
        sectionLabel: 'loro-dev/lody',
      }),
    ]);

    const chatRow = container?.querySelector('[data-sidebar-updated-id="chat"]');
    const openedRow = container?.querySelector('[data-sidebar-updated-id="opened"]');
    // Chat rows have no branch, so the chat keeps its project-only second line.
    expect(chatRow?.querySelector('.lucide-git-branch')).toBeNull();
    expect(
      container
        ?.querySelector('[data-sidebar-updated-id="opener"]')
        ?.querySelector('[data-sidebar-session-meta]')
    ).not.toBeNull();
    expect(openedRow?.querySelector('[data-sidebar-session-meta]')).toBeNull();
  });

  it('collapses the second line to the project segment when the branch preference is off', () => {
    render(
      [
        makeItem({
          id: 'github',
          kind: 'github',
          title: 'GitHub session',
          subtitle: 'loro-dev/lody',
          repoFullName: 'loro-dev/lody',
          branchName: 'feat/repository-identity',
          sectionLabel: 'loro-dev/lody',
        }),
      ],
      true,
      undefined,
      { branchNames: false }
    );

    const row = container?.querySelector('[data-sidebar-updated-id="github"]');
    expect(row?.querySelector('[data-sidebar-updated-project="github"]')).not.toBeNull();
    expect(row?.querySelector('.lucide-git-branch')).toBeNull();
  });
});
