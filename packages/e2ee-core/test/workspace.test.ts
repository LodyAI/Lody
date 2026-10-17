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
