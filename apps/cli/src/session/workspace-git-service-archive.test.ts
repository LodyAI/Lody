import { worktreeGitLegacy } from './worktree/git-execution-legacy';
import { archiveProjectGroup } from './worktree/project-worktree-archive';
import { existsSync } from 'node:fs';
import { materializeProjectGroup, projectGroupDirectory } from './worktree/project-worktrees';
import { lstat, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  owner,
  registerGitSeedCleanup,
  withLocalSubmoduleGroup,
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

  it('borrows complete local objects for unselected descendants and detaches their storage', async () => {
    await withLocalSubmoduleGroup(
      false,
      async ({ directory, web, api, run, meta, options, git }) => {
        const leaf = join(directory, 'leaf');
        await mkdir(leaf);
        await git(leaf, ['init', '-b', 'main']);
        await writeFile(join(leaf, 'payload'), 'nested objects');
        await git(leaf, ['add', '.']);
        await git(leaf, ['commit', '-m', 'leaf']);
        await git(api, ['submodule', 'add', pathToFileURL(leaf).href, 'nested/leaf']);
        await git(api, ['commit', '-am', 'nested module']);
        const source = join(web, 'deps/api');
        await git(source, ['fetch']);
        await git(source, ['checkout', (await git(api, ['rev-parse', 'HEAD'])).trim()]);
        await git(source, ['submodule', 'update', '--init', '--recursive']);
        await git(source, ['remote', 'set-url', 'origin', 'https://github.com/example/api.git']);
        await git(web, ['commit', '-am', 'advance gitlink']);
        await git(web, ['submodule', 'sync']);
        meta.set(owner, { projectRun: run, machineId: 'machine' as never });
        const expected = (await git(source, ['rev-parse', 'HEAD'])).trim();

        // Real upload-pack still advertises refs, but cannot transfer an object pack.
        // Only borrowing the complete local objects can materialize these checkouts.
        const globalConfig = join(directory, 'gitconfig');
        await writeFile(globalConfig, '[uploadpack]\n  packObjectsHook = false\n');
        vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
        const sourceGitfiles = [join(source, 'nested/leaf/.git'), join(api, 'nested/leaf/.git')];
        const gitfiles = await Promise.all(sourceGitfiles.map((file) => readFile(file)));
        await Promise.all(sourceGitfiles.map((file) => unlink(file)));
        await expect(materializeProjectGroup(options)).rejects.toThrow();
        const checkout = join(projectGroupDirectory(run), 'worktrees', owner, 'web/deps/api');
        // The parent completed before its descendant failed. A retry must resume
        // below it without resetting its HEAD or silently leaving the child empty.
        expect((await git(checkout, ['rev-parse', 'HEAD'])).trim()).toBe(expected);
        await Promise.all(sourceGitfiles.map((file, index) => writeFile(file, gitfiles[index]!)));
        const prepared = await materializeProjectGroup(options);
        expect(join(prepared.workdir, 'web/deps/api')).toBe(checkout);
        expect((await git(checkout, ['rev-parse', 'HEAD'])).trim()).toBe(expected);
        expect(await readFile(join(checkout, 'nested/leaf/payload'), 'utf8')).toBe(
          'nested objects'
        );

        await rm(source, { recursive: true, force: true });
        await rm(join(web, '.git/modules'), { recursive: true, force: true });
        await rm(api, { recursive: true, force: true });
        await rm(leaf, { recursive: true, force: true });
        for (const repository of [checkout, join(checkout, 'nested/leaf')]) {
          const alternates = (
            await git(repository, ['rev-parse', '--git-path', 'objects/info/alternates'])
          ).trim();
          expect(existsSync(resolvePath(repository, alternates))).toBe(false);
          await git(repository, ['fsck', '--full']);
        }
        expect((await git(checkout, ['status', '--porcelain'])).trim()).toBe('');
      }
    );
  }, 180_000);

  it.each(['partial', 'shallow', 'linked', 'alternates', 'wrong-origin', 'symlink', 'missing'])(
    'does not borrow an unselected %s local source',
    async (layout) => {
      await withLocalSubmoduleGroup(false, async ({ web, api, options, git }) => {
        const source = join(web, 'deps/api');
        const url = pathToFileURL(api).href;
        if (layout === 'partial') await git(source, ['config', 'remote.origin.promisor', 'true']);
        if (layout === 'wrong-origin')
          await git(source, ['remote', 'set-url', 'origin', 'https://github.com/other/repo']);
        if (layout === 'alternates') {
          const objects = (
            await git(api, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])
          ).trim();
          const alternate = (
            await git(source, [
              'rev-parse',
              '--path-format=absolute',
              '--git-path',
              'objects/info/alternates',
            ])
          ).trim();
          await writeFile(alternate, objects + '\n');
        }
        if (['shallow', 'linked', 'symlink', 'missing'].includes(layout)) {
          await rm(source, { recursive: true, force: true });
          if (layout === 'shallow') await git(web, ['clone', '--depth', '1', url, source]);
          if (layout === 'linked') await git(api, ['worktree', 'add', '--detach', source]);
          if (layout === 'symlink') {
            await symlink(api, source, 'dir');
            // Git status rejects symlinked gitlinks before reference selection. Ignore
            // only this source's status so preparation can exercise the fallback;
            // git submodule update and reference validation still inspect the path.
            await git(web, ['config', 'submodule.deps/api.ignore', 'all']);
          }
        }
        // The symlink target has a GitHub origin; match it so URL mismatch cannot
        // accidentally satisfy the symlink rejection assertion.
        const expectedUrl = layout === 'symlink' ? 'git@github.com:example/api.git' : url;
        expect(
          await worktreeGitLegacy.findProjectSubmoduleReference(source, expectedUrl)
        ).toBeUndefined();
        const prepared = await materializeProjectGroup(options);
        const checkout = join(prepared.workdir, 'web/deps/api');
        expect(await readFile(join(checkout, 'readme'), 'utf8')).toBe('original');
        if (layout === 'partial' || layout === 'symlink') {
          await git(checkout, ['fsck', '--full']);
        }
        if (layout === 'symlink') {
          expect((await lstat(source)).isSymbolicLink()).toBe(true);
          expect(await realpath(source)).toBe(api);
          expect((await lstat(checkout)).isDirectory()).toBe(true);
          expect((await git(api, ['status', '--porcelain'])).trim()).toBe('');
        }
      });
    },
    180_000
  );

  it('ignores stale unselected submodule paths while initializing real gitlinks', async () => {
    await withLocalSubmoduleGroup(false, async ({ web, options, git }) => {
      await git(web, ['config', '-f', '.gitmodules', 'submodule.stale.path', 'deps/stale']);
      await git(web, [
        'config',
        '-f',
        '.gitmodules',
        'submodule.stale.url',
        'file:///nonexistent-stale-submodule',
      ]);
      await git(web, ['commit', '-am', 'stale submodule metadata']);

      const prepared = await materializeProjectGroup(options);
      expect(await readFile(join(prepared.workdir, 'web/deps/api/readme'), 'utf8')).toBe(
        'original'
      );
      expect(existsSync(join(prepared.workdir, 'web/deps/api/.git'))).toBe(true);
      expect(existsSync(join(prepared.workdir, 'web/deps/stale'))).toBe(false);
    });
  }, 180_000);

  it.each(['linked-worktree', 'shallow'])(
    'materializes a local member backed by a %s without using it as an object reference',
    async (layout) => {
      await withLocalSubmoduleGroup(true, async ({ directory, api, roots, options, git }) => {
        const reference = join(directory, 'reference');
        if (layout === 'linked-worktree')
          await git(api, ['worktree', 'add', '-b', 'local-copy', reference]);
        else {
          await git(directory, ['clone', '--depth', '1', pathToFileURL(api).href, reference]);
          await git(reference, ['remote', 'set-url', 'origin', 'git@github.com:example/api.git']);
        }
        roots.api = reference;
        const sourceHead = (await git(reference, ['rev-parse', 'HEAD'])).trim();

        const prepared = await materializeProjectGroup(options);

        expect(await readFile(join(prepared.workdir, 'web/deps/api/readme'), 'utf8')).toBe(
          'original'
        );
        expect((await git(reference, ['rev-parse', 'HEAD'])).trim()).toBe(sourceHead);
        expect((await git(reference, ['rev-parse', '--is-shallow-repository'])).trim()).toBe(
          layout === 'shallow' ? 'true' : 'false'
        );
      });
    },
    180_000
  );

  it.each(['empty', 'missing'])(
    'archives a failed submodule clone with a %s member directory and preserves completed work',
    async (state) => {
      await withLocalSubmoduleGroup(
        true,
        async ({ directory, web, api, run, options, meta, git }) => {
          vi.stubEnv(
            'GIT_CONFIG_KEY_0',
            `url.${pathToFileURL(join(directory, 'unavailable')).href}.insteadOf`
          );
          await expect(materializeProjectGroup(options)).rejects.toThrow(/clone|repository/i);
          const root = join(projectGroupDirectory(run), 'worktrees', owner);
          const parent = join(root, 'web');
          const member = join(parent, 'deps/api');
          await rm(member, { recursive: true, force: true });
          if (state === 'empty') await mkdir(member, { recursive: true });
          await writeFile(join(parent, 'saved.txt'), 'completed before archive');
          const sourceHead = (await git(web, ['rev-parse', 'HEAD'])).trim();
          const childBranches = await git(api, [
            'for-each-ref',
            '--format=%(refname) %(objectname)',
            'refs/heads/',
          ]);
          meta.set(owner, { ...meta.get(owner), isArchived: true });

          await archiveProjectGroup({ ...options, worktreePath: root, cleanup: async () => {} });

          expect(existsSync(root)).toBe(false);
          const saved = Object.values(meta.get(owner)!.projectRun!.members)[0]!.branch;
          if (!saved) throw new Error('Archived parent branch was not recorded');
          expect((await git(web, ['show', `${saved}:saved.txt`])).trim()).toBe(
            'completed before archive'
          );
          expect((await git(web, ['rev-parse', 'HEAD'])).trim()).toBe(sourceHead);
          expect(await readFile(join(web, 'readme'), 'utf8')).toBe('original');
          expect(existsSync(join(web, 'saved.txt'))).toBe(false);
          expect(
            await git(api, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'])
          ).toBe(childBranches);
          expect(await git(web, ['ls-tree', saved, '--', 'deps/api'])).toMatch(/^160000 commit /);
          vi.stubEnv('GIT_CONFIG_KEY_0', `url.${pathToFileURL(api).href}.insteadOf`);
          meta.set(owner, { ...meta.get(owner), isArchived: false });
          const restored = await materializeProjectGroup(options);
          expect(await readFile(join(restored.workdir, 'web/saved.txt'), 'utf8')).toBe(
            'completed before archive'
          );
          expect(await readFile(join(restored.workdir, 'web/deps/api/readme'), 'utf8')).toBe(
            'original'
          );
          expect(existsSync(join(restored.workdir, 'web/deps/api/.git'))).toBe(true);
        }
      );
    },
    180_000
  );
});
