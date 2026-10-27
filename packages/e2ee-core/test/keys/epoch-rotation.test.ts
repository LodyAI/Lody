import Database from 'better-sqlite3';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { runNativeChild } from '../native-child';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Result, Scope } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import * as Bytes from '../../src/internal/foundation/bytes';
import { decodeCbor, encodeCbor } from '../../src/internal/foundation/cbor';
import { disposeEpochKey } from '../../src/internal/foundation/epoch-key';
import {
  decodeRecord,
  extendLedger,
  hashRecordBytes,
  possessionSigningBytes,
  recordSigningBytes,
  verifyLedger,
  type LedgerView,
} from '../../src/internal/ledger';
import {
  prepareDeviceAdmission,
  prepareJoinRequest,
  prepareLedgerCommand,
} from '../../src/internal/ledger/admission';
import { prepareLedgerRecord, signLedgerRecord } from '../../src/internal/ledger/signing';
import { SubmissionJournal, LedgerLog, LedgerLogError } from '../../src/services';
import { sqliteSubmissionJournal } from '../../src/adapters/node-sqlite/submission-journal';
import {
  getCommittedEpochStagingKey,
  ownEpochStagedGroup,
  type EpochStagedGroup,
} from '../../src/internal/keys/staging';
import { checkEpochStageRequest } from '../../src/host/staging';
import { makeSqliteEpochRotation, type EpochStagingPort } from './harness';
import {
  commitEpochKey,
  recoverLedgerHistory,
  sealHistoryPacket,
} from '../../src/internal/keys/history';
import { prepareEpochEnvelope } from '../../src/internal/keys/envelope';
import { makeSqliteEpochReceiver } from './harness';
import { makeSqliteProtectedEpochKeys } from './harness';
import { makeSqliteKeyDistribution } from './harness';
import { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { makeSqliteRecipientMailbox } from './harness';
import { envelopeFixture, recipientPair } from './fixture';
import { synthetic } from './protection-fixture';
const ok = Result.getOrThrow;
function memberDevice(seed: number) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, seed),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = ok(
    Bytes.signingPublicKey(
      new Uint8Array(
        createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
      )
    )
  );
  return {
    publicKey,
    encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(seed + 100))),
    signBytes: (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey)),
    signer: {
      publicKey,
      sign: (message: Uint8Array) =>
        Effect.sync(() => ok(Bytes.signature(new Uint8Array(sign(null, message, privateKey))))),
    },
  };
}
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(kind: 0 | 1 | 2 = 0) {
  const f = envelopeFixture(kind),
    native = synthetic();
  const dir = mkdtempSync(path.join(tmpdir(), 'e2ee-epoch-rotation-'));
  dirs.push(dir);
  const files = {
    candidate: path.join(dir, 'candidate.sqlite'),
    keys: path.join(dir, 'keys.sqlite'),
    journal: path.join(dir, 'journal.sqlite'),
    history: path.join(dir, 'history.json'),
  };
  let view = f.view(),
    records = f.records(),
    mode: 'ok' | 'unavailable' | 'lost-ack' | 'lost-readback' = 'ok',
    readbackLost = false,
    signed = 0;
  const persist = () =>
    writeFileSync(
      files.history,
      JSON.stringify(records.map((r) => Buffer.from(r).toString('hex')))
    );
  persist();
  const append = (record: Uint8Array) => {
    view = ok(
      extendLedger(view, [record], { head: hashRecordBytes(record), length: view.length + 1 })
    );
    records.push(new Uint8Array(record));
    persist();
  };
  let revokedSeed = 30;
  const requestRotation = () => {
    const device = memberDevice(++revokedSeed),
      membership = view.inspectState().owner;
    const proof = device.signBytes(
      ok(
        possessionSigningBytes({
          genesis: f.context.genesis,
          targetMembershipId: membership,
          signingPublicKey: device.publicKey,
          encryptionPublicKey: device.encryptionPublicKey,
          kind: 'personal',
        })
      )
    );
    for (const operation of [
      [4, 0, device.publicKey.toBytes(), device.encryptionPublicKey.toBytes(), proof],
      [5, device.publicKey.toBytes()],
    ] as const) {
      const body = ok(encodeCbor([view.head.toBytes(), f.owner.publicKey.toBytes(), operation]));
      append(ok(encodeCbor([ok(decodeCbor(body)), f.owner.signBytes(recordSigningBytes(body))])));
    }
  };
  requestRotation();
  const groups = new Map<string, EpochStagedGroup>();
  let stageFailure = false,
    stageRewrite = false;
  const staging: EpochStagingPort = {
    stageGroup: (group) =>
      Effect.suspend(() => {
        if (stageFailure) return Effect.fail(new Error('stage-unavailable'));
        const owned = ok(ownEpochStagedGroup(group));
        groups.set(
          group.recordHash,
          stageRewrite ? { ...owned, envelopes: owned.envelopes.slice(1) } : owned
        );
        return Effect.void;
      }),
    readGroup: (key) => Effect.sync(() => groups.get(key.recordHash) ?? null),
    deleteGroup: (key) =>
      Effect.sync(() => {
        groups.delete(key.recordHash);
      }),
  };
  const lookup = () => Effect.sync(() => view);
  const remote = LedgerLog.of({
    read: () =>
      Effect.suspend(() =>
        readbackLost
          ? Effect.fail(new LedgerLogError())
          : Effect.sync(() => ({
              records: records.map((r) => new Uint8Array(r)),
              checkpoint: { head: view.head, length: view.length },
            }))
      ),
    appendCas: (_anchor, expected, record) =>
      Effect.suspend(() => {
        // Observe both actual durable originals at the transport boundary, not
        // only the eventual result after publication has already happened.
        expect(row()?.record).toEqual(Buffer.from(record));
        const journalDb = new Database(files.journal);
        try {
          const pending = journalDb.prepare('SELECT pending FROM submission_journal').get() as {
            pending: Buffer;
          };
          expect(pending.pending).toEqual(Buffer.from(record));
        } finally {
          journalDb.close();
        }
        const candidatePurpose = new TextEncoder().encode('lody-e2ee/local-epoch-candidate/v1\0');
        expect(
          native.plains.some(
            (plain) =>
              plain.length > candidatePurpose.length &&
              plain
                .subarray(0, candidatePurpose.length)
                .every((value, index) => value === candidatePurpose[index])
          )
        ).toBe(true);
        if (mode === 'unavailable') return Effect.fail(new LedgerLogError());
        if (!view.head.equals(expected.head) || view.length !== expected.length)
          return Effect.fail(new LedgerLogError());
        append(record);
        if (mode === 'lost-readback') readbackLost = true;
        return mode === 'lost-ack' ? Effect.fail(new LedgerLogError()) : Effect.void;
      }),
  });
  const signer = {
    publicKey: f.owner.publicKey,
    sign: (message: Uint8Array) =>
      Effect.sync(() => {
        if (new TextDecoder().decode(message.subarray(0, 17)) === 'lody-e2ee/sig/v1\0') signed++;
      }).pipe(Effect.andThen(f.owner.signer.sign(message))),
  };
  const open = Effect.fnUntraced(function* (
    openMode: 'create' | 'open' = 'create',
    options: {
      signer?: typeof signer;
      native?: typeof native.protector;
      lookup?: () => Effect.Effect<LedgerView, unknown>;
      remote?: typeof remote;
      staging?: EpochStagingPort;
    } = {}
  ) {
    const ledger = options.lookup ?? lookup;
    const installed = yield* makeSqliteProtectedEpochKeys({
      path: files.keys,
      mode: openMode,
      genesis: f.context.genesis,
      recipient: f.owner.publicKey,
      ledger,
      protector: native.protector,
    });
    if (openMode === 'create') yield* installed.saveAndReload(0, f.secret);
    const context = yield* Layer.build(sqliteSubmissionJournal({ path: files.journal })),
      journal = Context.get(context, SubmissionJournal);
    const rotation = yield* makeSqliteEpochRotation({
      path: files.candidate,
      mode: openMode,
      genesis: f.context.genesis,
      signer: options.signer ?? signer,
      ledger,
      installed,
      protector: options.native ?? native.protector,
      staging: options.staging ?? staging,
    }).pipe(
      Effect.provideService(SubmissionJournal, journal),
      Effect.provideService(LedgerLog, options.remote ?? remote)
    );
    return { rotation, installed, journal };
  });
  const row = () => {
    const db = new Database(files.candidate);
    try {
      return db
        .prepare('SELECT * FROM epoch_rotation_candidates ORDER BY rowid DESC LIMIT 1')
        .get() as
        | { record: Buffer; blob: Buffer; outcome: string | null; consumed: number; epoch: number }
        | undefined;
    } finally {
      db.close();
    }
  };
  return {
    ...f,
    files,
    native,
    lookup,
    remote,
    open,
    row,
    append,
    view: () => view,
    records: () => records.map((r) => new Uint8Array(r)),
    mode: (next: typeof mode) => {
      mode = next;
      readbackLost = false;
    },
    signed: () => signed,
    requestRotation,
    staging,
    groups,
    stageFailure: (value: boolean) => {
      stageFailure = value;
    },
    stageRewrite: (value: boolean) => {
      stageRewrite = value;
    },
  };
}
const failureCode = (exit: Exit.Exit<unknown, unknown>, code: string) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain(code);
};
describe('durable local epoch rotation', () => {
  it('checks real staging signatures and contexts without granting current-epoch permission', async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation } = yield* f.open();
          const result = yield* rotation.publish();
          const group = (yield* f.staging.readGroup(ok(getCommittedEpochStagingKey(f.view(), 1))))!;
          const check = (
            input: EpochStagedGroup,
            principal = f.owner.publicKey,
            genesis = f.context.genesis
          ) => checkEpochStageRequest({ genesis, principal, group: input });
          expect(Result.isSuccess(check(group))).toBe(true);
          expect(Result.isFailure(check(group, f.phone.publicKey))).toBe(true);
          expect(
            Result.isFailure(
              check(group, f.owner.publicKey, ok(Bytes.genesisHash(new Uint8Array(32).fill(99))))
            )
          ).toBe(true);
          const record = new Uint8Array(group.record);
          record[record.length - 1] = record[record.length - 1]! ^ 1;
          expect(
            Result.isFailure(
              check({
                ...group,
                record,
                recordHash: Buffer.from(hashRecordBytes(record).toBytes()).toString('hex'),
              })
            )
          ).toBe(true);
          expect(Result.isFailure(check({ ...group, recordHash: '00'.repeat(32) }))).toBe(true);
          const frame = new Uint8Array(group.envelopes[0]!.frame);
          frame[frame.length - 1] = frame[frame.length - 1]! ^ 1;
          expect(
            Result.isFailure(
              check({
                ...group,
                envelopes: [{ ...group.envelopes[0]!, frame }, ...group.envelopes.slice(1)],
              })
            )
          ).toBe(true);
          expect(
            Result.isFailure(
              check({
                ...group,
                envelopes: [
                  { ...group.envelopes[0]!, recipient: '00'.repeat(32) },
                  ...group.envelopes.slice(1),
                ],
              })
            )
          ).toBe(true);
          expect(
            Result.isFailure(
              check({ ...group, envelopes: [...group.envelopes, group.envelopes[0]!] })
            )
          ).toBe(true);
          // A genuine historical outer signature remains valid after the current
          // slot advances. The helper cannot replace device/epoch authorization.
          yield* rotation.acknowledge(result!);
          f.requestRotation();
          expect((yield* rotation.publish())?.epoch).toBe(2);
          expect(f.view().inspectState().epoch.number).toBe(2);
          expect(Result.isSuccess(check(group))).toBe(true);
        })
      )
    );
  });
  it('refuses remote CAS until a complete staged group has exact readback and retries only persisted originals', async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation, journal } = yield* f.open();
          f.stageFailure(true);
          expect(Exit.isFailure(yield* Effect.exit(rotation.publish()))).toBe(true);
          const original = f.row()!;
          expect(f.records()).toHaveLength(4);
          expect((yield* journal.load(f.context.genesis)).record).toBeNull();
          f.stageFailure(false);
          f.stageRewrite(true);
          failureCode(yield* Effect.exit(rotation.resume()), 'stage-readback');
          expect(f.row()!.record).toEqual(original.record);
          expect(f.row()!.blob).toEqual(original.blob);
          expect(f.records()).toHaveLength(4);
          expect((yield* journal.load(f.context.genesis)).record).toBeNull();
          f.stageRewrite(false);
          const result = yield* rotation.resume();
          expect(result).toMatchObject({ outcome: 'Committed', epoch: 1 });
          expect(f.signed()).toBe(1);
          const key = ok(getCommittedEpochStagingKey(f.view(), 1));
          const stored = yield* f.staging.readGroup(key);
          expect(stored?.envelopes.map((row) => row.recipient).sort()).toEqual(
            [...f.view().inspectState().devices.keys()].sort()
          );
          expect(stored?.record).toEqual(new Uint8Array(original.record));
        })
      )
    );
  });
  it('keeps uncommitted ciphertext inert and installs real HPKE after permanent publisher destruction, including Recovery', async () => {
    for (const kind of [0, 2] as const) {
      const f = fixture(kind),
        pair = await recipientPair();
      let group: EpochStagedGroup;
      f.mode('unavailable');
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { rotation, installed } = yield* f.open();
            failureCode(yield* Effect.exit(rotation.publish()), 'unconfirmed');
            group = [...f.groups.values()][0]!;
            const receiver = yield* makeSqliteEpochReceiver({
              path: path.join(path.dirname(f.files.keys), 'receive.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              signer: f.phone.signer,
              pair,
              keyStore: {
                path: path.join(path.dirname(f.files.keys), 'recipient.sqlite'),
                mode: 'create',
                protector: f.native.protector,
              },
              ledger: f.lookup,
              remote: {
                status: () => Effect.die('staged installation has no mailbox dependency'),
                report: () => Effect.die('staged installation has no report dependency'),
              },
            });
            failureCode(yield* Effect.exit(receiver.receiveStagedGroup(group)), 'uncommitted');
            failureCode(yield* Effect.exit(receiver.installedEpochKeys.read(1)), 'missing-key');
            f.mode('ok');
            expect(yield* rotation.resume()).toMatchObject({ outcome: 'Committed', epoch: 1 });
            if (kind === 0) {
              const key = yield* installed.read(1);
              const frame = yield* prepareEpochEnvelope({
                context: {
                  ...f.context,
                  epoch: ok(Bytes.epochNumber(1)),
                  sender: f.phone.publicKey,
                },
                key,
                signer: f.phone.signer,
                ledger: f.lookup,
              });
              disposeEpochKey(key);
              const substituted = {
                ...group,
                envelopes: group.envelopes.map((row) =>
                  row.recipient === Buffer.from(f.phone.raw).toString('hex')
                    ? { ...row, frame }
                    : row
                ),
              };
              failureCode(
                yield* Effect.exit(receiver.receiveStagedGroup(substituted)),
                'invalid-envelope'
              );
              failureCode(yield* Effect.exit(receiver.installedEpochKeys.read(1)), 'missing-key');
              // The original publisher then loses current sender eligibility.
              // Its genuinely committed publication still authorizes these originals.
              f.append(
                yield* signLedgerRecord(
                  ok(
                    prepareLedgerRecord(
                      f.view(),
                      ok(
                        encodeCbor([
                          f.view().head.toBytes(),
                          f.phone.publicKey.toBytes(),
                          [5, f.owner.publicKey.toBytes()],
                        ])
                      )
                    )
                  ),
                  f.phone.signer
                )
              );
              expect(
                f.view().inspectState().devices.has(Buffer.from(f.owner.raw).toString('hex'))
              ).toBe(false);
            }
          })
        )
      );
      // No surviving publisher candidate, installed key, journal, or signer is used.
      for (const file of [f.files.candidate, f.files.keys, f.files.journal]) rmSync(file);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const receiver = yield* makeSqliteEpochReceiver({
              path: path.join(path.dirname(f.files.keys), 'receive.sqlite'),
              mode: 'open',
              genesis: f.context.genesis,
              signer: f.phone.signer,
              pair,
              keyStore: {
                path: path.join(path.dirname(f.files.keys), 'recipient.sqlite'),
                mode: 'open',
                protector: f.native.protector,
              },
              ledger: f.lookup,
              remote: {
                status: () => Effect.die('unexpected mailbox'),
                report: () => Effect.die('unexpected report'),
              },
            });
            expect(yield* receiver.receiveStagedGroup(group!)).toMatchObject({
              outcome: 'Installed',
              epoch: 1,
            });
            const installed = yield* receiver.installedEpochKeys.read(1);
            expect(ok(commitEpochKey(f.context.genesis, 1, installed))).toEqual(
              f.view().inspectState().epoch.keyCommitment
            );
            disposeEpochKey(installed);
          })
        )
      );
    }
  });
  it('includes a genuine Guest personal device in the complete poststate group and opens its real HPKE frame', async () => {
    const f = fixture(),
      guest = memberDevice(47);
    const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const encryptionPublicKey = ok(
      Bytes.encryptionPublicKey(
        new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const membershipId = ok(Bytes.membershipId(new Uint8Array(16).fill(47)));
          const request = yield* prepareJoinRequest({
            genesis: f.context.genesis,
            requestId: ok(Bytes.requestId(new Uint8Array(16).fill(48))),
            userId: ok(Bytes.userId(new Uint8Array(32).fill(47))),
            encryptionPublicKey,
            expiresAt: null,
            signer: guest.signer,
          });
          f.append(
            yield* signLedgerRecord(
              ok(
                prepareLedgerCommand(f.view(), f.owner.publicKey, {
                  _tag: 'AdmitMember',
                  membershipId,
                  request,
                })
              ),
              f.owner.signer
            )
          );
          f.append(
            yield* signLedgerRecord(
              ok(
                prepareLedgerCommand(f.view(), f.owner.publicKey, {
                  _tag: 'SetRole',
                  membershipId,
                  role: 'guest',
                })
              ),
              f.owner.signer
            )
          );
          const { rotation } = yield* f.open();
          const result = yield* rotation.publish();
          expect(result.outcome).toBe('Committed');
          const group = yield* f.staging.readGroup(ok(getCommittedEpochStagingKey(f.view(), 1)));
          expect(group!.envelopes.map((row) => row.recipient)).toContain(
            Buffer.from(guest.publicKey.toBytes()).toString('hex')
          );
          expect(group!.envelopes).toHaveLength(3);
          const receiver = yield* makeSqliteEpochReceiver({
            path: path.join(path.dirname(f.files.keys), 'guest-receive.sqlite'),
            mode: 'create',
            genesis: f.context.genesis,
            signer: guest.signer,
            pair,
            keyStore: {
              path: path.join(path.dirname(f.files.keys), 'guest-keys.sqlite'),
              mode: 'create',
              protector: f.native.protector,
            },
            ledger: f.lookup,
            remote: {
              status: () => Effect.die('unexpected mailbox'),
              report: () => Effect.die('unexpected report'),
            },
          });
          expect(yield* receiver.receiveStagedGroup(group!)).toMatchObject({
            outcome: 'Installed',
          });
          const key = yield* receiver.installedEpochKeys.read(1);
          expect(ok(commitEpochKey(f.context.genesis, 1, key))).toEqual(
            f.view().inspectState().epoch.keyCommitment
          );
          disposeEpochKey(key);
        })
      )
    );
  });
  it('retains two real staged candidates, commits one, invalidates the loser, and cleans only its occupied epoch group', async () => {
    const winner = fixture(),
      loser = fixture();
    winner.mode('unavailable');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* winner.open();
          let loserCasAttempts = 0;
          const loserRemote = LedgerLog.of({
            read: winner.remote.read,
            appendCas: () =>
              Effect.sync(() => {
                loserCasAttempts++;
              }).pipe(Effect.andThen(Effect.fail(new LedgerLogError()))),
          });
          const other = yield* loser.open('create', {
            lookup: winner.lookup,
            remote: loserRemote,
            staging: winner.staging,
          });
          failureCode(yield* Effect.exit(first.rotation.publish()), 'unconfirmed');
          failureCode(yield* Effect.exit(other.rotation.publish()), 'unconfirmed');
          expect(winner.groups.size).toBe(2);
          expect(Exit.isFailure(yield* Effect.exit(other.rotation.cleanupStaged()))).toBe(true);
          expect(winner.groups.size).toBe(2);
          winner.mode('ok');
          const committed = yield* first.rotation.resume();
          expect(committed?.outcome).toBe('Committed');
          const lost = yield* other.rotation.resume();
          expect(lost).toMatchObject({ outcome: 'Conflict', binding: null });
          expect(loser.row()!.blob).toHaveLength(0);
          failureCode(yield* Effect.exit(other.installed.read(1)), 'missing-key');
          expect(Exit.isFailure(yield* Effect.exit(first.rotation.cleanupStaged()))).toBe(true);
          expect(yield* other.rotation.cleanupStaged()).toBe(true);
          expect(winner.groups.size).toBe(1);
          expect([...winner.groups.values()][0]!.record).toEqual(committed!.record);
          expect(loser.signed()).toBe(1);
          expect(loserCasAttempts).toBe(1);
        })
      )
    );
  });
  it('removes one member and all its device kinds through the same durable candidate and real P09 after process reopen', async () => {
    const f = fixture(),
      target = ok(Bytes.membershipId(new Uint8Array(16).fill(90))),
      devices = [memberDevice(41), memberDevice(42), memberDevice(43)],
      originalHistory = f.records();
    let initial: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const request = yield* prepareJoinRequest({
            genesis: f.context.genesis,
            requestId: ok(Bytes.requestId(new Uint8Array(16).fill(91))),
            userId: ok(Bytes.userId(new Uint8Array(32).fill(90))),
            encryptionPublicKey: devices[0]!.encryptionPublicKey,
            expiresAt: null,
            signer: devices[0]!.signer,
          });
          f.append(
            yield* signLedgerRecord(
              ok(
                prepareLedgerCommand(f.view(), f.owner.publicKey, {
                  _tag: 'AdmitMember',
                  membershipId: target,
                  request,
                })
              ),
              f.owner.signer
            )
          );
          for (const [index, kind] of ['machine', 'recovery'].entries()) {
            const device = devices[index + 1]!,
              command = yield* prepareDeviceAdmission({
                genesis: f.context.genesis,
                membershipId: target,
                encryptionPublicKey: device.encryptionPublicKey,
                kind: kind as 'machine' | 'recovery',
                ...(kind === 'machine' ? { machineId: 'removed-member-machine' } : {}),
                signer: device.signer,
              });
            f.append(
              yield* signLedgerRecord(
                ok(prepareLedgerCommand(f.view(), devices[0]!.publicKey, command)),
                devices[0]!.signer
              )
            );
          }
          const { rotation } = yield* f.open();
          failureCode(
            yield* Effect.exit(rotation.publishRemoving(f.view().inspectState().owner)),
            'unauthorized'
          );
          failureCode(
            yield* Effect.exit(
              rotation.publishRemoving(ok(Bytes.membershipId(new Uint8Array(16).fill(99))))
            ),
            'unauthorized'
          );
          expect(f.signed()).toBe(0);
          f.mode('unavailable');
          failureCode(yield* Effect.exit(rotation.publishRemoving(target)), 'unconfirmed');
          const original = f.row()!,
            parsed = ok(decodeRecord(original.record));
          expect(parsed.body.type === 'ordinary' && parsed.body.operation).toMatchObject({
            type: 'removeMemberAndPublishEpoch',
            epoch: 1,
          });
          expect(
            f.view().inspectState().members.has(Buffer.from(target.toBytes()).toString('hex'))
          ).toBe(true);
          expect(f.view().inspectState().epoch.number).toBe(0);
          expect(f.signed()).toBe(1);
          failureCode(yield* Effect.exit(rotation.publish()), 'busy');
          failureCode(
            yield* Effect.exit(
              rotation.publishRemoving(ok(Bytes.membershipId(new Uint8Array(16).fill(99))))
            ),
            'busy'
          );
          expect(f.signed()).toBe(1);
          initial = f.records().map((record) => Buffer.from(record).toString('hex'));
          f.mode('lost-readback');
          failureCode(yield* Effect.exit(rotation.publishRemoving(target)), 'LedgerLogError');
          expect(f.row()!.record).toEqual(original.record);
          expect(f.row()!.outcome).toBeNull();
          expect(f.view().inspectState().epoch.number).toBe(1);
          expect(
            f.view().inspectState().members.has(Buffer.from(target.toBytes()).toString('hex'))
          ).toBe(false);
          expect(f.signed()).toBe(1);
        })
      )
    );
    const original = f.row()!,
      config = path.join(path.dirname(f.files.candidate), 'remove-child.json');
    expect(initial).toHaveLength(originalHistory.length + 3);
    writeFileSync(
      config,
      JSON.stringify({
        genesis: Buffer.from(f.context.genesis.toBytes()).toString('hex'),
        publisher: Buffer.from(f.owner.publicKey.toBytes()).toString('hex'),
        files: f.files,
        initial,
        candidate: original.record.toString('hex'),
      }),
      { mode: 0o600 }
    );
    const child = await runNativeChild(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./rotation-reopen.mts', import.meta.url)), config],
      { cwd: fileURLToPath(new URL('../..', import.meta.url)) }
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({
      outcome: 'Committed',
      epoch: 1,
      signed: 0,
      consumed: 1,
      removedMembershipId: Buffer.from(target.toBytes()).toString('hex'),
    });
    const retained = f.row()!;
    expect(retained.record).toEqual(original.record);
    expect(retained.blob).toEqual(original.blob);
    expect(retained.consumed).toBe(1);
    const records = (JSON.parse(readFileSync(f.files.history, 'utf8')) as string[]).map(
        (hex) => new Uint8Array(Buffer.from(hex, 'hex'))
      ),
      view = ok(
        verifyLedger({
          anchor: f.context.genesis,
          records,
          checkpoint: {
            head: hashRecordBytes(records[records.length - 1]!),
            length: records.length,
          },
        })
      );
    expect(records).toHaveLength(initial.length + 1);
    expect(view.inspectState().members.has(Buffer.from(target.toBytes()).toString('hex'))).toBe(
      false
    );
    for (const device of devices)
      expect(
        view.inspectState().devices.has(Buffer.from(device.publicKey.toBytes()).toString('hex'))
      ).toBe(false);
    expect(
      view.inspectState().devices.has(Buffer.from(f.owner.publicKey.toBytes()).toString('hex'))
    ).toBe(true);
    expect(
      view.inspectState().devices.has(Buffer.from(f.phone.publicKey.toBytes()).toString('hex'))
    ).toBe(true);
    expect(view.inspectState().epoch).toMatchObject({ number: 1, rotationRequired: false });
    const pair = await recipientPair();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = () => Effect.succeed(view),
            file = (name: string) => path.join(path.dirname(f.files.candidate), `${name}.sqlite`),
            hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
          const host = yield* makeSqliteKeyMailbox({
              path: file('mailbox'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger,
            }),
            ownerRemote = ok(host.bind(f.owner.publicKey)),
            phoneRemote = ok(host.bind(f.phone.publicKey));
          const distributor = yield* makeSqliteKeyDistribution({
            path: file('publisher-receive'),
            mode: 'create',
            genesis: f.context.genesis,
            signer: f.owner.signer,
            pair,
            ledger,
            remote: ownerRemote,
            keyStore: { path: f.files.keys, mode: 'open', protector: f.native.protector },
            repairStore: { path: file('publisher-repair'), mode: 'create' },
            sendStore: { path: file('distribution'), mode: 'create' },
            outboxStore: { path: file('outbox'), mode: 'create' },
            currentPublication: () => Effect.succeed(new Uint8Array(original.record)),
          });
          expect(yield* distributor.reconcileCurrentEpoch()).toEqual({
            scheduled: 1,
            blocked: [],
            next: null,
          });
          expect(yield* distributor.resumePendingDeliveries()).toMatchObject({
            processed: 1,
            blocked: [],
          });
          yield* distributor.flushReports();
          expect(
            (yield* ownerRemote.status({
              genesis: hex(f.context.genesis.toBytes()),
              epoch: 1,
              recipient: hex(f.owner.publicKey.toBytes()),
            })).status
          ).toBe('InstallationReported');
          const receiver = yield* makeSqliteRecipientMailbox({
            path: file('phone-receive'),
            mode: 'create',
            genesis: f.context.genesis,
            signer: f.phone.signer,
            pair,
            ledger,
            remote: phoneRemote,
            keyStore: { path: file('phone-keys'), mode: 'create', protector: f.native.protector },
            repairStore: { path: file('phone-repair'), mode: 'create' },
          });
          expect(yield* receiver.fetchAndInstall()).toEqual({ processed: 1, next: null });
          yield* receiver.flushReports();
          expect(
            (yield* phoneRemote.status({
              genesis: hex(f.context.genesis.toBytes()),
              epoch: 1,
              recipient: hex(f.phone.publicKey.toBytes()),
            })).status
          ).toBe('InstallationReported');
          const key = yield* receiver.installedEpochKeys.read(1);
          try {
            expect(ok(commitEpochKey(f.context.genesis, 1, key))).toEqual(
              view.inspectState().epoch.keyCommitment
            );
            const history = ok(recoverLedgerHistory(view, key));
            try {
              expect(ok(commitEpochKey(f.context.genesis, 0, history.get(0)!))).toEqual(
                ok(commitEpochKey(f.context.genesis, 0, f.secret))
              );
            } finally {
              for (const old of history.values()) disposeEpochKey(old);
            }
          } finally {
            disposeEpochKey(key);
          }
          const db = new Database(file('mailbox'));
          try {
            expect(
              db.prepare('SELECT DISTINCT recipient FROM mailbox_envelopes WHERE epoch=1').all()
            ).toEqual([{ recipient: hex(f.phone.publicKey.toBytes()) }]);
          } finally {
            db.close();
          }
        })
      )
    );
  });
  it('persists and actually opens one candidate before CAS; lost ACK keeps original and explicit ACK releases the next epoch', async () => {
    const f = fixture();
    f.mode('lost-ack');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation, installed, journal } = yield* f.open();
          const result = yield* rotation.publish();
          expect(result).toMatchObject({ outcome: 'Committed', epoch: 1, binding: 'current' });
          const first = f.row()!;
          expect(first.record).toEqual(Buffer.from(result.record));
          expect(first.outcome).toBe('Committed');
          expect(first.consumed).toBe(0);
          expect(f.signed()).toBe(1);
          const key = yield* installed.read(1);
          expect(ok(commitEpochKey(f.context.genesis, 1, key))).toEqual(
            f.view().inspectState().epoch.keyCommitment
          );
          disposeEpochKey(key);
          expect((yield* journal.load(f.context.genesis)).record).toEqual(result.record);
          const again = yield* rotation.publish();
          expect(again?.record).toEqual(result.record);
          expect(f.signed()).toBe(1);
          yield* rotation.acknowledge(result!);
          expect(f.row()!.consumed).toBe(1);
          expect((yield* journal.load(f.context.genesis)).record).toBeNull();
          f.mode('ok');
          failureCode(yield* Effect.exit(rotation.publish()), 'rotation-not-required');
          f.requestRotation();
          const next = yield* rotation.publish();
          expect(next).toMatchObject({ outcome: 'Committed', epoch: 2 });
          expect(f.signed()).toBe(2);
          expect(f.native.plains.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
          const db = new Database(f.files.candidate);
          try {
            expect(db.prepare('SELECT count(*) AS n FROM epoch_rotation_candidates').get()).toEqual(
              { n: 2 }
            );
          } finally {
            db.close();
          }
        })
      )
    );
  });
  it('failed transport and process reopen use original bytes without a usable signer, then retain originals after ACK', async () => {
    const f = fixture();
    f.mode('unavailable');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation } = yield* f.open();
          failureCode(yield* Effect.exit(rotation.publish()), 'unconfirmed');
        })
      )
    );
    const before = f.row()!;
    expect(before.outcome).toBeNull();
    expect(f.signed()).toBe(1);
    expect(f.records()).toHaveLength(4);
    const config = path.join(path.dirname(f.files.candidate), 'child.json');
    writeFileSync(
      config,
      JSON.stringify({
        genesis: Buffer.from(f.context.genesis.toBytes()).toString('hex'),
        publisher: Buffer.from(f.owner.publicKey.toBytes()).toString('hex'),
        files: f.files,
        initial: f.records().map((r) => Buffer.from(r).toString('hex')),
        candidate: before.record.toString('hex'),
      }),
      { mode: 0o600 }
    );
    const child = await runNativeChild(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./rotation-reopen.mts', import.meta.url)), config],
      { cwd: fileURLToPath(new URL('../..', import.meta.url)) }
    );
    expect(child.status, child.stderr).toBe(0);
    const output = JSON.parse(child.stdout.trim());
    expect(output).toMatchObject({ outcome: 'Committed', epoch: 1, signed: 0, consumed: 1 });
    expect(output.record).toBe(before.record.toString('hex'));
    const after = f.row()!;
    expect(after.record).toEqual(before.record);
    expect(after.blob).toEqual(before.blob);
    expect(after.consumed).toBe(1);
    expect(JSON.parse(readFileSync(f.files.history, 'utf8'))).toHaveLength(5);
  });
  it('candidate SQL IGNORE and rewrite roll back before submitting; original installation failure resumes safely', async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation } = yield* f.open();
          const db = new Database(f.files.candidate);
          try {
            db.exec(
              'CREATE TRIGGER ignore_candidate BEFORE INSERT ON epoch_rotation_candidates BEGIN SELECT RAISE(IGNORE);END'
            );
            failureCode(yield* Effect.exit(rotation.publish()), 'corrupt');
            expect(f.row()).toBeUndefined();
            expect(f.records()).toHaveLength(4);
            db.exec(
              'DROP TRIGGER ignore_candidate;CREATE TRIGGER rewrite_candidate AFTER INSERT ON epoch_rotation_candidates BEGIN UPDATE epoch_rotation_candidates SET epoch=99 WHERE id=NEW.id;END'
            );
            failureCode(yield* Effect.exit(rotation.publish()), 'corrupt');
            expect(f.row()).toBeUndefined();
            expect(f.records()).toHaveLength(4);
            db.exec('DROP TRIGGER rewrite_candidate');
            const keydb = new Database(f.files.keys);
            try {
              keydb.exec(
                'CREATE TRIGGER ignore_install BEFORE INSERT ON installed_epoch_keys WHEN NEW.epoch=1 BEGIN SELECT RAISE(IGNORE);END'
              );
              failureCode(yield* Effect.exit(rotation.publish()), 'missing-key');
              const original = f.row()!;
              expect(original.outcome).toBeNull();
              expect(f.records()).toHaveLength(5);
              const signed = f.signed();
              keydb.exec('DROP TRIGGER ignore_install');
              const done = yield* rotation.resume();
              expect(done?.record).toEqual(new Uint8Array(original.record));
              expect(f.signed()).toBe(signed);
            } finally {
              keydb.close();
            }
          } finally {
            db.close();
          }
        })
      )
    );
  });
  it('Conflict never installs the losing secret and permits a new candidate only after explicit ACK', async () => {
    const f = fixture();
    f.mode('unavailable');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation, installed } = yield* f.open();
          yield* Effect.exit(rotation.publish());
          const original = f.row()!;
          const view = f.view(),
            body = ok(
              encodeCbor([view.head.toBytes(), f.owner.publicKey.toBytes(), [5, f.phone.raw]])
            );
          const competitor = yield* signLedgerRecord(
            ok(prepareLedgerRecord(view, body)),
            f.owner.signer
          );
          f.append(competitor);
          const conflict = yield* rotation.resume();
          expect(conflict).toMatchObject({ outcome: 'Conflict', epoch: 1, binding: null });
          expect(conflict?.record).toEqual(new Uint8Array(original.record));
          failureCode(yield* Effect.exit(installed.read(1)), 'missing-key');
          expect(f.signed()).toBe(1);
          yield* rotation.acknowledge(conflict!);
          f.mode('ok');
          expect(yield* rotation.publish()).toMatchObject({ outcome: 'Committed', epoch: 1 });
          expect(f.signed()).toBe(2);
        })
      )
    );
  });
  it('a confirmed candidate may install historically and later epoch advancement does not invalidate its original ACK', async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation, installed } = yield* f.open();
          const first = yield* rotation.publish();
          const key1 = yield* installed.read(1),
            raw = new Uint8Array(32).fill(72),
            key2 = ok(Bytes.epochKey(raw));
          raw.fill(0);
          try {
            const commitment = ok(commitEpochKey(f.context.genesis, 2, key2)),
              packet = ok(
                sealHistoryPacket({
                  genesis: f.context.genesis,
                  epoch: 2,
                  currentKey: key2,
                  previousKey: key1,
                })
              ),
              view = f.view();
            const body = ok(
              encodeCbor([
                view.head.toBytes(),
                f.owner.publicKey.toBytes(),
                [7, 2, commitment.toBytes(), packet],
              ])
            );
            f.append(yield* signLedgerRecord(ok(prepareLedgerRecord(view, body)), f.owner.signer));
            const resumed = yield* rotation.resume();
            expect(resumed?.record).toEqual(first!.record);
            expect(f.view().inspectState().epoch.number).toBe(2);
            yield* rotation.acknowledge(first!);
            expect(f.row()!.consumed).toBe(1);
          } finally {
            disposeEpochKey(key1);
            disposeEpochKey(key2);
          }
        })
      )
    );
  });
  it('ACK failure preserves original candidate after P09 consumption and is safely repeatable', async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation, journal } = yield* f.open();
          const done = yield* rotation.publish(),
            original = f.row()!;
          const db = new Database(f.files.candidate);
          try {
            db.exec(
              'CREATE TRIGGER ignore_ack BEFORE UPDATE OF consumed ON epoch_rotation_candidates BEGIN SELECT RAISE(IGNORE);END'
            );
            failureCode(yield* Effect.exit(rotation.acknowledge(done!)), 'corrupt');
            expect((yield* journal.load(f.context.genesis)).record).toBeNull();
            expect(f.row()!.consumed).toBe(0);
            expect(f.row()!.blob).toEqual(original.blob);
            db.exec('DROP TRIGGER ignore_ack');
            yield* rotation.acknowledge(done!);
            yield* rotation.acknowledge(done!);
            expect(f.row()!.consumed).toBe(1);
            expect(f.signed()).toBe(1);
          } finally {
            db.close();
          }
        })
      )
    );
  });
  it('two handles elect one immutable candidate; the losing first attempt never submits and retries only the winner', async () => {
    const f = fixture();
    f.mode('unavailable');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const delayed = {
            ...f.native.protector,
            protect: async (body: Uint8Array) => {
              Deferred.doneUnsafe(entered, Effect.void);
              await Effect.runPromise(Deferred.await(release));
              return f.native.protector.protect(body);
            },
          };
          const first = yield* f.open('create', { native: delayed }),
            other = yield* f.open('open');
          const publishing = yield* Effect.exit(first.rotation.publish()).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          failureCode(yield* Effect.exit(other.rotation.publish()), 'unconfirmed');
          const winner = f.row()!;
          expect(f.signed()).toBe(2);
          yield* Deferred.succeed(release, undefined);
          failureCode(yield* Fiber.join(publishing), 'busy');
          expect(f.row()!.record).toEqual(winner.record);
          expect(f.row()!.blob).toEqual(winner.blob);
          expect(f.records()).toHaveLength(4);
          f.mode('ok');
          expect(yield* first.rotation.publish()).toMatchObject({ outcome: 'Committed', epoch: 1 });
          expect(f.row()!.record).toEqual(winner.record);
          expect(f.signed()).toBe(2);
          expect(f.records()).toHaveLength(5);
        })
      )
    );
  });
  it('first local confirmation may be historical without rolling back the genuine current epoch', async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation } = yield* f.open(),
            db = new Database(f.files.keys);
          try {
            db.exec(
              'CREATE TRIGGER hold_install BEFORE INSERT ON installed_epoch_keys WHEN NEW.epoch=1 BEGIN SELECT RAISE(IGNORE);END'
            );
            failureCode(yield* Effect.exit(rotation.publish()), 'missing-key');
            const original = f.row()!;
            const plain = yield* Effect.promise(() =>
                f.native.protector.unprotect(new Uint8Array(original.blob))
              ),
              key1 = ok(Bytes.epochKey(plain.subarray(-32)));
            plain.fill(0);
            const raw = new Uint8Array(32).fill(61),
              key2 = ok(Bytes.epochKey(raw));
            raw.fill(0);
            try {
              const commitment = ok(commitEpochKey(f.context.genesis, 2, key2)),
                packet = ok(
                  sealHistoryPacket({
                    genesis: f.context.genesis,
                    epoch: 2,
                    currentKey: key2,
                    previousKey: key1,
                  })
                ),
                view = f.view(),
                body = ok(
                  encodeCbor([
                    view.head.toBytes(),
                    f.owner.publicKey.toBytes(),
                    [7, 2, commitment.toBytes(), packet],
                  ])
                );
              f.append(
                yield* signLedgerRecord(ok(prepareLedgerRecord(view, body)), f.owner.signer)
              );
              db.exec('DROP TRIGGER hold_install');
              const result = yield* rotation.resume();
              expect(result).toMatchObject({
                outcome: 'Committed',
                epoch: 1,
                binding: 'historical',
              });
              expect(f.view().inspectState().epoch.number).toBe(2);
              expect(result?.record).toEqual(new Uint8Array(original.record));
              yield* rotation.acknowledge(result!);
            } finally {
              disposeEpochKey(key1);
              disposeEpochKey(key2);
            }
          } finally {
            db.close();
          }
        })
      )
    );
  });
  it('terminal and ACK field rewrites roll back, preserving the exact candidate and safe retries', async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation } = yield* f.open(),
            db = new Database(f.files.candidate);
          try {
            db.exec(
              'CREATE TRIGGER change_terminal AFTER UPDATE OF outcome ON epoch_rotation_candidates BEGIN UPDATE epoch_rotation_candidates SET consumed=1 WHERE id=NEW.id;END'
            );
            failureCode(yield* Effect.exit(rotation.publish()), 'corrupt');
            const original = f.row()!;
            expect(original.outcome).toBeNull();
            expect(original.consumed).toBe(0);
            expect(f.records()).toHaveLength(5);
            db.exec('DROP TRIGGER change_terminal');
            const result = yield* rotation.resume();
            expect(result?.record).toEqual(new Uint8Array(original.record));
            db.exec(
              'CREATE TRIGGER change_ack AFTER UPDATE OF consumed ON epoch_rotation_candidates BEGIN UPDATE epoch_rotation_candidates SET parent_count=99 WHERE id=NEW.id;END'
            );
            failureCode(yield* Effect.exit(rotation.acknowledge(result!)), 'corrupt');
            expect(f.row()!.consumed).toBe(0);
            expect(f.row()!.record).toEqual(original.record);
            expect(f.row()!.blob).toEqual(original.blob);
            db.exec('DROP TRIGGER change_ack');
            yield* rotation.acknowledge(result!);
            expect(f.row()!.consumed).toBe(1);
            expect(f.signed()).toBe(1);
          } finally {
            db.close();
          }
        })
      )
    );
  });
  it('candidate native readback failure never reaches CAS and retains the first protected original for explicit retry', async () => {
    const f = fixture();
    let refuse = true;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const native = {
            ...f.native.protector,
            unprotect: async (blob: Uint8Array) => {
              if (refuse) throw Error('host temporarily unavailable');
              return f.native.protector.unprotect(blob);
            },
          };
          const { rotation, journal } = yield* f.open('create', { native });
          failureCode(yield* Effect.exit(rotation.publish()), 'native-failed');
          const original = f.row()!;
          expect(original.outcome).toBeNull();
          expect((yield* journal.load(f.context.genesis)).record).toBeNull();
          expect(f.records()).toHaveLength(4);
          refuse = false;
          expect(yield* rotation.publish()).toMatchObject({ outcome: 'Committed', epoch: 1 });
          expect(f.row()!.blob).toEqual(original.blob);
          expect(f.row()!.record).toEqual(original.record);
          expect(f.signed()).toBe(1);
          expect(f.native.plains.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
        })
      )
    );
  });
  it('final outcome and ACK transactions reject ignored writes and metadata rewrites after the candidate update', async () => {
    for (const fault of ['ignore', 'metadata'] as const) {
      const f = fixture();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { rotation, journal } = yield* f.open(),
              db = new Database(f.files.candidate);
            try {
              db.exec(
                fault === 'ignore'
                  ? 'CREATE TRIGGER terminal_fault BEFORE UPDATE OF outcome ON epoch_rotation_candidates BEGIN SELECT RAISE(IGNORE);END'
                  : `CREATE TRIGGER terminal_fault AFTER UPDATE OF outcome ON epoch_rotation_candidates BEGIN UPDATE epoch_rotation_meta SET genesis='${'00'.repeat(32)}' WHERE id=1;END`
              );
              failureCode(yield* Effect.exit(rotation.publish()), 'corrupt');
              const original = f.row()!;
              expect(original.outcome).toBeNull();
              expect(original.consumed).toBe(0);
              expect(db.prepare('SELECT genesis FROM epoch_rotation_meta').get()).toEqual({
                genesis: Buffer.from(f.context.genesis.toBytes()).toString('hex'),
              });
              expect(f.records()).toHaveLength(5);
              db.exec('DROP TRIGGER terminal_fault');
              const done = yield* rotation.resume();
              expect(done?.record).toEqual(new Uint8Array(original.record));
              db.exec(
                fault === 'ignore'
                  ? 'CREATE TRIGGER ack_fault BEFORE UPDATE OF consumed ON epoch_rotation_candidates BEGIN SELECT RAISE(IGNORE);END'
                  : `CREATE TRIGGER ack_fault AFTER UPDATE OF consumed ON epoch_rotation_candidates BEGIN UPDATE epoch_rotation_meta SET publisher='${'00'.repeat(32)}' WHERE id=1;END`
              );
              failureCode(yield* Effect.exit(rotation.acknowledge(done!)), 'corrupt');
              expect((yield* journal.load(f.context.genesis)).record).toBeNull();
              expect(f.row()!.consumed).toBe(0);
              expect(f.row()!.blob).toEqual(original.blob);
              expect(db.prepare('SELECT publisher FROM epoch_rotation_meta').get()).toEqual({
                publisher: Buffer.from(f.owner.publicKey.toBytes()).toString('hex'),
              });
              db.exec('DROP TRIGGER ack_fault');
              yield* rotation.acknowledge(done!);
              expect(f.row()!.consumed).toBe(1);
              expect(f.signed()).toBe(1);
            } finally {
              db.close();
            }
          })
        )
      );
    }
  });
  it('rejects Recovery/machine and known rollback before random/signing or submission', async () => {
    for (const kind of [1, 2] as const) {
      const f = fixture(kind);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { journal } = yield* f.open();
            const installed = yield* makeSqliteProtectedEpochKeys({
              path: path.join(path.dirname(f.files.keys), 'other.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              recipient: f.phone.publicKey,
              ledger: f.lookup,
              protector: f.native.protector,
            });
            yield* installed.saveAndReload(0, f.secret);
            const rotation = yield* makeSqliteEpochRotation({
              path: path.join(path.dirname(f.files.candidate), 'other-candidate.sqlite'),
              mode: 'create',
              genesis: f.context.genesis,
              signer: f.phone.signer,
              ledger: f.lookup,
              installed,
              protector: f.native.protector,
              staging: f.staging,
            }).pipe(
              Effect.provideService(SubmissionJournal, journal),
              Effect.provideService(LedgerLog, f.remote)
            );
            failureCode(yield* Effect.exit(rotation.publish()), 'unauthorized');
            expect(f.records()).toHaveLength(4);
          })
        )
      );
    }
    const f = fixture();
    let selected = f.view();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { rotation } = yield* f.open('create', {
            lookup: () => Effect.sync(() => selected),
          });
          f.mode('unavailable');
          yield* Effect.exit(rotation.publish());
          const before = selected,
            body = ok(
              encodeCbor([before.head.toBytes(), f.owner.publicKey.toBytes(), [5, f.phone.raw]])
            );
          f.append(yield* signLedgerRecord(ok(prepareLedgerRecord(before, body)), f.owner.signer));
          selected = f.view();
          const db = new Database(path.join(path.dirname(f.files.candidate), 'ledger-pin.sqlite'));
          try {
            db.exec(
              'CREATE TRIGGER ignore_pin BEFORE UPDATE ON ledger_pin BEGIN SELECT RAISE(IGNORE);END'
            );
            failureCode(yield* Effect.exit(rotation.resume()), 'corrupt');
            expect(db.prepare('SELECT count FROM ledger_pin').get()).toEqual({ count: 4 });
            selected = before;
            failureCode(yield* Effect.exit(rotation.resume()), 'rollback');
            db.exec('DROP TRIGGER ignore_pin');
            selected = f.view();
            expect(yield* rotation.resume()).toMatchObject({ outcome: 'Conflict' });
            expect(f.signed()).toBe(1);
          } finally {
            db.close();
          }
        })
      )
    );
  });
  it('Scope close waits for real native protection settlement, wipes plaintext and rejects late persistence', async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>(),
            closed = yield* Deferred.make<void>();
          let nativeBody: Uint8Array | undefined;
          const child = yield* Scope.make();
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(release, undefined).pipe(Effect.andThen(Scope.close(child, Exit.void)))
          );
          const native = {
            ...f.native.protector,
            protect: async (body: Uint8Array) => {
              nativeBody = body;
              Deferred.doneUnsafe(entered, Effect.void);
              await Effect.runPromise(Deferred.await(release));
              return f.native.protector.protect(body);
            },
          };
          const { rotation } = yield* f
            .open('create', { native })
            .pipe(Effect.provideService(Scope.Scope, child));
          const publishing = yield* rotation.publish().pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const closing = yield* Scope.close(child, Exit.void).pipe(
            Effect.andThen(Deferred.succeed(closed, undefined)),
            Effect.forkChild({ startImmediately: true })
          );
          // Register after both child fibers: even a failed pre-release assertion
          // releases the native gate before their owning finalizers await them.
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          // Effect's immediate start runs admission close through its first awaited
          // native lease. No sleep or guessed number of microtask drains is used.
          expect(yield* Deferred.isDone(closed)).toBe(false);
          failureCode(yield* Effect.exit(rotation.publish()), 'closed');
          const interrupted = yield* Fiber.interrupt(publishing).pipe(
            Effect.forkChild({ startImmediately: true })
          );
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.await(interrupted);
          yield* Fiber.await(closing);
          yield* Deferred.await(closed);
          expect(nativeBody?.every((x) => x === 0)).toBe(true);
          expect(f.row()).toBeUndefined();
          expect(f.records()).toHaveLength(4);
          failureCode(yield* Effect.exit(rotation.publish()), 'closed');
        })
      )
    );
  });
});
