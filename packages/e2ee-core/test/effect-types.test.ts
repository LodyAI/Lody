import { Either } from 'effect';
import { describe, expect, it } from 'vitest';
import { Point } from '@noble/ed25519';
import * as Bytes from '../src/pure/bytes';
import * as Cbor from '../src/pure/cbor';
import type { DeviceGrant } from '../src/pure/commands';
import type {
  DecodedRecord,
  SignatureCheckedRecord,
  ApplicableRecord,
  LedgerView,
} from '../src/pure/records';

describe('validated opaque bytes', () => {
  it('owns input/output bytes and rejects wrong lengths and signing points', () => {
    const input = Point.BASE.toBytes();
    const parsed = Bytes.signingPublicKey(input);
    expect(Either.isRight(parsed)).toBe(true);
    if (Either.isLeft(parsed)) return;
    input.fill(0);
    const exported = parsed.right.toBytes();
    exported.fill(0);
    expect(parsed.right.toBytes()).toEqual(Point.BASE.toBytes());
    expect(Either.isLeft(Bytes.signingPublicKey(input))).toBe(true);
    expect(Either.isLeft(Bytes.signature(new Uint8Array(32)))).toBe(true);
    expect(Either.isLeft(Bytes.encryptionPublicKey(new Uint8Array(32)))).toBe(true);
  });

  it('returns errors instead of throwing for untrusted bytes and epoch bounds', () => {
    for (const invalid of [null, undefined, {}, 1, 'key', new Uint8Array(33)]) {
      expect(Either.isLeft(Bytes.signingPublicKey(invalid))).toBe(true);
      expect(Either.isLeft(Bytes.membershipId(invalid))).toBe(true);
    }
    for (const invalid of [-1, 1.5, NaN, Infinity, 0x1_0000_0000, '0']) {
      expect(Either.isLeft(Bytes.epochNumber(invalid))).toBe(true);
    }
    expect(Either.isRight(Bytes.epochNumber(0xffff_ffff))).toBe(true);
  });
});

describe('total CBOR boundary', () => {
  it('rejects noncanonical/untrusted input through Either', () => {
    for (const input of [
      null,
      {},
      new Uint8Array(),
      Uint8Array.of(0x18, 0),
      Uint8Array.of(1, 2),
      Uint8Array.of(0xa0),
      Uint8Array.of(0x61, 0x61),
    ]) {
      expect(Either.isLeft(Cbor.decodeCbor(input))).toBe(true);
    }
    const value = [0, true, null, Uint8Array.of(1, 2)] as const;
    const encoded = Cbor.encodeCbor(value);
    expect(Either.isRight(encoded)).toBe(true);
    if (Either.isLeft(encoded)) return;
    const decoded = Cbor.decodeCbor(encoded.right);
    encoded.right.fill(0);
    expect(decoded).toEqual(Either.right(value));
  });
});

// Compiled, never invoked: meaningful negative contracts for ordinary consumers.
function typeContracts(
  sign: Bytes.SigningPublicKey,
  enc: Bytes.EncryptionPublicKey,
  sig: Bytes.Signature,
  hash: Bytes.RecordHash
) {
  const acceptsSigning = (_key: Bytes.SigningPublicKey) => {};
  acceptsSigning(sign);
  // @ts-expect-error Encryption and signing keys are distinct even at 32 bytes.
  acceptsSigning(enc);
  // @ts-expect-error Raw bytes are not validated keys.
  acceptsSigning(new Uint8Array(32));
  // @ts-expect-error Signatures are not hashes.
  const wrongHash: Bytes.RecordHash = sig;
  // @ts-expect-error A record hash is not a trusted genesis input.
  const wrongGenesis: Bytes.GenesisHash = hash;
  return { wrongHash, wrongGenesis };
}
void typeContracts;

function stageContracts(decoded: DecodedRecord, signed: SignatureCheckedRecord) {
  // @ts-expect-error Decoding is not signature verification.
  const wrongSignature: SignatureCheckedRecord = decoded;
  // @ts-expect-error Signature verification is not authorization at a ledger view.
  const wrongAuthority: ApplicableRecord = signed;
  // @ts-expect-error Machines cannot be given an Org-management flag.
  const machine: DeviceGrant = { kind: 'machine', canManage: true };
  // @ts-expect-error Recovery devices cannot be given an Org-management flag.
  const recovery: DeviceGrant = { kind: 'recovery', canManage: true };
  return { wrongSignature, wrongAuthority, machine, recovery };
}
void stageContracts;

function viewContracts() {
  // @ts-expect-error A flag and structural fields cannot mint a verified view.
  const forged: LedgerView = { verified: true, length: 1 };
  return forged;
}
void viewContracts;
