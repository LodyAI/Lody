// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GitHubCheckRunsSummary,
  GitHubMergeResult,
  GitHubPullRequestDetails,
} from '@lody/shared';

const githubMocks = vi.hoisted(() => ({
  githubBranchExists: vi.fn(),
  githubCreatePRIssueComment: vi.fn(),
  githubDeleteBranch: vi.fn(),
  githubFetchCheckRuns: vi.fn(),
  githubFetchPRIssueComments: vi.fn(),
  githubFetchPRReviewComments: vi.fn(),
  githubFetchPullRequestDetails: vi.fn(),
  githubFetchPullRequestReviews: vi.fn(),
  githubMarkPullRequestReadyForReview: vi.fn(),
  githubMergePullRequest: vi.fn(),
  githubSetPullRequestState: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  readPrCacheEntry: vi.fn(),
  writePrCacheEntry: vi.fn(),
}));

const convexAuthMock = vi.hoisted(() => ({
  state: { isAuthenticated: true, isLoading: false } as {
    isAuthenticated: boolean;
    isLoading: boolean;
  },
}));

vi.mock('../src/hooks/use-recoverable-convex-query', () => ({
  usePublicConvexQuery: () => undefined,
  useRecoverableConvexQuery: () => null,
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => convexAuthMock.state,
}));

vi.mock('@lody/cloud-api', () => ({
  api: { github: { getPrCacheVersions: 'github.getPrCacheVersions' } },
}));

const githubTokenMockModule = vi.hoisted(() => ({
  withGitHubTokenRetry: vi.fn(
    async (_workspaceId: string, _repoFullName: string, run: (token: string) => Promise<unknown>) =>
      run('github-token')
  ),
  withGitHubOperationTokenRetry: async (
    _workspaceId: string,
    _repoFullName: string,
    _mode: 'read' | 'write',
    run: (token: string) => Promise<unknown>
  ) => run('github-token'),
  isGitHubUnauthorizedTokenError: (error: unknown) =>
    Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'unauthorized'
    ),
}));

vi.mock('@/lib/github-token', () => githubTokenMockModule);

vi.mock('../src/lib/github-token', () => githubTokenMockModule);

const prCacheMockModule = vi.hoisted(() => ({
  EMPTY_PR_CACHE_VERSIONS: {
    prDetailsFetchedAt: null,
    reviewCommentsFetchedAt: null,
    reviewsFetchedAt: null,
    issueCommentsFetchedAt: null,
    checkRunsFetchedAt: null,
  },
  getPrCacheKey: (workspaceId: string, repoFullName: string, prNumber: number) =>
    `${workspaceId}:${repoFullName.toLowerCase()}:#${prNumber}`,
  readPrCacheEntry: cacheMocks.readPrCacheEntry,
  writePrCacheEntry: cacheMocks.writePrCacheEntry,
}));

vi.mock('@/lib/github-pr-cache', () => prCacheMockModule);

vi.mock('../src/lib/github-pr-cache', () => prCacheMockModule);

vi.mock('@lody/shared', () => {
  class GitHubPermissionError extends Error {}

  return {
    getServerNow: () => Date.now(),
    GitHubPermissionError,
    githubBranchExists: githubMocks.githubBranchExists,
    githubCreatePRIssueComment: githubMocks.githubCreatePRIssueComment,
    githubDeleteBranch: githubMocks.githubDeleteBranch,
    githubFetchCheckRuns: githubMocks.githubFetchCheckRuns,
    githubFetchPRIssueComments: githubMocks.githubFetchPRIssueComments,
    githubFetchPRReviewComments: githubMocks.githubFetchPRReviewComments,
    githubFetchPullRequestDetails: githubMocks.githubFetchPullRequestDetails,
    githubFetchPullRequestReviews: githubMocks.githubFetchPullRequestReviews,
    githubMarkPullRequestReadyForReview: githubMocks.githubMarkPullRequestReadyForReview,
    githubMergePullRequest: githubMocks.githubMergePullRequest,
    githubSetPullRequestState: githubMocks.githubSetPullRequestState,
  };
});

import type {
  GitHubPrDetailsData,
  UseGitHubPrDetailsInput,
  UseGitHubPrDetailsResult,
} from '../src/hooks/use-github-pr-details';

