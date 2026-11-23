import { describe, expect, it } from 'vitest';
import { resolveLocalWorkspaceFilePath } from '../src/lib/session-local-file-path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSessionFileOpenTarget } from '../src/lib/session-file-open-target';
import { encodeSessionFilePath, type SessionProjectRun } from '@lody/shared';
import {
  buildSessionFileRootMounts,
  toSessionFileDisplayPath,
  toSessionFileRequestPath,
} from '../src/lib/session-file-root-mounts';

describe('session-local-file-path', () => {
  describe('resolveLocalWorkspaceFilePath', () => {
    it('preserves absolute paths only for an explicitly local target', () => {
      expect(resolveLocalWorkspaceFilePath('/workspace', '/tmp/build/Lody.zip', true)).toBe(
        '/tmp/build/Lody.zip'
      );
      expect(resolveLocalWorkspaceFilePath(null, '/tmp/build/Lody.dmg', true)).toBe(
        '/tmp/build/Lody.dmg'
      );
      expect(resolveLocalWorkspaceFilePath('/workspace', 'C:/build/Lody.zip', true)).toBe(
        'C:/build/Lody.zip'
      );
      expect(resolveLocalWorkspaceFilePath('/workspace', '../Lody.zip', true)).toBe(
        '/workspace/../Lody.zip'
      );
    });

    it('refuses a path that is not relative to the workspace', () => {
      // Absolute paths remain rejected unless the caller identifies a local target.
      expect(resolveLocalWorkspaceFilePath('/Users/dev/project', '/etc/passwd')).toBeNull();
      expect(resolveLocalWorkspaceFilePath('/Users/dev/project', '../../etc/passwd')).toBeNull();
      expect(
        resolveLocalWorkspaceFilePath('/Users/dev/project', 'src/../../etc/passwd')
      ).toBeNull();
      expect(
        resolveLocalWorkspaceFilePath('/Users/dev/project', 'C:\\Windows\\notepad.exe')
      ).toBeNull();
    });

    it('never joins a home-rooted path onto the workspace root', () => {
      // Remote targets do not resolve it, exactly like an absolute path.
      expect(
        resolveLocalWorkspaceFilePath('/workspace', '~/a.txt', false, '/Users/dev')
      ).toBeNull();
      // An unknown home directory leaves it unresolved rather than producing
      // `<workspace>/~/...`.
      expect(resolveLocalWorkspaceFilePath('/workspace', '~/a.txt', true)).toBeNull();
      expect(resolveLocalWorkspaceFilePath('/workspace', '~/a.txt', true, '  ')).toBeNull();
    });
  });
});

describe('session-file-open-target', () => {
  const WORKSPACE = '/Users/dev/project';

  describe('resolveSessionFileOpenTarget', () => {
    describe('a path that came from the file index', () => {
      // Every one of these is a legal filename, and every one of them used to be
      // rewritten into a path the machine could not find, because the file tree,
      // quick open and the mobile browser all shared the markdown-href parser
      // with agent-written chat links.
      const untouched = [
        ['percent-encoding in the name', 'docs/report%20v2.md'],
        ['a percent sign in the name', 'assets/100%25.png'],
        ['a colon and digits at the end', 'logs/2024:30.txt'],
        [
          'a `worktrees/<uuid>/` segment of its own',
          'fixtures/worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/case.txt',
        ],
        ['a hash in the name', 'notes/draft#2.md'],
        ['a leading space', ' notes.md'],
      ] as const;

      for (const [description, filePath] of untouched) {
        it(`passes through ${description}`, () => {
          expect(
            resolveSessionFileOpenTarget({
              rawPath: filePath,
              pathKind: 'canonical',
              workspacePath: WORKSPACE,
            })
          ).toEqual({ filePath, fromMarkdownLink: false });
        });
      }
    });

    it.each([
      ['docs/a.md#L12', true],
      ['./docs/a.md', true],
      ['/workspace/project/docs/a.md', undefined],
      ['%2Fworkspace%2Fproject%2Fdocs%2Fa.md', undefined],
      ['C:/repo/a.md', undefined],
      ['~/docs/a.md', undefined],
      ['../repo/a.md', undefined],
    ])('limits candidate discovery to ambiguous relative hrefs: %s', (rawPath, expected) => {
      expect(
        resolveSessionFileOpenTarget({
          rawPath,
          pathKind: 'markdown-href',
          workspacePath: WORKSPACE,
        }).resolveMarkdownLink
      ).toBe(expected);
      expect(
        resolveSessionFileOpenTarget({ rawPath, pathKind: 'canonical', workspacePath: WORKSPACE })
          .resolveMarkdownLink
      ).toBeUndefined();
    });

    describe('an href an agent wrote', () => {
      const otherWorktree = '/tmp/worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

      it('reads the linked local file instead of a same-named file in the current workspace', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'lody-file-link-'));
        try {
          const workspacePath = path.join(root, 'current');
          const linkedRoot = path.join(root, 'worktrees', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
          await mkdir(workspacePath, { recursive: true });
          await mkdir(linkedRoot, { recursive: true });
          await writeFile(path.join(workspacePath, 'report.md'), 'wrong workspace');
          const linkedFile = path.join(linkedRoot, 'report.md');
          await writeFile(linkedFile, 'linked artifact');
          const target = resolveSessionFileOpenTarget({
            rawPath: `${linkedFile}:12`,
            pathKind: 'markdown-href',
            workspacePath,
            preserveWorktreePath: true,
          });
          expect(await readFile(path.resolve(workspacePath, target.filePath), 'utf8')).toBe(
            'linked artifact'
          );
          await rm(linkedFile);
          await expect(
            readFile(path.resolve(workspacePath, target.filePath), 'utf8')
          ).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });

      it('keeps portable worktree mapping for nonlocal opens', () => {
        expect(
          resolveSessionFileOpenTarget({
            rawPath: `${otherWorktree}/report.md:12`,
            pathKind: 'markdown-href',
            workspacePath: WORKSPACE,
          })
        ).toMatchObject({ filePath: 'report.md', startLine: 12 });
      });

      it.each([
        `../worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report.md`,
        `C:/worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report.md`,
        `\\\\server\\worktrees\\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\\report.md`,
      ])('preserves the local target %s', (rawPath) => {
        expect(
          resolveSessionFileOpenTarget({
            rawPath,
            pathKind: 'markdown-href',
            workspacePath: WORKSPACE,
            preserveWorktreePath: true,
          }).filePath
        ).toBe(rawPath.replace(/\\/g, '/'));
      });
    });
  });
});

