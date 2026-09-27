import { describe, expect, it } from 'vitest';
import {
  EMPTY_PR_CACHE_VERSIONS,
  getPrCacheKey,
  readPrCacheEntry,
  writePrCacheEntry,
  type PrCacheEntry,
} from '../src/lib/github-pr-cache';

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