const { getAuthRecoveryBackoffMs, useGitHubPrDetails } =
  await import('../src/hooks/use-github-pr-details');
const { TestCloudPlatformProvider } = await import('./test-platform');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_CHECK_RUNS: GitHubCheckRunsSummary = {
  status: 'none',
  conclusion: null,
  total: 0,
  runs: [],
};

const createPullRequest = (
  number: number,
  overrides: Partial<GitHubPullRequestDetails> = {}
): GitHubPullRequestDetails => ({
  number,
  nodeId: `PR_${number}`,
  title: `Pull request ${number}`,
  body: '',
  state: 'open',
  merged: false,
  draft: false,
  htmlUrl: `https://github.com/loro-dev/lody/pull/${number}`,
  baseRef: 'main',
  headRef: `branch-${number}`,
  headSha: `sha-${number}`,
  user: null,
  createdAt: '2026-05-26T00:00:00.000Z',
  updatedAt: '2026-05-26T00:01:00.000Z',
  mergedAt: null,
  closedAt: null,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  commits: 1,
  mergeable: true,
  mergeableState: 'clean',
  ...overrides,
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  if (!resolve || !reject) {
    throw new Error('Failed to create deferred promise');
  }
  return { promise, resolve, reject };
}

function Probe({
  input,
  onResult,
}: {
  input: UseGitHubPrDetailsInput;
  onResult: (result: UseGitHubPrDetailsResult) => void;
}) {
  const result = useGitHubPrDetails(input);
  useEffect(() => {
    onResult(result);
  }, [onResult, result]);
  return null;
}

describe('useGitHubPrDetails target isolation', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let currentResult: UseGitHubPrDetailsResult | null = null;

  const onResult = (result: UseGitHubPrDetailsResult) => {
    currentResult = result;
  };

  const renderHook = async (input: UseGitHubPrDetailsInput) => {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }

    await act(async () => {
      root?.render(
        createElement(TestCloudPlatformProvider, null, createElement(Probe, { input, onResult }))
      );
    });
  };

  const waitForResult = async (predicate: (result: UseGitHubPrDetailsResult) => boolean) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (currentResult && predicate(currentResult)) return;
      await act(async () => {
        if (vi.isFakeTimers()) {
          await vi.advanceTimersByTimeAsync(0);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
    throw new Error(
      `Timed out waiting for hook result: ${JSON.stringify({
        state: currentResult?.state,
        error: currentResult?.error?.message,
        number: currentResult?.data?.pullRequest.number,
        hasData: Boolean(currentResult?.data),
        readCalls: cacheMocks.readPrCacheEntry.mock.calls.length,
        fetchDetailsCalls: githubMocks.githubFetchPullRequestDetails.mock.calls.length,
      })}`
    );
  };

  beforeEach(() => {
    currentResult = null;
    convexAuthMock.state = { isAuthenticated: true, isLoading: false };
    cacheMocks.readPrCacheEntry.mockImplementation(
      async (workspaceId: string, repoFullName: string, prNumber: number) => ({
        workspaceId,
        repoFullName,
        prNumber,
        payload: {
          pullRequest: createPullRequest(prNumber),
          reviewThreads: [],
          reviews: [],
          issueComments: [],
          checkRuns: EMPTY_CHECK_RUNS,
          checksPermissionError: false,
        },
        versions: {
          prDetailsFetchedAt: Date.now(),
          reviewCommentsFetchedAt: Date.now(),
          reviewsFetchedAt: Date.now(),
          issueCommentsFetchedAt: Date.now(),
          checkRunsFetchedAt: Date.now(),
        },
        lastWriteAt: Date.now(),
      })
    );
    cacheMocks.writePrCacheEntry.mockResolvedValue(undefined);
    githubTokenMockModule.withGitHubTokenRetry.mockImplementation(
      async (
        _workspaceId: string,
        _repoFullName: string,
        run: (token: string) => Promise<unknown>
      ) => run('github-token')
    );
    githubMocks.githubFetchPullRequestDetails.mockImplementation(
      async (_token: string, _repoFullName: string, prNumber: number) => createPullRequest(prNumber)
    );
    githubMocks.githubFetchPRReviewComments.mockResolvedValue([]);
    githubMocks.githubFetchPullRequestReviews.mockResolvedValue([]);
    githubMocks.githubFetchPRIssueComments.mockResolvedValue([]);
    githubMocks.githubFetchCheckRuns.mockResolvedValue(EMPTY_CHECK_RUNS);
    githubMocks.githubBranchExists.mockResolvedValue(true);
    githubMocks.githubMarkPullRequestReadyForReview.mockResolvedValue(undefined);
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
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sends one request when two views of the same PR refresh together', async () => {
    const results: Array<UseGitHubPrDetailsResult | null> = [null, null];
    const input: UseGitHubPrDetailsInput = {
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 1,
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          TestCloudPlatformProvider,
          null,
          createElement(Probe, { input, onResult: (result) => (results[0] = result) }),
          createElement(Probe, { input, onResult: (result) => (results[1] = result) })
        )
      );
    });
    for (let attempt = 0; attempt < 30 && !results.every((r) => r?.state === 'ready'); attempt++) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    githubMocks.githubFetchPullRequestDetails.mockClear();
    const shared = createDeferred<GitHubPullRequestDetails>();
    githubMocks.githubFetchPullRequestDetails.mockReturnValue(shared.promise);

    let refreshes: Array<Promise<GitHubPrDetailsData | null> | undefined> = [];
    await act(async () => {
      refreshes = results.map((result) => result?.refresh());
      await Promise.resolve();
    });
    expect(githubMocks.githubFetchPullRequestDetails).toHaveBeenCalledTimes(1);

    await act(async () => {
      shared.resolve(createPullRequest(1, { title: 'Shared refresh' }));
      await Promise.all(refreshes);
    });
    expect(results.map((result) => result?.data?.pullRequest.title)).toEqual([
      'Shared refresh',
      'Shared refresh',
    ]);
  });

  it("does not let a refresh join another view's poll that started before it", async () => {
    vi.useFakeTimers();
    const results: Array<UseGitHubPrDetailsResult | null> = [null, null];
    const base: UseGitHubPrDetailsInput = {
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 1,
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          TestCloudPlatformProvider,
          null,
          // The merging view is off screen, so only the other view polls.
          createElement(Probe, {
            input: { ...base, visible: false },
            onResult: (result) => (results[0] = result),
          }),
          createElement(Probe, { input: base, onResult: (result) => (results[1] = result) })
        )
      );
    });
    for (let attempt = 0; attempt < 30 && !results.every((r) => r?.state === 'ready'); attempt++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    githubMocks.githubFetchPullRequestDetails.mockClear();
    const beforeMerge = createDeferred<GitHubPullRequestDetails>();
    const afterMerge = createDeferred<GitHubPullRequestDetails>();
    githubMocks.githubFetchPullRequestDetails
      .mockReturnValueOnce(beforeMerge.promise)
      .mockReturnValueOnce(afterMerge.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(githubMocks.githubFetchPullRequestDetails).toHaveBeenCalledTimes(1);

    // The first view merges, then refreshes: that read must be its own.
    let refreshed: Promise<GitHubPrDetailsData | null> | undefined;
    await act(async () => {
      refreshed = results[0]?.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(githubMocks.githubFetchPullRequestDetails).toHaveBeenCalledTimes(2);

    await act(async () => {
      afterMerge.resolve(createPullRequest(1, { title: 'After merge' }));
      beforeMerge.resolve(createPullRequest(1, { title: 'Before merge' }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect((await refreshed)?.pullRequest.title).toBe('After merge');
  });

  it('bypasses the browser cache when manually refreshing an idle PR tab', async () => {
    const refreshedPullRequest = createPullRequest(1, {
      title: 'Refreshed pull request',
      headSha: 'fresh-head-sha',
      updatedAt: '2026-05-26T00:02:00.000Z',
    });

    await renderHook({
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 1,
    });
    await waitForResult(
      (result) =>
        result.state === 'ready' &&
        !result.isRevalidating &&
        githubMocks.githubFetchPullRequestDetails.mock.calls.length === 1 &&
        githubMocks.githubFetchCheckRuns.mock.calls.length === 1
    );

    githubMocks.githubFetchPullRequestDetails.mockClear();
    githubMocks.githubFetchPRReviewComments.mockClear();
    githubMocks.githubFetchPullRequestReviews.mockClear();
    githubMocks.githubFetchPRIssueComments.mockClear();
    githubMocks.githubFetchCheckRuns.mockClear();
    const manualPullRequest = createDeferred<GitHubPullRequestDetails>();
    githubMocks.githubFetchPullRequestDetails.mockReturnValueOnce(manualPullRequest.promise);

    let refreshPromise: Promise<GitHubPrDetailsData | null> | null = null;
    await act(async () => {
      refreshPromise = currentResult?.refresh() ?? null;
      await Promise.resolve();
    });
    if (!refreshPromise) {
      throw new Error('Expected manual refresh to start');
    }
    await waitForResult((result) => result.isRevalidating);

    expect(githubMocks.githubFetchPullRequestDetails).toHaveBeenCalledTimes(1);
    expect(githubMocks.githubFetchPullRequestDetails).toHaveBeenCalledWith(
      'github-token',
      'loro-dev/lody',
      1,
      { cache: 'reload' }
    );
    expect(githubMocks.githubFetchCheckRuns).not.toHaveBeenCalled();

    await act(async () => {
      manualPullRequest.resolve(refreshedPullRequest);
      await refreshPromise;
    });

    expect(githubMocks.githubFetchPRReviewComments).toHaveBeenLastCalledWith(
      'github-token',
      'loro-dev/lody',
      1,
      { cache: 'reload' }
    );
    expect(githubMocks.githubFetchPullRequestReviews).toHaveBeenLastCalledWith(
      'github-token',
      'loro-dev/lody',
      1,
      { cache: 'reload' }
    );
    expect(githubMocks.githubFetchPRIssueComments).toHaveBeenLastCalledWith(
      'github-token',
      'loro-dev/lody',
      1,
      { cache: 'reload' }
    );
    expect(githubMocks.githubFetchCheckRuns).toHaveBeenLastCalledWith(
      'github-token',
      'loro-dev/lody',
      'fresh-head-sha',
      { cache: 'reload' }
    );
    expect(currentResult?.data?.pullRequest.title).toBe('Refreshed pull request');
    expect(currentResult?.isRevalidating).toBe(false);
  });

  it('fetches the current head and check runs without falling back to cached CI data', async () => {
    await renderHook({
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 1,
    });
    await waitForResult((result) => result.state === 'ready' && !result.isRevalidating);

    const freshPullRequest = createPullRequest(1, { headSha: 'fresh-ci-head' });
    const freshCheckRuns: GitHubCheckRunsSummary = {
      status: 'completed',
      conclusion: 'failure',
      total: 1,
      runs: [
        {
          id: 9,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          htmlUrl: 'https://github.com/loro-dev/lody/actions/runs/9',
          startedAt: null,
          completedAt: null,
          appName: 'GitHub Actions',
        },
      ],
    };
    githubMocks.githubFetchPullRequestDetails.mockClear();
    githubMocks.githubFetchCheckRuns.mockClear();
    githubMocks.githubFetchPullRequestDetails.mockResolvedValueOnce(freshPullRequest);
    githubMocks.githubFetchCheckRuns.mockResolvedValueOnce(freshCheckRuns);

    let refreshed: GitHubPrDetailsData | null = null;
    await act(async () => {
      refreshed = (await currentResult?.refreshCheckRuns()) ?? null;
    });

    expect(githubMocks.githubFetchPullRequestDetails).toHaveBeenCalledWith(
      'github-token',
      'loro-dev/lody',
      1,
      { cache: 'reload' }
    );
    expect(githubMocks.githubFetchCheckRuns).toHaveBeenCalledWith(
      'github-token',
      'loro-dev/lody',
      'fresh-ci-head',
      { cache: 'reload' }
    );
    expect(refreshed?.checkRuns).toEqual(freshCheckRuns);
  });

  it('rejects a fresh CI read failure instead of returning cached checks', async () => {
    await renderHook({
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 1,
    });
    await waitForResult((result) => result.state === 'ready' && !result.isRevalidating);

    const fetchError = new Error('check fetch failed');
    githubMocks.githubFetchCheckRuns.mockRejectedValueOnce(fetchError);
    let caught: unknown;
    await act(async () => {
      try {
        await currentResult?.refreshCheckRuns();
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBe(fetchError);
  });

  it('keeps a draft PR blocked while ready-for-review confirmation is still loading', async () => {
    const draftPullRequest = createPullRequest(1, {
      draft: true,
      mergeable: null,
      mergeableState: 'draft',
    });
    const readyPullRequest = createPullRequest(1, {
      draft: false,
      mergeable: true,
      mergeableState: 'clean',
      updatedAt: '2026-05-26T00:02:00.000Z',
    });

    cacheMocks.readPrCacheEntry.mockImplementationOnce(
      async (workspaceId: string, repoFullName: string, prNumber: number) => ({
        workspaceId,
        repoFullName,
        prNumber,
        payload: {
          pullRequest: draftPullRequest,
          reviewThreads: [],
          reviews: [],
          issueComments: [],
          checkRuns: EMPTY_CHECK_RUNS,
          checksPermissionError: false,
        },
        versions: {
          prDetailsFetchedAt: Date.now(),
          reviewCommentsFetchedAt: Date.now(),
          reviewsFetchedAt: Date.now(),
          issueCommentsFetchedAt: Date.now(),
          checkRunsFetchedAt: Date.now(),
        },
        lastWriteAt: Date.now(),
      })
    );
    githubMocks.githubFetchPullRequestDetails.mockResolvedValue(draftPullRequest);

    await renderHook({
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 1,
    });
    await waitForResult(
      (result) => result.data?.pullRequest.draft === true && !result.isMarkingReady
    );

    githubMocks.githubFetchPullRequestDetails.mockClear();
    const refetchDeferred = createDeferred<GitHubPullRequestDetails>();
    githubMocks.githubFetchPullRequestDetails.mockReturnValueOnce(refetchDeferred.promise);

    let readyPromise: Promise<void> | null = null;
    await act(async () => {
      readyPromise = currentResult?.markReadyForReview() ?? null;
    });
    if (!readyPromise) {
      throw new Error('Expected ready-for-review operation to start');
    }

    await waitForResult((result) => result.isMarkingReady);
    expect(currentResult?.data?.pullRequest.draft).toBe(true);
    expect(currentResult?.data?.pullRequest.mergeableState).toBe('draft');

    await act(async () => {
      refetchDeferred.resolve(readyPullRequest);
      await readyPromise;
    });

    expect(currentResult?.isMarkingReady).toBe(false);
    expect(currentResult?.data?.pullRequest.draft).toBe(false);
    expect(currentResult?.data?.pullRequest.mergeableState).toBe('clean');
  });

  it("never presents the previous PR's details as the next one's while its cache read is pending", async () => {
    await renderHook({ workspaceId: 'workspace-1', repoFullName: 'loro-dev/lody', prNumber: 1 });
    await waitForResult((result) => result.data?.pullRequest.number === 1);
    expect(currentResult?.state).toBe('ready');

    const pendingRead = createDeferred<null>();
    const pendingDetails = createDeferred<ReturnType<typeof createPullRequest>>();
    cacheMocks.readPrCacheEntry.mockReturnValueOnce(pendingRead.promise);
    githubMocks.githubFetchPullRequestDetails.mockReturnValueOnce(pendingDetails.promise);
    await renderHook({ workspaceId: 'workspace-1', repoFullName: 'loro-dev/lody', prNumber: 2 });

    // PR 1's checks and ready state must not render (or enable Merge) for PR 2.
    expect(currentResult?.data).toBeNull();
    expect(currentResult?.state).toBe('loading');

    await act(async () => {
      pendingRead.resolve(null);
      pendingDetails.resolve(createPullRequest(2));
    });
    await waitForResult((result) => result.data?.pullRequest.number === 2);
  });

  it('does not apply a completed merge to the PR opened after navigation', async () => {
    const mergeDeferred = createDeferred<GitHubMergeResult>();
    githubMocks.githubMergePullRequest.mockReturnValueOnce(mergeDeferred.promise);

    await renderHook({
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 1,
    });
    await waitForResult((result) => result.data?.pullRequest.number === 1);

    let mergePromise: Promise<void> | null = null;
    await act(async () => {
      mergePromise = currentResult?.mergePullRequest('merge') ?? null;
    });
    if (!mergePromise) {
      throw new Error('Expected merge operation to start');
    }
    expect(githubMocks.githubMergePullRequest).toHaveBeenCalledWith(
      'github-token',
      'loro-dev/lody',
      1,
      { method: 'merge', sha: 'sha-1' }
    );

    await renderHook({
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 2,
    });
    await waitForResult((result) => result.data?.pullRequest.number === 2);

    await act(async () => {
      mergeDeferred.resolve({ sha: 'merged-sha', merged: true, message: 'merged' });
      await mergePromise;
    });

    expect(currentResult?.data?.pullRequest.number).toBe(2);
    expect(currentResult?.data?.pullRequest.merged).toBe(false);
  });

  it('silently recovers from an apparent session expiry instead of showing the auth error', async () => {
    // Convex reports unauthenticated (a stale JWT after a long idle) and nothing
    // is cached, so the previous behavior dropped straight to a "Session
    // expired" screen the user had to dismiss by hand. The hook should instead
    // refetch silently — the token path mints a fresh JWT from the still-valid
    // BetterAuth cookie — and resolve to ready without surfacing an auth error.
    convexAuthMock.state = { isAuthenticated: false, isLoading: false };
    cacheMocks.readPrCacheEntry.mockResolvedValueOnce(null);

    await renderHook({
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 7,
    });

    await waitForResult(
      (result) => result.state === 'ready' && result.data?.pullRequest.number === 7
    );

    expect(currentResult?.data?.pullRequest.number).toBe(7);
    expect(githubMocks.githubFetchPullRequestDetails).toHaveBeenCalled();
  });

  it('grows the auth recovery delay and caps it at 30 seconds', () => {
    expect([0, 1, 2, 3, 99].map(getAuthRecoveryBackoffMs)).toEqual([
      1000, 3000, 10_000, 30_000, 30_000,
    ]);
  });

  it('surfaces a workspace membership failure without entering auth recovery', async () => {
    cacheMocks.readPrCacheEntry.mockResolvedValueOnce(null);
    const membershipError = Object.assign(new Error('Not a member of this workspace.'), {
      code: 'not_a_member',
    });
    githubTokenMockModule.withGitHubTokenRetry.mockRejectedValue(membershipError);

    await renderHook({
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 9,
    });

    await waitForResult(
      (result) =>
        result.state === 'error' &&
        result.error?.message === 'Not a member of this workspace.' &&
        githubTokenMockModule.withGitHubTokenRetry.mock.calls.length === 5
    );

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    });
    expect(githubTokenMockModule.withGitHubTokenRetry).toHaveBeenCalledTimes(5);
  });

  it('keeps auth recovery automatic after the first refresh attempt fails', async () => {
    vi.useFakeTimers();
    // Nothing is cached and Convex is temporarily unauthenticated. A failed
    // refresh must stay in the loading state and retry without asking the user
    // to sign in or click Retry.
    convexAuthMock.state = { isAuthenticated: false, isLoading: false };
    cacheMocks.readPrCacheEntry.mockResolvedValueOnce(null);
    const recoveredPullRequest = createDeferred<GitHubPullRequestDetails>();
    githubMocks.githubFetchPullRequestDetails
      .mockRejectedValueOnce(new Error('temporary auth refresh race'))
      .mockReturnValueOnce(recoveredPullRequest.promise);

    await renderHook({
      workspaceId: 'workspace-1',
      repoFullName: 'loro-dev/lody',
      prNumber: 8,
    });

    await waitForResult(
      (result) =>
        result.state === 'loading' && result.error?.message === 'temporary auth refresh race'
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitForResult(() => githubMocks.githubFetchPullRequestDetails.mock.calls.length >= 2);

    expect(currentResult?.state).toBe('loading');
    expect(currentResult?.data).toBeNull();

    await act(async () => {
      recoveredPullRequest.resolve(createPullRequest(8));
    });
    await waitForResult(
      (result) => result.state === 'ready' && result.data?.pullRequest.number === 8
    );

    expect(githubMocks.githubFetchPullRequestDetails).toHaveBeenCalledTimes(2);
  });
});
