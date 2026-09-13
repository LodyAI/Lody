import { getPublicKeyAsync, signAsync } from '@noble/ed25519';
import { encode } from '@ipld/dag-cbor';
import { describe, expect, it } from 'vitest';
import { Ledger, LedgerError } from '../src/ledger';
import { decodeCbor, encodeCanonical, encodeCbor, MAX_DEPTH } from '../src/ledger/cbor';
import { hashRecord, RECORD_HASH_DOMAIN } from '../src/ledger/crypto';
import {
  decodeRecord,
  encodeGenesisBody,
  encodeSignedRecord,
  possessionSigningBytes,
  signingBytesForBody,
} from '../src/ledger/schema';
import { append, ed25519, fromHex, hex, random, signGenesis, signJoin } from './ledger-fixtures';

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe(code);
}

const RFC_SECRET = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');

describe('L1 canonical vectors and rejects', () => {
  it('produces a stable genesis vector from a fixed RFC 8032 key', async () => {
    const signer = await getPublicKeyAsync(RFC_SECRET);
    const userId = new Uint8Array(32).fill(0x11);
    const membershipId = new Uint8Array(16).fill(0x22);
    const encryptionPublicKey = new Uint8Array(32).fill(0x33);
    const epochCommitment = new Uint8Array(32).fill(0x44);
    const body = encodeGenesisBody({
      signer,
      userId,
      membershipId,
      encryptionPublicKey,
      epochCommitment,
    });
    const signature = await signAsync(signingBytesForBody(body), RFC_SECRET);
    const record = encodeSignedRecord(body, signature);
    const again = encodeSignedRecord(body, signature);
    expect(hex(again)).toBe(hex(record));
    expect(hex(Uint8Array.from(encode(decodeCbor(record))))).toBe(hex(record));
    const decoded = decodeRecord(record);
    expect(hex(decoded.bodyBytes)).toBe(hex(body));
    const digest = await hashRecord(record);
    expect(hex(digest)).toBe('c4c4beea624a4e8dfc5ab3f9a47d935ca9632b62bfcd7defd8e81b20f559aaad');
    const tagged = new Uint8Array(RECORD_HASH_DOMAIN.byteLength + record.byteLength);
    tagged.set(RECORD_HASH_DOMAIN);
    tagged.set(record, RECORD_HASH_DOMAIN.byteLength);
    expect(hex(digest)).toBe(hex(new Uint8Array(await crypto.subtle.digest('SHA-256', tagged))));
    const ledger = await Ledger.verify({
      anchor: digest,
      records: [record],
    });
    expect(ledger.length).toBe(1);
    expect(hex(ledger.hashAt(0))).toBe(hex(digest));
  });

  it('rejects maps, utf8 text, and over-deep nesting', () => {
    try {
      decodeCbor(new Uint8Array([0xa1, 0x01, 0x01]));
      throw new Error('map-accepted');
    } catch (error) {
      expectCode(error, 'canonical');
    }
    try {
      decodeCbor(new Uint8Array([0x61, 0x61]));
      throw new Error('text-accepted');
    } catch (error) {
      expectCode(error, 'canonical');
    }
    let nested: unknown[] = [];
    for (let i = 0; i < MAX_DEPTH + 2; i++) nested = [nested];
    try {
      decodeCbor(encode(nested));
      throw new Error('nesting-accepted');
    } catch (error) {
      expectCode(error, 'nesting');
    }
  });

  it('rejects identity and all-zero signing keys and all-zero encryption keys', async () => {
    const identity = fromHex(`01${'00'.repeat(31)}`);
    const body = encodeCbor([
      1,
      identity,
      new Uint8Array(32).fill(1),
      new Uint8Array(16).fill(2),
      new Uint8Array(32).fill(3),
      new Uint8Array(32).fill(4),
    ]);
    const record = encodeCbor([decodeCbor(body), new Uint8Array(64).fill(9)]);
    try {
      await Ledger.verify({ anchor: await hashRecord(record), records: [record] });
      throw new Error('identity-key-accepted');
    } catch (error) {
      expectCode(error, 'invalid-key');
    }
    const owner = await ed25519();
    try {
      encodeGenesisBody({
        signer: owner.publicKey,
        userId: random(32),
        membershipId: random(16),
        encryptionPublicKey: new Uint8Array(32),
        epochCommitment: random(32),
      });
      throw new Error('zero-enc-accepted');
    } catch (error) {
      expectCode(error, 'invalid-key');
    }
    const created = await signGenesis(owner);
    expect(created.ledger.length).toBe(1);
    try {
      await Ledger.verify({ anchor: await hashRecord(record), records: [record] });
      throw new Error('identity-key-accepted-after-cache');
    } catch (error) {
      expectCode(error, 'invalid-key');
    }
  });

  it('rejects a join proof bound to another org and a tampered nested proof under a valid outer signature', async () => {
    const owner = await ed25519();
    const member = await ed25519();
    const a = await signGenesis(owner);
    const b = await signGenesis(owner);
    const joinA = await signJoin(a.anchor, member);
    try {
      await append(b.ledger, owner, {
        type: 'admitMember',
        membershipId: random(16),
        request: joinA,
      });
      throw new Error('cross-org-join');
    } catch (error) {
      expectCode(error, 'bad-proof');
    }

    const join = await signJoin(a.anchor, member);
    const tampered = {
      ...join,
      signature: Uint8Array.from(join.signature, (byte, index) =>
        index === 0 ? byte ^ 0xff : byte
      ),
    };
    try {
      await append(a.ledger, owner, {
        type: 'admitMember',
        membershipId: random(16),
        request: tampered,
      });
      throw new Error('tampered-proof');
    } catch (error) {
      expectCode(error, 'bad-proof');
    }
    expect(a.ledger.state.members.size).toBe(1);
  });

  it('keeps sliced body bytes equal to a canonical re-encode and does not alias record hashes', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const records = [created.record];
    let ledger = created.ledger;
    const join = await signJoin(created.anchor, await ed25519());
    const admitted = await append(ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: join,
    });
    records.push(admitted.record);
    ledger = admitted.ledger;
    const rotated = await append(ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await hashRecord(random(32)),
      previousEpochKey: random(72),
    });
    records.push(rotated.record);
    ledger = rotated.ledger;
    for (const record of records) {
      const decoded = decodeRecord(record);
      const root = decodeCbor(record);
      if (!Array.isArray(root) || root.length !== 2) throw new Error('bad-root');
      expect(hex(decoded.bodyBytes)).toBe(hex(encodeCanonical(root[0]!)));
    }
    const again = await Ledger.verify({ anchor: created.anchor, records });
    expect(again.length).toBe(3);
    expect(hex(again.hashAt(0))).toBe(hex(created.anchor));
    expect(hex(again.hashAt(1))).not.toBe(hex(again.hashAt(0)));
    expect(hex(again.hashAt(2))).not.toBe(hex(again.hashAt(1)));
    expect(hex(again.hashAt(0))).toBe(hex(ledger.hashAt(0)));
    expect(hex(again.hashAt(2))).toBe(hex(ledger.head));
    const view = again.state;
    const members = view.members.size;
    (view.members as Map<string, { userId: Uint8Array; role: string }>).clear();
    expect(again.state.members.size).toBe(members);
  });

  it('rejects a possession signature reused as a join proof', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const applicant = await ed25519();
    const possession = await applicant.sign(
      possessionSigningBytes({
        genesis: created.anchor,
        signingPublicKey: applicant.publicKey,
        encryptionPublicKey: applicant.enc,
        kind: 'personal',
        canManage: false,
      })
    );
    const request = {
      requestId: random(16),
      userId: random(32),
      signingPublicKey: applicant.publicKey,
      encryptionPublicKey: applicant.enc,
      expiresAt: null,
      signature: possession,
    };
    try {
      await append(created.ledger, owner, {
        type: 'admitMember',
        membershipId: random(16),
        request,
      });
      throw new Error('domain-reuse');
    } catch (error) {
      expectCode(error, 'bad-proof');
    }
  });
});
