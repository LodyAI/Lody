import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { NativeRepoHostLegacy } from './native-repo-host';
import { connectEngine, readEngineEndpoint } from '@loro-dev/loro-repo-client/node';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import { LoroRepo } from 'loro-repo';
import { StreamsTransportAdapter } from 'loro-repo/transport/streams';
import { readNativeFlockSnapshot } from './native-repo-migration';
import { afterEach, describe, expect, it } from 'vitest';
import { getLoroStreamIdForDocId, type WorkspaceId } from '@lody/shared';
import { streamsFixture } from './native-repo-remote.test-support';
import {
  createNativeRepoPlaintextRemoteLegacy,
  prepareNativeCatalogRemoteSeedLegacy,
  nativeCatalogMigrationWriter,
} from './native-repo-remote';

const sdk = createRequire(path.resolve(import.meta.dirname, '../../../../electron/package.json'));
const workspaceId = 'synthetic-remote-workspace' as WorkspaceId;
const namespace = 'account-bound-native-workspace';
const remoteId = 'ordinary-workspace';
const roots = new Set<string>();
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse())
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Native remote fixture cleanup failed; synthetic state retained'
    );
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

async function independentEngine(root: string, dataDir: string) {
  const entry = path.join(root, 'native-host.mjs');
  await build({
    entryPoints: [path.join(import.meta.dirname, 'native-repo-host-entry.ts')],
    outfile: entry,
    platform: 'node',
    format: 'esm',
    bundle: true,
    // Keep this synthetic loopback fixture outside system proxies.
    banner: { js: "process.env.NO_PROXY='127.0.0.1,localhost';" },
    plugins: [
      {
        name: 'external-native-package',
        setup(builder) {
          builder.onResolve({ filter: /^@loro-dev\/loro-repo-engine$/ }, () => ({
            path: sdk.resolve('@loro-dev/loro-repo-engine'),
            external: true,
          }));
        },
      },
    ],
  });
  const owner = new NativeRepoHostLegacy({ dataDir, entry });
  cleanup.push(() => owner.close());
  await owner.client();
  return { endpoint: await readEngineEndpoint(dataDir), stop: () => owner.close() };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-native-remote-'));
  roots.add(root);
  const cloud = await streamsFixture(root);
  cleanup.push(cloud.close);
  const dataDir = path.join(root, 'engine');
  const engine = await independentEngine(root, dataDir);
  const client = await connectEngine(dataDir);
  cleanup.push(() => client.close());
  return {
    root,
    dataDir,
    cloud,
    engine,
    client,
    connect: (rooms: Parameters<typeof createNativeRepoPlaintextRemoteLegacy>[0]['rooms']) =>
      createNativeRepoPlaintextRemoteLegacy({
        content: { mode: 'plaintext' },
        workspaceId,
        binding: 'synthetic-account/workspace',
        namespace,
        remoteId,
        dataDir,
        engineRunId: engine.endpoint.runId,
        rooms,
        streamsTokens: cloud.tokens,
        fetch: globalThis.fetch,
      }),
  };
}

