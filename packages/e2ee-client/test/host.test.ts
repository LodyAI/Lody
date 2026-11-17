import type {
  RecoveryVaultLocalStore as LocalStore,
  RecoveryVaultStore as VaultStore,
} from '@lody/e2ee-core/services';
import { describe, expect, it } from 'vitest';
import { Effect, Result } from 'effect';
import { signLedgerSnapshot } from '@lody/e2ee-core/protocol';
import { envelopeFixture } from '../../e2ee-core/test/keys/fixture';
import { assertPersonalAdmission, verifyPersonalHistory } from '../src/admission';
import {
  encodePersonalInvitation,
  verifyPersonalApproval,
  type PersonalPairingOffer,
} from '../src/pairing';

const hex = (a: Uint8Array) => Buffer.from(a).toString('hex');
describe('portable personal host admission boundary', () => {
  it('never substitutes login, an endorsed snapshot or a foreign device for exact personal admission', async () => {
    const f = envelopeFixture();
    const offer: PersonalPairingOffer = {
      version: 1,
      workspaceId: 'workspace-A',
      genesisHash: hex(f.context.genesis.toBytes()),
      genesisRecordHex: hex(f.genesisRecord),
      endorser: hex(f.owner.raw),
      membershipId: '0a'.repeat(16),
      pairingSessionId: '11'.repeat(16),
    };
    const receipt = {
      workspaceId: offer.workspaceId,
      ...(await Effect.runPromise(
        signLedgerSnapshot({ signer: f.owner.signer, ledger: f.ledger })
      )),
      offset: 'opaque/approved',
    };
    const approval = Result.getOrThrow(verifyPersonalApproval(offer, receipt));
    const binding = {
      accountId: 'A',
      workspaceId: offer.workspaceId,
      genesis: f.context.genesis,
      device: f.phone.publicKey,
      installationId: 'aa'.repeat(32),
    };
    const request = {
      ...offer,
      signingPublicKey: hex(f.phone.raw),
      encryptionPublicKey: f
        .view()
        .inspectState()
        .devices.get(hex(f.phone.raw))!
        .encryptionPublicKey.toBytes()
        .reduce((s, n) => s + n.toString(16).padStart(2, '0'), ''),
    };
    expect(Result.isSuccess(assertPersonalAdmission(binding, request, approval.view))).toBe(true);
    for (const wrong of [
      { ...request, membershipId: 'bb'.repeat(16) },
      { ...request, encryptionPublicKey: 'cc'.repeat(32) },
      { ...request, signingPublicKey: hex(f.owner.raw) },
    ])
      expect(Result.isFailure(assertPersonalAdmission(binding, wrong, approval.view))).toBe(true);
    expect(
      Result.isFailure(
        assertPersonalAdmission({ ...binding, workspaceId: 'foreign' }, request, approval.view)
      )
    ).toBe(true);
    expect(encodePersonalInvitation(receipt).length).toBeGreaterThan(0);
  });
  it('replays every full-history signature from its independent genesis and rejects incomplete/malformed pages', async () => {
    const f = envelopeFixture();
    const offer = {
      workspaceId: 'workspace-A',
      genesisHash: hex(f.context.genesis.toBytes()),
      genesisRecordHex: hex(f.genesisRecord),
    };
    const page = {
      workspaceId: offer.workspaceId,
      genesisHash: offer.genesisHash,
      checkpoint: { length: f.records().length, headHash: hex(f.view().head.toBytes()) },
      startIndex: 0,
      recordsHex: f.records().map(hex),
      position: 'opaque/final',
      nextCursor: null,
    };
    expect(
      (await Effect.runPromise(verifyPersonalHistory(offer, [page]))).head.equals(f.view().head)
    ).toBe(true);
    for (const invalid of [
      [],
      [{ ...page, startIndex: 1 }],
      [{ ...page, nextCursor: 'more' }],
      [{ ...page, recordsHex: [hex(f.genesisRecord), '00'] }],
      [{ ...page, checkpoint: null }],
    ]) {
      expect(
        Result.isFailure(
          await Effect.runPromise(Effect.result(verifyPersonalHistory(offer, invalid)))
        )
      ).toBe(true);
    }
  });
});

