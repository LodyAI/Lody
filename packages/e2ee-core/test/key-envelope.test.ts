import { beforeAll, expect, it } from 'vitest';
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import {
  KeyEnvelopeCipher,
  type KeyEnvelopeContext,
  type KeyEnvelopePolicy,
} from '../src/key-envelope';
import { fromHex, toHex } from '../src/wire';

let sender: CryptoKeyPair;
let receiver: CryptoKeyPair;
let stranger: CryptoKeyPair;
let senderPublic: string;
let receiverPublic: string;
const secret = new Uint8Array(32).fill(19);
const context: KeyEnvelopeContext = {
  genesis: 'a1'.repeat(32),
  epoch: 0,
  controlHead: 'b2'.repeat(32),
  sender: { actor: 'admin', memberInstance: 'admin1', device: 'phone' },
  recipient: { kind: 'device', actor: 'member', memberInstance: 'member1', id: 'desktop' },
};
function suite() {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
}
beforeAll(async () => {
  sender = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  receiver = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  stranger = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  senderPublic = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey)));
  receiverPublic = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey)));
});
function cipher(check: (operation: 'send' | 'receive') => void = () => {}, encryptionKey?: string) {
  const policy: KeyEnvelopePolicy = {
    authorize(value, operation) {
      check(operation);
      expect(value).toEqual(context);
      return {
        senderSigningKey: senderPublic,
        recipientEncryptionKey: encryptionKey ?? receiverPublic,
      };
    },
  };
  return new KeyEnvelopeCipher(policy);
}

it('delivers only the epoch key with native nonextractable device keys and fresh encapsulation', async () => {
  expect(receiver.privateKey.extractable).toBe(false);
  const first = await cipher().seal(context, secret, sender.privateKey);
  const second = await cipher().seal(context, secret, sender.privateKey);
  expect(first).not.toEqual(second);
  expect(await cipher().open(context, receiver, first)).toEqual(secret);
  expect(await cipher().open(context, receiver, second)).toEqual(secret);
  // Independent receiver API verifies the envelope's actual suite, layout, info and AAD.
  const length = new DataView(first.buffer, first.byteOffset).getUint16(0);
  const plaintext = await suite().open(
    {
      recipientKey: receiver,
      enc: first.slice(2 + length, 34 + length),
      info: new TextEncoder().encode('lody-epoch-key-hpke/v1'),
    },
    first.slice(34 + length, -64),
    first.slice(2, 2 + length)
  );
  expect(new Uint8Array(plaintext)).toEqual(secret);
  await expect(cipher().open(context, stranger, first)).rejects.toThrow('key-recipient-mismatch');
  await expect(
    cipher().open(
      context,
      { publicKey: receiver.publicKey, privateKey: stranger.privateKey },
      first
    )
  ).rejects.toThrow('key-decryption-failed');
});

it('decrypts the CFRG Base X25519/HKDF-SHA256/ChaCha20Poly1305 vector', async () => {
  // Public test material, not credentials: https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/master/test-vectors.json
  const hpke = suite();
  const recipientKey = {
    privateKey: await hpke.kem.deserializePrivateKey(
      fromHex('8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb')
    ),
    publicKey: await hpke.kem.deserializePublicKey(
      fromHex('4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a')
    ),
  };
  const plaintext = await hpke.open(
    {
      recipientKey,
      enc: fromHex('1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a'),
      info: fromHex('4f6465206f6e2061204772656369616e2055726e'),
    },
    fromHex(
      '1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28'
    ),
    fromHex('436f756e742d30')
  );
  expect(toHex(new Uint8Array(plaintext))).toBe(
    '4265617574792069732074727574682c20747275746820626561757479'
  );
});

