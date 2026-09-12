import { beforeAll, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import {
  StreamsCrdt,
  createLoroDocAdapter,
  InMemoryRemoteCursorStore,
  type PayloadProtectionContext,
} from '@loro-dev/streams-crdt/loro';
import { ContentCipher } from '../src/content';
import { toHex } from '../src/wire';
import { createStreamsContentProvider } from '../src/streams-content';

let pair: CryptoKeyPair;
let publicKey: string;
const key = new Uint8Array(32).fill(9);
const url = 'https://synthetic.example.test/ds/doc';
const context: PayloadProtectionContext = {
  protocol: 'loro-streams-crdt-payload-protection',
  version: 2,
  kind: 'update_batch',
};
beforeAll(async () => {
  pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
});
function provider(resource = 'doc-1', readKey = (_epoch: number) => key) {
  return createStreamsContentProvider({
    cipher: new ContentCipher({
      authorize(header) {
        if (header.actor !== 'A' || header.memberInstance !== 'A1' || header.device !== 'D')
          throw new Error('unauthorized');
        return publicKey;
      },
    }),
    genesis: 'ab'.repeat(32),
    resource,
    model: 'loro',
    writeEpoch: 0,
    author: { actor: 'A', memberInstance: 'A1', device: 'D' },
    signingKey: pair.privateKey,
    readKey,
  });
}
function response(body: Uint8Array, nextOffset = 'tail') {
  return new Response(new Uint8Array(body).buffer, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Stream-Next-Offset': nextOffset,
      'Stream-Up-To-Date': 'true',
    },
  });
}
async function upload(doc: LoroDoc, text = 'secret') {
  let body = new Uint8Array();
  const transport = new StreamsCrdt({
    streamUrl: url,
    adapter: createLoroDocAdapter(doc),
    e2ee: { provider: provider(), readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
    fetch: async (_url, init) => {
      if (init?.method !== 'POST') throw new Error('unexpected-read');
      body = new Uint8Array(await new Response(init.body).arrayBuffer());
      return response(new Uint8Array());
    },
  });
  doc.getText('text').insert(0, text);
  doc.commit();
  const result = await transport.appendWriteOnly();
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.appended).toBe(true);
  expect(body.byteLength).toBeGreaterThan(0);
  return body;
}
async function download(
  doc: LoroDoc,
  body: Uint8Array,
  resource = 'doc-1',
  failPersistence = false
) {
  const store = new InMemoryRemoteCursorStore();
  await store.save({
    streamUrl: url,
    nextOffset: '-1',
    serverLowerBoundVersion: {},
    updatedAtMs: 0,
  });
  let persisted: Uint8Array | undefined;
  const transport = new StreamsCrdt({
    streamUrl: url,
    adapter: createLoroDocAdapter(doc),
    remoteCursorStore: {
      load: (streamUrl) => store.load(streamUrl),
      async save(cursor) {
        // Detect a cursor written before the corresponding state, not just eventual success.
        expect(persisted).toBeDefined();
        const restored = new LoroDoc();
        try {
          restored.import(persisted!);
          expect(restored.toJSON()).toEqual(doc.toJSON());
        } finally {
          restored.free();
        }
        await store.save(cursor);
      },
    },
    beforeRemoteCursorSave: async () => {
      if (failPersistence) throw new Error('synthetic-persist-failure');
      persisted = doc.export({ mode: 'snapshot' });
    },
    e2ee: { provider: provider(resource), readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
    fetch: async (requestUrl) => {
      if (new URL(requestUrl).pathname.endsWith('/bootstrap'))
        throw new Error('unexpected-bootstrap');
      return response(body);
    },
  });
  const result = await transport.catchup();
  return { result, cursor: await store.load(url), persisted };
}

it('authenticates the exact SDK AAD and checks the declared overhead', async () => {
  const p = provider();
  const plaintext = new TextEncoder().encode('private');
  let calls = 0;
  const binding = new Uint8Array([6, 7, 8]);
  const sealed = await p.seal({
    plaintext,
    context,
    additionalData(header) {
      calls++;
      expect(header).toEqual(new Uint8Array([1]));
      return binding;
    },
  });
  expect(calls).toBe(1);
  expect(sealed.header.length + sealed.sealed.length - plaintext.length).toBeLessThanOrEqual(
    p.maxSealOverheadBytes
  );
  expect(await p.open({ ...sealed, context, additionalData: binding })).toEqual(plaintext);
  await expect(
    p.open({ ...sealed, context, additionalData: new Uint8Array([6, 7, 9]) })
  ).rejects.toThrow('streams-aad-mismatch');
  await expect(
    p.open({ ...sealed, header: new Uint8Array([2]), context, additionalData: binding })
  ).rejects.toThrow('unsupported-streams-header');
  await expect(
    provider('other').open({ ...sealed, context, additionalData: binding })
  ).rejects.toThrow('content-context-mismatch');
  await expect(
    provider('doc-1', () => new Uint8Array(32)).open({
      ...sealed,
      context,
      additionalData: binding,
    })
  ).rejects.toThrow();
});

it('rejects snapshot publication/read and unknown protocol without weakening verification', async () => {
  const p = provider();
  for (const invalid of [
    { ...context, kind: 'snapshot' as const },
    { ...context, version: 3 },
  ]) {
    await expect(
      p.seal({
        plaintext: new Uint8Array(),
        context: invalid as PayloadProtectionContext,
        additionalData: () => {
          throw new Error('must-not-request-aad');
        },
      })
    ).rejects.toThrow();
    await expect(
      p.open({
        sealed: new Uint8Array(),
        header: new Uint8Array([1]),
        context: invalid as PayloadProtectionContext,
        additionalData: new Uint8Array([1]),
      })
    ).rejects.toThrow();
  }
});

it('passes real SDK write-only and catchup, persisting the real Loro document before the cursor', async () => {
  const source = new LoroDoc();
  const target = new LoroDoc();
  const restored = new LoroDoc();
  try {
    const body = await upload(source, 'a secret that must not appear on the wire');
    expect(new TextDecoder().decode(body)).not.toContain(
      'a secret that must not appear on the wire'
    );
    const { result, cursor, persisted } = await download(target, body);
    expect(result.ok).toBe(true);
    expect(target.toJSON()).toEqual(source.toJSON());
    expect(cursor?.nextOffset).toBe('tail');
    expect(persisted).toBeDefined();
    restored.import(persisted!);
    expect(restored.toJSON()).toEqual(source.toJSON());
  } finally {
    source.free();
    target.free();
    restored.free();
  }
});

it('does not import or checkpoint corrupted, plaintext or wrong-room SDK payloads', async () => {
  const source = new LoroDoc();
  try {
    const body = await upload(source);
    const corrupt = body.slice();
    corrupt[corrupt.length - 1]! ^= 1;
    for (const [bytes, resource] of [
      [corrupt, 'doc-1'],
      [body, 'other'],
      [new Uint8Array([0, 0, 0, 1, 42]), 'doc-1'],
    ] as const) {
      const target = new LoroDoc();
      try {
        const initial = target.toJSON();
        const result = await download(target, bytes, resource);
        expect(result.result.ok).toBe(false);
        expect(target.toJSON()).toEqual(initial);
        expect(result.cursor?.nextOffset).toBe('-1');
        expect(result.persisted).toBeUndefined();
      } finally {
        target.free();
      }
    }
  } finally {
    source.free();
  }
});

it('retains the old cursor when persistence fails after a valid import, allowing replay', async () => {
  const source = new LoroDoc();
  const target = new LoroDoc();
  try {
    const body = await upload(source);
    const failed = await download(target, body, 'doc-1', true);
    expect(failed.result.ok).toBe(false);
    expect(failed.cursor?.nextOffset).toBe('-1');
    expect(failed.persisted).toBeUndefined();
    expect(target.toJSON()).toEqual(source.toJSON());
    const resumed = await download(target, body);
    expect(resumed.result.ok).toBe(true);
    expect(resumed.cursor?.nextOffset).toBe('tail');
    expect(target.toJSON()).toEqual(source.toJSON());
  } finally {
    source.free();
    target.free();
  }
});
