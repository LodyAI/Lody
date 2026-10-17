import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalProjectControlService } from '../src/lib/local-project-control-service';
import type { LocalProjectId } from '@lody/shared';
import type { Logger } from '../src/utils/logger';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  success: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  setLevel: () => undefined,
  setDebug: () => undefined,
  child: () => noopLogger,
  close: async () => undefined,
};

describe('LocalProjectControlService.createDirectory', () => {
  let parent: string;
  const service = new LocalProjectControlService(noopLogger);

  beforeEach(async () => {
    parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lody-create-directory-')));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(parent, { recursive: true, force: true });
  });

  it('creates one empty directory under the canonical parent, without registration', async () => {
    await mkdir(path.join(parent, 'real parent'));
    await symlink(path.join(parent, 'real parent'), path.join(parent, 'alias'), 'junction');
    const result = await service.createDirectory(path.join(parent, 'alias'), '新项目 with spaces');
    expect(result.path).toBe(path.join(parent, 'real parent', '新项目 with spaces'));
    expect((await fs.promises.stat(result.path)).isDirectory()).toBe(true);
    expect(await readdir(result.path)).toEqual([]);
    expect((await service.browseDirectory({ absolutePath: result.path })).path).toBe(result.path);
  });

  it.each([
    '',
    ' ',
    '.',
    '..',
    '../escape',
    'a/b',
    'a\\b',
    '/absolute',
    'a\0b',
    'a\nb',
    ' padded',
    'padded ',
  ])('rejects a non-single name %j without writing', async (name) => {
    await expect(service.createDirectory(parent, name)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await readdir(parent)).toEqual([]);
  });

  it.each([
    'CON',
    'nul.txt',
    'COM1',
    'LPT9.ext',
    'COM¹',
    'trailing.',
    'a:b',
    'a*',
    'a?',
    'a|b',
    'a<b',
  ])('rejects Windows reserved or invalid name %j', async (name) => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    await expect(service.createDirectory(parent, name)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await readdir(parent)).toEqual([]);
  });

  it('requires an absolute, existing directory parent and never creates intermediate parents', async () => {
    await writeFile(path.join(parent, 'file'), 'preserve');
    for (const invalid of [
      '',
      'relative',
      `${parent}\0`,
      path.join(parent, 'missing'),
      path.join(parent, 'file'),
    ]) {
      await expect(service.createDirectory(invalid, 'child')).rejects.toMatchObject({
        code: 'path_invalid',
      });
    }
    expect(await readdir(parent)).toEqual(['file']);
    expect(await fs.promises.readFile(path.join(parent, 'file'), 'utf8')).toBe('preserve');
  });

  it('never overwrites a directory, file, or dangling symlink', async () => {
    await mkdir(path.join(parent, 'directory'));
    await writeFile(path.join(parent, 'file'), 'preserve');
    await symlink(path.join(parent, 'missing'), path.join(parent, 'link'), 'junction');
    for (const name of ['directory', 'file', 'link']) {
      await expect(service.createDirectory(parent, name)).rejects.toMatchObject({
        code: 'already_exists',
      });
    }
    expect(await fs.promises.readFile(path.join(parent, 'file'), 'utf8')).toBe('preserve');
    expect((await fs.promises.lstat(path.join(parent, 'link'))).isSymbolicLink()).toBe(true);
    expect(await readdir(parent)).toEqual(['directory', 'file', 'link']);
  });

  it('allows exactly one concurrent creation and rejects retries', async () => {
    const results = await Promise.allSettled([
      service.createDirectory(parent, 'child'),
      service.createDirectory(parent, 'child'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'already_exists' },
    });
    await expect(service.createDirectory(parent, 'child')).rejects.toMatchObject({
      code: 'already_exists',
    });
    expect(await readdir(parent)).toEqual(['child']);
    expect(await readdir(path.join(parent, 'child'))).toEqual([]);
  });

  it.each(['EACCES', 'EPERM', 'EROFS'])(
    'reports mkdir %s without changing the parent',
    async (code) => {
      // chmod cannot reliably deny the root user running CI; inject the OS failure at mkdir.
      vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce(
        Object.assign(new Error(code), { code })
      );
      await expect(service.createDirectory(parent, 'child')).rejects.toMatchObject({
        code: 'access_denied',
      });
      expect(await readdir(parent)).toEqual([]);
    }
  );

  it('reports an unreadable parent', async () => {
    vi.spyOn(fs.promises, 'realpath').mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' })
    );
    await expect(service.createDirectory(parent, 'child')).rejects.toMatchObject({
      code: 'access_denied',
    });
    expect(await readdir(parent)).toEqual([]);
  });
});

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

  it('sorts before truncation and returns stat metadata only when requested', async () => {
    await mkdir(path.join(rootPath, 'sorted'));
    await writeFile(path.join(rootPath, 'sorted', 'file10.txt'), '1234567890');
    await writeFile(path.join(rootPath, 'sorted', 'file2.txt'), '12');

    const result = await service.listProjectDirectory(rootPath, 'sorted', {
      limit: 1,
      sort: { by: 'size', order: 'desc', directoriesFirst: false },
      include: ['stat'],
    });

    expect(result.entries[0]).toMatchObject({ name: 'file10.txt', type: 'file', size: 10 });
    expect(result.entries[0]?.mtimeMs).toEqual(expect.any(Number));
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

describe('LocalProjectControlService.readProjectFile', () => {
  let rootPath: string;
  let service: LocalProjectControlService;

  beforeEach(async () => {
    rootPath = await mkdtemp(path.join(os.tmpdir(), 'lody-local-project-read-'));
    service = new LocalProjectControlService(noopLogger);
    await mkdir(path.join(rootPath, '.git'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootPath, { recursive: true, force: true });
  });

  /**
   * The read sizes its buffer from `fstat`, so a file APPENDED between the stat
   * and the read fills that buffer exactly. Under-reporting the size is the
   * deterministic way to reproduce that race: it is the same state the read
   * observes, without racing a writer.
   */
  const understateSize = (byBytes: number): void => {
    const realFstat = fs.fstatSync.bind(fs);
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: unknown) => {
      const stat = realFstat(fd, options as never);
      if (!stat.isFile()) return stat;
      Object.defineProperty(stat, 'size', { value: Math.max(0, stat.size - byBytes) });
      return stat;
    }) as typeof fs.fstatSync);
  };

  it('reads the whole file when it grew past the stat-sized buffer', async () => {
    const content = 'x'.repeat(5_000);
    await writeFile(path.join(rootPath, 'grows.txt'), content);
    understateSize(4_900);

    const result = service.readProjectFile(rootPath, 'grows.txt', { maxBytes: 1024 * 1024 });

    // A full buffer is not proof of EOF; the prefix must not be served as the file.
    expect(result?.content).toBe(content);
    expect(result?.truncated).toBe(false);
  });

  it('still reports truncation when a grown file passes the budget', async () => {
    await writeFile(path.join(rootPath, 'grows-past-budget.txt'), 'y'.repeat(5_000));
    understateSize(4_900);

    const result = service.readProjectFile(rootPath, 'grows-past-budget.txt', { maxBytes: 200 });

    expect(result?.content).toHaveLength(200);
    expect(result?.truncated).toBe(true);
  });
});
