import { describe, expect, it } from 'vitest';
import { resolvePrCompareRange } from '../src/lib/github-pr-diff';
import {
  EMPTY_PR_CACHE_VERSIONS,
  getPrCacheKey,
  readPrCacheEntry,
  writePrCacheEntry,
  type PrCacheEntry,
} from '../src/lib/github-pr-cache';
import type { GitHubPullRequestDetails, GitHubCheckRun } from '@lody/shared';
import { mergePullRequestDetailsState } from '../src/lib/github-pr-details-state';
import {
  mapGitHubCheckRunToPrCiRun,
  summarizePrCiRuns,
} from '../src/components/sessions/session-info-chips';

describe('github-pr-diff', () => {
  const commits = [
    {
      sha: 'a',
      message: 'one',
      authorLogin: null,
      authoredAt: null,
      htmlUrl: null,
      parentSha: 'base',
    },
    {
      sha: 'b',
      message: 'two',
      authorLogin: null,
      authoredAt: null,
      htmlUrl: null,
      parentSha: 'a',
    },
    {
      sha: 'c',
      message: 'three',
      authorLogin: null,
      authoredAt: null,
      htmlUrl: null,
      parentSha: 'b',
    },
  ];

  describe('PR diff commit ranges', () => {
    it('compares all commits from the immutable PR base to head', () => {
      expect(
        resolvePrCompareRange({
          baseRef: 'main',
          baseSha: 'base',
          headSha: 'c',
          commits,
          selection: { type: 'all' },
        })
      ).toEqual({ from: 'base', to: 'c', historical: false });
    });

    it('uses the commit parent for a single commit and range', () => {
      expect(
        resolvePrCompareRange({
          baseRef: 'main',
          baseSha: 'base',
          headSha: 'c',
          commits,
          selection: { type: 'commit', sha: 'b' },
        })
      ).toEqual({ from: 'a', to: 'b', historical: true });
      expect(
        resolvePrCompareRange({
          baseRef: 'main',
          baseSha: 'base',
          headSha: 'c',
          commits,
          selection: { type: 'range', startSha: 'b', endSha: 'c' },
        })
      ).toEqual({ from: 'a', to: 'c', historical: true });
    });

    it('falls back to all commits for an invalid or reversed range', () => {
      expect(
        resolvePrCompareRange({
          baseRef: 'main',
          baseSha: 'base',
          headSha: 'c',
          commits,
          selection: { type: 'range', startSha: 'c', endSha: 'b' },
        })
      ).toEqual({ from: 'base', to: 'c', historical: false });
      expect(
        resolvePrCompareRange({
          baseRef: 'main',
          baseSha: 'base',
          headSha: 'c',
          commits,
          selection: { type: 'commit', sha: 'missing' },
        })
      ).toEqual({ from: 'base', to: 'c', historical: false });
    });
  });
});

describe('github-pr-cache', () => {
  describe('stable GitHub cache identity', () => {
    it('retains renamed repository cache without giving it to a repository reusing the name', async () => {
      const entry: PrCacheEntry = {
        workspaceId: 'identity-workspace',
        repoFullName: 'org/old',
        repositoryId: 10,
        prNumber: 7,
        payload: {
          pullRequest: null,
          reviewThreads: [],
          reviews: [],
          issueComments: [],
          checkRuns: { status: 'none', conclusion: null, total: 0, runs: [] },
          checksPermissionError: false,
        },
        versions: EMPTY_PR_CACHE_VERSIONS,
        lastWriteAt: 1,
      };
      await writePrCacheEntry(entry);
      expect(await readPrCacheEntry(entry.workspaceId, 'org/new', 7, 10)).toEqual(entry);
      expect(await readPrCacheEntry(entry.workspaceId, 'org/old', 7, 11)).toBeNull();
      expect(getPrCacheKey(entry.workspaceId, 'org/old', 7, 10)).not.toBe(
        getPrCacheKey(entry.workspaceId, 'org/old', 7)
      );
    });
  });
});

describe('github-pr-details-state', () => {
  const createPullRequest = (
    overrides: Partial<GitHubPullRequestDetails> = {}
  ): GitHubPullRequestDetails => ({
    number: 42,
    nodeId: 'PR_kwDO_test',
    title: 'Fix PR detail state',
    body: '',
    state: 'open',
    merged: false,
    draft: false,
    htmlUrl: 'https://github.com/loro-dev/lody/pull/42',
    baseRef: 'main',
    headRef: 'fix/pr-detail-state',
    headSha: 'abc123',
    user: null,
    createdAt: '2026-04-21T09:00:00.000Z',
    updatedAt: '2026-04-21T09:05:00.000Z',
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

  describe('mergePullRequestDetailsState', () => {
    it('does not let a stale PR details response roll a merged PR back to open', () => {
      const previous = createPullRequest({
        state: 'closed',
        merged: true,
        mergedAt: '2026-04-21T09:10:00.000Z',
        closedAt: '2026-04-21T09:10:00.000Z',
      });
      const incoming = createPullRequest({
        state: 'open',
        merged: false,
        updatedAt: '2026-04-21T09:11:00.000Z',
      });

      const merged = mergePullRequestDetailsState(previous, incoming);

      expect(merged).toMatchObject({
        state: 'closed',
        merged: true,
        mergedAt: '2026-04-21T09:10:00.000Z',
        closedAt: '2026-04-21T09:10:00.000Z',
        updatedAt: '2026-04-21T09:11:00.000Z',
      });
    });

    it('does not let a stale PR details response roll a ready PR back to draft', () => {
      const previous = createPullRequest({
        draft: false,
        mergeable: true,
        mergeableState: 'clean',
        updatedAt: '2026-04-21T09:10:00.000Z',
      });
      const incoming = createPullRequest({
        draft: true,
        mergeable: true,
        mergeableState: 'draft',
        updatedAt: '2026-04-21T09:05:00.000Z',
      });

      expect(mergePullRequestDetailsState(previous, incoming)).toMatchObject({
        draft: false,
        mergeable: true,
        mergeableState: 'clean',
        updatedAt: '2026-04-21T09:10:00.000Z',
      });
    });

    it('accepts a newer draft PR details update', () => {
      const previous = createPullRequest({
        draft: false,
        mergeable: true,
        mergeableState: 'clean',
        updatedAt: '2026-04-21T09:10:00.000Z',
      });
      const incoming = createPullRequest({
        draft: true,
        mergeable: true,
        mergeableState: 'draft',
        updatedAt: '2026-04-21T09:15:00.000Z',
      });

      expect(mergePullRequestDetailsState(previous, incoming)).toEqual(incoming);
    });
  });
});

describe('pr-ci-verdict', () => {
  function checkRun(
    name: string,
    conclusion: GitHubCheckRun['conclusion'],
    status: GitHubCheckRun['status'] = 'completed'
  ): GitHubCheckRun {
    return {
      id: name.length,
      name,
      status,
      conclusion,
      htmlUrl: `https://github.com/loro-dev/lody/actions/runs/${name.length}`,
      startedAt: null,
      completedAt: null,
      appName: 'GitHub Actions',
    };
  }

  describe('PR CI verdict', () => {
    const verdict = (runs: GitHubCheckRun[]) =>
      summarizePrCiRuns(runs.map(mapGitHubCheckRunToPrCiRun));

    it('does not report a cancelled check as a CI failure', () => {
      expect(verdict([checkRun('test', 'success'), checkRun('deploy', 'cancelled')])).toBe(
        'passing'
      );
      expect(verdict([checkRun('test', 'failure'), checkRun('deploy', 'cancelled')])).toBe(
        'failing'
      );
    });
  });
});
