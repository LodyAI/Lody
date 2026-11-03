// @vitest-environment jsdom

// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, getDefaultStore, Provider } from 'jotai';
import { sidebarShowBranchNamesAtom } from '../src/atoms/sidebar-state';
import { sessionSendStatusesAtom } from '../src/atoms/session-send-status';
import { SessionList } from '../src/components/session-list';
import { SidebarBranchSegment, SidebarRowEndSlot } from '../src/components/sidebar-row-shared';
import { initI18n } from '../src/i18n';
import { WORKING_HAND_OVER_MS } from '../src/ui/working-status-mark';



const PR_STATUS_CASES = [
  ['open', '.lucide-git-pull-request', 'text-github-open'],
  ['merged', '.lucide-git-merge', 'text-pr-merged'],
  ['closed', '.lucide-git-pull-request-closed', 'text-github-closed'],
  ['draft', '.lucide-git-pull-request-draft', 'text-github-draft'],
] as const;

const PR_CI_CASES = [
  ['s', 'success', '.lucide-check', 'text-status-success', '5'],
  ['f', 'failure', '.lucide-x', 'text-destructive', '5'],
  ['e', 'failure', '.lucide-x', 'text-destructive', '5'],
  ['p', 'pending', '[data-pr-ci-verdict-slot] > circle', 'text-status-warning', '3.75'],
  ['x', 'expected', '.lucide-circle-dot', 'text-status-warning', '5'],
] as const;

const PR_STATUS_CI_CASES = PR_STATUS_CASES.flatMap(([prStatus, baseSelector, baseToneClassName]) =>
  PR_CI_CASES.map(([prCiState, verdict, verdictSelector, verdictToneClassName, cutoutRadius]) => ({
    prStatus,
    baseSelector,
    baseToneClassName,
    prCiState,
    verdict,
    verdictSelector,
    verdictToneClassName,
    cutoutRadius,
  }))
);

