import { describe, expect, it } from 'vitest';
import { Effect, Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import hpke from '../../e2ee-core/test/hpke-vector.json';
import {
  Bytes,
  signLedgerSnapshot,
  prepareDeviceAdmission,
  signDeviceCredentialBinding,
} from '@lody/e2ee-core/protocol';
import { credentialPacket, openCredentialPacket } from '../src/identity';
import { envelopeFixture } from '../../e2ee-core/test/keys/fixture';
import {
  PersonalPairingOfferSchema,
  decodePersonalRequest,
  encodePersonalInvitation,
  decodePersonalInvitation,
  verifyPersonalRequest,
  verifyPersonalApproval,
} from '../src/pairing';

describe('shared desktop and portable personal pairing proofs', () => {
  it('roundtrips the existing public invitation bytes and rejects a different independently pinned endorser/workspace', async () => {
    const f = envelopeFixture();
    const signed = await Effect.runPromise(
      signLedgerSnapshot({ signer: f.owner.signer, ledger: f.ledger })
    );
    const receipt = {
      workspaceId: 'workspace-A',
      snapshot: signed.snapshot,
      head: signed.head,
      length: signed.length,
      headSignature: signed.headSignature,
      offset: 'opaque/native',
    };
    const encoded = encodePersonalInvitation(receipt);
    expect(decodePersonalInvitation(encoded)).toEqual(receipt);
    const offer = PersonalPairingOfferSchema.parse({
      version: 1,
      workspaceId: 'workspace-A',
      genesisHash: Buffer.from(f.context.genesis.toBytes()).toString('hex'),
      genesisRecordHex: Buffer.from(f.genesisRecord).toString('hex'),
      endorser: Buffer.from(f.owner.raw).toString('hex'),
      membershipId: '0a'.repeat(16),
      pairingSessionId: '11'.repeat(16),
    });
    expect(Result.isSuccess(verifyPersonalApproval(offer, receipt))).toBe(true);
    expect(
      Result.isFailure(verifyPersonalApproval({ ...offer, workspaceId: 'other' }, receipt))
    ).toBe(true);
    expect(
      Result.isFailure(
        verifyPersonalApproval(
          { ...offer, endorser: Buffer.from(f.phone.raw).toString('hex') },
          receipt
        )
      )
    ).toBe(true);
    expect(() => decodePersonalInvitation(encoded + '00')).toThrow();
    expect(() => decodePersonalRequest('00')).toThrow();
  });
  it('verifies possession and credential proofs for both protection disclosures without treating them as approval', async () => {
    const f = envelopeFixture(),
      hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    const offer = PersonalPairingOfferSchema.parse({
      version: 1,
      workspaceId: 'workspace-A',
      genesisHash: hex(f.context.genesis.toBytes()),
      genesisRecordHex: hex(f.genesisRecord),
      endorser: hex(f.owner.raw),
      membershipId: '0a'.repeat(16),
      pairingSessionId: '11'.repeat(16),
    });
    const proof = await Effect.runPromise(
      prepareDeviceAdmission({
        genesis: f.context.genesis,
        membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
        encryptionPublicKey: Result.getOrThrow(
          Bytes.encryptionPublicKey(Buffer.from(hpke.epoch.pkR, 'hex'))
        ),
        kind: 'personal',
        signer: f.phone.signer,
      })
    );
    const credentialHash = sha256(new Uint8Array(32).fill(0x73));
    const bound = await Effect.runPromise(
      signDeviceCredentialBinding({
        genesis: f.context.genesis,
        pairingSessionId: new Uint8Array(16).fill(0x11),
        signingPublicKey: f.phone.publicKey,
        credentialHash,
        signer: f.phone.signer,
      })
    );
    const request = {
      ...offer,
      signingPublicKey: hex(f.phone.raw),
      encryptionPublicKey: hpke.epoch.pkR,
      credentialHash: hex(credentialHash),
      possessionSignature: hex(proof.possessionSignature.toBytes()),
      bindingSignature: hex(bound.toBytes()),
      protection: 'os-keystore',
    };
    const encode = (value: unknown) => hex(new TextEncoder().encode(JSON.stringify(value)));
    for (const protection of ['os-keystore', 'web-crypto'])
      expect(
        Result.isSuccess(verifyPersonalRequest(offer, encode({ ...request, protection })))
      ).toBe(true);
    for (const wrong of [
      { workspaceId: 'other' },
      { membershipId: '22'.repeat(16) },
      { genesisHash: '33'.repeat(32) },
      { encryptionPublicKey: '44'.repeat(32) },
      { signingPublicKey: hex(f.owner.raw) },
      { credentialHash: '55'.repeat(32) },
      { bindingSignature: '00'.repeat(64) },
      { possessionSignature: '00'.repeat(64) },
      { protection: 'file' },
    ])
      expect(Result.isFailure(verifyPersonalRequest(offer, encode({ ...request, ...wrong })))).toBe(
        true
      );
  });

  it('authenticates retained offer pins in the protected credential package, excluding only retry session identity', () => {
    const f = envelopeFixture(),
      hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    const binding = {
      accountId: 'account',
      workspaceId: 'workspace-A',
      genesis: f.context.genesis,
      device: f.phone.publicKey,
      installationId: '44'.repeat(32),
    };
    const offer = PersonalPairingOfferSchema.parse({
      version: 1,
      workspaceId: binding.workspaceId,
      genesisHash: hex(binding.genesis.toBytes()),
      genesisRecordHex: hex(f.genesisRecord),
      endorser: hex(f.owner.raw),
      membershipId: '0a'.repeat(16),
      pairingSessionId: '11'.repeat(16),
    });
    const credential = new Uint8Array(32).fill(0x73);
    const packet = Result.getOrThrow(credentialPacket(binding, offer, credential));
    expect(Result.getOrThrow(openCredentialPacket(binding, offer, packet))).toEqual(credential);
    expect(
      Result.getOrThrow(
        openCredentialPacket(binding, { ...offer, pairingSessionId: '55'.repeat(16) }, packet)
      )
    ).toEqual(credential);
    for (const wrong of [
      { endorser: hex(f.phone.raw) },
      { membershipId: '66'.repeat(16) },
      { workspaceId: 'other' },
    ])
      expect(Result.isFailure(openCredentialPacket(binding, { ...offer, ...wrong }, packet))).toBe(
        true
      );
    expect(
      Result.isFailure(openCredentialPacket({ ...binding, accountId: 'other' }, offer, packet))
    ).toBe(true);
    expect(
      Result.isFailure(
        openCredentialPacket({ ...binding, installationId: '77'.repeat(32) }, offer, packet)
      )
    ).toBe(true);
    expect(Result.isFailure(openCredentialPacket(binding, offer, credential))).toBe(true);
    const altered = new Uint8Array(packet);
    altered[altered.length - 1] ^= 1;
    expect(Result.isFailure(openCredentialPacket(binding, offer, altered))).toBe(true);
  });
});
