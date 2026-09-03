import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareExportOutputDir } from './output-dir';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-export-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    })
  );
});

describe('prepareExportOutputDir', () => {
  it('creates a missing directory', async () => {
    const root = await createTempDir();
    const target = path.join(root, 'nested', 'export');

    await prepareExportOutputDir(target);

    const stats = await fs.stat(target);
    expect(stats.isDirectory()).toBe(true);
  });

  it('allows placeholder files in an otherwise empty directory', async () => {
    const target = await createTempDir();
    await fs.writeFile(path.join(target, '.gitkeep'), '', 'utf8');

    await expect(prepareExportOutputDir(target)).resolves.toBeUndefined();
  });

  it('rejects directories with real content', async () => {
    const target = await createTempDir();
    await fs.writeFile(path.join(target, 'notes.txt'), 'keep out', 'utf8');

    await expect(prepareExportOutputDir(target)).rejects.toThrow(/Output directory is not empty/);
  });
});
