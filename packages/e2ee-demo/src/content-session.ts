import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import {
  InMemoryRemoteCursorStore,
  StreamsCrdt,
  createLoroDocAdapter,
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
