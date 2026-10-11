import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchFilePaths = vi.hoisted(() => vi.fn());

vi.mock('@lody/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lody/shared')>()),
  githubFetchFilePaths: fetchFilePaths,
}));
vi.mock('../src/lib/github-token', () => ({
  withGitHubTokenRetry: (_ws: string, _repo: string, run: (token: string) => unknown) =>
    run('token'),
}));

const {
  clearRepoFilePathsMemoryCache,
  loadRepoFilePaths,
  fetchRepoFilePaths,
  readCachedRepoFilePaths,
  getRepoFilePathsCacheKey,
} = await import('../src/lib/repo-file-paths-cache');
const { GitHubRepoFileProvider } = await import('../src/lib/github-repo-file-provider');

const tree = (paths: string[]) => ({
  defaultBranch: 'main',
  headSha: 'abc',
  paths,
  truncated: false,
});

describe('repo file paths cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T00:00:00Z'));
  });

  afterEach(() => {
    clearRepoFilePathsMemoryCache();
    fetchFilePaths.mockReset();
    vi.useRealTimers();
  });

  it('downloads a tree once for concurrent and repeated searches', async () => {
    let resolve!: (value: unknown) => void;
    fetchFilePaths.mockReturnValueOnce(new Promise((r) => (resolve = r)));

    const first = loadRepoFilePaths('ws', 'org/repo', 'main');
    const second = loadRepoFilePaths('ws', 'org/repo', 'main');
    resolve(tree(['a.ts']));

    expect((await first).paths).toEqual(['a.ts']);
    expect((await second).paths).toEqual(['a.ts']);
    expect((await loadRepoFilePaths('ws', 'org/repo', 'main')).paths).toEqual(['a.ts']);
    expect(fetchFilePaths).toHaveBeenCalledTimes(1);
  });

  it('keys by branch and refreshes a stale tree', async () => {
    fetchFilePaths
      .mockResolvedValueOnce(tree(['main.ts']))
      .mockResolvedValueOnce(tree(['feature.ts']))
      .mockResolvedValueOnce(tree(['main-2.ts']));

    expect((await loadRepoFilePaths('ws', 'org/repo', 'main')).paths).toEqual(['main.ts']);
    expect((await loadRepoFilePaths('ws', 'org/repo', 'feature')).paths).toEqual(['feature.ts']);

    vi.setSystemTime(new Date('2026-09-23T07:00:00Z'));
    expect((await loadRepoFilePaths('ws', 'org/repo', 'main')).paths).toEqual(['main-2.ts']);
  });

  it('does not cache a failed download', async () => {
    fetchFilePaths.mockRejectedValueOnce(new Error('403')).mockResolvedValueOnce(tree(['a.ts']));

    await expect(loadRepoFilePaths('ws', 'org/repo')).rejects.toThrow('403');
    expect((await loadRepoFilePaths('ws', 'org/repo')).paths).toEqual(['a.ts']);
  });

  it('searches a GitHub repository fresh once per file browser, not from the TTL cache', async () => {
    fetchFilePaths
      .mockResolvedValueOnce(tree(['old.ts']))
      .mockResolvedValueOnce(tree(['old.ts', 'pushed.ts']));
    // A mention search earlier today cached the tree.
    await loadRepoFilePaths('ws', 'org/repo', 'main');

    const browser = new GitHubRepoFileProvider({
      workspaceId: 'ws',
      repoFullName: 'org/repo',
      branch: 'main',
    });
    const paths = async (query: string) =>
      (await browser.searchFiles(query)).map((entry) => entry.path);
    expect(await paths('pushed')).toEqual(['pushed.ts']);
    // Later keystrokes reuse the browser's copy.
    expect(await paths('old')).toEqual(['old.ts']);
    expect(fetchFilePaths).toHaveBeenCalledTimes(2);
  });
});

describe('shared file download failures', () => {
  afterEach(() => {
    clearRepoFilePathsMemoryCache();
    fetchFilePaths.mockReset();
    vi.useRealTimers();
  });

  it('reports one failed attempt to the first observer, rejects every caller, then retries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const error = new Error('GitHub API error: 503 unavailable');
    let reject!: (error: unknown) => void;
    fetchFilePaths.mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r;
      })
    );
    const reports: unknown[] = [];
    // A file browser can start the operation before any mention observer joins.
    const browser = fetchRepoFilePaths('ws', 'org/repo');
    const first = fetchRepoFilePaths('ws', 'org/repo', undefined, (err, duration) => {
      reports.push({ err, duration });
    });
    const second = fetchRepoFilePaths('ws', 'org/repo', undefined, () => {
      reports.push('duplicate');
    });
    const settled = Promise.allSettled([browser, first, second]);
    vi.setSystemTime(1250);
    reject(error);
    expect(await settled).toEqual(
      Array.from({ length: 3 }, () => ({ status: 'rejected', reason: error }))
    );
    expect(reports).toEqual([{ err: error, duration: 250 }]);
    expect(await readCachedRepoFilePaths(getRepoFilePathsCacheKey('ws', 'org/repo'))).toBeNull();

    // Another genuine attempt with the SAME error object must still be reported.
    fetchFilePaths.mockRejectedValueOnce(error);
    await expect(
      fetchRepoFilePaths('ws', 'org/repo', undefined, (err) => {
        reports.push(err);
      })
    ).rejects.toBe(error);
    expect(reports).toEqual([{ err: error, duration: 250 }, error]);
    fetchFilePaths.mockResolvedValueOnce(tree(['recovered.ts']));
    expect((await loadRepoFilePaths('ws', 'org/repo')).paths).toEqual(['recovered.ts']);
  });

  it('preserves a stale tree and the original failure even if the observer throws', async () => {
    fetchFilePaths.mockResolvedValueOnce(tree(['cached.ts']));
    const cached = await loadRepoFilePaths('ws', 'org/repo');
    const error = new Error('403');
    fetchFilePaths.mockRejectedValueOnce(error);
    await expect(
      fetchRepoFilePaths('ws', 'org/repo', undefined, () => {
        throw new Error('observer');
      })
    ).rejects.toBe(error);
    expect(await readCachedRepoFilePaths(getRepoFilePathsCacheKey('ws', 'org/repo'))).toBe(cached);
  });
});
