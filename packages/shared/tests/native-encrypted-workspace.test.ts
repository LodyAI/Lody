import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer } from '@loro-dev/sqlite-riverrun';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import { afterEach, describe, expect, it } from 'vitest';
import { connectNativeRepo } from '../src/node/native-repo';
import { LoroDoc } from 'loro-crdt';
import { commitDocUpdates, createDocRoom } from '../src/node/native-docs';
import {
  attachNativeEncryptedWorkspace,
  NATIVE_CONTENT_REMOTE_ID,
  nativePendingWipeMarker,
  type NativePendingWipe,
} from '../src/node/native-encrypted-workspace';
import { createLoroStreamUrl, getLoroStreamIdForDocId, type WorkspaceId } from '../src';

const hostScript = fileURLToPath(new URL('./fixtures/native-repo-host.mjs', import.meta.url));
/** While set, a relaunch starts nothing: the host stays down. */
let hostBlocked = false;
const launcher = () =>
  hostBlocked
    ? { command: process.execPath, args: ['-e', 'process.exit(1)'] }
    : { command: process.execPath, args: [hostScript] };
const ws = 'ws-e2ee-native';
const bucketId = 'lody-e2ee-test';
const genesis = new Uint8Array(32).fill(0x42);
const genesisHash = Buffer.from(genesis).toString('hex');
const epochKey = new Uint8Array(32).fill(0x07);
const seeds = { a: new Uint8Array(32).fill(0x11), b: new Uint8Array(32).fill(0x22) };
const room = { kind: 'loro_doc' as const, id: 'session-0001' };
/** The Ed25519 public key of a seed, as the ledger admits it. */
const publicKey = (seed: Uint8Array) =>
  new Uint8Array(
    createPublicKey(
      createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
        format: 'der',
        type: 'pkcs8',
      })
    )
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
  );
const admitted = [publicKey(seeds.a), publicKey(seeds.b)];

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  hostBlocked = false;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

async function streamsServer() {
  const dir = await mkdtemp(join(tmpdir(), 'lody-native-streams-'));
  const server = await startDevServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(dir, 'riverrun.sqlite'),
    protocol: 'http1',
  });
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  cleanups.push(() => server.close());
  await fetch(`${server.baseUrl}/ds/${bucketId}`, { method: 'PUT' });
  return server.baseUrl as string;
}

