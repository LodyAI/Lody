import { streamsContentAdditionalData } from '../src/streams-content';
/**
 * Snapshot admission retry/offset semantics with real
 * Ed25519, HKDF, XChaCha20-Poly1305 and the real streams-content provider.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PayloadProtectionContext } from '@loro-dev/streams-crdt/loro';
import { ContentCipher, type ContentAuthor } from '../src/content';
import {
  CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS,
  createContentSnapshotPublication,
} from '../src/snapshot-admission';
import { createStreamsContentProvider } from '../src/streams-content';
import { toHex } from '../src/wire';

const genesis = 'ab'.repeat(32);
const resource = 'doc-1';
const epochKey = new Uint8Array(32).fill(7);
const pairs = new Map<string, { pair: CryptoKeyPair; publicKey: string }>();

beforeAll(async () => {
  for (const device of ['writer', 'other', 'guest']) {
    const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    pairs.set(device, { pair, publicKey });
  }
});

function policy() {
  return {
    authorize(header: { device: string }) {
      const known = Array.from(pairs.values()).find((row) => row.publicKey === header.device);
      if (!known) throw new Error('unauthorized');
      return known.publicKey;
    },
  };
}

function author(device: string): ContentAuthor {
  return {
    actor: device.toUpperCase(),
    memberInstance: `${device}-m`,
    device: pairs.get(device)!.publicKey,
  };
}

async function seal(
  device: string,
  kind: 'snapshot' | 'update_batch',
  offset: string,
  plaintext: string
) {
  const provider = createStreamsContentProvider({
    cipher: new ContentCipher(policy()),
    genesis,
    resource,
    model: 'loro',
    writeEpoch: 0,
    author: author(device),
    signingKey: pairs.get(device)!.pair.privateKey,
    readKey: () => epochKey,
    mayWriteDocument: () => true,
  });
  const context =
    kind === 'snapshot'
      ? {
          protocol: 'loro-streams-crdt-payload-protection',
          version: 2,
          kind,
          continuationOffset: offset,
        }
      : { protocol: 'loro-streams-crdt-payload-protection', version: 2, kind };
  const sealed = await provider.seal({
    plaintext: new TextEncoder().encode(plaintext),
    context: context as PayloadProtectionContext,
    additionalData: (header) => {
      const prefix = new Uint8Array([
        0x4c,
        0x53,
        0x43,
        0x45,
        2,
        kind === 'snapshot' ? 2 : 1,
        0,
        1,
        0,
        0,
        header[0]!,
      ]);
      return streamsContentAdditionalData(prefix);
    },
  });
  // Always use the snapshot LSCE kind byte so only the inner purpose differs.
  const prefix = new Uint8Array(10 + sealed.header.byteLength);
  prefix.set([0x4c, 0x53, 0x43, 0x45, 2, 2]);
  new DataView(prefix.buffer).setUint16(6, sealed.header.byteLength);
  prefix.set(sealed.header, 10);
  prefix[10] = 4;
  const body = new Uint8Array(prefix.byteLength + sealed.sealed.byteLength);
  body.set(prefix);
  body.set(sealed.sealed, prefix.byteLength);
  return body;
}

function host(writable: Set<string>, clock: { now: number }) {
  return createContentSnapshotPublication({
    cipher: new ContentCipher(policy()),
    mayWriteDocument: (who) =>
      Array.from(writable).some((id) => pairs.get(id)?.publicKey === who.device),
    now: () => clock.now,
  });
}

function put(
  offset: string,
  body: Uint8Array,
  device: string,
  lease: { issued: number; expires: number }
) {
  return {
    streamKey: 'g/loro',
    offset,
    body,
    submittingDevice: pairs.get(device)!.publicKey,
    leaseIssuedAt: lease.issued,
    leaseExpiresAt: lease.expires,
    expectedGenesis: genesis,
    expectedResource: resource,
    expectedPurpose: 'doc-snapshot' as const,
  };
}

describe('snapshot admission exact retries', () => {
  it('lets only the signing device retry an admitted snapshot', async () => {
    const clock = { now: 1_000 };
    const writable = new Set(['writer']);
    const publication = host(writable, clock);
    const fresh = { issued: 1_000, expires: 1_000 + CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS };
    const s10 = await seal('writer', 'snapshot', '10', 'ten');
    const s20 = await seal('writer', 'snapshot', '20', 'twenty');
    expect((await publication.admit(put('10', s10, 'writer', fresh))).status).toBe('accepted');
    expect((await publication.admit(put('20', s20, 'writer', fresh))).status).toBe('accepted');

    // Identical bytes are not a credential for another submitter.
    await expect(publication.admit(put('10', s10, 'guest', fresh))).rejects.toMatchObject({
      message: 'snapshot-device-mismatch',
    });
    // The author's own lost-ACK retry stays idempotent after its lease and write
    // right lapse; it reports the unchanged current offset and changes nothing.
    writable.delete('writer');
    clock.now = 10 * CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS;
    const retry = await publication.admit(put('10', s10, 'writer', fresh));
    expect(retry).toMatchObject({ status: 'idempotent', currentOffset: '20' });
    expect(publication.current('g/loro')?.offset).toBe('20');
  });
});

describe('SAFE: identity, purpose and alias checks in core admission', () => {
  it('rejects offset aliases with different bytes and update-purpose frames in snapshot envelopes', async () => {
    const clock = { now: 1_000 };
    const lease = { issued: 1_000, expires: 1_000 + CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS };
    const publication = host(new Set(['writer', 'other']), clock);
    const first = await seal('writer', 'snapshot', '00000000000000000010', 'one');
    expect(
      (await publication.admit(put('00000000000000000010', first, 'writer', lease))).status
    ).toBe('accepted');
    const other = await seal('other', 'snapshot', '10', 'two');
    await expect(publication.admit(put('10', other, 'other', lease))).rejects.toMatchObject({
      message: 'snapshot-identity-conflict',
    });
    await expect(publication.admit(put('010', other, 'other', lease))).rejects.toMatchObject({
      message: 'snapshot-offset-incomparable',
    });
    const update = await seal('writer', 'update_batch', '20', 'update-not-snapshot');
    await expect(publication.admit(put('20', update, 'writer', lease))).rejects.toMatchObject({
      message: 'bad-content-signature',
    });
    expect(publication.current('g/loro')?.offset).toBe('00000000000000000010');
  });

  it('a snapshot sealed for one continuation offset cannot be opened at another', async () => {
    const provider = createStreamsContentProvider({
      cipher: new ContentCipher(policy()),
      genesis,
      resource,
      model: 'loro',
      writeEpoch: 0,
      author: author('writer'),
      signingKey: pairs.get('writer')!.pair.privateKey,
      readKey: () => epochKey,
      mayWriteDocument: () => true,
    });
    const aad = new Uint8Array([9, 9]);
    const sealed = await provider.seal({
      plaintext: new TextEncoder().encode('snap'),
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'snapshot',
        continuationOffset: '00000000000000000010',
      } as PayloadProtectionContext,
      additionalData: () => aad,
    });
    await expect(
      provider.open({
        sealed: sealed.sealed,
        header: sealed.header,
        additionalData: aad,
        context: {
          protocol: 'loro-streams-crdt-payload-protection',
          version: 2,
          kind: 'snapshot',
          continuationOffset: '10',
        } as PayloadProtectionContext,
      })
    ).rejects.toThrow('snapshot-offset-mismatch');
  });
});
