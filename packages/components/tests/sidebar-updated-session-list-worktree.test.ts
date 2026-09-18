// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarUpdatedSessionList } from '../src/components/sidebar-updated-session-list';
import { initI18n } from '../src/i18n';

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
    vi.restoreAllMocks();
  });

  it('does not render a session-type icon in the row (it lives in the hover card now)', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(SidebarUpdatedSessionList, {
          now: new Date('2026-05-09T12:00:00.000Z'),
          items: [
            {
              id: 'session-worktree',
              kind: 'local',
              title: 'Local worktree session',
              sectionLabel: 'Local Projects · lody',
              subtitle: 'lody',
              latestMessageAt: new Date('2026-05-09T11:45:00.000Z'),
              isWorktree: true,
            },
            {
              id: 'session-local',
              kind: 'local',
              title: 'Plain local session',
              sectionLabel: 'Local Projects · lody',
              subtitle: 'lody',
              latestMessageAt: new Date('2026-05-09T11:30:00.000Z'),
            },
          ],
        })
      );
    });

    // The worktree / folder / repo type icon was removed from the row; the
    // worktree distinction now lives only in the desktop hover info card.
    const worktreeIcon = container.querySelector(
      '[data-sidebar-updated-id="session-worktree"] [aria-label="Running in a worktree"]'
    );
    const plainIcon = container.querySelector(
      '[data-sidebar-updated-id="session-local"] [aria-label="Running in a worktree"]'
    );

    expect(worktreeIcon).toBeNull();
    expect(plainIcon).toBeNull();
  });

  it('keeps PR status rightmost and line diff immediately before it', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(SidebarUpdatedSessionList, {
          now: new Date('2026-05-09T12:00:00.000Z'),
          items: [
            {
              id: 'session-with-pr',
              kind: 'github',
              title: 'Session with PR',
              sectionLabel: 'GitHub · loro-dev/lody',
              subtitle: 'loro-dev/lody',
              latestMessageAt: new Date('2026-05-09T11:45:00.000Z'),
              prUrl: 'https://github.com/loro-dev/lody/pull/42',
              prStatus: 'open',
              addedLines: 12,
              deletedLines: 4,
            },
            {
              id: 'session-without-pr',
              kind: 'github',
              title: 'Session without PR',
              sectionLabel: 'GitHub · loro-dev/lody',
              subtitle: 'loro-dev/lody',
              latestMessageAt: new Date('2026-05-09T11:30:00.000Z'),
              addedLines: 8,
              deletedLines: 2,
            },
          ],
        })
      );
    });

    const rowWithPr = container.querySelector('[data-sidebar-updated-id="session-with-pr"]');
    const rowWithoutPr = container.querySelector('[data-sidebar-updated-id="session-without-pr"]');

    expect(rowWithPr?.querySelector('.lucide-git-pull-request')).not.toBeNull();
    expect(rowWithPr?.querySelector('.text-code-added')).toBeNull();
    expect(rowWithPr?.querySelector('.text-code-removed')).toBeNull();
    expect(rowWithoutPr?.querySelector('.lucide-git-pull-request')).toBeNull();
    expect(rowWithoutPr?.querySelector('.text-code-added')).toBeNull();
    expect(rowWithoutPr?.querySelector('.text-code-removed')).toBeNull();
  });

  it('shows the PR icon for a local row linked to a GitHub PR', () => {
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
