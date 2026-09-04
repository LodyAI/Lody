import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalProjectControlService,
  listLocalProjectFilesByWalk,
} from '../src/lib/local-project-control-service';
import type { LocalProjectId } from '@lody/shared';
import type { Logger } from '../src/utils/logger';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  success: () => undefined,
  debug: () => undefined,
  setLevel: () => undefined,
  setDebug: () => undefined,
  child: () => noopLogger,
  close: async () => undefined,
};

describe('LocalProjectControlService.listProjectDirectory', () => {
  let rootPath: string;
  let service: LocalProjectControlService;

  beforeEach(async () => {
    rootPath = await mkdtemp(path.join(os.tmpdir(), 'lody-local-project-'));
    service = new LocalProjectControlService(noopLogger);

    await mkdir(path.join(rootPath, '.git'));
    await mkdir(path.join(rootPath, 'src'));
    await mkdir(path.join(rootPath, 'ignored-dir'));
    await writeFile(path.join(rootPath, '.gitignore'), 'ignored.txt\nignored-dir/\n');
    await writeFile(path.join(rootPath, 'package.json'), '{}\n');
    await writeFile(path.join(rootPath, 'src', 'index.ts'), 'export {};\n');
    await writeFile(path.join(rootPath, 'ignored.txt'), 'ignored\n');
    await writeFile(path.join(rootPath, 'ignored-dir', 'hidden.txt'), 'ignored\n');
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it('lists one directory level and applies project ignore rules', async () => {
    const result = await service.listProjectDirectory(rootPath, '');

    expect(result).toEqual({
      entries: [
        { name: 'src', type: 'directory' },
        { name: '.gitignore', type: 'file' },
        { name: 'package.json', type: 'file' },
      ],
      truncated: false,
    });
  });

  it('lists child directories without walking recursively', async () => {
    const result = await service.listProjectDirectory(rootPath, 'src');

    expect(result).toEqual({
      entries: [{ name: 'index.ts', type: 'file' }],
      truncated: false,
    });
  });

  it('reports truncation for a directory-level limit', async () => {
    const result = await service.listProjectDirectory(rootPath, '', { limit: 1 });

    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('browses machine directories without project-root filtering', async () => {
    await mkdir(path.join(rootPath, 'package-dir'));
    await mkdir(path.join(rootPath, 'package-dir', '.git'));
    await writeFile(path.join(rootPath, 'package-dir', 'package.json'), '{}\n');

    const srcRealPath = await realpath(path.join(rootPath, 'src'));
    const result = await service.browseDirectory({
      absolutePath: rootPath,
      registeredProjects: {
        ['project-src' as LocalProjectId]: srcRealPath,
      },
    });

    expect(result.path).toBe(await realpath(rootPath));
    expect(result.entries).toEqual([
      {
        name: 'ignored-dir',
        absolutePath: await realpath(path.join(rootPath, 'ignored-dir')),
        isSymlink: false,
        hidden: false,
      },
      {
        name: 'package-dir',
        absolutePath: await realpath(path.join(rootPath, 'package-dir')),
        isSymlink: false,
        hidden: false,
        hints: { git: true },
      },
      {
        name: 'src',
        absolutePath: srcRealPath,
        isSymlink: false,
        hidden: false,
        registeredProjectId: 'project-src',
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('supports hidden directories and cursor pagination while browsing', async () => {
    const firstPage = await service.browseDirectory({
      absolutePath: rootPath,
      showHidden: true,
      limit: 1,
    });

    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0]?.name).toBe('.git');
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.nextCursor).toBe('1');

    const secondPage = await service.browseDirectory({
      absolutePath: rootPath,
      showHidden: true,
      limit: 1,
      cursor: firstPage.nextCursor,
    });

    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.entries[0]?.name).toBe('ignored-dir');
  });
});

describe('listLocalProjectFilesByWalk', () => {
  let rootPath: string;

  beforeEach(async () => {
    // Called DIRECTLY: ripgrep answers the default path now, so going through
    // `listProjectFiles` would no longer reach this fallback at all. It still
    // has to be correct for a machine that has no ripgrep binary.
    rootPath = await mkdtemp(path.join(os.tmpdir(), 'lody-local-project-walk-'));
    await mkdir(path.join(rootPath, '.git'));
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  const listPaths = async (): Promise<string[]> =>
    (await listLocalProjectFilesByWalk(rootPath, 80_000)).paths;

  it('applies a nested .gitignore to its own subtree only', async () => {
    await mkdir(path.join(rootPath, 'app', 'build'), { recursive: true });
    await mkdir(path.join(rootPath, 'lib', 'build'), { recursive: true });
    await writeFile(path.join(rootPath, 'app', '.gitignore'), 'build/\n');
    await writeFile(path.join(rootPath, 'app', 'main.ts'), 'export {};\n');
    await writeFile(path.join(rootPath, 'app', 'build', 'out.js'), '\n');
    await writeFile(path.join(rootPath, 'lib', 'build', 'out.js'), '\n');

    expect(await listPaths()).toEqual([
      'app/.gitignore',
      'app/main.ts',
      'lib/build/out.js',
    ]);
  });

  it('keeps root rules while a nested file adds its own', async () => {
    await mkdir(path.join(rootPath, 'pkg'));
    await writeFile(path.join(rootPath, '.gitignore'), '*.log\n');
    await writeFile(path.join(rootPath, 'pkg', '.gitignore'), 'secret.txt\n');
    await writeFile(path.join(rootPath, 'keep.ts'), '\n');
    await writeFile(path.join(rootPath, 'root.log'), '\n');
    await writeFile(path.join(rootPath, 'pkg', 'nested.log'), '\n');
    await writeFile(path.join(rootPath, 'pkg', 'secret.txt'), '\n');
    await writeFile(path.join(rootPath, 'pkg', 'keep.ts'), '\n');

    expect(await listPaths()).toEqual([
      '.gitignore',
      'keep.ts',
      'pkg/.gitignore',
      'pkg/keep.ts',
    ]);
  });

  it('lets a nested negation re-include what the root ignored', async () => {
    await mkdir(path.join(rootPath, 'docs'));
    await writeFile(path.join(rootPath, '.gitignore'), '*.md\n');
    await writeFile(path.join(rootPath, 'docs', '.gitignore'), '!README.md\n');
    await writeFile(path.join(rootPath, 'top.md'), '\n');
    await writeFile(path.join(rootPath, 'docs', 'README.md'), '\n');
    await writeFile(path.join(rootPath, 'docs', 'notes.md'), '\n');

    expect(await listPaths()).toEqual([
      '.gitignore',
      'docs/.gitignore',
      'docs/README.md',
    ]);
  });

  it('never lists .git internals', async () => {
    await writeFile(path.join(rootPath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(rootPath, 'a.ts'), '\n');

    expect(await listPaths()).toEqual(['a.ts']);
  });
});

describe('LocalProjectControlService.listProjectFiles via ripgrep', () => {
  let rootPath: string;
  let service: LocalProjectControlService;

  beforeEach(async () => {
    rootPath = await mkdtemp(path.join(os.tmpdir(), 'lody-local-project-rg-'));
    service = new LocalProjectControlService(noopLogger);
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  const listPaths = async (): Promise<string[]> => (await service.listProjectFiles(rootPath)).paths;

  it('answers an empty directory instead of falling through', async () => {
    // ripgrep exits 1 for "no matches", which for `--files` is an empty
    // directory. Measured, not assumed: treating that as failure would hand
    // every empty project to the slower fallback.
    const result = await service.listProjectFiles(rootPath);

    expect(result).toEqual({ paths: [], truncated: false });
  });

  it('never lists .git, at the root or nested', async () => {
    await mkdir(path.join(rootPath, '.git'), { recursive: true });
    await mkdir(path.join(rootPath, 'vendor', 'inner', '.git'), { recursive: true });
    await writeFile(path.join(rootPath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(rootPath, 'vendor', 'inner', '.git', 'HEAD'), 'ref: x\n');
    await writeFile(path.join(rootPath, 'vendor', 'inner', 'kept.ts'), '\n');

    expect(await listPaths()).toEqual(['vendor/inner/kept.ts']);
  });

  it('applies a root and a nested .gitignore in a directory that is not a repository', async () => {
    // This is what `--no-require-git` buys: without it ripgrep applies
    // .gitignore only inside a git repository.
    await mkdir(path.join(rootPath, 'app', 'build'), { recursive: true });
    await mkdir(path.join(rootPath, 'lib'), { recursive: true });
    await writeFile(path.join(rootPath, '.gitignore'), '*.log\n');
    await writeFile(path.join(rootPath, 'app', '.gitignore'), 'build/\n');
    await writeFile(path.join(rootPath, 'app', 'main.ts'), '\n');
    await writeFile(path.join(rootPath, 'app', 'build', 'out.js'), '\n');
    await writeFile(path.join(rootPath, 'lib', 'keep.ts'), '\n');
    await writeFile(path.join(rootPath, 'root.log'), '\n');

    expect(await listPaths()).toEqual([
      '.gitignore',
      'app/.gitignore',
      'app/main.ts',
      'lib/keep.ts',
    ]);
  });

  it('lists dotfiles, which are ordinary project files', async () => {
    await mkdir(path.join(rootPath, '.github'), { recursive: true });
    await writeFile(path.join(rootPath, '.env'), '\n');
    await writeFile(path.join(rootPath, '.github', 'ci.yml'), '\n');

    expect(await listPaths()).toEqual(['.env', '.github/ci.yml']);
  });

  it('reports truncation at maxFiles', async () => {
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      await writeFile(path.join(rootPath, name), '\n');
    }

    const result = await service.listProjectFiles(rootPath, { maxFiles: 2 });

    expect(result.paths).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('lists a symlinked file, which git and the walk both list', async () => {
    // This repository tracks 36 of these (every `CLAUDE.md` is a symlink to its
    // `AGENTS.md`), so a lister that drops them makes `@CLAUDE.md` find nothing.
    await writeFile(path.join(rootPath, 'AGENTS.md'), '\n');
    await symlink('AGENTS.md', path.join(rootPath, 'CLAUDE.md'));

    expect(await listPaths()).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('keeps the listing it produced when a symlink loop reports an error', async () => {
    // `--follow` makes ripgrep exit 2 on a loop while still writing everything
    // it reached. Falling through here would run a second full enumeration for
    // a result already in hand.
    await mkdir(path.join(rootPath, 'app'), { recursive: true });
    await writeFile(path.join(rootPath, 'app', 'main.ts'), '\n');
    await symlink(rootPath, path.join(rootPath, 'app', 'loop'));

    expect(await listPaths()).toEqual(['app/main.ts']);
  });
});
