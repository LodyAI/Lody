import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import {
  InMemoryRemoteCursorStore,
  StreamsCrdt,
  createLoroDocAdapter,
  type PayloadProtectionContext,
} from '@loro-dev/streams-crdt/loro';
import {
  StreamsCrdt as FlockStreamsCrdt,
  createFlockAdapter,
  InMemoryRemoteCursorStore as FlockCursorStore,
} from '@loro-dev/streams-crdt/flock';
import { ContentCipher, Ledger } from '@lody/e2ee-core';
import {
  collectEpochPackets,
  commitEpochKey,
  decodeRecord,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  recoverHistory,
  sealHistoryPacket,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { createStreamsContentProvider } from '@lody/e2ee-core/streams-content';
import { listenDurableContent } from '../bench/ds-cas-server';

const author = { actor: 'owner', memberInstance: 'm0', device: 'd0' };
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function ed25519() {
  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey,
    async sign(bytes: Uint8Array) {
      const message = new Uint8Array(bytes.byteLength);
      message.set(bytes);
      return new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, message));
    },
  };
}

function pkgVersion(name: string): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === name && typeof pkg.version === 'string') return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`installed-version-missing:${name}`);
}

async function signingPair() {
  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const signingPublic = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { pair, signingPublic };
}

async function rotatedOrg() {
  const owner = await ed25519();
  const k0 = random(32);
  const body = encodeGenesisBody({
    signer: owner.publicKey,
    userId: random(32),
    membershipId: random(16),
    encryptionPublicKey: random(32),
    epochCommitment: await commitEpochKey(new Uint8Array(32), 0, k0),
  });
  const genesis = encodeSignedRecord(body, await owner.sign(signingBytesForBody(body)));
  const anchor = await hashRecord(genesis);
  const k1 = random(32);
  const packet = sealHistoryPacket(k1, k0, anchor, 1);
  const verified = await Ledger.verify({ anchor, records: [genesis] });
  const proposal = verified.prepare(
    {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(anchor, 1, k1),
      previousEpochKey: packet,
    },
    owner.publicKey
  );
  const published = encodeSignedRecord(proposal.bodyBytes, await owner.sign(proposal.signingBytes));
  const decoded = decodeRecord(genesis);
  if (decoded.body.type !== 'genesis') throw new Error('not-genesis');
  const recovered = await recoverHistory({
    genesis: anchor,
    latestEpoch: 1,
    latestKey: k1,
    packets: collectEpochPackets([genesis, published], decoded.body.fields.epochCommitment),
  });
  return { owner, genesis, anchor, k0, k1, recovered };
}

function providerFor(
  genesis: Uint8Array,
  signingPublic: string,
  signingKey: CryptoKey,
  readKey: (epoch: number) => Uint8Array | undefined,
  writeEpoch: number,
  resource: string
) {
  return createStreamsContentProvider({
    cipher: new ContentCipher({
      authorize(header) {
        if (header.actor !== author.actor) throw new Error('unauthorized');
        return signingPublic;
      },
    }),
    genesis: hex(genesis),
    resource,
    model: resource.startsWith('flock') ? 'flock' : 'loro',
    writeEpoch,
    author,
    signingKey,
    readKey,
    mayWriteDocument: () => true,
  });
}

function spyFetch(log: string[], failPosts = 0) {
  let remaining = failPosts;
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = `${method} ${url.pathname}`;
    log.push(path);
    if (method === 'POST' && remaining > 0 && !url.pathname.endsWith('/append-cas')) {
      remaining -= 1;
      throw new TypeError('lost-post');
    }
    return globalThis.fetch(input, init);
  };
}

async function closeHttp(server: { close(cb: (error?: Error | null) => void): void }) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

