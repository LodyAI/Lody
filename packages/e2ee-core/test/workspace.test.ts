import { Effect, Result } from 'effect';
import { describe, it, expect } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { extendLedger } from '@lody/e2ee-core/protocol';
import { issueWorkspaceInvitation, verifyWorkspaceInvitationSnapshot } from '@lody/e2ee-core';
import { envelopeFixture } from './keys/fixture';
const ok = Result.getOrThrow;
describe('independently imported workspace invitations', () => {
  it('delivers a signed manager snapshot, owns bytes and verifies every later record including self revocation', async () => {
    const f = envelopeFixture(),
      before = f.view();
    let stored: Effect.Success<ReturnType<typeof issueWorkspaceInvitation>>['receipt'] | null =
      null;
    const issued = await Effect.runPromise(
      issueWorkspaceInvitation({
        workspaceId: 'workspace-A',
        signer: f.owner.signer,
        ledger: () => Effect.succeed(before),
        offset: () => Effect.succeed('opaque/native-origin'),
        requestId: ok(Bytes.requestId(new Uint8Array(16).fill(7))),
        mailbox: {
          put: (_id, receipt) =>
            Effect.sync(() => {
              stored = { ...receipt, snapshot: new Uint8Array(receipt.snapshot) };
            }),
          read: () => Effect.succeed(stored),
        },
      })
    );
    const qualified = ok(verifyWorkspaceInvitationSnapshot(issued.pin, issued.receipt));
    expect(qualified.view.verification).toBe('endorsed-snapshot');
    f.append([5, f.phone.raw]);
    const after = f.view(),
      suffix = f.records().slice(before.length);
    const extended = ok(
      extendLedger(qualified.view, suffix, { head: after.head, length: after.length })
    );
    expect(extended.inspectState().devices.has(Buffer.from(f.phone.raw).toString('hex'))).toBe(
      false
    );
    const corrupted = new Uint8Array(suffix[0]!);
    corrupted[0] ^= 1;
    expect(
      Result.isFailure(
        extendLedger(qualified.view, [corrupted], { head: after.head, length: after.length })
      )
    ).toBe(true);
    issued.receipt.snapshot.fill(0);
    expect(qualified.view.head.equals(before.head)).toBe(true);
  });
  it('refuses a forged pinned endorser, wrong workspace, bad signature and unavailable readback', async () => {
    const f = envelopeFixture();
    const issued = await Effect.runPromise(
      issueWorkspaceInvitation({
        workspaceId: 'workspace-A',
        signer: f.owner.signer,
        ledger: () => Effect.sync(f.view),
        offset: () => Effect.succeed('opaque-origin'),
        requestId: ok(Bytes.requestId(new Uint8Array(16).fill(8))),
        mailbox: { put: () => Effect.void, read: () => Effect.succeed(null) },
      }).pipe(Effect.result)
    );
    expect(Result.isFailure(issued)).toBe(true);
    const { signLedgerSnapshot } = await import('@lody/e2ee-core/protocol');
    const signed = await Effect.runPromise(
      signLedgerSnapshot({ signer: f.owner.signer, ledger: () => Effect.sync(f.view) })
    );
    const pin = { workspaceId: 'A', genesis: f.context.genesis, endorser: f.owner.publicKey },
      receipt = {
        workspaceId: 'A',
        snapshot: signed.snapshot,
        head: signed.head,
        length: signed.length,
        headSignature: signed.headSignature,
        offset: 'opaque-origin',
      };
    expect(
      Result.isFailure(
        verifyWorkspaceInvitationSnapshot({ ...pin, endorser: f.phone.publicKey }, receipt)
      )
    ).toBe(true);
    expect(
      Result.isFailure(verifyWorkspaceInvitationSnapshot({ ...pin, workspaceId: 'B' }, receipt))
    ).toBe(true);
    const corrupt = new Uint8Array(signed.snapshot);
    corrupt[corrupt.length - 1] ^= 1;
    expect(
      Result.isFailure(verifyWorkspaceInvitationSnapshot(pin, { ...receipt, snapshot: corrupt }))
    ).toBe(true);
  });
});

describe('workspace governance safeguards', () => {
  it('requires explicit confirmation for the last personal device while keeping v1 replay compatible', async () => {
    const { WorkspaceControl, LedgerSubmission } = await import('@lody/e2ee-core');
    const { DeviceIdentity, LedgerSync } = await import('@lody/e2ee-core/services');
    const { Layer } = await import('effect');
    const f = envelopeFixture(2); // Owner personal device plus an active recovery device.
    const records: Uint8Array[] = f.records();
    const { verifyLedger, hashRecordBytes } = await import('@lody/e2ee-core/protocol');
    const view = () =>
      ok(
        verifyLedger({
          anchor: f.context.genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)!), length: records.length },
        })
      );
    const state = () =>
      Effect.sync(() => ({ view: view(), bootstrap: false, offset: String(records.length) }));
    const layer = WorkspaceControl.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DeviceIdentity, {
            signer: f.owner.signer,
            encryptionKeyPair: {} as CryptoKeyPair,
          }),
          Layer.succeed(LedgerSync, { current: state, refresh: state }),
          Layer.succeed(LedgerSubmission, {
            pending: () => Effect.succeed({ record: null, outcome: null, checkpoint: null }),
            resume: () => Effect.succeed(null),
            acknowledge: () => Effect.void,
            submit: (record) =>
              Effect.sync(() => {
                records.push(record);
                view();
                return { outcome: 'Committed' as const, record };
              }),
          })
        )
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* WorkspaceControl;
          const rejected = yield* Effect.result(
            control.execute({ _tag: 'RevokeDevice', target: f.owner.publicKey })
          );
          expect(
            Result.isFailure(rejected) && (rejected.failure as { reason: string }).reason
          ).toBe('recovery-only-confirmation-required');
          expect(view().inspectState().devices.size).toBe(2);
          yield* control.execute({
            _tag: 'RevokeDevice',
            target: f.owner.publicKey,
            confirmedRecoveryOnly: true,
          });
          expect(view().inspectState().devices.size).toBe(1);
        })
      ).pipe(Effect.provide(layer))
    );
  });
});