it('authenticates metadata inside HPKE even when a legitimate signer re-signs modified context', async () => {
  const wire = await cipher().seal(context, secret, sender.privateKey);
  const length = new DataView(wire.buffer, wire.byteOffset).getUint16(0);
  const changedHeader = JSON.parse(new TextDecoder().decode(wire.slice(2, 2 + length)));
  changedHeader[2] = '1';
  wire.set(new TextEncoder().encode(JSON.stringify(changedHeader)), 2);
  const domain = new TextEncoder().encode('lody-epoch-key-signature/v1\0');
  const signedBytes = new Uint8Array(domain.length + wire.length - 64);
  signedBytes.set(domain);
  signedBytes.set(wire.subarray(0, -64), domain.length);
  wire.set(
    new Uint8Array(await crypto.subtle.sign('Ed25519', sender.privateKey, signedBytes)),
    wire.length - 64
  );
  const permissive = new KeyEnvelopeCipher({
    authorize: () => ({ senderSigningKey: senderPublic, recipientEncryptionKey: receiverPublic }),
  });
  await expect(permissive.open({ ...context, epoch: 1 }, receiver, wire)).rejects.toThrow(
    'key-decryption-failed'
  );
});

it('binds Org, epoch, control evidence, sender and recipient member/device instance', async () => {
  const wire = await cipher().seal(context, secret, sender.privateKey);
  for (const wrong of [
    { ...context, genesis: 'c3'.repeat(32) },
    { ...context, epoch: 1 },
    { ...context, controlHead: 'd4'.repeat(32) },
    { ...context, sender: { ...context.sender, device: 'other' } },
    { ...context, recipient: { ...context.recipient, memberInstance: 'member2' } },
    { ...context, recipient: { ...context.recipient, kind: 'recovery' as const } },
  ])
    await expect(cipher().open(wrong, receiver, wire)).rejects.toThrow('key-context-mismatch');
  for (const offset of [2, wire.length - 1, wire.length - 65, wire.length - 113]) {
    const changed = wire.slice();
    changed[offset]! ^= 1;
    await expect(cipher().open(context, receiver, changed)).rejects.toThrow();
  }
  for (const invalid of [
    wire.slice(1),
    new Uint8Array(4096),
    new TextEncoder().encode('private malformed bytes'),
  ])
    await expect(cipher().open(context, receiver, invalid)).rejects.toThrow('invalid-key-envelope');
});

it('does not return usable envelopes or recovered keys if authorization is absent or revoked while awaiting crypto', async () => {
  let active = true;
  const guarded = cipher(() => {
    if (!active) throw new Error('revoked');
  });
  const sealed = await guarded.seal(context, secret, sender.privateKey);
  const pending = guarded.seal(context, secret, sender.privateKey);
  active = false;
  await expect(pending).rejects.toThrow('revoked');
  await expect(guarded.seal(context, secret, sender.privateKey)).rejects.toThrow('revoked');
  active = true;
  const opening = guarded.open(context, receiver, sealed);
  active = false;
  await expect(opening).rejects.toThrow('revoked');
});

it('rejects low-order and noncanonical recipient encryption keys before releasing secrets', async () => {
  for (const key of ['00'.repeat(32), '01' + '00'.repeat(31)])
    await expect(cipher(() => {}, key).seal(context, secret, sender.privateKey)).rejects.toThrow();
  const alias =
    receiverPublic.slice(0, 62) + (parseInt(receiverPublic.slice(62), 16) | 128).toString(16);
  for (const key of [alias, 'ed' + 'ff'.repeat(30) + '7f'])
    await expect(cipher(() => {}, key).seal(context, secret, sender.privateKey)).rejects.toThrow(
      'noncanonical-encryption-key'
    );
});

it('snapshots mutable inputs and rejects an unrelated sender signing key', async () => {
  const mutable = structuredClone(context);
  const payload = secret.slice();
  const pending = cipher().seal(mutable, payload, sender.privateKey);
  payload.fill(0);
  Object.assign(mutable.recipient, { id: 'attacker' });
  const sealed = await pending;
  expect(await cipher().open(context, receiver, sealed)).toEqual(secret);
  const other = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  await expect(cipher().seal(context, secret, other.privateKey)).rejects.toThrow(
    'bad-key-signature'
  );
  await expect(cipher().seal(context, new Uint8Array(33), sender.privateKey)).rejects.toThrow(
    'invalid-epoch-key'
  );
});
