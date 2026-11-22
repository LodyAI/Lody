import { archiveProjectGroup } from './worktree/project-worktree-archive';
import { existsSync } from 'node:fs';
import { materializeProjectGroup } from './worktree/project-worktrees';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import {
  fixture,
  owner,
  projectRun,
  registerGitSeedCleanup,
  withLocalSubmoduleGroup,
  withRepo,
} from '../../tests/workspace-git-service-helpers';
import { CodeCollabV2Service } from '../lib/code-collab/code-collab-v2-service';
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
            const files = new CodeCollabV2Service({
              resolveWorkspace: async () => ({
                ok: true,
                ownerSessionId: owner,
                workspaceRoot: prepared.workdir,
                projectRun: meta.get(owner)?.projectRun,
              }),
              publishFileIndex: async (state) => {
                if (state.persistAllChangesDiffStats) await service.publishDiffStats(state);
              },
            });
            try {
              await files.initDirectory({ sessionId: owner, path: '.' });
            } finally {
              files.dispose();
            }
            const members = Object.values(meta.get(owner)!.projectRun!.members);
            expect(members.map((member) => member.dirty)).toEqual([layout !== 'roots', true]);
            expect(meta.get(owner)).toMatchObject({
              workspaceDirty: true,
              branchName: firstBranches[0],
              diffStats: { allChange: { add: 1, del: 0 } },
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

  it('materializes a local partial-clone member without borrowing or hydrating its missing objects', async () => {
    await withLocalSubmoduleGroup(true, async ({ directory, web, api, roots, options, git }) => {
      let seed = 33;
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
      };
      const text = () =>
        Array.from({ length: 100 }, () => 'abcdefghijklmnopqrstuvwxyz '[random() % 27]).join('');
      const lines = Array.from({ length: 1200 }, () => `${text()}\n`);
      const addRevision = async (version: number) => {
        for (let change = 0; change < 30; change++)
          lines[random() % lines.length] = `${version} ${text()}\n`;
        // Shrinking blobs produce deltas against older promised blobs when the
        // remote advances beyond the partial clone's known commits.
        await writeFile(join(api, 'file'), lines.join('').slice(0, 120000 - version * 100));
        await git(api, ['add', 'file']);
        await git(api, ['commit', '-m', `revision ${version}`]);
      };
      for (let version = 0; version < 12; version++) await addRevision(version);
      await git(api, ['gc', '--aggressive', '--prune=now']);
      await git(api, ['config', 'uploadpack.allowFilter', 'true']);
      await git(api, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
      const partial = join(directory, 'partial');
      await git(directory, [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        pathToFileURL(api).href,
        partial,
      ]);
      await git(partial, ['remote', 'set-url', 'origin', 'git@github.com:example/api.git']);
      roots.api = partial;
      const missingObjects = async () =>
        (await git(partial, ['rev-list', '--objects', '--all', '--missing=print']))
          .split('\n')
          .filter((line) => line.startsWith('?'))
          .sort();
      const before = await missingObjects();
      expect(before.length).toBeGreaterThan(0);
      expect((await git(partial, ['config', '--get', 'remote.origin.promisor'])).trim()).toBe(
        'true'
      );
      expect(
        (await git(partial, ['config', '--get', 'remote.origin.partialclonefilter'])).trim()
      ).toBe('blob:none');
      await git(partial, ['fsck', '--connectivity-only']);
      for (let version = 12; version < 16; version++) await addRevision(version);
      await git(api, ['gc', '--aggressive', '--prune=now']);
      const nested = join(web, 'deps/api');
      await git(nested, ['fetch']);
      await git(nested, ['checkout', (await git(api, ['rev-parse', 'HEAD'])).trim()]);
      await git(web, ['commit', '-am', 'advance gitlink']);

      const prepared = await materializeProjectGroup(options);
      const checkout = join(prepared.workdir, 'web/deps/api');
      expect(await readFile(join(checkout, 'file'), 'utf8')).toBe(
        await readFile(join(api, 'file'), 'utf8')
      );
      expect((await git(checkout, ['rev-parse', 'HEAD'])).trim()).toBe(
        (await git(api, ['rev-parse', 'HEAD'])).trim()
      );
      await git(checkout, ['fsck', '--full']);
      expect(await missingObjects()).toEqual(before);
    });
  }, 180_000);
});
