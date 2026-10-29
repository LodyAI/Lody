// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, Provider, createStore, type Store } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubCheckRunsSummary, GitHubPullRequestDetails, WorkspaceId } from '@lody/shared';

const mocks = vi.hoisted(() => {
  class ReadyForReviewStillDraftError extends Error {
    constructor() {
      super('GitHub is still reporting this pull request as a draft.');
      this.name = 'ReadyForReviewStillDraftError';
    }
  }

  return {
    markReadyForReview: vi.fn(),
    mergePullRequest: vi.fn(),
    refresh: vi.fn(),
    toastError: vi.fn(),
    useGitHubPrDetails: vi.fn(),
    useGitHubPrDiff: vi.fn(),
    ReadyForReviewStillDraftError,
  };
});

vi.mock('@posthog/react', () => ({
  usePostHog: () => null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    error: mocks.toastError,
  },
}));

vi.mock('@/lib/github-token', () => ({
  isGitHubOperationTokenConnectionLostError: (error: unknown) =>
    error instanceof Error && error.message === 'Connection lost while action was in flight',
  isGitHubUnauthorizedTokenError: (error: unknown) =>
    Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'unauthorized'
    ),
}));

vi.mock('../src/lib/github-token', () => ({
  isGitHubOperationTokenConnectionLostError: (error: unknown) =>
    error instanceof Error && error.message === 'Connection lost while action was in flight',
  isGitHubUnauthorizedTokenError: (error: unknown) =>
    Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'unauthorized'
    ),
}));

vi.mock('@/hooks/use-github-pr-details', () => ({
  ReadyForReviewStillDraftError: mocks.ReadyForReviewStillDraftError,
  useGitHubPrDetails: mocks.useGitHubPrDetails,
}));

vi.mock('../src/hooks/use-github-pr-details', () => ({
  ReadyForReviewStillDraftError: mocks.ReadyForReviewStillDraftError,
  useGitHubPrDetails: mocks.useGitHubPrDetails,
}));

vi.mock('@/hooks/use-github-pr-diff', () => ({
  useGitHubPrDiff: mocks.useGitHubPrDiff,
}));

import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { PrTabContainer } from '../src/components/sessions/pr-tab-container';
import { resolveConflictsActionAtomFamily } from '../src/components/sessions/session-pr-agent-action';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const pullRequest: GitHubPullRequestDetails = {
  number: 42,
  nodeId: 'PR_kwDO_test',
  title: 'Fix ready for review',
  body: '',
  state: 'open',
  merged: false,
  draft: true,
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42',
  baseRef: 'main',
  headRef: 'fix/ready-for-review',
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
  mergeable: null,
  mergeableState: 'draft',
};

const checkRuns: GitHubCheckRunsSummary = {
  status: 'none',
  conclusion: null,
  total: 0,
  runs: [],
};

const mergeablePullRequest: GitHubPullRequestDetails = {
  ...pullRequest,
  draft: false,
  mergeable: true,
  mergeableState: 'clean',
};

const conflictedPullRequest: GitHubPullRequestDetails = {
  ...mergeablePullRequest,
  mergeable: false,
  mergeableState: 'dirty',
};

const dispatchedSessionAtom = atom<string | null>(null);

function createAuthError(): Error {
  return new Error('Not authenticated. Please sign in.');
}

