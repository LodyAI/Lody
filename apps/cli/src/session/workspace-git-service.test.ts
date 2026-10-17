import { worktreeGitLegacy } from './worktree/git-execution-legacy';
import { archiveProjectGroup } from './worktree/project-worktree-archive';
import { existsSync } from 'node:fs';
import { materializeProjectGroup } from './worktree/project-worktrees';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRef, SessionId, SessionMeta, SessionProjectRun } from '@lody/shared';
import { projectRunMetaPatch } from './project-run-state';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import type { SessionExec } from '@/lib/git/resolve-git-branch-name';
import { WorkspaceGitService } from './workspace-git-service';

const exec = promisify(execFile);
const owner = 'owner' as SessionId;
const child = 'child' as SessionId;
function fixture() {
  const meta = new Map<SessionId, Partial<SessionMeta>>([
    [owner, {}],
    [child, { parentSessionId: owner }],
  ]);
  const workspaceDocument = {
    repo: {
      async getDocMeta() {
        return { meta: meta.get(owner) };
      },
      async upsertDocMeta(_room: string, patch: Partial<SessionMeta>) {
        meta.set(owner, { ...meta.get(owner), ...patch });
      },
    },
    async getOrCreateSessionDoc(id: SessionId) {
      return {
        async getMetaState() {
          return meta.get(id);
        },
        async setProjectRun(run: SessionProjectRun) {
          meta.set(id, { ...meta.get(id), ...projectRunMetaPatch(run) });
        },
        async setProject(project: ProjectRef) {
          meta.set(id, { ...meta.get(id), project });
        },
        async setBranchName(branchName: string) {
          meta.set(id, { ...meta.get(id), branchName });
        },
      };
    },
  } as unknown as LoroDocumentManager;
  const service = new WorkspaceGitService({
    logger: { debug() {} } as unknown as Logger,
    workspaceDocument,
  });
  return { service, meta, workspaceDocument };
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
  beforeEach(() => {
    // Exercise the fixture's native Git URLs, not the caller's transport rewrites,
    // repository pointers, hooks, or signing configuration. Service subprocesses
    // must see the same isolated environment as fixture setup.
    for (const key of Object.keys(process.env)) {
      if (/^(GIT_|SSH_|LODY_GIT_)/.test(key)) vi.stubEnv(key, undefined);
    }
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', devNull);
  });
  afterEach(() => vi.unstubAllEnvs());

  const projectRun = (): SessionProjectRun => ({
    id: '12345678-1234-4234-8234-123456789012' as never,
    name: 'Example',
    root: 'project-example-12345678-1234-4234-8234-123456789012',
    members: {
      web: {
        o: 0,
        src: { kind: 'github', repoFullName: 'example/web' },
        placement: { kind: 'root', dir: 'web' },
        path: 'web',
        base: 'main',
      },
      api: {
        o: 1,
        src: { kind: 'github', repoFullName: 'example/api' },
        placement: { kind: 'root', dir: 'api' },
        path: 'api',
        base: 'main',
      },
    },
  });

  it('serializes owner and child member mutations and recovers after a failed mutation', async () => {
    const { service, meta } = fixture();
    meta.set(owner, { projectRun: projectRun() });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = service.updateProjectRun(owner, async (run) => {
      started();
      await gate;
      Object.values(run.members)[0]!.branch = 'feature/web';
      return run;
    });
    await entered;
    const second = service.updateProjectRun(child, async (run) => {
      Object.values(run.members)[1]!.branch = 'feature/api';
      return run;
    });
    release();
    await Promise.all([first, second]);
    await expect(
      service.updateProjectRun(owner, async (run) => {
        run.name = 'Uncommitted';
        throw new Error('failed');
      })
    ).rejects.toThrow('failed');
    await service.updateProjectRun(child, async (run) => ({ ...run, instructions: 'Ready' }));
    expect(
      Object.values(meta.get(owner)!.projectRun!.members).map((member) => member.branch)
    ).toEqual(['feature/web', 'feature/api']);
    expect(meta.get(owner)).toMatchObject({
      branchName: 'feature/web',
      repoFullName: 'example/web',
      projectRun: { name: 'Example', instructions: 'Ready' },
    });
    expect(meta.get(child)).toEqual({ parentSessionId: owner });
  });

  it('projects known member state without treating unknown probes as clean', () => {
    const run = projectRun();
    const [web, api] = Object.values(run.members);
    web!.dirty = false;
    web!.unpushed = true;
    web!.diff = { add: 2, del: 3 };
    expect(projectRunMetaPatch(run)).not.toHaveProperty('workspaceDirty');
    expect(projectRunMetaPatch(run)).toHaveProperty('workspaceUnpushed', true);
    api!.dirty = true;
    api!.diff = { add: 5, del: 7 };
    expect(projectRunMetaPatch(run)).toMatchObject({
      workspaceDirty: true,
      diffStats: { allChange: { add: 7, del: 10 } },
    });
  });

  it('probes working submodule configuration without fetching, writing config or exposing host paths', async () => {
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
    await withRepo(async (root, git) => {
      await git(['remote', 'add', 'origin', 'git@github.com:acme/api.git']);
      expect(await worktreeGitLegacy.probeLocalProjectMember(root)).toEqual({
        repoFullName: 'acme/api',
        submodules: [],
      });
      const modules =
        '[submodule "quoted name"]\npath = deps/proto\nurl = ../proto.git\n[submodule "local"]\npath = local\nurl = /private/host/repo\n[include]\npath = /not-readable-or-needed\n';
      await writeFile(join(root, '.gitmodules'), modules);
      const config = await readFile(join(root, '.git/config'), 'utf8');
      expect(await worktreeGitLegacy.probeLocalProjectMember(root)).toEqual({
        repoFullName: 'acme/api',
        submodules: [
          { path: 'deps/proto', url: '../proto.git', repoFullName: 'acme/proto' },
          { path: 'local', url: '' },
        ],
      });
      expect(await readFile(join(root, '.git/config'), 'utf8')).toBe(config);
      expect(await readFile(join(root, '.gitmodules'), 'utf8')).toBe(modules);
      await rm(join(root, '.gitmodules'));
      await symlink(join(root, '.git/config'), join(root, '.gitmodules'));
      await expect(worktreeGitLegacy.probeLocalProjectMember(root)).rejects.toThrow();
    });
  });

  it.each(['roots', 'submodule', 'submodule-cache'])(
    'materializes, observes, archives and restores %s without losing branches',
    async (layout) => {
      await withRepo(async (web, webGit) => {
        await withRepo(async (api, apiGit) => {
          for (const git of [webGit, apiGit])
            await git([
              '-c',
              'user.name=Test',
              '-c',
              'user.email=test@example.com',
              'commit',
              '--allow-empty',
              '-m',
              'base',
            ]);
          if (layout !== 'roots') {
            vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
            const moduleUrl =
              layout === 'submodule-cache' ? 'https://github.com/example/api.git' : api;
            if (layout === 'submodule-cache') {
              vi.stubEnv('GIT_CONFIG_COUNT', '1');
              vi.stubEnv('GIT_CONFIG_KEY_0', `url.${api}.insteadOf`);
              vi.stubEnv('GIT_CONFIG_VALUE_0', moduleUrl);
            }
            await webGit([
              '-c',
              'protocol.file.allow=always',
              'submodule',
              'add',
              moduleUrl,
              'deps/api',
            ]);
            await webGit([
              '-c',
              'user.name=Test',
              '-c',
              'user.email=test@example.com',
              'commit',
              '-am',
              'submodule',
            ]);
          }
          const data = await mkdtemp(join(tmpdir(), 'lody-project-group-'));
          vi.stubEnv('LODY_DATA_DIR', data);
          const { service, meta, workspaceDocument } = fixture();
          const run = projectRun();
          for (const [id, member] of Object.entries(run.members)) {
            member.src = {
              kind: 'local',
              machineId: 'machine' as never,
              localProjectId: id as never,
            };
            member.base = 'HEAD';
          }
          const apiPath = layout !== 'roots' ? 'web/deps/api' : 'api';
          if (layout !== 'roots') {
            const member = Object.values(run.members)[1]!;
            member.placement = { kind: 'submodule', parent: 'web' as never, path: 'deps/api' };
            member.path = apiPath;
            member.base = 'gitlink';
            if (layout === 'submodule-cache')
              member.src = { kind: 'github', repoFullName: 'example/api' };
          }
          meta.set(owner, { projectRun: run, machineId: 'machine' as never });
          const options = {
            sessionId: owner,
            machineId: 'machine',
            workspaceDocument,
            logger: { debug() {}, info() {}, warn() {}, trace() {} } as unknown as Logger,
            resolveLocalRoot: async (id: string) => (id === 'web' ? web : api),
            brokerAuth: async () => undefined,
            setup: async () => {},
          };
          try {
            const prepared = await materializeProjectGroup(options);
            const firstBranches = Object.values(prepared.run.members).map(
              (member) => member.branch
            );
            const firstBases = Object.values(prepared.run.members).map((member) => member.base);
            expect(firstBases[0]).toBe('feature/local');
            if (layout === 'roots') expect(firstBases[1]).toBe('feature/local');
            else expect(firstBases[1]).toMatch(/^[0-9a-f]{40,64}$/);
            const again = await materializeProjectGroup(options);
            expect(Object.values(again.run.members).map((member) => member.branch)).toEqual(
              firstBranches
            );
            await writeFile(join(prepared.workdir, apiPath, 'new-file.txt'), 'uncommitted');
            await service.syncLocalWorkspace(owner, prepared.workdir);
            const members = Object.values(meta.get(owner)!.projectRun!.members);
            expect(members.map((member) => member.dirty)).toEqual([layout !== 'roots', true]);
            expect(meta.get(owner)).toMatchObject({
              workspaceDirty: true,
              branchName: firstBranches[0],
              diffStats: { allChange: { add: 0, del: 0 } },
            });
            meta.set(owner, { ...meta.get(owner), isArchived: true });
            await archiveProjectGroup({
              ...options,
              worktreePath: prepared.workdir,
              cleanup: async () => {},
            });
            expect(existsSync(prepared.workdir)).toBe(false);
            meta.set(owner, { ...meta.get(owner), isArchived: false });
            const restored = await materializeProjectGroup(options);
            expect(await readFile(join(restored.workdir, apiPath, 'new-file.txt'), 'utf8')).toBe(
              'uncommitted'
            );
            expect(Object.values(restored.run.members).map((member) => member.branch)).toEqual(
              firstBranches
            );
            expect(Object.values(restored.run.members).map((member) => member.base)).toEqual(
              firstBases
            );
          } finally {
            await rm(data, { recursive: true, force: true });
          }
        });
      });
    },
    180_000
  );

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
      await git(['worktree', 'add', '-b', 'session/12345678', worktree]);
      const { service, meta } = fixture();
      await service.syncSession(child, {
        getWorkdir: () => worktree,
        exec: async (command, args, workdir) =>
          (await exec(command, args, { cwd: workdir })).stdout,
      });
      expect(meta.get(owner)?.branchName).toBe('session/12345678');
      expect(meta.get(child)).toEqual({ parentSessionId: owner });
      expect((await git(['branch', '--show-current'])).trim()).toBe('feature/local');
      await git(['-C', worktree, 'branch', '-m', 'feature/worktree']);
      await service.syncLocalWorkspace(owner, worktree);
      expect(meta.get(owner)?.branchName).toBe('feature/worktree');
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
