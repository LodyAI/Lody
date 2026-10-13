import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Deferred, Effect, Fiber, Result, Scope, Exit } from 'effect';
import {
  SubmissionJournal,
  SubmissionRemote,
  SubmissionRemoteError,
  submitRecord,
  resumeSubmission,
  acknowledgeSubmission,
} from '@lody/e2ee-core/submission';
import { sqliteSubmissionJournal } from '@lody/e2ee-core/submission/sqlite';
import { anchor, checkpoint, filled, genesis, host, keys, owner, rotate, signed } from './fixture';
import { hashRecordBytes } from '../../src/ledger';
const fixture = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p09-'));
  const journal = path.join(dir, 'journal.sqlite');
  const remote = host(path.join(dir, 'host.sqlite'));
  return {
    dir,
    journal,
    remote,
    close: () => {
      remote.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
const errorCode = <A, E>(r: Result.Result<A, E>) =>
  Result.isFailure(r) ? (r.failure as { code: string }).code : 'success';
const using = <A, E, R>(
  f: ReturnType<typeof fixture>,
  effect: Effect.Effect<A, E, R>,
  remote = f.remote.service
) =>
  effect.pipe(
    Effect.provideService(SubmissionRemote, remote),
    Effect.provide(sqliteSubmissionJournal(f.journal))
  );

describe('durable submission', () => {
  it('persists before CAS; lost response reads back the original, result survives close', async () => {
    const f = fixture();
    const record = rotate();
    try {
      const service = {
        ...f.remote.service,
        appendCas: (
          _anchor: typeof anchor,
          expected: Parameters<typeof f.remote.service.appendCas>[1],
          raw: Uint8Array
        ) =>
          Effect.gen(function* () {
            const disk = new Database(f.journal, { readonly: true });
            try {
              expect(
                new Uint8Array(
                  (
                    disk.prepare('SELECT pending FROM submission_journal').get() as {
                      pending: Uint8Array;
                    }
                  ).pending
                )
              ).toEqual(record);
            } finally {
              disk.close();
            }
            yield* f.remote.service.appendCas(_anchor, expected, raw);
            return yield* new SubmissionRemoteError();
          }),
      };
      const result = await Effect.runPromise(using(f, submitRecord(anchor, record), service));
      expect(result).toEqual({ outcome: 'Committed', record });
      expect(f.remote.read()).toEqual([genesis, record]);
      const reopened = await Effect.runPromise(using(f, resumeSubmission(anchor)));
      expect(reopened).toEqual(result);
      const db = new Database(f.journal, { readonly: true });
      try {
        const row = db
          .prepare('SELECT pending, result_record, outcome FROM submission_journal')
          .get() as { pending: null; result_record: Uint8Array; outcome: string };
        expect(row.pending).toBeNull();
        expect(new Uint8Array(row.result_record)).toEqual(record);
        expect(row.outcome).toBe('Committed');
      } finally {
        db.close();
      }
      await Effect.runPromise(using(f, acknowledgeSubmission(anchor, result)));
      expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toBeNull();
    } finally {
      f.close();
    }
  });

  it.each(['before-cas', 'lost-response'])(
    'independent process crash at %s recovers exact bytes',
    (mode) => {
      const f = fixture();
      try {
        const require = createRequire(import.meta.url);
        const run = (processMode: string) =>
          spawnSync(
            process.execPath,
            [
              '--import',
              require.resolve('tsx'),
              path.join(import.meta.dirname, 'reopen.ts'),
              processMode,
              f.journal,
              path.join(f.dir, 'host.sqlite'),
            ],
            { encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_OPTIONS: '' } }
          );
        const crashed = run(mode);
        expect(crashed.error).toBeUndefined();
        expect(crashed.signal).toBeNull();
        expect(crashed.status).toBe(mode === 'before-cas' ? 71 : 72);
        const reopened = run('reopen');
        expect(reopened.error, reopened.stderr).toBeUndefined();
        expect(reopened.signal).toBeNull();
        expect(reopened.status, reopened.stderr).toBe(0);
        expect(JSON.parse(reopened.stdout)).toEqual({
          result: 'Committed',
          record: Buffer.from(rotate()).toString('hex'),
          phase: 'Committed',
          hostLength: 2,
        });
        expect(f.remote.read()).toEqual([genesis, rotate()]);
      } finally {
        f.close();
      }
    }
  );

  it('rejects different-body duplicates, retains conflict and requires exact acknowledgement', async () => {
    const f = fixture();
    const record = rotate();
    try {
      await Effect.runPromise(
        using(
          f,
          Effect.gen(function* () {
            const j = yield* SubmissionJournal;
            yield* j.prepare(anchor, record);
          })
        )
      );
      expect(
        errorCode(
          await Effect.runPromise(
            using(f, Effect.result(submitRecord(anchor, rotate(undefined, 22))))
          )
        )
      ).toBe('busy');
      f.remote.append(rotate(undefined, 23));
      const result = await Effect.runPromise(using(f, resumeSubmission(anchor)));
      expect(result).toEqual({ outcome: 'Conflict', record });
      expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toEqual(result);
      expect(
        errorCode(
          await Effect.runPromise(
            using(
              f,
              Effect.result(
                acknowledgeSubmission(anchor, {
                  outcome: 'Conflict',
                  record: rotate(undefined, 22),
                })
              )
            )
          )
        )
      ).toBe('busy');
      expect(f.remote.read()).toEqual([genesis, rotate(undefined, 23)]);
    } finally {
      f.close();
    }
  });

  it('SQLite terminal failure rolls back pending removal and recovers on reopen', async () => {
    const f = fixture();
    const record = rotate();
    try {
      await Effect.runPromise(
        using(
          f,
          Effect.gen(function* () {
            const j = yield* SubmissionJournal;
            yield* j.prepare(anchor, record);
          })
        )
      );
      const db = new Database(f.journal);
      db.exec(
        "CREATE TRIGGER fail_terminal BEFORE UPDATE OF outcome ON submission_journal WHEN NEW.outcome IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected'); END"
      );
      db.close();
      expect(
        errorCode(await Effect.runPromise(using(f, Effect.result(submitRecord(anchor, record)))))
      ).toBe('storage');
      const disk = new Database(f.journal);
      try {
        const r = disk.prepare('SELECT pending,result_record FROM submission_journal').get() as {
          pending: Uint8Array;
          result_record: null;
        };
        expect(new Uint8Array(r.pending)).toEqual(record);
        expect(r.result_record).toBeNull();
        disk.exec('DROP TRIGGER fail_terminal');
      } finally {
        disk.close();
      }
      expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toEqual({
        outcome: 'Committed',
        record,
      });
      expect(f.remote.read()).toEqual([genesis, record]);
    } finally {
      f.close();
    }
  });

  it('unauthorized signed pending and forged terminal status cannot mint authority', async () => {
    const f = fixture();
    const attacker = keys(7);
    const record = signed(
      [hashRecordBytes(genesis).toBytes(), attacker.pk, [7, 1, filled(21), filled(30, 72)]],
      attacker
    );
    try {
      expect(
        errorCode(await Effect.runPromise(using(f, Effect.result(submitRecord(anchor, record)))))
      ).toBe('unauthorized');
      await Effect.runPromise(
        using(
          f,
          Effect.gen(function* () {
            const j = yield* SubmissionJournal;
            yield* j.prepare(anchor, record);
          })
        )
      );
      expect(
        errorCode(await Effect.runPromise(using(f, Effect.result(resumeSubmission(anchor)))))
      ).toBe('unauthorized');
      expect(f.remote.read()).toEqual([genesis]);
      const disk = new Database(f.journal);
      disk
        .prepare(
          "UPDATE submission_journal SET pending = NULL, result_record = ?, outcome = 'Committed'"
        )
        .run(rotate());
      disk.close();
      expect(
        errorCode(await Effect.runPromise(using(f, Effect.result(resumeSubmission(anchor)))))
      ).toBe('corrupt-journal');
    } finally {
      f.close();
    }
  });

  it('bad suffix/rollback preserves last pin and pending, never skips to a new checkpoint', async () => {
    const f = fixture();
    const record = rotate();
    try {
      await Effect.runPromise(
        using(
          f,
          Effect.gen(function* () {
            const j = yield* SubmissionJournal;
            yield* j.prepare(anchor, record);
            yield* j.observe(anchor, record, null, checkpoint([genesis]));
          })
        )
      );
      const invalid = new Uint8Array(rotate());
      invalid[invalid.length - 1] ^= 1;
      const service = {
        ...f.remote.service,
        read: () =>
          Effect.succeed({
            records: [genesis, invalid],
            checkpoint: checkpoint([genesis, invalid]),
          }),
      };
      expect(
        errorCode(
          await Effect.runPromise(using(f, Effect.result(resumeSubmission(anchor)), service))
        )
      ).toBe('bad-signature');
      expect(
        (
          await Effect.runPromise(
            using(
              f,
              Effect.gen(function* () {
                return yield* (yield* SubmissionJournal).load(anchor);
              })
            )
          )
        ).record
      ).toEqual(record);
      const result = await Effect.runPromise(using(f, resumeSubmission(anchor)));
      expect(result?.outcome).toBe('Committed');
      const rollback = {
        ...f.remote.service,
        read: () => Effect.succeed({ records: [genesis], checkpoint: checkpoint([genesis]) }),
      };
      expect(
        errorCode(
          await Effect.runPromise(using(f, Effect.result(resumeSubmission(anchor)), rollback))
        )
      ).toBe('rollback');
    } finally {
      f.close();
    }
  });

  it('pending-save failure prevents CAS, while post-CAS read failure retains the original', async () => {
    const f = fixture();
    const record = rotate();
    try {
      await Effect.runPromise(using(f, Effect.void));
      const disk = new Database(f.journal);
      disk.exec(
        "CREATE TRIGGER fail_prepare BEFORE INSERT ON submission_journal BEGIN SELECT RAISE(ABORT, 'injected'); END"
      );
      disk.close();
      expect(
        errorCode(await Effect.runPromise(using(f, Effect.result(submitRecord(anchor, record)))))
      ).toBe('storage');
      expect(f.remote.read()).toEqual([genesis]);
      const remove = new Database(f.journal);
      remove.exec('DROP TRIGGER fail_prepare');
      remove.close();
      const service = {
        ...f.remote.service,
        read: () =>
          f.remote.read().length > 1
            ? Effect.fail(new SubmissionRemoteError())
            : f.remote.service.read(anchor),
      };
      const failed = await Effect.runPromise(
        using(f, Effect.result(submitRecord(anchor, record)), service)
      );
      expect(Result.isFailure(failed) && failed.failure._tag).toBe('SubmissionRemoteError');
      const entry = await Effect.runPromise(
        using(
          f,
          Effect.gen(function* () {
            return yield* (yield* SubmissionJournal).load(anchor);
          })
        )
      );
      expect(entry.record).toEqual(record);
      expect(entry.outcome).toBeNull();
      expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toEqual({
        outcome: 'Committed',
        record,
      });
    } finally {
      f.close();
    }
  });

  it('unconfirmed CAS remains pending and retries the same bytes on the next invocation', async () => {
    const f = fixture();
    const record = rotate();
    try {
      const service = { ...f.remote.service, appendCas: () => Effect.void };
      expect(
        errorCode(
          await Effect.runPromise(using(f, Effect.result(submitRecord(anchor, record)), service))
        )
      ).toBe('unconfirmed');
      expect(f.remote.read()).toEqual([genesis]);
      expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toEqual({
        outcome: 'Committed',
        record,
      });
    } finally {
      f.close();
    }
  });

  it('foreign/missing history does not manufacture a conflict or trust a local Owner row', async () => {
    const f = fixture();
    const record = rotate();
    try {
      await Effect.runPromise(
        using(
          f,
          Effect.gen(function* () {
            yield* (yield* SubmissionJournal).prepare(anchor, record);
          })
        )
      );
      const foreign = signed([1, owner.pk, filled(11), filled(11, 16), filled(102), filled(22)]);
      for (const records of [[foreign], [record]]) {
        const service = {
          ...f.remote.service,
          read: () => Effect.succeed({ records, checkpoint: checkpoint(records) }),
        };
        expect(
          Result.isFailure(
            await Effect.runPromise(using(f, Effect.result(resumeSubmission(anchor)), service))
          )
        ).toBe(true);
      }
      expect(f.remote.read()).toEqual([genesis]);
      expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toEqual({
        outcome: 'Committed',
        record,
      });
    } finally {
      f.close();
    }
    const old = fixture();
    try {
      const disk = new Database(old.journal);
      disk.exec('CREATE TABLE journal (owner TEXT)');
      disk.close();
      expect(
        errorCode(
          await Effect.runPromise(using(old, submitRecord(anchor, record)).pipe(Effect.result))
        )
      ).toBe('corrupt-journal');
    } finally {
      old.close();
    }
  });

  it('a valid original signed by a subsequently revoked device ends as Conflict, without re-signing', async () => {
    const f = fixture();
    const phone = keys(2);
    try {
      const proofBody = Result.getOrThrow(
        (await import('../../src/cbor')).encodeCbor([
          anchor.toBytes(),
          filled(10, 16),
          phone.pk,
          filled(102),
          0,
        ])
      );
      const proof = phone.sign(Buffer.concat([Buffer.from('lody-e2ee/possess/v2\0'), proofBody]));
      const admitted = signed([
        hashRecordBytes(genesis).toBytes(),
        owner.pk,
        [4, 0, phone.pk, filled(102), proof],
      ]);
      f.remote.append(admitted);
      const original = signed(
        [hashRecordBytes(admitted).toBytes(), phone.pk, [7, 1, filled(21), filled(30, 72)]],
        phone
      );
      await Effect.runPromise(
        using(
          f,
          Effect.gen(function* () {
            yield* (yield* SubmissionJournal).prepare(anchor, original);
          })
        )
      );
      const revoked = signed([hashRecordBytes(admitted).toBytes(), owner.pk, [5, phone.pk]]);
      f.remote.append(revoked);
      expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toEqual({
        outcome: 'Conflict',
        record: original,
      });
      expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toEqual({
        outcome: 'Conflict',
        record: original,
      });
      expect(f.remote.read()).toEqual([genesis, admitted, revoked]);
    } finally {
      f.close();
    }
  });

  it('Scope closes the real database handle without deleting the durable pending', async () => {
    const f = fixture();
    let captured: SubmissionJournal['Service'] | undefined;
    try {
      await Effect.runPromise(
        using(
          f,
          Effect.gen(function* () {
            captured = yield* SubmissionJournal;
            yield* captured.prepare(anchor, rotate());
          })
        )
      );
      expect(errorCode(await Effect.runPromise(Effect.result(captured!.load(anchor))))).toBe(
        'storage'
      );
      expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toEqual({
        outcome: 'Committed',
        record: rotate(),
      });
    } finally {
      f.close();
    }
  });

  it('a submitted attempt cannot recover another task installed before its resume step', async () => {
    const f = fixture();
    try {
      await Effect.runPromise(
        using(
          f,
          Effect.gen(function* () {
            const journal = yield* SubmissionJournal;
            const prepared = yield* Deferred.make<void>();
            const proceed = yield* Deferred.make<void>();
            const paused = {
              ...journal,
              prepare: (a: typeof anchor, r: Uint8Array) =>
                journal
                  .prepare(a, r)
                  .pipe(
                    Effect.andThen(Deferred.succeed(prepared, undefined)),
                    Effect.andThen(Deferred.await(proceed))
                  ),
            };
            const original = rotate();
            const caller = yield* Effect.forkChild(
              Effect.result(
                submitRecord(anchor, original).pipe(
                  Effect.provideService(SubmissionJournal, paused)
                )
              )
            );
            yield* Deferred.await(prepared);
            const completed = yield* resumeSubmission(anchor);
            expect(completed?.outcome).toBe('Committed');
            yield* acknowledgeSubmission(anchor, completed!);
            const next = signed([
              hashRecordBytes(original).toBytes(),
              owner.pk,
              [7, 2, filled(22), filled(30, 72)],
            ]);
            yield* journal.prepare(anchor, next);
            yield* Deferred.succeed(proceed, undefined);
            expect(errorCode(yield* Fiber.join(caller))).toBe('busy');
            expect(f.remote.read()).toEqual([genesis, original]);
            expect((yield* journal.load(anchor)).record).toEqual(next);
            expect((yield* resumeSubmission(anchor))?.outcome).toBe('Committed');
          })
        )
      );
    } finally {
      f.close();
    }
  });

  it('two independent handles cannot replace pending or erase an unconsumed result', async () => {
    const f = fixture();
    try {
      await Effect.runPromise(
        using(
          f,
          Effect.gen(function* () {
            yield* (yield* SubmissionJournal).prepare(anchor, rotate());
          })
        )
      );
      expect(
        errorCode(
          await Effect.runPromise(
            using(
              f,
              Effect.result(
                Effect.gen(function* () {
                  yield* (yield* SubmissionJournal).prepare(anchor, rotate(undefined, 22));
                })
              )
            )
          )
        )
      ).toBe('busy');
      const result = await Effect.runPromise(using(f, submitRecord(anchor, rotate())));
      expect(result.outcome).toBe('Committed');
      expect(
        errorCode(
          await Effect.runPromise(
            using(f, Effect.result(submitRecord(anchor, rotate(undefined, 22))))
          )
        )
      ).toBe('busy');
    } finally {
      f.close();
    }
  });
});

it('Scope interruption during CAS retains pending; next Scope reopens and recovers', async () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture();
        yield* Effect.addFinalizer(() => Effect.sync(() => f.close()));
        const started = yield* Deferred.make<void>();
        const scoped = yield* Scope.make();
        const service = {
          ...f.remote.service,
          appendCas: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
        };
        const fiber = yield* Effect.forkChild(
          Scope.provide(using(f, submitRecord(anchor, rotate()), service), scoped)
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        yield* Scope.close(scoped, Exit.void);
        expect(f.remote.read()).toEqual([genesis]);
        expect(yield* using(f, resumeSubmission(anchor))).toEqual({
          outcome: 'Committed',
          record: rotate(),
        });
      })
    )
  ));
