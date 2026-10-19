import { Worker } from 'node:worker_threads';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Effect, Result, Deferred, Fiber, Scope, Exit } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSqliteEpochReceiver, type ReceiveMailboxRemote } from './harness';
import { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { makeSqliteProtectedEpochKeys } from './harness';
import { commitEpochKey } from '@lody/e2ee-core/protocol';
import * as Reports from '@lody/e2ee-core/protocol';
import type { LedgerView } from '@lody/e2ee-core/protocol';
import type { DeviceSigner } from '@lody/e2ee-core/protocol';
import { ContentError } from '../../src/internal/foundation/errors';
import { envelopeFixture, recipientPair } from './fixture';
import { synthetic } from './protection-fixture';
const ok = Result.getOrThrow,
  hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const dirs: string[] = [];
const directory = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2ee-receive-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const target = (f: ReturnType<typeof envelopeFixture>) => ({
  genesis: hex(f.context.genesis.toBytes()),
  epoch: 0,
  recipient: hex(f.phone.raw),
});
const rows = (file: string) => {
  const db = new Database(file);
  try {
    return db.prepare('SELECT id,phase,report FROM receive_tasks ORDER BY id').all() as {
      id: string;
      phase: string;
      report: Uint8Array | null;
    }[];
  } finally {
    db.close();
  }
};
describe('durable finite epoch receive and original-report queue', () => {
  it('persists and reloads the key before signing; retries a lost ACK from original bytes after reopening without signer use', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      keyFile = path.join(dir, 'keys.sqlite'),
      journal = path.join(dir, 'receive.sqlite'),
      frame = await Effect.runPromise(f.prepare());
    const originals: Uint8Array[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: path.join(dir, 'mailbox.sqlite'),
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          const sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          yield* sender.put('01'.repeat(16), frame);
          let loseAck = true;
          const remote: ReceiveMailboxRemote = {
            status: recipient.status,
            report: (bytes, publication) =>
              Effect.gen(function* () {
                originals.push(new Uint8Array(bytes));
                yield* recipient.report(bytes, publication);
                if (loseAck) {
                  loseAck = false;
                  return yield* new ContentError({ code: 'sign-failed' });
                }
                return undefined;
              }),
          };
          const signer: DeviceSigner = {
            publicKey: f.phone.publicKey,
            sign: (message) =>
              Effect.gen(function* () {
                // Actual fresh disk read/decrypt, not a mock-call-count ordering assertion.
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const store = yield* makeSqliteProtectedEpochKeys({
                      path: keyFile,
                      mode: 'open',
                      genesis: f.context.genesis,
                      recipient: f.phone.publicKey,
                      ledger: f.ledger,
                      protector: native.protector,
                    });
                    const key = yield* store.read(0);
                    expect(ok(commitEpochKey(f.context.genesis, 0, key))).toEqual(
                      ok(commitEpochKey(f.context.genesis, 0, f.secret))
                    );
                  })
                );
                return yield* f.phone.signer.sign(message);
              }).pipe(Effect.mapError(() => new ContentError({ code: 'sign-failed' }))),
          };
          const config = {
            path: journal,
            genesis: f.context.genesis,
            signer,
            pair,
            ledger: f.ledger,
            remote,
          };
          let id = '';
          yield* Effect.scoped(
            Effect.gen(function* () {
              const receiver = yield* makeSqliteEpochReceiver({
                ...config,
                mode: 'create',
                keyStore: { path: keyFile, mode: 'create', protector: native.protector },
              });
              const result = yield* receiver.receive(f.owner.publicKey, frame);
              id = result.id;
              expect(result.outcome).toBe('Installed');
              expect(rows(journal)[0]!.phase).toBe('Report');
              expect((yield* recipient.status(target(f))).status).toBe('EnvelopeStored');
              expect(yield* receiver.flushReports()).toEqual({
                processed: 1,
                blocked: [id],
                next: null,
              });
              expect(rows(journal)[0]!.phase).toBe('Report');
              expect((yield* recipient.status(target(f))).status).toBe('InstallationReported');
            })
          );
          const saved = new Uint8Array(rows(journal)[0]!.report!);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const receiver = yield* makeSqliteEpochReceiver({
                ...config,
                mode: 'open',
                signer: {
                  publicKey: f.phone.publicKey,
                  sign: () => Effect.fail(new ContentError({ code: 'sign-failed' })),
                },
                keyStore: { path: keyFile, mode: 'open', protector: native.protector },
              });
              expect(yield* receiver.flushReports()).toEqual({
                processed: 1,
                blocked: [],
                next: null,
              });
              expect(originals).toEqual([saved, saved]);
              expect(yield* receiver.results()).toEqual([{ id, outcome: 'Reported' }]);
              yield* receiver.acknowledge(id);
              expect(yield* receiver.results()).toEqual([]);
              expect(yield* receiver.flushReports()).toEqual({
                processed: 0,
                blocked: [],
                next: null,
              });
              expect((yield* receiver.receive(f.owner.publicKey, frame)).outcome).toBe('Installed');
            })
          );
        })
      )
    );
    expect(native.plains.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
  });
  it('retains the pending original on protection failure, rejects the old format unchanged, and reports only after a reopened real install succeeds', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      keyFile = path.join(dir, 'keys.sqlite'),
      journal = path.join(dir, 'receive.sqlite'),
      frame = await Effect.runPromise(f.prepare());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: path.join(dir, 'mailbox.sqlite'),
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          const sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          yield* sender.put('02'.repeat(16), frame);
          const config = {
            path: journal,
            genesis: f.context.genesis,
            signer: f.phone.signer,
            pair,
            ledger: f.ledger,
            remote: recipient,
          };
          yield* Effect.scoped(
            Effect.gen(function* () {
              const receiver = yield* makeSqliteEpochReceiver({
                ...config,
                mode: 'create',
                keyStore: {
                  path: keyFile,
                  mode: 'create',
                  protector: {
                    ...native.protector,
                    protect: async (plain) => {
                      native.plains.push(plain);
                      throw Error('synthetic locked native store');
                    },
                  },
                },
              });
              expect(
                Result.isFailure(yield* Effect.result(receiver.receive(f.owner.publicKey, frame)))
              ).toBe(true);
              const task = rows(journal)[0]!;
              expect(task.phase).toBe('Install');
              expect(task.report).toBeNull();
              expect(yield* receiver.flushReports()).toEqual({
                processed: 0,
                blocked: [],
                next: null,
              });
              expect((yield* recipient.status(target(f))).status).toBe('EnvelopeStored');
            })
          );
          const disk = new Database(journal);
          const original = disk
            .prepare('SELECT body,frame,publication FROM receive_tasks')
            .get() as { body: Uint8Array; frame: Uint8Array; publication: null };
          disk.close();
          expect(new Uint8Array(original.frame)).toEqual(frame);
          expect(original.publication).toBeNull();
          expect(native.plains.every((bytes) => bytes.every((value) => value === 0))).toBe(true);

          const oldJournal = path.join(dir, 'receive-v1.sqlite');
          copyFileSync(journal, oldJournal);
          const old = new Database(oldJournal);
          old.exec(`ALTER TABLE receive_tasks RENAME TO receive_current;
            CREATE TABLE receive_tasks(id TEXT PRIMARY KEY,body BLOB NOT NULL CHECK(length(body) BETWEEN 1 AND 256),frame BLOB CHECK(length(frame) BETWEEN 1 AND 512),publication BLOB CHECK(length(publication) BETWEEN 1 AND 8192),report BLOB CHECK(length(report) BETWEEN 1 AND 512),phase TEXT NOT NULL CHECK(phase IN ('Verify','Install','Report','Reported','Obsolete','Revoked')),consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)));
            INSERT INTO receive_tasks SELECT id,body,frame,publication,report,'Verify',consumed FROM receive_current;
            DROP TABLE receive_current;
            CREATE INDEX receive_pending ON receive_tasks(phase,id);
            PRAGMA user_version=1;`);
          old.close();
          const oldBytes = readFileSync(oldJournal);
          const rejected = yield* Effect.result(
            Effect.scoped(
              makeSqliteEpochReceiver({
                ...config,
                path: oldJournal,
                mode: 'open',
                keyStore: { path: keyFile, mode: 'open', protector: native.protector },
              })
            )
          );
          expect(rejected).toMatchObject({ _tag: 'Failure', failure: { reason: 'corrupt' } });
          expect(readFileSync(oldJournal)).toEqual(oldBytes);

          yield* Effect.scoped(
            Effect.gen(function* () {
              const receiver = yield* makeSqliteEpochReceiver({
                ...config,
                mode: 'open',
                keyStore: { path: keyFile, mode: 'open', protector: native.protector },
              });
              expect(yield* receiver.resume()).toEqual({ processed: 1, blocked: [], next: null });
              expect(rows(journal)[0]!.phase).toBe('Report');
              const saved = new Database(journal);
              try {
                const queued = saved
                  .prepare('SELECT body,frame,publication,report FROM receive_tasks')
                  .get() as typeof original & { report: Uint8Array };
                expect({
                  body: queued.body,
                  frame: queued.frame,
                  publication: queued.publication,
                }).toEqual(original);
                expect(
                  ok(
                    Reports.installationBody(
                      ok(Reports.decodeInstallationReport(queued.report)).context
                    )
                  )
                ).toEqual(new Uint8Array(original.body));
              } finally {
                saved.close();
              }
              expect(yield* receiver.flushReports()).toEqual({
                processed: 1,
                blocked: [],
                next: null,
              });
              expect((yield* recipient.status(target(f))).status).toBe('InstallationReported');
            })
          );
        })
      )
    );
    expect(native.plains.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
  });
  it('does not let a pending install or pre-existing valid key stand in for authenticating this ciphertext', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      keyFile = path.join(dir, 'keys.sqlite'),
      journal = path.join(dir, 'receive.sqlite');
    const good = await Effect.runPromise(f.prepare()),
      mutated = new Uint8Array(good);
    mutated[mutated.length - 65] ^= 1;
    const frame = f.resign(mutated);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: path.join(dir, 'mailbox.sqlite'),
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          const sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          yield* sender.put('03'.repeat(16), frame);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const keys = yield* makeSqliteProtectedEpochKeys({
                path: keyFile,
                mode: 'create',
                genesis: f.context.genesis,
                recipient: f.phone.publicKey,
                ledger: f.ledger,
                protector: native.protector,
              });
              yield* keys.saveAndReload(0, f.secret);
            })
          );
          const receiver = yield* makeSqliteEpochReceiver({
            path: journal,
            mode: 'create',
            genesis: f.context.genesis,
            signer: f.phone.signer,
            pair,
            ledger: f.ledger,
            remote: recipient,
            keyStore: { path: keyFile, mode: 'open', protector: native.protector },
          });
          expect(
            Result.isFailure(yield* Effect.result(receiver.receive(f.owner.publicKey, frame)))
          ).toBe(true);
          const id = rows(journal)[0]!.id;
          expect(rows(journal)[0]!.phase).toBe('Install');
          expect(yield* receiver.resume()).toEqual({ processed: 1, blocked: [id], next: null });
          expect(rows(journal)[0]!.report).toBeNull();
          expect(yield* receiver.flushReports()).toEqual({ processed: 0, blocked: [], next: null });
          expect((yield* recipient.status(target(f))).status).toBe('EnvelopeStored');
        })
      )
    );
  });
  it('never treats a queued or reported task as current key possession after local loss; explicit repair creates a new bound episode', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      keyFile = path.join(dir, 'keys.sqlite'),
      journal = path.join(dir, 'receive.sqlite'),
      frame = await Effect.runPromise(f.prepare());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: path.join(dir, 'mailbox.sqlite'),
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          const sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          yield* sender.put('04'.repeat(16), frame);
          const receiver = yield* makeSqliteEpochReceiver({
            path: journal,
            mode: 'create',
            genesis: f.context.genesis,
            signer: f.phone.signer,
            pair,
            ledger: f.ledger,
            remote: recipient,
            keyStore: { path: keyFile, mode: 'create', protector: native.protector },
          });
          const first = yield* receiver.receive(f.owner.publicKey, frame);
          yield* receiver.flushReports();
          const lost = new Database(keyFile);
          lost.exec('DELETE FROM installed_epoch_keys');
          lost.close();
          expect(
            Result.isFailure(yield* Effect.result(receiver.receive(f.owner.publicKey, frame)))
          ).toBe(true);
          yield* recipient.repair(target(f), 'lost-synthetic-key');
          expect((yield* recipient.status(target(f))).status).toBe('EnvelopeStored');
          const second = yield* receiver.receive(f.owner.publicKey, frame);
          expect(second.id).not.toBe(first.id);
          expect(yield* receiver.flushReports()).toEqual({ processed: 1, blocked: [], next: null });
          expect((yield* recipient.status(target(f))).status).toBe('InstallationReported');
          expect(yield* receiver.results()).toHaveLength(2);
          const stored = rows(journal);
          expect(stored.every((task) => task.phase === 'Reported')).toBe(true);
          expect(stored[0]!.report).not.toEqual(stored[1]!.report);
        })
      )
    );
  });
  it('confirms only the exact local publisher record and an independently reloaded durable key', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      keyFile = path.join(dir, 'keys.sqlite'),
      journal = path.join(dir, 'receive.sqlite');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
              path: path.join(dir, 'mailbox.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            }),
            owner = ok(host.bind(f.owner.publicKey));
          const receiver = yield* makeSqliteEpochReceiver({
            path: journal,
            mode: 'create',
            genesis: f.context.genesis,
            signer: f.owner.signer,
            pair,
            ledger: f.ledger,
            remote: owner,
            keyStore: { path: keyFile, mode: 'create', protector: native.protector },
          });
          expect(
            Result.isFailure(
              yield* Effect.result(receiver.recordLocalInstallation(f.genesisRecord))
            )
          ).toBe(true);
          expect(yield* receiver.flushReports()).toEqual({ processed: 0, blocked: [], next: null });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const keys = yield* makeSqliteProtectedEpochKeys({
                path: keyFile,
                mode: 'open',
                genesis: f.context.genesis,
                recipient: f.owner.publicKey,
                ledger: f.ledger,
                protector: native.protector,
              });
              yield* keys.saveAndReload(0, f.secret);
            })
          );
          expect((yield* receiver.recordLocalInstallation(f.genesisRecord)).outcome).toBe(
            'Installed'
          );
          const bad = new Uint8Array(f.genesisRecord);
          bad[bad.length - 1] ^= 1;
          expect(
            Result.isFailure(yield* Effect.result(receiver.recordLocalInstallation(bad)))
          ).toBe(true);
          expect(yield* receiver.flushReports()).toEqual({ processed: 1, blocked: [], next: null });
          expect((yield* owner.status({ ...target(f), recipient: hex(f.owner.raw) })).status).toBe(
            'InstallationReported'
          );
        })
      )
    );
  });
  it.each([
    { phase: 'Revoked', suppress: null },
    { phase: 'Obsolete', suppress: null },
    { phase: 'Install', suppress: 'Report' },
  ])(
    'rejects tampered $phase or suppressed $suppress transition after reopen without claiming an unqueued installation',
    async ({ phase, suppress }) => {
      const f = envelopeFixture(),
        native = synthetic(),
        dir = directory(),
        pair = await recipientPair();
      const journal = path.join(dir, 'receive.sqlite'),
        keyFile = path.join(dir, 'keys.sqlite');
      const frame = await Effect.runPromise(f.prepare());
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeSqliteKeyMailbox({
              path: path.join(dir, 'mailbox.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            });
            const sender = ok(host.bind(f.owner.publicKey)),
              remote = ok(host.bind(f.phone.publicKey));
            yield* sender.put('ab'.repeat(16), frame);
            const config = {
              path: journal,
              genesis: f.context.genesis,
              signer: f.phone.signer,
              pair,
              ledger: f.ledger,
              remote,
            };
            let id = '';
            yield* Effect.scoped(
              Effect.gen(function* () {
                const receiver = yield* makeSqliteEpochReceiver({
                  ...config,
                  mode: 'create',
                  keyStore: { path: keyFile, mode: 'create', protector: native.protector },
                });
                id = (yield* receiver.receive(f.owner.publicKey, frame)).id;
              })
            );
            const disk = new Database(journal);
            try {
              disk
                .prepare('UPDATE receive_tasks SET phase=?,report=NULL WHERE id=?')
                .run(phase, id);
              if (suppress)
                disk.exec(
                  `CREATE TRIGGER suppress_receive_transition BEFORE UPDATE ON receive_tasks WHEN NEW.phase='${suppress}' BEGIN SELECT RAISE(IGNORE); END;`
                );
            } finally {
              disk.close();
            }
            yield* Effect.scoped(
              Effect.gen(function* () {
                const receiver = yield* makeSqliteEpochReceiver({
                  ...config,
                  mode: 'open',
                  keyStore: { path: keyFile, mode: 'open', protector: native.protector },
                });
                expect(
                  Result.isFailure(yield* Effect.result(receiver.receive(f.owner.publicKey, frame)))
                ).toBe(true);
                expect(rows(journal)).toEqual([{ id, phase, report: null }]);
                expect((yield* remote.status(target(f))).status).toBe('EnvelopeStored');
                expect(yield* receiver.flushReports()).toEqual({
                  processed: 0,
                  blocked: [],
                  next: null,
                });
              })
            );
          })
        )
      );
    }
  );
  it('pages past blocked repair revisions with keyset hints while preserving originals and delivering the current signed claim', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      keyFile = path.join(dir, 'keys.sqlite'),
      journal = path.join(dir, 'receive.sqlite');
    // Reuse this already genuinely verified immutable ledger. Replaying the unchanged
    // full fixture on every lookup measures fixture work, not finite queue progress.
    const verified = f.view(),
      ledger = () => Effect.succeed(verified);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
              path: path.join(dir, 'mailbox.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger,
            }),
            sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          const receiver = yield* makeSqliteEpochReceiver({
            path: journal,
            mode: 'create',
            genesis: f.context.genesis,
            signer: f.phone.signer,
            pair,
            ledger,
            remote: recipient,
            keyStore: { path: keyFile, mode: 'create', protector: native.protector },
          });
          let frame: Uint8Array | undefined;
          for (let index = 0; index < 16; index++) {
            frame = yield* f.prepare(ledger);
            yield* sender.put(index.toString(16).padStart(32, '0'), frame);
            yield* receiver.receive(f.owner.publicKey, frame);
          }
          const originals = rows(journal).map((task) => new Uint8Array(task.report!));
          yield* recipient.repair(target(f), 'new-repair-round');
          const current = yield* receiver.receive(f.owner.publicKey, frame!);
          let cursor: string | null = null,
            total = 0;
          const blocked: string[] = [];
          do {
            const page: { processed: number; blocked: readonly string[]; next: string | null } =
              yield* receiver.flushReports(3, cursor);
            total += page.processed;
            blocked.push(...page.blocked);
            cursor = page.next;
          } while (cursor !== null);
          expect(total).toBe(17);
          expect(blocked).toHaveLength(16);
          expect(new Set(blocked).size).toBe(16);
          expect(yield* receiver.results()).toEqual([{ id: current.id, outcome: 'Reported' }]);
          expect((yield* recipient.status(target(f))).status).toBe('InstallationReported');
          const pending = rows(journal)
            .filter((task) => task.phase === 'Report')
            .map((task) => new Uint8Array(task.report!));
          expect(pending).toEqual(originals);
          expect(Result.isFailure(yield* Effect.result(receiver.flushReports(0)))).toBe(true);
          expect(Result.isFailure(yield* Effect.result(receiver.resume(101)))).toBe(true);
          expect(Result.isFailure(yield* Effect.result(receiver.flushReports(1, 'invalid')))).toBe(
            true
          );
        })
      )
    );
  });
  it('retries an already queued original after sender revocation but refuses a new envelope from that revoked sender', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      frame = await Effect.runPromise(f.prepare());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
              path: path.join(dir, 'mailbox.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            }),
            sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          yield* sender.put('05'.repeat(16), frame);
          const receiver = yield* makeSqliteEpochReceiver({
            path: path.join(dir, 'receive.sqlite'),
            mode: 'create',
            genesis: f.context.genesis,
            signer: f.phone.signer,
            pair,
            ledger: f.ledger,
            remote: recipient,
            keyStore: {
              path: path.join(dir, 'keys.sqlite'),
              mode: 'create',
              protector: native.protector,
            },
          });
          const installed = yield* receiver.receive(f.owner.publicKey, frame);
          f.append([5, f.owner.raw]);
          expect(
            Result.isFailure(yield* Effect.result(receiver.receive(f.owner.publicKey, frame)))
          ).toBe(true);
          expect(yield* receiver.flushReports()).toEqual({ processed: 1, blocked: [], next: null });
          expect(yield* receiver.results()).toEqual([{ id: installed.id, outcome: 'Reported' }]);
          expect((yield* recipient.status(target(f))).status).toBe('InstallationReported');
        })
      )
    );
  });
  it('ends a pending claim only from genuinely observed recipient revocation and preserves its original bytes', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      journal = path.join(dir, 'receive.sqlite'),
      frame = await Effect.runPromise(f.prepare());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
              path: path.join(dir, 'mailbox.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            }),
            sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          yield* sender.put('06'.repeat(16), frame);
          const receiver = yield* makeSqliteEpochReceiver({
            path: journal,
            mode: 'create',
            genesis: f.context.genesis,
            signer: f.phone.signer,
            pair,
            ledger: f.ledger,
            remote: recipient,
            keyStore: {
              path: path.join(dir, 'keys.sqlite'),
              mode: 'create',
              protector: native.protector,
            },
          });
          const installed = yield* receiver.receive(f.owner.publicKey, frame),
            original = new Uint8Array(rows(journal)[0]!.report!);
          f.append([5, f.phone.raw]);
          expect(yield* receiver.flushReports()).toEqual({ processed: 1, blocked: [], next: null });
          expect(yield* receiver.results()).toEqual([{ id: installed.id, outcome: 'Revoked' }]);
          expect(new Uint8Array(rows(journal)[0]!.report!)).toEqual(original);
          expect(
            Result.isFailure(yield* Effect.result(receiver.receive(f.owner.publicKey, frame)))
          ).toBe(true);
          expect(yield* receiver.flushReports()).toEqual({ processed: 0, blocked: [], next: null });
        })
      )
    );
  });
  it('never queues a late borrowed signature through a closed Scope', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      journal = path.join(dir, 'receive.sqlite'),
      frame = await Effect.runPromise(f.prepare());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
              path: path.join(dir, 'mailbox.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            }),
            sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          yield* sender.put('07'.repeat(16), frame);
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>(),
            scope = yield* Effect.acquireRelease(Scope.make(), (child) =>
              Scope.close(child, Exit.void)
            );
          const signer: DeviceSigner = {
            publicKey: f.phone.publicKey,
            sign: (message) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(f.phone.signer.sign(message))
              ),
          };
          const receiver = yield* makeSqliteEpochReceiver({
            path: journal,
            mode: 'create',
            genesis: f.context.genesis,
            signer,
            pair,
            ledger: f.ledger,
            remote: recipient,
            keyStore: {
              path: path.join(dir, 'keys.sqlite'),
              mode: 'create',
              protector: native.protector,
            },
          }).pipe(Effect.provideService(Scope.Scope, scope));
          const callerFrame = new Uint8Array(frame),
            worker = yield* Effect.forkChild(receiver.receive(f.owner.publicKey, callerFrame));
          yield* Deferred.await(entered);
          callerFrame.fill(0);
          expect(rows(journal)[0]!.phase).toBe('Install');
          yield* Scope.close(scope, Exit.void);
          yield* Deferred.succeed(release, undefined);
          expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true);
          expect(rows(journal)[0]!.report).toBeNull();
          expect((yield* recipient.status(target(f))).status).toBe('EnvelopeStored');
          expect(Result.isFailure(yield* Effect.result(receiver.resume()))).toBe(true);
        })
      )
    );
  });
  it('captures request bytes and initialized capabilities before the first asynchronous ledger wait', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      frame = await Effect.runPromise(f.prepare()),
      journal = path.join(dir, 'receive.sqlite');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
              path: path.join(dir, 'mailbox.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            }),
            sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          yield* sender.put('08'.repeat(16), frame);
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          let first = true;
          const lookup: () => Effect.Effect<LedgerView, unknown> = () =>
            Effect.gen(function* () {
              if (first) {
                first = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return yield* f.ledger();
            });
          const signer = { publicKey: f.phone.publicKey, sign: f.phone.signer.sign },
            mutablePair = { ...pair },
            remote = { status: recipient.status, report: recipient.report };
          const config = {
            path: journal,
            mode: 'create' as const,
            genesis: f.context.genesis,
            signer,
            pair: mutablePair,
            ledger: lookup,
            remote,
            keyStore: {
              path: path.join(dir, 'keys.sqlite'),
              mode: 'create' as const,
              protector: native.protector,
            },
          };
          const receiver = yield* makeSqliteEpochReceiver(config),
            callerFrame = new Uint8Array(frame),
            worker = yield* Effect.forkChild(receiver.receive(f.owner.publicKey, callerFrame));
          yield* Deferred.await(entered);
          callerFrame.fill(0);
          signer.publicKey = f.owner.publicKey;
          signer.sign = () => Effect.fail(new ContentError({ code: 'sign-failed' }));
          mutablePair.privateKey = pair.publicKey;
          config.ledger = () => Effect.fail(new ContentError({ code: 'sign-failed' }));
          remote.report = () => Effect.fail(new ContentError({ code: 'sign-failed' }));
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(worker)).outcome).toBe('Installed');
          expect(yield* receiver.flushReports()).toEqual({ processed: 1, blocked: [], next: null });
          expect((yield* recipient.status(target(f))).status).toBe('InstallationReported');
        })
      )
    );
  });
  it('reopens the queued original in an independent process and delivers through the real host without a usable signer', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dir = directory(),
      pair = await recipientPair(),
      journal = path.join(dir, 'receive.sqlite'),
      keys = path.join(dir, 'keys.sqlite'),
      frame = await Effect.runPromise(f.prepare());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
              path: path.join(dir, 'mailbox.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            }),
            sender = ok(host.bind(f.owner.publicKey)),
            recipient = ok(host.bind(f.phone.publicKey));
          yield* sender.put('09'.repeat(16), frame);
          let id = '';
          yield* Effect.scoped(
            Effect.gen(function* () {
              const receiver = yield* makeSqliteEpochReceiver({
                path: journal,
                mode: 'create',
                genesis: f.context.genesis,
                signer: f.phone.signer,
                pair,
                ledger: f.ledger,
                remote: recipient,
                keyStore: { path: keys, mode: 'create', protector: native.protector },
              });
              id = (yield* receiver.receive(f.owner.publicKey, frame)).id;
            })
          );
          const original = new Uint8Array(rows(journal)[0]!.report!);
          const inFlight = new Set<Promise<unknown>>();
          let accepting = true;
          const worker = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new Worker(new URL('./receive-reopen.mts', import.meta.url), {
                  execArgv: ['--import', new URL('../worker-loader.mjs', import.meta.url).href],
                  workerData: { journal, keys },
                })
            ),
            (child) => Effect.promise(() => child.terminate())
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              accepting = false;
              await Promise.allSettled([...inFlight]);
            })
          );
          const result = yield* Effect.tryPromise({
            try: () =>
              new Promise<{
                batch: { processed: number; blocked: string[]; next: string | null };
                results: { id: string; outcome: string }[];
              }>((resolve, reject) => {
                worker.on('error', reject);
                worker.on('message', (message) => {
                  if (message.kind === 'done') {
                    resolve(message.result);
                    return;
                  }
                  if (message.kind === 'failed') {
                    reject(new Error('child failed'));
                    return;
                  }
                  if (message.kind !== 'request') return;
                  if (!accepting) {
                    worker.postMessage({ id: message.id, ok: false });
                    return;
                  }
                  // Test-only RPC bridge; the actual public host validates and persists every request.
                  const operation =
                    message.operation === 'status'
                      ? recipient.status(message.args[0])
                      : message.operation === 'report'
                        ? recipient.report(message.args[0], message.args[1])
                        : Effect.fail(new ContentError({ code: 'sign-failed' }));
                  const running = Effect.runPromise(operation).then(
                    (value) => worker.postMessage({ id: message.id, ok: true, value }),
                    () => worker.postMessage({ id: message.id, ok: false })
                  );
                  inFlight.add(running);
                  void running.finally(() => inFlight.delete(running));
                });
              }),
            catch: () => new ContentError({ code: 'sign-failed' }),
          });
          expect(result.batch).toEqual({ processed: 1, blocked: [], next: null });
          expect(result.results).toEqual([{ id, outcome: 'Reported' }]);
          expect(new Uint8Array(rows(journal)[0]!.report!)).toEqual(original);
          expect((yield* recipient.status(target(f))).status).toBe('InstallationReported');
        })
      )
    );
  });
});
