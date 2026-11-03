import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { readLatestLogTail } from './log-files';

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

  it('stops the walk at an unreadable archive instead of failing', async () => {
    const dir = createTempLogDir();
    fs.writeFileSync(path.join(dir, '2026-08-07.log.gz'), 'not actually gzip');
    writeLog(dir, '2026-08-07.log.1', 'live\n');

    await expect(readLatestLogTail(dir, 10)).resolves.toEqual({
      files: ['2026-08-07.log.1'],
      text: 'live',
    });
  });
});