describe('SessionList PR badge', () => {
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
    getDefaultStore().set(sidebarShowBranchNamesAtom, false);
    vi.restoreAllMocks();
  });

  it('keeps activity and PR visible on separate lines while preserving single-line priority', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const openPr = vi.fn();
    const archive = vi.fn();
    const renderSlot = (twoLines: boolean) =>
      React.createElement(SidebarRowEndSlot, {
        isWaitingPermission: true,
        restOnSecondLine: twoLines,
        interactiveRest: true,
        restIcon: React.createElement('button', { type: 'button', onClick: openPr }, 'PR #42'),
        archive: React.createElement('button', { type: 'button', onClick: archive }, 'Archive'),
      });
    flushSync(() => root?.render(renderSlot(true)));
    expect(container.querySelector('[data-session-row-end-slot]')?.textContent).toContain('PR #42');
    expect(
      container.querySelector('[data-session-row-end-slot]')?.querySelector('svg')
    ).not.toBeNull();
    expect(container.textContent).toContain('Archive');
    flushSync(() => {
      container?.querySelectorAll('button')[0]?.click();
      container?.querySelectorAll('button')[1]?.click();
    });
    expect(openPr).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledOnce();
    flushSync(() => root?.render(renderSlot(false)));
    expect(container.textContent).not.toContain('PR #42');
    expect(container.textContent).toContain('Archive');
  });

  it('keeps the full branch available when its middle is clipped', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const branch = 'feature/a-very-long-branch-name-with-a-distinct-ending';
    flushSync(() =>
      root?.render(React.createElement(SidebarBranchSegment, { branchName: branch }))
    );
    const label = container.querySelector('[title]');
    expect(label?.getAttribute('title')).toBe(branch);
    expect(label?.textContent).toBe(branch);
  });

  it('opens the in-app PR target instead of GitHub when a handler is provided', () => {
    const onOpenPullRequest = vi.fn();
    const onSelectSession = vi.fn();
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(SessionList, {
          sessions: [
            {
              sessionId: 'session-1',
              title: 'Fix sidebar PR badge',
              repoFullName: 'loro-dev/lody',
              branchName: 'fix/sidebar-pr-badge',
              prUrl: 'https://github.com/loro-dev/lody/pull/42',
              prNumber: 42,
              prStatus: 'open',
              latestMessageAt: '2026-04-22T00:00:00.000Z',
              addedLines: 1,
              deletedLines: 0,
              isWorking: false,
              hasUnreadMessages: false,
              isOffline: false,
              isWaitingPermission: false,
            },
          ],
          repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
          onOpenPullRequest,
          onSelectSession,
        })
      );
    });

    // The inline PR badge was replaced by a row context-menu action ("Open Pull
    // Request"); the PR now lives in the desktop hover info card + context menu.
    const row = container.querySelector('[data-sidebar-session-id="session-1"]');
    expect(row).not.toBeNull();
    flushSync(() => {
      row?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      );
    });

    const openPrItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((node) =>
      node.textContent?.includes('Open Pull Request')
    );
    expect(openPrItem).not.toBeUndefined();

    flushSync(() => {
      openPrItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onOpenPullRequest).toHaveBeenCalledWith({
      sessionId: 'session-1',
      repoFullName: 'loro-dev/lody',
      prUrl: 'https://github.com/loro-dev/lody/pull/42',
      prNumber: 42,
    });
    expect(windowOpen).not.toHaveBeenCalled();
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('replaces diff stats with a Mergeable pill only while the ready session is inactive', () => {
    getDefaultStore().set(sidebarShowBranchNamesAtom, true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const task = {
      sessionId: 'ready-session',
      title: 'Ready PR',
      repoFullName: 'loro-dev/lody',
      branchName: 'feat/ready-pr',
      prUrl: 'https://github.com/loro-dev/lody/pull/42',
      prStatus: 'open' as const,
      prCiState: 's' as const,
      prReadiness: 'y' as const,
      latestMessageAt: '2026-04-22T00:00:00.000Z',
      addedLines: 12,
      deletedLines: 4,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    };

    flushSync(() => {
      root?.render(
        React.createElement(SessionList, {
          sessions: [task],
          repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
        })
      );
    });

    const row = container.querySelector('[data-sidebar-session-id="ready-session"]');
    expect(row?.querySelector('[data-session-mergeable-pill]')?.textContent).toBe('Mergeable');
    expect(row?.querySelector('.text-github-addition')).toBeNull();
    expect(row?.querySelector('.text-github-deletion')).toBeNull();
    expect(row?.querySelector('.lucide-git-pull-request')).not.toBeNull();

    flushSync(() => {
      root?.render(
        React.createElement(SessionList, {
          sessions: [task],
          repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
          selectedSessionId: 'ready-session',
        })
      );
    });

    const selectedRow = container.querySelector('[data-sidebar-session-id="ready-session"]');
    expect(selectedRow?.querySelector('[data-session-mergeable-pill]')).toBeNull();
    expect(selectedRow?.querySelector('.text-github-addition')).toBeNull();
    expect(selectedRow?.querySelector('.text-github-deletion')).toBeNull();
    expect(selectedRow?.querySelector('.lucide-git-pull-request')).not.toBeNull();
  });

  it('shows the PR control only while branch names are enabled', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const store = createStore();
    const session = {
      sessionId: 'pr-toggle',
      title: 'PR session',
      repoFullName: 'example/repo',
      branchName: 'feature',
      latestMessageAt: '2026-04-22T00:00:00.000Z',
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
      prUrl: 'https://github.com/example/repo/pull/42',
      prStatus: 'open' as const,
    };
    flushSync(() =>
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(SessionList, {
            sessions: [session],
            repos: [{ repoFullName: 'example/repo', collapsed: false }],
            onToggleRepoCollapsed: () => undefined,
          })
        )
      )
    );
    const row = container.querySelector('[data-sidebar-session-id="pr-toggle"]')!;
    expect(row.querySelector('.lucide-git-pull-request')).toBeNull();
    expect(row.querySelector('[aria-label="Open pull request #42"]')).toBeNull();
    flushSync(() => store.set(sidebarShowBranchNamesAtom, true));
    expect(row.querySelector('[aria-label="Open pull request #42"]')).not.toBeNull();
    flushSync(() => store.set(sidebarShowBranchNamesAtom, false));
    expect(row.querySelector('[aria-label="Open pull request #42"]')).toBeNull();
    expect(row.querySelector('.lucide-git-pull-request')).toBeNull();
  });

  it('keeps a folded repo group telling what its hidden sessions are doing', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const row = (sessionId: string, status: Partial<Record<string, boolean>>) => ({
      sessionId,
      title: sessionId,
      repoFullName: 'loro-dev/lody',
      branchName: sessionId,
      latestMessageAt: '2026-04-22T00:00:00.000Z',
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
      ...status,
    });
    const renderList = (collapsed: boolean, sessions: ReturnType<typeof row>[]) => {
      flushSync(() => {
        root?.render(
          React.createElement(
            Provider,
            null,
            React.createElement(SessionList, {
              sessions,
              repos: [{ repoFullName: 'loro-dev/lody', collapsed }],
              onToggleRepoCollapsed: () => undefined,
            })
          )
        );
      });
      return container?.querySelector('[data-sidebar-group-key="loro-dev/lody"]');
    };

    const sessions = [
      row('running', { isWorking: true }),
      row('finished', { hasUnreadMessages: true }),
      row('read'),
    ];
    let header = renderList(false, sessions);
    expect(header?.querySelector('[data-sidebar-group-activity]')).toBeNull();

    header = renderList(true, sessions);
    expect(container.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(0);
    const mark = header?.querySelector('[data-sidebar-group-activity]');
    expect(mark?.querySelector('[data-working-grid]')).not.toBeNull();
    expect(mark?.getAttribute('aria-label')).toBe('1 working · 1 unread');

    // Work stops with nothing new to read: like a row, the group holds its grid
    // briefly in case the unread write is still on its way, then goes quiet.
    vi.useFakeTimers();
    header = renderList(true, [row('read')]);
    expect(header?.querySelector('[data-working-grid]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(WORKING_HAND_OVER_MS);
    });
    expect(header?.querySelector('[data-session-row-indicator]')).toBeNull();
    vi.useRealTimers();
  });

  it('rolls local send failures and uploads into a folded group by row priority', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const store = createStore();
    const row = (sessionId: string, isWorking = false) => ({
      sessionId,
      title: sessionId,
      repoFullName: 'loro-dev/lody',
      latestMessageAt: '2026-04-22T00:00:00.000Z',
      addedLines: 0,
      deletedLines: 0,
      isWorking,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    });
    const status = (state: 'sending' | 'failed') => ({
      state,
      progress: 40,
      sentBytes: 400,
      totalBytes: 1000,
      unsentNewConversation: false,
    });
    const render = (collapsed: boolean) => {
      flushSync(() => {
        root?.render(
          React.createElement(
            Provider,
            { store },
            React.createElement(SessionList, {
              sessions: [row('broken', true), row('running', true), row('uploading')],
              repos: [{ repoFullName: 'loro-dev/lody', collapsed }],
              onToggleRepoCollapsed: () => undefined,
            })
          )
        );
      });
      return container!.querySelector('[data-sidebar-group-key="loro-dev/lody"]');
    };
    const groupMark = () =>
      container!.querySelector<HTMLElement>(
        '[data-sidebar-group-activity] [data-session-row-indicator]'
      );

    flushSync(() => {
      store.set(sessionSendStatusesAtom, {
        broken: status('failed'),
        uploading: status('sending'),
      });
    });
    render(false);
    // Expanded, each row draws its own mark; a failed send outranks the agent working.
    const rowMark = (id: string) =>
      container!.querySelector<HTMLElement>(
        `[data-sidebar-session-id="${id}"] [data-session-row-indicator]`
      );
    expect(rowMark('broken')?.dataset.sessionSendState).toBe('failed');
    expect(rowMark('running')?.querySelector('[data-working-grid]')).not.toBeNull();
    expect(rowMark('uploading')?.querySelector('[data-session-send-ring]')).not.toBeNull();

    const header = render(true);
    expect(groupMark()?.dataset.sessionSendState).toBe('failed');
    expect(header?.querySelector('[data-sidebar-group-activity]')?.getAttribute('aria-label')).toBe(
      '1 not sent · 1 working · 1 sending'
    );

    flushSync(() => {
      store.set(sessionSendStatusesAtom, { uploading: status('sending') });
    });
    expect(groupMark()?.querySelector('[data-working-grid]')).not.toBeNull();
    expect(
      container!.querySelector('[data-sidebar-group-activity]')?.getAttribute('aria-label')
    ).toBe('2 working · 1 sending');
  });
});
