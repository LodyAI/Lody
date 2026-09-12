import { expect, test } from 'vitest';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { createUserIdentity, restoreUserIdentity } from '../src/user-identity';
import {
  createRecoveryFile,
  parseRecoveryFile,
  sealRecoveryBackup,
  openRecoveryBackup,
} from '../src/recovery-file';

const context = { identity: '12'.repeat(32), revision: 1 };
const material = new Uint8Array([1, 3, 5, 7]);

test('a file restores a real user identity with non-extractable signing and encryption handles', async () => {
  const created = await createUserIdentity();
  const file = createRecoveryFile();
  const expected = { identity: created.identity.fingerprint, revision: 0 };
  const frame = sealRecoveryBackup(file, expected, created.privateMaterial);
  created.privateMaterial.fill(0);
  const recovered = openRecoveryBackup(file, expected, frame);
  try {
    const restored = await restoreUserIdentity(recovered, expected.identity);
    expect(restored.fingerprint).toBe(created.identity.fingerprint);
    for (const pair of [restored.signing, restored.encryption]) {
      expect(pair.privateKey.extractable).toBe(false);
      await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();
    }
    const message = new TextEncoder().encode('synthetic recovered identity');
    const signature = await crypto.subtle.sign('Ed25519', restored.signing.privateKey, message);
    expect(
      await crypto.subtle.verify('Ed25519', created.identity.signing.publicKey, signature, message)
    ).toBe(true);
    const other = await createUserIdentity();
    const left = await crypto.subtle.deriveBits(
      { name: 'X25519', public: other.identity.encryption.publicKey },
      restored.encryption.privateKey,
      256
    );
    const right = await crypto.subtle.deriveBits(
      { name: 'X25519', public: restored.encryption.publicKey },
      other.identity.encryption.privateKey,
      256
    );
    expect(new Uint8Array(left)).toEqual(new Uint8Array(right));
    other.privateMaterial.fill(0);
  } finally {
    recovered.fill(0);
  }
});

test('authenticated backup bytes with mismatched private keys are still rejected', async () => {
  const first = await createUserIdentity();
  const other = await createUserIdentity();
  const original = JSON.parse(new TextDecoder().decode(first.privateMaterial));
  const donor = JSON.parse(new TextDecoder().decode(other.privateMaterial));
  const file = createRecoveryFile();
  const expected = { identity: first.identity.fingerprint, revision: 0 };
  for (const slot of [2, 4]) {
    const fields = [...original];
    fields[slot] = donor[slot];
    const frame = sealRecoveryBackup(
      file,
      expected,
      new TextEncoder().encode(JSON.stringify(fields))
    );
    const recovered = openRecoveryBackup(file, expected, frame);
    await expect(restoreUserIdentity(recovered, expected.identity)).rejects.toThrow(
      'user-key-pair-mismatch'
    );
    recovered.fill(0);
  }
  await expect(
    restoreUserIdentity(first.privateMaterial, other.identity.fingerprint)
  ).rejects.toThrow('user-identity-mismatch');
  const fields = [...original];
  fields[0] = 'lody-device-identity/v1';
  await expect(
    restoreUserIdentity(new TextEncoder().encode(JSON.stringify(fields)), expected.identity)
  ).rejects.toThrow('invalid-user-identity');
  first.privateMaterial.fill(0);
  other.privateMaterial.fill(0);
});

test('restore captures caller bytes before asynchronous crypto and never accepts malformed secret text', async () => {
  const created = await createUserIdentity();
  const pending = restoreUserIdentity(created.privateMaterial, created.identity.fingerprint);
  created.privateMaterial.fill(0);
  expect((await pending).fingerprint).toBe(created.identity.fingerprint);
  for (const bytes of [
    new Uint8Array([0xff]),
    new Uint8Array(2049),
    new TextEncoder().encode('["private-secret'),
  ]) {
    await expect(restoreUserIdentity(bytes, created.identity.fingerprint)).rejects.toThrow(
      'invalid-user-identity'
    );
  }
});