describe('native plaintext workspace remote', () => {
  it('uses the old physical Streams paths, authenticates privately, and proves a room-specific persisted tail', async () => {
    const { dataDir, cloud, client, connect } = await fixture();
    const rooms = [
      { kind: 'meta', id: 'meta' },
      ...['wf:workspace', 'mf:machine', 'sr', 'fi:owner', 'fis:owner'].map((id) => ({
        kind: 'flock',
        id: `${workspaceId}:${id}`,
      })),
      ...[
        'session-one',
        'schedule-one',
        'preview-comment-one',
        'task-one',
        'session-comment-one',
      ].map((id) => ({ kind: 'loro_doc', id })),
    ] as Parameters<typeof createNativeRepoPlaintextRemoteLegacy>[0]['rooms'];
    const remoteFlock = new Flock();
    remoteFlock.put(['project', 'cloud'], 'from legacy snapshot');
    for (const room of rooms) {
      await client.createRoom(namespace, room);
      const id =
        room.kind === 'meta'
          ? `${workspaceId}:meta`
          : room.kind === 'loro_doc'
            ? getLoroStreamIdForDocId(workspaceId, room.id)
            : room.id;
      if (!id.includes(':fi:') && !id.includes(':fis:')) {
        cloud.seed(
          id,
          room.kind === 'loro_doc'
            ? new LoroDoc().export({ mode: 'snapshot' })
            : remoteFlock.exportFile()
        );
      }
    }
    const remote = await connect(rooms);
    cleanup.push(() => remote.releaseAuth().then(() => {}));
    await remote.syncRound();
    const wf = { kind: 'flock' as const, id: `${workspaceId}:wf:workspace` };
    expect(
      (await client.flockGet(namespace, wf, ['project', 'cloud'])).value,
      JSON.stringify(cloud.requestPaths)
    ).toBe('from legacy snapshot');
    const baseline = await remote.syncRoomToObservedTail(wf);
    expect(await remote.isCurrent(baseline)).toBe(true);
    expect(baseline.room.id).toBe(wf.id);
    for (const room of rooms.filter((room) => room.kind === 'loro_doc')) {
      expect(
        cloud.requests.some(
          (request) => request.stream === getLoroStreamIdForDocId(workspaceId, room.id)
        )
      ).toBe(true);
    }
    const fi = { kind: 'flock' as const, id: `${workspaceId}:fi:owner` };
    await client.flockBatch(namespace, fi, [{ op: 'put', key: ['file.ts'], value: true }]);
    await remote.syncRound();
    expect(
      cloud.requests.find((request) => request.method === 'PUT' && request.stream === fi.id)?.ttl
    ).toBe('15552000');
    expect(cloud.unauthorized()).toBeGreaterThan(0);
    const dbPath = path.join(
      dataDir,
      'namespaces',
      `ns_${Buffer.from(namespace).toString('hex')}.sqlite3`
    );
    for (const suffix of ['', '-wal']) {
      const bytes = await fs.readFile(dbPath + suffix);
      expect(bytes.includes(Buffer.from('synthetic-streams-expired'))).toBe(false);
      expect(bytes.includes(Buffer.from('synthetic-streams-refreshed'))).toBe(false);
    }
    expect(await remote.releaseAuth()).toEqual({ requiresHostStop: true });
    expect(await remote.isCurrent(baseline)).toBe(false);
    const database = new Database(dbPath, { readonly: true, fileMustExist: true });
    const checkpoints = database
      .prepare(
        'SELECT room_kind, room_id, cursor FROM v2_sync_checkpoints ORDER BY room_kind, room_id'
      )
      .all();
    database.close();
    // Same remote + changed room routes would make 0.1.0 delete checkpoints.
    await expect(connect([wf])).rejects.toThrow(/explicit outbox-safe migration/);
    const unchanged = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(
      unchanged
        .prepare(
          'SELECT room_kind, room_id, cursor FROM v2_sync_checkpoints ORDER BY room_kind, room_id'
        )
        .all()
    ).toEqual(checkpoints);
    unchanged.close();
    const resumed = await connect(rooms);
    cleanup.push(() => resumed.releaseAuth().then(() => {}));
    expect(await resumed.isCurrent(baseline)).toBe(false);
    expect(await resumed.isCurrent(await resumed.syncRoomToObservedTail(wf))).toBe(true);
  });

  it('does not enqueue a baseline by reimporting an already quiet-merged snapshot', async () => {
    const { root, dataDir, cloud, client, connect } = await fixture();
    const wf = { kind: 'flock' as const, id: `${workspaceId}:wf:workspace` };
    await client.createRoom(namespace, wf);
    const left = new Flock();
    left.put(['source', 'left'], { opaque: { retained: true } });
    left.put(['deleted'], 'prior');
    left.delete(['deleted']);
    const right = new Flock();
    right.put(['source', 'right'], 'offline local');
    await client.importRoomState(namespace, wf, {
      snapshot: left.exportFile(),
      enqueueOutbox: false,
    });
    await client.importRoomState(namespace, wf, {
      snapshot: right.exportFile(),
      enqueueOutbox: false,
    });
    await client.compactRoom(namespace, wf);
    const merged = readNativeFlockSnapshot({ dataDir, namespace, room: wf });
    const ack = await client.importRoomState(namespace, wf, {
      snapshot: merged.bytes,
      enqueueOutbox: true,
      writer: 'migration:stable-quiet-probe',
    });
    expect(ack.roomTxId).toBe(merged.roomTxId);
    const db = new Database(
      path.join(dataDir, 'namespaces', `ns_${Buffer.from(namespace).toString('hex')}.sqlite3`),
      { readonly: true }
    );
    expect(db.prepare('SELECT count(*) AS n FROM v2_sync_outbox').get()).toEqual({ n: 0 });
    db.close();
    cloud.seed(wf.id);
    const remote = await connect([wf]);
    cleanup.push(() => remote.releaseAuth().then(() => {}));
    await remote.syncRoomToObservedTail(wf);
    const secondDir = path.join(root, 'quiet-reader');
    const secondEngine = await independentEngine(root, secondDir);
    const second = await connectEngine(secondDir);
    cleanup.push(() => second.close());
    await second.createRoom(namespace, wf);
    const reader = await createNativeRepoPlaintextRemoteLegacy({
      content: { mode: 'plaintext' },
      workspaceId,
      binding: 'synthetic-account/workspace',
      namespace,
      remoteId,
      dataDir: secondDir,
      engineRunId: secondEngine.endpoint.runId,
      rooms: [wf],
      streamsTokens: cloud.tokens,
      fetch: globalThis.fetch,
    });
    cleanup.push(() => reader.releaseAuth().then(() => {}));
    await reader.syncRoomToObservedTail(wf);
    expect((await second.flockScan(namespace, wf)).entries).toEqual([]);
    expect((await client.flockScan(namespace, wf)).entries).toHaveLength(2);
  });

  it('seeds a full UpdateBatch when quiet merged state is attributed by compact before first remote configuration', async () => {
    const { root, dataDir, cloud, client, connect } = await fixture();
    const wf = { kind: 'flock' as const, id: `${workspaceId}:wf:workspace` };
    cloud.seed(wf.id);
    const legacy = await LoroRepo.create({});
    cleanup.push(() => legacy.destroy());
    await legacy.addTransport(
      'streams',
      new StreamsTransportAdapter({
        bucketId: 'lody',
        baseUrl: cloud.url,
        auth: 'synthetic-streams-refreshed',
        persistence: { mode: 'ephemeral' },
        flockDocStreamId: (id) => id,
      })
    );
    const old = await legacy.openFlockDoc(wf.id);
    expect((await old.syncOnce()).ok).toBe(true);
    await client.createRoom(namespace, wf);
    const a = new Flock();
    a.put(['source', 'left'], { retained: true });
    a.put(['deleted'], 'prior');
    a.delete(['deleted']);
    const b = new Flock();
    b.put(['source', 'right'], 'offline');
    await client.importRoomState(namespace, wf, { snapshot: a.exportFile(), enqueueOutbox: false });
    await client.importRoomState(namespace, wf, { snapshot: b.exportFile(), enqueueOutbox: false });
    const before = await client.flockScan(namespace, wf);
    await client.compactRoom(namespace, wf);
    const frozen = readNativeFlockSnapshot({ dataDir, namespace, room: wf });
    const prepared = await prepareNativeCatalogRemoteSeedLegacy({
      content: { mode: 'plaintext' },
      workspaceId,
      binding: 'synthetic-account/workspace',
      namespace,
      remoteId,
      migrationId: 'stable-full-baseline',
      dataDir,
      engineRunId: (await sdk('@loro-dev/loro-repo-client/node').readEngineEndpoint(dataDir)).runId,
      client,
      frozen: [frozen],
    });
    expect(prepared.writer).toBe(
      nativeCatalogMigrationWriter({
        binding: 'synthetic-account/workspace',
        namespace,
        remoteId,
        migrationId: 'stable-full-baseline',
      })
    );
    const stored = readNativeFlockSnapshot({ dataDir, namespace, room: wf });
    expect(stored.roomTxId).toBe(before.roomTxId);
    const remote = await connect([wf]);
    cleanup.push(() => remote.releaseAuth().then(() => {}));
    await remote.syncRoomToObservedTail(wf);
    await expect(
      prepareNativeCatalogRemoteSeedLegacy({
        content: { mode: 'plaintext' },
        workspaceId,
        binding: 'synthetic-account/workspace',
        namespace,
        remoteId,
        migrationId: 'stable-full-baseline',
        dataDir,
        engineRunId: (await sdk('@loro-dev/loro-repo-client/node').readEngineEndpoint(dataDir))
          .runId,
        client,
        frozen: [frozen],
      })
    ).rejects.toThrow('first remote ID');
    expect((await old.syncOnce()).ok).toBe(true);
    expect(old.flock.get(['source', 'left'])).toEqual({ retained: true });
    expect(old.flock.get(['source', 'right'])).toBe('offline');
    expect(old.flock.get(['deleted'])).toBeUndefined();
    expect(
      (cloud.db.prepare('SELECT tail FROM streams WHERE id = ?').get(wf.id) as { tail: number })
        .tail
    ).toBeGreaterThan(0);
    const secondDir = path.join(root, 'full-reader');
    const engine = await independentEngine(root, secondDir);
    const second = await connectEngine(secondDir);
    cleanup.push(() => second.close());
    await second.createRoom(namespace, wf);
    const reader = await createNativeRepoPlaintextRemoteLegacy({
      content: { mode: 'plaintext' },
      workspaceId,
      binding: 'synthetic-account/workspace',
      namespace,
      remoteId,
      dataDir: secondDir,
      engineRunId: engine.endpoint.runId,
      rooms: [wf],
      streamsTokens: cloud.tokens,
      fetch: globalThis.fetch,
    });
    cleanup.push(() => reader.releaseAuth().then(() => {}));
    await reader.syncRoomToObservedTail(wf);
    expect((await second.flockScan(namespace, wf)).entries).toEqual(
      (await client.flockScan(namespace, wf)).entries
    );
  });

  it('does not announce quiet imports to an already caught-up legacy peer by compacting an existing remote', async () => {
    const { cloud, client, connect } = await fixture();
    const wf = { kind: 'flock' as const, id: `${workspaceId}:wf:workspace` };
    cloud.seed(wf.id);
    await client.createRoom(namespace, wf);
    const remote = await connect([wf]);
    cleanup.push(() => remote.releaseAuth().then(() => {}));
    await remote.syncRoomToObservedTail(wf);
    const legacy = await LoroRepo.create({});
    cleanup.push(() => legacy.destroy());
    await legacy.addTransport(
      'streams',
      new StreamsTransportAdapter({
        bucketId: 'lody',
        baseUrl: cloud.url,
        auth: 'synthetic-streams-refreshed',
        persistence: { mode: 'ephemeral' },
        flockDocStreamId: (id) => id,
      })
    );
    const old = await legacy.openFlockDoc(wf.id);
    expect((await old.syncOnce()).ok).toBe(true);
    const imported = new Flock();
    imported.put(['quiet-import'], { retained: true }, 1);
    await client.importRoomState(namespace, wf, {
      snapshot: imported.exportFile(),
      enqueueOutbox: false,
    });
    await client.compactRoom(namespace, wf, 'migration:existing-remote');
    await remote.syncRoomToObservedTail(wf);
    const stored = cloud.db
      .prepare('SELECT snapshot, tail FROM streams WHERE id = ?')
      .get(wf.id) as { snapshot: Uint8Array; tail: number };
    expect(stored.snapshot.byteLength).toBeGreaterThan(0);
    expect(stored.tail).toBe(0);
    expect((await old.syncOnce()).ok).toBe(true);
    expect(old.flock.get(['quiet-import'])).toBeUndefined();
    expect((await client.flockGet(namespace, wf, ['quiet-import'])).value).toEqual({
      retained: true,
    });
  });

  it('seeds a later mutually exclusive room group using a new stable remote id without touching the existing group', async () => {
    const { cloud, client, connect, dataDir, engine } = await fixture();
    const wf = { kind: 'flock' as const, id: `${workspaceId}:wf:workspace` };
    const mf = { kind: 'flock' as const, id: `${workspaceId}:mf:progressive-machine` };
    const mfRemoteId = `${remoteId}:mf:progressive-machine`;
    cloud.seed(wf.id);
    cloud.seed(mf.id);
    await client.createRoom(namespace, wf);
    await client.flockBatch(namespace, wf, [
      { op: 'put', key: ['original-wf'], value: 'retained' },
    ]);
    const wfRemote = await connect([wf]);
    cleanup.push(() => wfRemote.releaseAuth().then(() => {}));
    await wfRemote.syncRoomToObservedTail(wf);
    await client.compactRoom(namespace, wf);
    const oldFrozen = readNativeFlockSnapshot({ dataDir, namespace, room: wf });
    await wfRemote.syncRoomToObservedTail(wf);
    const legacy = await LoroRepo.create({});
    cleanup.push(() => legacy.destroy());
    await legacy.addTransport(
      'streams',
      new StreamsTransportAdapter({
        bucketId: 'lody',
        baseUrl: cloud.url,
        auth: 'synthetic-streams-refreshed',
        persistence: { mode: 'ephemeral' },
        flockDocStreamId: (id) => id,
      })
    );
    const old = await legacy.openFlockDoc(mf.id);
    expect((await old.syncOnce()).ok).toBe(true);
    const dbPath = path.join(
      dataDir,
      'namespaces',
      `ns_${Buffer.from(namespace).toString('hex')}.sqlite3`
    );
    const persisted = (id: string) => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return {
          config: db.prepare('SELECT * FROM v2_remotes WHERE remote_id=?').get(id),
          checkpoints: db
            .prepare('SELECT * FROM v2_sync_checkpoints WHERE remote_id=? ORDER BY room_id')
            .all(id),
          outbox: db
            .prepare('SELECT * FROM v2_sync_outbox WHERE remote_id=? ORDER BY outbox_seq')
            .all(id),
        };
      } finally {
        db.close();
      }
    };
    cloud.offline(true);
    await client.flockBatch(namespace, wf, [
      { op: 'put', key: ['wf-pending'], value: 'must retain queue' },
    ]);
    const before = persisted(remoteId);
    expect(before.outbox.length).toBeGreaterThan(0);
    expect(before.checkpoints.length).toBeGreaterThan(0);
    await client.createRoom(namespace, mf);
    const left = new Flock();
    left.put(['import', 'left'], { opaque: { retained: true } }, 1);
    left.put(['deleted'], true, 1);
    left.delete(['deleted'], 2);
    const right = new Flock();
    right.put(['import', 'right'], 'offline-edit', 1);
    await client.importRoomState(namespace, mf, {
      snapshot: left.exportFile(),
      enqueueOutbox: false,
    });
    await client.importRoomState(namespace, mf, {
      snapshot: right.exportFile(),
      enqueueOutbox: false,
    });
    await client.compactRoom(namespace, mf);
    const frozen = readNativeFlockSnapshot({ dataDir, namespace, room: mf });
    const seedArgs = {
      content: { mode: 'plaintext' as const },
      workspaceId,
      binding: 'synthetic-account/workspace',
      namespace,
      remoteId: mfRemoteId,
      migrationId: 'stable-progressive-mf-group',
      engineRunId: engine.endpoint.runId,
      dataDir,
      client,
    };
    // A different remote ID must not be used to reseed the already routed WF.
    await expect(
      prepareNativeCatalogRemoteSeedLegacy({ ...seedArgs, frozen: [oldFrozen] })
    ).rejects.toThrow('overlap');
    const prepared = await prepareNativeCatalogRemoteSeedLegacy({ ...seedArgs, frozen: [frozen] });
    const writer = prepared.writer;
    expect(persisted(remoteId)).toEqual(before);
    const mfRemote = await createNativeRepoPlaintextRemoteLegacy({
      content: { mode: 'plaintext' },
      workspaceId,
      binding: 'synthetic-account/workspace',
      namespace,
      remoteId: mfRemoteId,
      dataDir,
      engineRunId: engine.endpoint.runId,
      rooms: [mf],
      streamsTokens: cloud.tokens,
      fetch: globalThis.fetch,
    });
    cleanup.push(() => mfRemote.releaseAuth().then(() => {}));
    expect(persisted(remoteId)).toEqual(before);
    expect(persisted(mfRemoteId).outbox).toEqual([
      expect.objectContaining({ room_id: mf.id, writer, frame_kind: 1 }),
    ]);
    cloud.holdRoom(wf.id, true);
    cloud.offline(false);
    await mfRemote.syncRoomToObservedTail(mf);
    expect(persisted(remoteId)).toEqual(before);
    expect((await old.syncOnce()).ok).toBe(true);
    expect(old.flock.get(['import', 'left'])).toEqual({ opaque: { retained: true } });
    expect(old.flock.get(['import', 'right'])).toBe('offline-edit');
    expect(old.flock.get(['deleted'])).toBeUndefined();
    cloud.holdRoom(wf.id, false);
    await wfRemote.syncRoomToObservedTail(wf);
    expect((await client.flockGet(namespace, wf, ['wf-pending'])).value).toBe('must retain queue');
    cloud.offline(true);
    await client.flockBatch(namespace, wf, [{ op: 'put', key: ['wf-next'], value: true }]);
    await client.flockBatch(namespace, mf, [{ op: 'put', key: ['mf-next'], value: true }]);
    expect(persisted(remoteId).outbox).toEqual([
      expect.objectContaining({ room_id: wf.id, frame_kind: 1 }),
    ]);
    expect(persisted(mfRemoteId).outbox).toEqual([
      expect.objectContaining({ room_id: mf.id, frame_kind: 1 }),
    ]);
    const recordCounts = () =>
      cloud.db
        .prepare('SELECT id, count(*) AS n FROM records GROUP BY id ORDER BY id')
        .all() as Array<{ id: string; n: number }>;
    const priorPosts = recordCounts();
    cloud.offline(false);
    await mfRemote.syncRoomToObservedTail(mf);
    await wfRemote.syncRoomToObservedTail(wf);
    expect(recordCounts()).toEqual(priorPosts.map((row) => ({ ...row, n: row.n + 1 })));
    expect(persisted(remoteId).outbox).toEqual([]);
    expect(persisted(mfRemoteId).outbox).toEqual([]);
    expect((await old.syncOnce()).ok).toBe(true);
    expect(old.flock.get(['mf-next'])).toBe(true);
  });

  it('recovers the first full baseline after a lost HTTP acknowledgement, then converges native/legacy offline conflicts and deletes', async () => {
    const { root, dataDir, cloud, client, engine, connect } = await fixture();
    const wf = { kind: 'flock' as const, id: `${workspaceId}:wf:workspace` };
    cloud.seed(wf.id);
    const legacy = await LoroRepo.create({});
    cleanup.push(() => legacy.destroy());
    await legacy.addTransport(
      'streams',
      new StreamsTransportAdapter({
        bucketId: 'lody',
        baseUrl: cloud.url,
        auth: 'synthetic-streams-refreshed',
        persistence: { mode: 'ephemeral' },
        flockDocStreamId: (id) => id,
      })
    );
    const old = await legacy.openFlockDoc(wf.id);
    expect((await old.syncOnce()).ok).toBe(true);
    await client.createRoom(namespace, wf);
    const left = new Flock();
    left.put(['source', 'left'], { opaque: { retained: true } }, 1);
    left.put(['deleted'], 'old', 1);
    left.delete(['deleted'], 2);
    const right = new Flock();
    right.put(['source', 'right'], 'offline-before-migration', 1);
    await client.importRoomState(namespace, wf, {
      snapshot: left.exportFile(),
      enqueueOutbox: false,
    });
    await client.importRoomState(namespace, wf, {
      snapshot: right.exportFile(),
      enqueueOutbox: false,
    });
    await client.compactRoom(namespace, wf);
    const frozen = readNativeFlockSnapshot({ dataDir, namespace, room: wf });
    const preparation = await prepareNativeCatalogRemoteSeedLegacy({
      content: { mode: 'plaintext' },
      workspaceId,
      binding: 'synthetic-account/workspace',
      namespace,
      remoteId,
      migrationId: 'durable-journal-generation',
      dataDir,
      engineRunId: engine.endpoint.runId,
      client,
      frozen: [frozen],
    });
    // Journal the preparation BEFORE first configuration. This durable identity
    // remains the same across transport ambiguity and engine runs.
    const journalFile = path.join(root, 'synthetic-baseline-receipt.json');
    await fs.writeFile(journalFile, JSON.stringify(preparation));
    const lost = cloud.loseNextPostAck();
    const remote = await connect([wf]);
    cleanup.push(() => remote.releaseAuth().then(() => {}));
    const firstRound = remote.syncRound().then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await lost;
    await firstRound;
    await expect(remote.syncRoomToObservedTail(wf)).rejects.toThrow();
    const dbPath = path.join(
      dataDir,
      'namespaces',
      `ns_${Buffer.from(namespace).toString('hex')}.sqlite3`
    );
    const durableState = () => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return {
          outbox: db
            .prepare(
              'SELECT remote_id, room_id, frame_kind, writer, payload FROM v2_sync_outbox ORDER BY outbox_seq'
            )
            .all(),
          checkpoints: db
            .prepare('SELECT remote_id, room_id, cursor FROM v2_sync_checkpoints ORDER BY room_id')
            .all(),
        };
      } finally {
        db.close();
      }
    };
    await remote.releaseAuth();
    await client.close();
    await engine.stop();
    const beforeRestart = durableState();
    expect(beforeRestart.outbox.length).toBeGreaterThan(0);
    expect(beforeRestart.outbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ writer: preparation.writer, room_id: wf.id }),
      ])
    );
    const restarted = await independentEngine(root, dataDir);
    const resumedClient = await connectEngine(dataDir);
    cleanup.push(() => resumedClient.close());
    const resumed = await createNativeRepoPlaintextRemoteLegacy({
      content: { mode: 'plaintext' },
      workspaceId,
      binding: 'synthetic-account/workspace',
      namespace,
      remoteId,
      dataDir,
      engineRunId: restarted.endpoint.runId,
      rooms: [wf],
      streamsTokens: cloud.tokens,
      fetch: globalThis.fetch,
    });
    cleanup.push(() => resumed.releaseAuth().then(() => {}));
    expect(durableState()).toEqual(beforeRestart);
    expect(JSON.parse(await fs.readFile(journalFile, 'utf8')).writer).toBe(preparation.writer);
    cloud.offline(false);
    await resumed.syncRoomToObservedTail(wf);
    expect((await old.syncOnce()).ok).toBe(true);
    expect(old.flock.get(['source', 'left'])).toEqual({ opaque: { retained: true } });
    expect(old.flock.get(['source', 'right'])).toBe('offline-before-migration');
    expect(old.flock.get(['deleted'])).toBeUndefined();
    expect(durableState().outbox).toEqual([]);
    const secondDir = path.join(root, 'conflict-reader');
    const secondEngine = await independentEngine(root, secondDir);
    const second = await connectEngine(secondDir);
    cleanup.push(() => second.close());
    await second.createRoom(namespace, wf);
    const reader = await createNativeRepoPlaintextRemoteLegacy({
      content: { mode: 'plaintext' },
      workspaceId,
      binding: 'synthetic-account/workspace',
      namespace,
      remoteId,
      dataDir: secondDir,
      engineRunId: secondEngine.endpoint.runId,
      rooms: [wf],
      streamsTokens: cloud.tokens,
      fetch: globalThis.fetch,
    });
    cleanup.push(() => reader.releaseAuth().then(() => {}));
    await reader.syncRoomToObservedTail(wf);
    cloud.offline(true);
    await resumedClient.flockBatch(namespace, wf, [
      { op: 'put', key: ['conflict'], value: 'native-offline' },
      { op: 'put', key: ['native-offline'], value: { retained: true } },
    ]);
    await second.flockBatch(namespace, wf, [
      { op: 'put', key: ['conflict'], value: 'second-native-offline' },
      { op: 'put', key: ['second-native-offline'], value: { retained: true } },
      { op: 'delete', key: ['source', 'left'] },
    ]);
    old.flock.put(['conflict'], 'legacy-offline');
    old.flock.put(['legacy-offline'], { retained: true });
    old.flock.delete(['source', 'right']);
    old.flock.commit();
    expect(durableState().outbox.length).toBeGreaterThan(0);
    cloud.offline(false);
    await resumed.syncRoomToObservedTail(wf);
    expect((await old.syncOnce()).ok).toBe(true);
    await reader.syncRoomToObservedTail(wf);
    await resumed.syncRoomToObservedTail(wf);
    expect((await old.syncOnce()).ok).toBe(true);
    const firstRows = (await resumedClient.flockScan(namespace, wf)).entries;
    const secondRows = (await second.flockScan(namespace, wf)).entries;
    expect(secondRows).toEqual(firstRows);
    const legacyRows = old.flock
      .scan({})
      .filter((row) => row.value !== undefined)
      .map((row) => ({ key: row.key, value: row.value }));
    expect(legacyRows).toEqual(firstRows);
    expect(old.flock.get(['source', 'right'])).toBeUndefined();
    expect(old.flock.get(['native-offline'])).toEqual({ retained: true });
    expect(old.flock.get(['legacy-offline'])).toEqual({ retained: true });
    expect(old.flock.get(['second-native-offline'])).toEqual({ retained: true });
    expect(old.flock.get(['source', 'left'])).toBeUndefined();
    expect(['native-offline', 'legacy-offline', 'second-native-offline']).toContain(
      old.flock.get(['conflict'])
    );
    // A legacy peer still reads correctly after a native reader clean restart.
    await reader.releaseAuth();
    await second.close();
    await secondEngine.stop();
    const readerRestart = await independentEngine(root, secondDir);
    const reconnected = await connectEngine(secondDir);
    cleanup.push(() => reconnected.close());
    const remoteRestart = await createNativeRepoPlaintextRemoteLegacy({
      content: { mode: 'plaintext' },
      workspaceId,
      binding: 'synthetic-account/workspace',
      namespace,
      remoteId,
      dataDir: secondDir,
      engineRunId: readerRestart.endpoint.runId,
      rooms: [wf],
      streamsTokens: cloud.tokens,
      fetch: globalThis.fetch,
    });
    cleanup.push(() => remoteRestart.releaseAuth().then(() => {}));
    await remoteRestart.syncRoomToObservedTail(wf);
    expect((await reconnected.flockScan(namespace, wf)).entries).toEqual(firstRows);
  });

  it('never calls a partial 4MiB SDK round authoritative and catches the later command cancellation', async () => {
    const { cloud, client, connect } = await fixture();
    const mf = { kind: 'flock' as const, id: `${workspaceId}:mf:machine` };
    await client.createRoom(namespace, mf);
    cloud.seed(mf.id);
    const commands = new Flock();
    commands.put(['setup', 'command'], 'pending');
    cloud.append(
      mf.id,
      Buffer.from(JSON.stringify(commands.exportJson()) + ' '.repeat(4 * 1024 * 1024))
    );
    commands.delete(['setup', 'command']);
    cloud.append(mf.id, Buffer.from(JSON.stringify(commands.exportJson())));
    cloud.partialBootstrap.add(mf.id);
    const remote = await connect([mf]);
    cleanup.push(() => remote.releaseAuth().then(() => {}));
    await expect(remote.syncRoomToObservedTail(mf, { maxRounds: 1 })).rejects.toThrow(
      /coverage is unconfirmed/
    );
    expect((await client.flockGet(namespace, mf, ['setup', 'command'])).value).toBe('pending');
    const baseline = await remote.syncRoomToObservedTail(mf, { maxRounds: 1 });
    expect(await remote.isCurrent(baseline)).toBe(true);
    expect((await client.flockGet(namespace, mf, ['setup', 'command'])).found).toBe(false);
    cloud.rejectHead(403);
    await expect(remote.syncRoomToObservedTail(mf)).rejects.toThrow(/tail is unconfirmed/);
    cloud.rejectHead(404);
    await expect(remote.syncRoomToObservedTail(mf)).rejects.toThrow(/tail is unconfirmed/);
  });

  it('only releases auth after the original independent host actually exited and re-registers after a socket handoff', async () => {
    const { dataDir, cloud, client, engine, connect } = await fixture();
    const room = { kind: 'flock' as const, id: `${workspaceId}:wf:workspace` };
    cloud.seed(room.id);
    await client.createRoom(namespace, room);
    const remote = await connect([room]);
    cleanup.push(() => remote.releaseAuthAfterHostStop().then(() => {}));
    const receipt = await remote.syncRoomToObservedTail(room);
    await remote.reconnectAuth();
    expect(await remote.isCurrent(receipt)).toBe(false);
    expect(await remote.isCurrent(await remote.syncRoomToObservedTail(room))).toBe(true);
    await expect(remote.releaseAuthAfterHostStop()).rejects.toThrow('still alive');
    await client.close();
    await engine.stop();
    await expect(remote.releaseAuthAfterHostStop()).resolves.toEqual({ requiresHostStop: true });
  });

  it('rejects protected composition before acquiring a token or client', async () => {
    await expect(
      createNativeRepoPlaintextRemoteLegacy({
        content: { mode: 'protected' },
        workspaceId,
        binding: 'synthetic',
        namespace,
        remoteId,
        engineRunId: 'not-an-engine',
        dataDir: '/not-opened',
        rooms: [],
        streamsTokens: {} as CloudStreamsTokenPort,
        fetch: globalThis.fetch,
      })
    ).rejects.toThrow(/Encrypted workspace/);
  });
});
