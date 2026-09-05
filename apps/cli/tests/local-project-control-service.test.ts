import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
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
