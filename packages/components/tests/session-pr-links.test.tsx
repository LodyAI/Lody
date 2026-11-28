// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  resolveSessionPullRequestLinkList,
  resolveSessionPullRequestViews,
  type SessionMeta,
  type SessionPullRequestLinkListItem,
} from '@lody/shared';

import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import { PrLinkProvider, type PrLinkTarget } from '../src/components/ai-gui/pr-link-context';
import { SessionReadonlyContext } from '../src/components/ai-gui/session-readonly-context';
import { SessionInfoBar } from '../src/components/sessions/session-info-bar';
import {
  matchesPrTabUrl,
  parsePrRepoSearchParam,
  resolveActivePrTab,
} from '../src/components/sessions/pr-tab-target';
import {
  SessionPullRequestLinksPanel,
  unlinkSessionPullRequestFromUi,
} from '../src/components/sessions/session-pr-links';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderPanel(meta: Record<string, unknown>) {
  await initI18n();
  const writes: Array<Record<string, unknown>> = [];
  const state = { meta };
  const write = async (patch: Record<string, unknown>) => {
    writes.push(patch);
    state.meta = { ...state.meta, ...patch };
  };
  const draw = () =>
    root!.render(
      createElement(SessionPullRequestLinksPanel, {
        items: resolveSessionPullRequestLinkList(state.meta as SessionMeta),
        onUnlink: async (url: string) => {
          await unlinkSessionPullRequestFromUi(state.meta, url, write, () => 2_000);
          draw();
        },
      })
    );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => draw());
  return { writes, container };
}

describe('linked pull requests panel', () => {
  const url = 'https://github.com/o/r/pull/12';

  it('unlinks a PR from its row menu as a user record, leaving the list without it', async () => {
    const view = await renderPanel({
      project: { kind: 'github', repoFullName: 'o/r' },
      pullRequests: [{ url, status: 'open' }],
    });
    expect(view.container.textContent).toContain('o/r#12');
    expect(view.container.textContent).toContain('Primary');
    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions: o/r#12"]'
    )!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trigger.click();
    });
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual([
      'Open on GitHub',
      'Copy link',
      'Unlink',
    ]);
    await act(async () => items[2]!.click());
    expect(view.writes).toEqual([
      { 'prLink:https://github.com/o/r/pull/12': { k: 'u', o: 'u', t: 2_000 } },
    ]);
    expect(view.container.textContent).not.toContain('o/r#12');
  });

  it('shows agent- or shim-written links the machine has not confirmed, with their reason', async () => {
    const view = await renderPanel({
      'prLink:https://github.com/o/r/pull/77': { k: 'l', o: 's', t: 1 },
      'prLink:https://github.com/o/r/pull/78': { k: 'l', o: 'a', t: 2 },
      'prLinkCheck:https://github.com/o/r/pull/78': { r: 'u', t: 3 },
      'prLink:https://gitlab.com/a/b/-/merge_requests/1': { k: 'l', o: 'a', t: 4 },
    });
    const text = view.container.textContent ?? '';
    expect(text).toContain('o/r#77');
    expect(text).toContain('Checking');
    expect(text).toContain('GitHub did not return this pull request');
    expect(text).toContain('This provider is not supported yet.');
  });

  it('shows linked PRs in the Info Bar even when the session has no GitHub remote or primary PR', async () => {
    await initI18n();
    const opened: SessionPullRequestLinkListItem[] = [];
    const items = resolveSessionPullRequestLinkList({
      'prLink:https://github.com/other/repo/pull/42': { k: 'l', o: 'a', t: 1 },
    } as unknown as SessionMeta);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(SessionInfoBar, {
          pr: null,
          prLinks: { items, onOpen: (item) => opened.push(item) },
        })
      );
    });
    expect(container.textContent).toContain('#42');
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Linked pull requests"]'
    )!;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trigger.click();
    });
    expect(document.body.textContent).toContain('other/repo#42');
    const rowButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.title === 'https://github.com/other/repo/pull/42'
    )!;
    await act(async () => rowButton.click());
    expect(opened).toHaveLength(1);
    expect(opened[0]?.url).toBe('https://github.com/other/repo/pull/42');
  });
});

