// @vitest-environment jsdom
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GitHubAuthError } from '@lody/shared';

const state = vi.hoisted(() => ({ fetch: vi.fn(), client: { capture: vi.fn() } }));
vi.mock('@lody/shared', async (original) => ({
  ...(await original<object>()),
  githubFetchFilePaths: (...args: unknown[]) => state.fetch(...args),
}));
vi.mock('@posthog/react', () => ({ usePostHog: () => state.client }));
vi.mock('../src/atoms', async () => ({
  currentWorkspaceIdAtom: (await import('jotai')).atom('ws'),
}));
vi.mock('../src/lib/github-token', () => ({
  withGitHubTokenRetry: (_ws: string, _repo: string, run: (token: string) => unknown) =>
    run('token'),
}));
import { useRepoFilePaths } from '../src/components/mentions/file-at-mention';

import { clearRepoFilePathsMemoryCache } from '../src/lib/repo-file-paths-cache';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const container = document.createElement('div');
let root = createRoot(container);
function Probe({ repo = 'org/repo' }: { repo?: string }) {
  const data = useRepoFilePaths(repo);
  return (
    <span>
      {data.status}:{data.entry?.paths.join(',')}
    </span>
  );
}
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  clearRepoFilePathsMemoryCache();
  state.fetch.mockReset();
  state.client = { capture: vi.fn() };
});
it('keeps shared failures visible and retryable without analytics, including after unmount', async () => {
  let reject!: (error: unknown) => void;
  state.fetch.mockReturnValue(
    new Promise((_, r) => {
      reject = r;
    })
  );
  await act(async () =>
    root.render(
      <>
        <Probe key="first" />
        <Probe key="second" />
      </>
    )
  );
  expect(container.textContent).toBe('loading:loading:');
  await act(async () => {
    reject(new GitHubAuthError());
  });
  expect(container.textContent).toBe('error:error:');
  expect(state.client.capture.mock.calls).toEqual([]);
  state.client = { capture: vi.fn() };
  await act(async () =>
    root.render(
      <>
        <Probe key="first" />
        <Probe key="second" />
      </>
    )
  );
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe('error:error:');
  expect(state.client.capture.mock.calls).toEqual([]);

  state.fetch.mockReturnValue(
    new Promise((_, r) => {
      reject = r;
    })
  );
  await act(async () => root.render(<Probe key="retry" />));
  await act(async () => root.render(null));
  await act(async () => {
    reject(new Error('GitHub API error: 429'));
  });
  expect(state.client.capture.mock.calls).toEqual([]);
  expect(container.textContent).toBe('');

  state.fetch.mockResolvedValueOnce({
    defaultBranch: 'main',
    headSha: 'b',
    paths: ['recovered.ts'],
    truncated: false,
  });
  await act(async () => root.render(<Probe key="recovered" />));
  expect(container.textContent).toBe('ready:recovered.ts');
  expect(state.client.capture.mock.calls).toEqual([]);
});
it('does not retain another repository paths when the next repository fails', async () => {
  state.fetch.mockResolvedValueOnce({
    defaultBranch: 'main',
    headSha: 'a',
    paths: ['old.ts'],
    truncated: false,
  });
  await act(async () => root.render(<Probe />));
  expect(container.textContent).toBe('ready:old.ts');
  state.fetch.mockRejectedValueOnce(new Error('GitHub API error: 404'));
  await act(async () => root.render(<Probe repo="org/other" />));
  expect(container.textContent).toBe('error:');
});
