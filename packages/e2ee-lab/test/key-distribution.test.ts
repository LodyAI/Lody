import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runOwnedChild } from './native-child';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { encodeCbor } from '@lody/e2ee-core/protocol';
import { commitEpochKey, sealHistoryPacket } from '@lody/e2ee-core/protocol';
import { type LedgerView } from '@lody/e2ee-core';
import { contentPermissions, hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import {
  signGenesisRecord,
  prepareDeviceAdmission,
  prepareJoinRequest,
  prepareLedgerCommand,
} from '@lody/e2ee-core/protocol';
import { prepareLedgerRecord, signLedgerRecord } from '@lody/e2ee-core/protocol';
import { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { makeSqliteKeyDistribution } from '@lody/e2ee-core/internal';
import { runLabKeyRound, LabKeyRoundError } from '../src/platform/key-round';
import { makeLabMailboxRemote } from '../src/platform/key-mailbox';
import { makeLabJoinMailbox, labJoinWire } from '../src/platform/join-mailbox';
import { makeAuthenticatedLabMailbox } from './authenticated-mailbox-fixture';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
const ok = Result.getOrThrow;
const signer = (seed: number) => {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, seed),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    publicKey: ok(
      Bytes.signingPublicKey(
        new Uint8Array(
          createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
        )
      )
    ),
    sign: (message: Uint8Array) =>
      Effect.sync(() => ok(Bytes.signature(new Uint8Array(sign(null, message, privateKey))))),
  };
};
describe('Lab finite key rounds using public HPKE/SQLite/HTTP owners', () => {
  it('delivers original epoch0/1 envelopes over HTTP, reopens installation/report and restores history from only the latest key; Recovery cannot send', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-key-round-'));
    // Test-only native device creation. No production key store, replay entropy override or real account.
    const pair = (await crypto.subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair;
    const ownerPair = (await crypto.subtle.generateKey('X25519', true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const ownerEncryptionPublicKey = ok(
      Bytes.encryptionPublicKey(
        new Uint8Array(await crypto.subtle.exportKey('raw', ownerPair.publicKey))
      )
    );
    const encryptionPublicKey = ok(
      Bytes.encryptionPublicKey(
        new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
      )
    );
    const owner = signer(101),
      recovery = signer(102),
      membershipId = ok(Bytes.membershipId(new Uint8Array(16).fill(103)));
    const key = ok(Bytes.epochKey(new Uint8Array(32).fill(104)));
    const file = (name: string) => join(dir, `${name}.sqlite`);
    let expectedFrame: Uint8Array | undefined;
    try {
      const genesis = await Effect.runPromise(
        signGenesisRecord({
          userId: ok(Bytes.userId(new Uint8Array(32).fill(105))),
          membershipId,
          encryptionPublicKey: ownerEncryptionPublicKey,
          initialKey: key,
          signer: owner,
        })
      );
      const records: Uint8Array[] = [genesis.record];
      // This fixture only appends signed records; captured records are never mutated.
      // Reverify every append (including epoch/revocation), not every unchanged HTTP lookup.
      let cachedView: LedgerView | undefined,
        cachedCount = 0;
      const view = () => {
        if (!cachedView || cachedCount !== records.length) {
          cachedView = ok(
            verifyLedger({
              anchor: genesis.genesis,
              records,
              checkpoint: { head: hashRecordBytes(records.at(-1)!), length: records.length },
            })
          );
          cachedCount = records.length;
        }
        return cachedView;
      };
      const command = await Effect.runPromise(
        prepareDeviceAdmission({
          genesis: genesis.genesis,
          membershipId,
          encryptionPublicKey,
          kind: 'recovery',
          signer: recovery,
        })
      );
      records.push(
        await Effect.runPromise(
          signLedgerRecord(ok(prepareLedgerCommand(view(), owner.publicKey, command)), owner)
        )
      );
      // Explicit synthetic device export for this OS-child fixture only, file0600.
      // No real key/custody path or recorded user data is read or committed.
      writeFileSync(
        join(dir, 'recovery-device.json'),
        JSON.stringify({
          genesis: Buffer.from(genesis.genesis.toBytes()).toString('hex'),
          records: records.map((record) => Buffer.from(record).toString('hex')),
          checkpoint: {
            head: Buffer.from(hashRecordBytes(records.at(-1)!).toBytes()).toString('hex'),
            length: records.length,
          },
          privateKey: Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
            'hex'
          ),
          publicKey: Buffer.from(encryptionPublicKey.toBytes()).toString('hex'),
        }),
        { mode: 0o600 }
      );
      const ledger = () => Effect.sync(view);
      const slot = {
        genesis: Buffer.from(genesis.genesis.toBytes()).toString('hex'),
        epoch: 0,
        recipient: Buffer.from(recovery.publicKey.toBytes()).toString('hex'),
      };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const keys = yield* makeSqliteProtectedEpochKeys({
              path: file('owner-keys'),
              mode: 'create',
              genesis: genesis.genesis,
              recipient: owner.publicKey,
              ledger,
              protector: labSyntheticProtector,
            });
            yield* keys.saveAndReload(0, key);
            const host = yield* makeSqliteKeyMailbox({
              path: file('host'),
              mode: 'create',
              genesis: genesis.genesis,
              ledger,
            });
            const joins = yield* makeLabJoinMailbox({
              path: file('joins'),
              mode: 'create',
              genesis: genesis.genesis,
              ledger,
            });
            const http = yield* makeAuthenticatedLabMailbox({
              directory: dir,
              mode: 'create',
              genesis: genesis.genesis,
              ledger,
              mailbox: host,
              joins,
            });
            const anonymous = yield* makeLabMailboxRemote({ url: http.url, fetch });
            const unauthenticated = yield* Effect.result(anonymous.fetch(0, null, 100));
            expect(Result.isFailure(unauthenticated)).toBe(true);
            if (Result.isFailure(unauthenticated))
              expect(unauthenticated.failure.code).toBe('unauthorized');
            const ownerSession = yield* http.authenticate(owner);
            const receiverSession = yield* http.authenticate(recovery);
            const recoveryJoin = yield* prepareJoinRequest({
              genesis: genesis.genesis,
              requestId: ok(Bytes.requestId(new Uint8Array(16).fill(147))),
              userId: ok(Bytes.userId(new Uint8Array(32).fill(148))),
              encryptionPublicKey,
              expiresAt: null,
              signer: recovery,
            });
            const deniedJoin = yield* Effect.promise(() =>
              receiverSession.fetch(http.url.replace('/key-mailbox', '/joins'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(labJoinWire(recoveryJoin)),
              })
            );
            expect(deniedJoin.status).toBe(403);
            expect(
              yield* joins.list({
                account: 'synthetic-owner',
                device: owner.publicKey,
                genesis: genesis.genesis,
              })
            ).toEqual([]);

            const remote = yield* makeLabMailboxRemote(ownerSession);
            let tamper = false;
            const receiverRemote = yield* makeLabMailboxRemote({
              url: receiverSession.url,
              fetch: async (input, init) => {
                const response = await receiverSession.fetch(input, init);
                if (!tamper || JSON.parse(String(init?.body)).op !== 'fetch') return response;
                const page = (await response.json()) as {
                  items: { sender: string; frame: string }[];
                  next: string | null;
                };
                const bytes = Buffer.from(page.items[0]!.frame, 'hex');
                bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
                page.items[0]!.frame = bytes.toString('hex');
                return new Response(JSON.stringify(page), { status: response.status });
              },
            });
            const distributor = yield* makeSqliteKeyDistribution({
              path: file('owner-receive'),
              mode: 'create',
              genesis: genesis.genesis,
              signer: owner,
              pair: ownerPair,
              ledger,
              remote,
              keyStore: {
                path: file('owner-keys'),
                mode: 'open',
                protector: labSyntheticProtector,
              },
              repairStore: { path: file('owner-repair'), mode: 'create' },
              sendStore: { path: file('owner-send'), mode: 'create' },
              outboxStore: { path: file('owner-outbox'), mode: 'create' },
              currentPublication: () => Effect.succeed(genesis.record),
            });
            const invalidRound = yield* Effect.result(runLabKeyRound(distributor, 0));
            expect(Result.isFailure(invalidRound)).toBe(true);
            if (Result.isFailure(invalidRound)) {
              expect(invalidRound.failure).toBeInstanceOf(LabKeyRoundError);
              expect((invalidRound.failure as LabKeyRoundError).reason).toBe('invalid-limit');
            }
            const untouched = new Database(file('owner-send'), {
              fileMustExist: true,
              readonly: true,
            });
            try {
              expect(
                untouched.prepare('SELECT count(*) AS n FROM distribution_tasks').get()
              ).toEqual({ n: 0 });
              expect((yield* receiverRemote.fetch(0, null, 100)).items).toEqual([]);
            } finally {
              untouched.close();
            }
            const firstRound = yield* runLabKeyRound(distributor);
            expect(firstRound.results.map((row) => row.outcome)).toEqual(['Reported']);
            expect(firstRound.reconciliation).toEqual({ scheduled: 1, next: null, blocked: [] });
            expect(firstRound.delivered.blocked).toEqual([]);
            expect((yield* remote.status(slot)).status).toBe('EnvelopeStored');
            const before = yield* receiverRemote.fetch(0, null, 100);
            expect(before.items).toHaveLength(1);
            expectedFrame = new Uint8Array(before.items[0]!.frame);
            // A real owner-signed HPKE frame does not let a Recovery bearer choose
            // the sender via hostile JSON. Server binds only the stored principal.
            const forged = yield* Effect.promise(() =>
              receiverSession.fetch(receiverSession.url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  op: 'put',
                  id: 'ef'.repeat(16),
                  bytes: Buffer.from(before.items[0]!.frame).toString('hex'),
                  deviceHex: Buffer.from(owner.publicKey.toBytes()).toString('hex'),
                  principal: Buffer.from(owner.publicKey.toBytes()).toString('hex'),
                }),
              })
            );
            expect(forged.status).toBe(403);
            expect((yield* receiverRemote.fetch(0, null, 100)).items).toEqual(before.items);

            const receiver = yield* makeSqliteKeyDistribution({
              path: file('recovery-receive'),
              mode: 'create',
              genesis: genesis.genesis,
              signer: recovery,
              pair,
              ledger,
              remote: receiverRemote,
              keyStore: {
                path: file('recovery-keys'),
                mode: 'create',
                protector: labSyntheticProtector,
              },
              repairStore: { path: file('recovery-repair'), mode: 'create' },
              sendStore: { path: file('recovery-send'), mode: 'create' },
              outboxStore: { path: file('recovery-outbox'), mode: 'create' },
              currentPublication: () => Effect.succeed(null),
            });
            tamper = true;
            expect(Result.isFailure(yield* Effect.result(runLabKeyRound(receiver)))).toBe(true);
            expect((yield* remote.status(slot)).status).toBe('EnvelopeStored');
            const db = new Database(file('recovery-keys'), { fileMustExist: true });
            try {
              expect(db.prepare('SELECT count(*) AS n FROM installed_epoch_keys').get()).toEqual({
                n: 0,
              });
            } finally {
              db.close();
            }
            tamper = false;
            const blocker = new Database(file('recovery-keys'), { fileMustExist: true });
            try {
              blocker.exec(
                'CREATE TRIGGER reject_pending_install BEFORE INSERT ON installed_epoch_keys BEGIN SELECT RAISE(IGNORE); END'
              );
            } finally {
              blocker.close();
            }
            expect(Result.isFailure(yield* Effect.result(runLabKeyRound(receiver)))).toBe(true);
            expect((yield* remote.status(slot)).status).toBe('EnvelopeStored');
            const pending = new Database(file('recovery-receive'), { fileMustExist: true });
            try {
              expect(pending.prepare('SELECT phase FROM receive_tasks').all()).toEqual([
                { phase: 'Install' },
              ]);
            } finally {
              pending.close();
            }
            const repair = new Database(file('recovery-keys'), { fileMustExist: true });
            try {
              expect(
                repair.prepare('SELECT count(*) AS n FROM installed_epoch_keys').get()
              ).toEqual({ n: 0 });
              repair.exec('DROP TRIGGER reject_pending_install');
            } finally {
              repair.close();
            }
            expect(yield* receiver.results()).toEqual([]);
            expect((yield* distributor.reconcileCurrentEpoch()).scheduled).toBe(0);
            expect((yield* receiverRemote.fetch(0, null, 100)).items[0]!.frame).toEqual(
              before.items[0]!.frame
            );
          })
        )
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeSqliteKeyMailbox({
              path: file('host'),
              mode: 'open',
              genesis: genesis.genesis,
              ledger,
            });
            const http = yield* makeAuthenticatedLabMailbox({
              directory: dir,
              mode: 'open',
              genesis: genesis.genesis,
              ledger,
              mailbox: host,
            });
            const receiverSession = yield* http.authenticate(recovery);
            const remote = yield* makeLabMailboxRemote(receiverSession);
            const crash = yield* Effect.result(
              runOwnedChild([
                '--import',
                'tsx',
                fileURLToPath(new URL('./key-reopen.mts', import.meta.url)),
                dir,
                http.url.replace(`/v1/spaces/${slot.genesis}/key-mailbox`, ''),
                'crash-before-report',
              ])
            );
            expect(Result.isFailure(crash)).toBe(true);
            if (Result.isFailure(crash))
              expect((crash.failure as Error & { code: number }).code).toBe(73);
            const crashKeys = new Database(file('recovery-keys'), {
              fileMustExist: true,
              readonly: true,
            });
            const crashJournal = new Database(file('recovery-receive'), {
              fileMustExist: true,
              readonly: true,
            });
            let originalProtected: Uint8Array;
            try {
              const saved = crashKeys
                .prepare('SELECT blob FROM installed_epoch_keys WHERE epoch=0')
                .get() as { blob: Uint8Array };
              originalProtected = new Uint8Array(saved.blob);
              expect(crashJournal.prepare('SELECT phase,report FROM receive_tasks').all()).toEqual([
                { phase: 'Install', report: null },
              ]);
            } finally {
              crashKeys.close();
              crashJournal.close();
            }
            expect((yield* remote.status(slot)).status).toBe('EnvelopeStored');
            const child = yield* runOwnedChild([
              '--import',
              'tsx',
              fileURLToPath(new URL('./key-reopen.mts', import.meta.url)),
              dir,
              http.url.replace(`/v1/spaces/${slot.genesis}/key-mailbox`, ''),
            ]);
            const completed = JSON.parse(child.trim()) as {
              installed: { processed: number; next: string | null };
              outcomes: string[];
            };
            expect(completed.installed).toEqual({ processed: 1, next: null });
            expect(completed.outcomes).toEqual(['Reported']);
            expect((yield* remote.status(slot)).status).toBe('InstallationReported');
            const readback = new Database(file('recovery-keys'), {
              fileMustExist: true,
              readonly: true,
            });
            try {
              expect(
                new Uint8Array(
                  (
                    readback
                      .prepare('SELECT blob FROM installed_epoch_keys WHERE epoch=0')
                      .get() as {
                      blob: Uint8Array;
                    }
                  ).blob
                )
              ).toEqual(originalProtected);
            } finally {
              readback.close();
            }
            const retained = new Database(file('recovery-receive'), { fileMustExist: true });
            try {
              const row = retained.prepare('SELECT phase,frame FROM receive_tasks').get() as {
                phase: string;
                frame: Uint8Array;
              };
              expect(row.phase).toBe('Reported');
              expect(new Uint8Array(row.frame)).toEqual(expectedFrame);
            } finally {
              retained.close();
            }
            const reopened = yield* makeSqliteKeyDistribution({
              path: file('recovery-receive'),
              mode: 'open',
              genesis: genesis.genesis,
              signer: recovery,
              pair,
              ledger,
              remote,
              keyStore: {
                path: file('recovery-keys'),
                mode: 'open',
                protector: labSyntheticProtector,
              },
              repairStore: { path: file('recovery-repair'), mode: 'open' },
              sendStore: { path: file('recovery-send'), mode: 'open' },
              outboxStore: { path: file('recovery-outbox'), mode: 'open' },
              currentPublication: () => Effect.succeed(null),
            });
            expect((yield* reopened.results()).map((item) => item.outcome)).toEqual(['Reported']);
            const recoveryRound = yield* runLabKeyRound(reopened);
            expect(recoveryRound.reconciliation).toEqual({ scheduled: 0, next: null, blocked: [] });
            expect((yield* remote.status(slot)).status).toBe('InstallationReported');
            // R can repair its own receive slot. Arbitrary existing bounded request
            // IDs remain valid; no new hex-ID wire format is invented in the adapter.
            yield* remote.repair(slot, 'lab-repair-request');
            expect((yield* remote.status(slot)).revision).toBe(1);
            yield* remote.repair(slot, 'lab-repair-request');
            expect((yield* remote.status(slot)).revision).toBe(1);
          })
        )
      );
      // Fixture-owned complete signed history is independently pinned, not a
      // server-provided checkpoint or implementation of createSpace's pending layout.
      // Synthetic key preparation is NOT a durable production rotation producer.
      const key1 = ok(Bytes.epochKey(new Uint8Array(32).fill(155)));
      const commitment1 = ok(commitEpochKey(genesis.genesis, 1, key1));
      const packet1 = ok(
        sealHistoryPacket({
          genesis: genesis.genesis,
          epoch: 1,
          currentKey: key1,
          previousKey: key,
        })
      );
      const epochOne = await Effect.runPromise(
        signLedgerRecord(
          ok(
            prepareLedgerRecord(
              view(),
              ok(
                encodeCbor([
                  view().head.toBytes(),
                  owner.publicKey.toBytes(),
                  [7, 1, commitment1.toBytes(), packet1],
                ])
              )
            )
          ),
          owner
        )
      );
      records.push(epochOne);
      expect(view().inspectState().epoch.number).toBe(1);
      const key2 = ok(Bytes.epochKey(new Uint8Array(32).fill(156)));
      const commitment2 = ok(commitEpochKey(genesis.genesis, 2, key2));
      const packet2 = ok(
        sealHistoryPacket({
          genesis: genesis.genesis,
          epoch: 2,
          currentKey: key2,
          previousKey: key1,
        })
      );
      const proposalFor = (device: typeof owner) =>
        prepareLedgerRecord(
          view(),
          ok(
            encodeCbor([
              view().head.toBytes(),
              device.publicKey.toBytes(),
              [7, 2, commitment2.toBytes(), packet2],
            ])
          )
        );
      expect(Result.isSuccess(proposalFor(owner))).toBe(true);
      expect(Result.isFailure(proposalFor(recovery))).toBe(true);
      const deviceFixture = JSON.parse(readFileSync(join(dir, 'recovery-device.json'), 'utf8'));
      deviceFixture.records = records.map((record) => Buffer.from(record).toString('hex'));
      deviceFixture.checkpoint = {
        head: Buffer.from(hashRecordBytes(epochOne).toBytes()).toString('hex'),
        length: records.length,
      };
      writeFileSync(join(dir, 'recovery-device.json'), JSON.stringify(deviceFixture), {
        mode: 0o600,
      });
      const slot1 = { ...slot, epoch: 1 };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const keys = yield* makeSqliteProtectedEpochKeys({
              path: file('owner-keys'),
              mode: 'open',
              genesis: genesis.genesis,
              recipient: owner.publicKey,
              ledger,
              protector: labSyntheticProtector,
            });
            yield* keys.saveAndReload(1, key1);
            const host = yield* makeSqliteKeyMailbox({
              path: file('host'),
              mode: 'open',
              genesis: genesis.genesis,
              ledger,
            });
            const http = yield* makeAuthenticatedLabMailbox({
              directory: dir,
              mode: 'open',
              genesis: genesis.genesis,
              ledger,
              mailbox: host,
            });
            const ownerSession = yield* http.authenticate(owner);
            const senderRemote = yield* makeLabMailboxRemote(ownerSession);
            const sender = yield* makeSqliteKeyDistribution({
              path: file('owner-receive'),
              mode: 'open',
              genesis: genesis.genesis,
              signer: owner,
              pair: ownerPair,
              ledger,
              remote: senderRemote,
              keyStore: {
                path: file('owner-keys'),
                mode: 'open',
                protector: labSyntheticProtector,
              },
              repairStore: { path: file('owner-repair'), mode: 'open' },
              sendStore: { path: file('owner-send'), mode: 'open' },
              outboxStore: { path: file('owner-outbox'), mode: 'open' },
              currentPublication: () => Effect.succeed(epochOne),
            });
            const epochOneRound = yield* runLabKeyRound(sender);
            expect(epochOneRound.reconciliation).toEqual({ scheduled: 1, next: null, blocked: [] });
            expect(epochOneRound.delivered.blocked).toEqual([]);
            expect((yield* senderRemote.status(slot1)).status).toBe('EnvelopeStored');
            const receiverSession = yield* http.authenticate(recovery);
            const receiverRemote = yield* makeLabMailboxRemote(receiverSession);
            const retainedFrame1 = new Uint8Array(
              (yield* receiverRemote.fetch(1, null, 100)).items[0]!.frame
            );
            const child = yield* runOwnedChild([
              '--import',
              'tsx',
              fileURLToPath(new URL('./key-reopen.mts', import.meta.url)),
              dir,
              http.url.replace(`/v1/spaces/${slot.genesis}/key-mailbox`, ''),
              'epoch1',
            ]);
            const completed = JSON.parse(child.trim()) as {
              installed: { processed: number; next: string | null };
              outcomes: string[];
              beforeHistory: number[];
              afterHistory: number[];
              historyCommitmentMatchesOriginal: boolean;
            };
            expect(completed.installed).toEqual({ processed: 1, next: null });
            expect(completed.outcomes).toEqual(['Reported']);
            expect(completed.beforeHistory).toEqual([1]);
            expect(completed.afterHistory).toEqual([0, 1]);
            expect(completed.historyCommitmentMatchesOriginal).toBe(true);
            expect((yield* senderRemote.status(slot1)).status).toBe('InstallationReported');
            const db = new Database(file('epoch1-recovery-receive'), { fileMustExist: true });
            try {
              const row = db.prepare('SELECT phase,frame FROM receive_tasks').get() as {
                phase: string;
                frame: Uint8Array;
              };
              expect(row.phase).toBe('Reported');
              expect(new Uint8Array(row.frame)).toEqual(retainedFrame1);
            } finally {
              db.close();
            }
            const reopened = yield* makeSqliteKeyDistribution({
              path: file('epoch1-recovery-receive'),
              mode: 'open',
              genesis: genesis.genesis,
              signer: recovery,
              pair,
              ledger,
              remote: receiverRemote,
              keyStore: {
                path: file('epoch1-recovery-keys'),
                mode: 'open',
                protector: labSyntheticProtector,
              },
              repairStore: { path: file('epoch1-recovery-repair'), mode: 'open' },
              sendStore: { path: file('epoch1-recovery-send'), mode: 'create' },
              outboxStore: { path: file('epoch1-recovery-outbox'), mode: 'create' },
              currentPublication: () => Effect.succeed(epochOne),
            });
            const epochOneRecoveryRound = yield* runLabKeyRound(reopened);
            expect(epochOneRecoveryRound.reconciliation).toEqual({
              scheduled: 0,
              next: null,
              blocked: [],
            });
            expect((yield* senderRemote.status(slot1)).status).toBe('InstallationReported');
            records.push(
              yield* signLedgerRecord(
                ok(
                  prepareLedgerCommand(view(), owner.publicKey, {
                    _tag: 'RevokeDevice',
                    target: owner.publicKey,
                  })
                ),
                owner
              )
            );
            expect(ok(contentPermissions(view(), owner.publicKey))).toMatchObject({
              mayWriteDocument: false,
              maySealNewContent: false,
            });
            deviceFixture.records = records.map((record) => Buffer.from(record).toString('hex'));
            deviceFixture.checkpoint = {
              head: Buffer.from(hashRecordBytes(records.at(-1)!).toBytes()).toString('hex'),
              length: records.length,
            };
            writeFileSync(join(dir, 'recovery-device.json'), JSON.stringify(deviceFixture), {
              mode: 0o600,
            });
            const localRestore = yield* runOwnedChild([
              '--import',
              'tsx',
              fileURLToPath(new URL('./key-reopen.mts', import.meta.url)),
              dir,
              'http://127.0.0.1:1',
              'installed-only',
            ]);
            expect(JSON.parse(localRestore)).toEqual({
              commitments: [
                { epoch: 0, matches: true },
                { epoch: 1, matches: true },
              ],
              localOnly: true,
            });
          })
        )
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