describe('C1 public-API streams-crdt over a real Durable Streams peer', () => {
  it('uses only public exports', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom '([^']+)'/g)].map((match) => match[1]!);
    expect(specifiers.some((value) => value.startsWith('../src') || value.includes('src/'))).toBe(
      false
    );
    expect(specifiers.some((value) => value.includes('ledger-fixtures'))).toBe(false);
    expect(specifiers.filter((value) => value === '@lody/e2ee-core').length).toBeGreaterThanOrEqual(
      1
    );
    expect(specifiers).toContain('@lody/e2ee-core/ledger');
    expect(specifiers).toContain('@lody/e2ee-core/streams-content');
    expect(specifiers).toContain('@loro-dev/streams-crdt/loro');
    expect(specifiers).toContain('@loro-dev/streams-crdt/flock');
    expect(specifiers).toContain('loro-crdt');
    expect(pkgVersion('@loro-dev/streams-crdt').length).toBeGreaterThan(0);
  });

  it('updates an old doc, creates a new doc, bootstraps history, retries, and rotates', async () => {
    const { server, streamUrl } = await listenDurableContent();
    servers.push({ close: () => closeHttp(server) });
    const { anchor, recovered, k0, k1 } = await rotatedOrg();
    const { pair, signingPublic } = await signingPair();
    const oldUrl = streamUrl('c1docs', 'old-doc');
    const newUrl = streamUrl('c1docs', 'new-doc');
    const paths: string[] = [];

    const writeOld = new LoroDoc();
    const writer = new StreamsCrdt({
      streamUrl: oldUrl,
      adapter: createLoroDocAdapter(writeOld),
      payloadProtectionRequired: true,
      e2ee: {
        provider: providerFor(
          anchor,
          signingPublic,
          pair.privateKey,
          (epoch) => recovered.get(epoch),
          1,
          'doc-old'
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: spyFetch(paths, 1),
    });
    const created = await writer.createStream();
    expect(created.ok).toBe(true);
    writeOld.getText('text').insert(0, 'old-doc-base');
    writeOld.commit();
    const lost = await writer.appendWriteOnly();
    expect(lost.ok).toBe(false);
    const first = await writer.appendWriteOnly();
    expect(first.ok).toBe(true);
    writeOld.getText('text').insert(12, '+update');
    writeOld.commit();
    expect((await writer.appendWriteOnly()).ok).toBe(true);
    await writer.close();
    writeOld.free();
    expect(paths.some((path) => path.endsWith('/old-doc') && path.startsWith('POST'))).toBe(true);

    const readOld = new LoroDoc();
    const oldStore = new InMemoryRemoteCursorStore();
    const oldCatchup = new StreamsCrdt({
      streamUrl: oldUrl,
      adapter: createLoroDocAdapter(readOld),
      remoteCursorStore: oldStore,
      payloadProtectionRequired: true,
      e2ee: {
        provider: providerFor(
          anchor,
          signingPublic,
          pair.privateKey,
          (epoch) => recovered.get(epoch),
          1,
          'doc-old'
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: spyFetch(paths),
    });
    const synced = await oldCatchup.sync();
    expect(synced.ok).toBe(true);
    expect(readOld.getText('text').toString()).toBe('old-doc-base+update');
    expect(paths.some((path) => path.endsWith('/old-doc/bootstrap'))).toBe(true);
    expect(paths.join('\n')).not.toContain('old-doc-base');
    await oldCatchup.close();
    readOld.free();

    const writeNew = new LoroDoc();
    const newWriter = new StreamsCrdt({
      streamUrl: newUrl,
      adapter: createLoroDocAdapter(writeNew),
      payloadProtectionRequired: true,
      e2ee: {
        provider: providerFor(
          anchor,
          signingPublic,
          pair.privateKey,
          (epoch) => recovered.get(epoch),
          1,
          'doc-new'
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: spyFetch(paths),
    });
    expect((await newWriter.createStream()).ok).toBe(true);
    writeNew.getText('text').insert(0, 'brand-new-doc');
    writeNew.commit();
    expect((await newWriter.appendWriteOnly()).ok).toBe(true);
    await newWriter.close();
    writeNew.free();

    const readNew = new LoroDoc();
    const newCatchup = new StreamsCrdt({
      streamUrl: newUrl,
      adapter: createLoroDocAdapter(readNew),
      remoteCursorStore: new InMemoryRemoteCursorStore(),
      payloadProtectionRequired: true,
      e2ee: {
        provider: providerFor(
          anchor,
          signingPublic,
          pair.privateKey,
          (epoch) => recovered.get(epoch),
          1,
          'doc-new'
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: spyFetch(paths),
    });
    expect((await newCatchup.sync()).ok).toBe(true);
    expect(readNew.getText('text').toString()).toBe('brand-new-doc');
    await newCatchup.close();
    readNew.free();

    const wrong = new LoroDoc();
    const wrongCatchup = new StreamsCrdt({
      streamUrl: oldUrl,
      adapter: createLoroDocAdapter(wrong),
      remoteCursorStore: new InMemoryRemoteCursorStore(),
      payloadProtectionRequired: true,
      e2ee: {
        provider: providerFor(
          anchor,
          signingPublic,
          pair.privateKey,
          () => random(32),
          1,
          'doc-old'
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: spyFetch(paths),
    });
    const failed = await wrongCatchup.sync();
    expect(failed.ok).toBe(false);
    expect(wrong.getText('text').toString()).not.toContain('old-doc-base');
    await wrongCatchup.close();
    wrong.free();

    const epoch0Url = streamUrl('c1docs', 'rotated');
    const epoch0Doc = new LoroDoc();
    const epoch0 = new StreamsCrdt({
      streamUrl: epoch0Url,
      adapter: createLoroDocAdapter(epoch0Doc),
      payloadProtectionRequired: true,
      e2ee: {
        provider: providerFor(anchor, signingPublic, pair.privateKey, () => k0, 0, 'doc-rot'),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: spyFetch(paths),
    });
    expect((await epoch0.createStream()).ok).toBe(true);
    epoch0Doc.getText('text').insert(0, 'from-epoch-0');
    epoch0Doc.commit();
    expect((await epoch0.appendWriteOnly()).ok).toBe(true);
    await epoch0.close();
    epoch0Doc.free();

    const epoch1Doc = new LoroDoc();
    const epoch1 = new StreamsCrdt({
      streamUrl: epoch0Url,
      adapter: createLoroDocAdapter(epoch1Doc),
      payloadProtectionRequired: true,
      e2ee: {
        provider: providerFor(
          anchor,
          signingPublic,
          pair.privateKey,
          (epoch) => recovered.get(epoch),
          1,
          'doc-rot'
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: spyFetch(paths),
    });
    epoch1Doc.getText('text').insert(0, 'from-epoch-1');
    epoch1Doc.commit();
    expect((await epoch1.appendWriteOnly()).ok).toBe(true);
    await epoch1.close();
    epoch1Doc.free();

    const rotatedReader = new LoroDoc();
    const rotated = new StreamsCrdt({
      streamUrl: epoch0Url,
      adapter: createLoroDocAdapter(rotatedReader),
      remoteCursorStore: new InMemoryRemoteCursorStore(),
      payloadProtectionRequired: true,
      e2ee: {
        provider: providerFor(
          anchor,
          signingPublic,
          pair.privateKey,
          (epoch) => recovered.get(epoch),
          1,
          'doc-rot'
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: spyFetch(paths),
    });
    expect((await rotated.sync()).ok).toBe(true);
    const text = rotatedReader.getText('text').toString();
    expect(text).toContain('from-epoch-0');
    expect(text).toContain('from-epoch-1');
    expect(k1).not.toEqual(k0);
    await rotated.close();
    rotatedReader.free();

    const onlyK0 = new LoroDoc();
    const stale = new StreamsCrdt({
      streamUrl: epoch0Url,
      adapter: createLoroDocAdapter(onlyK0),
      remoteCursorStore: new InMemoryRemoteCursorStore(),
      payloadProtectionRequired: true,
      e2ee: {
        provider: providerFor(
          anchor,
          signingPublic,
          pair.privateKey,
          (epoch) => (epoch === 0 ? k0 : undefined),
          0,
          'doc-rot'
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: spyFetch(paths),
    });
    expect((await stale.sync()).ok).toBe(false);
    expect(onlyK0.getText('text').toString()).not.toContain('from-epoch-1');
    await stale.close();
    onlyK0.free();
  });

  it('fail-closes snapshots and still bootstraps after 410 without leaking plaintext', async () => {
    const { server, streamUrl } = await listenDurableContent();
    servers.push({ close: () => closeHttp(server) });
    const { anchor, recovered } = await rotatedOrg();
    const { pair, signingPublic } = await signingPair();
    const url = streamUrl('c1docs', 'snap');
    const provider = providerFor(
      anchor,
      signingPublic,
      pair.privateKey,
      (epoch) => recovered.get(epoch),
      1,
      'doc-snap'
    );
    const snapshot = {
      protocol: 'loro-streams-crdt-payload-protection',
      version: 2,
      kind: 'snapshot',
    } as PayloadProtectionContext;
    await expect(
      provider.seal({
        plaintext: new Uint8Array([1]),
        context: snapshot,
        additionalData: () => {
          throw new Error('must-not-request-aad');
        },
      })
    ).rejects.toThrow(/invalid-snapshot-offset/);
    await expect(
      provider.open({
        sealed: new Uint8Array([1]),
        header: new Uint8Array([1]),
        context: snapshot,
        additionalData: new Uint8Array([1]),
      })
    ).rejects.toThrow(/invalid-snapshot-offset/);

    const writerDoc = new LoroDoc();
    const writer = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(writerDoc),
      payloadProtectionRequired: true,
      snapshotUpload: { canUpload: async () => true },
      e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
      fetch: globalThis.fetch.bind(globalThis),
    });
    expect((await writer.createStream()).ok).toBe(true);
    writerDoc.getText('text').insert(0, 'snapshot-secret');
    writerDoc.commit();
    expect((await writer.appendWriteOnly()).ok).toBe(true);
    await writer.close();
    writerDoc.free();

    const head = await fetch(url, { method: 'HEAD' });
    const tail = head.headers.get('Stream-Next-Offset') ?? '0';
    const compacted = await fetch(`${url}/snapshot/${tail}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([9, 9, 9]),
    });
    expect(compacted.status).toBe(204);
    const gone = await fetch(`${url}?offset=-1`);
    expect(gone.status).toBe(410);

    const reader = new LoroDoc();
    const catchup = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(reader),
      remoteCursorStore: new InMemoryRemoteCursorStore(),
      payloadProtectionRequired: true,
      e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
      fetch: globalThis.fetch.bind(globalThis),
    });
    const recoveredRead = await catchup.sync();
    expect(recoveredRead.ok).toBe(false);
    expect(reader.getText('text').toString()).not.toBe('snapshot-secret');
    await catchup.close();
    reader.free();
  });

  it('bootstraps an encrypted content snapshot plus a suffix without leaking plaintext', async () => {
    const { server, streamUrl } = await listenDurableContent();
    servers.push({ close: () => closeHttp(server) });
    const { anchor, recovered } = await rotatedOrg();
    const { pair, signingPublic } = await signingPair();
    const url = streamUrl('c1docs', 'snap-ok');
    const provider = providerFor(
      anchor,
      signingPublic,
      pair.privateKey,
      (epoch) => recovered.get(epoch),
      1,
      'doc-snap-ok'
    );
    const writerDoc = new LoroDoc();
    const writer = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(writerDoc),
      payloadProtectionRequired: true,
      e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
      fetch: globalThis.fetch.bind(globalThis),
    });
    expect((await writer.createStream()).ok).toBe(true);
    writerDoc.getText('text').insert(0, 'snapshot-secret');
    writerDoc.commit();
    expect((await writer.appendWriteOnly()).ok).toBe(true);
    const uploaded = await writer.uploadSnapshotForTesting();
    expect(uploaded.ok).toBe(true);
    writerDoc.getText('text').insert(15, '+suffix');
    writerDoc.commit();
    expect((await writer.appendWriteOnly()).ok).toBe(true);
    await writer.close();

    const head = await fetch(url, { method: 'HEAD' });
    expect(head.headers.get('Stream-Snapshot-Offset')).toBeTruthy();
    expect(head.headers.get('Stream-Snapshot-Offset')).not.toBe('-1');

    const readerDoc = new LoroDoc();
    const reader = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(readerDoc),
      remoteCursorStore: new InMemoryRemoteCursorStore(),
      payloadProtectionRequired: true,
      e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
      fetch: globalThis.fetch.bind(globalThis),
    });
    const synced = await reader.sync();
    expect(synced.ok).toBe(true);
    expect(readerDoc.getText('text').toString()).toBe(writerDoc.getText('text').toString());
    await reader.close();
    writerDoc.free();
    readerDoc.free();
  });

  it('decrypts a Flock document over the same real peer', async () => {
    const { server, streamUrl } = await listenDurableContent();
    servers.push({ close: () => closeHttp(server) });
    const { anchor, recovered } = await rotatedOrg();
    const { pair, signingPublic } = await signingPair();
    const url = streamUrl('c1docs', 'flock-1');
    const provider = providerFor(
      anchor,
      signingPublic,
      pair.privateKey,
      (epoch) => recovered.get(epoch),
      1,
      'flock-1'
    );
    const writer = new Flock('writer');
    const write = new FlockStreamsCrdt({
      streamUrl: url,
      adapter: createFlockAdapter(writer),
      payloadProtectionRequired: true,
      e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
      fetch: globalThis.fetch.bind(globalThis),
    });
    expect((await write.createStream()).ok).toBe(true);
    writer.put(['private', 'note'], { value: 'flock-from-ledger' });
    expect((await write.appendWriteOnly()).ok).toBe(true);
    await write.close();

    const reader = new Flock('reader');
    const read = new FlockStreamsCrdt({
      streamUrl: url,
      adapter: createFlockAdapter(reader),
      remoteCursorStore: new FlockCursorStore(),
      payloadProtectionRequired: true,
      e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
      fetch: globalThis.fetch.bind(globalThis),
    });
    expect((await read.sync()).ok).toBe(true);
    expect(reader.get(['private', 'note'])).toEqual({ value: 'flock-from-ledger' });
    await read.close();
  });
});
