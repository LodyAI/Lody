import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Exit, Result } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { encodeCbor, verifySignature } from '@lody/e2ee-core/protocol';
import { signVerified } from '@lody/e2ee-core/protocol';
import { epochStagingRequestSigningBytes } from '@lody/cloud-api/e2ee-epoch-staging';
import { type LedgerView } from '@lody/e2ee-core';
import { extendLedger, hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import { prepareLedgerRecord, signLedgerRecord } from '@lody/e2ee-core/protocol';
import { commitEpochKey, sealHistoryPacket } from '@lody/e2ee-core/protocol';
import { prepareEpochEnvelope } from '@lody/e2ee-core/protocol';
import { type EpochStagedGroup } from '@lody/e2ee-core';
import {
  ownEpochStagedGroup,
  obsoleteEpochStagedGroup,
  sameEpochStagedGroup,
} from '@lody/e2ee-core/protocol';
import {
  signGenesisRecord,
  prepareDeviceAdmission,
  prepareLedgerCommand,
} from '@lody/e2ee-core/protocol';
import { generateDevice } from '../src/platform/device';
import { makeLabEpochStaging } from '../src/platform/epoch-staging';
import { encodeLabEpochGroup, dispatchLabEpochStaging } from '../src/platform/epoch-staging-http';
const ok = Result.getOrThrow;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = async () => {
  const f = await Effect.runPromise(
    Effect.gen(function* () {
      const owner = yield* generateDevice(),
        recipient = yield* generateDevice();
      const secret = ok(Bytes.epochKey(new Uint8Array(32).fill(39)));
      const membershipId = ok(Bytes.membershipId(new Uint8Array(16).fill(38)));
      const genesis = yield* signGenesisRecord({
        userId: ok(Bytes.userId(new Uint8Array(32).fill(37))),
        membershipId,
        encryptionPublicKey: owner.enc,
        initialKey: secret,
        signer: owner,
      });
      const initial = ok(
        verifyLedger({
          anchor: genesis.genesis,
          records: [genesis.record],
          checkpoint: { head: hashRecordBytes(genesis.record), length: 1 },
        })
      );
      const admission = yield* prepareDeviceAdmission({
        genesis: genesis.genesis,
        membershipId,
        encryptionPublicKey: recipient.enc,
        kind: 'personal',
        signer: recipient,
      });
      const record = yield* signLedgerRecord(
        ok(prepareLedgerCommand(initial, owner.publicKey, admission)),
        owner
      );
      const before = ok(
        extendLedger(initial, [record], { head: hashRecordBytes(record), length: 2 })
      );
      return {
        context: { genesis: genesis.genesis },
        owner: { publicKey: owner.publicKey, signer: owner },
        secret,
        ownerDevice: owner,
        otherDevice: recipient,
        before,
      };
    })
  );
  const before = f.before;
  const groups: EpochStagedGroup[] = [],
    views: LedgerView[] = [];
  for (const seed of [40, 41]) {
    const key = ok(Bytes.epochKey(new Uint8Array(32).fill(seed)));
    const group = await Effect.runPromise(
      Effect.gen(function* () {
        const epoch = ok(Bytes.epochNumber(1));
        const commitment = ok(commitEpochKey(f.context.genesis, epoch, key));
        const packet = ok(
          sealHistoryPacket({
            genesis: f.context.genesis,
            epoch,
            currentKey: key,
            previousKey: f.secret,
          })
        );
        const record = yield* signLedgerRecord(
          ok(
            prepareLedgerRecord(
              before,
              ok(
                encodeCbor([
                  before.head.toBytes(),
                  f.owner.publicKey.toBytes(),
                  [7, epoch, commitment.toBytes(), packet],
                ])
              )
            )
          ),
          f.owner.signer
        );
        const view = ok(
          extendLedger(before, [record], {
            head: hashRecordBytes(record),
            length: before.length + 1,
          })
        );
        views.push(view);
        const envelopes = [];
        for (const recipient of view.inspectState().devices.keys())
          envelopes.push({
            recipient,
            frame: yield* prepareEpochEnvelope({
              context: {
                genesis: f.context.genesis,
                epoch,
                sender: f.owner.publicKey,
                recipient: ok(
                  Bytes.signingPublicKey(new Uint8Array(Buffer.from(recipient, 'hex')))
                ),
              },
              key,
              signer: f.owner.signer,
              ledger: () => Effect.succeed(before),
              candidate: { before, record },
            }),
          });
        return ok(
          ownEpochStagedGroup({
            genesis: hex(f.context.genesis.toBytes()),
            epoch,
            commitment: hex(commitment.toBytes()),
            recordHash: hex(hashRecordBytes(record).toBytes()),
            record,
            envelopes,
          })
        );
      })
    );
    groups.push(group);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'e2ee-stage-'));
  dirs.push(dir);
  return {
    path: path.join(dir, 'stage.sqlite'),
    before,
    groups,
    views,
    owner: f.ownerDevice,
    other: f.otherDevice,
  };
};
const count = (file: string) => {
  const db = new Database(file);
  try {
    return {
      groups: (db.prepare('SELECT count(*) n FROM staged_groups').get() as { n: number }).n,
      envelopes: (db.prepare('SELECT count(*) n FROM staged_envelopes').get() as { n: number }).n,
    };
  } finally {
    db.close();
  }
};
describe('transactional complete epoch staging', () => {
  it('binds a device proof to the complete immutable stage or delete request', async () => {
    const f = await fixture();
    const group = encodeLabEpochGroup(f.groups[0]!);
    const stage = { operation: 'stage' as const, workspaceId: 'synthetic-workspace', group };
    const original = epochStagingRequestSigningBytes(stage);
    expect(
      epochStagingRequestSigningBytes({
        ...stage,
        group: { ...group, envelopes: [...group.envelopes].reverse() },
      })
    ).toEqual(original);
    const signature = await Effect.runPromise(signVerified(f.owner, original));
    const verify = (bytes: Uint8Array) =>
      verifySignature(f.owner.publicKey.toBytes(), bytes, signature.toBytes());
    expect(Result.isSuccess(verify(original))).toBe(true);
    const changed = [
      { ...stage, workspaceId: 'other-workspace' },
      { ...stage, group: { ...group, genesis: 'aa'.repeat(32) } },
      { ...stage, group: { ...group, epoch: group.epoch + 1 } },
      { ...stage, group: { ...group, commitment: 'bb'.repeat(32) } },
      { ...stage, group: { ...group, recordHash: 'cc'.repeat(32) } },
      {
        ...stage,
        group: {
          ...group,
          recordHex: group.recordHex.slice(0, -2) + (group.recordHex.endsWith('00') ? '01' : '00'),
        },
      },
      { ...stage, group: { ...group, envelopes: group.envelopes.slice(0, 1) } },
      {
        ...stage,
        group: {
          ...group,
          envelopes: group.envelopes.map((row, index) =>
            index
              ? row
              : {
                  ...row,
                  frameHex: row.frameHex.slice(0, -2) + (row.frameHex.endsWith('00') ? '01' : '00'),
                }
          ),
        },
      },
    ];
    for (const request of changed)
      expect(Result.isFailure(verify(epochStagingRequestSigningBytes(request)))).toBe(true);
    const deletion = {
      operation: 'delete' as const,
      workspaceId: stage.workspaceId,
      key: group,
      occupied: { epoch: group.epoch, commitment: f.groups[1]!.commitment },
    };
    const deletionBytes = epochStagingRequestSigningBytes(deletion);
    expect(Result.isFailure(verify(deletionBytes))).toBe(true);
    const deleteSignature = await Effect.runPromise(signVerified(f.owner, deletionBytes));
    expect(
      Result.isFailure(
        verifySignature(
          f.owner.publicKey.toBytes(),
          epochStagingRequestSigningBytes({
            ...deletion,
            occupied: { epoch: group.epoch, commitment: 'dd'.repeat(32) },
          }),
          deleteSignature.toBytes()
        )
      )
    ).toBe(true);
    for (const invalid of [
      { ...stage, group: { ...group, envelopes: [group.envelopes[0]!, group.envelopes[0]!] } },
      { ...stage, group: { ...group, envelopes: [] } },
      { ...stage, group: { ...group, recordHex: '00'.repeat(8193) } },
      {
        ...stage,
        group: { ...group, envelopes: [{ ...group.envelopes[0]!, frameHex: '00'.repeat(513) }] },
      },
      { ...stage, workspaceId: '' },
      { ...deletion, occupied: { epoch: group.epoch, commitment: group.commitment } },
    ])
      expect(() => epochStagingRequestSigningBytes(invalid)).toThrow(TypeError);
  });

  it('refuses deletion by another active device even with a genuine occupied commitment', async () => {
    const f = await fixture(),
      [winner, loser] = f.groups;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeLabEpochStaging({ path: f.path, mode: 'create' });
          yield* store.stageGroup(winner!);
          yield* store.stageGroup(loser!);
          const request = {
            op: 'delete',
            key: loser!,
            occupied: { epoch: 1, commitment: winner!.commitment },
          };
          const credential = {
            token: '',
            account: 'synthetic-other',
            device: f.other.publicKey,
            genesis: f.before.genesis,
            issuedAt: 0,
            expiresAt: 1,
          };
          const result = yield* Effect.result(
            dispatchLabEpochStaging({
              value: request,
              genesis: f.before.genesis,
              credential,
              ledger: () => Effect.succeed(f.views[0]!),
              port: store,
            })
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toMatchObject({
              _tag: 'LabEpochStagingHttpError',
              code: 'unauthorized',
            });
          expect(yield* store.readGroup(loser!)).toEqual(loser);
          expect(yield* store.readGroup(winner!)).toEqual(winner);
          const ownResult = yield* dispatchLabEpochStaging({
            value: request,
            genesis: f.before.genesis,
            credential: { ...credential, device: f.owner.publicKey },
            ledger: () => Effect.succeed(f.views[0]!),
            port: store,
          });
          expect(ownResult).toEqual({ ok: true });
          expect(yield* store.readGroup(loser!)).toBeNull();
          // Absence is terminal success: do not evaluate a new cleanup claim or
          // issue another DELETE after discovering that the original is gone.
          const db = new Database(f.path);
          try {
            db.exec(
              "CREATE TRIGGER unexpected_delete BEFORE DELETE ON staged_groups BEGIN SELECT RAISE(ABORT,'unexpected second delete'); END"
            );
            expect(
              yield* dispatchLabEpochStaging({
                value: { ...request, occupied: { epoch: 2, commitment: loser!.commitment } },
                genesis: f.before.genesis,
                credential: { ...credential, device: f.owner.publicKey },
                ledger: () => Effect.succeed(f.views[0]!),
                port: store,
              })
            ).toEqual({ ok: true });
          } finally {
            db.close();
          }
          expect(yield* store.readGroup(winner!)).toEqual(winner);
        })
      )
    );
  });

  it('rolls back whole groups on ignored or rewritten rows and retains exact ciphertext across reopen', async () => {
    for (const fault of ['ignore-group', 'ignore-envelope', 'rewrite-envelope'] as const) {
      const f = await fixture(),
        group = f.groups[0]!;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* makeLabEpochStaging({
              path: f.path,
              mode: 'create',
            });
            const db = new Database(f.path);
            try {
              db.exec(
                fault === 'ignore-group'
                  ? 'CREATE TRIGGER stage_fault BEFORE INSERT ON staged_groups BEGIN SELECT RAISE(IGNORE);END'
                  : fault === 'ignore-envelope'
                    ? `CREATE TRIGGER stage_fault BEFORE INSERT ON staged_envelopes WHEN NEW.recipient='${group.envelopes[1]!.recipient}' BEGIN SELECT RAISE(IGNORE);END`
                    : `CREATE TRIGGER stage_fault AFTER INSERT ON staged_envelopes WHEN NEW.recipient='${group.envelopes[1]!.recipient}' BEGIN UPDATE staged_envelopes SET frame=x'01' WHERE recipient=NEW.recipient;END`
              );
              expect(Exit.isFailure(yield* Effect.exit(store.stageGroup(group)))).toBe(true);
              expect(count(f.path)).toEqual({ groups: 0, envelopes: 0 });
              expect(yield* store.readGroup(group)).toBeNull();
              db.exec('DROP TRIGGER stage_fault');
              yield* store.stageGroup(group);
              yield* store.stageGroup(group);
              expect(count(f.path)).toEqual({ groups: 1, envelopes: 2 });
            } finally {
              db.close();
            }
          })
        )
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reopened = yield* makeLabEpochStaging({
              path: f.path,
              mode: 'open',
            });
            const actual = yield* reopened.readGroup(group);
            expect(actual && sameEpochStagedGroup(group, actual)).toBe(true);
            const changed = {
              ...group,
              envelopes: group.envelopes.map((row, i) => ({
                ...row,
                frame: i ? new Uint8Array([1]) : row.frame,
              })),
            };
            const result = yield* Effect.exit(reopened.stageGroup(changed));
            expect(Exit.isFailure(result)).toBe(true);
            expect(yield* reopened.readGroup(group)).toEqual(group);
          })
        )
      );
    }
  });
  it('keeps honest-client cleanup qualification separate from opaque storage', async () => {
    const f = await fixture(),
      [winner, loser] = f.groups;
    let view = f.before;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeLabEpochStaging({
            path: f.path,
            mode: 'create',
          });
          yield* store.stageGroup(winner!);
          yield* store.stageGroup(loser!);
          expect(Result.isFailure(obsoleteEpochStagedGroup(view, loser!))).toBe(true);
          expect(count(f.path)).toEqual({ groups: 2, envelopes: 4 });
          view = f.views[0]!;
          expect(Result.isFailure(obsoleteEpochStagedGroup(view, winner!))).toBe(true);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                store.deleteGroup(loser!, { epoch: 2, commitment: winner!.commitment })
              )
            )
          ).toBe(true);
          yield* store.deleteGroup(loser!, ok(obsoleteEpochStagedGroup(view, loser!)));
          expect(yield* store.readGroup(loser!)).toBeNull();
          expect(yield* store.readGroup(winner!)).toEqual(winner);
          expect(count(f.path)).toEqual({ groups: 1, envelopes: 2 });
        })
      )
    );
  });
});
