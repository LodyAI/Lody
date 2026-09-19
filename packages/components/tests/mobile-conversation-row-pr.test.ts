// @vitest-environment jsdom

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import {
  ConversationRow,
  type MobileConversationItem,
} from '../src/components/mobile/mobile-project-screen';
import { initI18n } from '../src/i18n';

/**
 * The mobile conversation row must surface PR status the same way the desktop
 * sidebar row does (`session-list-pr-badge.test.ts` covers that surface): the
 * shared `SessionPrIcon` at the row's right edge, carrying the PR-status tone
 * plus the CI verdict badge.
 */
describe('mobile ConversationRow PR status', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
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

  function renderRow(conversation: MobileConversationItem, selected = false) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(createElement(ConversationRow, { conversation, selected }));
    });
    return container;
  }

  const readyPr: MobileConversationItem = {
    id: 'ready-session',
    title: 'Ready PR',
    kind: 'github',
    prNumber: 52,
    prStatus: 'open',
    prUrl: 'https://github.com/loro-dev/lody/pull/52',
    prCiState: 's',
    prReadiness: 'y',
    addedLines: 12,
    deletedLines: 4,
  };

  it('renders the PR status icon with its CI verdict after the diff stats', () => {
    const row = renderRow({
      id: 'session-with-pr',
      title: 'Session with PR',
      kind: 'github',
      prNumber: 42,
      prStatus: 'merged',
      prUrl: 'https://github.com/loro-dev/lody/pull/42',
      prCiState: 's',
      addedLines: 12,
      deletedLines: 4,
    });

    const prIcon = row.querySelector('svg[data-pr-ci-verdict="success"]');
    expect(prIcon).not.toBeNull();
    expect(prIcon?.querySelector('.lucide-git-merge')?.classList.contains('text-pr-merged')).toBe(
      true
    );
    expect(prIcon?.querySelector('.lucide-check')?.classList.contains('text-status-success')).toBe(
      true
    );
    // PR owns the right edge, with the line diff immediately before it.
    expect(
      Array.from(row.querySelectorAll('.text-github-deletion, [data-pr-ci-verdict]'))
    ).toEqual([row.querySelector('.text-github-deletion'), prIcon]);
  });

  it('renders a plain PR glyph when the poller has no CI record yet', () => {
    const row = renderRow({
      id: 'session-draft-pr',
      title: 'Draft PR',
      kind: 'github',
      prNumber: 51,
      prStatus: 'draft',
      prUrl: 'https://github.com/loro-dev/lody/pull/51',
    });

    expect(row.querySelector('[data-pr-ci-verdict]')).toBeNull();
    expect(
      row.querySelector('.lucide-git-pull-request-draft')?.classList.contains('text-github-draft')
    ).toBe(true);
  });

  it('falls back to the open tone while a synced PR has no status yet', () => {
    const row = renderRow({
      id: 'session-pr-syncing',
      title: 'PR without a synced status',
      kind: 'github',
      prUrl: 'https://github.com/loro-dev/lody/pull/77',
      prStatus: null,
    });

    expect(
      row.querySelector('.lucide-git-pull-request')?.classList.contains('text-github-open')
    ).toBe(true);
  });

  it('replaces the line diff with the Mergeable pill on a ready PR', () => {
    const row = renderRow(readyPr);

    expect(row.querySelector('[data-session-mergeable-pill]')?.textContent).toBe('Mergeable');
    expect(row.querySelector('.text-github-addition')).toBeNull();
    expect(row.querySelector('.text-github-deletion')).toBeNull();
    // The PR icon keeps its own slot at the right edge.
    expect(row.querySelector('.lucide-git-pull-request, [data-pr-ci-verdict]')).not.toBeNull();
  });

  it('hides the pill on the open conversation, whose info bar owns merging', () => {
    const row = renderRow(readyPr, true);

    expect(row.querySelector('[data-session-mergeable-pill]')).toBeNull();
    // The diff does not come back either — the slot stays quiet on the active row.
    expect(row.querySelector('.text-github-addition')).toBeNull();
    expect(row.querySelector('[data-pr-ci-verdict]')).not.toBeNull();
  });

  it('drops a stale readiness record once the PR is merged or closed', () => {
    for (const prStatus of ['merged', 'closed'] as const) {
      const row = renderRow({ ...readyPr, id: `${prStatus}-session`, prStatus });
      expect(row.querySelector('[data-session-mergeable-pill]')).toBeNull();
      expect(row.querySelector('.text-github-addition')?.textContent).toBe('+12');
      flushSync(() => root?.unmount());
      root = undefined;
      container?.remove();
      container = undefined;
    }
  });

  it('renders no PR icon for a session without a pull request', () => {
    const row = renderRow({
      id: 'session-without-pr',
      title: 'Local session',
      kind: 'local',
      addedLines: 8,
      deletedLines: 2,
    });

    expect(row.querySelector('[data-pr-ci-verdict]')).toBeNull();
    expect(row.querySelector('svg[class*="lucide-git-"]')).toBeNull();
    expect(row.querySelector('.text-github-addition')?.textContent).toBe('+8');
  });

  it('places the status before the owner avatar and title for a Team Task', () => {
    const row = renderRow({
      id: 'team-task-session',
      title: 'Owned team task',
      kind: 'chat',
      owner: { id: 'owner-1', name: 'Ada Lovelace' },
      hasUnreadMessages: true,
    }).querySelector('button');

    expect(row?.children[0]?.querySelector('.bg-primary')).not.toBeNull();
    expect(row?.children[1]?.textContent).toBe('AL');
    expect(row?.children[2]?.textContent).toContain('Owned team task');
  });

  it('places the title immediately after the status for My Tasks', () => {
    const row = renderRow({
      id: 'my-task-session',
      title: 'My task',
      kind: 'chat',
      hasUnreadMessages: true,
    }).querySelector('button');

    expect(row?.children).toHaveLength(2);
    expect(row?.children[0]?.querySelector('.bg-primary')).not.toBeNull();
    expect(row?.children[1]?.textContent).toContain('My task');
  });
});