describe('session-file-root-mounts', () => {
  const run = {
    id: '0b9a4a6e-6d2f-4f3a-9a53-0f3d1f0b2c11',
    name: 'Shop',
    root: 'project-shop-0b9a4a6e-6d2f-4f3a-9a53-0f3d1f0b2c11',
    members: {
      api: {
        o: 0,
        access: 'worktree',
        src: { kind: 'github', repoFullName: 'acme/api' },
        placement: { kind: 'root', dir: 'api' },
        path: 'api',
        base: 'HEAD',
      },
      docs: {
        o: 1,
        access: 'additional',
        src: { kind: 'local', machineId: 'm1', localProjectId: 'docs' },
        placement: { kind: 'root', dir: 'docs' },
        path: 'docs',
        base: 'HEAD',
      },
      assets: {
        o: 2,
        access: 'link',
        src: { kind: 'local', machineId: 'm1', localProjectId: 'assets' },
        placement: { kind: 'root', dir: 'assets' },
        path: 'assets',
        base: 'HEAD',
      },
    },
  } as unknown as SessionProjectRun;

  const docsKey = (relativePath: string) =>
    encodeSessionFilePath({ rootId: 'member:docs', relativePath });

  describe('session file root mounts', () => {
    const mounts = buildSessionFileRootMounts(run);

    it('mounts only members outside the main directory', () => {
      expect(mounts.map((mount) => [mount.rootId, mount.mountPath])).toEqual([
        ['member:docs', 'docs'],
        ['member:assets', 'assets'],
      ]);
      expect(buildSessionFileRootMounts(undefined)).toEqual([]);
    });

    it('shows member keys under their mount and leaves main paths unchanged', () => {
      expect(toSessionFileDisplayPath(docsKey('guide/intro.md'), mounts)).toBe(
        'docs/guide/intro.md'
      );
      expect(toSessionFileDisplayPath('api/src/main.go', mounts)).toBe('api/src/main.go');
      // A root this snapshot does not mount never shows a NUL.
      expect(
        toSessionFileDisplayPath(
          encodeSessionFilePath({ rootId: 'member:gone' as string, relativePath: 'a.md' }),
          mounts
        )
      ).toBe('member-gone/a.md');
    });

    it('splits display paths and raw keys back into rootId and relative path', () => {
      expect(toSessionFileRequestPath('docs/guide/intro.md', mounts)).toEqual({
        rootId: 'member:docs',
        path: 'guide/intro.md',
      });
      expect(toSessionFileRequestPath(docsKey('a.md'), mounts)).toEqual({
        rootId: 'member:docs',
        path: 'a.md',
      });
      expect(toSessionFileRequestPath('api/main.go', mounts)).toEqual({ path: 'api/main.go' });
      // The mount directory itself and look-alike prefixes stay main paths.
      expect(toSessionFileRequestPath('docs', mounts)).toEqual({ path: 'docs' });
      expect(toSessionFileRequestPath('docs-old/a.md', mounts)).toEqual({ path: 'docs-old/a.md' });
    });
  });
});
