// @vitest-environment jsdom

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGitHubTokenPort } from '../src/lib/github-token-port';
import { invalidateGitHubTokensForWorkspace } from '../src/lib/github-token';
import { githubBranchesCache } from '../src/lib/local-storage-cache';
import {
  GITHUB_BRANCH_SEARCH_DEBOUNCE_MS,
  useGitHubRepoBranches,
  type UseGitHubRepoBranchesResult,
} from '../src/hooks/use-github-repo-branches';

const WORKSPACE_ID = 'branch-paging-workspace';
const REPO = 'owner/repo';

// 251 synthetic branches: three GitHub pages, default branch on the last one.
const BRANCH_NAMES = [
  ...Array.from({ length: 250 }, (_, i) => `feature/${String(i).padStart(3, '0')}`),
  'trunk',
];

type Probe = UseGitHubRepoBranchesResult & { selectedBranch: string | null };

let root: Root;
let container: HTMLDivElement;
let latest: Probe;
let requests: string[];
let disposeTokenPort: () => void;

function BranchesProbe({ initialBranch }: { initialBranch: string | null }) {
  const [selectedBranch, setSelectedBranch] = useState<string | null>(initialBranch);
  const value = useGitHubRepoBranches({
    enabled: true,
    workspaceId: WORKSPACE_ID,
    repoFullName: REPO,
    selectedBranch,
    setSelectedBranch,
  });
  useEffect(() => {
    latest = { ...value, selectedBranch };
  });
  return null;
}

function pageResponse(page: number): Response {
  const start = (page - 1) * 100;
  const headers = new Headers();
  if (start + 100 < BRANCH_NAMES.length) {
    headers.set(
      'link',
      `<https://api.github.com/repositories/42/branches?per_page=100&page=${page + 1}>; rel="next"`
    );
  }
  return new Response(
    JSON.stringify(BRANCH_NAMES.slice(start, start + 100).map((name) => ({ name }))),
    { headers }
  );
}

function githubResponse(input: string | URL | Request): Response {
  const url = new URL(String(input));
  if (url.pathname === `/repos/${REPO}`) {
    return new Response(JSON.stringify({ default_branch: 'trunk' }));
  }
  if (url.pathname === `/repos/${REPO}/branches` || url.pathname === '/repositories/42/branches') {
    return pageResponse(Number(url.searchParams.get('page') ?? '1'));
  }
  const refsPrefix = `/repos/${REPO}/git/matching-refs/heads/`;
  if (url.pathname.startsWith(refsPrefix)) {
    const prefix = decodeURIComponent(url.pathname.slice(refsPrefix.length));
    return new Response(
      JSON.stringify(
        BRANCH_NAMES.filter((name) => name.startsWith(prefix)).map((name) => ({
          ref: `refs/heads/${name}`,
        }))
      )
    );
  }
  return new Response('not found', { status: 404 });
}

/** Settles fetch promise chains without depending on wall-clock time. */
async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(initialBranch: string | null = null) {
  await act(async () => {
    root.render(<BranchesProbe initialBranch={initialBranch} />);
  });
  await flush();
}

const branchPageRequests = () =>
  requests.filter((url) => new URL(url).pathname.endsWith('/branches'));
