import fs from 'node:fs/promises';
import type { z } from 'zod';
import type { MachineDiskInfoSchema } from '@lody/shared';

type MachineDiskInfo = z.infer<typeof MachineDiskInfoSchema>;
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

const GB = 1024 ** 3;
const round = (value: number) => Math.round(value * 10) / 10;

export async function readVolumeFreeBytes(directory: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(directory);
    const free = stats.bavail * stats.bsize;
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/** Volume usage for the Lody data directory, or undefined when it cannot be read. */
export async function readLodyDataDiskInfo(
  directory: string = getLodyDataDir()
): Promise<MachineDiskInfo | undefined> {
  try {
    const stats = await fs.statfs(directory);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) return undefined;
    return {
      totalGB: round(total / GB),
      freeGB: round(free / GB),
      usedPercent: Math.min(100, Math.max(0, round(((total - free) / total) * 100))),
    };
  } catch {
    return undefined;
  }
}
