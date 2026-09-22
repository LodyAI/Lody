import { createHpkeDriver } from '../platform/hpke';
import * as history from '../pure/epoch-history';
import { Either } from 'effect';
import * as envelope from '../pure/epoch-envelope';
import type { ValidationError } from '../pure/errors';
import { liveEntropy, type Entropy } from '../capabilities';
import {
  assertSignature,
  bytesEqual,
  checkEncryptionPublicKey,
  checkSigningPublicKey,
  checkEpoch,
  commitEpochKey,
  concat,
  type Hash,
  type SigningPointCache,
  type SigningPublicKey,
} from './crypto';
import { fail } from './error';
import type { OrgState } from './policy';

function unwrap<A>(result: Either.Either<A, ValidationError>): A {
  if (Either.isLeft(result)) fail(result.left.code, result.left.position);
  return result.right;
}

export function sealHistoryPacket(
  currentKey: Uint8Array,
  previousKey: Uint8Array,
  genesis: Hash,
  epoch: number,
  entropy: Entropy = liveEntropy
): Uint8Array {
  if (currentKey.byteLength !== 32 || previousKey.byteLength !== 32) fail('invalid-operation');
  checkEpoch(epoch, 1);
  const nonce = entropy.fill('history-packet-nonce', new Uint8Array(24));
  return unwrap(history.sealHistoryPacket({ currentKey, previousKey, genesis, epoch, nonce }));
}

export function openHistoryPacket(
  currentKey: Uint8Array,
  packet: Uint8Array,
  genesis: Hash,
  epoch: number
): Uint8Array {
  return unwrap(history.openHistoryPacket({ currentKey, packet, genesis, epoch }));
}

export async function recoverHistory(input: {
  genesis: Hash;
  latestEpoch: number;
  latestKey: Uint8Array;
  packets: ReadonlyMap<number, { commitment: Hash; packet: Uint8Array }>;
}): Promise<Map<number, Uint8Array>> {
  return unwrap(history.recoverHistory(input));
}

export function collectEpochPackets(
  records: readonly Uint8Array[],
  genesisCommitment: Hash
): Map<number, { commitment: Hash; packet: Uint8Array }> {
  return unwrap(history.collectEpochPackets(records, genesisCommitment));
}

/**
 * Any currently active device except a recovery device may distribute the
 * current epoch key (decision 2026-09-22). Key authenticity does not come from
 * the sender's role: `openEpochEnvelope` recomputes the commitment against the
 * ledger, and the recipient must be an admitted device. Recovery devices only
 * receive keys.
 */
export const canSendEpoch = envelope.canSendEpoch;

export function envelopeAad(input: {
  genesis: Hash;
  epoch: number;
  sender: SigningPublicKey;
  recipient: SigningPublicKey;
}): Uint8Array {
  return unwrap(envelope.envelopeAad(input));
}

export async function sealEpochEnvelope(input: {
  state: OrgState;
  genesis: Hash;
  epoch: number;
  sender: SigningPublicKey;
  recipient: SigningPublicKey;
  recipientEncryptionKey: Uint8Array;
  epochKey: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /** Test/lab only. Production omits this and uses live DHKEM keygen. */
  entropy?: Entropy;
  cache?: SigningPointCache;
}): Promise<Uint8Array> {
  const expectedEnc = unwrap(
    envelope.recipientEncryptionKey(input.state, input.sender, input.recipient)
  );
  checkSigningPublicKey(input.sender, input.cache);
  checkSigningPublicKey(input.recipient, input.cache);
  checkEncryptionPublicKey(input.recipientEncryptionKey);
  if (!expectedEnc || !bytesEqual(expectedEnc, input.recipientEncryptionKey)) fail('unauthorized');
  if (input.epochKey.byteLength !== 32) fail('invalid-operation');
  checkEpoch(input.epoch, 0);
  const aad = envelopeAad(input);
  const sealed = await createHpkeDriver().seal(
    input.recipientEncryptionKey,
    input.epochKey,
    aad,
    input.entropy
  );
  if (sealed.enc.byteLength !== 32 || sealed.ct.byteLength !== 48) fail('invalid-operation');
  const unsigned = concat([aad, new Uint8Array(sealed.enc), new Uint8Array(sealed.ct)]);
  const message = envelope.envelopeSigningBytes(unsigned);
  const signature = await input.sign(message);
  await assertSignature(input.sender, message, signature, 'bad-signature', input.cache);
  return concat([unsigned, signature]);
}

export async function openEpochEnvelope(input: {
  state: OrgState;
  genesis: Hash;
  epoch: number;
  sender: SigningPublicKey;
  recipient: SigningPublicKey;
  recipientKeyPair: CryptoKeyPair;
  frame: Uint8Array;
  cache?: SigningPointCache;
}): Promise<Uint8Array> {
  const expected = unwrap(
    envelope.recipientEncryptionKey(input.state, input.sender, input.recipient)
  );
  if (input.epoch !== input.state.epoch.number) fail('invalid-operation');
  checkEpoch(input.epoch, 0);
  const {
    aad,
    enc,
    ct,
    signature,
    signingBytes: message,
  } = unwrap(envelope.decodeEnvelopeFrame(input, input.frame));
  await assertSignature(input.sender, message, signature, 'bad-signature', input.cache);
  const driver = createHpkeDriver();
  const local = await driver.publicKey(input.recipientKeyPair);
  if (!expected || !bytesEqual(local, expected)) fail('unauthorized');
  let plaintext: Uint8Array;
  try {
    plaintext = await driver.open(input.recipientKeyPair, enc, ct, aad);
  } catch {
    fail('invalid-operation');
  }
  if (plaintext.byteLength !== 32) {
    plaintext.fill(0);
    fail('invalid-operation');
  }
  const commit = await commitEpochKey(input.genesis, input.epoch, plaintext);
  if (!bytesEqual(commit, input.state.epoch.keyCommitment)) {
    plaintext.fill(0);
    fail('invalid-operation');
  }
  return plaintext;
}
