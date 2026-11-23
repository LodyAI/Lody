// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GitHubAuthError } from '@lody/shared';

const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  client: { capture: vi.fn() },
  control: vi.fn(),
}));
vi.mock('@lody/shared', async (original) => ({
  ...(await original<object>()),
  githubFetchFilePaths: (...args: unknown[]) => state.fetch(...args),
}));
vi.mock('@/lib/posthog-context', () => ({ usePostHog: () => state.client }));
vi.mock('../src/atoms', async () => {
  const { atom } = await import('jotai');
  return {
    currentWorkspaceIdAtom: atom('ws'),
    userAtom: atom({ id: 'user-1' }),
    runtimeAtom: atom({
      requestLocalProjectControl: (request: unknown) => state.control(request),
    }),
  };
});
vi.mock('../src/lib/github-token', () => ({
  withGitHubTokenRetry: (_ws: string, _repo: string, run: (token: string) => unknown) =>
    run('token'),
}));
import { useRepoFilePaths } from '../src/components/mentions/file-at-mention';
import {
  useMentionProjectFiles,
  type MentionProjectSource,
} from '../src/components/mentions/mention-project-file-source';
import { unsupportedLocalProjectControlResponse } from '../src/lib/local-project-rpc-file-provider';

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
  state.control.mockReset();
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

const remoteProject = {
  kind: 'local',
  machineId: 'machine-remote',
  workspaceId: 'ws',
  localProjectId: 'lp-1',
} as MentionProjectSource;

let searchRemote: ((term: string) => void) | undefined;
function MentionFilesProbe(props: {
  source: MentionProjectSource;
  active: boolean;
  text?: string;
}) {
  const { fileData, searchRemoteFiles } = useMentionProjectFiles(props.source, {
    active: props.active,
    hydrationText: props.text ?? '',
  });
  searchRemote = searchRemoteFiles;
  return (
    <span>
      {fileData.status}:{fileData.entry?.paths.join(',')}
    </span>
  );
}

function controlRequests(): Array<{ type: string; query?: string }> {
  return state.control.mock.calls.map(([request]) => request as { type: string; query?: string });
}

it('fetches nothing for a selected repository until the file source is asked for', async () => {
  state.fetch.mockResolvedValue({
    defaultBranch: 'main',
    headSha: 'a',
    paths: ['src/app.ts'],
    truncated: false,
  });
  const github = { kind: 'github', repoFullName: 'org/lazy' } as MentionProjectSource;

  await act(async () => root.render(<MentionFilesProbe source={github} active={false} />));
  expect(state.fetch).not.toHaveBeenCalled();
  expect(container.textContent).toBe('loading:');

  await act(async () => root.render(<MentionFilesProbe source={github} active />));
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe('ready:src/app.ts');
});

it('searches a remote project on its machine instead of listing every file', async () => {
  state.control.mockImplementation(async (request: { type: string; query: string }) => ({
    ok: true,
    type: 'local-project/search-files',
    result: {
      paths: request.query === 'src/old.ts' ? ['src/old.ts'] : ['src/button.tsx'],
      truncated: false,
    },
  }));

  await act(async () =>
    root.render(<MentionFilesProbe source={remoteProject} active text="see @src/old.ts" />)
  );
  expect(controlRequests()).toEqual([
    expect.objectContaining({ type: 'local-project/search-files', query: 'src/old.ts' }),
  ]);
  expect(container.textContent).toBe('ready:src/old.ts');

  await act(async () => searchRemote?.('btn'));
  await act(async () => searchRemote?.('btn'));
  expect(controlRequests().map((request) => request.query)).toEqual(['src/old.ts', 'btn']);
  expect(controlRequests().some((request) => request.type === 'local-project/list-files')).toBe(
    false
  );
  expect(container.textContent).toBe('ready:src/button.tsx,src/old.ts');
});

it('opens the remote Files category with the host shallowest paths, loading until they arrive', async () => {
  let resolve!: (value: unknown) => void;
  state.control.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    })
  );
  const project = { ...remoteProject, localProjectId: 'lp-empty' } as MentionProjectSource;

  await act(async () => root.render(<MentionFilesProbe source={project} active />));
  expect(container.textContent).toBe('loading:');

  await act(async () => searchRemote?.(''));
  expect(controlRequests()).toEqual([
    expect.objectContaining({ type: 'local-project/search-files', query: '' }),
  ]);
  expect(container.textContent).toBe('loading:');

  await act(async () => {
    resolve({
      ok: true,
      type: 'local-project/search-files',
      result: { paths: ['README.md', 'package.json'], truncated: false },
    });
  });
  expect(container.textContent).toBe('ready:package.json,README.md');
});

it('falls back to the full list when the remote daemon predates host search', async () => {
  state.control.mockImplementation(async (request: { type: string }) =>
    request.type === 'local-project/search-files'
      ? unsupportedLocalProjectControlResponse('local-project/search-files')
      : {
          ok: true,
          type: 'local-project/list-files',
          result: { paths: ['legacy.ts'], truncated: false },
        }
  );
  const legacyProject = { ...remoteProject, localProjectId: 'lp-legacy' } as MentionProjectSource;

  await act(async () => root.render(<MentionFilesProbe source={legacyProject} active />));
  await act(async () => searchRemote?.('leg'));
  await act(async () => {});

  expect(controlRequests().map((request) => request.type)).toEqual([
    'local-project/search-files',
    'local-project/list-files',
  ]);
  expect(searchRemote).toBeUndefined();
  expect(container.textContent).toBe('ready:legacy.ts');
});
