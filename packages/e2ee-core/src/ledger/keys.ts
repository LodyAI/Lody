import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { encodeCbor } from './cbor';
import {
  HISTORY_AEAD_DOMAIN,
  HISTORY_PACKET_BYTES,
  assertSignature,
  bytesEqual,
  checkEncryptionPublicKey,
  checkHash,
  checkSigningPublicKey,
  commitEpochKey,
  concat,
  keyId,
  type Hash,
  type SigningPublicKey,
} from './crypto';
import { fail } from './error';
import { decodeRecord } from './schema';
import type { OrgState } from './policy';

const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});
const hpkeInfo = new TextEncoder().encode('lody-e2ee/hpke-epoch/v1\0');
const envelopeSigDomain = new TextEncoder().encode('lody-e2ee/epoch-env/v1\0');

function historyAad(genesis: Hash, epoch: number): Uint8Array {
  const epochBytes = new Uint8Array(4);
  new DataView(epochBytes.buffer).setUint32(0, epoch);
  return concat([HISTORY_AEAD_DOMAIN, genesis, epochBytes]);
}

export function sealHistoryPacket(
  currentKey: Uint8Array,
  previousKey: Uint8Array,
  genesis: Hash,
  epoch: number
): Uint8Array {
  if (currentKey.byteLength !== 32 || previousKey.byteLength !== 32) fail('invalid-operation');
  if (!Number.isSafeInteger(epoch) || epoch < 1) fail('invalid-operation');
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = xchacha20poly1305(
    Uint8Array.from(currentKey),
    nonce,
    historyAad(genesis, epoch)
  ).encrypt(Uint8Array.from(previousKey));
  if (sealed.byteLength !== 32 + TAG_BYTES) fail('invalid-operation');
  const packet = new Uint8Array(HISTORY_PACKET_BYTES);
  packet.set(nonce, 0);
  packet.set(sealed, NONCE_BYTES);
  return packet;
}

export function openHistoryPacket(
  currentKey: Uint8Array,
  packet: Uint8Array,
  genesis: Hash,
  epoch: number
): Uint8Array {
  if (currentKey.byteLength !== 32 || packet.byteLength !== HISTORY_PACKET_BYTES) {
    fail('invalid-operation');
  }
  if (!Number.isSafeInteger(epoch) || epoch < 1) fail('invalid-operation');
  try {
    return xchacha20poly1305(
      Uint8Array.from(currentKey),
      packet.subarray(0, NONCE_BYTES),
      historyAad(genesis, epoch)
    ).decrypt(packet.subarray(NONCE_BYTES));
  } catch {
    fail('invalid-operation');
  }
}

export async function recoverHistory(input: {
  genesis: Hash;
  latestEpoch: number;
  latestKey: Uint8Array;
  packets: ReadonlyMap<number, { commitment: Hash; packet: Uint8Array }>;
}): Promise<Map<number, Uint8Array>> {
  const keys = new Map<number, Uint8Array>();
  const expectedLatest = input.packets.get(input.latestEpoch);
  if (input.latestEpoch === 0) {
    const row = input.packets.get(0);
    if (!row) fail('invalid-operation');
    const commit = await commitEpochKey(input.genesis, 0, input.latestKey);
    if (!bytesEqual(commit, row.commitment)) fail('invalid-operation');
    keys.set(0, Uint8Array.from(input.latestKey));
    return keys;
  }
  if (!expectedLatest) fail('invalid-operation');
  const latestCommit = await commitEpochKey(input.genesis, input.latestEpoch, input.latestKey);
  if (!bytesEqual(latestCommit, expectedLatest.commitment)) fail('invalid-operation');
  keys.set(input.latestEpoch, Uint8Array.from(input.latestKey));
  let current = Uint8Array.from(input.latestKey);
  for (let epoch = input.latestEpoch; epoch >= 1; epoch--) {
    const row = input.packets.get(epoch);
    if (!row) fail('invalid-operation');
    const previous = openHistoryPacket(current, row.packet, input.genesis, epoch);
    const commit = await commitEpochKey(input.genesis, epoch - 1, previous);
    if (epoch - 1 === 0) {
      const genesisRow = input.packets.get(0);
      if (!genesisRow || !bytesEqual(commit, genesisRow.commitment)) fail('invalid-operation');
      keys.set(0, previous);
      break;
    }
    const prevRow = input.packets.get(epoch - 1);
    if (!prevRow || !bytesEqual(commit, prevRow.commitment)) fail('invalid-operation');
    keys.set(epoch - 1, previous);
    current = Uint8Array.from(previous);
  }
  return keys;
}

