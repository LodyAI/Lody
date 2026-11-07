import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Effect, Layer, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { encodeCbor } from '@lody/e2ee-core/protocol';
import {
  E2eePasskeyCancelled,
  enrollVaultPasskey,
  unlockVaultWithPasskey,
  type E2eePasskeyPort,
} from '@lody/e2ee-client/passkey-unlock';
import {
  abandonWorkspaceRecovery,
  makeWorkspaceRecovery,
  memoryRecoveryEpochKeys,
  type RecoveryVault,
  type RecoverySubmitResult,
  type WorkspaceRecoveryInput,
} from '@lody/e2ee-core';
import {
  readRecoveryHistory,
  recoveryLedger,
  recoveryRestoreIncomplete,
  restoreVaultWorkspaces,
  type VaultRestoreAnchor,
} from '@lody/e2ee-client/recovery-restore';
import {
  abandonVaultReplacement,
  planVaultReplacement,
  recoveryFetchEnvelope,
  recoverySubmitOriginal,
  replaceAccountVault,
} from '@lody/e2ee-client/vault-replacement';
import { type RecoveryVaultLocalStore } from '@lody/e2ee-core/services';
import {
  verifiedPasskeyPrf,
  verifiedPasskeyRegistration,
  passkeyUserHandle,
  vaultIdFromPasskeyUserHandle,
  vaultPrfInput,
  disposePrf,
  wipeRecoveryPackage,
  generateRecoveryPackage,
  vaultCiphertextDigest,
  deriveRecoveryAccessCredential,
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
import {
  decodeRecord,
  prepareDeviceAdmission,
  signGenesisRecord,
  prepareLedgerCommand,
} from '@lody/e2ee-core/protocol';
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
const replacementFixture = Effect.fnUntraced(function* (dir: string) {
  const f = yield* fixture(),
    storage = yield* makeLabRecoveryVaultStore({
      path: join(dir, 'vault.sqlite'),
      mode: 'create',
    }),
    journal = yield* Layer.build(sqliteSubmissionJournal({ path: join(dir, 'p09.sqlite') })).pipe(
      Effect.map((context) => Context.get(context, SubmissionJournal))
    ),
    installed = yield* makeSqliteProtectedEpochKeys({
      path: join(dir, 'keys.sqlite'),
      mode: 'create',
      genesis: f.initial.genesis,
      recipient: f.owner.publicKey,
      ledger: () => Effect.sync(f.view),
      protector: labSyntheticProtector,
    });
  let intercept:
    | ((record: Uint8Array) => Effect.Effect<RecoverySubmitResult | void, unknown>)
    | null = null;
  const submit = (record: Uint8Array) =>
    Effect.gen(function* () {
      const intercepted = intercept ? yield* intercept(record) : undefined;
      if (intercepted) return intercepted;
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
  let envelopeFails = false;
  let envelopeHeld = false;
  const credentials: Uint8Array[] = [];
  const fetchEnvelope: WorkspaceRecoveryInput['fetchCurrentEnvelope'] = (
    recipient,
    epoch,
    _identity,
    credential
  ) =>
    Effect.gen(function* () {
      credentials.push(new Uint8Array(credential));
      if (envelopeFails) return yield* Effect.fail(new Error('synthetic no envelope'));
      if (envelopeHeld) return { pending: true as const };
      return {
        sender: f.owner.publicKey,
        frame: yield* prepareEpochEnvelope({
          context: {
            genesis: f.initial.genesis,
            epoch: ok(Bytes.epochNumber(epoch)),
            sender: f.owner.publicKey,
            recipient,
          },
          key: f.epochKey,
          signer: f.owner,
          ledger: () => Effect.sync(f.view),
        }),
      };
    });
  const owner = (vault: RecoveryVault, keys: WorkspaceRecoveryInput['installed'] = installed) =>
    makeWorkspaceRecovery({
      vault,
      local: storage.local,
      genesis: f.initial.genesis,
      membershipId: f.membership,
      personalSigner: f.owner,
      ledger: () => Effect.sync(f.view),
      submitOriginal: submit,
      installed: keys,
      trust: {
        source: 'synthetic device that verified the workspace',
        genesisRecord: f.initial.record,
        head: hex(f.view().head.toBytes()),
        length: f.records.length,
      },
      fetchCurrentEnvelope: fetchEnvelope,
    });
  const recoveryDevices = () =>
    [...f.view().inspectState().devices]
      .filter(([, device]) => device.kind === 'recovery')
      .map(([id]) => id);
  const oldVault = yield* createRecoveryVault({
    locator: 'https://synthetic.invalid/vault',
    ...storage,
  });
  const oldOwner = yield* owner(oldVault.vault);
  yield* oldOwner.setup();
  const [oldR] = recoveryDevices();
  const newVault = yield* createRecoveryVault({
    locator: 'https://synthetic.invalid/vault',
    ...storage,
  });
  const newOwner = yield* owner(newVault.vault);
  const replace = (
    workflow: Effect.Success<ReturnType<typeof owner>>,
    finish: () => Effect.Effect<void>
  ) =>
    replaceAccountVault({
      workspaces: [
        {
          name: 'synthetic workspace',
          setup: workflow.setup,
          revokeOtherRecoveryDevices: workflow.revokeOtherRecoveryDevices,
        },
      ],
      finish,
    });
  const submitOnce = (record: Uint8Array) =>
    f.records.some((row) => hex(row) === hex(record))
      ? Effect.succeed({ outcome: 'Committed' as const, record: new Uint8Array(record) })
      : submit(record);
  return {
    f,
    oldVault,
    fetchEnvelope,
    submitOnce,
    local: storage.local,
    seenCredentials: () => credentials,
    owner,
    oldR,
    newVault,
    newOwner,
    oldOwner,
    submit,
    recoveryDevices,
    replace,
    holdEnvelope: (held: boolean) => {
      envelopeHeld = held;
    },
    failEnvelope: (fails: boolean) => {
      envelopeFails = fails;
    },
    interceptSubmit: (next: typeof intercept) => {
      intercept = next;
    },
  };
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
              userVerified: true,
              extension: { results: { first: new Uint8Array(32).fill(77).buffer } },
            });
            yield* vault.addPasskey({
              registration: yield* verifiedPasskeyRegistration({
                credentialId: 'synthetic-credential',
                extension: { enabled: true },
              }),
              assertion: prf,
              label: 'Synthetic passkey',
            });
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
              verifiedPasskeyPrf({
                credentialId: 'login-onlyA',
                userVerified: true,
                extension: { enabled: false },
              })
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
            const registrations: { record: string; hash: string | null }[] = [];
            const submit = (
              record: Uint8Array,
              registration: { readonly recoveryCredentialHash: Uint8Array } | null = null
            ) =>
              Effect.gen(function* () {
                registrations.push({
                  record: hex(record),
                  hash: registration ? hex(registration.recoveryCredentialHash) : null,
                });
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
            // R's admission (including its post-crash reconciliation) carries the hash
            // of the credential derived from R's own package; nothing else does.
            const hashOf = (ref: typeof oldRef) =>
              Effect.acquireUseRelease(
                created.vault.readEntry(ref),
                (bundle) =>
                  Effect.sync(() => {
                    const derived = deriveRecoveryAccessCredential(bundle);
                    derived.credential.fill(0);
                    return hex(derived.credentialHash);
                  }),
                (bundle) => Effect.sync(() => wipeRecoveryPackage(bundle))
              );
            const expectedHash = yield* hashOf(oldRef);
            const registered = registrations.filter((row) => row.hash !== null);
            expect(registered.length).toBeGreaterThanOrEqual(2);
            expect(new Set(registered.map((row) => row.hash))).toEqual(new Set([expectedHash]));
            expect(new Set(registered.map((row) => row.record)).size).toBe(1);
            expect(registrations.every((row) => row.hash !== null)).toBe(true);
            const beforeReplace = registrations.length;
            expect(
              (yield* workflow.replace({ requestId: 'routine-one', compromised: false }))
                .recoverable
            ).toBe(true);
            const afterReplacement = yield* created.vault.readIndex();
            const newHash = yield* hashOf(
              afterReplacement.value.entries.find((ref) => !ref.retired)!
            );
            const replacing = registrations.slice(beforeReplace);
            // The new R's admission registers its own credential; the old R's revocation registers none.
            expect(replacing.some((row) => row.hash === newHash)).toBe(true);
            expect(replacing.some((row) => row.hash === null)).toBe(true);
            expect(replacing.every((row) => row.hash === null || row.hash === newHash)).toBe(true);
            expect(newHash).not.toBe(expectedHash);
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
              submitOriginalAsRecovery: (record) => submit(record, null),
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
                submitOriginalAsRecovery: (record) => submit(record, null),
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
  it('refuses a restore when the served history lacks the package checkpoint', () =>
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
              }),
              journal = yield* Layer.build(
                sqliteSubmissionJournal({ path: join(dir, 'p09.sqlite') })
              ).pipe(Effect.map((context) => Context.get(context, SubmissionJournal))),
              installed = yield* makeSqliteProtectedEpochKeys({
                path: join(dir, 'keys.sqlite'),
                mode: 'create',
                genesis: f.initial.genesis,
                recipient: f.owner.publicKey,
                ledger: () => Effect.sync(f.view),
                protector: labSyntheticProtector,
              });
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
            const workflow = yield* makeWorkspaceRecovery({
              vault: created.vault,
              local: storage.local,
              genesis: f.initial.genesis,
              membershipId: f.membership,
              personalSigner: f.owner,
              ledger: () => Effect.sync(f.view),
              submitOriginal: submit,
              installed,
              // A later head of a fork the served history does not contain.
              trust: {
                source: 'synthetic checkpoint from a device that saw another history',
                genesisRecord: f.initial.record,
                head: hex(new Uint8Array(32).fill(66)),
                length: 1,
              },
              fetchCurrentEnvelope: (recipient, epoch) =>
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
            });
            yield* workflow.setup();
            const before = f.records.length;
            const refused = yield* Effect.result(
              workflow.restoreFromRecovery({
                personal: { ...f.personal, encryptionPublicKey: f.personal.enc },
                submitOriginalAsRecovery: (record) => submit(record),
              })
            );
            expect(refused).toMatchObject({ _tag: 'Failure', failure: { code: 'authentication' } });
            expect(f.records).toHaveLength(before);
          })
        )
      );
    }));
  it('replaces the whole vault without the old V: new R proves itself, then old R is revoked', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { f, oldOwner, newOwner, oldR, submit, recoveryDevices, replace, failEnvelope } =
              yield* replacementFixture(dir);
            let finished = 0;
            const run = () =>
              replace(newOwner, () =>
                Effect.sync(() => {
                  finished += 1;
                })
              );
            // A failed envelope test revokes nothing and retires nothing.
            failEnvelope(true);
            expect(Result.isFailure(yield* Effect.result(run()))).toBe(true);
            expect(recoveryDevices()).toContain(oldR);
            expect(finished).toBe(0);
            failEnvelope(false);
            expect(yield* run()).toEqual({ outcome: 'Committed' });
            expect(finished).toBe(1);
            const remaining = recoveryDevices();
            expect(remaining).toHaveLength(1);
            expect(remaining).not.toContain(oldR);
            // The revoked R stops an old-file restore at the existing active-R check.
            const refused = yield* Effect.result(
              oldOwner.restoreFromRecovery({
                personal: { ...f.personal, encryptionPublicKey: f.personal.enc },
                submitOriginalAsRecovery: (record) => submit(record),
              })
            );
            expect(refused).toMatchObject({ _tag: 'Failure', failure: { code: 'unauthorized' } });
            // Rerunning after completion signs nothing new.
            const before = f.records.length;
            expect(yield* run()).toEqual({ outcome: 'Committed' });
            expect(f.records).toHaveLength(before);
            const restored = yield* newOwner.restoreFromRecovery({
              personal: { ...f.personal, encryptionPublicKey: f.personal.enc },
              submitOriginalAsRecovery: (record) => submit(record),
            });
            expect(restored.outcome).toBe('Committed');
          })
        )
      );
    }));
  it('rebuilds a revocation once the ledger proves its original can never commit', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            yield* r.newOwner.setup();
            const revocations: string[] = [];
            r.interceptSubmit((record) =>
              Effect.gen(function* () {
                const body = ok(decodeRecord(record)).body;
                if (body.type !== 'ordinary' || body.operation.type !== 'revokeDevice') return;
                revocations.push(hex(record));
                if (revocations.length > 1) return;
                // Ordinary concurrency: another device's admission takes the position.
                const stranger = yield* generateDevice();
                const command = yield* prepareDeviceAdmission({
                  genesis: r.f.initial.genesis,
                  membershipId: r.f.membership,
                  encryptionPublicKey: stranger.enc,
                  kind: 'personal',
                  signer: stranger,
                });
                const admission = yield* signLedgerRecord(
                  ok(prepareLedgerCommand(r.f.view(), r.f.owner.publicKey, command)),
                  r.f.owner
                );
                r.interceptSubmit(null);
                yield* r.submit(admission);
                r.interceptSubmit((next) =>
                  Effect.sync(() => {
                    revocations.push(hex(next));
                  })
                );
                return { outcome: 'Conflict' as const, record };
              })
            );
            let finished = 0;
            const run = () =>
              r.replace(r.newOwner, () =>
                Effect.sync(() => {
                  finished += 1;
                })
              );
            // A rebuilt workflow finishes: the stale original is no longer resent forever.
            let outcome = (yield* run()).outcome;
            for (let attempt = 0; attempt < 3 && outcome !== 'Committed'; attempt++) {
              const rebuilt = yield* r.owner(r.newVault.vault);
              outcome = (yield* r.replace(rebuilt, () =>
                Effect.sync(() => {
                  finished += 1;
                })
              )).outcome;
            }
            expect(outcome).toBe('Committed');
            expect(finished).toBe(1);
            expect(r.recoveryDevices()).not.toContain(r.oldR);
            expect(new Set(revocations).size).toBe(2);
          })
        )
      );
    }));
  it('resends the same original after an unknown result, never a second one', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            yield* r.newOwner.setup();
            const sent: string[] = [];
            r.interceptSubmit((record) =>
              Effect.sync(() => {
                const body = ok(decodeRecord(record)).body;
                if (body.type !== 'ordinary' || body.operation.type !== 'revokeDevice') return;
                sent.push(hex(record));
                return { outcome: 'Pending' as const, record };
              })
            );
            let finished = 0;
            const finish = () =>
              Effect.sync(() => {
                finished += 1;
              });
            expect((yield* r.replace(r.newOwner, finish)).outcome).toBe('Pending');
            const rebuilt = yield* r.owner(r.newVault.vault);
            expect((yield* r.replace(rebuilt, finish)).outcome).toBe('Pending');
            expect(sent).toHaveLength(2);
            expect(new Set(sent).size).toBe(1);
            expect(finished).toBe(0);
            // The original commits once the service answers again.
            r.interceptSubmit(null);
            const before = r.f.records.length;
            expect((yield* r.replace(yield* r.owner(r.newVault.vault), finish)).outcome).toBe(
              'Committed'
            );
            expect(r.f.records).toHaveLength(before + 1);
            expect(hex(r.f.records.at(-1)!)).toBe(sent[0]);
            expect(finished).toBe(1);
          })
        )
      );
    }));
  it('revokes the old R first on a suspected leak, even while the new R cannot pass', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            let finished = 0;
            const run = () =>
              replaceAccountVault({
                workspaces: [
                  {
                    name: 'synthetic workspace',
                    setup: r.newOwner.setup,
                    revokeOtherRecoveryDevices: r.newOwner.revokeOtherRecoveryDevices,
                  },
                ],
                compromised: true,
                finish: () =>
                  Effect.sync(() => {
                    finished += 1;
                  }),
              });
            r.failEnvelope(true);
            expect(Result.isFailure(yield* Effect.result(run()))).toBe(true);
            expect(r.recoveryDevices()).not.toContain(r.oldR);
            expect(finished).toBe(0);
            r.failEnvelope(false);
            expect(yield* run()).toEqual({ outcome: 'Committed' });
            expect(r.recoveryDevices()).toHaveLength(1);
            expect(finished).toBe(1);
          })
        )
      );
    }));
  it('abandons a replacement by revoking only the new R, then starts again', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            yield* r.newOwner.setup();
            expect(r.recoveryDevices()).toHaveLength(2);
            let abandoned = 0;
            const run = () =>
              abandonVaultReplacement({
                workspaces: [
                  {
                    name: 'synthetic workspace',
                    revokeOwnRecoveryDevice: r.newOwner.revokeOwnRecoveryDevice,
                  },
                ],
                abandon: () =>
                  Effect.sync(() => {
                    abandoned += 1;
                  }),
              });
            expect(yield* run()).toEqual({ outcome: 'Committed' });
            expect(r.recoveryDevices()).toEqual([r.oldR]);
            expect(abandoned).toBe(1);
            // Rerunning after a lost reply signs nothing new.
            const before = r.f.records.length;
            expect(yield* run()).toEqual({ outcome: 'Committed' });
            expect(r.f.records).toHaveLength(before);
          })
        )
      );
    }));
  it('abandons with the new file lost: the journal alone names the new R', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            yield* r.newOwner.setup();
            const abandon = yield* abandonWorkspaceRecovery({
              vaultId: r.newVault.vault.vaultId,
              local: r.local,
              genesis: r.f.initial.genesis,
              membershipId: r.f.membership,
              personalSigner: r.f.owner,
              ledger: () => Effect.sync(r.f.view),
              submitOriginal: r.submit,
              genesisRecord: r.f.initial.record,
            });
            expect(yield* abandon.revokeOwnRecoveryDevice()).toEqual({ outcome: 'Committed' });
            expect(r.recoveryDevices()).toEqual([r.oldR]);
          })
        )
      );
    }));
  it('hands the envelope fetch the credential registered with this R', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            yield* r.newOwner.setup();
            const index = yield* r.newVault.vault.readIndex();
            const bundle = yield* r.newVault.vault.readEntry(index.value.entries[0]!);
            const derived = deriveRecoveryAccessCredential(bundle);
            wipeRecoveryPackage(bundle);
            expect(r.seenCredentials().map(hex)).toContain(hex(derived.credential));
          })
        )
      );
    }));
  it('maps service replies and asks for delivery once before giving up', async () => {
    const appended: unknown[] = [];
    let refreshed = 0;
    const submit = recoverySubmitOriginal({
      append: (request) =>
        Effect.sync(() => {
          appended.push(request);
          return { status: appended.length === 1 ? 'committed' : 'conflict' } as const;
        }),
      refresh: () =>
        Effect.sync(() => {
          refreshed += 1;
        }),
    });
    const f = await Effect.runPromise(fixture());
    const record = f.initial.record;
    await Effect.runPromise(
      Effect.gen(function* () {
        const hash = new Uint8Array(32).fill(9);
        expect((yield* submit(record, { recoveryCredentialHash: hash })).outcome).toBe('Committed');
        expect((yield* submit(record, null)).outcome).toBe('Conflict');
      })
    );
    expect(refreshed).toBe(2);
    expect(appended).toEqual([
      {
        requestId: hex(hashRecordBytes(record).toBytes()),
        recordHex: hex(record),
        credentialHash: hex(new Uint8Array(32).fill(9)),
      },
      { requestId: hex(hashRecordBytes(record).toBytes()), recordHex: hex(record) },
    ]);
    const sender = hex(f.owner.publicKey.toBytes());
    let items: { sender: string; frame: Uint8Array }[] = [];
    let delivered = 0;
    const seen: string[] = [];
    const fetch = recoveryFetchEnvelope({
      mailbox: (credential) => {
        seen.push(credential);
        return { fetch: () => Effect.sync(() => ({ items, next: null })) };
      },
      deliver: () =>
        Effect.sync(() => {
          delivered += 1;
          items = [{ sender, frame: new Uint8Array([7]) }];
        }),
    });
    const recipient = f.personal.publicKey;
    const found = await Effect.runPromise(
      fetch(recipient, 0, undefined as never, new Uint8Array(32).fill(8))
    );
    expect(delivered).toBe(1);
    expect(seen[0]).toBe(hex(new Uint8Array(32).fill(8)));
    expect('frame' in found && found.frame).toEqual(new Uint8Array([7]));
    items = [];
    const silent = recoveryFetchEnvelope({
      mailbox: () => ({ fetch: () => Effect.succeed({ items: [] }) }),
      deliver: () => Effect.void,
    });
    expect(
      await Effect.runPromise(silent(recipient, 0, undefined as never, new Uint8Array(32)))
    ).toEqual({ pending: true });
  });
  it('waits for a slow delivery instead of failing, then finishes without a second R', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            let finished = 0;
            const finish = () =>
              Effect.sync(() => {
                finished += 1;
              });
            r.holdEnvelope(true);
            expect(yield* r.replace(r.newOwner, finish)).toEqual({
              outcome: 'Pending',
              step: 'setup',
              workspace: 'synthetic workspace',
            });
            expect(r.recoveryDevices()).toContain(r.oldR);
            expect(r.recoveryDevices()).toHaveLength(2);
            expect(finished).toBe(0);
            r.holdEnvelope(false);
            expect(yield* r.replace(r.newOwner, finish)).toEqual({ outcome: 'Committed' });
            expect(r.recoveryDevices()).toHaveLength(1);
          })
        )
      );
    }));
  it('reports a restore as pending while the envelope is on its way', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            yield* r.newOwner.setup();
            r.holdEnvelope(true);
            const before = r.f.records.length;
            const result = yield* r.newOwner.restoreFromRecovery({
              personal: { ...r.f.personal, encryptionPublicKey: r.f.personal.enc },
              submitOriginalAsRecovery: (record) => r.submit(record),
            });
            expect(result.outcome).toBe('Pending');
            expect(r.f.records).toHaveLength(before);
          })
        )
      );
    }));
  it('hands the recovery submission the credential of the R admitting the device', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            yield* r.newOwner.setup();
            const index = yield* r.newVault.vault.readIndex();
            const bundle = yield* r.newVault.vault.readEntry(index.value.entries[0]!);
            const derived = deriveRecoveryAccessCredential(bundle);
            wipeRecoveryPackage(bundle);
            const seen: string[] = [];
            const result = yield* r.newOwner.restoreFromRecovery({
              personal: { ...r.f.personal, encryptionPublicKey: r.f.personal.enc },
              submitOriginalAsRecovery: (record, _identity, credential) => {
                seen.push(hex(credential));
                return r.submit(record);
              },
            });
            expect(result.outcome).toBe('Committed');
            expect(seen).toEqual([hex(derived.credential)]);
          })
        )
      );
    }));
  it('replays served history from the package genesis and refuses a partial or other ledger', async () => {
    const [f, other] = await Effect.runPromise(Effect.all([fixture(), fixture()]));
    const page = (records: readonly Uint8Array[], startIndex = 0) => ({
      startIndex,
      recordsHex: records.map(hex),
      nextCursor: null,
      checkpoint: null,
    });
    const ledger = (pages: readonly ReturnType<typeof page>[]) =>
      Effect.runPromise(
        Effect.result(
          recoveryLedger({ genesis: f.initial.genesis, pages: () => Effect.succeed(pages) })()
        )
      );
    expect(await ledger([page(f.records)])).toMatchObject({ _tag: 'Success' });
    expect(await ledger([page(f.records, 1)])).toMatchObject({ _tag: 'Failure' });
    expect(await ledger([page(other.records)])).toMatchObject({ _tag: 'Failure' });
    expect(await ledger([])).toMatchObject({ _tag: 'Failure' });
  });
  it('keeps restored keys usable after core releases its own, for a real SQLite install', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            yield* r.newOwner.setup();
            const keys = memoryRecoveryEpochKeys();
            const restorer = yield* r.owner(r.newVault.vault, keys);
            const restored = yield* restorer.restoreFromRecovery({
              personal: { ...r.f.personal, encryptionPublicKey: r.f.personal.enc },
              submitOriginalAsRecovery: (record) => r.submit(record),
            });
            expect(restored.outcome).toBe('Committed');
            const installed = yield* makeSqliteProtectedEpochKeys({
              path: join(dir, 'new-device-keys.sqlite'),
              mode: 'create',
              genesis: r.f.initial.genesis,
              recipient: r.f.personal.publicKey,
              ledger: () => Effect.sync(r.f.view),
              protector: labSyntheticProtector,
            });
            const entries = keys.entries();
            expect(entries.length).toBeGreaterThan(0);
            for (const [epoch, key] of entries) yield* installed.saveAndReload(epoch, key);
            keys.dispose();
            const read = yield* installed.read(0);
            expect(
              ok(commitEpochKey(r.f.initial.genesis, 0, read)).equals(
                ok(epochHistoryPacket(r.f.view(), 0)).commitment
              )
            ).toBe(true);
            expect(keys.entries()).toHaveLength(0);
          })
        )
      );
    }));
  it('reads a ledger longer than one page with a fixed checkpoint', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (let index = 0; index < 34; index++) {
          const device = yield* generateDevice();
          const admit = yield* prepareDeviceAdmission({
            genesis: f.initial.genesis,
            membershipId: f.membership,
            encryptionPublicKey: device.enc,
            kind: 'personal',
            signer: device,
          });
          for (const command of [
            admit,
            { _tag: 'RevokeDevice', target: device.publicKey } as const,
          ])
            f.records.push(
              new Uint8Array(
                yield* signLedgerRecord(
                  ok(prepareLedgerCommand(f.view(), f.owner.publicKey, command)),
                  f.owner
                )
              )
            );
        }
        expect(f.records.length).toBe(69);
        const size = 25;
        const fixed = { head: hex(f.view().head.toBytes()), length: f.records.length };
        const history = (next?: { readonly cursor: string; readonly checkpoint: typeof fixed }) => {
          if (next && next.checkpoint?.head !== fixed.head)
            return Effect.fail(new Error('e2ee_invalid_cursor'));
          const startIndex = next ? Number(next.cursor) : 0;
          const end = startIndex + size;
          return Effect.succeed({
            startIndex,
            checkpoint: fixed,
            recordsHex: f.records.slice(startIndex, end).map(hex),
            nextCursor: end < f.records.length ? String(end) : null,
          });
        };
        const view = yield* recoveryLedger({
          genesis: f.initial.genesis,
          pages: () => readRecoveryHistory(history),
        })();
        expect(view.length).toBe(69);
      })
    );
  });
  it('retries a restore whose keys never installed, then leaves it alone', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            yield* r.newOwner.setup();
            let adoptions = 0;
            let hasIdentity = false;
            const keys = memoryRecoveryEpochKeys();
            const target = {
              id: 'workspace',
              name: 'Workspace',
              genesisHash: hex(r.f.initial.genesis.toBytes()),
              hasIdentity: () => hasIdentity,
              connect: (anchor: VaultRestoreAnchor) =>
                Effect.succeed({
                  personalSigner: r.f.personal,
                  personal: { ...r.f.personal, encryptionPublicKey: r.f.personal.enc },
                  ledger: () => Effect.sync(r.f.view),
                  installed: keys,
                  fetchCurrentEnvelope: r.fetchEnvelope,
                  submitOriginalAsRecovery: (record: Uint8Array) => r.submitOnce(record),
                  acquirePersonal: () => Effect.fail(new Error('unused')),
                  recovered: keys.entries,
                  adopt: () =>
                    Effect.suspend(() => {
                      expect(anchor.genesis.equals(r.f.initial.genesis)).toBe(true);
                      adoptions += 1;
                      hasIdentity = true;
                      return adoptions === 1
                        ? Effect.fail(new Error('synthetic install failure'))
                        : Effect.void;
                    }),
                }),
            };
            const run = () =>
              restoreVaultWorkspaces({
                vault: r.newVault.vault,
                local: r.local,
                targets: [target],
              });
            expect(yield* run()).toEqual([{ name: 'Workspace', outcome: 'Failed' }]);
            expect(yield* recoveryRestoreIncomplete(r.local, 'workspace')).toBe(true);
            expect(yield* run()).toEqual([{ name: 'Workspace', outcome: 'Committed' }]);
            expect(adoptions).toBe(2);
            expect(yield* recoveryRestoreIncomplete(r.local, 'workspace')).toBe(false);
            expect(yield* run()).toEqual([]);
            expect(adoptions).toBe(2);
          })
        )
      );
    }));
  it('keeps a new vault restore retryable after an old vault restore finished', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            const second = yield* generateDevice();
            let device = r.f.personal;
            let hasIdentity = false;
            let failInstall = false;
            let adoptions = 0;
            const target = () => {
              const keys = memoryRecoveryEpochKeys();
              return {
                id: 'workspace',
                name: 'Workspace',
                genesisHash: hex(r.f.initial.genesis.toBytes()),
                hasIdentity: () => hasIdentity,
                connect: () =>
                  Effect.succeed({
                    personalSigner: device,
                    personal: { ...device, encryptionPublicKey: device.enc },
                    ledger: () => Effect.sync(r.f.view),
                    installed: keys,
                    fetchCurrentEnvelope: r.fetchEnvelope,
                    submitOriginalAsRecovery: (record: Uint8Array) => r.submitOnce(record),
                    acquirePersonal: () => Effect.fail(new Error('unused')),
                    recovered: keys.entries,
                    adopt: () =>
                      Effect.scoped(
                        Effect.gen(function* () {
                          adoptions += 1;
                          hasIdentity = true;
                          const installed = yield* makeSqliteProtectedEpochKeys({
                            path: join(dir, `restored-${adoptions}.sqlite`),
                            mode: 'create',
                            genesis: r.f.initial.genesis,
                            recipient: device.publicKey,
                            ledger: () => Effect.sync(r.f.view),
                            protector: labSyntheticProtector,
                          });
                          if (failInstall)
                            return yield* Effect.fail(new Error('synthetic install'));
                          for (const [epoch, key] of keys.entries())
                            yield* installed.saveAndReload(epoch, key);
                        })
                      ),
                  }),
              };
            };
            const run = (vault: RecoveryVault) =>
              restoreVaultWorkspaces({ vault, local: r.local, targets: [target()] });
            // The old vault restores and finishes.
            expect(yield* run(r.oldVault.vault)).toEqual([
              { name: 'Workspace', outcome: 'Committed' },
            ]);
            expect(yield* recoveryRestoreIncomplete(r.local, 'workspace')).toBe(false);
            // Finished work is not repeated.
            expect(yield* run(r.oldVault.vault)).toEqual([]);
            // A new R passes and the old one is revoked; the local identity is rebuilt.
            yield* r.newOwner.setup();
            yield* r.newOwner.revokeOtherRecoveryDevices();
            hasIdentity = false;
            device = second;
            failInstall = true;
            expect(yield* run(r.newVault.vault)).toEqual([
              { name: 'Workspace', outcome: 'Failed' },
            ]);
            expect(hasIdentity).toBe(true);
            expect(yield* recoveryRestoreIncomplete(r.local, 'workspace')).toBe(true);
            failInstall = false;
            expect(yield* run(r.newVault.vault)).toEqual([
              { name: 'Workspace', outcome: 'Committed' },
            ]);
            expect(yield* recoveryRestoreIncomplete(r.local, 'workspace')).toBe(false);
            expect(yield* run(r.newVault.vault)).toEqual([]);
          })
        )
      );
    }));
  it('stops a restore when its progress cannot be reopened', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const r = yield* replacementFixture(dir);
            let connected = 0;
            const target = {
              id: 'workspace',
              name: 'Workspace',
              genesisHash: hex(r.f.initial.genesis.toBytes()),
              hasIdentity: () => false,
              connect: () =>
                Effect.suspend(() => {
                  connected += 1;
                  return Effect.fail(new Error('unused'));
                }),
            };
            const refusing = {
              ...r.local,
              compareAndSwap: () => Effect.succeed('Conflict' as const),
            };
            expect(
              yield* restoreVaultWorkspaces({
                vault: r.oldVault.vault,
                local: refusing,
                targets: [target],
              })
            ).toEqual([{ name: 'Workspace', outcome: 'Failed' }]);
            expect(connected).toBe(0);
          })
        )
      );
    }));
  it('names the workspaces a device cannot act on', () => {
    expect(
      planVaultReplacement(
        [
          { id: 'a', name: 'Alpha' },
          { id: 'b', name: 'Beta' },
        ],
        new Set(['a'])
      )
    ).toEqual({ covered: [{ id: 'a', name: 'Alpha' }], uncovered: [{ id: 'b', name: 'Beta' }] });
  });
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

