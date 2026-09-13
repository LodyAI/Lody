import { describe, expect, it } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import {
  StreamsCrdt,
  createLoroDocAdapter,
  InMemoryRemoteCursorStore,
  type PayloadProtectionContext,
} from '@loro-dev/streams-crdt/loro';
import {
  StreamsCrdt as FlockStreamsCrdt,
  createFlockAdapter,
  InMemoryRemoteCursorStore as FlockCursorStore,
} from '@loro-dev/streams-crdt/flock';
import { ContentCipher } from '@lody/e2ee-core';
import {
  collectEpochPackets,
  commitEpochKey,
  decodeRecord,
  recoverHistory,
  sealHistoryPacket,
} from '@lody/e2ee-core/ledger';
import { createStreamsContentProvider } from '@lody/e2ee-core/streams-content';
import { append, ed25519, hex, random, signGenesis } from './ledger-fixtures';

const url = 'https://synthetic.example.test/ds/doc';

function response(body: Uint8Array, nextOffset = 'tail', upToDate = true) {
  return new Response(new Uint8Array(body).buffer, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Stream-Next-Offset': nextOffset,
      'Stream-Up-To-Date': upToDate ? 'true' : 'false',
    },
  });
}

const author = { actor: 'owner', memberInstance: 'm0', device: 'd0' };

async function signingPair() {
  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const signingPublic = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { pair, signingPublic };
}

async function rotatedKeys() {
  const owner = await ed25519();
  const k0 = random(32);
  const created = await signGenesis(owner, k0);
  const k1 = random(32);
  const published = await append(created.ledger, owner, {
    type: 'publishEpoch',
    epoch: 1,
    commitment: await commitEpochKey(created.anchor, 1, k1),
    previousEpochKey: sealHistoryPacket(k1, k0, created.anchor, 1),
  });
  const genesisBody = decodeRecord(created.record);
  if (genesisBody.body.type !== 'genesis') throw new Error('not-genesis');
  const recovered = await recoverHistory({
    genesis: created.anchor,
    latestEpoch: 1,
    latestKey: k1,
    packets: collectEpochPackets(
      [created.record, published.record],
      genesisBody.body.fields.epochCommitment
    ),
  });
  return { owner, created, published, k0, k1, recovered };
}

function providerFor(
  genesis: Uint8Array,
  signingPublic: string,
  signingKey: CryptoKey,
  readKey: (epoch: number) => Uint8Array | undefined,
  writeEpoch: number,
  resource = 'doc-1'
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
    model: 'loro',
    writeEpoch,
    author,
    signingKey,
    readKey,
  });
}

async function catchupFromPages(
  streamUrl: string,
  pages: Uint8Array[],
  provider: ReturnType<typeof createStreamsContentProvider>
) {
  const reader = new LoroDoc();
  const store = new InMemoryRemoteCursorStore();
  await store.save({
    streamUrl,
    nextOffset: '-1',
    serverLowerBoundVersion: {},
    updatedAtMs: 0,
  });
  const transport = new StreamsCrdt({
    streamUrl,
    adapter: createLoroDocAdapter(reader),
    remoteCursorStore: store,
    e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
    fetch: async (requestUrl) => {
      if (new URL(requestUrl).pathname.endsWith('/bootstrap')) {
        throw new Error('unexpected-bootstrap');
      }
      const offset = new URL(requestUrl).searchParams.get('offset') ?? '-1';
      const index = offset === '-1' ? 0 : Number.parseInt(offset, 10);
      const page = pages[index];
      if (!page) return response(new Uint8Array(), 'tail', true);
      const last = index + 1 >= pages.length;
      return response(page, last ? 'tail' : String(index + 1), last);
    },
  });
  const result = await transport.catchup();
  return { result, reader };
}

