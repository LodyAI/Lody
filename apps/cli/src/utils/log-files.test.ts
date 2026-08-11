import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listDailyLogFiles,
  parseDailyLogFileName,
  readDailyLogFile,
  readLatestLogTail,
} from './log-files';

const tempDirs: string[] = [];

function createTempLogDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-log-files-'));
  tempDirs.push(dir);
  return dir;
}

function writeLog(dir: string, name: string, content: string, mtimeMs?: number): void {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, name.endsWith('.gz') ? zlib.gzipSync(content) : content);
  if (mtimeMs !== undefined) {
    const mtime = new Date(mtimeMs);
    fs.utimesSync(filePath, mtime, mtime);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseDailyLogFileName', () => {
  it("parses the day's first file as rotation zero", () => {
    expect(parseDailyLogFileName('2026-08-07.log')).toEqual({
      date: '2026-08-07',
      index: 0,
      compressed: false,
    });
  });

  it('parses size-rotation counters and gzip archives', () => {
    expect(parseDailyLogFileName('2026-08-07.log.1')).toEqual({
      date: '2026-08-07',
      index: 1,
      compressed: false,
    });
    expect(parseDailyLogFileName('2026-08-07.log.gz')).toEqual({
      date: '2026-08-07',
      index: 0,
      compressed: true,
    });
    expect(parseDailyLogFileName('2026-07-31.log.26.gz')).toEqual({
      date: '2026-07-31',
      index: 26,
      compressed: true,
    });
  });

  it('rejects entries that are not daily logs', () => {
    expect(parseDailyLogFileName('.b7e1328-audit.json')).toBeNull();
    expect(parseDailyLogFileName('notes.txt')).toBeNull();
    expect(parseDailyLogFileName('session.jsonl')).toBeNull();
  });
});

describe('listDailyLogFiles', () => {
  it('orders by day and rotation counter rather than mtime', () => {
    const dir = createTempLogDir();
    // Archiving `<date>.log` rewrites it as `.gz` at the same moment the live
    // `.log.1` is opened, so mtime alone can rank the archive above the file
    // that is still being written.
    writeLog(dir, '2026-08-06.log.gz', 'yesterday', 1_000);
    writeLog(dir, '2026-08-07.log.gz', 'earlier today', 9_000);
    writeLog(dir, '2026-08-07.log.1', 'live', 2_000);

    expect(listDailyLogFiles(dir).map((file) => file.name)).toEqual([
      '2026-08-07.log.1',
      '2026-08-07.log.gz',
      '2026-08-06.log.gz',
    ]);
  });

  it('returns an empty list for a missing directory', () => {
    expect(listDailyLogFiles(path.join(createTempLogDir(), 'absent'))).toEqual([]);
  });
});

describe('readDailyLogFile', () => {
  it('decompresses archived rotations', async () => {
    const dir = createTempLogDir();
    writeLog(dir, '2026-08-07.log.gz', 'archived line\n');
    const [file] = listDailyLogFiles(dir);
    expect(file).toBeDefined();
    await expect(readDailyLogFile(file!)).resolves.toBe('archived line\n');
  });
});

describe('readLatestLogTail', () => {
  it('reads the live rotation once the day has rolled past `<date>.log`', async () => {
    const dir = createTempLogDir();
    // The regression: after the first size roll no file is named `<date>.log`,
    // and matching on that suffix alone reports an empty log directory.
    writeLog(dir, '2026-08-07.log.gz', 'a\nb\n');
    writeLog(dir, '2026-08-07.log.1', 'c\nd\n');

    const tail = await readLatestLogTail(dir, 2);

    expect(tail).toEqual({ files: ['2026-08-07.log.1'], text: 'c\nd' });
  });

  it('walks back through rotations when the live file is shorter than requested', async () => {
    const dir = createTempLogDir();
    writeLog(dir, '2026-08-06.log', 'old\n');
    writeLog(dir, '2026-08-07.log.gz', 'a\nb\n');
    writeLog(dir, '2026-08-07.log.1', 'c\n');

    const tail = await readLatestLogTail(dir, 3);

    expect(tail).toEqual({ files: ['2026-08-07.log.gz', '2026-08-07.log.1'], text: 'a\nb\nc' });
  });

  it('does not insert blank lines at rotation boundaries', async () => {
    const dir = createTempLogDir();
    writeLog(dir, '2026-08-07.log.gz', 'a\n');
    writeLog(dir, '2026-08-07.log.1', 'b\n');

    await expect(readLatestLogTail(dir, 10)).resolves.toMatchObject({ text: 'a\nb' });
  });

  it('stops the walk at an unreadable archive instead of failing', async () => {
    const dir = createTempLogDir();
    fs.writeFileSync(path.join(dir, '2026-08-07.log.gz'), 'not actually gzip');
    writeLog(dir, '2026-08-07.log.1', 'live\n');

    await expect(readLatestLogTail(dir, 10)).resolves.toEqual({
      files: ['2026-08-07.log.1'],
      text: 'live',
    });
  });

  it('surfaces a failure to read the live file', async () => {
    const dir = createTempLogDir();
    fs.writeFileSync(path.join(dir, '2026-08-07.log.1'), 'not actually gzip.gz');
    fs.renameSync(path.join(dir, '2026-08-07.log.1'), path.join(dir, '2026-08-07.log.1.gz'));

    await expect(readLatestLogTail(dir, 10)).rejects.toThrow();
  });

  it('returns null when the directory holds no log files', async () => {
    const dir = createTempLogDir();
    fs.writeFileSync(path.join(dir, '.audit.json'), '{}');

    await expect(readLatestLogTail(dir, 10)).resolves.toBeNull();
  });
});