describe('markdown GitHub PR link interception', () => {
  const renderMarkdown = async (
    text: string,
    options: { onOpenPrTab?: (target: PrLinkTarget) => void; readonly?: boolean } = {}
  ) => {
    await initI18n();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const content = createElement(
      PrLinkProvider,
      { onOpenPrTab: options.onOpenPrTab },
      createElement(MarkdownRenderer, { text })
    );
    await act(async () => {
      root!.render(
        options.readonly
          ? createElement(
              SessionReadonlyContext.Provider,
              {
                value: {
                  readAttachment: async () => null,
                },
              },
              content
            )
          : content
      );
    });
    return container;
  };

  const clickLink = (anchor: HTMLAnchorElement, init: MouseEventInit = {}) => {
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...init,
    });
    act(() => {
      anchor.dispatchEvent(event);
    });
    return event;
  };

  it('opens same-repo, cross-repo, sub-page, and descriptive GitHub PR links in the PR panel', async () => {
    const opened: PrLinkTarget[] = [];
    const host = await renderMarkdown(
      [
        'Same repo: https://github.com/LodyAI/Lody/pull/101',
        'Cross repo: https://github.com/other-org/other-repo/pull/42/files?w=1#diff-123',
        'Www descriptive: [see upstream fix](http://www.github.com/facebook/react/pull/30000/commits)',
      ].join('\n\n'),
      { onOpenPrTab: (target) => opened.push(target) }
    );

    const anchors = Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href]'));
    expect(anchors).toHaveLength(3);

    for (const anchor of anchors) {
      const event = clickLink(anchor);
      expect(event.defaultPrevented).toBe(true);
    }

    expect(opened).toEqual([
      { repoFullName: 'LodyAI/Lody', prNumber: 101 },
      { repoFullName: 'other-org/other-repo', prNumber: 42 },
      { repoFullName: 'facebook/react', prNumber: 30000 },
    ]);
  });

  it('keeps non-PR links, malformed PR URLs, modifier clicks, and read-only views external', async () => {
    const onOpenPrTab = vi.fn();
    const host = await renderMarkdown(
      [
        '[issue](https://github.com/LodyAI/Lody/issues/101)',
        '[pulls](https://github.com/LodyAI/Lody/pulls)',
        '[gist](https://gist.github.com/LodyAI/Lody/pull/101)',
        '[zero](https://github.com/LodyAI/Lody/pull/0)',
        '[plus](https://github.com/LodyAI/Lody/pull/+7)',
        '[gitlab](https://gitlab.com/org/repo/-/merge_requests/9)',
        '[valid](https://github.com/other/repo/pull/77)',
      ].join(' '),
      { onOpenPrTab }
    );

    const anchors = Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href]'));
    expect(anchors).toHaveLength(7);

    for (const nonPrAnchor of anchors.slice(0, 6)) {
      const event = clickLink(nonPrAnchor);
      expect(event.defaultPrevented).toBe(false);
    }

    const validAnchor = anchors[6]!;
    expect(clickLink(validAnchor, { metaKey: true }).defaultPrevented).toBe(false);
    expect(clickLink(validAnchor, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(onOpenPrTab).not.toHaveBeenCalled();

    act(() => root?.unmount());
    container?.remove();
    const readonlyHost = await renderMarkdown('https://github.com/other/repo/pull/77', {
      onOpenPrTab,
      readonly: true,
    });
    const readonlyAnchor = readonlyHost.querySelector<HTMLAnchorElement>('a[href]')!;
    expect(clickLink(readonlyAnchor).defaultPrevented).toBe(false);
    expect(onOpenPrTab).not.toHaveBeenCalled();
  });
});

