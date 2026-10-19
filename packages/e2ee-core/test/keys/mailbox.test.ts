import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Effect, Result, Deferred, Fiber, Scope, Exit } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import * as Reports from '@lody/e2ee-core/protocol';
import * as Envelopes from '@lody/e2ee-core/protocol';
import { envelopeFixture } from './fixture';
const ok = <A, E>(r: Result.Result<A, E>) => Result.getOrThrow(r);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const dirs: string[] = [];
const file = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2ee-mailbox-'));
  dirs.push(dir);
  return path.join(dir, 'mailbox.sqlite');
};
const ownedTestRuns = new Set<() => Promise<void>>();
afterEach(async () => {
  try {
    for (const finish of ownedTestRuns) await finish();
  } finally {
    ownedTestRuns.clear();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
});
const ownTestRun = () => {
  const controller = new AbortController();
  let active: Promise<unknown> | undefined;
  ownedTestRuns.add(async () => {
    controller.abort();
    // The test already owns any failure; interruption cleanup must settle before file removal.
    await active?.catch(() => undefined);
  });
  return <A, E>(effect: Effect.Effect<A, E>) => {
    const result = Effect.runPromise(effect, { signal: controller.signal });
    active = result;
    return result;
  };
};
const target = (f: ReturnType<typeof envelopeFixture>) => ({
  genesis: hex(f.context.genesis.toBytes()),
  epoch: 0,
  recipient: hex(f.phone.raw),
});
const signedReport = (f: ReturnType<typeof envelopeFixture>, frame: Uint8Array, revision = 0) => {
  const context: Reports.InstallationContext = {
    ...target(f),
    commitment: hex(f.view().inspectState().epoch.keyCommitment.toBytes()),
    revision,
    source: {
      _tag: 'Envelope',
      sender: hex(f.owner.raw),
      frameDigest: Reports.mailboxDigest(frame),
    },
  };
  return ok(
    Reports.encodeInstallationReport(
      context,
      f.phone.signBytes(Reports.installationSigningBytes(ok(Reports.installationBody(context))))
    )
  );
};
describe('authenticated SQLite key mailbox', () => {
  it('reads payload and continuation from one WAL snapshot during two public cross-worker repairs', async () => {
    const f = envelopeFixture(),
      dbPath = file();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: dbPath,
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          const sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          const expected: string[] = [];
          for (let n = 0; n < 16; n++) {
            const frame = yield* f.prepare();
            expected.push(Reports.mailboxDigest(frame));
            yield* sender.put(n.toString(16).padStart(32, '0'), frame);
          }
          expected.sort();
          const signal = new SharedArrayBuffer(8),
            state = new Int32Array(signal);
          const worker = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new Worker(new URL('./mailbox-repair.mts', import.meta.url), {
                  execArgv: ['--import', new URL('../worker-loader.mjs', import.meta.url).href],
                  workerData: {
                    file: dbPath,
                    signal,
                    target: target(f),
                    digests: [expected[0], expected[15]],
                  },
                })
            ),
            (ownedWorker) => Effect.promise(() => ownedWorker.terminate())
          );
          const wait = (index: number) => {
            // A real synchronous SQLite SELECT is paused here. The worker's
            // explicit signal, never elapsed time, releases it. The bound is
            // only a harness watchdog; failure cannot count as a repair refusal.
            if (Atomics.load(state, index) === 0) {
              const result = Atomics.wait(state, index, 0, 120_000);
              if (result === 'timed-out')
                throw new Error('Mailbox worker harness failure: watchdog expired');
            }
            if (Atomics.load(state, index) === -1)
              throw new Error('Mailbox worker harness failure: native repair failed');
            expect(Atomics.load(state, index)).toBe(1);
          };
          const native = Database.prototype.prepare;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              Database.prototype.prepare = native;
            })
          );
          let fired = false;
          try {
            wait(0);
            // The shim pauses after a real payload SELECT; it never changes SQL or rows.
            Object.defineProperty(Database.prototype, 'prepare', {
              configurable: true,
              writable: true,
              value: function (query: string) {
                const statement = native.call(this, query) as Database.Statement<unknown[]>;
                if (query.includes('ORDER BY sender,digest LIMIT')) {
                  const all = statement.all;
                  statement.all = function (...args: unknown[]) {
                    const rows = all.apply(this, args);
                    if (!fired) {
                      fired = true;
                      worker.postMessage('repair-now');
                      wait(1);
                    }
                    return rows;
                  };
                }
                return statement;
              },
            });
            const page = yield* recipient.fetch(0, null, 15);
            expect(page.items.map((item) => Reports.mailboxDigest(item.frame))).toEqual(
              expected.slice(0, 15)
            );
            expect(page.next).toBe(`${hex(f.owner.raw)}:${expected[14]}`);
            // Both repairs committed concurrently; a later request sees the new projection.
            const after = yield* recipient.fetch(0, null, 15);
            expect(after.items.map((item) => Reports.mailboxDigest(item.frame))).toEqual(
              expected.slice(1, -1)
            );
            expect(after.next).toBeNull();
          } finally {
            Database.prototype.prepare = native;
          }
        })
      )
    );
  });

  it('persists ciphertext and signed claims, reopens, and repairs without deleting history', async () => {
    const f = envelopeFixture(),
      dbPath = file(),
      frame = await Effect.runPromise(f.prepare());
    const run = (
      mode: 'create' | 'open',
      body: (
        host: Effect.Success<ReturnType<typeof makeSqliteKeyMailbox>>
      ) => Effect.Effect<void, unknown>
    ) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeSqliteKeyMailbox({
              path: dbPath,
              mode,
              genesis: f.context.genesis,
              ledger: f.ledger,
            });
            yield* body(host);
          })
        )
      );
    await run('create', (host) =>
      Effect.gen(function* () {
        const sender = ok(host.bind(f.owner.publicKey)),
          recipient = ok(host.bind(f.phone.publicKey));
        expect((yield* sender.status(target(f))).status).toBe('NeedsEnvelope');
        yield* sender.put('01'.repeat(16), frame);
        expect(yield* sender.read('01'.repeat(16))).toEqual(frame);
        expect((yield* recipient.fetch(0, null, 1)).items[0]?.frame).toEqual(frame);
        expect((yield* recipient.status(target(f))).status).toBe('EnvelopeStored');
        yield* recipient.report(signedReport(f, frame));
        expect((yield* sender.status(target(f))).status).toBe('InstallationReported');
      })
    );
    await run('open', (host) =>
      Effect.gen(function* () {
        const sender = ok(host.bind(f.owner.publicKey)),
          recipient = ok(host.bind(f.phone.publicKey));
        expect((yield* recipient.status(target(f))).status).toBe('InstallationReported');
        yield* recipient.repair(target(f), 'repair-1', Reports.mailboxDigest(frame));
        yield* recipient.repair(target(f), 'repair-1', Reports.mailboxDigest(frame));
        expect(yield* recipient.status(target(f))).toMatchObject({
          status: 'NeedsEnvelope',
          revision: 1,
        });
        expect((yield* recipient.fetch(0, null, 1)).items).toEqual([]);
        expect(yield* sender.read('01'.repeat(16))).toEqual(frame);
        expect(
          Result.isFailure(yield* Effect.result(recipient.report(signedReport(f, frame))))
        ).toBe(true);
        expect(
          Result.isFailure(yield* Effect.result(recipient.repair(target(f), 'repair-1')))
        ).toBe(true);
      })
    );
    const db = new Database(dbPath);
    try {
      expect(db.prepare('SELECT count(*) AS n FROM mailbox_envelopes').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT count(*) AS n FROM mailbox_reports').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
  it('deduplicates authenticated insider ciphertext and keeps an unrelated recipient readable', async () => {
    const run = ownTestRun();
    const f = envelopeFixture(),
      dbPath = file(),
      frame = await run(f.prepare());
    const verified = f.view(),
      ledger = () => Effect.succeed(verified);
    const other = await run(
      Envelopes.prepareEpochEnvelope({
        context: { ...f.context, recipient: f.owner.publicKey },
        key: f.secret,
        signer: f.owner.signer,
        ledger,
      })
    );
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: dbPath,
            mode: 'create',
            genesis: f.context.genesis,
            ledger,
          });
          const sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          for (let n = 0; n < 500; n++) yield* sender.put(n.toString(16).padStart(32, '0'), frame);
          yield* sender.put('ff'.repeat(16), other);
          const received = yield* recipient.fetch(0, null, 1);
          expect(received).toEqual({ items: [{ sender: hex(f.owner.raw), frame }], next: null });
          expect((yield* sender.fetch(0, null, 1)).items[0]?.frame).toEqual(other);
        })
      )
    );
    const db = new Database(dbPath);
    try {
      expect(db.prepare('SELECT count(*) AS n FROM mailbox_envelopes').get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
  it('binds sender and reporting recipient to authenticated principals and fixes signature verification', async () => {
    const f = envelopeFixture(),
      frame = await Effect.runPromise(f.prepare());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: file(),
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          const sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          expect(
            Result.isFailure(yield* Effect.result(recipient.put('01'.repeat(16), frame)))
          ).toBe(true);
          const forged = new Uint8Array(frame);
          forged[forged.length - 1] ^= 1;
          expect(Result.isFailure(yield* Effect.result(sender.put('01'.repeat(16), forged)))).toBe(
            true
          );
          expect(
            Result.isFailure(yield* Effect.result(recipient.report(signedReport(f, frame))))
          ).toBe(true);
          yield* sender.put('01'.repeat(16), frame);
          expect(
            Result.isFailure(yield* Effect.result(sender.report(signedReport(f, frame))))
          ).toBe(true);
          const report = signedReport(f, frame);
          report[report.length - 1] ^= 1;
          expect(Result.isFailure(yield* Effect.result(recipient.report(report)))).toBe(true);
          expect((yield* recipient.status(target(f))).status).toBe('EnvelopeStored');
        })
      )
    );
  });
  it('rejects persisted rollback after reopening and preserves another authority observation', async () => {
    const f = envelopeFixture(),
      dbPath = file(),
      old = f.view();
    f.append([5, f.phone.raw]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: dbPath,
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          expect((yield* ok(host.bind(f.owner.publicKey)).status(target(f))).status).toBe(
            'Ineligible'
          );
        })
      )
    );
    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeSqliteKeyMailbox({
              path: dbPath,
              mode: 'open',
              genesis: f.context.genesis,
              ledger: () => Effect.succeed(old),
            });
            yield* ok(host.bind(f.owner.publicKey)).status(target(f));
          })
        )
      )
    );
    expect(Result.isFailure(result)).toBe(true);
    const db = new Database(dbPath);
    try {
      expect(db.prepare('SELECT count FROM mailbox_meta').get()).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });
  it('rejects foreign files and operations after Scope closes', async () => {
    const f = envelopeFixture(),
      dbPath = file();
    writeFileSync(dbPath, 'foreign');
    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          makeSqliteKeyMailbox({
            path: dbPath,
            mode: 'open',
            genesis: f.context.genesis,
            ledger: f.ledger,
          })
        )
      )
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(readFileSync(dbPath, 'utf8')).toBe('foreign');
    const session = await Effect.runPromise(
      Effect.scoped(
        Effect.map(
          makeSqliteKeyMailbox({
            path: file(),
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          }),
          (host) => ok(host.bind(f.owner.publicKey))
        )
      )
    );
    const closed = await Effect.runPromise(Effect.result(session.status(target(f))));
    expect(Result.isFailure(closed) && closed.failure).toMatchObject({ code: 'closed' });
  });
  it('validates cursors before reading rows and isolates unrelated oversized storage corruption', async () => {
    const f = envelopeFixture(),
      dbPath = file(),
      frame = await Effect.runPromise(f.prepare());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
              path: dbPath,
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            }),
            sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          yield* sender.put('01'.repeat(16), frame);
          const db = new Database(dbPath);
          try {
            db.pragma('ignore_check_constraints=ON');
            db.prepare('INSERT INTO mailbox_envelopes VALUES(?,?,?,?,?,?)').run(
              0,
              hex(f.owner.raw),
              hex(f.owner.raw),
              '02'.repeat(16),
              'ff'.repeat(32),
              new Uint8Array(513)
            );
          } finally {
            db.close();
          }
          expect((yield* recipient.fetch(0, null, 1)).items[0]?.frame).toEqual(frame);
          expect(Result.isFailure(yield* Effect.result(recipient.fetch(0, '2', 1)))).toBe(true);
          expect(Result.isFailure(yield* Effect.result(recipient.fetch(0, null, 101)))).toBe(true);
          expect(Result.isFailure(yield* Effect.result(sender.fetch(0, null, 1)))).toBe(true);
        })
      )
    );
  });
  it('captures ciphertext before waiting and rejects revocation observed during admission', async () => {
    const f = envelopeFixture(),
      frame = await Effect.runPromise(f.prepare()),
      original = new Uint8Array(frame);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          let pause = true;
          const ledger = () =>
            Effect.gen(function* () {
              if (pause) {
                pause = false;
                yield* Deferred.succeed(reached, undefined);
                yield* Deferred.await(release);
              }
              return f.view();
            });
          const host = yield* makeSqliteKeyMailbox({
            path: file(),
            mode: 'create',
            genesis: f.context.genesis,
            ledger,
          });
          const sender = ok(host.bind(f.owner.publicKey));
          const worker = yield* Effect.forkChild(sender.put('01'.repeat(16), frame));
          yield* Deferred.await(reached);
          frame.fill(0);
          yield* Deferred.succeed(release, undefined);
          expect(Exit.isSuccess(yield* Fiber.await(worker))).toBe(true);
          expect(yield* sender.read('01'.repeat(16))).toEqual(original);
          f.append([5, f.phone.raw]);
          expect(
            Result.isFailure(yield* Effect.result(sender.put('02'.repeat(16), original)))
          ).toBe(true);
        })
      )
    );
  });
  it('awaits caller work explicitly and closes without a late write while a borrowed ledger is pending', async () => {
    const f = envelopeFixture(),
      dbPath = file(),
      frame = await Effect.runPromise(f.prepare());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>(),
            scope = yield* Scope.make();
          const ledger = () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
              return f.view();
            });
          const host = yield* Scope.provide(
            makeSqliteKeyMailbox({
              path: dbPath,
              mode: 'create',
              genesis: f.context.genesis,
              ledger,
            }),
            scope
          );
          const worker = yield* Effect.forkChild(
            ok(host.bind(f.owner.publicKey)).put('01'.repeat(16), frame)
          );
          yield* Deferred.await(reached);
          yield* Scope.close(scope, Exit.void);
          yield* Deferred.succeed(release, undefined);
          expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true);
        })
      )
    );
    const db = new Database(dbPath);
    try {
      expect(db.prepare('SELECT count(*) AS n FROM mailbox_envelopes').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
  it('rejects the old JSON schema before mutating its SQLite file', async () => {
    const f = envelopeFixture(),
      dbPath = file(),
      db = new Database(dbPath);
    db.exec(
      "CREATE TABLE document (text TEXT); INSERT INTO document VALUES ('original'); PRAGMA application_id=1279610161; PRAGMA user_version=1;"
    );
    db.close();
    const before = readFileSync(dbPath);
    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          makeSqliteKeyMailbox({
            path: dbPath,
            mode: 'open',
            genesis: f.context.genesis,
            ledger: f.ledger,
          })
        )
      )
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(readFileSync(dbPath)).toEqual(before);
  });
  it('continues 16 real envelopes in 15/1 keyset pages without loading a lookahead ciphertext', async () => {
    const f = envelopeFixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: file(),
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          const sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          const expected: Uint8Array[] = [];
          for (let n = 0; n < 16; n++) {
            const frame = yield* f.prepare();
            expected.push(frame);
            yield* sender.put(n.toString(16).padStart(32, '0'), frame);
          }
          const first = yield* recipient.fetch(0, null, 15);
          expect(first.items).toHaveLength(15);
          expect(first.next).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
          const second = yield* recipient.fetch(0, first.next, 15);
          expect(second.items).toHaveLength(1);
          expect(second.next).toBe(null);
          const observed = [...first.items, ...second.items]
            .map((row) => Reports.mailboxDigest(row.frame))
            .sort();
          expect(observed).toEqual(expected.map(Reports.mailboxDigest).sort());
          expect(yield* recipient.fetch(0, 'ff'.repeat(32) + ':' + 'ff'.repeat(32), 100)).toEqual({
            items: [],
            next: null,
          });
          expect(Result.isFailure(yield* Effect.result(recipient.fetch(0, '102', 100)))).toBe(true);
        })
      )
    );
  });
});

