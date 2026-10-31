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
