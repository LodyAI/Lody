import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(zlib.gunzip);

/**
 * winston-daily-rotate-file names the day's first file `<date>.log` and appends a
 * size-rotation counter to every file it opens after that (`<date>.log.1`,
 * `<date>.log.2`, …). Because the file transport also sets `zippedArchive`, the
 * file it rolls away from is gzipped in place, so `<date>.log` stops existing as
 * soon as the day's first `maxSize` roll happens.
 *
 * Every reader of the log directory must go through this module. Matching on
 * `.log` alone silently finds nothing on any machine that logs more than
 * `maxSize` in a day.
 */
const DAILY_LOG_FILE_PATTERN = /^(.*)\.log(?:\.(\d+))?(\.gz)?$/i;

export type DailyLogFileName = {
  /** The `%DATE%` portion of the name, e.g. `2026-08-07`. */
  date: string;
  /** Size-rotation counter; `0` for the day's first file, which carries no counter. */
  index: number;
  compressed: boolean;
};

export type DailyLogFile = DailyLogFileName & {
  path: string;
  name: string;
  mtimeMs: number;
};

export function parseDailyLogFileName(name: string): DailyLogFileName | null {
  const match = DAILY_LOG_FILE_PATTERN.exec(name);
  if (!match) return null;
  return {
    date: match[1] ?? '',
    index: match[2] === undefined ? 0 : Number(match[2]),
    compressed: match[3] !== undefined,
  };
}

/**
 * Lists the daily log files in `logDir`, newest first. Non-log entries and
 * subdirectories (ACP `.jsonl` capture) are ignored.
 */
export function listDailyLogFiles(logDir: string): DailyLogFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: DailyLogFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseDailyLogFileName(entry.name);
    if (!parsed) continue;
    const filePath = path.join(logDir, entry.name);
    try {
      files.push({
        ...parsed,
        path: filePath,
        name: entry.name,
        mtimeMs: fs.statSync(filePath).mtimeMs,
      });
    } catch {
      // The file disappeared between readdir and stat (rotation, retention).
    }
  }

  // Date then rotation counter is the authoritative order; mtime is only a tie
  // breaker. Sorting by mtime alone inverts the newest pair, because archiving
  // `<date>.log` to `<date>.log.gz` rewrites it at the same moment the live
  // `<date>.log.1` is opened.
  files.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      b.index - a.index ||
      Number(a.compressed) - Number(b.compressed) ||
      b.mtimeMs - a.mtimeMs
  );
  return files;
}

/** Reads one daily log file, decompressing archived rotations. */
export async function readDailyLogFile(file: DailyLogFile): Promise<string> {
  const raw = await fsPromises.readFile(file.path);
  if (!file.compressed) return raw.toString('utf8');
  return (await gunzip(raw)).toString('utf8');
}

export type LatestLogTail = {
  /** Names of the files the tail was read from, oldest first. */
  files: string[];
  text: string;
};

/**
 * Reads the last `lineCount` lines of the log directory, walking back through
 * size rotations when the live file is too short to satisfy the request. Older
 * rotations are best-effort: only the newest file has to be readable.
 *
 * Returns `null` when the directory holds no log files at all.
 */
export async function readLatestLogTail(
  logDir: string,
  lineCount: number,
  maxFiles = 5
): Promise<LatestLogTail | null> {
  const candidates = listDailyLogFiles(logDir).slice(0, maxFiles);
  if (candidates.length === 0) return null;

  const files: string[] = [];
  let lines: string[] = [];
  for (const [position, file] of candidates.entries()) {
    let content: string;
    try {
      content = await readDailyLogFile(file);
    } catch (error) {
      // The live file is what the caller asked for; failing to read it is a
      // real error. A corrupt archive further back only ends the walk.
      if (position === 0) throw error;
      break;
    }
    const fileLines = content.split('\n');
    // Drop the separator-only trailing element so concatenating rotations does
    // not insert a blank line at every file boundary.
    if (fileLines[fileLines.length - 1] === '') fileLines.pop();
    files.unshift(file.name);
    lines = fileLines.concat(lines);
    if (lines.length >= lineCount) break;
  }

  return { files, text: lines.slice(-lineCount).join('\n') };
}