describe('active PR tab resolution and session isolation', () => {
  const sessionMeta = {
    project: { kind: 'github', repoFullName: 'LodyAI/Lody' },
    pullRequests: [
      {
        url: 'https://github.com/LodyAI/Lody/pull/42',
        status: 'open',
        headCommitSha: 'sha-primary',
      },
      {
        url: 'https://github.com/LodyAI/Lody/pull/41',
        status: 'merged',
        headCommitSha: 'sha-older',
      },
    ],
  } as unknown as SessionMeta;
  const associatedPrViews = resolveSessionPullRequestViews(sessionMeta);
  const latestPr = sessionMeta.pullRequests![0]!;

  it('opens a cross-repo PR even when its number collides with the session primary PR', () => {
    const tab = resolveActivePrTab({
      selectedPrTab: { repoFullName: 'other-org/other-repo', prNumber: 42 },
      urlPrNumber: 42,
      urlPrRepo: 'other-org/other-repo',
      latestPr,
      latestPrNumber: 42,
      latestPrRepoFullName: 'LodyAI/Lody',
      associatedPrViews,
    });

    expect(tab).toEqual({
      repoFullName: 'other-org/other-repo',
      prNumber: 42,
      headCommitSha: undefined,
      isAssociated: false,
      isCurrentWorkPr: false,
    });
    expect(matchesPrTabUrl(tab!, 42, 'other-org/other-repo')).toBe(true);
    expect(matchesPrTabUrl(tab!, 42, 'LodyAI/Lody')).toBe(false);
  });

  it('opens an arbitrary PR in a session with no repository binding or associated PRs', () => {
    const fromSelection = resolveActivePrTab({
      selectedPrTab: { repoFullName: 'facebook/react', prNumber: 30000 },
      associatedPrViews: [],
    });
    expect(fromSelection).toEqual({
      repoFullName: 'facebook/react',
      prNumber: 30000,
      headCommitSha: undefined,
      isAssociated: false,
      isCurrentWorkPr: false,
    });

    const fromUrl = resolveActivePrTab({
      selectedPrTab: null,
      urlPrNumber: 30000,
      urlPrRepo: 'facebook/react',
      associatedPrViews: [],
    });
    expect(fromUrl).toEqual(fromSelection);
  });

  it('marks only the session primary PR as current work PR and only associated PRs as associated', () => {
    const primary = resolveActivePrTab({
      selectedPrTab: { repoFullName: 'lodyai/lody', prNumber: 42 },
      latestPr,
      latestPrNumber: 42,
      latestPrRepoFullName: 'LodyAI/Lody',
      associatedPrViews,
    });
    expect(primary).toEqual({
      repoFullName: 'LodyAI/Lody',
      prNumber: 42,
      headCommitSha: 'sha-primary',
      isAssociated: true,
      isCurrentWorkPr: true,
    });

    const olderSameRepo = resolveActivePrTab({
      selectedPrTab: { repoFullName: 'LodyAI/Lody', prNumber: 41 },
      latestPr,
      latestPrNumber: 42,
      latestPrRepoFullName: 'LodyAI/Lody',
      associatedPrViews,
    });
    expect(olderSameRepo).toEqual({
      repoFullName: 'LodyAI/Lody',
      prNumber: 41,
      headCommitSha: 'sha-older',
      isAssociated: true,
      isCurrentWorkPr: false,
    });

    const unassociatedSameRepo = resolveActivePrTab({
      selectedPrTab: { repoFullName: 'LodyAI/Lody', prNumber: 99 },
      latestPr,
      latestPrNumber: 42,
      latestPrRepoFullName: 'LodyAI/Lody',
      associatedPrViews,
    });
    expect(unassociatedSameRepo).toEqual({
      repoFullName: 'LodyAI/Lody',
      prNumber: 99,
      headCommitSha: undefined,
      isAssociated: false,
      isCurrentWorkPr: false,
    });
  });

  it('validates optional prRepo URL params safely', () => {
    expect(parsePrRepoSearchParam('LodyAI/Lody')).toBe('LodyAI/Lody');
    expect(parsePrRepoSearchParam(' owner/repo ')).toBe('owner/repo');
    expect(parsePrRepoSearchParam('../repo')).toBeUndefined();
    expect(parsePrRepoSearchParam('owner/..')).toBeUndefined();
    expect(parsePrRepoSearchParam('not-a-repo')).toBeUndefined();
    expect(parsePrRepoSearchParam(123)).toBeUndefined();
  });
});