it.each(['partial', 'adopt-failure'] as const)(
  'retries vault restoration on the admitted device after %s',
  async (failure) => {
    const { Layer } = await import('effect');
    const { Bytes, RecoveryVaults, makeWorkspaceRecovery, memoryRecoveryEpochKeys } =
      await import('@lody/e2ee-core');
    const { RecoveryVaultStore, RecoveryVaultLocalStore } =
      await import('@lody/e2ee-core/services');
    const {
      verifyLedger,
      hashRecordBytes,
      prepareEpochEnvelope,
      commitEpochKey,
      sealHistoryPacket,
      prepareLedgerRecord,
      signLedgerRecord,
    } = await import('@lody/e2ee-core/protocol');
    const { disposeEpochKey } = await import('../../e2ee-core/src/internal/foundation/epoch-key');
    const { encodeCbor } = await import('../../e2ee-core/src/internal/foundation/cbor');
    const { restoreVaultWorkspaces, recoveryRestoreIncomplete } =
      await import('../src/recovery-restore');
    const ok = Result.getOrThrow;
    const f = envelopeFixture();
    const records: Uint8Array[] = f.records();
    const view = () =>
      ok(
        verifyLedger({
          anchor: f.context.genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)!), length: records.length },
        })
      );
    const journal = new Map<string, Uint8Array>();
    const local: LocalStore['Service'] = {
      read: (key) => Effect.sync(() => journal.get(key)?.slice() ?? null),
      compareAndSwap: (key, expected, next) =>
        Effect.sync(() => {
          if (hex(journal.get(key) ?? new Uint8Array()) !== hex(expected ?? new Uint8Array()))
            return 'Conflict' as const;
          journal.set(key, next.slice());
          return 'Committed' as const;
        }),
      list: (prefix) =>
        Effect.sync(() =>
          [...journal]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value }))
        ),
    };
    type Ciphertext = NonNullable<Effect.Success<ReturnType<VaultStore['Service']['readEntry']>>>;
    const entries = new Map<string, Ciphertext>();
    let index: Ciphertext | null = null;
    const store: VaultStore['Service'] = {
      putImmutable: (_vault, entry) =>
        Effect.sync(() => {
          entries.set(entry.entryId, entry);
        }),
      readEntry: (_vault, key) => Effect.sync(() => entries.get(key) ?? null),
      readIndex: () => Effect.sync(() => index),
      compareAndSwapIndex: (_vault, _expected, next) =>
        Effect.sync(() => {
          index = next;
          return 'Committed' as const;
        }),
      deleteUnreferenced: () => Effect.void,
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { vault, recoveryFile } = yield* (yield* RecoveryVaults).create({
            locator: 'retry-test',
          });
          recoveryFile.fill(0);
          const installed = memoryRecoveryEpochKeys();
          const next = ok(Bytes.epochKey(new Uint8Array(32).fill(0x72)));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              installed.dispose();
              disposeEpochKey(next);
              disposeEpochKey(f.secret);
            })
          );
          const envelopes = new Map<
            number,
            { sender: typeof f.owner.publicKey; frame: Uint8Array }
          >();
          const fetchEnvelope: import('@lody/e2ee-core').WorkspaceRecoveryInput['fetchCurrentEnvelope'] =
            (recipient, epoch, _identity, credential) =>
              Effect.gen(function* () {
                credential.fill(0);
                if (!envelopes.has(epoch) && epoch === 0)
                  envelopes.set(epoch, {
                    sender: f.owner.publicKey,
                    frame: yield* prepareEpochEnvelope({
                      context: { ...f.context, recipient },
                      key: f.secret,
                      signer: f.owner.signer,
                      ledger: () => Effect.sync(view),
                    }),
                  });
                return envelopes.get(epoch) ?? { pending: true as const };
              });
          const submit = (record: Uint8Array) =>
            Effect.sync(() => {
              records.push(record);
              view();
              return { outcome: 'Committed' as const, record };
            });
          const setup = yield* makeWorkspaceRecovery({
            vault,
            local,
            genesis: f.context.genesis,
            membershipId: ok(Bytes.membershipId(new Uint8Array(16).fill(10))),
            personalSigner: f.owner.signer,
            ledger: () => Effect.sync(view),
            installed,
            trust: {
              source: 'synthetic',
              genesisRecord: records[0]!,
              head: hex(view().head.toBytes()),
              length: view().length,
            },
            fetchCurrentEnvelope: fetchEnvelope,
            submitOriginal: submit,
          });
          yield* setup.setup();
          const recoveryKey = [...view().inspectState().devices].find(
            ([, device]) => device.kind === 'recovery'
          )![0];
          const body = ok(
            encodeCbor([
              view().head.toBytes(),
              f.owner.raw,
              [
                7,
                1,
                ok(commitEpochKey(f.context.genesis, 1, next)).toBytes(),
                ok(
                  sealHistoryPacket({
                    genesis: f.context.genesis,
                    epoch: 1,
                    currentKey: next,
                    previousKey: f.secret,
                  })
                ),
              ],
            ])
          );
          records.push(
            yield* signLedgerRecord(ok(prepareLedgerRecord(view(), body)), f.owner.signer)
          );
          const latest = {
            sender: f.owner.publicKey,
            frame: yield* prepareEpochEnvelope({
              context: {
                ...f.context,
                epoch: ok(Bytes.epochNumber(1)),
                recipient: ok(Bytes.signingPublicKey(Buffer.from(recoveryKey, 'hex'))),
              },
              key: next,
              signer: f.owner.signer,
              ledger: () => Effect.sync(view),
            }),
          };
          if (failure === 'adopt-failure') envelopes.set(1, latest);
          let hasIdentity = false,
            failAdoption = failure === 'adopt-failure';
          const personal = {
            ...f.ed(23).signer,
            encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(23))),
          };
          const target: import('../src/recovery-restore').RecoveryRestoreTarget = {
            id: 'workspace',
            name: 'Workspace',
            genesisHash: hex(f.context.genesis.toBytes()),
            hasIdentity: () => hasIdentity,
            connect: () =>
              Effect.gen(function* () {
                const keys = memoryRecoveryEpochKeys();
                yield* Effect.addFinalizer(() => Effect.sync(() => keys.dispose()));
                return {
                  personal,
                  personalSigner: personal,
                  ledger: () => Effect.sync(view),
                  installed: keys,
                  fetchCurrentEnvelope: fetchEnvelope,
                  submitOriginalAsRecovery: (record, _identity, credential) => {
                    credential.fill(0);
                    return submit(record);
                  },
                  acquirePersonal: () => Effect.die('not used'),
                  recovered: keys.entries,
                  adopt: (recovered) =>
                    Effect.gen(function* () {
                      hasIdentity = true;
                      if (failAdoption) {
                        failAdoption = false;
                        return yield* Effect.fail(new Error('install interrupted'));
                      }
                      for (const [epoch, key] of recovered)
                        yield* installed.saveAndReload(epoch, key);
                    }),
                };
              }),
          };
          const run = () => restoreVaultWorkspaces({ vault, local, targets: [target] });
          const progress = () =>
            new TextDecoder().decode(journal.get('restore-progress/workspace'));
          const first = yield* run();
          expect(first[0]).toMatchObject(
            failure === 'partial'
              ? { outcome: 'Committed', partialEpochKey: true }
              : { outcome: 'Failed' }
          );
          expect(progress()).toBe(failure === 'partial' ? 'partial' : 'open');
          expect(yield* recoveryRestoreIncomplete(local, 'workspace')).toBe(true);
          const admittedLength = records.length;
          envelopes.set(1, latest);
          expect((yield* run())[0]).toMatchObject({ outcome: 'Committed', partialEpochKey: false });
          expect(records.length).toBe(admittedLength);
          expect(progress()).toBe('done');
          expect(yield* recoveryRestoreIncomplete(local, 'workspace')).toBe(false);
          yield* Effect.acquireUseRelease(
            installed.read(1),
            (key) =>
              Effect.sync(() =>
                expect(
                  ok(commitEpochKey(f.context.genesis, 1, key)).equals(
                    view().inspectState().epoch.keyCommitment
                  )
                ).toBe(true)
              ),
            (key) => Effect.sync(() => disposeEpochKey(key))
          );
          expect(yield* run()).toEqual([]);
        })
      ).pipe(
        Effect.provide(
          RecoveryVaults.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(RecoveryVaultStore, store),
                Layer.succeed(RecoveryVaultLocalStore, local)
              )
            )
          )
        )
      )
    );
  }
);