it('catchup decrypts a Loro update with keys recovered from the public ledger API', async () => {
  const owner = await ed25519();
  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const signingPublic = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const k0 = random(32);
  const created = await signGenesis(owner, k0);
  const k1 = random(32);
  const published = await append(created.ledger, owner, {
    type: 'publishEpoch',
    epoch: 1,
    commitment: await commitEpochKey(created.anchor, 1, k1),
    previousEpochKey: sealHistoryPacket(k1, k0, created.anchor, 1),
  });
  const genesisBody = decodeRecord(created.record);
  if (genesisBody.body.type !== 'genesis') throw new Error('not-genesis');
  const recovered = await recoverHistory({
    genesis: created.anchor,
    latestEpoch: 1,
    latestKey: k1,
    packets: collectEpochPackets(
      [created.record, published.record],
      genesisBody.body.fields.epochCommitment
    ),
  });
  expect(recovered.get(1)).toEqual(k1);
  expect(recovered.get(0)).toEqual(k0);

  const author = { actor: 'owner', memberInstance: 'm0', device: 'd0' };
  const provider = () =>
    createStreamsContentProvider({
      cipher: new ContentCipher({
        authorize(header) {
          if (header.actor !== author.actor) throw new Error('unauthorized');
          return signingPublic;
        },
      }),
      genesis: hex(created.anchor),
      resource: 'doc-1',
      model: 'loro',
      writeEpoch: 1,
      author,
      signingKey: pair.privateKey,
      readKey: (epoch) => recovered.get(epoch),
    });

  const writer = new LoroDoc();
  let body = new Uint8Array();
  const writeTransport = new StreamsCrdt({
    streamUrl: url,
    adapter: createLoroDocAdapter(writer),
    e2ee: { provider: provider(), readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
    fetch: async (_url, init) => {
      if (init?.method !== 'POST') throw new Error('unexpected-read');
      body = new Uint8Array(await new Response(init.body).arrayBuffer());
      return response(new Uint8Array());
    },
  });
  writer.getText('text').insert(0, 'secret-from-ledger-epoch');
  writer.commit();
  const written = await writeTransport.appendWriteOnly();
  expect(written.ok).toBe(true);
  if (written.ok) expect(written.value.appended).toBe(true);
  expect(body.byteLength).toBeGreaterThan(0);
  writer.free();

  const reader = new LoroDoc();
  const store = new InMemoryRemoteCursorStore();
  await store.save({
    streamUrl: url,
    nextOffset: '-1',
    serverLowerBoundVersion: {},
    updatedAtMs: 0,
  });
  let persisted: Uint8Array | undefined;
  const readTransport = new StreamsCrdt({
    streamUrl: url,
    adapter: createLoroDocAdapter(reader),
    remoteCursorStore: {
      load: (streamUrl) => store.load(streamUrl),
      async save(cursor) {
        expect(persisted).toBeDefined();
        const restored = new LoroDoc();
        try {
          restored.import(persisted!);
          expect(restored.toJSON()).toEqual(reader.toJSON());
        } finally {
          restored.free();
        }
        await store.save(cursor);
      },
    },
    beforeRemoteCursorSave: async () => {
      persisted = reader.export({ mode: 'snapshot' });
    },
    e2ee: { provider: provider(), readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
    fetch: async (requestUrl) => {
      if (new URL(requestUrl).pathname.endsWith('/bootstrap')) {
        throw new Error('unexpected-bootstrap');
      }
      return response(body);
    },
  });
  const caught = await readTransport.catchup();
  expect(caught.ok).toBe(true);
  expect(reader.getText('text').toString()).toBe('secret-from-ledger-epoch');
  expect(persisted).toBeDefined();
  reader.free();

  const wrong = new LoroDoc();
  const wrongStore = new InMemoryRemoteCursorStore();
  await wrongStore.save({
    streamUrl: url,
    nextOffset: '-1',
    serverLowerBoundVersion: {},
    updatedAtMs: 0,
  });
  const wrongTransport = new StreamsCrdt({
    streamUrl: url,
    adapter: createLoroDocAdapter(wrong),
    remoteCursorStore: wrongStore,
    e2ee: {
      provider: createStreamsContentProvider({
        cipher: new ContentCipher({
          authorize() {
            return signingPublic;
          },
        }),
        genesis: hex(created.anchor),
        resource: 'doc-1',
        model: 'loro',
        writeEpoch: 1,
        author,
        signingKey: pair.privateKey,
        readKey: () => random(32),
      }),
      readPolicy: 'encrypted-only',
      writePolicy: 'encrypt',
    },
    fetch: async (requestUrl) => {
      if (new URL(requestUrl).pathname.endsWith('/bootstrap')) {
        throw new Error('unexpected-bootstrap');
      }
      return response(body);
    },
  });
  const failed = await wrongTransport.catchup();
  expect(failed.ok).toBe(false);
  expect(wrong.getText('text').toString()).not.toBe('secret-from-ledger-epoch');
  wrong.free();
});

describe('C1 public-export catchup variants', () => {
  it('decrypts an old-document update and a new document without bootstrap', async () => {
    const { created, recovered } = await rotatedKeys();
    const { pair, signingPublic } = await signingPair();
    const provider = () =>
      providerFor(
        created.anchor,
        signingPublic,
        pair.privateKey,
        (epoch) => recovered.get(epoch),
        1
      );
    const writer = new LoroDoc();
    const pages: Uint8Array[] = [];
    const write = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(writer),
      e2ee: { provider: provider(), readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
      fetch: async (_requestUrl, init) => {
        if (init?.method !== 'POST') throw new Error('unexpected-read');
        pages.push(new Uint8Array(await new Response(init.body).arrayBuffer()));
        return response(new Uint8Array());
      },
    });
    writer.getText('text').insert(0, 'old-doc-base');
    writer.commit();
    expect((await write.appendWriteOnly()).ok).toBe(true);
    writer.getText('text').insert(12, '+update');
    writer.commit();
    expect((await write.appendWriteOnly()).ok).toBe(true);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(new TextDecoder().decode(page)).not.toContain('old-doc-base');
      expect(new TextDecoder().decode(page)).not.toContain('+update');
    }
    writer.free();

    const oldDoc = await catchupFromPages(url, pages, provider());
    expect(oldDoc.result.ok).toBe(true);
    expect(oldDoc.reader.getText('text').toString()).toBe('old-doc-base+update');
    oldDoc.reader.free();

    const newUrl = 'https://synthetic.example.test/ds/new-doc';
    const newWriter = new LoroDoc();
    let newBody = new Uint8Array();
    const newWrite = new StreamsCrdt({
      streamUrl: newUrl,
      adapter: createLoroDocAdapter(newWriter),
      e2ee: {
        provider: providerFor(
          created.anchor,
          signingPublic,
          pair.privateKey,
          (epoch) => recovered.get(epoch),
          1,
          'doc-2'
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: async (_requestUrl, init) => {
        if (init?.method !== 'POST') throw new Error('unexpected-read');
        newBody = new Uint8Array(await new Response(init.body).arrayBuffer());
        return response(new Uint8Array());
      },
    });
    newWriter.getText('text').insert(0, 'brand-new-doc');
    newWriter.commit();
    expect((await newWrite.appendWriteOnly()).ok).toBe(true);
    newWriter.free();
    const fresh = await catchupFromPages(
      newUrl,
      [newBody],
      providerFor(
        created.anchor,
        signingPublic,
        pair.privateKey,
        (epoch) => recovered.get(epoch),
        1,
        'doc-2'
      )
    );
    expect(fresh.result.ok).toBe(true);
    expect(fresh.reader.getText('text').toString()).toBe('brand-new-doc');
    fresh.reader.free();
  });

  it('retries the exact sealed bytes after a lost POST and decrypts them', async () => {
    const { created, recovered } = await rotatedKeys();
    const { pair, signingPublic } = await signingPair();
    const writer = new LoroDoc();
    const posts: Uint8Array[] = [];
    let failFirst = true;
    const write = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(writer),
      e2ee: {
        provider: providerFor(
          created.anchor,
          signingPublic,
          pair.privateKey,
          (epoch) => recovered.get(epoch),
          1
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: async (_requestUrl, init) => {
        if (init?.method !== 'POST') throw new Error('unexpected-read');
        const body = new Uint8Array(await new Response(init.body).arrayBuffer());
        posts.push(body);
        if (failFirst) {
          failFirst = false;
          throw new TypeError('lost-post');
        }
        return response(new Uint8Array());
      },
    });
    writer.getText('text').insert(0, 'retry-exact-bytes');
    writer.commit();
    const first = await write.appendWriteOnly();
    expect(first.ok).toBe(false);
    const second = await write.appendWriteOnly();
    expect(second.ok).toBe(true);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts[1]).toEqual(posts[0]);
    writer.free();

    const caught = await catchupFromPages(
      url,
      [posts[0]!],
      providerFor(
        created.anchor,
        signingPublic,
        pair.privateKey,
        (epoch) => recovered.get(epoch),
        1
      )
    );
    expect(caught.result.ok).toBe(true);
    expect(caught.reader.getText('text').toString()).toBe('retry-exact-bytes');
    caught.reader.free();
  });

  it('reads epoch-0 history and epoch-1 updates after rotation without snapshot bootstrap', async () => {
    const owner = await ed25519();
    const { pair, signingPublic } = await signingPair();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const genesisHex = hex(created.anchor);
    const pages: Uint8Array[] = [];
    const writer0 = new LoroDoc();
    const write0 = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(writer0),
      e2ee: {
        provider: providerFor(created.anchor, signingPublic, pair.privateKey, () => k0, 0),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: async (_requestUrl, init) => {
        if (init?.method !== 'POST') throw new Error('unexpected-read');
        pages.push(new Uint8Array(await new Response(init.body).arrayBuffer()));
        return response(new Uint8Array());
      },
    });
    writer0.getText('text').insert(0, 'from-epoch-0');
    writer0.commit();
    expect((await write0.appendWriteOnly()).ok).toBe(true);
    writer0.free();

    const k1 = random(32);
    const published = await append(created.ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, k1),
      previousEpochKey: sealHistoryPacket(k1, k0, created.anchor, 1),
    });
    const genesisBody = decodeRecord(created.record);
    if (genesisBody.body.type !== 'genesis') throw new Error('not-genesis');
    const recovered = await recoverHistory({
      genesis: created.anchor,
      latestEpoch: 1,
      latestKey: k1,
      packets: collectEpochPackets(
        [created.record, published.record],
        genesisBody.body.fields.epochCommitment
      ),
    });
    expect(recovered.get(0)).toEqual(k0);
    expect(recovered.get(1)).toEqual(k1);

    const writer1 = new LoroDoc();
    const write1 = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(writer1),
      e2ee: {
        provider: providerFor(
          created.anchor,
          signingPublic,
          pair.privateKey,
          (epoch) => recovered.get(epoch),
          1
        ),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: async (_requestUrl, init) => {
        if (init?.method !== 'POST') throw new Error('unexpected-read');
        pages.push(new Uint8Array(await new Response(init.body).arrayBuffer()));
        return response(new Uint8Array());
      },
    });
    writer1.getText('text').insert(0, 'from-epoch-1');
    writer1.commit();
    expect((await write1.appendWriteOnly()).ok).toBe(true);
    writer1.free();
    expect(pages).toHaveLength(2);
    expect(genesisHex).toBe(hex(created.anchor));

    const caught = await catchupFromPages(
      url,
      pages,
      providerFor(
        created.anchor,
        signingPublic,
        pair.privateKey,
        (epoch) => recovered.get(epoch),
        1
      )
    );
    expect(caught.result.ok).toBe(true);
    const text = caught.reader.getText('text').toString();
    expect(text).toContain('from-epoch-0');
    expect(text).toContain('from-epoch-1');
    caught.reader.free();
  });

  it('catchup decrypts a Flock update with keys recovered from the public ledger API', async () => {
    const { created, recovered } = await rotatedKeys();
    const { pair, signingPublic } = await signingPair();
    const flockUrl = 'https://synthetic.example.test/ds/flock-1';
    const provider = createStreamsContentProvider({
      cipher: new ContentCipher({
        authorize(header) {
          if (header.actor !== author.actor) throw new Error('unauthorized');
          return signingPublic;
        },
      }),
      genesis: hex(created.anchor),
      resource: 'flock-1',
      model: 'flock',
      writeEpoch: 1,
      author,
      signingKey: pair.privateKey,
      readKey: (epoch) => recovered.get(epoch),
    });
    const writer = new Flock('writer');
    let body = new Uint8Array();
    const write = new FlockStreamsCrdt({
      streamUrl: flockUrl,
      adapter: createFlockAdapter(writer),
      e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
      fetch: async (_url, init) => {
        if (init?.method !== 'POST') throw new Error('unexpected-read');
        body = new Uint8Array(await new Response(init.body).arrayBuffer());
        return response(new Uint8Array());
      },
    });
    writer.put(['private', 'note'], { value: 'flock-from-ledger' });
    const written = await write.appendWriteOnly();
    expect(written.ok).toBe(true);
    expect(body.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(body)).not.toContain('flock-from-ledger');

    const reader = new Flock('reader');
    const store = new FlockCursorStore();
    await store.save({
      streamUrl: flockUrl,
      nextOffset: '-1',
      serverLowerBoundVersion: {},
      updatedAtMs: 0,
    });
    const read = new FlockStreamsCrdt({
      streamUrl: flockUrl,
      adapter: createFlockAdapter(reader),
      remoteCursorStore: store,
      e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
      fetch: async (requestUrl) => {
        if (new URL(requestUrl).pathname.endsWith('/bootstrap')) {
          throw new Error('unexpected-bootstrap');
        }
        return response(body);
      },
    });
    const caught = await read.catchup();
    expect(caught.ok).toBe(true);
    expect(reader.get(['private', 'note'])).toEqual({ value: 'flock-from-ledger' });
  });

  it('fails closed on snapshot contexts until provenance exists', async () => {
    const { created, recovered } = await rotatedKeys();
    const { pair, signingPublic } = await signingPair();
    const provider = providerFor(
      created.anchor,
      signingPublic,
      pair.privateKey,
      (epoch) => recovered.get(epoch),
      1
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
    ).rejects.toThrow(/snapshot-evidence-required/);
    await expect(
      provider.open({
        sealed: new Uint8Array([1]),
        header: new Uint8Array([1]),
        context: snapshot,
        additionalData: new Uint8Array([1]),
      })
    ).rejects.toThrow(/snapshot-evidence-required/);
  });
});