export function collectEpochPackets(
  records: readonly Uint8Array[],
  genesisCommitment: Hash
): Map<number, { commitment: Hash; packet: Uint8Array }> {
  const packets = new Map<number, { commitment: Hash; packet: Uint8Array }>();
  packets.set(0, { commitment: checkHash(genesisCommitment), packet: new Uint8Array() });
  for (const record of records) {
    const decoded = decodeRecord(record);
    if (decoded.body.type !== 'ordinary') continue;
    const op = decoded.body.fields.operation;
    if (op.type !== 'publishEpoch') continue;
    packets.set(op.epoch, { commitment: op.commitment, packet: op.previousEpochKey });
  }
  return packets;
}

function canSendEpoch(state: OrgState, sender: SigningPublicKey): boolean {
  const device = state.devices.get(keyId(sender));
  if (!device || device.kind !== 'personal' || !device.canManage) return false;
  const member = state.members.get(keyId(device.membershipId));
  return member?.role === 'owner' || member?.role === 'admin';
}

function canReceiveEpoch(state: OrgState, recipient: SigningPublicKey): boolean {
  return state.devices.has(keyId(recipient));
}

export function envelopeAad(input: {
  genesis: Hash;
  epoch: number;
  sender: SigningPublicKey;
  recipient: SigningPublicKey;
}): Uint8Array {
  return encodeCbor([input.genesis, input.epoch, input.sender, input.recipient]);
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
}): Promise<Uint8Array> {
  if (!canSendEpoch(input.state, input.sender)) fail('unauthorized');
  if (!canReceiveEpoch(input.state, input.recipient)) fail('unauthorized');
  checkSigningPublicKey(input.sender);
  checkSigningPublicKey(input.recipient);
  checkEncryptionPublicKey(input.recipientEncryptionKey);
  const expectedEnc = input.state.devices.get(keyId(input.recipient))?.encryptionPublicKey;
  if (!expectedEnc || !bytesEqual(expectedEnc, input.recipientEncryptionKey)) fail('unauthorized');
  if (input.epochKey.byteLength !== 32) fail('invalid-operation');
  const aad = envelopeAad(input);
  const recipientPublicKey = await suite.kem.deserializePublicKey(input.recipientEncryptionKey);
  const sealed = await suite.seal({ recipientPublicKey, info: hpkeInfo }, input.epochKey, aad);
  if (sealed.enc.byteLength !== 32 || sealed.ct.byteLength !== 48) fail('invalid-operation');
  const unsigned = concat([aad, new Uint8Array(sealed.enc), new Uint8Array(sealed.ct)]);
  const message = concat([envelopeSigDomain, unsigned]);
  const signature = await input.sign(message);
  await assertSignature(input.sender, message, signature);
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
  if (!canReceiveEpoch(input.state, input.recipient)) fail('unauthorized');
  if (input.epoch !== input.state.epoch.number) fail('invalid-operation');
  const aad = envelopeAad(input);
  if (input.frame.byteLength !== aad.byteLength + 32 + 48 + 64) fail('canonical');
  const enc = input.frame.subarray(aad.byteLength, aad.byteLength + 32);
  const ct = input.frame.subarray(aad.byteLength + 32, aad.byteLength + 80);
  const signature = input.frame.subarray(aad.byteLength + 80);
  if (!bytesEqual(input.frame.subarray(0, aad.byteLength), aad)) fail('canonical');
  const message = concat([envelopeSigDomain, input.frame.subarray(0, -64)]);
  await assertSignature(input.sender, message, signature);
  const local = new Uint8Array(
    await suite.kem.serializePublicKey(input.recipientKeyPair.publicKey)
  );
  const expected = input.state.devices.get(keyId(input.recipient))?.encryptionPublicKey;
  if (!expected || !bytesEqual(local, expected)) fail('unauthorized');
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await suite.open({ recipientKey: input.recipientKeyPair, enc, info: hpkeInfo }, ct, aad)
    );
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
