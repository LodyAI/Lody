import { archiveProjectGroup } from './worktree/project-worktree-archive';
import { existsSync } from 'node:fs';
import { materializeProjectGroup, projectGroupDirectory } from './worktree/project-worktrees';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
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

  it('preserves an unknown nonempty submodule directory without backing up its parent as the child', async () => {
    await withLocalSubmoduleGroup(true, async ({ directory, api, run, options, meta, git }) => {
      vi.stubEnv(
        'GIT_CONFIG_KEY_0',
        `url.${pathToFileURL(join(directory, 'unavailable')).href}.insteadOf`
      );
      await expect(materializeProjectGroup(options)).rejects.toThrow(/clone|repository/i);
      const root = join(projectGroupDirectory(run), 'worktrees', owner);
      const parent = join(root, 'web');
      const member = join(parent, 'deps/api');
      await mkdir(member, { recursive: true });
      await writeFile(join(member, 'keep.txt'), 'unknown local content');
      const parentHead = (await git(parent, ['rev-parse', 'HEAD'])).trim();
      const childBranches = await git(api, [
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads/',
      ]);
      meta.set(owner, { ...meta.get(owner), isArchived: true });

      await expect(
        archiveProjectGroup({ ...options, worktreePath: root, cleanup: async () => {} })
      ).rejects.toThrow(/no independent Git checkout/);

      expect(await readFile(join(member, 'keep.txt'), 'utf8')).toBe('unknown local content');
      expect((await git(parent, ['rev-parse', 'HEAD'])).trim()).toBe(parentHead);
      expect(
        await git(api, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'])
      ).toBe(childBranches);
    });
  }, 180_000);

  it('keeps the project when a missing submodule has an unrestorable saved branch', async () => {
    await withLocalSubmoduleGroup(true, async ({ directory, run, options, meta }) => {
      vi.stubEnv(
        'GIT_CONFIG_KEY_0',
        `url.${pathToFileURL(join(directory, 'unavailable')).href}.insteadOf`
      );
      await expect(materializeProjectGroup(options)).rejects.toThrow(/clone|repository/i);
      const root = join(projectGroupDirectory(run), 'worktrees', owner);
      const member = join(root, 'web/deps/api');
      await rm(member, { recursive: true, force: true });
      const savedRun = meta.get(owner)!.projectRun!;
      Object.values(savedRun.members)[1]!.branch = 'local/missing-backup';
      meta.set(owner, { ...meta.get(owner), projectRun: savedRun, isArchived: true });
      await writeFile(join(root, 'web/keep.txt'), 'unbacked parent work');

      await expect(
        archiveProjectGroup({ ...options, worktreePath: root, cleanup: async () => {} })
      ).rejects.toThrow();

      expect(await readFile(join(root, 'web/keep.txt'), 'utf8')).toBe('unbacked parent work');
      expect(existsSync(root)).toBe(true);
      expect(existsSync(member)).toBe(false);
    });
  }, 180_000);

  it.each(['empty', 'missing'])(
    'preserves an explicit staged gitlink deletion when a submodule directory is %s',
    async (state) => {
      await withLocalSubmoduleGroup(true, async ({ directory, run, options, meta, git }) => {
        vi.stubEnv(
          'GIT_CONFIG_KEY_0',
          `url.${pathToFileURL(join(directory, 'unavailable')).href}.insteadOf`
        );
        await expect(materializeProjectGroup(options)).rejects.toThrow(/clone|repository/i);
        const root = join(projectGroupDirectory(run), 'worktrees', owner);
        const parent = join(root, 'web');
        await rm(join(parent, 'deps/api'), { recursive: true, force: true });
        if (state === 'empty') await mkdir(join(parent, 'deps/api'), { recursive: true });
        await git(parent, ['rm', '--cached', 'deps/api']);
        const staged = await git(parent, ['diff', '--cached', '--raw']);
        const parentHead = (await git(parent, ['rev-parse', 'HEAD'])).trim();
        meta.set(owner, { ...meta.get(owner), isArchived: true });

        await expect(
          archiveProjectGroup({ ...options, worktreePath: root, cleanup: async () => {} })
        ).rejects.toThrow();

        expect(await git(parent, ['diff', '--cached', '--raw'])).toBe(staged);
        expect(await git(parent, ['ls-files', '--stage', '--', 'deps/api'])).toBe('');
        expect((await git(parent, ['rev-parse', 'HEAD'])).trim()).toBe(parentHead);
        expect(existsSync(root)).toBe(true);
      });
    },
    180_000
  );

  it('rejects a missing submodule below an escaping symlink without creating an external directory', async () => {
    await withLocalSubmoduleGroup(true, async ({ directory, run, options, meta, git }) => {
      vi.stubEnv(
        'GIT_CONFIG_KEY_0',
        `url.${pathToFileURL(join(directory, 'unavailable')).href}.insteadOf`
      );
      await expect(materializeProjectGroup(options)).rejects.toThrow(/clone|repository/i);
      const root = join(projectGroupDirectory(run), 'worktrees', owner);
      const parent = join(root, 'web');
      const outside = join(directory, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'keep.txt'), 'external content');
      await rm(join(parent, 'deps'), { recursive: true, force: true });
      await symlink(outside, join(parent, 'deps'), 'dir');
      const parentHead = (await git(parent, ['rev-parse', 'HEAD'])).trim();
      meta.set(owner, { ...meta.get(owner), isArchived: true });

      await expect(
        archiveProjectGroup({ ...options, worktreePath: root, cleanup: async () => {} })
      ).rejects.toThrow();

      expect(existsSync(join(outside, 'api'))).toBe(false);
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('external content');
      expect((await git(parent, ['rev-parse', 'HEAD'])).trim()).toBe(parentHead);
      expect(existsSync(root)).toBe(true);
    });
  }, 180_000);

  it.each(['main', 'detached'])(
    'preserves an independent submodule checkout on %s when no task branch was recorded',
    async (checkoutState) => {
      await withLocalSubmoduleGroup(true, async ({ directory, api, run, options, meta, git }) => {
        vi.stubEnv(
          'GIT_CONFIG_KEY_0',
          `url.${pathToFileURL(join(directory, 'unavailable')).href}.insteadOf`
        );
        await expect(materializeProjectGroup(options)).rejects.toThrow(/clone|repository/i);
        const root = join(projectGroupDirectory(run), 'worktrees', owner);
        const parent = join(root, 'web');
        const member = join(parent, 'deps/api');
        await rm(member, { recursive: true, force: true });
        await git(parent, ['clone', pathToFileURL(api).href, member]);
        if (checkoutState === 'detached') await git(member, ['checkout', '--detach']);
        await writeFile(join(member, 'keep.txt'), 'unclaimed checkout work');
        const parentHead = (await git(parent, ['rev-parse', 'HEAD'])).trim();
        const childBranches = await git(api, [
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads/',
        ]);
        meta.set(owner, { ...meta.get(owner), isArchived: true });

        await expect(
          archiveProjectGroup({ ...options, worktreePath: root, cleanup: async () => {} })
        ).rejects.toThrow();

        expect(await readFile(join(member, 'keep.txt'), 'utf8')).toBe('unclaimed checkout work');
        expect((await git(parent, ['rev-parse', 'HEAD'])).trim()).toBe(parentHead);
        expect(
          await git(api, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'])
        ).toBe(childBranches);
      });
    },
    180_000
  );
});
