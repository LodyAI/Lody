import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Effect, Layer, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { encodeCbor } from '@lody/e2ee-core/protocol';
import { makeWorkspaceRecovery } from '@lody/e2ee-core';
import { type RecoveryVaultLocalStore } from '@lody/e2ee-core/services';
import {
  verifiedPasskeyPrf,
  disposePrf,
  wipeRecoveryPackage,
  generateRecoveryPackage,
  vaultCiphertextDigest,
} from '@lody/e2ee-core/protocol';
import {
  createRecoveryVault,
  openRecoveryVault,
  openRecoveryVaultWithPasskey,
} from '@lody/e2ee-core/internal';
import {
  extendLedger,
  verifyLedger,
  hashRecordBytes,
  epochHistoryPacket,
} from '@lody/e2ee-core/protocol';
import { signGenesisRecord, prepareLedgerCommand } from '@lody/e2ee-core/protocol';
import { prepareLedgerRecord, signLedgerRecord } from '@lody/e2ee-core/protocol';
import { prepareEpochEnvelope } from '@lody/e2ee-core/protocol';
import { commitEpochKey, sealHistoryPacket } from '@lody/e2ee-core/protocol';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { LedgerLog, LedgerLogError, SubmissionJournal } from '@lody/e2ee-core/services';
import { submitRecord, acknowledgeSubmission } from '@lody/e2ee-core/internal';
import {
  sqliteRecoveryVaultLocalStore,
  sqliteSubmissionJournal,
} from '@lody/e2ee-core/adapters/node-sqlite';
import { generateDevice } from '../src/platform/device';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
import { makeLabRecoveryVaultStore } from '../src/platform/recovery-vault-sqlite';
const ok = Result.getOrThrow;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const inDir = async (run: (directory: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-recovery-vault-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const fixture = Effect.fnUntraced(function* () {
  const owner = yield* generateDevice(),
    personal = yield* generateDevice(),
    epochKey = ok(Bytes.epochKey(new Uint8Array(32).fill(57))),
    membership = ok(Bytes.membershipId(new Uint8Array(16).fill(58)));
  const initial = yield* signGenesisRecord({
    userId: ok(Bytes.userId(new Uint8Array(32).fill(59))),
    membershipId: membership,
    encryptionPublicKey: owner.enc,
    initialKey: epochKey,
    signer: owner,
  });
  const records = [initial.record];
  const view = () =>
    ok(
      verifyLedger({
        anchor: initial.genesis,
        records,
        checkpoint: { head: hashRecordBytes(records.at(-1)!), length: records.length },
      })
    );
  const remote = LedgerLog.of({
    read: () =>
      Effect.sync(() => ({
        records: records.map((row) => new Uint8Array(row)),
        checkpoint: { head: view().head, length: records.length },
      })),
    appendCas: (_anchor, expected, record) =>
      Effect.suspend(() => {
        const before = view();
        if (!expected.head.equals(before.head) || expected.length !== before.length)
          return Effect.fail(new LedgerLogError());
        return Effect.sync(() => {
          ok(
            extendLedger(before, [record], {
              head: hashRecordBytes(record),
              length: before.length + 1,
            })
          );
          records.push(new Uint8Array(record));
        });
      }),
  });
  return { owner, personal, epochKey, membership, initial, records, view, remote };
});
describe('encrypted recovery vault and genuine workflow', () => {
  it('opens the same V from a recovery file and actual PRF result, authenticates AAD, rejects unsupported PRF and index rollback', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* makeLabRecoveryVaultStore({
                path: join(dir, 'vault.sqlite'),
                mode: 'create',
              }),
              f = yield* fixture();
            const { vault, recoveryFile } = yield* createRecoveryVault({
              locator: 'https://synthetic.invalid/vault',
              ...storage,
            });
            const binding = {
              genesis: hex(f.initial.genesis.toBytes()),
              membershipId: hex(f.membership.toBytes()),
              generation: 0,
              trust: {
                source: 'independent synthetic invitation',
                genesisRecord: f.initial.record,
                head: hex(f.view().head.toBytes()),
                length: 1,
              },
            };
            const bundle = yield* generateRecoveryPackage(binding),
              signing = new Uint8Array(bundle.signingPrivate);
            const candidate = yield* vault.upload(bundle);
            wipeRecoveryPackage(bundle);
            for (const name of readdirSync(dir))
              if (name.startsWith('vault.sqlite'))
                expect(readFileSync(join(dir, name)).includes(Buffer.from(signing))).toBe(false);
            expect((yield* vault.reserve(candidate)).outcome).toBe('Committed');
            const index0 = yield* storage.store.readIndex(vault.vaultId);
            const prf = yield* verifiedPasskeyPrf({
              credentialId: 'synthetic-credential',
              extension: { enabled: true, results: { first: new Uint8Array(32).fill(77).buffer } },
            });
            yield* vault.addPasskey(prf);
            const reopened = yield* openRecoveryVault({ recoveryFile, ...storage }),
              fromPrf = yield* openRecoveryVaultWithPasskey({
                vaultId: vault.vaultId,
                locator: vault.locator,
                credential: prf,
                ...storage,
              });
            for (const session of [reopened, fromPrf]) {
              const actual = yield* session.readEntry(candidate);
              expect(actual.signingPrivate).toEqual(signing);
              wipeRecoveryPackage(actual);
            }
            const unsupported = yield* Effect.result(
              verifiedPasskeyPrf({ credentialId: 'login-only', extension: { enabled: false } })
            );
            expect(Result.isFailure(unsupported)).toBe(true);
            const clone = yield* Effect.result(
              openRecoveryVaultWithPasskey({
                vaultId: vault.vaultId,
                locator: vault.locator,
                credential: { credentialId: 'synthetic-credential' },
                ...storage,
              })
            );
            expect(Result.isFailure(clone)).toBe(true);
            const db = new Database(join(dir, 'vault.sqlite'));
            try {
              db.prepare('UPDATE vault_entries SET revision=revision+1 WHERE entryId=?').run(
                candidate.entryId
              );
              const corrupt = yield* Effect.result(vault.readEntry(candidate));
              expect(Result.isFailure(corrupt)).toBe(true);
              db.prepare('UPDATE vault_entries SET revision=revision-1 WHERE entryId=?').run(
                candidate.entryId
              );
            } finally {
              db.close();
            }
            const nextBundle = yield* generateRecoveryPackage({
                ...binding,
                genesis: '11'.repeat(32),
                membershipId: '22'.repeat(16),
              }),
              nextRef = yield* vault.upload(nextBundle);
            wipeRecoveryPackage(nextBundle);
            yield* vault.reserve(nextRef);
            const rollback = new Database(join(dir, 'vault.sqlite'));
            try {
              rollback
                .prepare('UPDATE vault_index SET entryId=?,revision=?,body=? WHERE vault=?')
                .run(index0!.entryId, index0!.revision, index0!.body, vault.vaultId);
              const rejected = yield* Effect.result(vault.readIndex());
              expect(Result.isFailure(rejected)).toBe(true);
              if (Result.isFailure(rejected))
                expect(rejected.failure).toMatchObject({ code: 'rollback' });
            } finally {
              rollback.close();
            }
            disposePrf(prf);
            signing.fill(0);
          })
        )
      );
    }));
  it('atomically rejects ignored or corrupted immutable/index/local writes and preserves the original ciphertext', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const file = join(dir, 'vault.sqlite'),
              storage = yield* makeLabRecoveryVaultStore({ path: file, mode: 'create' }),
              f = yield* fixture();
            const { vault } = yield* createRecoveryVault({
              locator: 'https://synthetic.invalid/vault',
              ...storage,
            });
            const bundle = yield* generateRecoveryPackage({
              genesis: hex(f.initial.genesis.toBytes()),
              membershipId: hex(f.membership.toBytes()),
              generation: 0,
              trust: {
                source: 'synthetic',
                genesisRecord: f.initial.record,
                head: hex(f.view().head.toBytes()),
                length: 1,
              },
            });
            const faults = new Database(file);
            try {
              faults.exec(
                'CREATE TRIGGER ignore_entry BEFORE INSERT ON vault_entries BEGIN SELECT RAISE(IGNORE); END'
              );
              expect(Result.isFailure(yield* Effect.result(vault.upload(bundle)))).toBe(true);
              expect(faults.prepare('SELECT count(*)-1 n FROM vault_entries').get()).toEqual({
                n: 0,
              });
              faults.exec('DROP TRIGGER ignore_entry');
              const ref = yield* vault.upload(bundle),
                original = yield* storage.store.readEntry(vault.vaultId, ref.entryId);
              faults.exec(
                'CREATE TRIGGER rewrite_index AFTER INSERT ON vault_index BEGIN UPDATE vault_index SET revision=revision+1; END'
              );
              expect(Result.isFailure(yield* Effect.result(vault.reserve(ref)))).toBe(true);
              expect(yield* storage.store.readIndex(vault.vaultId)).toBeNull();
              faults.exec('DROP TRIGGER rewrite_index');
              expect((yield* vault.reserve(ref)).outcome).toBe('Committed');
              expect(yield* storage.store.readEntry(vault.vaultId, ref.entryId)).toEqual(original);
              faults.exec(
                'CREATE TRIGGER ignore_local BEFORE INSERT ON vault_local BEGIN SELECT RAISE(IGNORE); END'
              );
              expect(
                Result.isFailure(
                  yield* Effect.result(
                    storage.local.compareAndSwap('native-fault', null, new Uint8Array([1]))
                  )
                )
              ).toBe(true);
              expect(yield* storage.local.read('native-fault')).toBeNull();
            } finally {
              faults.close();
              wipeRecoveryPackage(bundle);
            }
          })
        )
      );
    }));
  it('seals formatVersion 1 packages and rejects other versions or non-RFC 8410 private keys before storage', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const file = join(dir, 'vault.sqlite'),
              storage = yield* makeLabRecoveryVaultStore({ path: file, mode: 'create' }),
              f = yield* fixture();
            const { vault } = yield* createRecoveryVault({
              locator: 'https://synthetic.invalid/vault',
              ...storage,
            });
            const bundle = yield* generateRecoveryPackage({
              genesis: hex(f.initial.genesis.toBytes()),
              membershipId: hex(f.membership.toBytes()),
              generation: 0,
              trust: {
                source: 'synthetic',
                genesisRecord: f.initial.record,
                head: hex(f.view().head.toBytes()),
                length: 1,
              },
            });
            const entries = () =>
              (() => {
                const db = new Database(file, { readonly: true });
                try {
                  return db.prepare('SELECT count(*) n FROM vault_entries').get();
                } finally {
                  db.close();
                }
              })();
            try {
              expect(bundle.formatVersion).toBe(1);
              const before = entries();
              const swapped = {
                ...bundle,
                signingPrivate: bundle.encryptionPrivate,
                encryptionPrivate: bundle.signingPrivate,
              };
              const appended = {
                ...bundle,
                signingPrivate: new Uint8Array([...bundle.signingPrivate, 0]),
              };
              const { formatVersion: _omitted, ...unversioned } = bundle;
              for (const invalid of [
                { ...bundle, formatVersion: 2 },
                unversioned,
                swapped,
                appended,
              ]) {
                const rejected = yield* Effect.result(vault.upload(invalid as typeof bundle));
                expect(Result.isFailure(rejected)).toBe(true);
                if (Result.isFailure(rejected))
                  expect(rejected.failure).toMatchObject({ code: 'invalid-input' });
              }
              expect(entries()).toEqual(before);
              const ref = yield* vault.upload(bundle);
              const read = yield* vault.readEntry(ref);
              expect(read.formatVersion).toBe(1);
              wipeRecoveryPackage(read);
            } finally {
              wipeRecoveryPackage(bundle);
            }
          })
        )
      );
    }));
  it('keeps the production SQLite journal pin across reopen, refuses stale CAS and foreign files', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const journal = join(dir, 'recovery-journal.sqlite');
          const created = yield* Effect.scoped(
            Effect.gen(function* () {
              const storage = yield* makeLabRecoveryVaultStore({
                  path: join(dir, 'vault.sqlite'),
                  mode: 'create',
                }),
                local = yield* sqliteRecoveryVaultLocalStore({ path: journal, mode: 'create' }),
                f = yield* fixture();
              const { vault, recoveryFile } = yield* createRecoveryVault({
                locator: 'https://synthetic.invalid/vault',
                store: storage.store,
                local,
              });
              const bundle = yield* generateRecoveryPackage({
                genesis: hex(f.initial.genesis.toBytes()),
                membershipId: hex(f.membership.toBytes()),
                generation: 0,
                trust: {
                  source: 'synthetic',
                  genesisRecord: f.initial.record,
                  head: hex(f.view().head.toBytes()),
                  length: 1,
                },
              });
              const ref = yield* vault.upload(bundle);
              wipeRecoveryPackage(bundle);
              expect((yield* vault.reserve(ref)).outcome).toBe('Committed');
              expect(yield* local.compareAndSwap('k', null, new Uint8Array([1]))).toBe('Committed');
              expect(yield* local.compareAndSwap('k', null, new Uint8Array([2]))).toBe('Conflict');
              expect(
                yield* local.compareAndSwap('k', new Uint8Array([9]), new Uint8Array([2]))
              ).toBe('Conflict');
              expect(yield* local.read('k')).toEqual(new Uint8Array([1]));
              return {
                recoveryFile,
                vaultId: vault.vaultId,
                index: yield* storage.store.readIndex(vault.vaultId),
              };
            })
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const storage = yield* makeLabRecoveryVaultStore({
                  path: join(dir, 'vault.sqlite'),
                  mode: 'open',
                }),
                local = yield* sqliteRecoveryVaultLocalStore({ path: journal, mode: 'open' });
              const reopened = yield* openRecoveryVault({
                recoveryFile: created.recoveryFile,
                store: storage.store,
                local,
              });
              expect((yield* reopened.readIndex()).value.entries).toHaveLength(1);
              expect(
                (yield* local.list(`vault-v1/${created.vaultId}/`)).map((row) => row.key)
              ).toContain(`vault-v1/${created.vaultId}/index-pin`);
              // The durable pin outlives the process: a server rollback to no index is refused.
              const db = new Database(join(dir, 'vault.sqlite'));
              try {
                db.prepare('DELETE FROM vault_index WHERE vault=?').run(created.vaultId);
              } finally {
                db.close();
              }
              const rolledBack = yield* Effect.result(reopened.readIndex());
              expect(Result.isFailure(rolledBack)).toBe(true);
              if (Result.isFailure(rolledBack))
                expect(rolledBack.failure).toMatchObject({ code: 'rollback' });
              expect(created.index).not.toBeNull();
            })
          );
          const foreign = yield* Effect.result(
            Effect.scoped(
              sqliteRecoveryVaultLocalStore({ path: join(dir, 'vault.sqlite'), mode: 'open' })
            )
          );
          expect(Result.isFailure(foreign)).toBe(true);
          if (Result.isFailure(foreign))
            expect(foreign.failure).toMatchObject({ _tag: 'LocalStoreError', reason: 'corrupt' });
        })
      );
    }));
  it('resumes four setup boundaries without a second R, uses real P09/HPKE/protected storage, restores independent C, and rejects revoked R', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              storage = yield* makeLabRecoveryVaultStore({
                path: join(dir, 'vault.sqlite'),
                mode: 'create',
              }),
              created = yield* createRecoveryVault({
                locator: 'https://synthetic.invalid/vault',
                ...storage,
              });
            const currentKey = ok(Bytes.epochKey(new Uint8Array(32).fill(61)));
            const publication = yield* signLedgerRecord(
              ok(
                prepareLedgerRecord(
                  f.view(),
                  ok(
                    encodeCbor([
                      f.view().head.toBytes(),
                      f.owner.publicKey.toBytes(),
                      [
                        7,
                        1,
                        ok(commitEpochKey(f.initial.genesis, 1, currentKey)).toBytes(),
                        ok(
                          sealHistoryPacket({
                            genesis: f.initial.genesis,
                            epoch: 1,
                            currentKey,
                            previousKey: f.epochKey,
                          })
                        ),
                      ],
                    ])
                  )
                )
              ),
              f.owner
            );
            f.records.push(new Uint8Array(publication));
            const installed = yield* makeSqliteProtectedEpochKeys({
              path: join(dir, 'keys.sqlite'),
              mode: 'create',
              genesis: f.initial.genesis,
              recipient: f.owner.publicKey,
              ledger: () => Effect.sync(f.view),
              protector: labSyntheticProtector,
            });
            const journal = yield* Layer.build(
              sqliteSubmissionJournal({ path: join(dir, 'p09.sqlite') })
            ).pipe(Effect.map((context) => Context.get(context, SubmissionJournal)));
            let stopAt: 'candidate' | 'indexed' | 'registered' | 'envelope' | 'commit' | null =
              'candidate';
            const submit = (record: Uint8Array) =>
              Effect.gen(function* () {
                const result = yield* submitRecord(f.initial.genesis, record).pipe(
                  Effect.provideService(SubmissionJournal, journal),
                  Effect.provideService(LedgerLog, f.remote)
                );
                if (stopAt === 'commit') {
                  stopAt = null;
                  return yield* Effect.fail(
                    new Error('synthetic crash after P09 committed before ACK')
                  );
                }
                yield* acknowledgeSubmission(f.initial.genesis, result).pipe(
                  Effect.provideService(SubmissionJournal, journal),
                  Effect.provideService(LedgerLog, f.remote)
                );
                return result;
              });
            const interrupting: RecoveryVaultLocalStore['Service'] = {
              read: storage.local.read,
              list: storage.local.list,
              compareAndSwap: (key, expected, next) =>
                Effect.gen(function* () {
                  const outcome = yield* storage.local.compareAndSwap(key, expected, next);
                  if (key.includes('/workspace/') && stopAt) {
                    const decoded = new TextDecoder().decode(next);
                    if (
                      (stopAt === 'candidate' && decoded.includes('candidate')) ||
                      (stopAt === 'indexed' && decoded.includes('indexed')) ||
                      (stopAt === 'registered' && decoded.includes('registered'))
                    ) {
                      stopAt = null;
                      return yield* Effect.fail(
                        new Error('synthetic interruption after durable step')
                      );
                    }
                  }
                  return outcome;
                }),
            };
            const make = () =>
              makeWorkspaceRecovery({
                vault: created.vault,
                local: interrupting,
                genesis: f.initial.genesis,
                membershipId: f.membership,
                personalSigner: f.owner,
                ledger: () => Effect.sync(f.view),
                submitOriginal: submit,
                installed,
                trust: {
                  source: 'independent synthetic genesis',
                  genesisRecord: f.initial.record,
                  head: hex(f.view().head.toBytes()),
                  length: f.records.length,
                },
                fetchCurrentEnvelope: (recipient, epoch) =>
                  Effect.gen(function* () {
                    if (stopAt === 'envelope') {
                      stopAt = null;
                      return yield* Effect.fail(new Error('synthetic missing envelope'));
                    }
                    const context = {
                      genesis: f.initial.genesis,
                      epoch: ok(Bytes.epochNumber(epoch)),
                      sender: f.owner.publicKey,
                      recipient,
                    };
                    return {
                      sender: f.owner.publicKey,
                      frame: yield* prepareEpochEnvelope({
                        context,
                        key: currentKey,
                        signer: f.owner,
                        ledger: () => Effect.sync(f.view),
                      }),
                    };
                  }),
              });
            let workflow = yield* make();
            expect(Result.isFailure(yield* Effect.result(workflow.setup()))).toBe(true);
            for (const point of ['indexed', 'commit', 'registered', 'envelope'] as const) {
              stopAt = point;
              workflow = yield* make();
              expect(Result.isFailure(yield* Effect.result(workflow.setup()))).toBe(true);
            }
            workflow = yield* make();
            const completed = yield* workflow.setup();
            expect(completed.status).toMatchObject({
              paired: true,
              envelopeAvailable: true,
              recoverable: true,
              currentEpoch: 1,
            });
            expect(f.view().inspectState().devices.size).toBe(2);
            const oldTest = yield* workflow.status();
            stopAt = 'envelope';
            expect(Result.isFailure(yield* Effect.result(workflow.test()))).toBe(true);
            expect(yield* workflow.status()).toMatchObject({
              paired: true,
              envelopeAvailable: false,
              recoverable: false,
              lastTest: oldTest.lastTest,
              testedEpoch: 1,
            });
            expect((yield* workflow.test()).recoverable).toBe(true);
            const beforeReplacement = yield* created.vault.readIndex();
            const oldRef = beforeReplacement.value.entries.find((ref) => !ref.retired)!;
            expect(
              (yield* workflow.replace({ requestId: 'routine-one', compromised: false }))
                .recoverable
            ).toBe(true);
            const afterReplacement = yield* created.vault.readIndex();
            expect(
              afterReplacement.value.entries.find((ref) => ref.entryId === oldRef.entryId)?.retired
            ).toBe(true);
            expect(
              yield* storage.store.readEntry(created.vault.vaultId, oldRef.entryId)
            ).not.toBeNull();
            yield* created.vault.cleanupRetired(oldRef.entryId, { confirmedRecoveryLoss: true });
            expect(
              yield* storage.store.readEntry(created.vault.vaultId, oldRef.entryId)
            ).toBeNull();
            const index = yield* created.vault.readIndex();
            expect(index.value.entries.filter((ref) => !ref.retired)).toHaveLength(1);
            const original = yield* created.vault.readEntry(index.value.entries[0]!);
            const rPublic = ok(Bytes.signingPublicKey(original.signingPublic));
            wipeRecoveryPackage(original);
            const result = yield* workflow.restoreFromRecovery({
              personal: { ...f.personal, encryptionPublicKey: f.personal.enc },
              submitOriginalAsRecovery: submit,
            });
            expect(result.outcome).toBe('Committed');
            expect(f.view().inspectState().devices.size).toBe(3);
            expect(
              f.view().inspectState().devices.get(hex(f.personal.publicKey.toBytes()))?.kind
            ).toBe('personal');
            const read = yield* installed.read(0);
            expect(
              ok(commitEpochKey(f.initial.genesis, 0, read)).equals(
                ok(epochHistoryPacket(f.view(), 0)).commitment
              )
            ).toBe(true);
            const revoke = yield* signLedgerRecord(
              ok(
                prepareLedgerCommand(f.view(), f.owner.publicKey, {
                  _tag: 'RevokeDevice',
                  target: rPublic,
                })
              ),
              f.owner
            );
            yield* submit(revoke);
            const refused = yield* Effect.result(
              workflow.restoreFromRecovery({
                personal: { ...f.personal, encryptionPublicKey: f.personal.enc },
                submitOriginalAsRecovery: submit,
              })
            );
            expect(Result.isFailure(refused)).toBe(true);
            expect(f.records).toHaveLength(7);
            // No plaintext secret seed or private PKCS8 is in the encrypted cloud store.
            expect(
              readFileSync(join(dir, 'vault.sqlite')).includes(
                Buffer.from(new Uint8Array(32).fill(57))
              )
            ).toBe(false);
          })
        )
      );
    }));
  it('concurrent first setup on two durable clients reuses the winning R and leaves no duplicate ledger identity', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              cloud = yield* makeLabRecoveryVaultStore({
                path: join(dir, 'cloud.sqlite'),
                mode: 'create',
              }),
              other = yield* makeLabRecoveryVaultStore({
                path: join(dir, 'other-local.sqlite'),
                mode: 'create',
              });
            const created = yield* createRecoveryVault({
                locator: 'https://synthetic.invalid/vault',
                ...cloud,
              }),
              second = yield* openRecoveryVault({
                recoveryFile: created.recoveryFile,
                store: cloud.store,
                local: other.local,
              });
            const installed = yield* makeSqliteProtectedEpochKeys({
              path: join(dir, 'keys.sqlite'),
              mode: 'create',
              genesis: f.initial.genesis,
              recipient: f.owner.publicKey,
              ledger: () => Effect.sync(f.view),
              protector: labSyntheticProtector,
            });
            const journal = yield* Layer.build(
              sqliteSubmissionJournal({ path: join(dir, 'p09.sqlite') })
            ).pipe(Effect.map((context) => Context.get(context, SubmissionJournal)));
            const submit = (record: Uint8Array) =>
              Effect.gen(function* () {
                const result = yield* submitRecord(f.initial.genesis, record).pipe(
                  Effect.provideService(SubmissionJournal, journal),
                  Effect.provideService(LedgerLog, f.remote)
                );
                yield* acknowledgeSubmission(f.initial.genesis, result).pipe(
                  Effect.provideService(SubmissionJournal, journal),
                  Effect.provideService(LedgerLog, f.remote)
                );
                return result;
              });
            const common = {
              genesis: f.initial.genesis,
              membershipId: f.membership,
              personalSigner: f.owner,
              ledger: () => Effect.sync(f.view),
              submitOriginal: submit,
              installed,
              trust: {
                source: 'independent synthetic genesis',
                genesisRecord: f.initial.record,
                head: hex(f.view().head.toBytes()),
                length: 1,
              },
              fetchCurrentEnvelope: (recipient: Bytes.SigningPublicKey, epoch: number) =>
                Effect.gen(function* () {
                  const context = {
                    genesis: f.initial.genesis,
                    epoch: ok(Bytes.epochNumber(epoch)),
                    sender: f.owner.publicKey,
                    recipient,
                  };
                  return {
                    sender: f.owner.publicKey,
                    frame: yield* prepareEpochEnvelope({
                      context,
                      key: f.epochKey,
                      signer: f.owner,
                      ledger: () => Effect.sync(f.view),
                    }),
                  };
                }),
            };
            const a = yield* makeWorkspaceRecovery({
                ...common,
                vault: created.vault,
                local: cloud.local,
              }),
              b = yield* makeWorkspaceRecovery({ ...common, vault: second, local: other.local });
            const results = yield* Effect.all(
              [Effect.result(a.setup()), Effect.result(b.setup())],
              { concurrency: 'unbounded' }
            );
            // A concurrent P09 journal may require a retry, preserving its exact original.
            for (const [index, result] of results.entries())
              if (Result.isFailure(result)) yield* (index === 0 ? a : b).setup();
            expect((yield* a.status()).recoverable).toBe(true);
            expect((yield* b.status()).recoverable).toBe(true);
            expect(f.view().inspectState().devices.size).toBe(2);
            expect(f.records).toHaveLength(2);
            const rows = (yield* created.vault.readIndex()).value.entries.filter(
              (row) => !row.retired
            );
            expect(rows).toHaveLength(1);
            const clientRows = yield* other.local.list(
              `vault-v1/${created.vault.vaultId}/workspace/`
            );
            expect(clientRows.length).toBeGreaterThan(0);
          })
        )
      );
    }));
  it('refuses a dangling index when another native session deletes after candidate readback, retaining the existing indexed identity', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* makeLabRecoveryVaultStore({
              path: join(dir, 'vault.sqlite'),
              mode: 'create',
            });
            const other = yield* makeLabRecoveryVaultStore({
              path: join(dir, 'vault.sqlite'),
              mode: 'open',
            });
            const f = yield* fixture();
            const created = yield* createRecoveryVault({
              locator: 'https://synthetic.invalid/vault',
              ...storage,
            });
            const binding = {
              genesis: hex(f.initial.genesis.toBytes()),
              membershipId: hex(f.membership.toBytes()),
              generation: 0,
              trust: {
                source: 'independent synthetic genesis',
                genesisRecord: f.initial.record,
                head: hex(f.view().head.toBytes()),
                length: 1,
              },
            };
            const firstPackage = yield* generateRecoveryPackage(binding);
            const first = yield* created.vault.upload(firstPackage);
            wipeRecoveryPackage(firstPackage);
            expect((yield* created.vault.reserve(first)).outcome).toBe('Committed');
            const original = yield* storage.store.readEntry(created.vault.vaultId, first.entryId);
            const indexBefore = yield* storage.store.readIndex(created.vault.vaultId);
            expect(indexBefore).not.toBeNull();
            const candidatePackage = yield* generateRecoveryPackage({
              ...binding,
              genesis: '22'.repeat(32),
            });
            const candidate = yield* created.vault.upload(candidatePackage);
            wipeRecoveryPackage(candidatePackage);
            expect(
              yield* other.store.readEntry(created.vault.vaultId, candidate.entryId)
            ).not.toBeNull();
            let deletedAfterRead = false;
            const port = {
              ...storage.store,
              readEntry: (vaultId: string, entryId: string) =>
                Effect.gen(function* () {
                  const read = yield* storage.store.readEntry(vaultId, entryId);
                  if (entryId === candidate.entryId && !deletedAfterRead) {
                    expect(read).not.toBeNull();
                    yield* other.store.deleteUnreferenced(vaultId, entryId, {
                      revision: indexBefore!.revision,
                      digest: vaultCiphertextDigest(indexBefore!),
                    });
                    deletedAfterRead = true;
                  }
                  return read;
                }),
            };
            const pendingSession = yield* openRecoveryVault({
              recoveryFile: created.recoveryFile,
              store: port,
              local: storage.local,
            });
            const result = yield* pendingSession.reserve(candidate);
            expect(result).toEqual({ outcome: 'Conflict', reference: null });
            expect(deletedAfterRead).toBe(true);
            expect(yield* storage.store.readIndex(created.vault.vaultId)).toEqual(indexBefore);
            expect(yield* storage.store.readEntry(created.vault.vaultId, first.entryId)).toEqual(
              original
            );
            expect(
              (yield* created.vault.readIndex()).value.entries.map((entry) => entry.entryId)
            ).toEqual([first.entryId]);
            const decoded = yield* created.vault.readEntry(first);
            wipeRecoveryPackage(decoded);
          })
        )
      );
    }));
  it('retries the same encrypted index intent before acceptance and reconciles an accepted CAS with a lost response', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* makeLabRecoveryVaultStore({
                path: join(dir, 'vault.sqlite'),
                mode: 'create',
              }),
              f = yield* fixture();
            let fault: 'before' | 'after' | null = 'before';
            const attempts: Uint8Array[] = [];
            const port = {
              ...storage.store,
              compareAndSwapIndex: (
                ...args: Parameters<typeof storage.store.compareAndSwapIndex>
              ) =>
                Effect.gen(function* () {
                  attempts.push(new Uint8Array(args[2].body));
                  if (fault === 'before') {
                    fault = null;
                    return yield* Effect.fail(new Error('synthetic CAS not accepted'));
                  }
                  const result = yield* storage.store.compareAndSwapIndex(...args);
                  if (fault === 'after') {
                    fault = null;
                    return yield* Effect.fail(new Error('synthetic accepted CAS response lost'));
                  }
                  return result;
                }),
            };
            const { vault } = yield* createRecoveryVault({
              locator: 'https://synthetic.invalid/vault',
              store: port,
              local: storage.local,
            });
            const bundle = yield* generateRecoveryPackage({
                genesis: hex(f.initial.genesis.toBytes()),
                membershipId: hex(f.membership.toBytes()),
                generation: 0,
                trust: {
                  source: 'independent synthetic genesis',
                  genesisRecord: f.initial.record,
                  head: hex(f.view().head.toBytes()),
                  length: 1,
                },
              }),
              ref = yield* vault.upload(bundle);
            wipeRecoveryPackage(bundle);
            expect(Result.isFailure(yield* Effect.result(vault.reserve(ref)))).toBe(true);
            expect(yield* storage.store.readIndex(vault.vaultId)).toBeNull();
            expect((yield* vault.reserve(ref)).outcome).toBe('Committed');
            expect(attempts[1]).toEqual(attempts[0]);
            const other = yield* generateRecoveryPackage({
                genesis: '44'.repeat(32),
                membershipId: '55'.repeat(16),
                generation: 0,
                trust: {
                  source: 'separate workspace',
                  genesisRecord: f.initial.record,
                  head: hex(f.view().head.toBytes()),
                  length: 1,
                },
              }),
              otherRef = yield* vault.upload(other);
            wipeRecoveryPackage(other);
            fault = 'after';
            expect(Result.isFailure(yield* Effect.result(vault.reserve(otherRef)))).toBe(true);
            const committed = yield* storage.store.readIndex(vault.vaultId);
            expect((yield* vault.reserve(otherRef)).outcome).toBe('Existing');
            expect(yield* storage.store.readIndex(vault.vaultId)).toEqual(committed);
            expect((yield* vault.readIndex()).value.entries).toHaveLength(2);
          })
        )
      );
    }));
});