describe('passkey unlock through the platform port', () => {
  /** A platform authenticator with real discoverable credentials and a fixed PRF. */
  const authenticator = (options: { prf?: boolean; verified?: boolean; length?: number } = {}) => {
    const credentials = new Map<string, { handle: Uint8Array; secret: number }>();
    const calls = { registered: 0, authenticated: 0 };
    const port: E2eePasskeyPort = {
      available: async () => true,
      register: async (request) => {
        calls.registered += 1;
        const credentialId = `credential${credentials.size}A`;
        credentials.set(credentialId, {
          handle: new Uint8Array(request.userHandle),
          secret: 40 + credentials.size,
        });
        return { credentialId, prfEnabled: options.prf ?? true };
      },
      authenticate: async (request) => {
        calls.authenticated += 1;
        const [credentialId, credential] = [...credentials].find(
          ([id]) =>
            request.allowCredentialIds.length === 0 || request.allowCredentialIds.includes(id)
        )!;
        return {
          credentialId,
          userHandle: credential.handle,
          userVerified: options.verified ?? true,
          prfFirst: new Uint8Array(options.length ?? 32).fill(credential.secret),
        };
      },
    };
    return { port, calls };
  };
  const vaultFixture = Effect.fnUntraced(function* (dir: string) {
    const storage = yield* makeLabRecoveryVaultStore({
      path: join(dir, 'vault.sqlite'),
      mode: 'create',
    });
    const created = yield* createRecoveryVault({
      locator: 'https://synthetic.invalid/vault',
      ...storage,
    });
    return { storage, vault: created.vault };
  });
  it('enrolls through a real assertion, then opens V on a device with no file', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { storage, vault } = yield* vaultFixture(dir);
            const { port, calls } = authenticator();
            yield* enrollVaultPasskey({ port, vault, label: 'iCloud Keychain' });
            expect(calls).toEqual({ registered: 1, authenticated: 1 });
            expect(yield* vault.listPasskeys()).toHaveLength(1);
            const opened = yield* unlockVaultWithPasskey({
              port,
              open: ({ vaultId, credential }) =>
                openRecoveryVaultWithPasskey({
                  vaultId,
                  locator: 'https://synthetic.invalid/vault',
                  credential,
                  ...storage,
                }),
            });
            expect(opened.vaultId).toBe(vault.vaultId);
          })
        )
      );
    }));
  it.each([
    ['reports no PRF at registration', { prf: false }],
    ['skips user verification', { verified: false }],
    ['returns a wrong-length result', { length: 16 }],
  ])('writes nothing when an authenticator %s', (_name, options) =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { vault } = yield* vaultFixture(dir);
            const failed = yield* Effect.result(
              enrollVaultPasskey({ port: authenticator(options).port, vault, label: 'Other' })
            );
            expect(failed).toMatchObject({ _tag: 'Failure', failure: { code: 'prf-unavailable' } });
            expect(yield* vault.listPasskeys()).toHaveLength(0);
          })
        )
      );
    })
  );
  it('lists enrolled passkeys so a second registration cannot overwrite them', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { vault } = yield* vaultFixture(dir);
            const { port } = authenticator();
            yield* enrollVaultPasskey({ port, vault, label: 'First' });
            const seen: (readonly string[])[] = [];
            yield* enrollVaultPasskey({
              port: {
                ...port,
                register: (request) => {
                  seen.push(request.excludeCredentialIds);
                  return port.register(request);
                },
                authenticate: (request) =>
                  port.authenticate({
                    ...request,
                    allowCredentialIds: ['credential1A'],
                  }),
              },
              vault,
              label: 'Second',
            });
            expect(seen[0]).toEqual([(yield* vault.listPasskeys())[0]!.credentialId]);
          })
        )
      );
    }));
  it('passes a dismissed prompt through without changing the vault', () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { vault } = yield* vaultFixture(dir);
            const { port } = authenticator();
            const cancelled = new E2eePasskeyCancelled();
            const failed = yield* Effect.result(
              enrollVaultPasskey({
                port: { ...port, register: () => Promise.reject(cancelled) },
                vault,
                label: 'Dismissed',
              })
            );
            expect(failed).toMatchObject({ _tag: 'Failure', failure: cancelled });
            expect(yield* vault.listPasskeys()).toHaveLength(0);
          })
        )
      );
    }));
});
describe('passkey wrapping of one vault master key', () => {
  const output = (fill: number) => new Uint8Array(32).fill(fill).buffer;
  const passkey = Effect.fnUntraced(function* (credentialId: string, fill: number) {
    return {
      registration: yield* verifiedPasskeyRegistration({
        credentialId,
        extension: { enabled: true },
      }),
      assertion: yield* verifiedPasskeyPrf({
        credentialId,
        userVerified: true,
        extension: { results: { first: output(fill) } },
      }),
      label: `Passkey ${credentialId}`,
    };
  });
  const created = Effect.fnUntraced(function* (dir: string) {
    const storage = yield* makeLabRecoveryVaultStore({
      path: join(dir, 'vault.sqlite'),
      mode: 'create',
    });
    const { vault, recoveryFile } = yield* createRecoveryVault({
      locator: 'https://synthetic.invalid/vault',
      ...storage,
    });
    return { storage, vault, recoveryFile };
  });

  it('judges each ceremony on what WebAuthn actually reports for it', async () => {
    const first = output(1);
    const rejected = async (work: Effect.Effect<unknown, unknown>) =>
      Result.isFailure(await Effect.runPromise(Effect.result(work)));
    const assertion = (input: {
      credentialId?: string;
      userVerified?: boolean;
      extension: unknown;
    }) => verifiedPasskeyPrf({ credentialId: 'abc_-Q', userVerified: true, ...input });

    // A real authentication result has no `enabled`.
    await Effect.runPromise(assertion({ extension: { results: { first } } }));
    expect(await rejected(assertion({ extension: { enabled: false, results: { first } } }))).toBe(
      true
    );
    expect(await rejected(assertion({ extension: { enabled: true } }))).toBe(true);
    expect(
      await rejected(assertion({ extension: { results: { first: new ArrayBuffer(31) } } }))
    ).toBe(true);
    expect(
      await rejected(assertion({ userVerified: false, extension: { results: { first } } }))
    ).toBe(true);
    for (const credentialId of ['', 'padded==', 'not+base64url', 'A', 'QR', 'QUF'])
      expect(await rejected(assertion({ credentialId, extension: { results: { first } } }))).toBe(
        true
      );

    const registration = (extension: unknown) =>
      verifiedPasskeyRegistration({ credentialId: 'abc_-Q', extension });
    await Effect.runPromise(registration({ enabled: true }));
    expect(await rejected(registration({ enabled: false }))).toBe(true);
    expect(await rejected(registration({ results: { first } }))).toBe(true);
    expect(await rejected(registration(undefined))).toBe(true);
  });

  it('opens one V from either passkey on a device that has no recovery file', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { storage, vault } = yield* created(dir);
            const a = yield* passkey('credential-a', 21),
              b = yield* passkey('credential-b', 22);
            yield* vault.addPasskey(a);
            yield* vault.addPasskey(b);
            expect((yield* vault.listPasskeys()).map((row) => row.label)).toEqual([
              'Passkey credential-a',
              'Passkey credential-b',
            ]);

            // A new device learns the vault only from the ceremony's user handle.
            const vaultId = yield* vaultIdFromPasskeyUserHandle(passkeyUserHandle(vault.vaultId));
            expect(vaultId).toBe(vault.vaultId);
            const pinless = yield* makeLabRecoveryVaultStore({
              path: join(dir, 'other.sqlite'),
              mode: 'create',
            });
            for (const credential of [a.assertion, b.assertion]) {
              const session = yield* openRecoveryVaultWithPasskey({
                vaultId,
                locator: 'https://synthetic.invalid/vault',
                credential,
                store: storage.store,
                local: pinless.local,
              });
              expect((yield* session.listPasskeys()).length).toBe(2);
            }
            // A different passkey never derives the wrapping key.
            const stranger = yield* passkey('credential-a', 99);
            const failed = yield* Effect.result(
              openRecoveryVaultWithPasskey({
                vaultId,
                locator: 'https://synthetic.invalid/vault',
                credential: stranger.assertion,
                ...storage,
              })
            );
            expect(Result.isFailure(failed)).toBe(true);
          })
        )
      );
    }));

  it('rejects a user handle that is not a vault id and fixes one PRF input', async () => {
    expect(new TextDecoder().decode(vaultPrfInput())).toBe('lody-e2ee/vault-v1/prf-input\0');
    const short = await Effect.runPromise(
      Effect.result(vaultIdFromPasskeyUserHandle(new Uint8Array(31)))
    );
    expect(Result.isFailure(short)).toBe(true);
  });

  it('refuses enrollment without a registration for the same credential', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { vault } = yield* created(dir);
            const a = yield* passkey('credential-a', 21),
              b = yield* passkey('credential-b', 22);
            for (const forged of [
              { ...a, registration: b.registration },
              { ...a, registration: { credentialId: 'credential-a' } },
            ]) {
              const failed = yield* Effect.result(vault.addPasskey(forged));
              expect(Result.isFailure(failed)).toBe(true);
            }
            expect(yield* vault.listPasskeys()).toEqual([]);
          })
        )
      );
    }));

  it('keeps a listed wrap through index writes, refuses its deletion, and removes it on request', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { storage, vault } = yield* created(dir);
            const f = yield* fixture();
            const a = yield* passkey('credential-a', 21);
            const entryId = yield* vault.addPasskey(a);

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
            const candidate = yield* vault.upload(bundle);
            wipeRecoveryPackage(bundle);
            expect((yield* vault.reserve(candidate)).outcome).toBe('Committed');
            expect((yield* vault.listPasskeys()).map((row) => row.entryId)).toEqual([entryId]);

            const header = (yield* storage.store.readIndex(vault.vaultId))!;
            const version = { revision: header.revision, digest: vaultCiphertextDigest(header) };
            const deletion = yield* Effect.result(
              storage.store.deleteUnreferenced(vault.vaultId, entryId, version)
            );
            expect(Result.isFailure(deletion)).toBe(true);
            expect(yield* storage.store.readEntry(vault.vaultId, entryId)).not.toBeNull();

            yield* vault.removePasskey(entryId);
            expect(yield* vault.listPasskeys()).toEqual([]);
            expect(yield* storage.store.readEntry(vault.vaultId, entryId)).toBeNull();
            const removed = yield* Effect.result(
              openRecoveryVaultWithPasskey({
                vaultId: vault.vaultId,
                locator: vault.locator,
                credential: a.assertion,
                ...storage,
              })
            );
            expect(Result.isFailure(removed)).toBe(true);
          })
        )
      );
    }));

  it('finishes an enrollment whose index commit was lost, and stops at the passkey limit', async () =>
    inDir(async (dir) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* makeLabRecoveryVaultStore({
              path: join(dir, 'vault.sqlite'),
              mode: 'create',
            });
            let lose = true;
            const store: typeof storage.store = {
              ...storage.store,
              compareAndSwapIndex: (...args) => {
                if (!lose) return storage.store.compareAndSwapIndex(...args);
                lose = false;
                return Effect.fail(new Error('lost before commit'));
              },
            };
            const { vault } = yield* createRecoveryVault({
              locator: 'https://synthetic.invalid/vault',
              store,
              local: storage.local,
            });
            const a = yield* passkey('credential-a', 21);
            expect(Result.isFailure(yield* Effect.result(vault.addPasskey(a)))).toBe(true);
            expect(yield* vault.listPasskeys()).toEqual([]);

            // The wrap is immutable and was uploaded, so the retry must reuse it.
            const id = yield* vault.addPasskey(a);
            expect((yield* vault.listPasskeys()).map((row) => row.entryId)).toEqual([id]);
            expect(yield* vault.addPasskey(a)).toBe(id);

            for (let n = 1; n < 8; n += 1)
              yield* vault.addPasskey(yield* passkey(`credential-${n}`, n));
            expect((yield* vault.listPasskeys()).length).toBe(8);
            const ninth = yield* Effect.result(vault.addPasskey(yield* passkey('credential-9', 9)));
            expect(Result.isFailure(ninth)).toBe(true);
          })
        )
      );
    }));
});
