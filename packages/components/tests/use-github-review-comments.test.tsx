// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installGitHubTokenPort } from '../src/lib/github-token-port';
import { invalidateGitHubTokensForWorkspace } from '../src/lib/github-token';
import {
  useGitHubReviewComments,
  type UseGitHubReviewCommentsResult,
} from '../src/hooks/use-github-review-comments';

const mocks = vi.hoisted(() => ({
  versions: undefined as
    | undefined
    | null
    | { identityPending?: boolean; repositoryId?: number; repoFullName?: string },
  repair: vi.fn(async () => ({ resolved: false })),
}));
vi.mock('@lody/platform/react', async (original) => ({
  ...(await original<typeof import('@lody/platform/react')>()),
  useCloudQuery: () => mocks.versions,
  useCloudMutation: () => mocks.repair,
}));
vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ isAuthenticated: true }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('@lody/shared', async (original) => ({
  ...(await original<typeof import('@lody/shared')>()),
  githubFetchPRReviewComments: async () => [],
}));

let root: Root;
let container: HTMLDivElement;
let result: UseGitHubReviewCommentsResult;
let dispose: () => void;
const writes: string[] = [];
let remoteId = 101;
function Probe() {
  const value = useGitHubReviewComments({
    workspaceId: 'review-identity',
    sessionId: 'session',
    repoFullName: 'org/old',
    prNumber: 7,
  });
  useEffect(() => {
    result = value;
  });
  return null;
}
const render = async () => {
  await act(async () => {
    root.render(<Probe />);
  });
};
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  root = createRoot(container);
  remoteId = 101;
  writes.length = 0;
  mocks.versions = { repositoryId: 101, repoFullName: 'org/new' };
  mocks.repair.mockClear();
  invalidateGitHubTokensForWorkspace('review-identity');
  dispose = installGitHubTokenPort({
    getRepoToken: async () => ({
      success: true,
      token: 'synthetic',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    getOperationToken: async () => ({ success: true, token: 'synthetic', tokenSource: 'app' }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        writes.push(url);
        return { ok: true, json: async () => ({ saved: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: remoteId, full_name: 'org/new' }) };
    })
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  dispose();
  vi.unstubAllGlobals();
});

it('writes using the canonical repository after validating its stable ID', async () => {
  await render();
  const saved = await result.runWithToken('write', async (_token, repo) =>
    (
      await fetch(`https://api.github.com/repos/${repo}/pulls/7/comments`, { method: 'POST' })
    ).json()
  );
  expect(saved).toEqual({ saved: true });
  expect(writes).toEqual(['https://api.github.com/repos/org/new/pulls/7/comments']);
});

it('rejects a reused name before sending any comment write', async () => {
  await render();
  remoteId = 202;
  await expect(
    result.runWithToken('write', async (_token, repo) =>
      fetch(`https://api.github.com/repos/${repo}/pulls/7/comments`, { method: 'POST' })
    )
  ).rejects.toMatchObject({ code: 'repository_identity_changed' });
  expect(writes).toEqual([]);
});

it.each([undefined, null, { identityPending: true }])(
  'blocks reads and writes without resolved session identity (%j)',
  async (versions) => {
    mocks.versions = versions;
    await render();
    await expect(
      result.runWithToken('write', async () => {
        writes.push('unsafe');
      })
    ).rejects.toThrow();
    expect(result.threads).toEqual([]);
    expect(writes).toEqual([]);
  }
);

it('keeps the identity gate closed when safe repair is unavailable', async () => {
  mocks.versions = { identityPending: true };
  mocks.repair.mockRejectedValueOnce(new Error('offline'));
  await render();
  expect(result.status).toBe('error');
  expect(result.error?.message).toContain('repository identity');
  await expect(result.refresh()).resolves.toBeUndefined();
  expect(result.threads).toEqual([]);
});