const searchRequests = () => requests.filter((url) => url.includes('/git/matching-refs/heads/'));

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  root = createRoot(container);
  requests = [];
  githubBranchesCache.remove(`${WORKSPACE_ID}:${REPO}`);
  invalidateGitHubTokensForWorkspace(WORKSPACE_ID);
  disposeTokenPort = installGitHubTokenPort({
    getRepoToken: async () => ({
      success: true,
      token: 'synthetic',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    getOperationToken: async () => ({ success: true, token: 'synthetic', tokenSource: 'app' }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      return githubResponse(input);
    })
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeTokenPort();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useGitHubRepoBranches', () => {
  it('shows the default branch from the first page and loads later pages only on demand', async () => {
    await render();

    expect(latest.defaultBranch).toBe('trunk');
    expect(latest.selectedBranch).toBe('trunk');
    expect(latest.branches).toHaveLength(101);
    expect(latest.hasMore).toBe(true);
    expect(branchPageRequests()).toHaveLength(1);

    await act(async () => latest.onReachEnd());
    await flush();
    expect(latest.branches).toContain('feature/199');
    expect(latest.branches).not.toContain('feature/200');

    await act(async () => latest.onReachEnd());
    await flush();
    expect(latest.branches).toEqual(BRANCH_NAMES);
    expect(latest.hasMore).toBe(false);
    expect(branchPageRequests()).toHaveLength(3);

    await act(async () => latest.onReachEnd());
    await flush();
    expect(branchPageRequests()).toHaveLength(3);
  });

  it('resolves a typed query on GitHub once and keeps the result for that repository', async () => {
    await render();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await act(async () => latest.onSearchQueryChange('feature/2'));
    await act(async () => latest.onSearchQueryChange('feature/24'));
    expect(latest.searching).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GITHUB_BRANCH_SEARCH_DEBOUNCE_MS);
    });
    await flush();

    expect(searchRequests()).toHaveLength(1);
    expect(searchRequests()[0]).toContain('/heads/feature/24');
    expect(latest.searching).toBe(false);
    expect(latest.branches).toContain('feature/249');
    // Scrolling while a query is typed does not page through the whole repository.
    await act(async () => latest.onReachEnd());
    expect(branchPageRequests()).toHaveLength(1);

    await act(async () => latest.onSearchQueryChange(''));
    await act(async () => latest.onSearchQueryChange('feature/24'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GITHUB_BRANCH_SEARCH_DEBOUNCE_MS);
    });
    expect(searchRequests()).toHaveLength(1);
  });

  it('keeps a restored branch beyond the first page once GitHub confirms it exists', async () => {
    await render('feature/230');

    expect(latest.selectedBranch).toBe('feature/230');
    expect(latest.branches).toContain('feature/230');
    expect(searchRequests()).toHaveLength(1);
  });

  it('keeps a confirmed branch listed when the first page arrives after a cached listing', async () => {
    githubBranchesCache.set(`${WORKSPACE_ID}:${REPO}`, {
      branches: BRANCH_NAMES.slice(0, 100),
      defaultBranch: 'trunk',
      nextPageUrl: 'https://api.github.com/repositories/42/branches?per_page=100&page=2',
      updatedAt: 0,
    });
    let releaseFirstPage!: () => void;
    const firstPageHeld = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        requests.push(String(input));
        if (new URL(String(input)).pathname === `/repos/${REPO}/branches`) await firstPageHeld;
        return githubResponse(input);
      })
    );

    await render('feature/230');
    expect(latest.branches).toContain('feature/230');

    releaseFirstPage();
    await flush();
    expect(branchPageRequests()).toHaveLength(1);
    expect(latest.selectedBranch).toBe('feature/230');
    expect(latest.branches).toContain('feature/230');
  });

  it('falls back to the default branch when a restored branch no longer exists', async () => {
    await render('deleted/branch');

    expect(latest.selectedBranch).toBe('trunk');
    expect(latest.branches).not.toContain('deleted/branch');
  });

  it('renders the cached listing and its cursor before the network answers', async () => {
    await render();
    await act(async () => latest.onReachEnd());
    await flush();
    await act(async () => root.unmount());
    root = createRoot(container);
    requests = [];
    // The cached listing renders before the network answers; the fresh first page
    // then replaces it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>(() => {
            /* never resolves */
          })
      )
    );
    await act(async () => {
      root.render(<BranchesProbe initialBranch={null} />);
    });

    expect(latest.branches).toContain('feature/199');
    expect(latest.hasMore).toBe(true);
    expect(latest.selectedBranch).toBe('trunk');
  });
});
