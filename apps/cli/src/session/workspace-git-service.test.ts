import { Effect } from 'effect';
import { NodeFileSystem } from '@effect/platform-node-shared';
import { WorktreeGit, WorktreeGitCommandFailed } from './worktree/git-execution';
import { probeLocalProjectMember } from './worktree/project-member-probe';
import {
  reconcileProjectMemberLink,
  removeProjectMemberLinks,
  resolveProjectFileRoots,
  resolveProjectFileTarget,
} from './worktree/project-member-access';
import { WorktreeManager } from './worktree/worktree-manager';
import { worktreeGitLegacy } from './worktree/git-execution-legacy';
import { archiveProjectGroup } from './worktree/project-worktree-archive';
import { existsSync } from 'node:fs';
import {
  materializeProjectGroup,
  resolveProjectGroupRepositories,
  ProjectRepositoryNotOnMachineError,
} from './worktree/project-worktrees';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  symlink,
  mkdir,
  unlink,
  realpath,
} from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRef, SessionId, SessionMeta, SessionProjectRun } from '@lody/shared';
import { decodeProjectPreparationProgress } from '@lody/shared';
import { projectRunMetaPatch } from './project-run-state';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import type { SessionExec } from '@/lib/git/resolve-git-branch-name';
import { WorkspaceGitService } from './workspace-git-service';

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
  // Frozen repository identities use real paths, including macOS /var aliases.
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'lody-branch-')));
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

  it('re-observes ranked local copies, separates managed fallback, and rejects duplicate identities', async () => {
    await withRepo(async (root, git) => {
      await git(['remote', 'add', 'origin', 'https://github.com/example/web.git']);
      await withRepo(async (stale, staleGit) => {
        await staleGit(['remote', 'add', 'origin', 'https://github.com/example/other.git']);
        const run = projectRun();
        const [webId, apiId] = Object.keys(run.members) as Array<keyof typeof run.members>;
        const web = run.members[webId!]!;
        web.src = { kind: 'github', repoFullName: 'example/web', preferLocal: true };
        const candidates = [
          {
            id: 'missing' as never,
            rootPath: join(stale, 'missing'),
            name: 'missing',
            createdAtMs: 3,
            githubRepoFullName: 'example/web',
          },
          {
            id: 'stale' as never,
            rootPath: stale,
            name: 'stale',
            createdAtMs: 2,
            githubRepoFullName: 'example/web',
          },
          {
            id: 'valid' as never,
            rootPath: root,
            name: 'valid',
            createdAtMs: 1,
            githubRepoFullName: 'EXAMPLE/WEB',
          },
        ];
        const options = {
          machineId: 'machine',
          resolveLocalRoot: async (id: string) => (id === 'valid' ? root : stale),
          listLocalProjects: async () => [...candidates],
          allowManagedClone: false,
        };
        const resolved = await resolveProjectGroupRepositories(run, options);
        expect(resolved.get(webId!)?.source).toEqual({
          kind: 'local-shared',
          originalRootPath: await realpath(root),
        });
        expect(resolved.get(webId!)?.repositoryCheckout).toEqual({
          kind: 'local',
          machineId: 'machine',
          localProjectId: 'valid',
        });
        expect(resolved.get(apiId!)?.source.kind).toBe('github');
        await expect(
          resolveProjectGroupRepositories(run, {
            ...options,
            listLocalProjects: async () => candidates.slice(0, 2),
          })
        ).rejects.toMatchObject({ code: 'project_repository_not_on_machine', memberId: webId });
        const managed = await resolveProjectGroupRepositories(run, {
          ...options,
          listLocalProjects: async () => [],
          allowManagedClone: true,
        });
        expect(managed.get(webId!)?.source.kind).toBe('github');
        expect(managed.get(webId!)?.repositoryCheckout).toEqual({ kind: 'github' });
        web.repositoryCheckout = { kind: 'github' };
        expect(
          (await resolveProjectGroupRepositories(run, { ...options, allowManagedClone: true })).get(
            webId!
          )?.source.kind
        ).toBe('github');
        delete web.repositoryCheckout;
        run.members[apiId!]!.src = {
          kind: 'local',
          machineId: 'machine' as never,
          localProjectId: 'valid' as never,
        };
        await expect(resolveProjectGroupRepositories(run, options)).rejects.toThrow(
          /same Git root|duplicate/
        );
        run.members[apiId!]!.src = { ...web.src };
        await expect(resolveProjectGroupRepositories(run, options)).rejects.toThrow(
          /same Git root|duplicate/
        );
        await git(['remote', 'remove', 'origin']);
        await expect(resolveProjectGroupRepositories(run, options)).rejects.toBeInstanceOf(
          ProjectRepositoryNotOnMachineError
        );
      });
    });
  }, 180_000);

  it('pins a repository local copy through archive and restore and uses native member credentials', async () => {
    await withRepo(async (root, git) => {
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
      await git(['remote', 'add', 'origin', 'https://github.com/example/web.git']);
      const data = await mkdtemp(join(tmpdir(), 'repository-member-'));
      vi.stubEnv('LODY_DATA_DIR', data);
      const { meta, workspaceDocument } = fixture();
      const run = projectRun();
      const first = Object.keys(run.members)[0] as keyof typeof run.members;
      const member = run.members[first]!;
      member.src = { kind: 'github', repoFullName: 'example/web', preferLocal: true };
      member.base = 'HEAD';
      const docs = join(data, 'docs');
      await mkdir(docs);
      const second = Object.keys(run.members)[1] as keyof typeof run.members;
      run.members[second]!.src = {
        kind: 'local',
        machineId: 'machine' as never,
        localProjectId: 'docs' as never,
      };
      meta.set(owner, { projectRun: run, machineId: 'machine' as never });
      const options = {
        sessionId: owner,
        machineId: 'machine',
        workspaceDocument,
        logger: { debug() {}, info() {}, warn() {}, trace() {} } as unknown as Logger,
        resolveLocalRoot: async (id: string) => (id === 'copy' ? root : docs),
        listLocalProjects: async () => [
          {
            id: 'copy' as never,
            name: 'copy',
            rootPath: root,
            createdAtMs: 1,
            githubRepoFullName: 'example/web',
          },
        ],
        brokerAuth: async (source: { kind: string }) => {
          if (source.kind !== 'local-shared')
            throw new Error('Unexpected managed credential enrollment');
          return undefined;
        },
        setup: async () => {},
      };
      try {
        const prepared = await materializeProjectGroup(options);
        const receipt = prepared.run.members[first]!.repositoryCheckout;
        expect(receipt).toEqual({ kind: 'local', machineId: 'machine', localProjectId: 'copy' });
        expect(prepared.run.members[first]!.repoFullName).toBe('example/web');
        await writeFile(join(prepared.workdir, member.path, 'saved.txt'), 'durable');
        meta.set(owner, { ...meta.get(owner), isArchived: true });
        await archiveProjectGroup({
          ...options,
          worktreePath: prepared.workdir,
          cleanup: async () => {},
        });
        expect(existsSync(prepared.workdir)).toBe(false);
        const branch = Object.values(meta.get(owner)!.projectRun!.members)[0]!.branch!;
        expect((await git(['show', `${branch}:saved.txt`])).trim()).toBe('durable');
        // Registry ranking is irrelevant after the receipt is published.
        const restored = await materializeProjectGroup({
          ...options,
          listLocalProjects: async () => [],
        });
        expect(await readFile(join(restored.workdir, member.path, 'saved.txt'), 'utf8')).toBe(
          'durable'
        );
        expect(restored.run.members[first]!.repositoryCheckout).toEqual(receipt);
      } finally {
        await rm(data, { recursive: true, force: true });
      }
    });
  }, 180_000);

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
        isGit: true,
        repoFullName: 'acme/api',
        submodules: [],
      });
      const modules =
        '[submodule "quoted name"]\npath = deps/proto\nurl = ../proto.git\n[submodule "local"]\npath = local\nurl = /private/host/repo\n[include]\npath = /not-readable-or-needed\n';
      await writeFile(join(root, '.gitmodules'), modules);
      const config = await readFile(join(root, '.git/config'), 'utf8');
      expect(await worktreeGitLegacy.probeLocalProjectMember(root)).toEqual({
        isGit: true,
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

  it.each([true, false])(
    'materializes and archives non-Git members without touching their source (additional=%s)',
    async (supportsAdditionalDirectories) => {
      await withRepo(async (web, git) => {
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
        const data = await mkdtemp(join(tmpdir(), 'non-git-group-'));
        const docs = await mkdtemp(join(tmpdir(), 'non-git-docs-'));
        vi.stubEnv('LODY_DATA_DIR', data);
        await writeFile(join(docs, 'keep.txt'), 'original');
        const { meta, workspaceDocument } = fixture();
        const run = projectRun();
        for (const [id, member] of Object.entries(run.members)) {
          member.src = {
            kind: 'local',
            machineId: 'machine' as never,
            localProjectId: id as never,
          };
          member.base = 'HEAD';
        }
        meta.set(owner, { projectRun: run, machineId: 'machine' as never });
        const options = {
          sessionId: owner,
          machineId: 'machine',
          workspaceDocument,
          supportsAdditionalDirectories,
          logger: { debug() {}, info() {}, warn() {}, trace() {} } as unknown as Logger,
          resolveLocalRoot: async (id: string) => (id === 'web' ? web : docs),
          brokerAuth: async () => undefined,
          setup: async () => {},
        };
        try {
          const prepared = await materializeProjectGroup(options);
          const member = Object.values(prepared.run.members)[1]!;
          expect(member.access).toBe(supportsAdditionalDirectories ? 'additional' : 'link');
          expect(member.branch).toBeUndefined();
          expect(existsSync(join(prepared.workdir, 'api'))).toBe(!supportsAdditionalDirectories);
          meta.set(owner, { ...meta.get(owner), isArchived: true });
          await archiveProjectGroup({
            ...options,
            worktreePath: prepared.workdir,
            cleanup: async () => {},
          });
          expect(existsSync(prepared.workdir)).toBe(false);
          expect(await readFile(join(docs, 'keep.txt'), 'utf8')).toBe('original');
          expect(existsSync(join(docs, '.git'))).toBe(false);
        } finally {
          await rm(data, { recursive: true, force: true });
          await rm(docs, { recursive: true, force: true });
        }
      });
    },
    180_000
  );

  it.each(['roots', 'submodule', 'submodule-cache', 'repository-submodule'])(
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
              layout === 'submodule-cache' || layout === 'repository-submodule'
                ? 'https://github.com/example/api.git'
                : api;
            if (layout === 'submodule-cache' || layout === 'repository-submodule') {
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
          if (layout === 'repository-submodule')
            await apiGit(['remote', 'add', 'origin', 'git@github.com:example/api.git']);
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
            if (layout === 'submodule-cache' || layout === 'repository-submodule')
              member.src = {
                kind: 'github',
                repoFullName: 'example/api',
                ...(layout === 'repository-submodule' ? { preferLocal: true as const } : {}),
              };
          }
          meta.set(owner, { projectRun: run, machineId: 'machine' as never });
          const options = {
            sessionId: owner,
            machineId: 'machine',
            workspaceDocument,
            logger: { debug() {}, info() {}, warn() {}, trace() {} } as unknown as Logger,
            resolveLocalRoot: async (id: string) => (id === 'web' ? web : api),
            listLocalProjects: async () => [
              {
                id: 'api' as never,
                name: 'api',
                rootPath: api,
                createdAtMs: 1,
                githubRepoFullName: 'example/api',
              },
            ],
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

  it('prepares independent roots and nested members with local Git transport', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'lody-group-startup-')));
    const repositories = ['web', 'api', 'core', 'docs', 'tools', 'extra', 'leaf'];
    const git = async (repo: string, args: string[]) =>
      (await exec('git', ['-C', join(directory, repo), ...args])).stdout.trim();
    const timings: Record<string, number[]> = {};
    const spans: Array<{ phase: string; start: number; end: number }> = [];
    const started = performance.now();
    for (const method of [
      'createWorktree',
      'materializeProjectSubmodule',
      'initializeMissingProjectSubmodules',
    ] as const) {
      const original = WorktreeManager.prototype[method];
      // Instrument the real boundary; no simulated Git or elapsed-time assertions.
      vi.spyOn(WorktreeManager.prototype, method).mockImplementation(async function (
        this: WorktreeManager,
        ...args: never[]
      ) {
        const start = performance.now();
        try {
          return await Reflect.apply(original, this, args);
        } finally {
          const end = performance.now();
          (timings[method] ??= []).push(end - start);
          spans.push({
            phase: method === 'initializeMissingProjectSubmodules' ? 'submodules' : 'checkouts',
            start,
            end,
          });
        }
      });
    }
    try {
      vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
      vi.stubEnv('LODY_DATA_DIR', join(directory, 'data'));
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_KEY_0', 'url.file:///.insteadOf');
      vi.stubEnv('GIT_CONFIG_VALUE_0', '/');
      for (const repo of repositories) {
        await mkdir(join(directory, repo));
        await git(repo, ['init', '-b', 'main']);
        await writeFile(join(directory, repo, 'readme'), repo);
        await git(repo, ['add', '.']);
        await git(repo, [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '-m',
          'base',
        ]);
      }
      for (const [parent, nested] of [
        ['core', 'leaf'],
        ['api', 'core'],
        ['web', 'api'],
        ['web', 'extra'],
      ]) {
        await git(parent!, ['submodule', 'add', join(directory, nested!), `deps/${nested}`]);
        await git(parent!, [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '-am',
          'submodule',
        ]);
      }
      const { meta, workspaceDocument } = fixture();
      const run = projectRun();
      run.members = {};
      for (const [index, id] of ['web', 'api', 'core', 'docs', 'tools'].entries()) {
        const parent = id === 'api' ? 'web' : id === 'core' ? 'api' : undefined;
        run.members[id as keyof typeof run.members] = {
          o: 10 - index, // Setup must retain parent-before-child traversal despite display order.
          src: { kind: 'local', machineId: 'machine' as never, localProjectId: id as never },
          placement: parent
            ? { kind: 'submodule', parent: parent as never, path: `deps/${id}` }
            : { kind: 'root', dir: id },
          path: id === 'core' ? 'web/deps/api/deps/core' : id === 'api' ? 'web/deps/api' : id,
          base: parent ? 'gitlink' : 'HEAD',
        };
      }
      meta.set(owner, { projectRun: run, machineId: 'machine' as never });
      const setup: string[] = [];
      const progress: string[] = [];
      const seen = new Set<string>();
      const rootsReady = Promise.withResolvers<void>();
      let rootsStarted = 0;
      const start = performance.now();
      const prepared = await materializeProjectGroup({
        sessionId: owner,
        machineId: 'machine',
        workspaceDocument,
        logger: { debug() {}, info() {}, warn() {}, trace() {} } as unknown as Logger,
        resolveLocalRoot: async (id) => join(directory, id),
        onProgress: (detail) => progress.push(detail),
        brokerAuth: async (source) => {
          if (source.kind !== 'local-shared' || seen.has(source.originalRootPath)) return undefined;
          seen.add(source.originalRootPath);
          if (
            ['web', 'docs', 'tools'].some((id) => source.originalRootPath === join(directory, id))
          ) {
            if (++rootsStarted === 3) rootsReady.resolve();
            await rootsReady.promise;
          } else {
            const root = join(directory, 'data/repos', run.root, 'worktrees', owner, 'web');
            const nested =
              source.originalRootPath === join(directory, 'api')
                ? 'deps/api'
                : 'deps/api/deps/core';
            // A selected descendant must not be cloned recursively under its parent's credentials.
            expect(existsSync(join(root, nested, '.git'))).toBe(false);
          }
          return undefined;
        },
        setup: async (member, workdir) => {
          const setupStart = performance.now();
          expect(await readFile(join(workdir, 'readme'), 'utf8')).toBe(
            member.src.kind === 'local' ? member.src.localProjectId : ''
          );
          setup.push(member.path);
          spans.push({ phase: 'setup', start: setupStart, end: performance.now() });
        },
      });
      const materializeMs = performance.now() - start;
      expect(setup).toEqual(['web', 'web/deps/api', 'web/deps/api/deps/core', 'docs', 'tools']);
      // Lifecycle steps only: start, one per finished member, submodules, one per setup.
      const steps = progress.map(decodeProjectPreparationProgress);
      expect(steps[0]).toEqual({ step: 'resolve' });
      expect(steps.filter((step) => step?.step === 'member')).toHaveLength(5);
      expect(steps).toContainEqual({
        step: 'member',
        done: 5,
        total: 5,
        path: expect.any(String),
      });
      expect(steps.filter((step) => step?.step === 'submodules')).toHaveLength(1);
      expect(
        steps
          .filter((step) => step?.step === 'setup')
          .map((step) => step && 'path' in step && step.path)
      ).toEqual(setup);
      expect(progress.length).toBe(1 + 5 + 1 + setup.length);
      // --dissociate must leave no dependency on a source repository's object retention.
      const objects = (
        await exec('git', [
          '-C',
          join(prepared.workdir, 'web/deps/api'),
          'rev-parse',
          '--git-path',
          'objects/info/alternates',
        ])
      ).stdout.trim();
      expect(existsSync(resolvePath(prepared.workdir, 'web/deps/api', objects))).toBe(false);
      expect(
        await readFile(join(prepared.workdir, 'web/deps/api/deps/core/deps/leaf/readme'), 'utf8')
      ).toBe('leaf');
      expect(await readFile(join(prepared.workdir, 'web/deps/extra/readme'), 'utf8')).toBe('extra');
      for (const member of Object.values(prepared.run.members)) {
        expect(
          (
            await exec('git', [
              '-C',
              join(prepared.workdir, member.path),
              'branch',
              '--show-current',
            ])
          ).stdout.trim()
        ).toBe(member.branch);
      }
      if (process.env.PROJECT_STARTUP_MEASUREMENTS)
        await writeFile(
          process.env.PROJECT_STARTUP_MEASUREMENTS,
          JSON.stringify({
            materializeMs,
            phaseWallMs: Object.fromEntries(
              ['checkouts', 'submodules', 'setup'].map((phase) => {
                const entries = spans.filter((span) => span.phase === phase);
                return [
                  phase,
                  Math.max(...entries.map((span) => span.end)) -
                    Math.min(...entries.map((span) => span.start)),
                ];
              })
            ),
            resolutionAndOwnerMs: Math.min(...spans.map((span) => span.start)) - start,
            timings,
            fixtureAndRunMs: performance.now() - started,
          })
        );
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it('retains the Project owner until concurrent mutations settle after a failure', async () => {
    await withRepo(async (web, webGit) =>
      withRepo(async (api, apiGit) => {
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
        const data = await mkdtemp(join(tmpdir(), 'lody-group-drain-'));
        vi.stubEnv('LODY_DATA_DIR', data);
        const { meta, workspaceDocument, service } = fixture();
        const run = projectRun();
        for (const [id, member] of Object.entries(run.members)) {
          member.src = {
            kind: 'local',
            machineId: 'machine' as never,
            localProjectId: id as never,
          };
          member.base = 'HEAD';
        }
        meta.set(owner, { projectRun: run });
        const secondStarted = Promise.withResolvers<void>();
        const failed = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let settled = false;
        let successorEntered = false;
        try {
          const preparation = materializeProjectGroup({
            sessionId: owner,
            machineId: 'machine',
            workspaceDocument,
            logger: { debug() {}, info() {}, warn() {}, trace() {} } as unknown as Logger,
            resolveLocalRoot: async (id) => (id === 'web' ? web : api),
            brokerAuth: async (source) => {
              if (source.kind === 'local-shared' && source.originalRootPath === web) {
                await secondStarted.promise;
                failed.resolve();
                throw new Error('fixture credential failure');
              }
              secondStarted.resolve();
              await release.promise;
              return undefined;
            },
            setup: async () => {},
          }).then(
            () => {
              settled = true;
            },
            (error) => {
              settled = true;
              throw error;
            }
          );
          const outcome = expect(preparation).rejects.toThrow('fixture credential failure');
          await failed.promise;
          const successor = service.updateProjectRun(owner, async (snapshot) => {
            successorEntered = true;
            expect(snapshot.members['api' as keyof typeof snapshot.members]?.branch).toBeTruthy();
            return snapshot;
          });
          expect(settled).toBe(false);
          expect(successorEntered).toBe(false);
          release.resolve();
          await outcome;
          await successor;
          expect(successorEntered).toBe(true);
        } finally {
          release.resolve();
          await rm(data, { recursive: true, force: true });
        }
      })
    );
  });

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

describe('non-Git member access', () => {
  it.each([
    [128, 'fatal: not a git repository (or any of the parent directories): .git', true],
    [
      128,
      'fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).',
      true,
    ],
    [1, 'fatal: not a git repository (or any parent up to mount point /)', false],
    [128, 'fatal: not a git repository: /broken/.git', false],
    [128, 'fatal: failed to stat /private: Permission denied', false],
  ] as const)('classifies discovery exit %s: %s', async (code, stderr, nonGit) => {
    const root = await mkdtemp(join(tmpdir(), 'member-discovery-'));
    const failure = new WorktreeGitCommandFailed({
      args: ['rev-parse', '--show-toplevel'],
      cwd: root,
      code,
      signal: null,
      stdout: '',
      stderr,
      message: stderr,
    });
    try {
      const result = Effect.runPromise(
        probeLocalProjectMember(root).pipe(
          Effect.provideService(
            WorktreeGit,
            WorktreeGit.of({
              run: () => Effect.fail(failure),
              probeCredentials: () => Effect.die('Unexpected credential probe'),
            })
          ),
          Effect.provide(NodeFileSystem.layer)
        )
      );
      if (nonGit) await expect(result).resolves.toEqual({ isGit: false, submodules: [] });
      else await expect(result).rejects.toBe(failure);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rebuilds a replaced link from registration, rejects escapes and preserves target on cleanup', async () => {
    const base = await mkdtemp(join(tmpdir(), 'project-roots-'));
    try {
      const main = join(base, 'main');
      const docs = join(base, 'docs');
      const outside = join(base, 'outside');
      for (const folder of [main, docs, outside]) await mkdir(folder);
      await writeFile(join(docs, 'keep.txt'), 'original');
      await writeFile(join(outside, 'secret.txt'), 'outside');
      const run = projectRun();
      const [id, member] = Object.entries(run.members)[0]!;
      member.src = { kind: 'local', machineId: 'm' as never, localProjectId: 'docs' as never };
      member.access = 'link';
      member.placement = { kind: 'root', dir: 'docs' };
      member.path = 'docs';
      await reconcileProjectMemberLink(main, 'docs', docs, false);
      const roots = await resolveProjectFileRoots(main, run, 'm', async () => docs);
      expect(resolveProjectFileTarget(roots, 'docs/keep.txt')).toMatchObject({
        rootId: `member:${id}`,
        relativePath: 'keep.txt',
      });
      await unlink(join(main, 'docs'));
      await symlink(outside, join(main, 'docs'), 'junction');
      expect(resolveProjectFileTarget(roots, 'docs/secret.txt')).toBeUndefined();
      await reconcileProjectMemberLink(main, 'docs', docs, false);
      expect(await realpath(join(main, 'docs'))).toBe(await realpath(docs));
      await symlink(outside, join(docs, 'escape'), 'junction');
      expect(resolveProjectFileTarget(roots, 'escape/secret.txt', `member:${id}`)).toBeUndefined();
      await symlink(join(outside, 'missing'), join(docs, 'dangling'), 'dir');
      expect(resolveProjectFileTarget(roots, 'dangling/file.txt', `member:${id}`)).toBeUndefined();
      await removeProjectMemberLinks(main, run);
      expect(existsSync(join(main, 'docs'))).toBe(false);
      expect(await readFile(join(docs, 'keep.txt'), 'utf8')).toBe('original');
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
      await expect(
        reconcileProjectMemberLink(main, 'docs', join(base, 'missing'), false)
      ).rejects.toThrow();
      await mkdir(join(main, 'docs'));
      await writeFile(join(main, 'docs', 'agent.txt'), 'keep');
      await expect(reconcileProjectMemberLink(main, 'docs', docs, false)).rejects.toThrow(
        'real entry'
      );
      expect(await readFile(join(main, 'docs', 'agent.txt'), 'utf8')).toBe('keep');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  it("keeps a sibling tab's member link when a later Provider takes additional directories", async () => {
    const base = await mkdtemp(join(tmpdir(), 'project-member-link-'));
    try {
      const main = join(base, 'main');
      const docs = join(base, 'docs');
      const other = join(base, 'other');
      await mkdir(main);
      await mkdir(docs);
      await mkdir(other);
      await writeFile(join(docs, 'keep.txt'), 'original');
      // The parent tab's Provider lacks additional directories: it uses the link.
      expect(await reconcileProjectMemberLink(main, 'docs', docs, false)).toBe(true);
      // A child tab's Provider takes them; the parent still reads through the link.
      expect(await reconcileProjectMemberLink(main, 'docs', docs, true)).toBe(true);
      expect(await readFile(join(main, 'docs', 'keep.txt'), 'utf8')).toBe('original');
      // A link to somewhere else is still removed, and none is created.
      await unlink(join(main, 'docs'));
      await symlink(other, join(main, 'docs'), 'junction');
      expect(await reconcileProjectMemberLink(main, 'docs', docs, true)).toBe(false);
      expect(existsSync(join(main, 'docs'))).toBe(false);
      expect(await reconcileProjectMemberLink(main, 'docs', docs, true)).toBe(false);
      expect(existsSync(join(main, 'docs'))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  it('probes non-Git directories and rejects missing roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'non-git-member-'));
    try {
      expect(await worktreeGitLegacy.probeLocalProjectMember(root)).toEqual({
        isGit: false,
        submodules: [],
      });
      await expect(
        worktreeGitLegacy.probeLocalProjectMember(join(root, 'missing'))
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
