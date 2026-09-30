import { createHpkeDriver } from '../platform/hpke';
import * as history from '../pure/epoch-history';
import { Either } from 'effect';
import { unwrap } from './compat';
import * as envelope from '../pure/epoch-envelope';
import { parseEpochEnvelopeChunk } from '../pure/epoch-envelope-stream';
import { decodeCbor } from '../pure/cbor';
import { ValidationError as ValidationErrorClass } from '../pure/errors';
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
  type SigningPublicKey,
} from './crypto';
import { fail } from './error';
import type { OrgState } from '../pure/ledger-state';
import type { Ledger } from './ledger';

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

/** Historical keys from a verified ledger: packets, genesis and epoch come from `ledger`. */
export async function recoverLedgerHistory(
  ledger: Ledger,
  latestKey: Uint8Array
): Promise<Map<number, Uint8Array>> {
  return unwrap(
    history.recoverHistory({
      genesis: ledger.state.genesis,
      latestEpoch: ledger.state.epoch.number,
      latestKey,
      packets: ledger.historyPackets(),
    })
  );
}

/** Low-level: `packets` must come from a verified ledger; prefer `recoverLedgerHistory`. */
export async function recoverHistory(input: {
  genesis: Hash;
  latestEpoch: number;
  latestKey: Uint8Array;
  packets: ReadonlyMap<number, { commitment: Hash; packet: Uint8Array }>;
}): Promise<Map<number, Uint8Array>> {
  return unwrap(history.recoverHistory(input));
}

/** Structural only, no signature or policy check; never pass unverified stream bytes. */
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

/**
 * Gateway admission for one raw key-stream append. The body must be exactly one
 * envelope for this Org's current epoch, naming the authenticated `sender` and an
 * admitted recipient, and signed by that sender. Readers fail closed on stray bytes
 * and first-writer-wins per delivery slot, so a host must never append anything else.
 * This does not decrypt or prove that the key matches the epoch commitment.
 */
export function assertEpochStreamAppend(
  state: OrgState,
  sender: SigningPublicKey,
  body: Uint8Array
): void {
  const parsed = unwrap(parseEpochEnvelopeChunk(new Uint8Array(), body));
  const frame = parsed.frames[0];
  if (parsed.frames.length !== 1 || parsed.tail.length !== 0 || !frame) fail('canonical');
  const recipient = unwrap(envelopeRecipient(frame.bytes));
  unwrap(envelope.recipientEncryptionKey(state, sender, recipient));
  const parts = unwrap(
    envelope.decodeEnvelopeFrame(
      { genesis: state.genesis, epoch: state.epoch.number, sender, recipient },
      frame.bytes
    )
  );
  assertSignature(sender, parts.signingBytes, parts.signature);
}

function envelopeRecipient(frame: Uint8Array) {
  return Either.flatMap(decodeCbor(frame.subarray(0, frame.byteLength - 144)), (aad) =>
    Array.isArray(aad) && aad.length === 4 && aad[3] instanceof Uint8Array
      ? Either.right(aad[3])
      : Either.left(new ValidationErrorClass({ code: 'canonical' }))
  );
}

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
}): Promise<Uint8Array> {
  const expectedEnc = unwrap(
    envelope.recipientEncryptionKey(input.state, input.sender, input.recipient)
  );
  checkSigningPublicKey(input.sender);
  checkSigningPublicKey(input.recipient);
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
  assertSignature(input.sender, message, signature);
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
  assertSignature(input.sender, message, signature);
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