describe('verified mailbox observations across failed pin writes', () => {
  it.each(['abort', 'ignore', 'rewrite-head', 'rewrite-context'] as const)(
    'retains genuine revocation and rolls back %s metadata writes',
    async (fault) => {
      const f = envelopeFixture(),
        old = f.view(),
        dbPath = file();
      let current = old;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeSqliteKeyMailbox({
              path: dbPath,
              mode: 'create',
              genesis: f.context.genesis,
              ledger: () => Effect.succeed(current),
            });
            const sender = ok(host.bind(f.owner.publicKey)),
              receiver = ok(host.bind(f.phone.publicKey));
            yield* sender.put('ae'.repeat(16), yield* f.prepare());
            expect((yield* receiver.fetch(0, null, 100)).items).toHaveLength(1);
            const db = new Database(dbPath);
            try {
              if (fault === 'abort' || fault === 'ignore')
                db.exec(
                  `CREATE TRIGGER fail_pin BEFORE UPDATE ON mailbox_meta BEGIN SELECT RAISE(${fault === 'abort' ? "ABORT,'fault'" : 'IGNORE'}); END`
                );
              else
                db.exec(
                  `CREATE TRIGGER fail_pin AFTER UPDATE ON mailbox_meta BEGIN UPDATE mailbox_meta SET ${fault === 'rewrite-head' ? `head=x'${hex(old.head.toBytes())}',count=2` : "genesis='" + '00'.repeat(32) + "'"} WHERE id=1; END`
                );
              f.append([5, f.phone.raw]);
              current = f.view();
              expect(Exit.isFailure(yield* Effect.exit(receiver.fetch(0, null, 100)))).toBe(true);
              expect(db.prepare('SELECT genesis,count FROM mailbox_meta WHERE id=1').get()).toEqual(
                { genesis: hex(f.context.genesis.toBytes()), count: 2 }
              );
              db.exec('DROP TRIGGER fail_pin');
              current = old;
              expect(
                Exit.isFailure(yield* Effect.exit(receiver.fetch(0, null, 100))),
                'in-memory verified revocation must survive storage failure'
              ).toBe(true);
              expect(db.prepare('SELECT COUNT(*) AS n FROM mailbox_envelopes').get()).toEqual({
                n: 1,
              });
            } finally {
              db.close();
            }
          })
        )
      );
    }
  );
  it('does not pin a cloned view on storage failure paths', async () => {
    const f = envelopeFixture(),
      original = f.view(),
      dbPath = file();
    let current = original;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: dbPath,
            mode: 'create',
            genesis: f.context.genesis,
            ledger: () => Effect.succeed(current),
          });
          const sender = ok(host.bind(f.owner.publicKey)),
            receiver = ok(host.bind(f.phone.publicKey));
          yield* sender.put('be'.repeat(16), yield* f.prepare());
          current = { ...original } as typeof original;
          expect(Exit.isFailure(yield* Effect.exit(receiver.fetch(0, null, 100)))).toBe(true);
          current = original;
          expect((yield* receiver.fetch(0, null, 100)).items).toHaveLength(1);
        })
      )
    );
  });
});

