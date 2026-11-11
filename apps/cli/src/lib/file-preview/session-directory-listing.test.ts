import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FILE_PREVIEW_PROTOCOL_VERSION, type SessionId } from '@lody/shared';
import { LocalProjectControlService } from '../local-project-control-service';
import type { Logger } from '../../utils/logger';
import type { FilePreviewWorkspaceResolver } from './file-preview-service';
import { listSessionDirectory, normalizeSessionDirectoryPath } from './session-directory-listing';

const SESSION_ID = 'session-worktree' as SessionId;
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

function logger(): Logger {
  const noop = vi.fn();
  return {
    info: noop,
    warn: noop,
    error: noop,
    success: noop,
    debug: noop,
    trace: noop,
    setLevel: noop,
    setDebug: noop,
    child: noop,
    close: noop,
  } as unknown as Logger;
}

function deps(resolveWorkspace: FilePreviewWorkspaceResolver) {
  const service = new LocalProjectControlService(logger());
  return {
    resolveWorkspace,
    listDirectory: async (rootPath: string, relativePath: string, limit: number) =>
      await service.listProjectDirectory(rootPath, relativePath, { limit }),
  };
}

const request = (dir: string, limit?: number) => ({
  v: FILE_PREVIEW_PROTOCOL_VERSION,
  sessionId: SESSION_ID,
  path: dir,
  ...(limit === undefined ? {} : { limit }),
});

describe('listSessionDirectory', () => {
  it("lists the session's worktree, not the original project folder", async () => {
    const project = await makeDir('lody-list-project-');
    const worktree = await makeDir('lody-list-worktree-');
    await writeFile(path.join(project, 'only-in-project.md'), '# project');
    await mkdir(path.join(worktree, 'docs'));
    await writeFile(path.join(worktree, 'docs', 'plan.md'), '# plan');
    await writeFile(path.join(worktree, 'README.md'), '# readme');
    const listing = deps(async () => ({
      ok: true,
      ownerSessionId: SESSION_ID,
      workspaceRoot: worktree,
    }));

    const root = await listSessionDirectory(listing, request(''));
    expect(root).toEqual({
      status: 'ok',
      v: FILE_PREVIEW_PROTOCOL_VERSION,
      path: '',
      entries: [
        { name: 'docs', type: 'directory' },
        { name: 'README.md', type: 'file' },
      ],
      truncated: false,
    });
    expect(await listSessionDirectory(listing, request('docs/'))).toMatchObject({
      status: 'ok',
      path: 'docs',
      entries: [{ name: 'plan.md', type: 'file' }],
    });
    expect(await listSessionDirectory(listing, request('', 1))).toMatchObject({
      status: 'ok',
      truncated: true,
    });
  });

  it('refuses paths that leave the workspace and reports missing folders', async () => {
    const outside = await makeDir('lody-list-outside-');
    const worktree = await makeDir('lody-list-worktree-');
    await writeFile(path.join(outside, 'secret.md'), 'secret');
    await symlink(outside, path.join(worktree, 'escape'));
    const listing = deps(async () => ({
      ok: true,
      ownerSessionId: SESSION_ID,
      workspaceRoot: worktree,
    }));

    expect(await listSessionDirectory(listing, request('../'))).toMatchObject({
      status: 'error',
      code: 'invalid_path',
    });
    expect(await listSessionDirectory(listing, request(outside))).toMatchObject({
      status: 'error',
      code: 'invalid_path',
    });
    expect(await listSessionDirectory(listing, request('escape'))).toMatchObject({
      status: 'error',
      code: 'path_not_allowed',
    });
    expect(await listSessionDirectory(listing, request(''))).toMatchObject({
      status: 'ok',
      entries: [],
    });
    expect(await listSessionDirectory(listing, request('missing'))).toMatchObject({
      status: 'error',
      code: 'file_not_found',
    });
  });

  it('passes an unresolvable workspace through as a typed error', async () => {
    const listing = deps(async () => ({
      ok: false,
      code: 'workspace_root_unavailable',
      message: 'Workspace folder is gone.',
    }));
    expect(await listSessionDirectory(listing, request(''))).toEqual({
      status: 'error',
      v: FILE_PREVIEW_PROTOCOL_VERSION,
      code: 'workspace_root_unavailable',
      message: 'Workspace folder is gone.',
      retryable: false,
    });
  });

  it('normalizes folder paths and rejects absolute or parent segments', () => {
    expect(normalizeSessionDirectoryPath('')).toBe('');
    expect(normalizeSessionDirectoryPath('./docs//guides/')).toBe('docs/guides');
    expect(normalizeSessionDirectoryPath('docs\\guides')).toBe('docs/guides');
    expect(normalizeSessionDirectoryPath('/etc')).toBeNull();
    expect(normalizeSessionDirectoryPath('C:/Users')).toBeNull();
    expect(normalizeSessionDirectoryPath('docs/../../x')).toBeNull();
    expect(normalizeSessionDirectoryPath('a\0b')).toBeNull();
  });
});
