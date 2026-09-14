import { afterEach, beforeAll, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import {
  StreamsCrdt,
  createLoroDocAdapter,
  InMemoryRemoteCursorStore,
  type PayloadProtectionContext,
} from '@loro-dev/streams-crdt/loro';
import { ContentCipher } from '../src/content';
import {
  CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS,
  SNAPSHOT_ADMISSION_DEVICE_HEADER,
  SNAPSHOT_ADMISSION_LEASE_EXPIRES_HEADER,
  SNAPSHOT_ADMISSION_LEASE_ISSUED_HEADER,
  createContentSnapshotPublication,
} from '../src/snapshot-admission';
import { createStreamsContentProvider, deviceMayWriteDocument } from '../src/streams-content';
import { toHex } from '../src/wire';
import { listenDurableContent } from '../bench/ds-cas-server';
import { admitDeviceOp, append, ed25519, hex, signGenesis } from './ledger-fixtures';

const genesis = 'ab'.repeat(32);
const resource = 'doc-1';
const epochKey = new Uint8Array(32).fill(9);
const writerAuthor = { actor: 'A', memberInstance: 'A1', device: 'writer' };
const guestAuthor = { actor: 'A', memberInstance: 'A1', device: 'guest' };
const strangerAuthor = { actor: 'B', memberInstance: 'B1', device: 'stranger' };

let writerPair: CryptoKeyPair;
let guestPair: CryptoKeyPair;
let strangerPair: CryptoKeyPair;
let writerPublic: string;
let guestPublic: string;
let strangerPublic: string;
const servers: Array<{ close(): Promise<void> }> = [];

async function closeHttp(server: { close(cb: (error?: Error | null) => void): void }) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

beforeAll(async () => {
  writerPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  guestPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  strangerPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  writerPublic = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', writerPair.publicKey)));
  guestPublic = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', guestPair.publicKey)));
  strangerPublic = toHex(
    new Uint8Array(await crypto.subtle.exportKey('raw', strangerPair.publicKey))
  );
});

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

function keys(device: string): { pair: CryptoKeyPair; publicKey: string } {
  if (device === 'writer') return { pair: writerPair, publicKey: writerPublic };
  if (device === 'guest') return { pair: guestPair, publicKey: guestPublic };
  return { pair: strangerPair, publicKey: strangerPublic };
}

function cipher() {
  return new ContentCipher({
    authorize(header) {
      if (header.device === 'writer') return writerPublic;
      if (header.device === 'guest') return guestPublic;
      throw new Error('unauthorized');
    },
  });
}

function attackerProvider(author: { actor: string; memberInstance: string; device: string }) {
  const { pair, publicKey } = keys(author.device);
  return createStreamsContentProvider({
    cipher: new ContentCipher({
      authorize(header) {
        if (header.device !== author.device) throw new Error('unauthorized');
        return publicKey;
      },
    }),
    genesis,
    resource,
    model: 'loro',
    writeEpoch: 0,
    author,
    signingKey: pair.privateKey,
    readKey: () => epochKey,
    mayWriteDocument: () => true,
  });
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

async function attackerSnapshot(
  author: { actor: string; memberInstance: string; device: string },
  offset: string,
  plaintext = 'snapshot-secret'
) {
  const provider = attackerProvider(author);
  const sealed = await provider.seal({
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

function publication(writable: Set<string>, clock: { now: number }) {
  return createContentSnapshotPublication({
    cipher: cipher(),
    mayWriteDocument: (author) => writable.has(author.device),
    now: () => clock.now,
  });
}

function put(
  offset: string,
  body: Uint8Array,
  device: string,
  clock: { now: number },
  extras: { issued?: number; expires?: number; genesis?: string; resource?: string } = {}
) {
  return {
    streamKey: 'docs/doc-1',
    offset,
    body,
    submittingDevice: device,
    leaseIssuedAt: extras.issued ?? clock.now,
    leaseExpiresAt: extras.expires ?? clock.now + CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS,
    expectedGenesis: extras.genesis ?? genesis,
    expectedResource: extras.resource ?? resource,
  };
}

it('admits a writer snapshot and rejects guest, stranger, and submitter/signer mismatch', async () => {
  const clock = { now: 1_000 };
  const writable = new Set(['writer']);
  const host = publication(writable, clock);
  const writerBody = await attackerSnapshot(writerAuthor, '10');
  const accepted = await host.admit(put('10', writerBody, 'writer', clock));
  expect(accepted.status).toBe('accepted');
  expect(accepted.header?.device).toBe('writer');
  const tampered = writerBody.slice();
  tampered[tampered.length - 1]! ^= 1;
  await expect(host.admit(put('20', tampered, 'writer', clock))).rejects.toThrow();
  await expect(
    host.admit(put('20', writerBody, 'writer', clock, { genesis: 'cd'.repeat(32) }))
  ).rejects.toMatchObject({ message: 'content-context-mismatch' });
  await expect(
    host.admit(put('20', writerBody, 'writer', clock, { resource: 'other' }))
  ).rejects.toMatchObject({ message: 'content-context-mismatch' });

  const guestBody = await attackerSnapshot(guestAuthor, '20');
  await expect(host.admit(put('20', guestBody, 'guest', clock))).rejects.toMatchObject({
    message: 'unauthorized',
  });

  const strangerBody = await attackerSnapshot(strangerAuthor, '20');
  await expect(host.admit(put('20', strangerBody, 'stranger', clock))).rejects.toThrow();

  await expect(host.admit(put('20', writerBody, 'guest', clock))).rejects.toMatchObject({
    message: 'snapshot-device-mismatch',
  });
  expect(host.current('docs/doc-1')?.offset).toBe('10');
});

it('rejects expired and delayed submissions without extending the original lease', async () => {
  const clock = { now: 1_000 };
  const host = publication(new Set(['writer']), clock);
  const body = await attackerSnapshot(writerAuthor, '10');
  const issued = 1_000;
  const expires = issued + 60_000;
  clock.now = expires;
  await expect(
    host.admit(put('10', body, 'writer', clock, { issued, expires }))
  ).rejects.toMatchObject({ message: 'snapshot-lease-expired' });
  clock.now = issued;
  await expect(
    host.admit(
      put('10', body, 'writer', clock, {
        issued,
        expires: issued + CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS + 1,
      })
    )
  ).rejects.toMatchObject({ message: 'snapshot-lease-invalid' });
});

it('keeps content identity: identical retries are idempotent and different bytes cannot replace an offset', async () => {
  const clock = { now: 1_000 };
  const host = publication(new Set(['writer']), clock);
  const first = await attackerSnapshot(writerAuthor, '10', 'one');
  const second = await attackerSnapshot(writerAuthor, '10', 'two');
  expect((await host.admit(put('10', first, 'writer', clock))).status).toBe('accepted');
  expect((await host.admit(put('10', first, 'writer', clock))).status).toBe('idempotent');
  await expect(host.admit(put('10', second, 'writer', clock))).rejects.toMatchObject({
    message: 'snapshot-identity-conflict',
  });
  const later = await attackerSnapshot(writerAuthor, '20', 'later');
  expect((await host.admit(put('20', later, 'writer', clock))).status).toBe('accepted');
  expect((await host.admit(put('10', first, 'writer', clock))).status).toBe('idempotent');
  expect(host.current('docs/doc-1')?.offset).toBe('20');
  await expect(host.admit(put('5', first, 'writer', clock))).rejects.toMatchObject({
    message: 'snapshot-offset-regression',
  });
});

it('rejects a revoked device from publishing new bytes but still opens the admitted historical snapshot', async () => {
  const clock = { now: 1_000 };
  const writable = new Set(['writer']);
  const host = publication(writable, clock);
  const offset = '10';
  const plaintext = new TextEncoder().encode('historical');
  const provider = attackerProvider(writerAuthor);
  const context = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'snapshot',
    continuationOffset: offset,
  } as PayloadProtectionContext;
  const binding = new Uint8Array([1, 2, 3]);
  const sealed = await provider.seal({
    plaintext,
    context,
    additionalData: () => binding,
  });
  const body = wrapSnapshotEnvelope(sealed.header, sealed.sealed);
  await host.admit(put(offset, body, 'writer', clock));
  writable.delete('writer');
  const newer = await attackerSnapshot(writerAuthor, '20', 'forged');
  await expect(host.admit(put('20', newer, 'writer', clock))).rejects.toMatchObject({
    message: 'unauthorized',
  });
  expect(await provider.open({ ...sealed, context, additionalData: binding })).toEqual(plaintext);
});

it('uses current ledger document-write, not mere key possession', async () => {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const machine = await ed25519();
  const withMachine = await append(
    created.ledger,
    owner,
    await admitDeviceOp(created.anchor, machine, 'machine', false)
  );
  const ownerHex = hex(owner.publicKey);
  const machineHex = hex(machine.publicKey);
  expect(deviceMayWriteDocument(withMachine.ledger.state, machineHex)).toBe(true);
  const revoked = await append(withMachine.ledger, owner, {
    type: 'revokeDevice',
    target: machine.publicKey,
  });
  expect(deviceMayWriteDocument(revoked.ledger.state, machineHex)).toBe(false);
  expect(deviceMayWriteDocument(revoked.ledger.state, ownerHex)).toBe(true);
});

it('fail-closes snapshot PUT until a host admission port is supplied', async () => {
  const { server, streamUrl } = await listenDurableContent();
  servers.push({ close: () => closeHttp(server) });
  const url = streamUrl('docs', 'no-admit');
  await fetch(url, { method: 'PUT' });
  const denied = await fetch(`${url}/snapshot/10`, {
    method: 'PUT',
    body: new Uint8Array([9, 9, 9]),
  });
  expect(denied.status).toBe(403);
  expect(await denied.text()).toBe('snapshot-admission-required');
  const bootstrap = await fetch(`${url}/bootstrap`);
  expect(bootstrap.headers.get('Stream-Snapshot-Offset')).toBe('-1');
});

it('HTTP-admits an encrypted snapshot, rejects replacement, and leaves cursor unchanged on verify failure', async () => {
  const clock = { now: 5_000 };
  const host = publication(new Set(['writer']), clock);
  const { server, streamUrl } = await listenDurableContent(undefined, {
    admitSnapshot: (input) =>
      host.admit({
        ...input,
        expectedGenesis: genesis,
        expectedResource: resource,
      }),
  });
  servers.push({ close: () => closeHttp(server) });
  const url = streamUrl('docs', 'doc-1');
  const provider = attackerProvider(writerAuthor);
  const headersFor = (device: string): HeadersInit => ({
    [SNAPSHOT_ADMISSION_DEVICE_HEADER]: device,
    [SNAPSHOT_ADMISSION_LEASE_ISSUED_HEADER]: String(clock.now),
    [SNAPSHOT_ADMISSION_LEASE_EXPIRES_HEADER]: String(
      clock.now + CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS
    ),
  });
  const fetchWithAdmission: typeof fetch = async (input, init) => {
    const target = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT' && target.pathname.includes('/snapshot/')) {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(headersFor('writer'))) headers.set(key, value);
      return await globalThis.fetch(input, { ...init, headers });
    }
    return await globalThis.fetch(input, init);
  };

  const writerDoc = new LoroDoc();
  const writer = new StreamsCrdt({
    streamUrl: url,
    adapter: createLoroDocAdapter(writerDoc),
    payloadProtectionRequired: true,
    e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
    fetch: fetchWithAdmission,
  });
  expect((await writer.createStream()).ok).toBe(true);
  writerDoc.getText('text').insert(0, 'snapshot-secret');
  writerDoc.commit();
  expect((await writer.appendWriteOnly()).ok).toBe(true);
  const uploaded = await writer.uploadSnapshotForTesting();
  expect(uploaded.ok).toBe(true);
  const head = await fetch(url, { method: 'HEAD' });
  const offset = head.headers.get('Stream-Snapshot-Offset');
  expect(offset && offset !== '-1').toBe(true);
  const forged = await attackerSnapshot(writerAuthor, offset!, 'forged');
  const replace = await fetch(`${url}/snapshot/${offset}`, {
    method: 'PUT',
    headers: headersFor('writer'),
    body: Buffer.from(forged),
  });
  expect(replace.status).toBe(409);
  await writer.close();

  const store = new InMemoryRemoteCursorStore();
  await store.save({
    streamUrl: url,
    nextOffset: '-1',
    serverLowerBoundVersion: {},
    updatedAtMs: 0,
  });
  const readerDoc = new LoroDoc();
  let persisted: Uint8Array | undefined;
  const reader = new StreamsCrdt({
    streamUrl: url,
    adapter: createLoroDocAdapter(readerDoc),
    remoteCursorStore: {
      load: (streamUrl) => store.load(streamUrl),
      async save(cursor) {
        expect(persisted).toBeDefined();
        await store.save(cursor);
      },
    },
    beforeRemoteCursorSave: async () => {
      persisted = readerDoc.export({ mode: 'snapshot' });
    },
    e2ee: {
      provider: attackerProvider({ ...writerAuthor, device: 'guest' }),
      readPolicy: 'encrypted-only',
      writePolicy: 'encrypt',
    },
    fetch: fetchWithAdmission,
  });
  const failed = await reader.sync();
  expect(failed.ok).toBe(false);
  expect((await store.load(url))?.nextOffset).toBe('-1');
  expect(persisted).toBeUndefined();
  await reader.close();
  writerDoc.free();
  readerDoc.free();
});
