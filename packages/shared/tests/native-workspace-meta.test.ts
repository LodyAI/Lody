import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { META_ROOM, type RepoClient } from '@loro-dev/loro-repo-client';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import {
  ExternalMetadataNotCommittedError,
  LoroRepo,
  type JsonObject,
  type RepoEvent,
} from 'loro-repo';

const notCommitted = (reason: string) => new ExternalMetadataNotCommittedError(reason);
import { Flock } from '@loro-dev/flock-wasm';
import { createNativeFlockDocs } from '../src/node/native-flock-docs';
import { connectNativeRepo, importLegacyRoom, type LegacyFlockBundle } from '../src/node/native-repo';
import {
  createNativeWorkspaceMeta,
} from '../src/node/native-workspace-meta';

const hostScript = fileURLToPath(new URL('./fixtures/native-repo-host.mjs', import.meta.url));
const launcher = () => ({ command: process.execPath, args: [hostScript] });
const ns = 'ws-native-meta';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

async function hostPid(dataDir: string) {
  return (JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')) as { pid: number }).pid;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function untilGone(pid: number) {
  while (alive(pid)) await new Promise((resolve) => setImmediate(resolve));
}
async function killHost(dataDir: string, signal: NodeJS.Signals) {
  const pid = await hostPid(dataDir);
  process.kill(pid, signal);
  await untilGone(pid);
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'lody-native-meta-'));
  const connection = await connectNativeRepo({ launcher, dataDir });
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  cleanups.push(() => killHost(dataDir, 'SIGTERM'));
  cleanups.push(() => connection.close());
  return { dataDir, connection };
}

/** A second process's connection (desktop main in production). */
async function peer(dataDir: string) {
  const client = await connectEngine(dataDir, { queueWhileReconnecting: false });
  cleanups.push(() => client.close());
  return client;
}

async function nativeRepo(client: RepoClient) {
  const meta = createNativeWorkspaceMeta(client, ns, notCommitted);
  const repo = await LoroRepo.createWithExternalMetadata<JsonObject>({}, meta);
  cleanups.push(() => meta.close());
  cleanups.push(() => repo.destroy());
  const events: RepoEvent<JsonObject>[] = [];
  repo.watch((event) => events.push(event));
  return { repo, events };
}

function nextEvent(events: RepoEvent<JsonObject>[], match: (event: RepoEvent<JsonObject>) => boolean) {
  const start = events.length;
  return new Promise<RepoEvent<JsonObject>>((resolve) => {
    const poll = () => {
      const found = events.slice(start).find(match);
      if (found) resolve(found);
      else setImmediate(poll);
    };
    poll();
  });
}

async function legacyBundle() {
  // A real legacy Meta Flock: soft deletions, removed fields, an unknown field
  // and a named Flock with expiry.
  const legacy = await LoroRepo.create<JsonObject>({});
  await legacy.upsertDocMeta('session-a', { title: 'A', futureField: { nested: [1, 2] } });
  await legacy.upsertDocMeta('session-b', { title: 'B', pinned: true });
  await legacy.upsertDocMeta('session-b', { pinned: undefined });
  await legacy.upsertDocMeta('session-c', { title: 'C' });
  await legacy.deleteDoc('session-c');
  const flock = await legacy.openFlockDoc('ws:fi:one');
  flock.flock.put(['x'], 1);
  await legacy.persistFlockDocNow('ws:fi:one', flock.flock);
  const bundle = legacy.getMeta().exportJson() as LegacyFlockBundle;
  await legacy.destroy();
  return bundle;
}

