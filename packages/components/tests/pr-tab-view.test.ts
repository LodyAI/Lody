// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GitHubCheckRunsSummary,
  GitHubPullRequestDetails,
  GitHubReview,
  GitHubReviewThread,
} from '@lody/shared';

import {
  PrTabView,
  type PrTabViewData,
  type PrTabViewState,
} from '../src/components/sessions/pr-tab-view';
import { threadHunkExcerpt } from '../src/ui/diff-viewer/github-comment-thread';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, opts?: Record<string, unknown>) =>
      (fallback ?? _key).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name])),
  }),
}));

const pullRequest: GitHubPullRequestDetails = {
  number: 42,
  nodeId: 'PR_kwDO_test',
  title: 'Fix refresh button',
  body: '',
  state: 'open',
  merged: false,
  draft: false,
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42',
  baseRef: 'main',
  headRef: 'fix/pr-refresh-button',
  headSha: 'abc123',
  user: null,
  createdAt: '2026-05-04T00:00:00.000Z',
  updatedAt: '2026-05-04T00:05:00.000Z',
  mergedAt: null,
  closedAt: null,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  commits: 1,
  mergeable: true,
  mergeableState: 'clean',
};

const checkRuns: GitHubCheckRunsSummary = {
  status: 'none',
  conclusion: null,
  total: 0,
  runs: [],
};

const data: PrTabViewData = {
  pullRequest,
  reviewThreads: [],
  reviews: [],
  issueComments: [],
  checkRuns,
};

describe('PrTabView refresh button', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

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

  const renderView = (props: {
    state: PrTabViewState;
    isRefreshing?: boolean;
    data?: PrTabViewData | null;
  }) => {
    const onRefresh = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(PrTabView, {
          repoFullName: 'loro-dev/lody',
          prNumber: 42,
          state: props.state,
          data: 'data' in props ? props.data : data,
          isRefreshing: props.isRefreshing,
          onRefresh,
        })
      );
    });

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');
    if (!button) {
      throw new Error('Expected refresh button to be rendered');
    }
    return { button, onRefresh };
  };

  it('keeps the top refresh button clickable while the initial load is spinning', () => {
    const { button, onRefresh } = renderView({ state: 'loading', data: null });

    expect(button.disabled).toBe(false);
    expect(button.querySelector('.animate-spin')).not.toBeNull();

    flushSync(() => {
      button.click();
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the top refresh button clickable while revalidating cached PR data', () => {
    const { button, onRefresh } = renderView({ state: 'ready', isRefreshing: true });

    expect(button.disabled).toBe(false);
    expect(button.querySelector('.animate-spin')).not.toBeNull();

    flushSync(() => {
      button.click();
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('pins the comment composer below the scrollable PR content', () => {
    const onPostComment = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(PrTabView, {
          repoFullName: 'loro-dev/lody',
          prNumber: 42,
          state: 'ready',
          data,
          onPostComment,
        })
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Leave a comment"]'
    );
    const scrollArea = container.querySelector<HTMLElement>('[data-pr-content-scroll-area]');
    const composer = container.querySelector<HTMLElement>('[data-pr-comment-composer]');

    expect(textarea).not.toBeNull();
    expect(scrollArea).not.toBeNull();
    expect(scrollArea?.contains(textarea)).toBe(false);
    expect(composer?.contains(textarea)).toBe(true);
    expect(scrollArea?.nextElementSibling).toBe(composer);
  });

  it('lets the PR description expand inside the panel scroll area', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(PrTabView, {
          repoFullName: 'loro-dev/lody',
          prNumber: 42,
          state: 'ready',
          data: {
            ...data,
            pullRequest: {
              ...pullRequest,
              body: 'A long pull request description.',
            },
          },
        })
      );
    });

    const scrollArea = container.querySelector<HTMLElement>('[data-pr-content-scroll-area]');
    const description = container.querySelector<HTMLElement>('[data-pr-description]');
    const panelViewport = scrollArea?.querySelector<HTMLElement>(
      '[data-radix-scroll-area-viewport]'
    );

    expect(description).not.toBeNull();
    expect(description?.closest('[data-radix-scroll-area-viewport]')).toBe(panelViewport);
  });
});

const hunk = [
  '@@ -10,6 +10,8 @@ export function load() {',
  '   const a = 1;',
  '   const b = 2;',
  '-  const c = a + b;',
  '+  const c = add(a, b);',
  '+  const d = c * 2;',
  '   return d;',
].join('\n');

function makeThread(overrides: Partial<GitHubReviewThread> = {}): GitHubReviewThread {
  return {
    id: 7,
    anchor: { path: 'src/load.ts', line: 15, side: 'RIGHT', startLine: null, startSide: null },
    comments: [
      {
        id: 70,
        nodeId: 'RC_70',
        pullRequestReviewId: 9,
        body: 'Why double it?',
        path: 'src/load.ts',
        commitId: 'abc123',
        originalCommitId: 'abc123',
        diffHunk: hunk,
        subjectType: 'line',
        user: { login: 'bob', id: 2, avatarUrl: '', htmlUrl: 'https://github.com/bob' },
        authorAssociation: 'MEMBER',
        createdAt: '2026-05-04T00:10:00.000Z',
        updatedAt: '2026-05-04T00:10:00.000Z',
        htmlUrl: 'https://github.com/loro-dev/lody/pull/42#discussion_r70',
        line: 15,
        originalLine: 15,
        side: 'RIGHT',
        startLine: null,
        originalStartLine: null,
        startSide: null,
      },
    ],
    outdated: false,
    diffHunk: hunk,
    subjectType: 'line',
    ...overrides,
  };
}

