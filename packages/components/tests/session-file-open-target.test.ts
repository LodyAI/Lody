import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSessionFileOpenTarget } from '../src/lib/session-file-open-target';

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

    it('carries an anchor the caller supplied rather than one parsed from the path', () => {
      expect(
        resolveSessionFileOpenTarget({
          rawPath: 'src/app.ts',
          pathKind: 'canonical',
          workspacePath: WORKSPACE,
          startLine: 42,
        })
      ).toEqual({ filePath: 'src/app.ts', startLine: 42, fromMarkdownLink: false });
    });
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

    it.each([WORKSPACE, null])(
      'preserves another local worktree with workspace %s',
      (workspacePath) => {
        expect(
          resolveSessionFileOpenTarget({
            rawPath: `${otherWorktree}/report%20v2.md#L12-L15`,
            pathKind: 'markdown-href',
            workspacePath,
            preserveWorktreePath: true,
          })
        ).toEqual({
          filePath: `${otherWorktree}/report v2.md`,
          startLine: 12,
          endLine: 15,
          fromMarkdownLink: true,
          lineSuffixFormat: 'github',
        });
      }
    );

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

    it('still shares the indexed identity for the current local workspace', () => {
      expect(
        resolveSessionFileOpenTarget({
          rawPath: `${otherWorktree}/src/app.ts:12`,
          pathKind: 'markdown-href',
          workspacePath: otherWorktree,
          preserveWorktreePath: true,
        })
      ).toMatchObject({ filePath: 'src/app.ts', startLine: 12 });
    });

    it('splits a trailing line suffix off the path', () => {
      expect(
        resolveSessionFileOpenTarget({
          rawPath: 'src/app.ts:12',
          pathKind: 'markdown-href',
          workspacePath: WORKSPACE,
        })
      ).toMatchObject({
        filePath: 'src/app.ts',
        startLine: 12,
        fromMarkdownLink: true,
        lineSuffixFormat: 'colon',
      });
    });

    it('makes an absolute path inside the workspace relative to it', () => {
      expect(
        resolveSessionFileOpenTarget({
          rawPath: `${WORKSPACE}/src/app.ts`,
          pathKind: 'markdown-href',
          workspacePath: WORKSPACE,
        })
      ).toMatchObject({ filePath: 'src/app.ts' });
    });

    it('decodes percent-encoding, which is why an indexed path must not come through here', () => {
      expect(
        resolveSessionFileOpenTarget({
          rawPath: 'docs/report%20v2.md',
          pathKind: 'markdown-href',
          workspacePath: WORKSPACE,
        })
      ).toMatchObject({ filePath: 'docs/report v2.md' });
    });
  });
});
