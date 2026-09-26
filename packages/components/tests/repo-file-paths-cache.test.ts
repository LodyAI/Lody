import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchFilePaths = vi.hoisted(() => vi.fn());

vi.mock('@lody/shared', () => ({ githubFetchFilePaths: fetchFilePaths }));
vi.mock('../src/lib/github-token', () => ({
  withGitHubTokenRetry: (_ws: string, _repo: string, run: (token: string) => unknown) =>
    run('token'),
}));

const { clearRepoFilePathsMemoryCache, loadRepoFilePaths } =
  await import('../src/lib/repo-file-paths-cache');

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
});
