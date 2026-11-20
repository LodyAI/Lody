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
import { createDocRoom } from '../src/node/native-docs';
import {
  attachNativeEncryptedWorkspace,
  NATIVE_CONTENT_REMOTE_ID,
  NativeWorkspaceWipedError,
  type NativePendingWipe,
} from '../src/node/native-encrypted-workspace';
import { createLoroStreamUrl, getLoroStreamIdForDocId, type WorkspaceId } from '../src';

const hostScript = fileURLToPath(new URL('./fixtures/native-repo-host.mjs', import.meta.url));
const launcher = () => ({ command: process.execPath, args: [hostScript] });
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
  const pendingWipe = memoryWipe();
  const attach = () =>
    attachNativeEncryptedWorkspace({
      client,
      workspaceId: ws,
      genesisHash,
      contentToken: async () => {
        tokens += 1;
        return { token: `token-${tokens}`, bucketId, gatewayBaseUrl: baseUrl, expiresIn: 480 };
      },
      // Stands in for core's EngineKeyringSync, which is tested against real ledgers in e2ee-core.
      syncKeyring: async () => {
        syncs += 1;
        await client.keyringConfigure(ws, genesis);
        await client.keyringAdmit(ws, admitted);
        await client.keyringInstallEpoch(ws, 0, epochKey);
        await client.keyringSetSigner(ws, writer, seeds[name]);
        await client.keyringSetSealEpoch(ws, 0);
        return { mayWrite: true };
      },
      pendingWipe,
    });
  return { dataDir, client, writer, attach, pendingWipe, syncs: () => syncs };
}

const write = (client: RepoClient, writer: string, note: string) =>
  client.applyDocPatch(ws, room, [{ op: 'set', path: ['history'], value: [{ id: note }] }], writer);

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

    await write(a.client, a.writer, 'sealed-in-a');
    expect((await a.client.syncNamespace(ws, NATIVE_CONTENT_REMOTE_ID)).blockedRooms).toBe(0);
    await b.client.syncRooms(ws, [room], NATIVE_CONTENT_REMOTE_ID);
    expect(JSON.stringify((await b.client.readDoc(ws, room)).value)).toContain('sealed-in-a');

    // Same stream legacy clients use, holding ciphertext only.
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

  it('reinstalls keys after the host restarts, and finishes a pending wipe before reopening', async () => {
    const baseUrl = await streamsServer();
    const a = await device('a', baseUrl);
    const wa = await a.attach();
    cleanups.push(async () => wa.close());
    await createDocRoom(a.client, ws, room.id);
    await write(a.client, a.writer, 'before-crash');
    await a.client.syncNamespace(ws, NATIVE_CONTENT_REMOTE_ID);
    const before = a.syncs();

    // The keyring lives in host memory: a crashed host comes back empty.
    process.kill(await hostPid(a.dataDir), 'SIGKILL');
    await expect.poll(() => a.syncs() > before, { timeout: 30_000 }).toBe(true);
    await write(a.client, a.writer, 'after-crash');
    await expect
      .poll(async () => (await a.client.syncNamespace(ws, NATIVE_CONTENT_REMOTE_ID)).blockedRooms, {
        timeout: 30_000,
      })
      .toBe(0);

    // Removal: the marker survives a host that is down; the next attach finishes the wipe.
    await a.pendingWipe.write();
    wa.close();
    const nsFile = join(a.dataDir, 'namespaces', `ns_${Buffer.from(ws).toString('hex')}.sqlite3`);
    expect(existsSync(nsFile)).toBe(true);
    await expect(a.attach()).rejects.toBeInstanceOf(NativeWorkspaceWipedError);
    expect(a.pendingWipe.pending).toBe(false);
    expect(existsSync(nsFile)).toBe(false);
    expect(await a.client.getRemoteStatus(ws)).toEqual([]);
  }, 90_000);
});