test('random file wraps offline material and interoperates with the fixed cipher', () => {
  const file = createRecoveryFile();
  const original = new Uint8Array(file);
  const frame = sealRecoveryBackup(file, context, material);
  const second = sealRecoveryBackup(file, context, material);
  expect(second).not.toEqual(frame);
  expect(openRecoveryBackup(file, context, frame)).toEqual(material);
  const { key } = parseRecoveryFile(file);
  const size = new DataView(frame.buffer).getUint16(0);
  expect(
    xchacha20poly1305(
      key,
      frame.subarray(2 + size, 26 + size),
      frame.subarray(2, 2 + size)
    ).decrypt(frame.subarray(26 + size))
  ).toEqual(material);
  key.fill(0);
  expect(file).toEqual(original);
  expect(material).toEqual(new Uint8Array([1, 3, 5, 7]));
  const padded = new Uint8Array(frame.length + 11);
  padded.set(frame, 7);
  expect(openRecoveryBackup(file, context, padded.subarray(7, 7 + frame.length))).toEqual(material);
});

test('wrong file, identity, revision, nonce or ciphertext releases no material', () => {
  const file = createRecoveryFile();
  const frame = sealRecoveryBackup(file, context, material);
  expect(() => openRecoveryBackup(createRecoveryFile(), context, frame)).toThrow();
  for (const changed of [
    { ...context, identity: '34'.repeat(32) },
    { ...context, revision: 2 },
  ]) {
    expect(() => openRecoveryBackup(file, changed, frame)).toThrow('recovery-context-mismatch');
  }
  const fields = JSON.parse(new TextDecoder().decode(file));
  fields[2] = '00'.repeat(32);
  expect(() =>
    openRecoveryBackup(new TextEncoder().encode(JSON.stringify(fields)), context, frame)
  ).toThrow('recovery-authentication-failed');
  const header = new DataView(frame.buffer).getUint16(0);
  for (const offset of [2 + header, frame.length - 1]) {
    const corrupted = new Uint8Array(frame);
    corrupted[offset] = corrupted[offset]! ^ 1;
    expect(() => openRecoveryBackup(file, context, corrupted)).toThrow(
      'recovery-authentication-failed'
    );
  }
});

test('strict file parsing rejects executable metadata, aliases, malformed and oversized input', () => {
  const file = createRecoveryFile();
  const text = new TextDecoder().decode(file);
  for (const malformed of [
    '',
    '{"url":"https://example.invalid/"}',
    ` ${text}`,
    `${text}\n`,
    text.replace('/v1', '/v2'),
    text.slice(0, -1),
    '["private secret"',
    'x'.repeat(257),
  ]) {
    expect(() => parseRecoveryFile(new TextEncoder().encode(malformed))).toThrow();
  }
  expect(() => parseRecoveryFile(new Uint8Array([0xff]))).toThrow('invalid-recovery-file');
  expect(() => parseRecoveryFile(new Uint8Array([0xef, 0xbb, 0xbf, ...file]))).toThrow();
});

test('material limits and truncated backup frames fail without changing caller inputs', () => {
  const file = createRecoveryFile();
  for (const size of [0, 2049])
    expect(() => sealRecoveryBackup(file, context, new Uint8Array(size))).toThrow();
  const largest = new Uint8Array(2048).fill(5);
  const frame = sealRecoveryBackup(file, context, largest);
  expect(openRecoveryBackup(file, context, frame)).toEqual(largest);
  for (const length of [0, 1, 20, frame.length - 1]) {
    expect(() => openRecoveryBackup(file, context, frame.subarray(0, length))).toThrow();
  }
  expect(() => openRecoveryBackup(file, context, new Uint8Array(3000))).toThrow();
  for (const revision of [-1, NaN, Infinity, 0.5]) {
    expect(() => sealRecoveryBackup(file, { ...context, revision }, material)).toThrow(
      'invalid-recovery-revision'
    );
  }
});
