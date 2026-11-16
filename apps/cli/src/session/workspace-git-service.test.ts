import { archiveProjectGroup } from './worktree/project-worktree-archive';
import { existsSync } from 'node:fs';
import {
  materializeProjectGroup,
  ProjectRepositoryNotOnMachineError,
  resolveProjectGroupRepositories,
} from './worktree/project-worktrees';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionProjectRun } from '@lody/shared';
import { projectRunMetaPatch } from './project-run-state';
import type { Logger } from '@/utils/logger';
import {
  child,
  fixture,
  owner,
  projectRun,
  registerGitSeedCleanup,
  withRepo,
} from '../../tests/workspace-git-service-helpers';
registerGitSeedCleanup();
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

  it('lets an encrypted guard reject the Project group snapshot it actually read', async () => {
    const { meta, workspaceDocument } = fixture();
    meta.set(owner, { projectRun: projectRun() });
    const resolved: string[] = [];
    const seen: SessionProjectRun[] = [];
    await expect(
      materializeProjectGroup({
        sessionId: owner,
        machineId: 'machine',
        workspaceDocument,
        logger: { debug() {}, info() {}, warn() {}, trace() {} } as unknown as Logger,
        resolveLocalRoot: async (id) => {
          resolved.push(id);
          return null;
        },
        brokerAuth: async () => undefined,
        allowManagedClone: true,
        setup: async () => {},
        authorizeRun: async (run) => {
          seen.push(run);
          throw new Error('e2ee_machine_not_shared');
        },
      })
    ).rejects.toThrow('e2ee_machine_not_shared');
    expect(seen.map((run) => Object.keys(run.members))).toEqual([
      Object.keys(projectRun().members),
    ]);
    expect(resolved).toEqual([]);
    // Nothing was published from the rejected snapshot.
    expect(meta.get(owner)?.projectRun).toEqual(projectRun());
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
    });
    expect(projectRunMetaPatch(run)).not.toHaveProperty('diffStats');
  });
});
