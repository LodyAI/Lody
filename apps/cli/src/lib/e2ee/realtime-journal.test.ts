import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { startProcessLegacy } from '@lody/shared/node/process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RealtimeJournal,
  RealtimeJournalError,
  type RealtimeJournalRequest,
  type RealtimeStartPermit,
} from './realtime-journal';

const request: RealtimeJournalRequest = {
  genesis: 'synthetic-genesis',
  workspaceId: 'synthetic-workspace',
  targetMachineId: 'synthetic-machine',
  requestId: 'synthetic-fixed-id',
  requester: 'synthetic-device',
  expiresAt: 1_000,
  frame: Uint8Array.from([0, 255, 1, 0, 9]),
};
const outcome = Uint8Array.from([7, 0, 255]);
const responseFrame = Uint8Array.from([255, 0, 4, 0, 252]);
const snapshotDatabase = (filename: string) => {
  const db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    const tables = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'
      ORDER BY name`)
      .all() as Array<{ name: string; sql: string }>;
    return {
      version: db.pragma('user_version', { simple: true }),
      mode: db.pragma('journal_mode', { simple: true }),
      tables: tables.map((table) => ({
        ...table,
        // Exact-byte evidence compared by digest: deep-equal over multi-MiB blobs takes seconds.
        rows: (
          db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all() as Array<
            Record<string, unknown>
          >
        ).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              Buffer.isBuffer(value)
                ? `sha256:${createHash('sha256').update(value).digest('hex')}:${value.byteLength}`
                : value,
            ])
          )
        ),
      })),
    };
  } finally {
    db.close();
  }
};
const snapshotFiles = (directory: string) =>
  Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => {
        const filename = path.join(directory, name);
        return [name, { bytes: readFileSync(filename), mode: statSync(filename).mode }];
      })
  );
const holdReader = (filename: string) => {
  const reader = new Database(filename, { timeout: 0 });
  const rows = reader.prepare('SELECT frame FROM realtime_requests').iterate();
  const release = () => {
    rows.return?.();
    reader.close();
  };
  try {
    expect(rows.next().done).toBe(false);
    return release;
  } catch (error) {
    release();
    throw error;
  }
};
const takePermit = (journal: RealtimeJournal, input = request): RealtimeStartPermit => {
  const claim = journal.claim(input);
  if (claim.state !== 'claimed') throw new Error(`Expected claim, got ${claim.state}`);
  return claim.permit;
};
const expectCode = (run: () => unknown, code: RealtimeJournalError['code']) => {
  try {
    run();
    throw new Error('Expected journal failure');
  } catch (error) {
    expect(error).toBeInstanceOf(RealtimeJournalError);
    expect((error as RealtimeJournalError).code).toBe(code);
    return error as RealtimeJournalError;
  }
};

// The child stops only after native SQLite has applied the large UPDATE inside
// its transaction. A two-page cache forces a real rollback-journal spill; IPC
// confirms that boundary before SIGKILL, without a race against COMMIT.
const crashBeforeCommit = async (
  filename: string,
  input: RealtimeJournalRequest,
  version: 2 | 1 | 99,
  mode: 'rollback' | 'committed-wal' = 'rollback'
) => {
  const script = `
    const { createRequire } = require('node:module');
    const req = createRequire(process.argv[1]);
    req('tsx/cjs');
    const Database = req('better-sqlite3');
    const { RealtimeJournal } = req(process.argv[2]);
    const input = JSON.parse(process.argv[4]);
    input.frame = Uint8Array.from(input.frame);
    const version = Number(process.argv[5]);
    const payload = Buffer.alloc(4 * 1024 * 1024, 7);
    const pause = () => {
      process.send('native-update-complete');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw new Error('Crash fixture unexpectedly resumed');
    };
    try {
      if (process.argv[6] === 'committed-wal') {
        const db = new Database(process.argv[3], { fileMustExist: true, timeout: 0 });
        db.pragma('journal_mode = WAL');
        db.pragma('wal_autocheckpoint = 0');
        db.exec('CREATE TABLE unsupported_evidence (payload BLOB NOT NULL)');
        db.prepare('INSERT INTO unsupported_evidence VALUES (?)').run(payload);
        pause();
      } else if (version === 2) {
        const nativePragma = Database.prototype.pragma;
        Database.prototype.pragma = function(sql, ...args) {
          const result = nativePragma.call(this, sql, ...args);
          if (sql === 'synchronous = FULL') nativePragma.call(this, 'cache_size = 2');
          return result;
        };
        const nativePrepare = Database.prototype.prepare;
        Database.prototype.prepare = function(sql) {
          const statement = nativePrepare.call(this, sql);
          if (sql.includes("UPDATE realtime_requests SET state = 'completed'")) {
            const nativeRun = statement.run;
            statement.run = function(...args) {
              nativeRun.apply(this, args);
              pause();
            };
          }
          return statement;
        };
        const journal = new RealtimeJournal(process.argv[3], () => 100);
        const claim = journal.claim(input);
        if (claim.state !== 'claimed') throw new Error('Fixture did not obtain its own permit');
        journal.finish(claim.permit, payload);
      } else {
        // Unsupported stores cannot enter product APIs. A native transaction
        // leaves their already-committed version and original records hot.
        const db = new Database(process.argv[3], { fileMustExist: true, timeout: 0 });
        db.pragma('synchronous = FULL');
        db.pragma('cache_size = 2');
        db.exec('BEGIN IMMEDIATE');
        db.prepare("UPDATE realtime_requests SET state = 'completed', outcome = ?, outcome_digest = ? WHERE request_id = ?")
          .run(payload, req('node:crypto').createHash('sha256').update(payload).digest('hex'), input.requestId);
        pause();
      }
    } catch (error) {
      process.send({ failure: String(error.stack ?? error) });
      process.exitCode = 1;
    }
  `;
  let resolvePhase!: () => void;
  let rejectPhase!: (cause: unknown) => void;
  const phase = new Promise<void>((resolve, reject) => {
    resolvePhase = resolve;
    rejectPhase = reject;
  });
  const deadline = AbortSignal.timeout(10_000);
  const abort = () => rejectPhase(new Error('Crash fixture did not reach its native UPDATE'));
  deadline.addEventListener('abort', abort, { once: true });
  const child = startProcessLegacy({
    command: process.execPath,
    args: [
      '-e',
      script,
      fileURLToPath(new URL('../../../package.json', import.meta.url)),
      fileURLToPath(new URL('./realtime-journal.ts', import.meta.url)),
      filename,
      JSON.stringify({ ...input, frame: [...input.frame] }),
      String(version),
      mode,
    ],
    options: { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    processGroup: true,
    onSpawned: (process) => {
      let stderr = '';
      process.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8_192);
      });
      process.once('error', rejectPhase);
      process.once('exit', (code, signal) =>
        rejectPhase(new Error(`Crash fixture exited before UPDATE: ${code}/${signal}: ${stderr}`))
      );
      process.on('message', (message: unknown) => {
        if (message === 'native-update-complete') resolvePhase();
        else rejectPhase(new Error(`Crash fixture failure: ${JSON.stringify(message)}`));
      });
    },
  });
  let committedWal: ReturnType<typeof snapshotDatabase> | undefined;
  try {
    await phase;
    if (mode === 'committed-wal') committedWal = snapshotDatabase(filename);
  } finally {
    deadline.removeEventListener('abort', abort);
    // Also reap the owned child if setup/UPDATE fails. No fixture may outlive
    // the test or continue writing after a failed assertion.
    await child.terminate({ graceMs: 0, killWaitMs: 5_000 });
  }
  const exit = await child.exited;
  if (process.platform === 'win32') expect(exit.code).not.toBeNull();
  else expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
  if (mode === 'committed-wal') {
    expect(readFileSync(`${filename}-wal`).byteLength).toBeGreaterThan(32);
  } else {
    const journalBytes = readFileSync(`${filename}-journal`);
    expect(journalBytes.subarray(0, 8)).toEqual(
      Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7])
    );
  }
  return committedWal;
};

describe('host-only E2EE realtime journal', () => {
  let directory: string;
  let filename: string;
  let now: number;
  let journal: RealtimeJournal;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'lody-realtime-journal-'));
    filename = path.join(directory, 'journal.sqlite');
    now = 100;
    journal = RealtimeJournal.create(filename, () => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    journal.retryCleanup();
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists exact frame and completed outcome across independent opens and expired deadlines', () => {
    journal.receive(request);
    const reopened = new RealtimeJournal(filename, () => now);
    expect(reopened.read(request)).toMatchObject({ ...request, state: 'received' });
    const permit = takePermit(reopened);
    const completed = reopened.finish(permit, outcome);
    expect(completed).toMatchObject({ state: 'completed', frame: request.frame, outcome });
    now = 10_000;
    const again = new RealtimeJournal(filename, () => now);
    expect(again.read(request)).toEqual(completed);
    expect(again.receive(request)).toEqual(completed);
    expect(again.claim(request)).toEqual({ state: 'existing', record: completed });
  });

  it.each([
    { requester: 'other-device' },
    { expiresAt: 1_001 },
    { frame: Uint8Array.from([0, 255, 1, 0, 8]) },
  ])('rejects same ID with changed immutable input: %j', (change) => {
    const original = journal.receive(request);
    expectCode(() => journal.receive({ ...request, ...change }), 'identity_conflict');
    expectCode(() => journal.claim({ ...request, ...change }), 'identity_conflict');
    expect(journal.read(request)).toEqual(original);
  });

  it('isolates workspaces, genesis, target machines and request IDs', () => {
    const variants = [
      request,
      { ...request, workspaceId: 'workspace-2' },
      { ...request, genesis: 'genesis-2' },
      { ...request, targetMachineId: 'machine-2' },
      { ...request, requestId: 'request-2' },
    ];
    for (const input of variants) journal.receive(input);
    for (const input of variants) {
      const permit = takePermit(journal, input);
      expect(journal.finish(permit, outcome)).toMatchObject({ ...input, state: 'completed' });
    }
  });

  it('copies caller and returned byte arrays, including the identity retained by a permit', () => {
    const frame = Uint8Array.from(request.frame);
    const input = { ...request, frame };
    const received = journal.receive(input);
    const permit = takePermit(journal, input);
    frame.fill(42);
    received.frame.fill(43);
    const result = Uint8Array.from(outcome);
    const completed = journal.finish(permit, result);
    result.fill(44);
    if (completed.state === 'completed') completed.outcome.fill(45);
    expect(journal.read(request)).toMatchObject({ frame: request.frame, outcome });
  });

  it('freezes the original before an injected clock can mutate its caller-owned frame', () => {
    const frame = Uint8Array.from(request.frame);
    const input = { ...request, frame };
    journal.receive(input);
    const mutatingClock = new RealtimeJournal(filename, () => {
      frame.fill(99);
      return 100;
    });
    const permit = takePermit(mutatingClock, input);
    expect(mutatingClock.finish(permit, outcome)).toMatchObject({
      state: 'completed',
      frame: request.frame,
      outcome,
    });
  });

  it('never reclaims a started operation after side effects, expiry, or reopen', () => {
    journal.receive(request);
    takePermit(journal);
    let sideEffects = 1; // The original claimant performed a business side effect, then crashed.
    now = 10_000;
    const restarted = new RealtimeJournal(filename, () => now);
    const result = restarted.claim(request);
    if (result.state === 'claimed') sideEffects++;
    expect(result).toMatchObject({ state: 'existing', record: { state: 'uncertain' } });
    expect(sideEffects).toBe(1);
    expectCode(() => restarted.finish({} as RealtimeStartPermit, outcome), 'permit');
  });

  it('only permits the original journal owner to finish and refuses result replacement', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const other = new RealtimeJournal(filename, () => now);
    expect(other.claim(request)).toMatchObject({ state: 'existing' });
    expectCode(() => other.finish(permit, outcome), 'permit');
    const saved = journal.finish(permit, outcome);
    expect(journal.finish(permit, Uint8Array.from(outcome))).toEqual(saved);
    expectCode(() => journal.finish(permit, Uint8Array.of(8)), 'outcome_conflict');
    expect(other.read(request)).toEqual(saved);
  });

  it('retains expired evidence and persists observed deadline time across clock rollback/reopen', () => {
    journal.receive(request);
    now = request.expiresAt;
    expect(journal.claim(request)).toMatchObject({ state: 'expired' });
    now = 0;
    const restarted = new RealtimeJournal(filename, () => now);
    expect(restarted.claim(request)).toMatchObject({ state: 'expired' });
    expect(restarted.read(request)).toMatchObject({ state: 'received', frame: request.frame });
    const next = { ...request, requestId: 'new-intent', expiresAt: 2_000 };
    restarted.receive(next);
    expect(restarted.claim(next)).toMatchObject({ state: 'claimed' });
  });

  it('fails closed on SQLite lock contention and recovers the next normal call', () => {
    journal.receive(request);
    const blocker = new Database(filename);
    try {
      blocker.exec('BEGIN IMMEDIATE');
      const failure = expectCode(() => journal.claim(request), 'storage');
      expect(failure.cause).toMatchObject({ code: 'SQLITE_BUSY' });
      blocker.exec('ROLLBACK');
      expect(journal.read(request)).toMatchObject({ state: 'received' });
      takePermit(journal);
    } finally {
      blocker.close();
    }
  });

  it('rolls back a start whose commit is blocked by a live reader and recovers after reader release', () => {
    journal.receive(request);
    const reader = new Database(filename, { timeout: 0 });
    const rows = reader.prepare('SELECT frame FROM realtime_requests').iterate();
    try {
      expect(rows.next().done).toBe(false); // Keep this real SQLite statement's shared lock.
      const failure = expectCode(() => journal.claim(request), 'storage');
      expect(failure.cause).toMatchObject({ code: 'SQLITE_BUSY' });
      expect(journal.read(request)).toMatchObject({ state: 'received' });
      rows.return?.();
      takePermit(journal);
      expect(new RealtimeJournal(filename, () => now).claim(request)).toMatchObject({
        state: 'existing',
        record: { state: 'uncertain' },
      });
    } finally {
      rows.return?.();
      reader.close();
    }
  });

  it('does not create missing journals, reprovision existing evidence, or interpret corruption as empty', () => {
    journal.receive(request);
    expectCode(() => RealtimeJournal.create(filename, () => now), 'storage');
    const savedPath = path.join(directory, 'original.sqlite');
    renameSync(filename, savedPath);
    expectCode(() => journal.claim(request), 'storage');
    expectCode(() => new RealtimeJournal(filename, () => now).receive(request), 'storage');
    renameSync(savedPath, filename);
    const bytes = readFileSync(filename);
    writeFileSync(filename, 'synthetic-corrupt-journal');
    expectCode(() => journal.read(request), 'storage');
    writeFileSync(filename, bytes);
    expect(journal.read(request)).toMatchObject({ state: 'received' });
    takePermit(journal);
  });

  it('rolls back a failed claim before permitting any side effect and later recovers', () => {
    journal.receive(request);
    const db = new Database(filename);
    try {
      db.exec(`CREATE TRIGGER refuse_start AFTER UPDATE ON realtime_requests
        WHEN NEW.state = 'started' BEGIN SELECT RAISE(ABORT, 'synthetic start I/O failure'); END;`);
      expectCode(() => journal.claim(request), 'storage');
      expect(journal.read(request)).toMatchObject({ state: 'received' });
      db.exec('DROP TRIGGER refuse_start');
      expect(journal.claim(request)).toMatchObject({ state: 'claimed' });
    } finally {
      db.close();
    }
  });

  it('does not admit a frame whose durable reception fails and preserves unrelated results', () => {
    journal.receive(request);
    const completed = journal.finish(takePermit(journal), outcome);
    const next = { ...request, requestId: 'next' };
    const db = new Database(filename);
    try {
      db.exec(`CREATE TRIGGER refuse_receive BEFORE INSERT ON realtime_requests
        BEGIN SELECT RAISE(ABORT, 'synthetic receive I/O failure'); END;`);
      expectCode(() => journal.receive(next), 'storage');
      expect(journal.read(next)).toBeNull();
      expectCode(() => journal.claim(next), 'missing');
      expect(journal.read(request)).toEqual(completed);
      db.exec('DROP TRIGGER refuse_receive');
      journal.receive(next);
      expect(journal.claim(next)).toMatchObject({ state: 'claimed' });
    } finally {
      db.close();
    }
  });

  it('keeps an uncertain started row when result persistence fails, then retries only settlement', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const db = new Database(filename);
    try {
      db.exec(`CREATE TRIGGER refuse_result AFTER UPDATE ON realtime_requests
        WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'synthetic result I/O failure'); END;`);
      const firstOutcome = Uint8Array.from(outcome);
      const failure = expectCode(() => journal.finish(permit, firstOutcome), 'storage');
      firstOutcome.fill(9);
      expect(failure.cause).toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
      expect(new RealtimeJournal(filename, () => now).claim(request)).toMatchObject({
        state: 'existing',
        record: { state: 'uncertain' },
      });
      db.exec('DROP TRIGGER refuse_result');
      expectCode(() => journal.finish(permit, Uint8Array.of(8)), 'outcome_conflict');
      expect(journal.retryFinish(permit)).toMatchObject({ state: 'completed', outcome });
    } finally {
      db.close();
    }
  });

  it('retains the validation error and independent failed close, then recovers without changing an unsupported original', () => {
    journal.receive(request);
    const saved = journal.finish(takePermit(journal), outcome);
    const editor = new Database(filename);
    editor.pragma('user_version = 99');
    editor.close();
    const before = snapshotFiles(directory);
    const closeCause = new Error('synthetic rejected-store close failure');
    let retained: Database.Database | undefined;
    const close = vi
      .spyOn(Database.prototype, 'close')
      .mockImplementation(function (this: Database.Database) {
        retained = this;
        throw closeCause;
      });
    const failure = expectCode(() => journal.read(request), 'storage');
    expect(failure.cause).toMatchObject({ message: 'Unsupported or incomplete realtime journal' });
    expect(journal.takeCleanupErrors()).toEqual([closeCause]);
    expect(retained?.open).toBe(true);
    expect(snapshotFiles(directory)).toEqual(before);
    close.mockRestore();
    expectCode(() => journal.read(request), 'storage');
    expect(retained?.open).toBe(false);
    const recovered = new Database(filename);
    recovered.pragma('user_version = 2');
    recovered.close();
    expect(journal.read(request)).toEqual(saved);
    expect(journal.takeCleanupErrors()).toEqual([]);
  });

  it('preserves confirmed response bytes and the first close cause through repeated cleanup failure', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const writer = new Database(filename);
    try {
      writer.exec(`CREATE TRIGGER refuse_response AFTER INSERT ON realtime_responses
        BEGIN SELECT RAISE(ABORT, 'synthetic response I/O failure'); END;`);
      expectCode(
        () => journal.retainResponse(permit, { index: 0, frame: responseFrame }),
        'storage'
      );
      writer.exec('DROP TRIGGER refuse_response');
    } finally {
      writer.close();
    }
    const first = new Error('first close cause');
    const later = new Error('later close cause');
    let cause = first;
    const retained = new Set<Database.Database>();
    const close = vi
      .spyOn(Database.prototype, 'close')
      .mockImplementation(function (this: Database.Database) {
        retained.add(this);
        throw cause;
      });
    expect(journal.retryResponse(permit)).toEqual(responseFrame);
    expect(journal.takeCleanupErrors()).toEqual([first]);
    cause = later;
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(expectCode(() => journal.read(request), 'storage').cause).toBe(first);
      expect(journal.takeCleanupErrors()).toEqual([first]);
    }
    expect(retained.size).toBe(1);
    expect([...retained][0]?.open).toBe(true);
    close.mockRestore();
    const completed = journal.finish(permit, outcome);
    expect([...retained][0]?.open).toBe(false);
    const reopened = new RealtimeJournal(filename, () => now);
    expect(reopened.read(request)).toEqual(completed);
    expect(reopened.readResponse(request, 0)).toEqual(responseFrame);
  });

  it('preserves a committed result and original close error while independently recovering cleanup', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const cause = new Error('synthetic close failure');
    const original = Database.prototype.close;
    const close = vi
      .spyOn(Database.prototype, 'close')
      .mockImplementation(function (this: Database.Database) {
        if (this.readonly) return original.call(this);
        throw cause;
      });
    const saved = journal.finish(permit, outcome);
    expect(saved).toMatchObject({ state: 'completed', outcome });
    expect(journal.takeCleanupErrors()).toEqual([cause]);
    close.mockImplementation(original);
    journal.retryCleanup();
    expect(journal.takeCleanupErrors()).toEqual([]);
    expect(new RealtimeJournal(filename, () => now).read(request)).toEqual(saved);
  });

  it('bounds repeated failed cleanup and refuses new handles until the original handle can close', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const cause = new Error('synthetic persistent close failure');
    const original = Database.prototype.close;
    const close = vi
      .spyOn(Database.prototype, 'close')
      .mockImplementation(function (this: Database.Database) {
        if (this.readonly) return original.call(this);
        throw cause;
      });
    const saved = journal.finish(permit, outcome);
    for (let attempt = 0; attempt < 3; attempt++) {
      expectCode(() => journal.read(request), 'storage');
    }
    expect(journal.takeCleanupErrors()).toEqual([cause]);
    close.mockRestore();
    expect(journal.read(request)).toEqual(saved);
    expect(journal.takeCleanupErrors()).toEqual([]);
  });

  it('does not return corrupted retained outcome bytes as a valid completed result', () => {
    journal.receive(request);
    const saved = journal.finish(takePermit(journal), outcome);
    const db = new Database(filename);
    try {
      db.prepare('UPDATE realtime_requests SET outcome = ?').run(Buffer.from([42]));
      expectCode(() => journal.read(request), 'storage');
      expectCode(() => journal.receive(request), 'storage');
      db.prepare('UPDATE realtime_requests SET outcome = ?').run(Buffer.from(outcome));
      expect(journal.read(request)).toEqual(saved);
    } finally {
      db.close();
    }
  });

  it('retains exact opaque response originals across channels, completion, expiry and restart', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const inputFrame = Uint8Array.from(responseFrame);
    const retained = journal.retainResponse(permit, { index: 0, frame: inputFrame });
    inputFrame.fill(42);
    retained.fill(43);
    const completed = journal.finish(permit, outcome);
    const secondFrame = Uint8Array.from([7, 9, 0]);
    expect(journal.retainResponse(permit, { index: 1, frame: secondFrame })).toEqual(secondFrame);
    now = 10_000;
    const restarted = new RealtimeJournal(filename, () => now);
    const streamCopy = restarted.readResponse(request, 0);
    expect(streamCopy).toEqual(responseFrame);
    streamCopy?.fill(44);
    expect(restarted.readResponse(request, 0)).toEqual(responseFrame);
    expect(restarted.readResponse(request, 1)).toEqual(secondFrame);
    expect(restarted.readResponse(request, 2)).toBeNull();
    expect(restarted.claim(request)).toMatchObject({ state: 'existing' });
    expectCode(
      () => restarted.retainResponse(permit, { index: 2, frame: responseFrame }),
      'permit'
    );
    expectCode(() => restarted.retryResponse(permit), 'permit');
    expect(restarted.read(request)).toEqual(completed);
  });

  it('rejects slot conflicts and gaps without poisoning the next legitimate response', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    expectCode(
      () => journal.retainResponse(permit, { index: 1, frame: responseFrame }),
      'response_gap'
    );
    journal.retainResponse(permit, { index: 0, frame: responseFrame });
    expect(journal.retainResponse(permit, { index: 0, frame: responseFrame })).toEqual(
      responseFrame
    );
    expectCode(
      () => journal.retainResponse(permit, { index: 0, frame: Uint8Array.of(3) }),
      'response_conflict'
    );
    expectCode(
      () => journal.retainResponse(permit, { index: 2, frame: responseFrame }),
      'response_gap'
    );
    expect(journal.retainResponse(permit, { index: 1, frame: Uint8Array.of(4) })).toEqual(
      Uint8Array.of(4)
    );
    expect(journal.readResponse(request, 0)).toEqual(responseFrame);
  });

  it('matches the complete original request and isolates response scope, ID and permit ownership', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    journal.retainResponse(permit, { index: 0, frame: responseFrame });
    for (const change of [
      { requester: 'other-device' },
      { expiresAt: 1_001 },
      { frame: Uint8Array.of(3) },
    ])
      expectCode(() => journal.readResponse({ ...request, ...change }, 0), 'identity_conflict');
    for (const change of [
      { genesis: 'other-genesis' },
      { workspaceId: 'other-workspace' },
      { targetMachineId: 'other-machine' },
      { requestId: 'other-request' },
    ]) {
      const other = { ...request, ...change };
      expectCode(() => journal.readResponse(other, 0), 'missing');
      journal.receive(other);
      expect(journal.readResponse(other, 0)).toBeNull();
      const otherPermit = takePermit(journal, other);
      journal.retainResponse(otherPermit, { index: 0, frame: Uint8Array.of(9) });
      expect(journal.readResponse(other, 0)).toEqual(Uint8Array.of(9));
    }
    const otherOwner = new RealtimeJournal(filename, () => now);
    expectCode(
      () => otherOwner.retainResponse(permit, { index: 0, frame: responseFrame }),
      'permit'
    );
    expectCode(
      () => journal.retainResponse({} as RealtimeStartPermit, { index: 0, frame: responseFrame }),
      'permit'
    );
    expect(otherOwner.readResponse(request, 0)).toEqual(responseFrame);
  });

  it('retains only the first pending original after response I/O fails and retries settlement only', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const completed = journal.finish(permit, outcome);
    const db = new Database(filename);
    try {
      db.exec(`CREATE TRIGGER refuse_response AFTER INSERT ON realtime_responses
        BEGIN SELECT RAISE(ABORT, 'synthetic response I/O failure'); END;`);
      const original = Uint8Array.from(responseFrame);
      const failure = expectCode(
        () => journal.retainResponse(permit, { index: 0, frame: original }),
        'storage'
      );
      expect(failure.cause).toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
      original.fill(42);
      expect(journal.readResponse(request, 0)).toBeNull();
      expect(journal.read(request)).toEqual(completed);
      expectCode(
        () => journal.retainResponse(permit, { index: 0, frame: Uint8Array.of(3) }),
        'response_conflict'
      );
      expectCode(
        () => journal.retainResponse(permit, { index: 1, frame: responseFrame }),
        'response_conflict'
      );
      db.exec('DROP TRIGGER refuse_response');
      expect(journal.retryResponse(permit)).toEqual(responseFrame);
      expect(journal.retainResponse(permit, { index: 1, frame: Uint8Array.of(4) })).toEqual(
        Uint8Array.of(4)
      );
      expect(journal.read(request)).toEqual(completed);
      expectCode(() => journal.retryResponse(permit), 'permit');
    } finally {
      db.close();
    }
  });

  it('keeps committed outcomes through response read/write faults and normal I/O recovery', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const completed = journal.finish(permit, outcome);
    journal.retainResponse(permit, { index: 0, frame: responseFrame });
    const originalPath = path.join(directory, 'retained-original.sqlite');
    renameSync(filename, originalPath);
    expectCode(() => journal.readResponse(request, 0), 'storage');
    expectCode(() => journal.retainResponse(permit, { index: 1, frame: responseFrame }), 'storage');
    renameSync(originalPath, filename);
    expect(journal.readResponse(request, 0)).toEqual(responseFrame);
    expect(journal.read(request)).toEqual(completed);
    expect(journal.retainResponse(permit, { index: 1, frame: responseFrame })).toEqual(
      responseFrame
    );
  });

  it('returns the committed response despite cleanup failure and recovers without a pending replacement', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const completed = journal.finish(permit, outcome);
    const cause = new Error('synthetic response handle close failure');
    const original = Database.prototype.close;
    const close = vi
      .spyOn(Database.prototype, 'close')
      .mockImplementation(function (this: Database.Database) {
        if (this.readonly) return original.call(this);
        throw cause;
      });
    expect(journal.retainResponse(permit, { index: 0, frame: responseFrame })).toEqual(
      responseFrame
    );
    expect(journal.takeCleanupErrors()).toEqual([cause]);
    expectCode(() => journal.retryResponse(permit), 'permit');
    close.mockRestore();
    expect(journal.readResponse(request, 0)).toEqual(responseFrame);
    expect(journal.read(request)).toEqual(completed);
    expect(journal.retainResponse(permit, { index: 1, frame: Uint8Array.of(3) })).toEqual(
      Uint8Array.of(3)
    );
  });

  it('rejects corrupt response bytes and digest without losing the separate completed outcome', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const completed = journal.finish(permit, outcome);
    journal.retainResponse(permit, { index: 0, frame: responseFrame });
    const db = new Database(filename);
    try {
      db.prepare('UPDATE realtime_responses SET frame = ?').run(Buffer.from([42]));
      expectCode(() => journal.readResponse(request, 0), 'storage');
      expectCode(
        () => journal.retainResponse(permit, { index: 0, frame: responseFrame }),
        'storage'
      );
      expect(journal.read(request)).toEqual(completed);
      db.prepare('UPDATE realtime_responses SET frame = ?').run(Buffer.from(responseFrame));
      expect(journal.readResponse(request, 0)).toEqual(responseFrame);
      const saved = db.prepare('SELECT digest FROM realtime_responses').get() as { digest: string };
      db.prepare('UPDATE realtime_responses SET digest = ?').run('00'.repeat(32));
      expectCode(() => journal.readResponse(request, 0), 'storage');
      db.prepare('UPDATE realtime_responses SET digest = ?').run(saved.digest);
      expect(journal.readResponse(request, 0)).toEqual(responseFrame);
    } finally {
      db.close();
    }
  });

  it('retains the first outcome through real COMMIT BUSY and retries only settlement', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const release = holdReader(filename);
    try {
      const failure = expectCode(() => journal.finish(permit, outcome), 'storage');
      expect(failure.cause).toMatchObject({ code: 'SQLITE_BUSY' });
      expect(journal.read(request)).toMatchObject({ state: 'uncertain', frame: request.frame });
      expectCode(() => journal.finish(permit, Uint8Array.of(3)), 'outcome_conflict');
    } finally {
      release();
    }
    expect(journal.retryFinish(permit)).toMatchObject({ state: 'completed', outcome });
    expect(new RealtimeJournal(filename, () => 2_000).read(request)).toMatchObject({
      state: 'completed',
      frame: request.frame,
      outcome,
    });
  });

  it('retains a response through real COMMIT BUSY while allowing separate outcome settlement', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const release = holdReader(filename);
    try {
      const failure = expectCode(
        () => journal.retainResponse(permit, { index: 0, frame: responseFrame }),
        'storage'
      );
      expect(failure.cause).toMatchObject({ code: 'SQLITE_BUSY' });
      expect(journal.readResponse(request, 0)).toBeNull();
      expect(journal.read(request)).toMatchObject({ state: 'uncertain' });
      expectCode(
        () => journal.retainResponse(permit, { index: 0, frame: Uint8Array.of(4) }),
        'response_conflict'
      );
    } finally {
      release();
    }
    const completed = journal.finish(permit, outcome);
    expect(journal.retryResponse(permit)).toEqual(responseFrame);
    expect(journal.read(request)).toEqual(completed);
    expect(new RealtimeJournal(filename, () => 2_000).readResponse(request, 0)).toEqual(
      responseFrame
    );
  });

  it('preserves a committed outcome when response COMMIT is busy and recovers the original response', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const completed = journal.finish(permit, outcome);
    const release = holdReader(filename);
    try {
      const failure = expectCode(
        () => journal.retainResponse(permit, { index: 0, frame: responseFrame }),
        'storage'
      );
      expect(failure.cause).toMatchObject({ code: 'SQLITE_BUSY' });
      expect(journal.read(request)).toEqual(completed);
      expect(journal.readResponse(request, 0)).toBeNull();
    } finally {
      release();
    }
    expect(journal.retryResponse(permit)).toEqual(responseFrame);
    const reopened = new RealtimeJournal(filename, () => 2_000);
    expect(reopened.read(request)).toEqual(completed);
    expect(reopened.readResponse(request, 0)).toEqual(responseFrame);
  });

  it('retains the observed floor for never-claimed received requests across rollback and restart', () => {
    journal.receive(request);
    const completedPermit = takePermit(journal);
    const completed = journal.finish(completedPermit, outcome);
    journal.retainResponse(completedPermit, { index: 0, frame: responseFrame });
    const pending = { ...request, requestId: 'never-claimed', expiresAt: 1_500 };
    const observed = { ...request, requestId: 'observed-expired', expiresAt: 2_000 };
    const started = { ...request, requestId: 'already-started', expiresAt: 5_000 };
    for (const input of [pending, observed, started]) journal.receive(input);
    const startedPermit = takePermit(journal, started);
    now = 2_000;
    expect(journal.claim(observed).state).toBe('expired');
    now = 1_000;
    const reopened = new RealtimeJournal(filename, () => now);
    expect(reopened.claim(pending).state).toBe('expired');
    expect(reopened.claim(observed).state).toBe('expired');
    expect(reopened.claim(started)).toMatchObject({
      state: 'existing',
      record: { state: 'uncertain' },
    });
    expect(reopened.read(request)).toEqual(completed);
    expect(reopened.readResponse(request, 0)).toEqual(responseFrame);
    expect(journal.finish(startedPermit, outcome)).toMatchObject({ state: 'completed', outcome });
    expect(journal.retainResponse(startedPermit, { index: 0, frame: responseFrame })).toEqual(
      responseFrame
    );
  });

  it('retains the accepted cross-workspace clock limit while completed evidence remains readable', () => {
    const completed = { ...request, requestId: 'completed-before-forward-jump' };
    journal.receive(completed);
    const permit = takePermit(journal, completed);
    const saved = journal.finish(permit, outcome);
    journal.retainResponse(permit, { index: 0, frame: responseFrame });
    now = 1_000_000_000;
    journal.receive(request);
    expect(journal.claim(request).state).toBe('expired');
    now = 100;
    const other = { ...request, workspaceId: 'another-workspace', requestId: 'new-intent' };
    const reopened = new RealtimeJournal(filename, () => now);
    reopened.receive(other);
    expect(reopened.claim(other).state).toBe('expired');
    expect(reopened.read(other)).toMatchObject({ state: 'received', frame: other.frame });
    expect(reopened.read(completed)).toEqual(saved);
    expect(reopened.readResponse(completed, 0)).toEqual(responseFrame);
    // Accepted limitation: never clear the floor, extend a deadline or adopt an
    // uncertain start to recover new execution after an erroneous forward jump.
  });

  it.each([
    ['old version', 'PRAGMA user_version = 1'],
    ['unknown version', 'PRAGMA user_version = 99'],
    ['missing request table', 'ALTER TABLE realtime_requests RENAME TO retained_requests'],
    [
      'missing request field',
      'ALTER TABLE realtime_requests RENAME COLUMN digest TO retained_digest',
    ],
    ['missing clock table', 'ALTER TABLE realtime_clock RENAME TO retained_clock'],
    [
      'missing clock field',
      'ALTER TABLE realtime_clock RENAME COLUMN observed_at TO retained_time',
    ],
    ['missing response table', 'ALTER TABLE realtime_responses RENAME TO retained_responses'],
    [
      'missing response field',
      'ALTER TABLE realtime_responses RENAME COLUMN digest TO retained_digest',
    ],
  ])('rejects %s without rewriting SQLite bytes, evidence, mode or permissions', (_, alter) => {
    const pending = { ...request, requestId: 'pending', expiresAt: 3_000 };
    const started = { ...request, requestId: 'started' };
    journal.receive(request);
    const permit = takePermit(journal);
    journal.finish(permit, outcome);
    journal.retainResponse(permit, { index: 0, frame: responseFrame });
    journal.receive(pending);
    journal.receive(started);
    takePermit(journal, started);
    const expired = { ...request, requestId: 'expired', expiresAt: 1_500 };
    journal.receive(expired);
    now = 2_000;
    expect(journal.claim(expired).state).toBe('expired');
    const editor = new Database(filename);
    try {
      expect(editor.pragma('journal_mode', { simple: true })).toBe('delete');
      editor.exec(alter);
    } finally {
      editor.close();
    }
    // All writers are closed and the fixture remains in rollback/DELETE mode.
    chmodSync(filename, 0o640);
    const beforeDatabase = snapshotDatabase(filename);
    const beforeFiles = snapshotFiles(directory);
    const reopened = new RealtimeJournal(filename, () => now);
    expectCode(() => reopened.read(request), 'storage');
    expectCode(() => reopened.readResponse(request, 0), 'storage');
    expectCode(() => reopened.receive({ ...request, requestId: 'not-admitted' }), 'storage');
    expectCode(() => reopened.claim(pending), 'storage');
    expectCode(() => journal.finish(permit, outcome), 'storage');
    expectCode(() => journal.retainResponse(permit, { index: 1, frame: responseFrame }), 'storage');
    expect(snapshotDatabase(filename)).toEqual(beforeDatabase);
    expect(snapshotFiles(directory)).toEqual(beforeFiles);
  });

  it('rejects an empty original without initializing or chmodding it', () => {
    const empty = path.join(directory, 'empty-original.sqlite');
    writeFileSync(empty, '', { mode: 0o640 });
    const before = snapshotFiles(directory);
    const unopened = new RealtimeJournal(empty, () => now);
    expectCode(() => unopened.receive(request), 'storage');
    expectCode(() => unopened.claim(request), 'storage');
    expect(snapshotFiles(directory)).toEqual(before);
  });

  it('enforces the current response foreign key without changing any parent evidence', () => {
    journal.receive(request);
    const db = new Database(filename);
    try {
      db.pragma('foreign_keys = ON');
      expect(() =>
        db
          .prepare(`INSERT INTO realtime_responses
        (genesis, workspace_id, target_machine_id, request_id, position, frame, digest)
        VALUES ('absent', 'absent', 'absent', 'absent', 0, ?, ?)`)
          .run(Buffer.from(responseFrame), '00'.repeat(32))
      ).toThrow();
    } finally {
      db.close();
    }
    expect(journal.read(request)).toMatchObject({ state: 'received', frame: request.frame });
    expect(journal.readResponse(request, 0)).toBeNull();
  });

  it('recovers a current hot journal without restarting the action or losing unrelated results and responses', async () => {
    const completed = { ...request, requestId: 'already-completed' };
    journal.receive(completed);
    const permit = takePermit(journal, completed);
    const archived = journal.finish(permit, outcome);
    journal.retainResponse(permit, { index: 0, frame: responseFrame });
    journal.receive(request);
    await crashBeforeCommit(filename, request, 2);

    const reopened = new RealtimeJournal(filename, () => now);
    const observe = (read: () => unknown) => {
      try {
        return { value: read() };
      } catch (error) {
        return { error };
      }
    };
    // Observe all independent records before asserting so one unavailable
    // crashed action cannot hide the unrelated committed-result regression.
    expect({
      active: observe(() => reopened.read(request)),
      completed: observe(() => reopened.read(completed)),
      response: observe(() => reopened.readResponse(completed, 0)),
    }).toEqual({
      active: { value: expect.objectContaining({ state: 'uncertain', frame: request.frame }) },
      completed: { value: archived },
      response: { value: responseFrame },
    });
    expect(reopened.claim(request)).toMatchObject({
      state: 'existing',
      record: { state: 'uncertain' },
    });
    expect(reopened.read(completed)).toEqual(archived);
    expect(reopened.readResponse(completed, 0)).toEqual(responseFrame);
    const independent = { ...request, requestId: 'after-recovery' };
    reopened.receive(independent);
    expect(reopened.finish(takePermit(reopened, independent), outcome)).toMatchObject({
      state: 'completed',
      outcome,
    });
    expect(new RealtimeJournal(filename, () => now).claim(request)).toMatchObject({
      state: 'existing',
      record: { state: 'uncertain' },
    });
  });

  it.each([1, 99] as const)(
    'recovers native rollback but rejects hot schema %s without application schema or record changes',
    async (version) => {
      const completed = { ...request, requestId: 'already-completed' };
      journal.receive(completed);
      const permit = takePermit(journal, completed);
      journal.finish(permit, outcome);
      journal.retainResponse(permit, { index: 0, frame: responseFrame });
      journal.receive(request);
      takePermit(journal);
      const editor = new Database(filename);
      try {
        expect(editor.pragma('journal_mode', { simple: true })).toBe('delete');
        editor.pragma(`user_version = ${version}`);
      } finally {
        editor.close();
      }
      chmodSync(filename, 0o640);
      const committed = snapshotDatabase(filename);
      const mode = statSync(filename).mode;
      await crashBeforeCommit(filename, request, version);
      const assertOriginals = () => {
        // Native rollback removes uncommitted pages. Application schema/version
        // and every previously committed original must remain unchanged.
        expect(snapshotDatabase(filename)).toEqual(committed);
        expect(statSync(filename).mode).toBe(mode);
      };
      const reopened = new RealtimeJournal(filename, () => now);
      for (const owner of [journal, reopened]) {
        expectCode(() => owner.read(request), 'storage');
        expectCode(() => owner.claim(request), 'storage');
        expectCode(() => owner.read(completed), 'storage');
        expectCode(() => owner.readResponse(completed, 0), 'storage');
        expectCode(() => owner.receive({ ...request, requestId: 'refused' }), 'storage');
        assertOriginals();
      }
      expectCode(() => journal.finish(permit, outcome), 'storage');
      expectCode(
        () => journal.retainResponse(permit, { index: 1, frame: responseFrame }),
        'storage'
      );
      assertOriginals();
    }
  );

  it('allows native checkpoint of an unsupported WAL store while preserving all committed application evidence', async () => {
    journal.receive(request);
    const permit = takePermit(journal);
    journal.finish(permit, outcome);
    journal.retainResponse(permit, { index: 0, frame: responseFrame });
    const editor = new Database(filename);
    editor.pragma('user_version = 99');
    editor.close();
    chmodSync(filename, 0o640);
    const mode = statSync(filename).mode;
    const committed = await crashBeforeCommit(filename, request, 99, 'committed-wal');
    const mainBeforeCheckpoint = readFileSync(filename);
    const reopened = new RealtimeJournal(filename, () => now);
    expectCode(() => reopened.receive({ ...request, requestId: 'refused-unknown-wal' }), 'storage');
    // The final native connection may checkpoint its WAL before rejecting/closing.
    // Physical bytes are allowed to change; application schema/version/rows are not.
    expect(readFileSync(filename).equals(mainBeforeCheckpoint)).toBe(false);
    expect(snapshotDatabase(filename)).toEqual(committed);
    expect(statSync(filename).mode).toBe(mode);
    for (const run of [
      () => reopened.read(request),
      () => reopened.claim(request),
      () => reopened.readResponse(request, 0),
      () => journal.finish(permit, outcome),
      () => journal.retainResponse(permit, { index: 1, frame: responseFrame }),
    ])
      expectCode(run, 'storage');
    expect(snapshotDatabase(filename)).toEqual(committed);
  });

  it('gives competing native SQLite connections at most one start permit on the current schema', async () => {
    journal.receive(request);
    const modulePath = fileURLToPath(new URL('./realtime-journal.ts', import.meta.url));
    const require = createRequire(import.meta.url);
    const workers = Array.from({ length: 2 }, () => {
      const worker = new Worker(
        `const { parentPort, workerData } = require('node:worker_threads');
         require(workerData.tsx);
         const { RealtimeJournal } = require(workerData.modulePath);
         const journal = new RealtimeJournal(workerData.filename, () => 100);
         parentPort.postMessage('ready');
         parentPort.once('message', () => {
           try { parentPort.postMessage({ state: journal.claim(workerData.request).state }); }
           catch (error) { parentPort.postMessage({ state: error.code, cause: error.cause?.code }); }
           finally { parentPort.close(); }
         });`,
        {
          eval: true,
          workerData: { tsx: require.resolve('tsx/cjs'), modulePath, filename, request },
        }
      );
      const ready = new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('message', () => resolve());
      });
      const result = new Promise<{ state: string; cause?: string }>((resolve, reject) => {
        worker.once('error', reject);
        worker.on('message', (message: unknown) => {
          if (message !== 'ready') resolve(message as { state: string; cause?: string });
        });
      });
      return { worker, ready, result };
    });
    let workerPermits = 0;
    try {
      await Promise.all(workers.map((entry) => entry.ready));
      for (const entry of workers) entry.worker.postMessage('claim');
      const results = await Promise.all(workers.map((entry) => entry.result));
      workerPermits = results.filter((entry) => entry.state === 'claimed').length;
      expect(workerPermits).toBeLessThanOrEqual(1);
      for (const entry of results) {
        if (entry.state === 'storage') expect(entry.cause).toBe('SQLITE_BUSY');
        else expect(['claimed', 'existing']).toContain(entry.state);
      }
    } finally {
      await Promise.all(workers.map((entry) => entry.worker.terminate()));
    }
    const parent = new RealtimeJournal(filename, () => now);
    const parentClaim = parent.claim(request);
    expect(workerPermits + Number(parentClaim.state === 'claimed')).toBe(1);
    if (workerPermits === 1) {
      expect(parentClaim).toMatchObject({
        state: 'existing',
        record: { state: 'uncertain' },
      });
    } else {
      expect(parentClaim.state).toBe('claimed');
      expect(new RealtimeJournal(filename, () => now).claim(request)).toMatchObject({
        state: 'existing',
        record: { state: 'uncertain' },
      });
    }
  });
});
