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
import { existsSync } from 'node:fs';
import { materializeProjectGroup } from './worktree/project-worktrees';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRef } from '@lody/shared';
import { decodeProjectPreparationProgress } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { SessionExec } from '@/lib/git/resolve-git-branch-name';
import {
  child,
  exec,
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
