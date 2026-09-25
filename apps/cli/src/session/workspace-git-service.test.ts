import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import type { SessionExec } from '@/lib/git/resolve-git-branch-name';
import { WorkspaceGitService } from './workspace-git-service';

const exec = promisify(execFile);
const owner = 'owner' as SessionId;
const child = 'child' as SessionId;
function fixture() {
  const meta = new Map<
    SessionId,
    { branchName?: string; parentSessionId?: SessionId; project?: ProjectRef }
  >([
    [owner, {}],
    [child, { parentSessionId: owner }],
  ]);
  const service = new WorkspaceGitService({
    logger: { debug() {} } as unknown as Logger,
    workspaceDocument: {
      async getOrCreateSessionDoc(id: SessionId) {
        return {
          async getMetaState() {
            return meta.get(id);
          },
          async setProject(project: ProjectRef) {
            meta.set(id, { ...meta.get(id), project });
          },
          async setBranchName(branchName: string) {
            meta.set(id, { ...meta.get(id), branchName });
          },
        };
      },
    } as unknown as LoroDocumentManager,
  });
  return { service, meta };
}
async function withRepo(
  run: (cwd: string, git: (args: string[]) => Promise<string>) => Promise<void>
) {
  const cwd = await mkdtemp(join(tmpdir(), 'lody-branch-'));
  const git = async (args: string[]) => (await exec('git', args, { cwd })).stdout;
  try {
    await git(['init', '-b', 'feature/local']);
    await run(cwd, git);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('WorkspaceGitService', () => {
  it('publishes a local repository without a remote, including its unborn branch and later checkout', async () => {
    await withRepo(async (cwd, git) => {
      const { service, meta } = fixture();
      await service.syncLocalWorkspace(owner, cwd);
      expect(meta.get(owner)?.branchName).toBe('feature/local');
      await git(['checkout', '-b', 'feature/next']);
      await service.syncLocalWorkspace(owner, cwd);
      expect(meta.get(owner)?.branchName).toBe('feature/next');
    });
  });

  it('backfills an existing local owner from its GitHub remote without changing project identity', async () => {
    await withRepo(async (cwd, git) => {
      const { service, meta } = fixture();
      const project: ProjectRef = { kind: 'local', localProjectId: 'local-1' as never };
      meta.set(owner, { project });
      await git(['remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
      await service.syncLocalWorkspace(owner, cwd);
      expect(meta.get(owner)).toEqual({
        branchName: 'feature/local',
        project: { ...project, githubRepoFullName: 'owner/repo' },
      });
      await git(['remote', 'set-url', 'origin', 'git@github.com:another/repo.git']);
      await service.syncLocalWorkspace(owner, cwd);
      expect(meta.get(owner)?.project).toEqual({ ...project, githubRepoFullName: 'owner/repo' });
    });
  });

  it('observes the actual worktree and publishes child observations only to its owner', async () => {
    await withRepo(async (cwd, git) => {
      await git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ]);
      const worktree = join(cwd, 'checkout');
      await git(['worktree', 'add', '-b', 'feature/worktree', worktree]);
      const { service, meta } = fixture();
      await service.syncSession(child, {
        getWorkdir: () => worktree,
        exec: async (command, args, workdir) =>
          (await exec(command, args, { cwd: workdir })).stdout,
      });
      expect(meta.get(owner)?.branchName).toBe('feature/worktree');
      expect(meta.get(child)).toEqual({ parentSessionId: owner });
      expect((await git(['branch', '--show-current'])).trim()).toBe('feature/local');
      await git(['-C', worktree, 'checkout', '--detach']);
      await service.syncLocalWorkspace(owner, worktree);
      expect(meta.get(owner)?.branchName).toBe('feature/worktree');
    });
  });

  it('does not invent a branch for non-Git folders or overwrite a known branch after a probe failure', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'lody-nongit-'));
    try {
      const { service, meta } = fixture();
      expect(await service.syncLocalWorkspace(owner, cwd)).toBeNull();
      expect(meta.get(owner)).toEqual({});
      meta.set(owner, { branchName: 'feature/known' });
      await service.syncSession(owner, {
        getWorkdir: () => cwd,
        exec: async () => {
          throw new Error('unavailable');
        },
      });
      expect(meta.get(owner)?.branchName).toBe('feature/known');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves branch metadata when a deleted or inaccessible workdir throws before probing', async () => {
    const { service, meta } = fixture();
    meta.set(owner, { branchName: 'feature/known' });
    await expect(
      service.syncSession(owner, {
        getWorkdir: () => {
          throw new Error('ENOENT');
        },
        exec: async () => 'feature/unreachable',
      })
    ).resolves.toBeNull();
    expect(meta.get(owner)?.branchName).toBe('feature/known');
    await service.syncSession(owner, {
      getWorkdir: () => '/restored',
      exec: async () => 'feature/restored',
    });
    expect(meta.get(owner)?.branchName).toBe('feature/restored');
  });

  it('serializes startup and child-turn observations so the final metadata is the newer branch', async () => {
    const { service, meta } = fixture();
    let release: (branch: string) => void = () => {
      throw new Error('not initialized');
    };
    let started: () => void = () => {
      throw new Error('not initialized');
    };
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const firstResult = new Promise<string>((resolve) => {
      release = resolve;
    });
    const slowExec: SessionExec = async () => {
      started();
      return firstResult;
    };
    const first = service.syncSession(owner, { getWorkdir: () => '/fixture', exec: slowExec });
    await firstStarted;
    const second = service.syncSession(child, {
      getWorkdir: () => '/fixture',
      exec: async () => 'feature/new',
    });
    release('feature/old');
    await Promise.all([first, second]);
    expect(meta.get(owner)?.branchName).toBe('feature/new');
    expect(meta.get(child)).toEqual({ parentSessionId: owner });
  });
});
