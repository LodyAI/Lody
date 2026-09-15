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
import { ContentCipher } from '@lody/e2ee-core';
import { createStreamsContentProvider } from '@lody/e2ee-core/streams-content';
import { toHex } from './bytes';
import { FLOCK_STREAM, LORO_STREAM } from './protocol';
import type { DemoSession } from './session';
import { deviceHex } from './device';

function provider(session: DemoSession, resource: string, model: 'loro' | 'flock') {
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

export async function writeLoro(session: DemoSession, text: string): Promise<void> {
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

export async function readLoro(session: DemoSession): Promise<string> {
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

export async function writeFlock(session: DemoSession, value: string): Promise<void> {
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
  flock.put(['private', 'note'], { value });
  const appended = await crdt.appendWriteOnly();
  if (!appended.ok) {
    throw new Error(
      `flock-append-failed:${'result' in appended ? JSON.stringify(appended.result) : ''}`
    );
  }
  await crdt.close();
}

export async function readFlock(session: DemoSession): Promise<string> {
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
  const value = String(
    (flock.get(['private', 'note']) as { value?: string } | undefined)?.value ?? ''
  );
  await crdt.close();
  return value;
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
  session: DemoSession,
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
  session: DemoSession,
  offset: string,
  body: Uint8Array
): Promise<Response> {
  return session.fetch(
    `/ds/${session.genesisHex}/${LORO_STREAM}/snapshot/${encodeURIComponent(offset)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from(body),
    }
  );
}

export async function loroTailOffset(session: DemoSession): Promise<string> {
  const response = await session.fetch(`/ds/${session.genesisHex}/${LORO_STREAM}`, {
    method: 'HEAD',
  });
  return response.headers.get('Stream-Next-Offset') ?? '00000000000000000000';
}

export async function uploadLoroSnapshot(session: DemoSession, text: string): Promise<void> {
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
