// @vitest-environment jsdom

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
});
