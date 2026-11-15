import { worktreeGitLegacy } from './worktree/git-execution-legacy';
import { archiveProjectGroup } from './worktree/project-worktree-archive';
import { existsSync } from 'node:fs';
import { materializeProjectGroup } from './worktree/project-worktrees';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import {
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

  it('publishes workspace totals even with an open PR and preserves them on unknown results', async () => {
    const { service, meta, workspaceDocument } = fixture();
    meta.set(owner, {
      pullRequests: [{ url: 'https://github.com/example/web/pull/1', status: 'open' }],
      diffStats: { allChange: { add: 0, del: 0 } },
    });
    const stats = { files: 2, allChange: { add: 4, del: 2 } };
    const expected = { allChange: { ...stats.allChange, files: 2 } };
    await service.publishDiffStats({ ownerSessionId: owner, allChangesDiffStats: stats });
    expect(meta.get(owner)).toMatchObject({ diffStats: expected });
    await service.publishDiffStats({ ownerSessionId: owner, allChangesDiffStats: null });
    expect(meta.get(owner)).toMatchObject({ diffStats: expected });
    const write = vi.spyOn(workspaceDocument.repo, 'upsertDocMeta');
    write.mockRejectedValueOnce(new Error('synthetic metadata failure'));
    const next = { files: 1, allChange: { add: 5, del: 3 } };
    await expect(
      service.publishDiffStats({ ownerSessionId: owner, allChangesDiffStats: next })
    ).rejects.toThrow('synthetic metadata failure');
    expect(meta.get(owner)).toMatchObject({ diffStats: expected });
    await service.publishDiffStats({ ownerSessionId: owner, allChangesDiffStats: next });
    expect(meta.get(owner)).toMatchObject({
      diffStats: { allChange: { add: 5, del: 3, files: 1 } },
    });
    await service.publishDiffStats({
      ownerSessionId: owner,
      allChangesDiffStats: { files: 3, allChange: null },
    });
    expect(meta.get(owner)?.diffStats).toEqual({ allChange: { add: 5, del: 3, files: 3 } });
  });

  it('reconciles group aggregates and preserves other owner fields', async () => {
    const { service, meta } = fixture();
    const run = projectRun();
    const [web, api] = Object.values(run.members);
    if (!web || !api) throw new Error('Expected two project members');
    web.diff = { add: 2, del: 1, files: 2 };
    api.diff = { add: 3, del: 0, files: 1 };
    meta.set(owner, {
      projectRun: run,
      branchName: 'feature/keep',
      diffStats: { allChange: { add: 0, del: 0 } },
    });
    await service.publishDiffStats({
      ownerSessionId: owner,
      allChangesDiffStats: { files: 3, allChange: { add: 5, del: 1 } },
      memberDiffStats: {
        web: { files: 2, allChange: web.diff },
        api: { files: 1, allChange: api.diff },
      },
    });
    expect(meta.get(owner)).toMatchObject({
      branchName: 'feature/keep',
      diffStats: { allChange: { add: 5, del: 1, files: 3 } },
    });
    expect(meta.get(owner)?.projectRun?.members).toEqual(run.members);
    await service.publishDiffStats({
      ownerSessionId: owner,
      allChangesDiffStats: null,
      memberDiffStats: { web: { files: 2, allChange: { add: 8, del: 2 } }, api: null },
    });
    expect(meta.get(owner)?.diffStats).toEqual({ allChange: { add: 5, del: 1, files: 3 } });
    expect(Object.values(meta.get(owner)?.projectRun?.members ?? {})[0]?.diff).toEqual({
      add: 8,
      del: 2,
      files: 2,
    });
  });

  it('publishes the group total when an unavailable non-Git directory Member has no comparison', async () => {
    const { service, meta } = fixture();
    const run = projectRun();
    run.members['docs' as keyof typeof run.members] = {
      o: 2,
      access: 'link',
      src: { kind: 'local', machineId: 'machine' as never, localProjectId: 'docs' as never },
      placement: { kind: 'root', dir: 'docs' },
      path: 'docs',
      base: 'main',
    };
    meta.set(owner, { projectRun: run, diffStats: { allChange: { add: 0, del: 0 } } });
    await service.publishDiffStats({
      ownerSessionId: owner,
      allChangesDiffStats: { files: 3, allChange: { add: 5, del: 1 } },
      memberDiffStats: {
        web: { files: 2, allChange: { add: 2, del: 1 } },
        api: { files: 1, allChange: { add: 3, del: 0 } },
      },
    });
    expect(meta.get(owner)?.diffStats).toEqual({ allChange: { add: 5, del: 1, files: 3 } });
    // A Git Member without a comparison still withholds the group total.
    await service.publishDiffStats({
      ownerSessionId: owner,
      allChangesDiffStats: { files: 4, allChange: { add: 9, del: 1 } },
      memberDiffStats: { web: { files: 2, allChange: { add: 2, del: 1 } } },
    });
    expect(meta.get(owner)?.diffStats).toEqual({ allChange: { add: 5, del: 1, files: 3 } });
  });

  it('does not publish a cancelled comparison queued behind another owner mutation', async () => {
    const { service, meta } = fixture();
    const previous = { allChange: { add: 4, del: 2 } };
    meta.set(owner, { diffStats: previous });
    let release: () => void = () => {
      throw new Error('Gate not initialized');
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = service.withOwnerMutation(owner, () => gate);
    const controller = new AbortController();
    const write = service.publishDiffStats({
      ownerSessionId: owner,
      allChangesDiffStats: { files: 1, allChange: { add: 1, del: 0 } },
      signal: controller.signal,
    });
    const cancelled = expect(write).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    release();
    await Promise.all([mutation, cancelled]);
    expect(meta.get(owner)).toMatchObject({ diffStats: previous });
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
});
