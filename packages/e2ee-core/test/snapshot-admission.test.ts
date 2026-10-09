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
import { streamsContentAdditionalData } from '../src/streams-content';
import { listenDurableContent } from '../bench/ds-cas-server';
import { admitDeviceOp, append, ed25519, hex, signGenesis } from './ledger-fixtures';

const genesis = 'ab'.repeat(32);
const resource = 'doc-1';
const epochKey = new Uint8Array(32).fill(9);
const writerAuthor = { actor: 'A', memberInstance: 'A1', device: '' };
const guestAuthor = { actor: 'A', memberInstance: 'A1', device: '' };
const strangerAuthor = { actor: 'B', memberInstance: 'B1', device: '' };

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
  writerAuthor.device = writerPublic;
  guestAuthor.device = guestPublic;
  strangerPublic = toHex(
    new Uint8Array(await crypto.subtle.exportKey('raw', strangerPair.publicKey))
  );
  strangerAuthor.device = strangerPublic;
});

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

function keys(device: string): { pair: CryptoKeyPair; publicKey: string } {
  if (device === writerPublic) return { pair: writerPair, publicKey: writerPublic };
  if (device === guestPublic) return { pair: guestPair, publicKey: guestPublic };
  return { pair: strangerPair, publicKey: strangerPublic };
}

