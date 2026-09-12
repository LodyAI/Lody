import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { ContentCipher, inspectContent } from '../src/content';
import { commitEpochKey, VerifiedEpochKeys, sealEpochHistory } from '../src/epoch-keys';
import { fromHex, toHex } from '../src/wire';

const genesis = '91'.repeat(32);
const secret = new Uint8Array(32).fill(15);

async function historyFixture() {
  const signing = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey)));
  const author = { actor: 'owner', memberInstance: 'owner1', device: 'desktop' };
  const cipher = new ContentCipher({
    authorize(header) {
      if (
        header.actor !== author.actor ||
        header.memberInstance !== author.memberInstance ||
        header.device !== author.device
      )
        throw new Error('unauthorized-history-author');
      return publicKey;
    },
  });
  const secrets = [0, 1, 2].map(() => crypto.getRandomValues(new Uint8Array(32)));
  const commitments = await Promise.all(secrets.map((key) => commitEpochKey(genesis, key)));
  const keys = new VerifiedEpochKeys(genesis, {
    commitment(epoch) {
      if (!commitments[epoch]) throw new Error('unpublished-epoch');
      return commitments[epoch]!;
    },
  });
  const wrap = (epoch: number, previousKey = secrets[epoch - 1]!) =>
    sealEpochHistory(cipher, {
      genesis,
      epoch,
      epochKey: secrets[epoch]!,
      previousKey,
      author,
      signingKey: signing.privateKey,
    });
  return { cipher, secrets, keys, wrap, author, signing };
}

it('recovers a three-epoch Loro history from only the newest key', async () => {
  const f = await historyFixture();
  const source = new LoroDoc();
  const target = new LoroDoc();
  try {
    const frames: Uint8Array[] = [];
    for (let epoch = 0; epoch < 3; epoch++) {
      const from = source.version();
      source.getText('text').insert(source.getText('text').length, `epoch-${epoch};`);
      source.commit();
      frames.push(
        await f.cipher.seal({
          scope: { genesis, epoch, resource: 'history-doc', purpose: 'doc-update' },
          author: f.author,
          signingKey: f.signing.privateKey,
          epochKey: f.secrets[epoch]!,
          plaintext: source.export({ mode: 'update', from }),
        })
      );
    }
    await f.keys.install(2, f.secrets[2]!);
    expect(() => f.keys.read(0)).toThrow('missing-content-key');
    await expect(f.keys.importHistory(f.cipher, 1, await f.wrap(1))).rejects.toThrow(
      'missing-content-key'
    );
    await f.keys.importHistory(f.cipher, 2, await f.wrap(2));
    await f.keys.importHistory(f.cipher, 1, await f.wrap(1));
    for (let epoch = 0; epoch < 3; epoch++) {
      const key = f.keys.read(epoch);
      try {
        const opened = await f.cipher.open(
          { genesis, epoch, resource: 'history-doc', purpose: 'doc-update' },
          key,
          frames[epoch]!
        );
        try {
          target.import(opened.plaintext);
        } finally {
          opened.plaintext.fill(0);
        }
      } finally {
        key.fill(0);
      }
    }
    expect(target.toJSON()).toEqual(source.toJSON());
    expect(target.getText('text').toString()).toBe('epoch-0;epoch-1;epoch-2;');
  } finally {
    source.free();
    target.free();
    f.keys.clear();
  }
});

it('rejects swapped, wrong-direction, forged, oversized or incorrect-key history bridges', async () => {
  const f = await historyFixture();
  try {
    await f.keys.install(2, f.secrets[2]!);
    const bridge = await f.wrap(2);
    await expect(f.cipher.open(inspectContent(bridge), f.secrets[1]!, bridge)).rejects.toThrow(
      'content-authentication-failed'
    );
    await expect(f.keys.importHistory(f.cipher, 2, await f.wrap(1))).rejects.toThrow(
      'content-context-mismatch'
    );
    await expect(f.keys.importHistory(f.cipher, 0, bridge)).rejects.toThrow('no-previous-epoch');
    await expect(f.keys.importHistory(f.cipher, 2, await f.wrap(2, f.secrets[0]!))).rejects.toThrow(
      'epoch-key-mismatch'
    );
    const tampered = bridge.slice();
    tampered[tampered.length - 1]! ^= 1;
    await expect(f.keys.importHistory(f.cipher, 2, tampered)).rejects.toThrow(
      'bad-content-signature'
    );
    await expect(f.keys.importHistory(f.cipher, 2, new Uint8Array(5000))).rejects.toThrow(
      'invalid-epoch-history'
    );
    expect(() => f.keys.read(1)).toThrow('missing-content-key');
    await f.keys.importHistory(f.cipher, 2, bridge);
    expect(f.keys.read(1)).toEqual(f.secrets[1]);
  } finally {
    f.keys.clear();
  }
});

it('never reinstalls history after clear interrupts the decryption', async () => {
  const f = await historyFixture();
  await f.keys.install(2, f.secrets[2]!);
  const bridge = await f.wrap(2);
  const importing = f.keys.importHistory(f.cipher, 2, bridge);
  f.keys.clear();
  await expect(importing).rejects.toThrow('epoch-keys-cleared');
  expect(() => f.keys.read(1)).toThrow('missing-content-key');
  expect(() => f.keys.read(2)).toThrow('missing-content-key');
});

it('uses a domain/Org-bound commitment reproducible independently of the implementation', async () => {
  const expected = createHash('sha256')
    .update('lody-epoch-secret/v1\0')
    .update(fromHex(genesis))
    .update(secret)
    .digest('hex');
  expect(await commitEpochKey(genesis, secret)).toBe(expected);
  expect(await commitEpochKey('92'.repeat(32), secret)).not.toBe(expected);
  await expect(commitEpochKey(genesis, new Uint8Array(31))).rejects.toThrow('invalid-epoch-key');
});

it('never replaces a verified key with a bad delivery and does not expose stored buffers', async () => {
  const commitment = await commitEpochKey(genesis, secret);
  const keys = new VerifiedEpochKeys(genesis, { commitment: () => commitment });
  const input = secret.slice();
  const installing = keys.install(0, input);
  input.fill(0);
  await installing;
  const read = keys.read(0);
  read.fill(0);
  expect(keys.read(0)).toEqual(secret);
  await keys.install(0, secret); // idempotent delivery/replay
  await expect(keys.install(0, new Uint8Array(32))).rejects.toThrow('epoch-key-mismatch');
  expect(keys.read(0)).toEqual(secret);
  expect(() => keys.read(1)).toThrow('missing-content-key');
  keys.clear();
  expect(() => keys.read(0)).toThrow('missing-content-key');
});

it('rechecks authority after hashing and never installs after a concurrent clear', async () => {
  const original = await commitEpochKey(genesis, secret);
  let commitment = original;
  const keys = new VerifiedEpochKeys(genesis, { commitment: () => commitment });
  const installing = keys.install(0, secret);
  commitment = '93'.repeat(32);
  await expect(installing).rejects.toThrow('epoch-authority-changed');
  commitment = original;
  expect(() => keys.read(0)).toThrow('missing-content-key');
  const afterClear = keys.install(0, secret);
  keys.clear();
  await expect(afterClear).rejects.toThrow('epoch-keys-cleared');
  expect(() => keys.read(0)).toThrow('missing-content-key');
  await keys.install(0, secret);
  expect(keys.read(0)).toEqual(secret);
  keys.clear();
});