async function hostPid(dataDir: string) {
  return (JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')) as { pid: number }).pid;
}

function memoryWipe(initial = false): NativePendingWipe & { pending: boolean } {
  const marker = {
    pending: initial,
    read: async () => marker.pending,
    write: async () => void (marker.pending = true),
    clear: async () => void (marker.pending = false),
  };
  return marker;
}

/** One device: its own engine data dir, host and connection, keys installed by "core". */
async function device(name: 'a' | 'b', baseUrl: string) {
  const dataDir = await mkdtemp(join(tmpdir(), `lody-native-e2ee-${name}-`));
  const connection = await connectNativeRepo({ launcher, dataDir });
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  cleanups.push(async () => process.kill(await hostPid(dataDir), 'SIGTERM'));
  cleanups.push(() => connection.close());
  const client = connection.client;
  const writer = `device-${name}`;
  let tokens = 0;
  let syncs = 0;
  const network = { online: true };
  /** The verified ledger's admitted devices, as this device last ingested them. */
  const ledger = { admitted };
  const attach = (pendingWipe: NativePendingWipe = memoryWipe(), onOpenPending?: () => void) =>
    attachNativeEncryptedWorkspace({
      client,
      workspaceId: ws,
      genesisHash,
      writer,
      contentToken: async () => {
        if (!network.online) throw new Error('synthetic_offline');
        tokens += 1;
        return { token: `token-${tokens}`, bucketId, gatewayBaseUrl: baseUrl, expiresIn: 480 };
      },
      syncKeyring: async () => {
        syncs += 1;
        await client.keyringConfigure(ws, genesis);
        await client.keyringAdmit(ws, ledger.admitted);
        await client.keyringInstallEpoch(ws, 0, epochKey);
        await client.keyringSetSigner(ws, writer, seeds[name]);
        await client.keyringSetSealEpoch(ws, 0);
        return { mayWrite: true };
      },
      pendingWipe,
      onOpenPending,
    });
  return { dataDir, client, writer, attach, network, ledger, syncs: () => syncs };
}

/** A replica's local edit, committed as the daemon and desktop commit theirs. */
const replicas = new WeakMap<RepoClient, LoroDoc>();
const write = (client: RepoClient, note: string) => {
  let doc = replicas.get(client);
  if (!doc) replicas.set(client, (doc = new LoroDoc()));
  const from = doc.oplogVersion();
  doc.getMap('session').set('note', note);
  doc.commit();
  return commitDocUpdates(client, ws, room.id, [doc.export({ mode: 'update', from })]);
};

describe('native encrypted workspace', () => {
  it('replicates encrypted rooms through the legacy stream URL, and the server sees only ciphertext', async () => {
    const baseUrl = await streamsServer();
    const a = await device('a', baseUrl);
    const b = await device('b', baseUrl);
    const wa = await a.attach();
    const wb = await b.attach();
    cleanups.push(async () => wa.close());
    cleanups.push(async () => wb.close());
    for (const d of [a, b]) await createDocRoom(d.client, ws, room.id);

    await write(a.client, 'sealed-in-a');
    expect((await a.client.syncNamespace(ws, NATIVE_CONTENT_REMOTE_ID)).blockedRooms).toBe(0);
    await b.client.syncRooms(ws, [room], NATIVE_CONTENT_REMOTE_ID);
    expect(JSON.stringify((await b.client.readDoc(ws, room)).value)).toContain('sealed-in-a');

    const url = createLoroStreamUrl({
      bucketId,
      streamId: getLoroStreamIdForDocId(ws as WorkspaceId, room.id),
      baseUrl,
    });
    const body = Buffer.from(await (await fetch(`${url}?offset=-1`)).arrayBuffer());
    expect(body.length).toBeGreaterThan(0);
    expect(body.includes('sealed-in-a')).toBe(false);
    expect(body.includes(Buffer.from('LSCE'))).toBe(true);
  }, 60_000);

  it('opens without a content token, keeps local writes, and uploads them once one is issued', async () => {
    const baseUrl = await streamsServer();
    const a = await device('a', baseUrl);
    const b = await device('b', baseUrl);
    a.network.online = false;
    const wa = await a.attach();
    cleanups.push(async () => wa.close());
    await createDocRoom(a.client, ws, room.id);
    await write(a.client, 'written-offline');
    expect(JSON.stringify((await a.client.readDoc(ws, room)).value)).toContain('written-offline');

    a.network.online = true;
    await wa.refresh();
    expect((await a.client.syncNamespace(ws, NATIVE_CONTENT_REMOTE_ID)).blockedRooms).toBe(0);
    const wb = await b.attach();
    cleanups.push(async () => wb.close());
    await createDocRoom(b.client, ws, room.id);
    await b.client.syncRooms(ws, [room], NATIVE_CONTENT_REMOTE_ID);
    expect(JSON.stringify((await b.client.readDoc(ws, room)).value)).toContain('written-offline');
  }, 60_000);

  it('a frame from a writer the installed ledger does not admit yet asks for a catch-up, then opens', async () => {
    const baseUrl = await streamsServer();
    const a = await device('a', baseUrl);
    const b = await device('b', baseUrl);
    const wa = await a.attach();
    cleanups.push(async () => wa.close());
    await createDocRoom(a.client, ws, room.id);
    await write(a.client, 'from-a');
    await a.client.syncNamespace(ws, NATIVE_CONTENT_REMOTE_ID);

    b.ledger.admitted = [publicKey(seeds.b)];
    let asked = 0;
    const caughtUp = Promise.withResolvers<void>();
    const wb = await b.attach(memoryWipe(), () => {
      asked += 1;
      b.ledger.admitted = admitted;
      void wb.refresh().then(caughtUp.resolve, caughtUp.reject);
    });
    cleanups.push(async () => wb.close());
    await createDocRoom(b.client, ws, room.id);
    await b.client.syncRooms(ws, [room], NATIVE_CONTENT_REMOTE_ID);
    await caughtUp.promise;
    expect(asked).toBeGreaterThan(0);
    await expect
      .poll(
        async () => {
          await b.client.syncRooms(ws, [room], NATIVE_CONTENT_REMOTE_ID);
          return JSON.stringify((await b.client.readDoc(ws, room)).value);
        },
        { timeout: 30_000 }
      )
      .toContain('from-a');
  }, 60_000);

  it('a removal while the host is down finishes once the host is back', async () => {
    const baseUrl = await streamsServer();
    const a = await device('a', baseUrl);
    const marker = nativePendingWipeMarker(a.dataDir, ws);
    const wa = await a.attach(marker);
    await createDocRoom(a.client, ws, room.id);
    await write(a.client, 'before-removal');
    const nsFile = join(a.dataDir, 'namespaces', `ns_${Buffer.from(ws).toString('hex')}.sqlite3`);
    expect(existsSync(nsFile)).toBe(true);

    hostBlocked = true;
    process.kill(await hostPid(a.dataDir), 'SIGKILL');
    await expect.poll(() => a.client.connectionState, { timeout: 30_000 }).not.toBe('connected');
    await expect(wa.wipe()).rejects.toThrow();
    expect(await marker.read()).toBe(true);

    hostBlocked = false;
    await expect.poll(() => marker.read(), { timeout: 60_000 }).toBe(false);
    expect(existsSync(nsFile)).toBe(false);
  }, 90_000);

  it('reinstalls keys after the host restarts, and finishes a pending wipe before reopening', async () => {
    const baseUrl = await streamsServer();
    const a = await device('a', baseUrl);
    const wa = await a.attach();
    cleanups.push(async () => wa.close());
    await createDocRoom(a.client, ws, room.id);
    await write(a.client, 'before-crash');
    await a.client.syncNamespace(ws, NATIVE_CONTENT_REMOTE_ID);
    const before = a.syncs();

    process.kill(await hostPid(a.dataDir), 'SIGKILL');
    await expect.poll(() => a.syncs() > before, { timeout: 30_000 }).toBe(true);
    await write(a.client, 'after-crash');
    await expect
      .poll(async () => (await a.client.syncNamespace(ws, NATIVE_CONTENT_REMOTE_ID)).blockedRooms, {
        timeout: 30_000,
      })
      .toBe(0);

    wa.close();
    const marker = nativePendingWipeMarker(a.dataDir, ws);
    await marker.write();
    const nsFile = join(a.dataDir, 'namespaces', `ns_${Buffer.from(ws).toString('hex')}.sqlite3`);
    expect(existsSync(nsFile)).toBe(true);
    const reopened = await a.attach(marker);
    cleanups.push(async () => reopened.close());
    expect(await marker.read()).toBe(false);
    await expect(a.client.readDoc(ws, room)).rejects.toThrow();
    await createDocRoom(a.client, ws, room.id);
    await a.client.syncRooms(ws, [room], NATIVE_CONTENT_REMOTE_ID);
    expect(JSON.stringify((await a.client.readDoc(ws, room)).value)).toContain('after-crash');
  }, 90_000);
});