function cipher() {
  return new ContentCipher({
    authorize(header) {
      if (header.device === writerPublic) return writerPublic;
      if (header.device === guestPublic) return guestPublic;
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
    additionalData: (header) =>
      streamsContentAdditionalData(wrapSnapshotEnvelope(header, new Uint8Array())),
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
    expectedPurpose: 'doc-snapshot' as const,
  };
}

it('admits a writer snapshot and rejects guest, stranger, and submitter/signer mismatch', async () => {
  const clock = { now: 1_000 };
  const writable = new Set([writerPublic]);
  const host = publication(writable, clock);
  const writerBody = await attackerSnapshot(writerAuthor, '10');
  const accepted = await host.admit(put('10', writerBody, writerPublic, clock));
  expect(accepted.status).toBe('accepted');
  expect(accepted.header?.device).toBe(writerPublic);
  const tampered = writerBody.slice();
  tampered[tampered.length - 1]! ^= 1;
  await expect(host.admit(put('20', tampered, writerPublic, clock))).rejects.toThrow();
  await expect(
    host.admit(put('20', writerBody, writerPublic, clock, { genesis: 'cd'.repeat(32) }))
  ).rejects.toMatchObject({ message: 'bad-content-signature' });
  await expect(
    host.admit(put('20', writerBody, writerPublic, clock, { resource: 'other' }))
  ).rejects.toMatchObject({ message: 'bad-content-signature' });
  await expect(
    host.admit({
      ...put('20', writerBody, writerPublic, clock),
      expectedPurpose: 'flock-snapshot',
    })
  ).rejects.toMatchObject({ message: 'bad-content-signature' });

  const guestBody = await attackerSnapshot(guestAuthor, '20');
  await expect(host.admit(put('20', guestBody, guestPublic, clock))).rejects.toMatchObject({
    message: 'unauthorized',
  });

  const strangerBody = await attackerSnapshot(strangerAuthor, '20');
  await expect(host.admit(put('20', strangerBody, strangerPublic, clock))).rejects.toThrow();

  await expect(host.admit(put('20', writerBody, guestPublic, clock))).rejects.toMatchObject({
    message: 'snapshot-device-mismatch',
  });
  expect(host.current('docs/doc-1')?.offset).toBe('10');
});

it('rejects expired and delayed submissions without extending the original lease', async () => {
  const clock = { now: 1_000 };
  const host = publication(new Set([writerPublic]), clock);
  const body = await attackerSnapshot(writerAuthor, '10');
  const issued = 1_000;
  const expires = issued + 60_000;
  clock.now = expires;
  await expect(
    host.admit(put('10', body, writerPublic, clock, { issued, expires }))
  ).rejects.toMatchObject({ message: 'snapshot-lease-expired' });
  expect(host.current('docs/doc-1')).toBeUndefined();
  clock.now = issued;
  await expect(
    host.admit(
      put('10', body, writerPublic, clock, {
        issued,
        expires: issued + CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS + 1,
      })
    )
  ).rejects.toMatchObject({ message: 'snapshot-lease-invalid' });
});

it('review: lease expiring during real signature verification must not publish', async () => {
  const clock = { now: 1_000 };
  const expires = 61_000;
  const body = await attackerSnapshot(writerAuthor, '10');
  const host = createContentSnapshotPublication({
    cipher: new ContentCipher({
      authorize(header) {
        if (header.device !== writerPublic) throw new Error('unauthorized');
        // Deterministic elapsed time during authenticate; real Ed25519 verification follows.
        clock.now = expires;
        return writerPublic;
      },
    }),
    mayWriteDocument: () => true,
    now: () => clock.now,
  });
  await expect(
    host.admit(
      put('10', body, writerPublic, clock, {
        issued: 1_000,
        expires,
      })
    )
  ).rejects.toMatchObject({ message: 'snapshot-lease-expired' });
  expect(host.current('docs/doc-1')).toBeUndefined();
});

it('rejects when write is revoked during real signature verification', async () => {
  const clock = { now: 1_000 };
  const writable = new Set([writerPublic]);
  const body = await attackerSnapshot(writerAuthor, '10');
  const host = createContentSnapshotPublication({
    cipher: new ContentCipher({
      authorize(header) {
        if (header.device !== writerPublic) throw new Error('unauthorized');
        writable.delete(writerPublic);
        return writerPublic;
      },
    }),
    mayWriteDocument: (author) => writable.has(author.device),
    now: () => clock.now,
  });
  await expect(host.admit(put('10', body, writerPublic, clock))).rejects.toMatchObject({
    message: 'unauthorized',
  });
  expect(host.current('docs/doc-1')).toBeUndefined();
});

it('keeps the original lease while queued and ignores later mutation of the request object', async () => {
  const clock = { now: 1_000 };
  const expires = 61_000;
  const firstBody = await attackerSnapshot(writerAuthor, '10', 'first');
  const secondBody = await attackerSnapshot(writerAuthor, '20', 'second');
  const host = createContentSnapshotPublication({
    cipher: new ContentCipher({
      authorize(header) {
        if (header.device !== writerPublic) throw new Error('unauthorized');
        clock.now = expires;
        return writerPublic;
      },
    }),
    mayWriteDocument: () => true,
    now: () => clock.now,
  });
  const first = put('10', firstBody, writerPublic, clock, { issued: 1_000, expires });
  const second = put('20', secondBody, writerPublic, clock, { issued: 1_000, expires });
  const firstAdmit = host.admit(first);
  const queued = host.admit(second);
  second.leaseExpiresAt = expires + 60_000;
  await Promise.all([
    expect(firstAdmit).rejects.toMatchObject({ message: 'snapshot-lease-expired' }),
    expect(queued).rejects.toMatchObject({ message: 'snapshot-lease-expired' }),
  ]);
  expect(host.current('docs/doc-1')).toBeUndefined();
});

it('keeps content identity: identical retries are idempotent and different bytes cannot replace an offset', async () => {
  const clock = { now: 1_000 };
  const host = publication(new Set([writerPublic]), clock);
  const first = await attackerSnapshot(writerAuthor, '10', 'one');
  const second = await attackerSnapshot(writerAuthor, '10', 'two');
  expect((await host.admit(put('10', first, writerPublic, clock))).status).toBe('accepted');
  expect((await host.admit(put('10', first, writerPublic, clock))).status).toBe('idempotent');
  clock.now += CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS;
  expect((await host.admit(put('10', first, writerPublic, clock))).status).toBe('idempotent');
  clock.now = 1_000;
  await expect(host.admit(put('10', second, writerPublic, clock))).rejects.toMatchObject({
    message: 'snapshot-identity-conflict',
  });
  const later = await attackerSnapshot(writerAuthor, '20', 'later');
  expect((await host.admit(put('20', later, writerPublic, clock))).status).toBe('accepted');
  expect((await host.admit(put('10', first, writerPublic, clock))).status).toBe('idempotent');
  expect(host.current('docs/doc-1')?.offset).toBe('20');
  await expect(host.admit(put('5', first, writerPublic, clock))).rejects.toMatchObject({
    message: 'snapshot-offset-regression',
  });
});

it('rejects a revoked device from publishing new bytes but still opens the admitted historical snapshot', async () => {
  const clock = { now: 1_000 };
  const writable = new Set([writerPublic]);
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
  let binding = new Uint8Array();
  const sealed = await provider.seal({
    plaintext,
    context,
    additionalData: (header) => {
      binding = streamsContentAdditionalData(wrapSnapshotEnvelope(header, new Uint8Array()));
      return binding;
    },
  });
  const body = wrapSnapshotEnvelope(sealed.header, sealed.sealed);
  await host.admit(put(offset, body, writerPublic, clock));
  writable.delete(writerPublic);
  const newer = await attackerSnapshot(writerAuthor, '20', 'forged');
  await expect(host.admit(put('20', newer, writerPublic, clock))).rejects.toMatchObject({
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
    await admitDeviceOp(created.anchor, created.membershipId, machine, 'machine')
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

it('rejects recovery-device snapshots through ledger-backed host admission', async () => {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const recovery = {
    ...(await ed25519()),
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', writerPair.publicKey)),
    sign: async (bytes: Uint8Array) =>
      new Uint8Array(
        await crypto.subtle.sign('Ed25519', writerPair.privateKey, new Uint8Array(bytes))
      ),
  };
  const admitted = await append(
    created.ledger,
    owner,
    await admitDeviceOp(created.anchor, created.membershipId, recovery, 'recovery')
  );
  const device = hex(recovery.publicKey);
  const author = { actor: 'A', memberInstance: 'A1', device };
  const contentCipher = new ContentCipher({ authorize: () => device });
  const provider = createStreamsContentProvider({
    cipher: contentCipher,
    genesis,
    resource,
    model: 'loro',
    writeEpoch: 0,
    author,
    signingKey: writerPair.privateKey,
    readKey: () => epochKey,
    // Malicious writer bypasses the honest-client guard, but not host admission.
    mayWriteDocument: () => true,
  });
  const sealed = await provider.seal({
    plaintext: new TextEncoder().encode('recovery device must not publish'),
    context: {
      protocol: 'loro-streams-crdt-payload-protection',
      version: 2,
      kind: 'snapshot',
      continuationOffset: '10',
    } as PayloadProtectionContext,
    additionalData: (header) =>
      streamsContentAdditionalData(wrapSnapshotEnvelope(header, new Uint8Array())),
  });
  const host = createContentSnapshotPublication({
    cipher: contentCipher,
    now: () => 1000,
    mayWriteDocument: (signer) => deviceMayWriteDocument(admitted.ledger.state, signer.device),
  });
  expect(deviceMayWriteDocument(admitted.ledger.state, device)).toBe(false);
  await expect(
    host.admit(put('10', wrapSnapshotEnvelope(sealed.header, sealed.sealed), device, { now: 1000 }))
  ).rejects.toMatchObject({ message: 'unauthorized' });
  expect(host.current('docs/doc-1')).toBeUndefined();
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
  const host = publication(new Set([writerPublic]), clock);
  const { server, streamUrl } = await listenDurableContent(undefined, {
    admitSnapshot: (input) =>
      host.admit({
        ...input,
        expectedGenesis: genesis,
        expectedResource: resource,
        expectedPurpose: 'doc-snapshot' as const,
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
      for (const [key, value] of Object.entries(headersFor(writerPublic))) headers.set(key, value);
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
  expect(uploaded).toMatchObject({ ok: true });
  const head = await fetch(url, { method: 'HEAD' });
  const offset = head.headers.get('Stream-Snapshot-Offset');
  expect(offset && offset !== '-1').toBe(true);
  const forged = await attackerSnapshot(writerAuthor, offset!, 'forged');
  const replace = await fetch(`${url}/snapshot/${offset}`, {
    method: 'PUT',
    headers: headersFor(writerPublic),
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
      load: (urlToLoad) => store.load(urlToLoad),
      async save(cursor) {
        expect(persisted).toBeDefined();
        await store.save(cursor);
      },
    },
    beforeRemoteCursorSave: async () => {
      persisted = readerDoc.export({ mode: 'snapshot' });
    },
    e2ee: {
      provider: attackerProvider({ ...writerAuthor, device: guestPublic }),
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

it('host reconstructs exact SDK AAD and rejects old binding revisions before storing a snapshot', async () => {
  const clock = { now: 1000 };
  const host = publication(new Set([writerPublic]), clock);
  const provider = attackerProvider(writerAuthor);
  const sealed = await provider.seal({
    plaintext: new TextEncoder().encode('untrusted binding'),
    context: {
      protocol: 'loro-streams-crdt-payload-protection',
      version: 2,
      kind: 'snapshot',
      continuationOffset: '10',
    } as PayloadProtectionContext,
    additionalData: () => new Uint8Array([1, 2, 3]),
  });
  const body = wrapSnapshotEnvelope(sealed.header, sealed.sealed);
  await expect(host.admit(put('10', body, writerPublic, clock))).rejects.toMatchObject({
    message: 'bad-content-signature',
  });
  expect(host.current('docs/doc-1')).toBeUndefined();
  const old = await attackerSnapshot(writerAuthor, '10');
  old[10] = 2;
  await expect(host.admit(put('10', old, writerPublic, clock))).rejects.toMatchObject({
    message: 'invalid-snapshot-envelope',
  });
  expect(host.current('docs/doc-1')).toBeUndefined();
  const valid = await attackerSnapshot(writerAuthor, '10');
  expect((await host.admit(put('10', valid, writerPublic, clock))).status).toBe('accepted');
});
