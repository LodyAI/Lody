// @vitest-environment jsdom

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