function createPrDetailsResult(pr: GitHubPullRequestDetails = pullRequest) {
  return {
    canWrite: true,
    state: 'ready' as const,
    data: {
      pullRequest: pr,
      reviewThreads: [],
      reviews: [],
      issueComments: [],
      checkRuns,
    },
    error: null,

    checksPermissionError: false,
    isRevalidating: false,
    refresh: mocks.refresh,
    refreshCheckRuns: vi.fn().mockResolvedValue(null),
    postComment: vi.fn(),
    isPostingComment: false,
    mergePullRequest: mocks.mergePullRequest,
    isMerging: false,
    setPullRequestState: vi.fn(),
    isUpdatingState: false,
    markReadyForReview: mocks.markReadyForReview,
    isMarkingReady: false,
    deleteBranch: vi.fn(),
    isDeletingBranch: false,
    branchExists: null,
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('PrTabContainer ready-for-review auth recovery', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let store: Store;

  beforeEach(() => {
    mocks.markReadyForReview.mockReset();
    mocks.mergePullRequest.mockReset();
    mocks.refresh.mockReset();
    mocks.toastError.mockReset();
    mocks.useGitHubPrDetails.mockReset();
    mocks.useGitHubPrDiff.mockReset();

    store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-1' as WorkspaceId);
    mocks.refresh.mockResolvedValue(null);
    mocks.useGitHubPrDetails.mockReturnValue(createPrDetailsResult());
    mocks.useGitHubPrDiff.mockReturnValue({
      state: 'idle',
      commits: [],
      files: [],
      range: null,
      mergeBaseSha: null,
      error: null,
      contentByPath: new Map(),
      refresh: vi.fn().mockResolvedValue(undefined),
      loadFile: vi.fn().mockResolvedValue(undefined),
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.clearAllMocks();
  });

  async function renderContainer(): Promise<void> {
    await act(async () => {
      root?.render(
        <Provider store={store}>
          <PrTabContainer repoFullName="loro-dev/lody" prNumber={42} actionSessionId={null} />
        </Provider>
      );
    });
  }

  function getReadyButton(): HTMLButtonElement {
    const button = Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (node) => node.textContent?.includes('Ready for review')
    );
    if (!button) {
      throw new Error('Expected ready-for-review button');
    }
    return button;
  }

  function getMergeButton(): HTMLButtonElement {
    const button = Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (node) => node.textContent?.includes('Merge')
    );
    if (!button) {
      throw new Error('Expected merge button');
    }
    return button;
  }

  function getResolveConflictsButton(): HTMLButtonElement {
    const button = Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (node) => node.textContent?.includes('Resolve conflicts')
    );
    if (!button) {
      throw new Error('Expected resolve-conflicts button');
    }
    return button;
  }

  it('shows public PR details without mutation controls or a comment composer', async () => {
    mocks.useGitHubPrDetails.mockReturnValue({
      ...createPrDetailsResult(mergeablePullRequest),
      canWrite: false,
    });
    await renderContainer();
    expect(container?.textContent).toContain(mergeablePullRequest.title);
    expect(
      Array.from(container?.querySelectorAll('button') ?? []).some(
        (button) =>
          /Merge|Close pull request|Ready for review|Delete branch/.test(
            button.textContent ?? ''
          ) && !button.disabled
      )
    ).toBe(false);
    expect(container?.querySelector('textarea')).toBeNull();
  });

  it('dispatches conflict resolution to the selected child while retaining the PR owner for queries', async () => {
    store.set(resolveConflictsActionAtomFamily('root-session'), {
      available: true,
      pending: false,
      run: () => store.set(dispatchedSessionAtom, 'root-session'),
    });
    store.set(resolveConflictsActionAtomFamily('child-session'), {
      available: true,
      pending: false,
      run: () => store.set(dispatchedSessionAtom, 'child-session'),
    });
    mocks.useGitHubPrDetails.mockReturnValue(createPrDetailsResult(conflictedPullRequest));

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <PrTabContainer
            repoFullName="loro-dev/lody"
            prNumber={42}
            sessionId="root-session"
            actionSessionId="child-session"
          />
        </Provider>
      );
    });

    expect(mocks.useGitHubPrDetails.mock.calls.at(-1)?.[0].sessionId).toBe('root-session');
    await act(async () => getResolveConflictsButton().click());
    expect(store.get(dispatchedSessionAtom)).toBe('child-session');
  });

  it('uses the root session when it is the selected execution target', async () => {
    store.set(resolveConflictsActionAtomFamily('root-session'), {
      available: true,
      pending: false,
      run: () => store.set(dispatchedSessionAtom, 'root-session'),
    });
    mocks.useGitHubPrDetails.mockReturnValue(createPrDetailsResult(conflictedPullRequest));

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <PrTabContainer
            repoFullName="loro-dev/lody"
            prNumber={42}
            sessionId="root-session"
            actionSessionId="root-session"
          />
        </Provider>
      );
    });

    await act(async () => getResolveConflictsButton().click());
    expect(store.get(dispatchedSessionAtom)).toBe('root-session');
  });

  it('does not expose or dispatch the root action without an execution target', async () => {
    store.set(resolveConflictsActionAtomFamily('root-session'), {
      available: true,
      pending: false,
      run: () => store.set(dispatchedSessionAtom, 'root-session'),
    });
    mocks.useGitHubPrDetails.mockReturnValue(createPrDetailsResult(conflictedPullRequest));

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <PrTabContainer
            repoFullName="loro-dev/lody"
            prNumber={42}
            sessionId="root-session"
            actionSessionId={null}
          />
        </Provider>
      );
    });

    expect(
      Array.from(container?.querySelectorAll('button') ?? []).some((button) =>
        button.textContent?.includes('Resolve conflicts')
      )
    ).toBe(false);
    expect(store.get(dispatchedSessionAtom)).toBeNull();
  });

  it('refreshes once and retries without showing a toast on the first auth failure', async () => {
    mocks.markReadyForReview
      .mockRejectedValueOnce(createAuthError())
      .mockResolvedValueOnce(undefined);
    await renderContainer();

    await act(async () => {
      getReadyButton().click();
    });
    await flushPromises();

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.markReadyForReview).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('shows the ready-for-review toast when the retry still fails', async () => {
    mocks.markReadyForReview
      .mockRejectedValueOnce(createAuthError())
      .mockRejectedValueOnce(new Error('still unauthorized'));
    await renderContainer();

    await act(async () => {
      getReadyButton().click();
    });
    await flushPromises();

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.markReadyForReview).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to mark as ready for review', {
      description: 'still unauthorized',
    });
  });

  it('silently restores the merge action when Convex loses the token action result', async () => {
    mocks.useGitHubPrDetails.mockReturnValue(createPrDetailsResult(mergeablePullRequest));
    mocks.mergePullRequest.mockRejectedValueOnce(
      new Error('Connection lost while action was in flight')
    );
    await renderContainer();

    await act(async () => {
      getMergeButton().click();
    });
    await flushPromises();

    expect(mocks.mergePullRequest).toHaveBeenCalledWith('merge');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