it('uses stable sender/digest cursors across rejection and insertion and caps each sender at 16 live envelopes', async () => {
  const f = envelopeFixture(),
    dbPath = file();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* makeSqliteKeyMailbox({
          path: dbPath,
          mode: 'create',
          genesis: f.context.genesis,
          ledger: f.ledger,
        });
        const sender = ok(host.bind(f.owner.publicKey)),
          recipient = ok(host.bind(f.phone.publicKey));
        const frames: Uint8Array[] = [];
        for (let index = 0; index < 16; index++) {
          const frame = yield* f.prepare();
          frames.push(frame);
          yield* sender.put(index.toString(16).padStart(32, '0'), frame);
        }
        const extra = yield* f.prepare();
        expect(yield* Effect.result(sender.put('ff'.repeat(16), extra))).toMatchObject({
          _tag: 'Failure',
          failure: { code: 'replay' },
        });
        const first = yield* recipient.fetch(0, null, 5);
        expect(first.items).toHaveLength(5);
        expect(first.next).not.toBeNull();
        const sorted = frames
          .map((frame) => ({ frame, digest: Reports.mailboxDigest(frame) }))
          .sort((a, b) => a.digest.localeCompare(b.digest));
        yield* recipient.repair(target(f), 'reject-first', sorted[0]!.digest);
        yield* sender.put('ff'.repeat(16), extra);
        const second = yield* recipient.fetch(0, first.next, 100);
        const cursor = first.next!.split(':')[1]!;
        const expected = [...sorted.slice(1).map((row) => row.digest), Reports.mailboxDigest(extra)]
          .filter((digest) => digest > cursor)
          .sort();
        expect(second.items.map((row) => Reports.mailboxDigest(row.frame))).toEqual(expected);
        expect(
          new Set([...first.items, ...second.items].map((row) => Reports.mailboxDigest(row.frame)))
            .size
        ).toBe(first.items.length + second.items.length);
        // Re-inserting the first original is idempotent even at capacity.
        yield* sender.put('ff'.repeat(16), extra);
      })
    )
  );
});
