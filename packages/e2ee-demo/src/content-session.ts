import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import { StreamsClient } from '@loro-dev/streams-client';
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
import { ContentCipher } from '@lody/e2ee-core';
import { createStreamsContentProvider } from '@lody/e2ee-core/streams-content';
import { asArrayBuffer, toHex } from './bytes';
import { FLOCK_STREAM, LORO_STREAM } from './protocol';
import type { DemoDevice } from './device';
import { deviceHex } from './device';

function requestUrl(input: object): string {
  const value = input as { href?: unknown; url?: unknown };
  if (typeof value.href === 'string') return value.href;
  if (typeof value.url === 'string') return value.url;
  return String(input);
}

export interface ContentClient {
  readonly baseUrl: string;
  genesisHex: string | null;
  device: DemoDevice;
  readonly account: string;
  membershipId: Uint8Array | null;
  epochKeys: Map<number, Uint8Array>;
  canWriteDocument: boolean;
  currentEpoch(): number;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function provider(session: ContentClient, resource: string, model: 'loro' | 'flock') {
  if (!session.genesisHex || !session.device) throw new Error('no-space');
  return createStreamsContentProvider({
    cipher: new ContentCipher({
      authorize(header) {
        return header.device;
      },
    }),
    genesis: session.genesisHex,
    resource,
    model,
    writeEpoch: session.currentEpoch(),
    author: {
      actor: session.account,
      memberInstance: session.membershipId ? toHex(session.membershipId) : session.account,
      device: deviceHex(session.device),
    },
    signingKey: session.device.signing.privateKey,
    readKey: (epoch) => session.epochKeys.get(epoch),
    mayWriteDocument: () => session.canWriteDocument,
  });
}

export async function writeLoro(session: ContentClient, text: string): Promise<void> {
  const doc = new LoroDoc();
  const crdt = new StreamsCrdt({
    streamUrl: `${session.baseUrl}/ds/${session.genesisHex}/${LORO_STREAM}`,
    adapter: createLoroDocAdapter(doc),
    payloadProtectionRequired: true,
    e2ee: {
      provider: provider(session, 'loro', 'loro'),
      readPolicy: 'encrypted-only',
      writePolicy: 'encrypt',
    },
    fetch: (input, init) => session.fetch(input, init),
  });
  const created = await crdt.createStream();
  if (!created.ok) {
    /* already exists */
  }
  doc.getText('text').insert(0, text);
  doc.commit();
  const appended = await crdt.appendWriteOnly();
  if (!appended.ok) {
    throw new Error(`loro-append-failed:${JSON.stringify(appended)}`);
  }
  await crdt.close();
  doc.free();
}

export async function readLoro(session: ContentClient): Promise<string> {
  const doc = new LoroDoc();
  const crdt = new StreamsCrdt({
    streamUrl: `${session.baseUrl}/ds/${session.genesisHex}/${LORO_STREAM}`,
    adapter: createLoroDocAdapter(doc),
    remoteCursorStore: new InMemoryRemoteCursorStore(),
    payloadProtectionRequired: true,
    e2ee: {
      provider: provider(session, 'loro', 'loro'),
      readPolicy: 'encrypted-only',
      writePolicy: 'encrypt',
    },
    fetch: (input, init) => session.fetch(input, init),
  });
  const synced = await crdt.sync();
  if (!synced.ok) throw new Error(`loro-sync-failed:${JSON.stringify(synced)}`);
  const text = doc.getText('text').toString();
  await crdt.close();
  doc.free();
  return text;
}

export async function writeFlock(
  session: ContentClient,
  value: string,
  path: readonly string[] = ['private', 'note']
): Promise<void> {
  const flock = new Flock('writer');
  const crdt = new FlockStreamsCrdt({
    streamUrl: `${session.baseUrl}/ds/${session.genesisHex}/${FLOCK_STREAM}`,
    adapter: createFlockAdapter(flock),
    payloadProtectionRequired: true,
    e2ee: {
      provider: provider(session, 'flock', 'flock'),
      readPolicy: 'encrypted-only',
      writePolicy: 'encrypt',
    },
    fetch: (input, init) => session.fetch(input, init),
  });
  const created = await crdt.createStream();
  if (!created.ok) {
    /* already exists */
  }
  flock.put([...path], { value });
  const appended = await crdt.appendWriteOnly();
  if (!appended.ok) {
    throw new Error(
      `flock-append-failed:${'result' in appended ? JSON.stringify(appended.result) : ''}`
    );
  }
  await crdt.close();
}

export async function readFlock(
  session: ContentClient,
  path: readonly string[] = ['private', 'note']
): Promise<string> {
  const flock = new Flock('reader');
  const crdt = new FlockStreamsCrdt({
    streamUrl: `${session.baseUrl}/ds/${session.genesisHex}/${FLOCK_STREAM}`,
    adapter: createFlockAdapter(flock),
    remoteCursorStore: new FlockCursorStore(),
    payloadProtectionRequired: true,
    e2ee: {
      provider: provider(session, 'flock', 'flock'),
      readPolicy: 'encrypted-only',
      writePolicy: 'encrypt',
    },
    fetch: (input, init) => session.fetch(input, init),
  });
  const synced = await crdt.sync();
  if (!synced.ok) throw new Error('flock-sync-failed');
  const value = String((flock.get([...path]) as { value?: string } | undefined)?.value ?? '');
  await crdt.close();
  return value;
}

export async function syncLoro(session: ContentClient): Promise<LoroDoc> {
  const doc = new LoroDoc();
  const crdt = new StreamsCrdt({
    streamUrl: `${session.baseUrl}/ds/${session.genesisHex}/${LORO_STREAM}`,
    adapter: createLoroDocAdapter(doc),
    remoteCursorStore: new InMemoryRemoteCursorStore(),
    payloadProtectionRequired: true,
    e2ee: {
      provider: provider(session, 'loro', 'loro'),
      readPolicy: 'encrypted-only',
      writePolicy: 'encrypt',
    },
    fetch: (input, init) => session.fetch(input, init),
  });
  const created = await crdt.createStream();
  if (!created.ok) {
    /* already exists */
  }
  const synced = await crdt.sync();
  if (!synced.ok) throw new Error(`loro-sync-failed:${JSON.stringify(synced)}`);
  await crdt.close();
  return doc;
}

export function loroWriter(session: ContentClient, doc: LoroDoc) {
  return new StreamsCrdt({
    streamUrl: `${session.baseUrl}/ds/${session.genesisHex}/${LORO_STREAM}`,
    adapter: createLoroDocAdapter(doc),
    payloadProtectionRequired: true,
    e2ee: {
      provider: provider(session, 'loro', 'loro'),
      readPolicy: 'encrypted-only',
      writePolicy: 'encrypt',
    },
    fetch: (input, init) => session.fetch(input, init),
  });
}

export async function appendLoro(session: ContentClient, doc: LoroDoc): Promise<void> {
  const crdt = loroWriter(session, doc);
  try {
    const created = await crdt.createStream();
    if (!created.ok) {
      /* already exists */
    }
    const appended = await crdt.appendWriteOnly();
    if (!appended.ok) throw new Error(`loro-append-failed:${JSON.stringify(appended)}`);
  } finally {
    await crdt.close();
  }
}

export async function editLoro(session: ContentClient, text: string): Promise<void> {
  const doc = await syncLoro(session);
  const writer = loroWriter(session, doc);
  try {
    const created = await writer.createStream();
    if (!created.ok) {
      /* already exists */
    }
    const current = doc.getText('text').toString();
    if (!current.includes(text)) {
      doc.getText('text').insert(current.length, text);
      doc.commit();
    }
    const appended = await writer.appendWriteOnly();
    if (!appended.ok) throw new Error(`loro-append-failed:${JSON.stringify(appended)}`);
  } finally {
    await writer.close();
    doc.free();
  }
}

export async function assertLiveCiphertext(
  session: ContentClient,
  stream: 'loro' | 'flock',
  plaintext: string
): Promise<Uint8Array> {
  const client = new StreamsClient({
    url: `${session.baseUrl}/ds/${session.genesisHex}/${stream}`,
    fetch: (input, init) => session.fetch(input, init),
    retry: { maxAttempts: 0 },
  });
  const chunks: Uint8Array[] = [];
  let offset = '-1';
  for (let page = 0; page < 64; page++) {
    const response = await client.read({ offset });
    if (!response.ok) throw new Error(`${stream}-read-failed:${JSON.stringify(response)}`);
    const body = new Uint8Array(response.result.payload.body);
    if (body.byteLength > 0) chunks.push(body);
    offset = response.result.nextOffset;
    if (response.result.upToDate) break;
  }
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(size);
  let start = 0;
  for (const chunk of chunks) {
    body.set(chunk, start);
    start += chunk.byteLength;
  }
  if (new TextDecoder().decode(body).includes(plaintext)) {
    throw new Error(`${stream}-plaintext-leak`);
  }
  if (body.byteLength === 0) throw new Error(`${stream}-empty-log`);
  return body;
}

function wrapSnapshotEnvelope(header: Uint8Array, sealed: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(10 + header.byteLength);
  prefix.set([0x4c, 0x53, 0x43, 0x45, 2, 2]);
  new DataView(prefix.buffer).setUint16(6, header.byteLength);
  prefix.set(header, 10);
  const body = new Uint8Array(prefix.byteLength + sealed.byteLength);
  body.set(prefix);
  body.set(sealed, prefix.byteLength);
  return body;
}

export async function sealLoroSnapshot(
  session: ContentClient,
  offset: string,
  plaintext: string
): Promise<Uint8Array> {
  const sealed = await provider(session, 'loro', 'loro').seal({
    plaintext: new TextEncoder().encode(plaintext),
    context: {
      protocol: 'loro-streams-crdt-payload-protection',
      version: 2,
      kind: 'snapshot',
      continuationOffset: offset,
    } as PayloadProtectionContext,
    additionalData: () => new Uint8Array([1, 2, 3]),
  });
  return wrapSnapshotEnvelope(sealed.header, sealed.sealed);
}

export async function putLoroSnapshot(
  session: ContentClient,
  offset: string,
  body: Uint8Array
): Promise<Response> {
  return session.fetch(
    `/ds/${session.genesisHex}/${LORO_STREAM}/snapshot/${encodeURIComponent(offset)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: asArrayBuffer(body),
    }
  );
}

export async function loroTailOffset(session: ContentClient): Promise<string> {
  const response = await session.fetch(`/ds/${session.genesisHex}/${LORO_STREAM}`, {
    method: 'HEAD',
  });
  return response.headers.get('Stream-Next-Offset') ?? '00000000000000000000';
}

export async function uploadLoroSnapshot(session: ContentClient, text: string): Promise<void> {
  const doc = new LoroDoc();
  const crdt = new StreamsCrdt({
    streamUrl: `${session.baseUrl}/ds/${session.genesisHex}/${LORO_STREAM}`,
    adapter: createLoroDocAdapter(doc),
    payloadProtectionRequired: true,
    snapshotUpload: { canUpload: async () => true },
    e2ee: {
      provider: provider(session, 'loro', 'loro'),
      readPolicy: 'encrypted-only',
      writePolicy: 'encrypt',
    },
    fetch: (input, init) => session.fetch(input, init),
  });
  const created = await crdt.createStream();
  if (!created.ok) {
    /* already exists */
  }
  doc.getText('text').insert(0, text);
  doc.commit();
  const appended = await crdt.appendWriteOnly();
  if (!appended.ok) throw new Error(`loro-append-failed:${JSON.stringify(appended)}`);
  const uploaded = await crdt.uploadSnapshotForTesting();
  if (!uploaded.ok) throw new Error(`loro-snapshot-failed:${JSON.stringify(uploaded)}`);
  await crdt.close();
  doc.free();
}

export async function snapshotOffset(session: ContentClient): Promise<string> {
  const response = await session.fetch(`/ds/${session.genesisHex}/${LORO_STREAM}`, {
    method: 'HEAD',
  });
  const offset = response.headers.get('Stream-Snapshot-Offset');
  if (!offset || offset === '-1') throw new Error('snapshot-missing');
  return offset;
}

export async function assertSnapshotCiphertext(
  session: ContentClient,
  plaintext: string
): Promise<Uint8Array> {
  const offset = await snapshotOffset(session);
  const response = await session.fetch(
    `/ds/${session.genesisHex}/${LORO_STREAM}/snapshot/${encodeURIComponent(offset)}`
  );
  if (!response.ok) throw new Error(`snapshot-get-${response.status}`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength === 0) throw new Error('snapshot-empty');
  const text = new TextDecoder().decode(body);
  if (text.includes(plaintext)) throw new Error('snapshot-plaintext-leak');
  return body;
}

export async function bootstrapLoroFromSnapshot(
  session: ContentClient,
  expected: string
): Promise<{ text: string; fetches: string[] }> {
  const fetches: string[] = [];
  await assertSnapshotCiphertext(session, expected);
  const doc = new LoroDoc();
  const crdt = new StreamsCrdt({
    streamUrl: `${session.baseUrl}/ds/${session.genesisHex}/${LORO_STREAM}`,
    adapter: createLoroDocAdapter(doc),
    remoteCursorStore: new InMemoryRemoteCursorStore(),
    payloadProtectionRequired: true,
    e2ee: {
      provider: provider(session, 'loro', 'loro'),
      readPolicy: 'encrypted-only',
      writePolicy: 'encrypt',
    },
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : requestUrl(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = new URL(url, session.baseUrl).pathname;
      fetches.push(`${method} ${path}`);
      return session.fetch(input, init);
    },
  });
  const synced = await crdt.sync();
  if (!synced.ok) throw new Error(`loro-bootstrap-failed:${JSON.stringify(synced)}`);
  const text = doc.getText('text').toString();
  await crdt.close();
  doc.free();
  const usedSnapshot = fetches.some(
    (entry) => entry.includes('/bootstrap') || entry.includes('/snapshot/')
  );
  if (!usedSnapshot) throw new Error(`snapshot-not-fetched:${fetches.join(',')}`);
  if (!text.includes(expected)) throw new Error(`bootstrap-missing:${text}`);
  return { text, fetches };
}