describe('native Workspace Meta', () => {
  it('migrates legacy Meta losslessly and publishes once', async () => {
    const { connection } = await setup();
    const bundle = await legacyBundle();
    expect(await importLegacyRoom(connection.client, ns, META_ROOM, 'cli', async () => bundle)).toBe(
      'imported'
    );
    // Registers keep their original clocks, tombstones included.
    const { registers } = await connection.client.flockReadRegisters(ns, META_ROOM);
    for (const [key, record] of Object.entries(bundle.entries)) {
      const register = registers.find((row) => JSON.stringify(row.key) === key);
      const clock = register?.clock;
      expect(`${clock?.physicalTime},${clock?.logicalCounter},${clock?.peerId}`).toBe(record.c);
      expect(register?.deleted).toBe(record.d === undefined);
    }
    const { repo } = await nativeRepo(connection.client);
    expect((await repo.getDocMeta('session-a'))?.meta).toEqual({
      title: 'A',
      futureField: { nested: [1, 2] },
    });
    expect((await repo.getDocMeta('session-b'))?.meta).toEqual({ title: 'B' });
    expect((await repo.getDocMeta('session-c'))?.deleted).toBe(true);
    expect((await repo.getFlockDoc('ws:fi:one'))?.deleted).toBe(false);
    // A published source is not imported again, even if its replica changed.
    expect(
      await importLegacyRoom(connection.client, ns, META_ROOM, 'cli', () => {
        throw new Error('must not load');
      })
    ).toBe('already-published');
  });

  it('shares one host between processes; one side closing leaves the other working', async () => {
    const { dataDir, connection } = await setup();
    const other = await peer(dataDir);
    const daemon = await nativeRepo(connection.client);
    const main = await nativeRepo(other);

    const seen = nextEvent(main.events, (e) => e.kind === 'doc-metadata' && e.docId === 'session-1');
    await daemon.repo.upsertDocMeta('session-1', { title: 'from daemon' });
    expect(await seen).toMatchObject({ patch: { title: 'from daemon' }, by: 'sync' });
    // A write by the other side is visible to its own repo on return.
    await main.repo.upsertDocMeta('session-1', { lastReadAt: 5 });
    expect((await main.repo.getDocMeta('session-1'))?.meta).toEqual({
      title: 'from daemon',
      lastReadAt: 5,
    });

    await connection.close();
    await main.repo.deleteDoc('session-1');
    expect((await main.repo.getDocMeta('session-1'))?.deleted).toBe(true);
  });

  it('recovers every view from a new snapshot after the host crashes', async () => {
    const { dataDir, connection } = await setup();
    const daemon = await nativeRepo(connection.client);
    await daemon.repo.upsertDocMeta('session-1', { title: 'before' });

    const reconnected = new Promise<void>((resolve) => {
      const stop = connection.client.onConnectionStateChange((state) => {
        if (state === 'connected') {
          stop();
          resolve();
        }
      });
    });
    await killHost(dataDir, 'SIGKILL');
    // The connection relaunches the host itself; the old pid cannot return.
    await reconnected;
    const reset = nextEvent(daemon.events, (e) => e.kind === 'doc-metadata' && e.docId === 'x');
    // Another process writes against the relaunched host.
    const other = await peer(dataDir);
    const writer = createNativeWorkspaceMeta(other, ns, notCommitted);
    cleanups.push(() => writer.close());
    await writer.open(() => {});
    await writer.commit({ kind: 'upsert-doc', docId: 'x', patch: { title: 'after' } });
    await reset;
    expect((await daemon.repo.getDocMeta('session-1'))?.meta).toEqual({ title: 'before' });
    await daemon.repo.upsertDocMeta('session-1', { title: 'again' });
    expect((await daemon.repo.getDocMeta('session-1'))?.meta).toEqual({ title: 'again' });
  });

  it('applies concurrent field writes from two writers without losing either', async () => {
    const { dataDir, connection } = await setup();
    const a = createNativeWorkspaceMeta(connection.client, ns, notCommitted);
    const b = createNativeWorkspaceMeta(await peer(dataDir), ns, notCommitted);
    cleanups.push(() => a.close(), () => b.close());
    await Promise.all([a.open(() => {}), b.open(() => {})]);
    await Promise.all([
      a.commit({ kind: 'upsert-doc', docId: 'd', patch: { left: 1 } }),
      b.commit({ kind: 'upsert-doc', docId: 'd', patch: { right: 2 } }),
      b.commit({ kind: 'ensure-doc', docId: 'd' }),
    ]);
    const { repo } = await nativeRepo(connection.client);
    expect((await repo.getDocMeta('d'))?.meta).toEqual({ left: 1, right: 2 });
  });

  it('keeps writes made by another process while a large view is still paging in', async () => {
    const { dataDir, connection } = await setup();
    const entries: LegacyFlockBundle['entries'] = {};
    for (let i = 0; i < 6000; i++) {
      const id = `doc-${i.toString().padStart(5, '0')}`;
      entries[JSON.stringify(['e', id])] = { c: `${1_000 + i},0,seed`, d: true };
      entries[JSON.stringify(['m', id, 'n'])] = { c: `${1_000 + i},1,seed`, d: 0 };
    }
    await importLegacyRoom(connection.client, ns, META_ROOM, 'seed', async () => ({ version: 0, entries }));
    const writer = createNativeWorkspaceMeta(await peer(dataDir), ns, notCommitted);
    cleanups.push(() => writer.close());
    await writer.open(() => {});
    // Writes race the paged load across several pages of the 12k-row room.
    const touched = ['doc-00000', 'doc-02999', 'doc-05999', 'doc-new'];
    const [{ repo }] = await Promise.all([
      nativeRepo(connection.client),
      (async () => {
        for (let round = 1; round <= 5; round++)
          for (const id of touched)
            await writer.commit({ kind: 'upsert-doc', docId: id, patch: { n: round } });
        await writer.commit({ kind: 'delete-doc', docId: 'doc-03000' });
      })(),
    ]);
    const settled = new Promise<void>((resolve) => {
      const check = async () => {
        const last = await repo.getDocMeta('doc-03000');
        if (last?.deleted) resolve();
        else setImmediate(() => void check());
      };
      void check();
    });
    await settled;
    for (const id of touched) expect((await repo.getDocMeta(id))?.meta).toEqual({ n: 5 });
    expect(repo.listDocSync().length).toBe(6001);
  });
});


