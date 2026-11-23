import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineDiskInfoSchema } from '@lody/shared';
import { readLodyDataDiskInfo } from './machine-disk';

describe('readLodyDataDiskInfo', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports the volume holding the data directory in the response schema', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-machine-disk-'));
    roots.push(root);
    const disk = await readLodyDataDiskInfo(root);
    expect(MachineDiskInfoSchema.parse(disk)).toEqual(disk);
    expect(disk!.freeGB).toBeLessThanOrEqual(disk!.totalGB);
  });

  it('omits disk instead of failing when the directory cannot be read', async () => {
    await expect(
      readLodyDataDiskInfo(path.join(os.tmpdir(), 'lody-machine-disk-missing', 'nested'))
    ).resolves.toBeUndefined();
  });
});
