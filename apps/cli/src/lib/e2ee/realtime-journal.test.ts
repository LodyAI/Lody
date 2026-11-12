import { Effect } from 'effect';
import { makeEncryptedAgentExecution, lazyExecutionJournal } from './agent-execution';
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
import { decideEncryptedDerivation } from './derivation-limits';

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
  version: 3 | 1 | 99,
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
      } else if (version === 3) {
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

  it.each(['SQLITE_BUSY', 'SQLITE_IOERR'])(
    'preserves the journal when schema validation encounters %s',
    (code) => {
      journal.receive(request);
      const original = snapshotDatabase(filename);
      const cause = Object.assign(new Error('synthetic SQLite failure'), { code });
      const prepare = Database.prototype.prepare;
      let injected = false;
      const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql) {
        if (!injected && sql.includes('FROM realtime_requests LIMIT 0')) {
          injected = true;
          throw cause;
        }
        return prepare.call(this, sql);
      });
      const failure = expectCode(() => journal.claim(request), 'storage');
      expect(failure.cause).toBe(cause);
      spy.mockRestore();
      expect(readdirSync(directory).some((name) => name.includes('.archive-'))).toBe(false);
      expect(snapshotDatabase(filename)).toEqual(original);
      expect(journal.read(request)).toMatchObject({ state: 'received', frame: request.frame });
      takePermit(journal);
      expect(new RealtimeJournal(filename, () => now).claim(request)).toMatchObject({
        state: 'existing',
        record: { state: 'uncertain' },
      });
    }
  );

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

  it('recovers unclaimed requests after local clock correction and restart without replaying started IDs', () => {
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
    expect(reopened.claim(pending).state).toBe('claimed');
    expect(reopened.claim(observed).state).toBe('claimed');
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

  it('accepts new requests in the same workspace after a five-minute local clock correction', () => {
    now = 300_100;
    const jumped = { ...request, requestId: 'during-forward-jump', expiresAt: now + 60_000 };
    journal.receive(jumped);
    const permit = takePermit(journal, jumped);
    now = 100;
    const reopened = new RealtimeJournal(filename, () => now);
    const next = { ...request, requestId: 'after-correction' };
    reopened.receive(next);
    expect(reopened.claim(next).state).toBe('claimed');
    expect(reopened.claim(jumped)).toMatchObject({
      state: 'existing',
      record: { state: 'uncertain' },
    });
    expect(journal.finish(permit, outcome)).toMatchObject({ state: 'completed', outcome });
  });

  it('isolates a forward clock observation from new workspaces while completed evidence remains readable', () => {
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
    expect(reopened.claim(other).state).toBe('claimed');
    expect(reopened.read(other)).toMatchObject({ state: 'uncertain', frame: other.frame });
    expect(reopened.read(completed)).toEqual(saved);
    expect(reopened.readResponse(completed, 0)).toEqual(responseFrame);
  });

  it.each([
    ['old version', 'PRAGMA user_version = 1'],
    ['unknown version', 'PRAGMA user_version = 99'],
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
  ])('archives %s without rewriting committed evidence or permissions', (_, alter) => {
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
    const beforeBytes = readFileSync(filename);
    const reopened = new RealtimeJournal(filename, () => now);
    const failure = expectCode(() => reopened.read(request), 'unsupported_schema');
    const archived = failure.archivePath as string;
    expect(readFileSync(archived)).toEqual(beforeBytes);
    expect(snapshotDatabase(archived)).toEqual(beforeDatabase);
    expect(statSync(archived).mode & 0o777).toBe(0o640);
    for (const run of [
      () => reopened.readResponse(request, 0),
      () => reopened.receive({ ...request, requestId: 'not-admitted' }),
      () => reopened.claim(pending),
      () => journal.finish(permit, outcome),
      () => journal.retainResponse(permit, { index: 1, frame: responseFrame }),
    ])
      expectCode(run, 'reset_required');
    // Archival alone never provisions a replacement or interprets unknown rows.
    expect(() => readFileSync(filename)).toThrow();
    const reset = reopened.reset();
    expect(reset.archivePath).toBe(archived);
    expect(new RealtimeJournal(filename, () => now).read(request)).toBeNull();
    expect(snapshotDatabase(archived)).toEqual(beforeDatabase);
  });

  it.each(['direct reset', 'archive before reset'])(
    'fences every current request when response schema is incomplete: %s',
    (route) => {
      journal.receive(request);
      journal.finish(takePermit(journal), outcome);
      const uncertain = { ...request, requestId: 'uncertain-before-incomplete-reset' };
      const pending = { ...request, requestId: 'received-before-incomplete-reset' };
      journal.receive(uncertain);
      takePermit(journal, uncertain);
      journal.receive(pending);
      const editor = new Database(filename);
      editor.exec('ALTER TABLE realtime_responses RENAME COLUMN digest TO retained_digest');
      editor.close();
      const before = snapshotDatabase(filename);
      const resetter = new RealtimeJournal(filename, () => now);
      if (route === 'archive before reset') {
        const failure = expectCode(() => resetter.read(request), 'unsupported_schema');
        const control = new Database(`${filename}.control.sqlite`, { readonly: true });
        try {
          expect(control.prepare('SELECT COUNT(*) AS count FROM retired_requests').get()).toEqual({
            count: 3,
          });
        } finally {
          control.close();
        }
        expect(snapshotDatabase(failure.archivePath as string)).toEqual(before);
      }
      const { archivePath } = resetter.reset();
      expect(snapshotDatabase(archivePath)).toEqual(before);
      const reopened = new RealtimeJournal(filename, () => now);
      for (const original of [request, uncertain, pending]) {
        expectCode(() => reopened.receive(original), 'archived_request');
        expectCode(() => reopened.claim(original), 'missing');
      }
      const independent = { ...request, requestId: 'independent-after-incomplete-reset' };
      reopened.receive(independent);
      expect(reopened.claim(independent).state).toBe('claimed');
    }
  );

  it.each([
    [
      'ALTER TABLE realtime_requests RENAME TO retained_requests',
      'ALTER TABLE retained_requests RENAME TO realtime_requests',
    ],
    [
      'ALTER TABLE realtime_requests RENAME COLUMN request_id TO retained_id',
      'ALTER TABLE realtime_requests RENAME COLUMN retained_id TO request_id',
    ],
  ])('refuses reset when current request keys cannot be read: %s', (damage, repair) => {
    journal.receive(request);
    journal.finish(takePermit(journal), outcome);
    const editor = new Database(filename);
    editor.exec(damage);
    editor.close();
    const before = snapshotFiles(directory);
    const resetter = new RealtimeJournal(filename, () => now);
    expectCode(() => resetter.read(request), 'request_keys_unreadable');
    expect(snapshotFiles(directory)).toEqual(before);
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = expectCode(() => resetter.reset(), 'request_keys_unreadable');
      expect(failure.message).toContain('Cannot safely reset');
      expect(snapshotFiles(directory)).toEqual(before);
    }
    const restored = new Database(filename);
    restored.exec(repair);
    restored.close();
    expect(new RealtimeJournal(filename, () => now).read(request)).toMatchObject({
      state: 'completed',
      outcome,
    });
    resetter.reset();
    expectCode(() => new RealtimeJournal(filename, () => now).receive(request), 'archived_request');
  });

  it('initializes an interrupted empty original without losing a later request', () => {
    const empty = path.join(directory, 'empty-original.sqlite');
    writeFileSync(empty, '', { mode: 0o600 });
    const reopened = new RealtimeJournal(empty, () => now);
    expect(reopened.receive(request)).toMatchObject({ state: 'received' });
    expect(reopened.finish(takePermit(reopened), outcome)).toMatchObject({ state: 'completed' });
  });

  it('rejects a local clock over ten minutes ahead of trusted time without advancing the floor', () => {
    journal.receive(request);
    const guarded = new RealtimeJournal(filename, () => now, { trustedNow: () => 100 });
    now = 600_101;
    const before = snapshotDatabase(filename);
    expectCode(() => guarded.claim(request), 'clock_skew');
    expect(snapshotDatabase(filename)).toEqual(before);
    now = 100;
    expect(guarded.claim(request).state).toBe('claimed');
  });

  it('resets the floor, archives exact evidence, fences retired IDs and invalidates old owners', () => {
    journal.receive(request);
    const permit = takePermit(journal);
    const observed = { ...request, requestId: 'far-future' };
    journal.receive(observed);
    now = 1_000_000_000;
    expect(journal.claim(observed).state).toBe('expired');
    const before = snapshotDatabase(filename);
    now = 100;
    const { archivePath } = new RealtimeJournal(filename, () => now).reset();
    expect(snapshotDatabase(archivePath)).toEqual(before);
    const reopened = new RealtimeJournal(filename, () => now);
    expectCode(() => reopened.receive(request), 'archived_request');
    expectCode(() => journal.finish(permit, outcome), 'journal_reset');
    const next = { ...request, requestId: 'new-after-reset' };
    reopened.receive(next);
    expect(reopened.claim(next).state).toBe('claimed');
    const second = new RealtimeJournal(filename, () => now).reset();
    expect(second.archivePath).not.toBe(archivePath);
    expectCode(() => new RealtimeJournal(filename, () => now).receive(request), 'archived_request');
  });

  it('accepts exactly ten minutes of skew and uses trusted time for the workspace floor', () => {
    journal.receive(request);
    const guarded = new RealtimeJournal(filename, () => 600_100, { trustedNow: () => 100 });
    expect(guarded.claim(request).state).toBe('claimed');
    const next = { ...request, requestId: 'after-tolerated-skew' };
    journal.receive(next);
    expect(new RealtimeJournal(filename, () => 100).claim(next).state).toBe('claimed');
  });

  it('resumes reset after interruption between archive and replacement schema commit', () => {
    journal.receive(request);
    takePermit(journal);
    const before = snapshotDatabase(filename);
    const nativePrepare = Database.prototype.prepare;
    const prepare = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      if (sql === 'INSERT INTO realtime_identity VALUES (?)')
        throw new Error('synthetic interrupted replacement');
      return nativePrepare.call(this, sql);
    });
    const resetter = new RealtimeJournal(filename, () => now);
    expectCode(() => resetter.reset(), 'storage');
    const archive = readdirSync(directory).find((name) => name.includes('.archive-'));
    expect(archive).toBeDefined();
    const archivePath = path.join(directory, archive as string);
    expect(snapshotDatabase(archivePath)).toEqual(before);
    expectCode(() => new RealtimeJournal(filename, () => now).receive(request), 'reset_required');
    prepare.mockRestore();
    expect(resetter.reset()).toEqual({ archivePath });
    expectCode(() => new RealtimeJournal(filename, () => now).receive(request), 'archived_request');
    const next = { ...request, requestId: 'after-interrupted-reset' };
    const reopened = new RealtimeJournal(filename, () => now);
    reopened.receive(next);
    expect(reopened.claim(next).state).toBe('claimed');
  });

  it('keeps a reset from renaming a main handle whose cleanup is unresolved', () => {
    journal.receive(request);
    const nativeClose = Database.prototype.close;
    let retained: Database.Database | undefined;
    const close = vi
      .spyOn(Database.prototype, 'close')
      .mockImplementation(function (this: Database.Database) {
        if (this.name === filename && (retained === undefined || retained === this)) {
          retained = this;
          throw new Error('synthetic retained handle');
        }
        return nativeClose.call(this);
      });
    expect(journal.read(request)).toMatchObject({ state: 'received' });
    const independent = new RealtimeJournal(filename, () => now);
    const next = { ...request, requestId: 'independent-despite-close-failure' };
    independent.receive(next);
    expect(independent.claim(next).state).toBe('claimed');
    const resetter = new RealtimeJournal(filename, () => now);
    expect(expectCode(() => resetter.reset(), 'storage').cause).toMatchObject({
      code: 'SQLITE_BUSY',
    });
    expect(readdirSync(directory).some((name) => name.includes('.archive-'))).toBe(false);
    close.mockRestore();
    journal.retryCleanup();
    expect(resetter.reset().archivePath).toContain('.archive-');
  });

  it('recovers a current hot journal without restarting the action or losing unrelated results and responses', async () => {
    const completed = { ...request, requestId: 'already-completed' };
    journal.receive(completed);
    const permit = takePermit(journal, completed);
    const archived = journal.finish(permit, outcome);
    journal.retainResponse(permit, { index: 0, frame: responseFrame });
    journal.receive(request);
    await crashBeforeCommit(filename, request, 3);

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
      const reopened = new RealtimeJournal(filename, () => now);
      const failure = expectCode(() => reopened.read(request), 'unsupported_schema');
      const archive = failure.archivePath as string;
      expect(snapshotDatabase(archive)).toEqual(committed);
      expect(statSync(archive).mode).toBe(mode);
      for (const run of [
        () => reopened.claim(request),
        () => reopened.read(completed),
        () => reopened.readResponse(completed, 0),
        () => reopened.receive({ ...request, requestId: 'refused' }),
        () => journal.finish(permit, outcome),
        () => journal.retainResponse(permit, { index: 1, frame: responseFrame }),
      ])
        expectCode(run, 'reset_required');
      expect(snapshotDatabase(archive)).toEqual(committed);
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
    const failure = expectCode(
      () => reopened.receive({ ...request, requestId: 'refused-unknown-wal' }),
      'unsupported_schema'
    );
    const archive = failure.archivePath as string;
    expect(readFileSync(archive).equals(mainBeforeCheckpoint)).toBe(false);
    // Archival checkpoints through SQLite before rename. Only journal mode may
    // change; the committed schema, version and all evidence remain identical.
    expect(snapshotDatabase(archive)).toEqual({ ...committed, mode: 'delete' });
    expect(statSync(archive).mode).toBe(mode);
    for (const run of [
      () => reopened.read(request),
      () => reopened.claim(request),
      () => reopened.readResponse(request, 0),
      () => journal.finish(permit, outcome),
      () => journal.retainResponse(permit, { index: 1, frame: responseFrame }),
    ])
      expectCode(run, 'reset_required');
    expect(snapshotDatabase(archive)).toEqual({ ...committed, mode: 'delete' });
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
  describe('shared agent execution admission', () => {
    const intent = {
      workspaceId: 'synthetic-workspace',
      sessionId: 'session',
      userTurnId: 'user-turn',
      requesterUserId: 'user',
    };
    const key = {
      genesis: 'synthetic-genesis',
      workspaceId: 'synthetic-workspace',
      targetMachineId: 'synthetic-machine',
      requestId: 'agent-start:user-turn',
    };
    const gate = (open: () => RealtimeJournal) =>
      makeEncryptedAgentExecution({
        machineUserId: 'synthetic-machine-account',
        genesis: key.genesis,
        workspaceId: key.workspaceId,
        targetMachineId: key.targetMachineId,
        journal: open,
        resolveVerifiedOriginal: () =>
          Effect.succeed({
            requesterDevice: 'ab'.repeat(32),
            requesterCryptoUserId: '1e'.repeat(32),
          }),
        authorizeExecution: () => Effect.succeed({ _tag: 'Authorized' }),
      });

    it('denies a verified original when no authorization capability is available', async () => {
      const execution = makeEncryptedAgentExecution({
        machineUserId: 'synthetic-machine-account',
        genesis: key.genesis,
        workspaceId: key.workspaceId,
        targetMachineId: key.targetMachineId,
        journal: () => journal,
        resolveVerifiedOriginal: () =>
          Effect.succeed({
            requesterDevice: 'ab'.repeat(32),
            requesterCryptoUserId: '1e'.repeat(32),
            expiresAt: 1000,
          }),
      });
      expect(await Effect.runPromise(execution.claim(intent))).toEqual({ state: 'denied' });
      expect(journal.read(key)).toBeNull();
    });

    it('checks the current policy fence immediately before the durable start', async () => {
      let current = true;
      let authorized = false;
      const read = journal.read.bind(journal);
      vi.spyOn(journal, 'read').mockImplementation((storedKey) => {
        if (authorized) current = false; // Explicit known withdrawal between authorization and claim.
        return read(storedKey);
      });
      const execution = makeEncryptedAgentExecution({
        machineUserId: 'synthetic-machine-account',
        genesis: key.genesis,
        workspaceId: key.workspaceId,
        targetMachineId: key.targetMachineId,
        journal: () => journal,
        resolveVerifiedOriginal: () =>
          Effect.succeed({
            requesterDevice: 'ab'.repeat(32),
            requesterCryptoUserId: '1e'.repeat(32),
            expiresAt: 1000,
          }),
        authorizeExecution: (_workspace, _requester, localProjectId) =>
          Effect.sync(() => {
            expect(localProjectId).toBe('actual-local-project');
            authorized = true;
            return { _tag: 'Authorized' as const, isCurrent: () => current };
          }),
      });
      expect(
        await Effect.runPromise(
          execution.claim({ ...intent, localProjectIds: ['actual-local-project'] })
        )
      ).toEqual({ state: 'denied' });
      expect(read(key)).toBeNull();
    });

    it.each([
      [['owner', 'owner'], 'owner'],
      [['owner', 'member'], 'member'],
    ] as const)(
      'keeps owner identity across project grants only when every grant names the owner (%j)',
      async (principals, expected) => {
        let index = 0;
        const execution = makeEncryptedAgentExecution({
          machineUserId: 'synthetic-machine-account',
          genesis: key.genesis,
          workspaceId: key.workspaceId,
          targetMachineId: key.targetMachineId,
          journal: () => journal,
          resolveVerifiedOriginal: () =>
            Effect.succeed({
              requesterDevice: 'ab'.repeat(32),
              requesterCryptoUserId: '1e'.repeat(32),
              expiresAt: 1000,
            }),
          authorizeExecution: () =>
            Effect.sync(() => ({
              _tag: 'Authorized' as const,
              principal: principals[index++] ?? 'member',
            })),
        });
        expect(
          await Effect.runPromise(
            execution.claim({ ...intent, localProjectIds: ['first', 'second'] })
          )
        ).toMatchObject({ state: 'claimed', principal: expected });
      }
    );

    it('requires every project the turn reaches to be shared before the durable start', async () => {
      const asked: (string | undefined)[] = [];
      const execution = makeEncryptedAgentExecution({
        machineUserId: 'synthetic-machine-account',
        genesis: key.genesis,
        workspaceId: key.workspaceId,
        targetMachineId: key.targetMachineId,
        journal: () => journal,
        resolveVerifiedOriginal: () =>
          Effect.succeed({
            requesterDevice: 'ab'.repeat(32),
            requesterCryptoUserId: '1e'.repeat(32),
            expiresAt: 1000,
          }),
        authorizeExecution: (_workspace, _requester, localProjectId) =>
          Effect.sync(() => {
            asked.push(localProjectId);
            return localProjectId === 'private'
              ? { _tag: 'Denied' as const, reason: 'e2ee_machine_not_shared' }
              : { _tag: 'Authorized' as const };
          }),
      });
      expect(
        await Effect.runPromise(
          execution.claim({ ...intent, localProjectIds: ['shared', 'private', 'shared'] })
        )
      ).toEqual({ state: 'denied', reason: 'e2ee_machine_not_shared' });
      expect(asked).toEqual(['shared', 'private']);
      expect(journal.read(key)).toBeNull();
    });

    it('starts a message once whatever the clock says, and never a retired one', async () => {
      // No deadline and no clock: a far-future, then a rolled-back clock both start it once.
      now = 4_102_444_800_000;
      const first = gate(() => journal);
      expect(await Effect.runPromise(first.claim(intent))).toMatchObject({ state: 'claimed' });
      now = 1;
      const reopened = gate(() => new RealtimeJournal(filename, () => now));
      expect(await Effect.runPromise(reopened.claim(intent))).toEqual({ state: 'uncertain' });
      // A message cancelled before it started stays retired, even if its row is pending again.
      const canceled = { ...intent, userTurnId: 'canceled-turn' };
      await Effect.runPromise(reopened.retire(canceled));
      expect(await Effect.runPromise(reopened.claim(canceled))).toEqual({ state: 'completed' });
      // Retiring an already started message changes nothing.
      await Effect.runPromise(reopened.retire(intent));
      expect(journal.read(key)?.state).toBe('uncertain');
    });

    it('binds the business intent to its turn and session, independently of display account IDs', async () => {
      const execution = gate(() => journal);
      expect((await Effect.runPromise(execution.claim(intent))).state).toBe('claimed');
      for (const changed of [
        { ...intent, sessionId: 'other-session' },
        { ...intent, workspaceId: 'other-workspace' },
      ]) {
        await expect(Effect.runPromise(execution.claim(changed))).rejects.toMatchObject({
          code: 'identity_conflict',
        });
      }
      const before = journal.read(key);
      expect(
        await Effect.runPromise(
          execution.claim({ ...intent, requesterUserId: 'another-display-account' })
        )
      ).toEqual({ state: 'uncertain' });
      expect(journal.read(key)?.frame).toEqual(before?.frame);
      expect(journal.read(key)?.state).toBe('uncertain');
    });

    it('refuses other content under a message ID that already started', async () => {
      const execution = gate(() => journal);
      expect((await Effect.runPromise(execution.claim(intent))).state).toBe('claimed');
      const edited = { ...intent, inputConfig: { prompt: 'edited after start' } };
      expect(await Effect.runPromise(execution.claim(edited))).toEqual({ state: 'uncertain' });
      expect(journal.read(key)?.state).toBe('uncertain');
    });

    it('refuses a late authorization after the workspace closes without consuming a start', async () => {
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      let open = true;
      const execution = makeEncryptedAgentExecution({
        machineUserId: 'synthetic-machine-account',
        genesis: key.genesis,
        workspaceId: key.workspaceId,
        targetMachineId: key.targetMachineId,
        journal: () => journal,
        isExecutionOpen: () => open,
        resolveVerifiedOriginal: () =>
          Effect.succeed({
            requesterDevice: 'ab'.repeat(32),
            requesterCryptoUserId: '1e'.repeat(32),
            expiresAt: 1000,
          }),
        authorizeExecution: () =>
          Effect.promise(async () => {
            entered.resolve();
            await released.promise;
            return { _tag: 'Authorized' as const };
          }),
      });
      const pending = Effect.runPromise(execution.claim(intent));
      await entered.promise;
      open = false;
      released.resolve();
      expect(await pending).toEqual({ state: 'denied' });
      expect(journal.read(key)).toBeNull();
    });

    it('retains userTurnId fences across explicit journal reset', async () => {
      const execution = gate(() => journal);
      expect((await Effect.runPromise(execution.claim(intent))).state).toBe('claimed');
      journal.reset();
      const successor = gate(() => new RealtimeJournal(filename, () => now));
      await expect(Effect.runPromise(successor.claim(intent))).rejects.toMatchObject({
        code: 'archived_request',
      });
      expect(
        (await Effect.runPromise(successor.claim({ ...intent, userTurnId: 'new-user-turn' }))).state
      ).toBe('claimed');
    });

    it('never provisions over a missing used execution log', async () => {
      const execution = gate(lazyExecutionJournal(filename, () => now));
      await Effect.runPromise(execution.claim(intent));
      rmSync(filename);
      const restarted = gate(lazyExecutionJournal(filename, () => now));
      await expect(Effect.runPromise(restarted.claim(intent))).rejects.toMatchObject({
        code: 'storage',
      });
      expect(readdirSync(directory)).not.toContain('journal.sqlite');
      expect(readdirSync(directory)).toContain('journal.sqlite.control.sqlite');
    });
  });

  describe('shared-member derivation on the same machine', () => {
    const self = 'ee'.repeat(32);
    const member = 'aa'.repeat(32);
    const owner = 'bb'.repeat(32);
    const origin = { sessionId: 'origin-session', userTurnId: 'origin-turn' };
    const derived = {
      workspaceId: 'synthetic-workspace',
      sessionId: 'child-session',
      userTurnId: 'child-turn',
      requesterUserId: 'display-owner-account',
      localProjectIds: ['private-project'],
    };
    type Original = {
      requesterDevice: string;
      requesterCryptoUserId: string;
      expiresAt: number;
      derivedFrom?: { sessionId: string; userTurnId: string };
    };
    const originals = new Map<string, Original>();
    const authorized: Array<[string, string | undefined]> = [];
    // The member may use only `shared-project`; the machine owner may use anything.
    const gate = (rows: Map<string, Original> = originals) =>
      makeEncryptedAgentExecution({
        machineUserId: 'synthetic-machine-account',
        genesis: 'synthetic-genesis',
        workspaceId: 'synthetic-workspace',
        targetMachineId: 'synthetic-machine',
        journal: () => journal,
        selfDevice: self,
        resolveVerifiedOriginal: (intent) =>
          Effect.succeed(rows.get(`${intent.sessionId}/${intent.userTurnId}`)),
        authorizeExecution: (_workspace, device, project) =>
          Effect.sync(() => {
            authorized.push([device, project]);
            if (device === self || device === owner)
              return { _tag: 'Authorized' as const, principal: 'owner' as const };
            if (device === member && (project === undefined || project === 'shared-project'))
              return { _tag: 'Authorized' as const, principal: 'member' as const };
            return { _tag: 'Denied' as const, reason: 'e2ee_machine_not_shared' };
          }),
      });
    const signed = (requesterDevice: string, extra: Partial<Original> = {}): Original => ({
      requesterDevice,
      requesterCryptoUserId: '1e'.repeat(32),
      expiresAt: Date.now() + 60_000,
      ...extra,
    });
    beforeEach(() => {
      originals.clear();
      authorized.length = 0;
      originals.set('origin-session/origin-turn', signed(member));
    });

    it("runs a derived input with the member's own rights, never the machine owner's", async () => {
      originals.set('child-session/child-turn', signed(self, { derivedFrom: origin }));
      const execution = gate();
      // A project shared with the member starts, as that member, and derives nothing further.
      expect(
        await Effect.runPromise(
          execution.claim({ ...derived, localProjectIds: ['shared-project'] })
        )
      ).toMatchObject({ state: 'claimed', principal: 'derived' });
      expect(authorized).toEqual([[member, 'shared-project']]);
      // The machine-authored input cannot reach a project the member may not use.
      originals.set('child-session/other-turn', signed(self, { derivedFrom: origin }));
      expect(
        await Effect.runPromise(execution.claim({ ...derived, userTurnId: 'other-turn' }))
      ).toEqual({ state: 'denied', reason: 'e2ee_machine_not_shared' });
      expect(authorized.at(-1)).toEqual([member, 'private-project']);
    });

    it('rejects forged, chained, unverifiable and over-limit derivations', async () => {
      const deny = async (row: Original | undefined, rows = originals) => {
        const userTurnId = `turn-${rows.size}-${Math.random()}`;
        if (row) rows.set(`child-session/${userTurnId}`, row);
        return Effect.runPromise(
          gate(rows).claim({ ...derived, userTurnId, localProjectIds: ['shared-project'] })
        );
      };
      // Only this machine authors derivations; a member cannot claim one for itself.
      expect(await deny(signed(member, { derivedFrom: origin }))).toEqual({ state: 'denied' });
      // One level: the origin may not itself be derived or machine-authored.
      originals.set('origin-session/origin-turn', signed(self, { derivedFrom: origin }));
      expect(await deny(signed(self, { derivedFrom: origin }))).toEqual({ state: 'denied' });
      originals.set('origin-session/origin-turn', signed(self));
      expect(await deny(signed(self, { derivedFrom: origin }))).toEqual({ state: 'denied' });
      // An origin that cannot be verified (absent, edited, other workspace) is refused.
      originals.delete('origin-session/origin-turn');
      expect(await deny(signed(self, { derivedFrom: origin }))).toEqual({ state: 'denied' });
      // No time limit applies; at most twenty starts per origin do.
      originals.set('origin-session/origin-turn', signed(member));
      const execution = gate();
      for (let index = 0; index < 21; index++) {
        const userTurnId = `bounded-${index}`;
        originals.set(`child-session/${userTurnId}`, signed(self, { derivedFrom: origin }));
        const result = await Effect.runPromise(
          execution.claim({ ...derived, userTurnId, localProjectIds: ['shared-project'] })
        );
        expect(result.state).toBe(index < 20 ? 'claimed' : 'denied');
      }
      expect(authorized.every(([device]) => device === member)).toBe(true);
    });

    it('decides at write time: owner unchanged, member only from its active turn on this machine', () => {
      const decide = (
        live: 'owner' | 'member' | undefined,
        verified: 'owner' | 'member' | 'denied',
        targetMachineId = 'machine'
      ) => decideEncryptedDerivation({ live, verified, targetMachineId, machineId: 'machine' });
      expect(decide('owner', 'denied', 'other-machine')).toBe('owner');
      expect(decide(undefined, 'owner')).toBe('owner');
      expect(decide('member', 'member')).toBe('member');
      expect(() => decide('member', 'member', 'other-machine')).toThrow(
        'e2ee_derivation_cross_machine_unsupported'
      );
      // Ended or over-limit member turns, unverifiable origins and mismatches fail closed.
      for (const [live, verified] of [
        [undefined, 'member'],
        [undefined, 'denied'],
        ['member', 'denied'],
        ['member', 'owner'],
      ] as const)
        expect(() => decide(live, verified)).toThrow('e2ee_derivation_denied');
    });

    it('classifies the driving turn by its verified signer and reports member origins', async () => {
      const execution = gate();
      expect(await Effect.runPromise(execution.classifyOrigin(origin))).toBe('member');
      originals.set('origin-session/origin-turn', signed(owner));
      expect(await Effect.runPromise(execution.classifyOrigin(origin))).toBe('owner');
      originals.set('origin-session/origin-turn', signed(self));
      expect(await Effect.runPromise(execution.classifyOrigin(origin))).toBe('owner');
      originals.set('origin-session/origin-turn', signed(self, { derivedFrom: origin }));
      expect(await Effect.runPromise(execution.classifyOrigin(origin))).toBe('denied');
      originals.delete('origin-session/origin-turn');
      expect(await Effect.runPromise(execution.classifyOrigin(origin))).toBe('denied');
      // A member's own turn reports its verified device for derivation and agent control.
      originals.set('member-session/member-turn', signed(member));
      expect(
        await Effect.runPromise(
          execution.claim({
            ...derived,
            sessionId: 'member-session',
            userTurnId: 'member-turn',
            localProjectIds: ['shared-project'],
          })
        )
      ).toMatchObject({
        state: 'claimed',
        principal: 'member',
        origin: { requesterDevice: member },
      });
      expect(
        await Effect.runPromise(execution.authorizeAgentControl(member, ['shared-project']))
      ).toBe(true);
      expect(
        await Effect.runPromise(execution.authorizeAgentControl(member, ['private-project']))
      ).toBe(false);
    });
  });
});