describe('natively owned named Flock documents', () => {
  const CATALOG = 'ws:wf:workspace';
  const owner = (client: RepoClient) =>
    createNativeFlockDocs(client, ns, (id) => id === CATALOG, (file) =>
      Flock.fromFile(file).exportJson()
    );
  const replica = async (client: RepoClient) => {
    const repo = await LoroRepo.create({ externalFlockDocs: owner(client) });
    cleanups.push(() => repo.destroy());
    return { repo, handle: await repo.openFlockDoc(CATALOG) };
  };
  const until = async (check: () => boolean) => {
    while (!check()) await new Promise((resolve) => setImmediate(resolve));
  };

  it('migrates the legacy body and converges a daemon and a renderer replica', async () => {
    const { dataDir, connection } = await setup();
    const legacy = new Flock('legacy');
    legacy.put(['mcpServer', 'a'], { name: 'a' });
    legacy.delete(['mcpServer', 'gone']);
    await importLegacyRoom(connection.client, ns, { kind: 'flock', id: CATALOG }, 'cli', async () =>
      legacy.exportJson() as LegacyFlockBundle
    );
    const daemon = await replica(connection.client);
    const renderer = await replica(await peer(dataDir));
    expect(daemon.handle.flock.get(['mcpServer', 'a'])).toEqual({ name: 'a' });

    // Same key from both sides, plus one key each.
    daemon.handle.flock.put(['role', 'shared'], 'daemon');
    renderer.handle.flock.put(['role', 'shared'], 'renderer');
    daemon.handle.flock.put(['role', 'daemon'], 1);
    renderer.handle.flock.put(['role', 'renderer'], 2);
    await Promise.all([
      daemon.repo.persistFlockDocNow(CATALOG, daemon.handle.flock),
      renderer.repo.persistFlockDocNow(CATALOG, renderer.handle.flock),
    ]);
    const settled = (flock: Flock) =>
      flock.get(['role', 'daemon']) === 1 && flock.get(['role', 'renderer']) === 2;
    await until(() => settled(daemon.handle.flock) && settled(renderer.handle.flock));
    const native = Flock.fromFile(
      (await connection.client.exportFlockRaw(ns, { kind: 'flock', id: CATALOG })).bytes
    );
    const winner = native.get(['role', 'shared']);
    expect(['daemon', 'renderer']).toContain(winner);
    await until(
      () =>
        daemon.handle.flock.get(['role', 'shared']) === winner &&
        renderer.handle.flock.get(['role', 'shared']) === winner
    );
    expect(native.get(['role', 'daemon'])).toBe(1);
    expect(native.get(['role', 'renderer'])).toBe(2);
  });

  it('keeps a change pending while the host is down and commits it after relaunch', async () => {
    const { dataDir, connection } = await setup();
    const daemon = await replica(connection.client);
    const reconnected = new Promise<void>((resolve) => {
      const stop = connection.client.onConnectionStateChange((state) => {
        if (state === 'connected') {
          stop();
          resolve();
        }
      });
    });
    await killHost(dataDir, 'SIGKILL');
    daemon.handle.flock.put(['row'], 'offline');
    await expect(daemon.repo.persistFlockDocNow(CATALOG, daemon.handle.flock)).rejects.toThrow();
    expect(daemon.handle.flock.get(['row'])).toBe('offline');
    await reconnected;
    await daemon.repo.flush();
    const native = Flock.fromFile(
      (await connection.client.exportFlockRaw(ns, { kind: 'flock', id: CATALOG })).bytes
    );
    expect(native.get(['row'])).toBe('offline');
  });
});
