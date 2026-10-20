import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { makeProcessRunnerLegacy, runCommandTextSyncLegacy } from '@lody/shared/node/process';
import { toShared } from '@/platform/process-options';
import {
  createSqliteLockReporter,
  formatSqliteOpeners,
  mentionsSqliteBusy,
  parseLsofOpeners,
  probeSqliteOpeners,
  type SqliteOpenersProbe,
} from './sqlite-lock-diagnostics';

const dbPath = '/data/loro-repo/ws-1/repo.sqlite3';

const hasLsof = (() => {
  try {
    runCommandTextSyncLegacy(
      { command: 'lsof', args: ['-v'], timeout: '5 seconds', check: 'none' },
      toShared()
    );
    return true;
  } catch {
    return false;
  }
})();

describe('sqlite lock diagnostics', () => {
  it('collects each process once from lsof field output', () => {
    const output = [
      'p501',
      'R1',
      'cLody Helper',
      'f12',
      'f13',
      'p77',
      'R501',
      'cnode',
      'f9',
      'p501',
      'f14',
      '',
    ].join('\n');

    expect(parseLsofOpeners(output)).toEqual([
      { pid: 77, ppid: 501, command: 'node' },
      { pid: 501, ppid: 1, command: 'Lody Helper' },
    ]);
  });

  it('names the other openers and leaves this process out', () => {
    const probe: SqliteOpenersProbe = {
      kind: 'ok',
      openers: [
        { pid: 77, ppid: 501, command: 'node' },
        { pid: 501, ppid: 1, command: 'Lody Helper' },
      ],
    };

    expect(formatSqliteOpeners(dbPath, probe, 501, 'loro-repo')).toBe(
      '[sqlite-lock] repo.sqlite3 busy (workspace=ws-1, source=loro-repo); other processes with it open: pid=77 ppid=501 command="node"'
    );
    expect(
      formatSqliteOpeners(
        dbPath,
        { kind: 'ok', openers: [{ pid: 501, command: 'x' }] },
        501,
        'loro-repo'
      )
    ).toBe(
      '[sqlite-lock] repo.sqlite3 busy (workspace=ws-1, source=loro-repo); no other process has it open'
    );
    expect(
      formatSqliteOpeners(
        dbPath,
        { kind: 'unavailable', reason: 'SpawnFailed' },
        501,
        'streams-crdt'
      )
    ).toBe(
      '[sqlite-lock] repo.sqlite3 busy (workspace=ws-1, source=streams-crdt); openers unknown: lsof SpawnFailed'
    );
  });

  it('recognizes the lock-contention reports loro-repo and streams-crdt print', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(
      mentionsSqliteBusy(['[loro-repo] doc dirty flush failed: database is locked', busy])
    ).toBe(true);
    expect(
      mentionsSqliteBusy([
        '[streams-crdt] sse flush chain error',
        { streamUrl: 'u', error: 'database is locked' },
      ])
    ).toBe(true);
    expect(mentionsSqliteBusy(['[streams-crdt] live read failed', { code: 'network' }])).toBe(
      false
    );
  });

  it('probes every tracked database once per window and logs one line each', async () => {
    let now = 1_000;
    const lines: string[] = [];
    const probed: string[] = [];
    const reporter = createSqliteLockReporter({
      probe: async (target) => {
        probed.push(target);
        return { kind: 'ok', openers: [{ pid: 9, command: 'lody' }] };
      },
      log: (line) => lines.push(line),
      now: () => now,
      selfPid: 1,
      minIntervalMs: 60_000,
    });

    expect(reporter.reportBusy('loro-repo')).toBeUndefined();
    reporter.register(dbPath);
    const removeSecond = reporter.register('/data/loro-repo/ws-2/repo.sqlite3');

    await reporter.reportBusy('loro-repo');
    expect(lines).toEqual([
      '[sqlite-lock] repo.sqlite3 busy (workspace=ws-1, source=loro-repo); other processes with it open: pid=9 command="lody"',
      '[sqlite-lock] repo.sqlite3 busy (workspace=ws-2, source=loro-repo); other processes with it open: pid=9 command="lody"',
    ]);

    // A burst of failures inside the window starts no new probe.
    now += 59_999;
    expect(reporter.reportBusy('streams-crdt')).toBeUndefined();

    removeSecond();
    now += 1;
    await reporter.reportBusy('streams-crdt');
    expect(lines).toHaveLength(3);
    expect(probed.at(-1)).toBe(dbPath);
  });

  it('starts no second probe while one is still running', async () => {
    let release!: () => void;
    const pending = new Promise<SqliteOpenersProbe>((resolve) => {
      release = () => resolve({ kind: 'ok', openers: [] });
    });
    const lines: string[] = [];
    const reporter = createSqliteLockReporter({
      probe: () => pending,
      log: (line) => lines.push(line),
      now: () => 0,
      selfPid: 1,
      minIntervalMs: 0,
    });
    reporter.register(dbPath);

    const first = reporter.reportBusy('loro-repo');
    expect(reporter.reportBusy('loro-repo')).toBeUndefined();
    release();
    await first;
    expect(lines).toHaveLength(1);
  });

  it.skipIf(!hasLsof)('lists this process as an opener of a real database', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lody-sqlite-lock-'));
    const file = path.join(dir, 'repo.sqlite3');
    const db = new Database(file);
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE t (x)');
      const probe = await makeProcessRunnerLegacy(toShared())(probeSqliteOpeners(file));
      expect(probe.kind).toBe('ok');
      if (probe.kind === 'ok') {
        expect(probe.openers.map((opener) => opener.pid)).toContain(process.pid);
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
