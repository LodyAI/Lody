import { Effect, Either } from 'effect';
import { verifyRecordSignature } from '../src/workflows/verification';
import type { PreparedEpochEnvelope } from '@lody/e2ee-core/effect';
import { describe, expect, it } from 'vitest';
import { Point } from '@noble/ed25519';
import * as Bytes from '../src/pure/bytes';
import * as Cbor from '../src/pure/cbor';
import { SigningFacts } from '../src/pure/signing-facts';
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

it('reuses immutable point-validity evidence without accepting modified or low-order keys', () => {
  const bytes = Point.BASE.toBytes();
  const first = SigningFacts.empty.check(bytes);
  if (Either.isLeft(first)) throw new Error('base point fixture must be valid');
  expect(SigningFacts.empty.size).toBe(0);
  expect(first.right.facts.size).toBe(1);
  bytes.fill(0);
  first.right.key.toBytes().fill(0);
  const second = first.right.facts.check(Point.BASE.toBytes());
  if (Either.isLeft(second)) throw new Error('previously checked point must remain valid');
  expect(second.right.facts).toBe(first.right.facts);
  expect(second.right.key.toBytes()).toEqual(Point.BASE.toBytes());
  expect(first.right.facts.check(bytes)).toMatchObject({ _tag: 'Left' });
  expect(first.right.facts.check(Point.ZERO.toBytes())).toMatchObject({ _tag: 'Left' });
  expect(first.right.facts.size).toBe(1);
});

// Compiled, never invoked: meaningful negative contracts for ordinary consumers.
function typeContracts(
  sign: Bytes.SigningPublicKey,
  enc: Bytes.EncryptionPublicKey,
  sig: Bytes.Signature,
  hash: Bytes.RecordHash,
  request: Bytes.RequestId
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
  // @ts-expect-error Equal byte length does not make a record hash an epoch commitment.
  const wrongCommitment: Bytes.EpochCommitment = hash;
  // @ts-expect-error A public commitment cannot be substituted for an epoch secret.
  const wrongEpochKey: Bytes.EpochKey = wrongCommitment;
  // @ts-expect-error Secret key material is not exported by the public key value.
  wrongEpochKey.toBytes();
  // @ts-expect-error A join request ID cannot be used as an outbox delivery ID.
  const wrongDelivery: Bytes.DeliveryId = request;
  return { wrongHash, wrongGenesis, wrongCommitment, wrongEpochKey, wrongDelivery };
}
void typeContracts;

function stageContracts(decoded: DecodedRecord, signed: SignatureCheckedRecord) {
  // @ts-expect-error Cryptographic execution requires an explicitly supplied verifier Service.
  void Effect.runPromise(verifyRecordSignature(decoded));
  // @ts-expect-error Decoding is not signature verification.
  const wrongSignature: SignatureCheckedRecord = decoded;
  // @ts-expect-error Signature verification is not authorization at a ledger view.
  const wrongAuthority: ApplicableRecord = signed;
  // @ts-expect-error Management is role-derived; no device grant carries a management flag.
  const personal: DeviceGrant = { kind: 'personal', canManage: true };
  // @ts-expect-error Device kinds are closed; there is no managing device kind.
  const manager: DeviceGrant = { kind: 'manager' };
  return { wrongSignature, wrongAuthority, personal, manager };
}
void stageContracts;

function viewContracts(
  genesis: Bytes.GenesisHash,
  epoch: Bytes.EpochNumber,
  signer: Bytes.SigningPublicKey
) {
  // @ts-expect-error Metadata and a byte-export callback cannot forge a prepared envelope.
  const forgedEnvelope: PreparedEpochEnvelope = {
    stage: 'Prepared',
    genesis,
    epoch,
    sender: signer,
    recipient: signer,
    toBytes: () => new Uint8Array(),
  };
  // @ts-expect-error A flag and structural fields cannot mint a verified view.
  const forged: LedgerView = { verified: true, length: 1 };
  // @ts-expect-error A callback and a size cannot fabricate private key-validity evidence.
  const forgedFacts: SigningFacts = { size: 1, check: SigningFacts.empty.check };
  return { forged, forgedFacts, forgedEnvelope };
}
void viewContracts;
