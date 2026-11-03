// @vitest-environment jsdom

// @vitest-environment jsdom
import React from 'react';
import { getDefaultStore } from 'jotai';
import { sidebarShowBranchNamesAtom } from '../src/atoms/sidebar-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarUpdatedSessionList } from '../src/components/sidebar-updated-session-list';
import { initI18n } from '../src/i18n';
import * as stylex from '@stylexjs/stylex';
import { sidebarSurface } from '../src/components/sidebar-surface';

describe('SidebarUpdatedSessionList session-type icon', () => {
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

  it('shows a neutral count for multiple pull requests and prioritizes unread status', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const pullRequests = [
      { url: 'https://github.com/example/one/pull/42', status: 'open' as const },
      { url: 'https://github.com/example/two/pull/42', status: 'merged' as const },
    ];
    const item = {
      id: 'multi',
      kind: 'github' as const,
      title: 'Multiple',
      sectionLabel: 'example',
      latestMessageAt: new Date('2026-05-09T11:45:00.000Z'),
      prUrl: pullRequests[0]!.url,
      pullRequests,
    };
    flushSync(() =>
      root?.render(
        React.createElement(SidebarUpdatedSessionList, {
          now: new Date('2026-05-09T12:00:00.000Z'),
          items: [item],
        })
      )
    );
    expect(container.querySelector('[aria-label="2 pull requests"]')).toBeNull();
    expect(container.querySelector('.lucide-git-pull-request')).toBeNull();
    flushSync(() => getDefaultStore().set(sidebarShowBranchNamesAtom, true));
    const trigger = container.querySelector('[aria-label="2 pull requests"]');
    expect(trigger?.textContent).toBe('PR ×2');
    expect(trigger?.firstElementChild?.className).toBe(stylex.props(sidebarSurface.meta).className);
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
    flushSync(() => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.textContent).toContain('example/one/#42');
    expect(document.body.textContent).toContain('Open');
    expect(document.body.textContent).toContain('Merged');
    expect(document.body.textContent).not.toContain('https://github.com');
    const target = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('example/two/#42')
    );
    expect(target).toBeDefined();
    flushSync(() => target?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(openWindow).toHaveBeenCalledWith(
      'https://github.com/example/two/pull/42',
      '_blank',
      'noopener,noreferrer'
    );
    flushSync(() =>
      root?.render(
        React.createElement(SidebarUpdatedSessionList, {
          now: new Date('2026-05-09T12:00:00.000Z'),
          items: [{ ...item, hasUnreadMessages: true }],
        })
      )
    );
    expect(container.querySelector('[aria-label="2 pull requests"]')).toBeNull();
    flushSync(() => getDefaultStore().set(sidebarShowBranchNamesAtom, false));
    expect(container.querySelector('.lucide-git-pull-request')).toBeNull();
  });

  it('shows the PR icon for a local row linked to a GitHub PR', () => {
    getDefaultStore().set(sidebarShowBranchNamesAtom, true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(SidebarUpdatedSessionList, {
          now: new Date('2026-05-09T12:00:00.000Z'),
          items: [
            {
              id: 'session-local-with-pr',
              kind: 'local',
              title: 'Local session with PR',
              sectionLabel: 'Local Projects · lody',
              subtitle: 'lody',
              repoFullName: 'loro-dev/lody',
              latestMessageAt: new Date('2026-05-09T11:45:00.000Z'),
              prUrl: 'https://github.com/loro-dev/lody/pull/42',
              prStatus: 'open',
            },
          ],
        })
      );
    });

    // Local projects linked to a GitHub repo can carry a PR; the row must not
    // hide it just because `kind` is 'local'.
    const row = container.querySelector('[data-sidebar-updated-id="session-local-with-pr"]');
    expect(row?.querySelector('.lucide-git-pull-request')).not.toBeNull();
  });
});