it('refuses a recovery-only successor without changing v1 history rules, then transfers after personal admission', async () => {
  const { WorkspaceControl, LedgerSubmission } = await import('@lody/e2ee-core');
  const { DeviceIdentity, LedgerSync } = await import('@lody/e2ee-core/services');
  const { Layer } = await import('effect');
  const {
    prepareJoinRequest,
    prepareLedgerCommand,
    prepareDeviceAdmission,
    signLedgerRecord,
    verifyLedger,
    hashRecordBytes,
  } = await import('@lody/e2ee-core/protocol');
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
  const bob = f.ed(23),
    recovery = f.ed(24),
    personal = f.ed(25);
  const member = ok(Bytes.membershipId(new Uint8Array(16).fill(23)));
  const encryptionPublicKey = ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(23)));
  const append = (
    signer: typeof f.owner.signer,
    command: Parameters<typeof prepareLedgerCommand>[2]
  ) =>
    Effect.gen(function* () {
      records.push(
        yield* signLedgerRecord(ok(prepareLedgerCommand(view(), signer.publicKey, command)), signer)
      );
      view();
    });
  const state = () =>
    Effect.sync(() => ({ view: view(), bootstrap: false, offset: String(records.length) }));
  const layer = WorkspaceControl.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DeviceIdentity, {
          signer: f.owner.signer,
          encryptionKeyPair: {} as CryptoKeyPair,
        }),
        Layer.succeed(LedgerSync, { current: state, refresh: state }),
        Layer.succeed(LedgerSubmission, {
          pending: () => Effect.succeed({ record: null, outcome: null, checkpoint: null }),
          resume: () => Effect.succeed(null),
          acknowledge: () => Effect.void,
          submit: (record) =>
            Effect.sync(() => {
              records.push(record);
              view();
              return { outcome: 'Committed' as const, record };
            }),
        })
      )
    )
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const request = yield* prepareJoinRequest({
          genesis: f.context.genesis,
          requestId: ok(Bytes.requestId(new Uint8Array(16).fill(23))),
          userId: ok(Bytes.userId(new Uint8Array(32).fill(23))),
          encryptionPublicKey,
          expiresAt: null,
          signer: bob.signer,
        });
        yield* append(f.owner.signer, { _tag: 'AdmitMember', membershipId: member, request });
        yield* append(
          bob.signer,
          yield* prepareDeviceAdmission({
            genesis: f.context.genesis,
            membershipId: member,
            encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(24))),
            kind: 'recovery',
            signer: recovery.signer,
          })
        );
        yield* append(bob.signer, { _tag: 'RevokeDevice', target: bob.publicKey });
        const command = { _tag: 'TransferOwner' as const, successorMembershipId: member };
        // Legacy v1 still authorizes and replays this record; only new workflow intent is refused.
        expect(Result.isSuccess(prepareLedgerCommand(view(), f.owner.publicKey, command))).toBe(
          true
        );
        const control = yield* WorkspaceControl;
        const rejected = yield* Effect.result(control.execute(command));
        expect(Result.isFailure(rejected) && (rejected.failure as { reason: string }).reason).toBe(
          'owner-personal-device-required'
        );
        expect(view().inspectState().owner.equals(member)).toBe(false);
        yield* append(
          recovery.signer,
          yield* prepareDeviceAdmission({
            genesis: f.context.genesis,
            membershipId: member,
            encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(25))),
            kind: 'personal',
            signer: personal.signer,
          })
        );
        yield* control.execute(command);
        expect(view().inspectState().owner.equals(member)).toBe(true);
        yield* append(personal.signer, {
          _tag: 'TransferOwner',
          successorMembershipId: ok(Bytes.membershipId(new Uint8Array(16).fill(10))),
        });
        yield* append(personal.signer, { _tag: 'RevokeDevice', target: recovery.publicKey });
        yield* append(personal.signer, { _tag: 'RevokeDevice', target: personal.publicKey });
        const noDevices = yield* Effect.result(control.execute(command));
        expect(
          Result.isFailure(noDevices) && (noDevices.failure as { reason: string }).reason
        ).toBe('owner-personal-device-required');
      })
    ).pipe(Effect.provide(layer))
  );
});
