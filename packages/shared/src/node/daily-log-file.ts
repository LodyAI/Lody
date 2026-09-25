import fs from 'node:fs';
import path from 'node:path';

/**
 * The CLI's daily log (`<data dir>/logs/<YYYY-MM-DD>.log`) is written by
 * winston-daily-rotate-file inside the CLI. Other processes that must leave
 * evidence in the same file (Electron main, the CLI's stall watchdog thread,
 * synchronous crash/exit beacons) append to it directly through this module,
 * so one file tells the whole story of a machine's day.
 *
 * Naming contract, owned by winston-daily-rotate-file: `%DATE%` is the LOCAL
 * date, the day's first file is `<date>.log`, and every size rotation opens
 * `<date>.log.<n>` while gzipping the file it leaves.
 */

export type DailyLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Local-time `YYYY-MM-DD`, the `%DATE%` winston-daily-rotate-file uses by default.
 * Self-contained, like `pickDailyLogAppendName` and `formatDailyLogLine`: the
 * CLI's stall watchdog inlines these three functions' source into its worker.
 */
export function formatLocalLogDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Picks the file an external writer should append to: the day's live
 * (uncompressed, highest-rotation) file, so appended lines interleave with the
 * CLI's own, or `<date>.log` when the CLI has not written today.
 */
export function pickDailyLogAppendName(names: readonly string[], date: string): string {
  const base = `${date}.log`;
  let bestIndex = -1;
  for (const name of names) {
    if (name === base) {
      bestIndex = Math.max(bestIndex, 0);
      continue;
    }
    if (!name.startsWith(`${base}.`)) continue;
    const suffix = name.slice(base.length + 1);
    if (!/^\d+$/.test(suffix)) continue;
    bestIndex = Math.max(bestIndex, Number(suffix));
  }
  return bestIndex > 0 ? `${base}.${bestIndex}` : base;
}

export function resolveDailyLogAppendPath(logDir: string, now: Date = new Date()): string {
  let names: string[] = [];
  try {
    names = fs.readdirSync(logDir);
  } catch {
    // Missing directory: the first append creates it.
  }
  return path.join(logDir, pickDailyLogAppendName(names, formatLocalLogDate(now)));
}

/** One line in the CLI file format: `<ISO time> [LEVEL] [scope] message`. */
export function formatDailyLogLine(options: {
  time: Date;
  level: DailyLogLevel;
  scope: string;
  message: string;
}): string {
  const maxChars = 16_000;
  const message =
    options.message.length > maxChars
      ? `${options.message.slice(0, maxChars)}…[truncated ${options.message.length - maxChars} chars]`
      : options.message;
  return `${options.time.toISOString()} [${options.level}] [${options.scope}] ${message}\n`;
}

/**
 * Synchronous append for paths that may not get another event-loop turn:
 * crash handlers, `process.on('exit')`, and a watchdog thread reporting on a
 * blocked main thread. Never throws; logging must not change control flow.
 */
export function appendDailyLogSync(logDir: string, text: string, now: Date = new Date()): boolean {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(resolveDailyLogAppendPath(logDir, now), text, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export async function appendDailyLog(
  logDir: string,
  text: string,
  now: Date = new Date()
): Promise<boolean> {
  try {
    await fs.promises.mkdir(logDir, { recursive: true });
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(logDir);
    } catch {
      // Created above; a concurrent retention sweep may still race us.
    }
    const target = path.join(logDir, pickDailyLogAppendName(names, formatLocalLogDate(now)));
    await fs.promises.appendFile(target, text, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