describe('threadHunkExcerpt', () => {
  it('quotes the hunk tail that ends at the commented line', () => {
    expect(threadHunkExcerpt(makeThread())).toEqual([
      '-  const c = a + b;',
      '+  const c = add(a, b);',
      '+  const d = c * 2;',
      '   return d;',
    ]);
  });

  it('quotes a multi-line range whole', () => {
    const thread = makeThread({
      anchor: { path: 'src/load.ts', line: 15, side: 'RIGHT', startLine: 10, startSide: 'RIGHT' },
    });
    expect(threadHunkExcerpt(thread)).toHaveLength(6);
  });

  it('quotes nothing for a file-level thread', () => {
    expect(threadHunkExcerpt(makeThread({ subjectType: 'file' }))).toEqual([]);
  });
});

describe('PrTabView document', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
  });

  const render = (viewData: PrTabViewData) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        createElement(PrTabView, {
          repoFullName: 'loro-dev/lody',
          prNumber: 42,
          state: 'ready',
          data: viewData,
        })
      );
    });
    return container;
  };

  it('states the PR once: number in the header, state and branches under the title', () => {
    const el = render({
      ...data,
      pullRequest: { ...pullRequest, state: 'closed', merged: true },
    });
    expect(el.querySelector('h2')?.textContent).toBe('Fix refresh button');
    expect(el.textContent?.match(/#42/g)).toHaveLength(1);
    expect(el.querySelector('[data-pr-state]')?.getAttribute('data-pr-state')).toBe('merged');
    const branches = [...el.querySelectorAll('button[title]')].map((b) => b.textContent);
    expect(branches).toEqual(expect.arrayContaining(['main', 'fix/pr-refresh-button']));
  });

  it("files a review's thread under the review with its path, line and code", () => {
    const review: GitHubReview = {
      id: 9,
      nodeId: 'PRR_9',
      body: '',
      state: 'changes_requested',
      user: { login: 'alice', id: 1, avatarUrl: '', htmlUrl: 'https://github.com/alice' },
      authorAssociation: 'MEMBER',
      commitId: 'abc123',
      submittedAt: '2026-05-04T00:11:00.000Z',
      htmlUrl: 'https://github.com/loro-dev/lody/pull/42#pullrequestreview-9',
    };
    const el = render({ ...data, reviews: [review], reviewThreads: [makeThread()] });

    const thread = el.querySelector('[data-diff-comment-thread-id="7"]');
    expect(thread?.closest('article')?.textContent).toContain('requested changes');
    expect(thread?.textContent).toContain('src/load.ts');
    expect(thread?.textContent).toContain(':15');
    const excerpt = thread?.querySelector('[data-thread-excerpt]');
    expect(excerpt?.lastElementChild?.textContent).toBe('   return d;');
    expect(thread?.textContent).toContain('Why double it?');
  });

  it('opens an outdated thread collapsed, to a preview of its first comment', () => {
    const el = render({
      ...data,
      reviewThreads: [makeThread({ id: 8, outdated: true })],
    });
    const thread = el.querySelector('[data-diff-comment-thread-id="8"]');
    const toggle = thread?.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(thread?.querySelector('[data-thread-excerpt]')).toBeNull();
    expect(toggle?.textContent).toContain('bob: Why double it?');

    flushSync(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(thread?.querySelector('[data-thread-excerpt]')).not.toBeNull();
  });
});

describe('PrTabView merge card', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
  });

  const render = (pr: GitHubPullRequestDetails, extra: Record<string, unknown> = {}) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        createElement(PrTabView, {
          repoFullName: 'loro-dev/lody',
          prNumber: 42,
          state: 'ready',
          data: { ...data, pullRequest: pr },
          onMerge: vi.fn(),
          onSetState: vi.fn(),
          ...extra,
        })
      );
    });
    const el = container;
    return {
      card: el.querySelector<HTMLElement>('[data-pr-merge-card]'),
      header: el.querySelector<HTMLElement>('header'),
    };
  };

  it('keeps the merge action in the header and the verdict in the card', () => {
    const onMerge = vi.fn();
    const { card, header } = render(pullRequest, { onMerge });
    expect(card?.getAttribute('data-pr-merge-card')).toBe('ready');
    expect(card?.textContent).toContain('Ready to merge');
    expect(card?.querySelector('button[data-pr-merge-action], [data-pr-merge-action]')).toBeNull();

    const group = header?.querySelector('[data-pr-merge-action]');
    expect(group?.getAttribute('role')).toBe('group');
    const [merge, options] = [...(group?.querySelectorAll('button') ?? [])];
    expect(options?.getAttribute('aria-label')).toBe('More actions');
    flushSync(() => merge?.click());
    expect(onMerge).toHaveBeenCalledWith('merge');
  });

  it('drops the header action once merged with no branch left to delete', () => {
    const merged = render({ ...pullRequest, state: 'closed', merged: true });
    expect(
      merged.header?.querySelector('[role="group"], button[aria-label="More actions"]')
    ).toBeNull();
    expect(merged.card?.getAttribute('data-pr-merge-card')).toBe('merged');
  });

  it('names a conflict in the card and offers Resolve conflicts in the header', () => {
    const { card, header } = render(
      { ...pullRequest, mergeable: false, mergeableState: 'dirty' },
      { onResolveConflicts: vi.fn() }
    );
    expect(card?.getAttribute('data-pr-merge-card')).toBe('conflict');
    expect(card?.textContent).toContain('Conflicts with the base branch');
    expect(header?.textContent).toContain('Resolve conflicts');
  });
});
