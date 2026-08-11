import fs from 'node:fs';
import path from 'node:path';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { parseDailyLogFileName } from './log-files';

export const LODY_LOG_DIR = path.join(getLodyDataDir(), 'logs');
export const LODY_LOG_RETENTION_DAYS = 7;
export const LODY_LOG_RETENTION_MS = LODY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const LODY_LOG_RETENTION_MAX_FILES = `${LODY_LOG_RETENTION_DAYS}d`;

const MANAGED_JSONL_FILE_PATTERN = /\.jsonl(?:\.gz)?$/i;

// Daily-log naming lives in `log-files.ts` so retention and the log readers
// cannot drift apart on what a rotated file is called.
const isManagedLogFile = (name: string): boolean =>
  parseDailyLogFileName(name) !== null || MANAGED_JSONL_FILE_PATTERN.test(name);

function removeEmptyDirectories(dirPath: string, preserveRoot: boolean): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childPath = path.join(dirPath, entry.name);
    removeEmptyDirectories(childPath, false);
  }

  if (preserveRoot) {
    return;
  }

  if (fs.readdirSync(dirPath).length === 0) {
    fs.rmdirSync(dirPath);
  }
}

export function cleanupExpiredLogs(
  logDir: string = LODY_LOG_DIR,
  options: {
    now?: number;
    maxAgeMs?: number;
  } = {}
): number {
  if (!fs.existsSync(logDir)) {
    return 0;
  }

  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? LODY_LOG_RETENTION_MS;
  const cutoff = now - maxAgeMs;
  let removed = 0;

  const walk = (dirPath: string): void => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (!entry.isFile() || !isManagedLogFile(entry.name)) {
        continue;
      }

      const stat = fs.statSync(entryPath);
      if (stat.mtimeMs > cutoff) {
        continue;
      }

      fs.unlinkSync(entryPath);
      removed += 1;
    }
  };

  walk(logDir);
  removeEmptyDirectories(logDir, true);
  return removed;
}
