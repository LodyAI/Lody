// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'jotai';
import { SessionList } from '../src/components/session-list';
import { SessionPrIcon, SidebarRowEndSlot } from '../src/components/sidebar-row-shared';
import { initI18n } from '../src/i18n';

const PR_STATUS_CASES = [
  ['open', '.lucide-git-pull-request', 'text-github-open'],
  ['merged', '.lucide-git-merge', 'text-github-merged'],
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
    vi.restoreAllMocks();
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

  it('keeps PR status rightmost and line diff immediately before it', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(SessionList, {
          sessions: [
            {
              sessionId: 'session-with-pr',
              title: 'Session with PR',
              repoFullName: 'loro-dev/lody',
              branchName: 'fix/session-with-pr',
              prUrl: 'https://github.com/loro-dev/lody/pull/42',
              prStatus: 'open',
              prCiState: 's',
              latestMessageAt: '2026-04-22T00:00:00.000Z',
              addedLines: 12,
              deletedLines: 4,
              isWorking: false,
              hasUnreadMessages: false,
              isOffline: false,
              isWaitingPermission: false,
            },
            {
              sessionId: 'session-without-pr',
              title: 'Session without PR',
              repoFullName: 'loro-dev/lody',
              branchName: 'fix/session-without-pr',
              latestMessageAt: '2026-04-21T00:00:00.000Z',
              addedLines: 8,
              deletedLines: 2,
              isWorking: false,
              hasUnreadMessages: false,
              isOffline: false,
              isWaitingPermission: false,
            },
          ],
          repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
        })
      );
    });

    const rowWithPr = container.querySelector('[data-sidebar-session-id="session-with-pr"]');
    const rowWithoutPr = container.querySelector('[data-sidebar-session-id="session-without-pr"]');

    const passedPrIcon = rowWithPr?.querySelector('svg[data-pr-ci-verdict="success"]');
    const passedBase = passedPrIcon?.querySelector('.lucide-git-pull-request');
    const passedVerdict = passedPrIcon?.querySelector('.lucide-check');
    expect(passedPrIcon).not.toBeNull();
    expect(passedPrIcon?.querySelector('mask')).not.toBeNull();
    expect(passedBase?.getAttribute('width')).toBe('14');
    expect(passedBase?.getAttribute('height')).toBe('14');
    expect(passedBase?.classList.contains('text-github-open')).toBe(true);
    expect(passedVerdict).not.toBeNull();
    expect(passedVerdict?.parentElement?.getAttribute('transform')).toBe('translate(7 7)');
    expect(passedVerdict?.getAttribute('width')).toBe('10');
    expect(passedVerdict?.getAttribute('height')).toBe('10');
    expect(passedVerdict?.classList.contains('text-status-success')).toBe(true);
    expect(passedPrIcon?.querySelector('.bg-sidebar')).toBeNull();
    expect(rowWithPr?.querySelector('.text-code-added')?.textContent).toBe('+12');
    expect(rowWithPr?.querySelector('.text-code-removed')?.textContent).toBe('-4');
    expect(
      Array.from(
        rowWithPr?.querySelectorAll('.text-code-removed, [data-pr-ci-verdict="success"]') ?? []
      )
    ).toEqual([rowWithPr?.querySelector('.text-code-removed'), passedPrIcon]);
    expect(rowWithoutPr?.querySelector('[data-pr-ci-verdict]')).toBeNull();
    expect(rowWithoutPr?.querySelector('.text-code-added')?.textContent).toBe('+8');
    expect(rowWithoutPr?.querySelector('.text-code-removed')?.textContent).toBe('-2');
  });

  it('replaces diff stats with a Mergeable pill only while the ready session is inactive', () => {
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
    expect(row?.querySelector('.text-code-added')).toBeNull();
    expect(row?.querySelector('.text-code-removed')).toBeNull();
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
    expect(selectedRow?.querySelector('.text-code-added')).toBeNull();
    expect(selectedRow?.querySelector('.text-code-removed')).toBeNull();
    expect(selectedRow?.querySelector('.lucide-git-pull-request')).not.toBeNull();
  });

  it.each(PR_STATUS_CI_CASES)(
    'keeps the $prStatus PR tone independent from CI $prCiState',
    ({
      prStatus,
      baseSelector,
      baseToneClassName,
      prCiState,
      verdict,
      verdictSelector,
      verdictToneClassName,
      cutoutRadius,
    }) => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      flushSync(() => {
        root?.render(React.createElement(SessionPrIcon, { prStatus, prCiState }));
      });

      const icon = container.querySelector(`svg[data-pr-ci-verdict="${verdict}"]`);
      const baseIcon = icon?.querySelector(baseSelector);
      const cutout = icon?.querySelector('mask circle');
      const verdictIcon = icon?.querySelector(verdictSelector);
      expect(icon).not.toBeNull();
      expect(baseIcon).not.toBeNull();
      expect(baseIcon?.classList.contains(baseToneClassName)).toBe(true);
      expect(baseIcon?.classList.contains(verdictToneClassName)).toBe(false);
      expect(cutout?.getAttribute('cx')).toBe('12');
      expect(cutout?.getAttribute('cy')).toBe('12');
      expect(cutout?.getAttribute('r')).toBe(cutoutRadius);
      expect(verdictIcon).not.toBeNull();
      expect(verdictIcon?.classList.contains(verdictToneClassName)).toBe(true);
      expect(verdictIcon?.classList.contains(baseToneClassName)).toBe(false);
      expect(verdictIcon?.parentElement?.getAttribute('transform')).toBe('translate(7 7)');
      expect(icon?.querySelector('.bg-sidebar')).toBeNull();
      expect(icon?.querySelector('.rounded-full')).toBeNull();
      if (verdict === 'pending') {
        expect(verdictIcon?.getAttribute('cx')).toBe('5');
        expect(verdictIcon?.getAttribute('cy')).toBe('5');
        expect(verdictIcon?.getAttribute('r')).toBe('2.5');
        expect(verdictIcon?.getAttribute('fill')).toBe('currentColor');
        expect(icon?.querySelector('.lucide-loader-circle')).toBeNull();
        expect(icon?.querySelector('.animate-spin')).toBeNull();
      }
    }
  );

  it('does not update shared list state during render', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          Provider,
          null,
          React.createElement(SessionList, {
            sessions: [
              {
                sessionId: 'session-1',
                title: 'Fix sidebar state sync',
                repoFullName: 'loro-dev/lody',
                branchName: 'fix/sidebar-state-sync',
                latestMessageAt: '2026-04-22T00:00:00.000Z',
                addedLines: 0,
                deletedLines: 0,
                isWorking: false,
                hasUnreadMessages: false,
                isOffline: false,
                isWaitingPermission: false,
              },
            ],
            repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
          })
        )
      );
    });

    const emittedRenderUpdateWarning = consoleError.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('Cannot update a component'))
    );
    expect(emittedRenderUpdateWarning).toBe(false);
  });

  it('keeps the working animation on an active-only fixed SVG', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(SidebarRowEndSlot, {
          isWorking: true,
        })
      );
    });

    const spinner = container.querySelector('[data-session-working-spinner]');
    expect(spinner?.tagName).toBe('svg');
    expect(spinner?.classList.contains('h-3')).toBe(true);
    expect(spinner?.classList.contains('w-3')).toBe(true);
    expect(spinner?.classList.contains('shrink-0')).toBe(true);
    expect(spinner?.classList.contains('animate-spin')).toBe(true);
    expect(spinner?.classList.contains('will-change-transform')).toBe(true);

    flushSync(() => {
      root?.render(
        React.createElement(SidebarRowEndSlot, {
          isWorking: false,
          hasUnreadMessages: true,
        })
      );
    });

    expect(container.querySelector('[data-session-working-spinner]')).toBeNull();
    expect(container.querySelector('.will-change-transform')).toBeNull();
  });
});
