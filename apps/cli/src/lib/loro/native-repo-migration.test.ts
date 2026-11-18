import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { NativeRepoHostLegacy } from './native-repo-host';
import { Flock } from '@loro-dev/flock-wasm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNativeRoomMigrationCoordinatorLegacy,
  NativeRoomMigrationAdmission,
} from './native-repo-room-migration';
import {
  NativeRepoMigrationJournal,
  readNativeFlockSnapshot,
  verifyFrozenFlockMigration,
  verifyLegacyFlockRollback,
  type NativeFlockRoom,
  type LegacyFlockRollbackProof,
} from './native-repo-migration';

// Resolve the actual installed artifact without loading the addon into this worker.
const sdk = createRequire(path.resolve(import.meta.dirname, '../../../../electron/package.json'));
const paths = new Set<string>();
const closers: Array<() => void | Promise<void>> = [];
const namespace = 'migration-workspace';
const room: NativeFlockRoom = { kind: 'flock', id: 'migration-workspace:wf' };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of paths) await fs.rm(root, { recursive: true, force: true });
  paths.clear();
});

async function nativeFixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-native-migration-'));
  paths.add(parent);
  const root = path.join(parent, 'data');
  const entry = path.join(parent, 'host.mjs');
  await build({
    entryPoints: [path.join(import.meta.dirname, 'native-repo-host-entry.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'external-native-engine',
        setup(builder) {
          builder.onResolve({ filter: /^@loro-dev\/loro-repo-engine$/ }, () => ({
            path: sdk.resolve('@loro-dev/loro-repo-engine'),
            external: true,
          }));
        },
      },
    ],
  });
  const owner = new NativeRepoHostLegacy({ dataDir: root, entry, executable: process.execPath });
  closers.push(() => owner.close());
  const client = await owner.client();
  await client.createRoom(namespace, room);
  return { root, client };
}

function frozenSources() {
  const first = new Flock();
  first.put(['project', 'old'], { title: 'Old' }, 100);
  const second = Flock.strictFromFile(first.exportFile());
  second.delete(['project', 'old'], 200);
  second.put(['project', 'second'], { title: 'Second device' }, 201);
  first.put(['project', 'first'], { title: 'First device' }, 300);
  return [
    { sourceId: 'renderer-idb-generation-a', snapshot: first.exportFile() },
    { sourceId: 'daemon-sqlite-generation-b', snapshot: second.exportFile() },
  ];
}

describe('native Repo frozen Flock migration', () => {
  it('proves exact binary i64/bytes/MVR/tombstone state across source order and rejects value or clock changes', async () => {
    const { root, client } = await nativeFixture();
    const first = new Flock('device-a');
    first.put(['gone'], 'before', 100);
    first.put(['clock'], 'same', 110);
    first.putWithMeta(
      ['opaque'],
      { retained: true },
      { now: 120, metadata: { future: { retained: true } } }
    );
    first.putMvr(['mvr'], 'device-a');
    const second = Flock.strictFromFile(first.exportFile(), 'device-b');
    second.delete(['gone'], 200);
    second.put(['other'], 'second', 210);
    second.putMvr(['mvr'], 'device-b');
    const sources = [
      { sourceId: 'a', snapshot: first.exportFile() },
      { sourceId: 'b', snapshot: second.exportFile() },
    ];
    for (const source of [...sources].reverse())
      await client.importRoomState(namespace, room, {
        snapshot: source.snapshot,
        enqueueOutbox: false,
      });
    await client.compactRoom(namespace, room);
    const base = readNativeFlockSnapshot({ dataDir: root, namespace, room });
    expect(verifyFrozenFlockMigration(base, sources).sources).toHaveLength(2);
    expect(verifyFrozenFlockMigration(base, [...sources].reverse()).sources).toHaveLength(2);
    expect(Flock.strictFromFile(base.bytes).getMvr(['mvr'])).toEqual(second.getMvr(['mvr']));
    await client.flockBatch(namespace, room, [
      { op: 'put', key: ['exact'], value: 9007199254740993n },
      { op: 'put', key: ['bytes'], value: new Uint8Array([0, 255, 128]) },
      { op: 'put', key: ['future', 9007199254740995n], value: { opaque: true } },
    ]);
    expect(() => readNativeFlockSnapshot({ dataDir: root, namespace, room })).toThrow(
      /fully compacted/
    );
    expect((await client.flockGet(namespace, room, ['exact'])).value).toBe(9007199254740993n);
    expect((await client.flockGet(namespace, room, ['bytes'])).value).toEqual(
      new Uint8Array([0, 255, 128])
    );
    const exported = await client.exportFlockRaw(namespace, room);
    const target = {
      namespace,
      room,
      roomTxId: exported.roomTxId,
      bytes: exported.bytes,
      sha256: sha256(exported.bytes),
    };
    expect(() => Flock.strictFromFile(target.bytes).exportJson()).toThrow(/9007199254740993/);
    const complete = [...sources, { sourceId: 'native-frozen', snapshot: target.bytes }];
    expect(verifyFrozenFlockMigration(target, complete).sources).toHaveLength(3);
    expect(verifyFrozenFlockMigration(target, [...complete].reverse()).sources).toHaveLength(3);
    expect(() => verifyFrozenFlockMigration(target, sources)).toThrow(/exact frozen CRDT/);
    const intent = {
      migrationId: 'binary-roundtrip',
      binding: 'synthetic-binding',
      namespace,
      room,
      targetGeneration: 'synthetic-generation',
      sources: [{ sourceId: 'legacy', sha256: sha256(sources[0]!.snapshot) }],
    };
    const restored = new Flock('legacy-restored');
    restored.strictImportFile(sources[0]!.snapshot);
    restored.strictImportFile(target.bytes);
    expect(
      verifyLegacyFlockRollback({
        intent,
        nativeSnapshot: target,
        legacyBefore: sources[0]!.snapshot,
        legacyAfter: restored.exportFile(),
      }).nativeSnapshotSha256
    ).toBe(target.sha256);
    const value = Flock.strictFromFile(target.bytes, 'value-tamper');
    value.put(['other'], 'tampered');
    const clock = new Flock('clock-tamper');
    // Import a genuinely different HLC: put of the existing same value is a no-op.
    clock.put(['clock'], 'same', Number.MAX_SAFE_INTEGER - 1);
    clock.strictImportFile(target.bytes);
    expect(clock.getEntry(['clock'])).not.toEqual(
      Flock.strictFromFile(target.bytes).getEntry(['clock'])
    );
    const tombstone = Flock.strictFromFile(target.bytes, 'tombstone-tamper');
    tombstone.put(['gone'], 'before');
    const mvr = Flock.strictFromFile(target.bytes, 'mvr-tamper');
    mvr.putMvr(['mvr'], 'third');
    for (const changed of [value, clock, tombstone, mvr]) {
      const bytes = changed.exportFile();
      expect(() =>
        verifyFrozenFlockMigration({ ...target, bytes, sha256: sha256(bytes) }, complete)
      ).toThrow(/exact frozen CRDT/);
      expect(() =>
        verifyLegacyFlockRollback({
          intent,
          nativeSnapshot: target,
          legacyBefore: sources[0]!.snapshot,
          legacyAfter: bytes,
        })
      ).toThrow(/exact old and native CRDT/);
    }
    expect(await client.exportFlockRaw(namespace, room)).toEqual(exported);
  });

  it('proves the complete merged CRDT, exports native edits back, and keeps stale deletes deleted', async () => {
    const { root, client } = await nativeFixture();
    const sources = frozenSources();
    for (const source of sources) {
      await client.importRoomState(namespace, room, {
        snapshot: source.snapshot,
        enqueueOutbox: false,
      });
    }
    expect(() => readNativeFlockSnapshot({ dataDir: root, namespace, room })).toThrow(
      /fully compacted/
    );
    await client.compactRoom(namespace, room);
    const before = readNativeFlockSnapshot({ dataDir: root, namespace, room });
    const proof = verifyFrozenFlockMigration(before, sources);
    expect(proof.sources).toHaveLength(2);
    const restored = Flock.strictFromFile(before.bytes);
    expect(restored.get(['project', 'old'])).toBeUndefined();
    expect(restored.getEntry(['project', 'old'])).toBeDefined();
    expect(restored.get(['project', 'first'])).toEqual({ title: 'First device' });
    expect(restored.get(['project', 'second'])).toEqual({ title: 'Second device' });

    await client.flockBatch(namespace, room, [
      { op: 'delete', key: ['project', 'first'] },
      { op: 'put', key: ['project', 'native'], value: 'Native write' },
    ]);
    expect(() => readNativeFlockSnapshot({ dataDir: root, namespace, room })).toThrow(
      /fully compacted/
    );
    await client.compactRoom(namespace, room);
    const after = readNativeFlockSnapshot({ dataDir: root, namespace, room });
    expect(after.roomTxId).toBeGreaterThan(before.roomTxId);
    expect(() => verifyFrozenFlockMigration(after, sources)).toThrow(/exact frozen CRDT/);
    const rollback = Flock.strictFromFile(after.bytes);
    for (const source of sources) rollback.strictImportFile(source.snapshot);
    expect(rollback.get(['project', 'old'])).toBeUndefined();
    expect(rollback.get(['project', 'first'])).toBeUndefined();
    expect(rollback.get(['project', 'native'])).toBe('Native write');
  });

  it('refuses an omitted source, changed bytes, future schema, protected room and absent storage', async () => {
    const { root, client } = await nativeFixture();
    const sources = frozenSources();
    for (const source of sources)
      await client.importRoomState(namespace, room, { snapshot: source.snapshot });
    await client.compactRoom(namespace, room);
    const snapshot = readNativeFlockSnapshot({ dataDir: root, namespace, room });
    expect(() => verifyFrozenFlockMigration(snapshot, sources.slice(0, 1))).toThrow(
      /exact frozen CRDT/
    );
    expect(() =>
      verifyFrozenFlockMigration({ ...snapshot, sha256: '0'.repeat(64) }, sources)
    ).toThrow(/exact frozen CRDT/);
    const visibleOnly = new Flock();
    for (const row of Flock.strictFromFile(snapshot.bytes).scan()) {
      visibleOnly.put(row.key, row.value);
    }
    const lossyBytes = visibleOnly.exportFile();
    expect(() =>
      verifyFrozenFlockMigration(
        { ...snapshot, bytes: lossyBytes, sha256: sha256(lossyBytes) },
        sources
      )
    ).toThrow(/exact frozen CRDT/);
    expect(() =>
      readNativeFlockSnapshot({ dataDir: path.join(root, 'missing'), namespace, room })
    ).toThrow();
    const databasePath = path.join(
      root,
      'namespaces',
      `ns_${Buffer.from(namespace).toString('hex')}.sqlite3`
    );
    const db = new Database(databasePath);
    try {
      db.prepare('UPDATE v2_rooms SET encryption = 1 WHERE room_id = ?').run(room.id);
      expect(() => readNativeFlockSnapshot({ dataDir: root, namespace, room })).toThrow(
        /protected/
      );
      db.prepare('UPDATE v2_rooms SET encryption = 0 WHERE room_id = ?').run(room.id);
      db.prepare("UPDATE v2_meta SET v = 2 WHERE k = 'schema_version'").run();
      expect(() => readNativeFlockSnapshot({ dataDir: root, namespace, room })).toThrow(
        /Unsupported/
      );
    } finally {
      db.close();
    }
  });

  it('freezes and publishes FI/FIS atomically, including failure halfway through the group', async () => {
    const { root, client } = await nativeFixture();
    const group = [
      { kind: 'flock', id: 'migration-workspace:fi:owner' },
      { kind: 'flock', id: 'migration-workspace:fis:owner' },
    ] as const;
    const proofs = [];
    const intents = [];
    for (const member of group) {
      const source = { sourceId: 'synthetic-device', snapshot: new Flock().exportFile() };
      await client.createRoom(namespace, member);
      await client.importRoomState(namespace, member, {
        snapshot: source.snapshot,
        enqueueOutbox: false,
      });
      await client.compactRoom(namespace, member);
      proofs.push(
        verifyFrozenFlockMigration(
          readNativeFlockSnapshot({ dataDir: root, namespace, room: member }),
          [source]
        )
      );
      intents.push({
        migrationId: 'fi-group',
        binding: 'account/workspace',
        namespace,
        room: member,
        targetGeneration: 'native-v1-generation-2',
        sources: [{ sourceId: source.sourceId, sha256: sha256(source.snapshot) }],
      });
    }
    const journalPath = path.join(root, 'group-manifest.sqlite3');
    const journal = new NativeRepoMigrationJournal(journalPath);
    closers.push(() => journal.close());
    journal.freezeGroup(intents);
    const prematureRollback = group.map((member) => {
      const intent = journal.getIntent('account/workspace', member);
      if (!intent) throw new Error('Missing test migration intent');
      const snapshot = new Flock().exportFile();
      return verifyLegacyFlockRollback({
        intent,
        nativeSnapshot: readNativeFlockSnapshot({ dataDir: root, namespace, room: member }),
        legacyBefore: snapshot,
        legacyAfter: snapshot,
      });
    });
    expect(() =>
      journal.completeRollbackGroup('account/workspace', group, 'fi-group', prematureRollback)
    ).toThrow(/published native group/);
    const firstProof = proofs[0];
    const secondProof = proofs[1];
    if (!firstProof || !secondProof) throw new Error('Missing test proof');
    journal.verify('account/workspace', 'fi-group', firstProof);
    expect(() => journal.publish('account/workspace', group[0], 'fi-group')).toThrow(
      /all rooms atomically/
    );
    expect(() => journal.publishGroup('account/workspace', group, 'fi-group')).toThrow(
      /verified coverage/
    );
    expect(journal.routeGroup('account/workspace', group).owner).toBe('frozen');
    journal.verify('account/workspace', 'fi-group', secondProof);
    journal.close();
    const reopened = new NativeRepoMigrationJournal(journalPath);
    closers.push(() => reopened.close());
    expect(reopened.routeGroup('account/workspace', group).owner).toBe('frozen');
    reopened.publishGroup('account/workspace', group, 'fi-group');
    expect(reopened.routeGroup('account/workspace', group)).toEqual({
      owner: 'native',
      migrationId: 'fi-group',
      targetGeneration: 'native-v1-generation-2',
    });
    expect(() => reopened.abortGroup('account/workspace', group, 'fi-group')).toThrow(
      /cannot fall back/
    );

    const rollbackProofs: LegacyFlockRollbackProof[] = [];
    const staleDevices = [];
    const restoredLegacy = [];
    for (const member of group) {
      await client.flockBatch(namespace, member, [
        { op: 'put', key: ['deleted'], value: 'must stay deleted' },
        { op: 'put', key: ['native'], value: 'retained native edit' },
      ]);
      await client.compactRoom(namespace, member);
      const stale = readNativeFlockSnapshot({ dataDir: root, namespace, room: member });
      staleDevices.push(stale.bytes);
      await client.flockBatch(namespace, member, [{ op: 'delete', key: ['deleted'] }]);
      await client.compactRoom(namespace, member);
      const current = readNativeFlockSnapshot({ dataDir: root, namespace, room: member });
      const legacy = new Flock();
      legacy.put(['legacy'], 'retain current legacy state');
      const legacyBefore = legacy.exportFile();
      legacy.strictImportFile(current.bytes);
      const intent = reopened.getIntent('account/workspace', member);
      if (!intent) throw new Error('Missing test migration intent');
      rollbackProofs.push(
        verifyLegacyFlockRollback({
          intent,
          nativeSnapshot: current,
          legacyBefore,
          legacyAfter: legacy.exportFile(),
        })
      );
      restoredLegacy.push(legacy);
      const visibleOnly = new Flock();
      for (const row of legacy.scan()) visibleOnly.put(row.key, row.value);
      expect(() =>
        verifyLegacyFlockRollback({
          intent,
          nativeSnapshot: current,
          legacyBefore,
          legacyAfter: visibleOnly.exportFile(),
        })
      ).toThrow(/exact old and native CRDT/);
    }
    expect(() =>
      reopened.completeRollbackGroup(
        'account/workspace',
        group,
        'fi-group',
        rollbackProofs.slice(0, 1)
      )
    ).toThrow(/one proof/);
    const firstRollback = rollbackProofs[0];
    const secondRollback = rollbackProofs[1];
    if (!firstRollback || !secondRollback) throw new Error('Missing test rollback proof');
    expect(() =>
      reopened.completeRollbackGroup('account/workspace', group, 'fi-group', [
        firstRollback,
        {
          ...secondRollback,
          intent: { ...secondRollback.intent, targetGeneration: 'wrong-generation' },
        },
      ])
    ).toThrow(/original migration inventory/);
    expect(reopened.routeGroup('account/workspace', group).owner).toBe('native');
    reopened.completeRollbackGroup('account/workspace', group, 'fi-group', rollbackProofs);
    expect(reopened.routeGroup('account/workspace', group)).toEqual({ owner: 'legacy' });
    reopened.completeRollbackGroup('account/workspace', group, 'fi-group', rollbackProofs);
    for (const [index, legacy] of restoredLegacy.entries()) {
      const stale = staleDevices[index];
      if (!stale) throw new Error('Missing test stale device snapshot');
      legacy.strictImportFile(stale);
      expect(legacy.get(['deleted'])).toBeUndefined();
      expect(legacy.getEntry(['deleted'])).toBeDefined();
      expect(legacy.get(['native'])).toBe('retained native edit');
      expect(legacy.get(['legacy'])).toBe('retain current legacy state');
    }
  });

  it('durably gates one whole room through verified publication and never flips a published room back', async () => {
    const { root, client } = await nativeFixture();
    const sources = frozenSources();
    for (const source of sources)
      await client.importRoomState(namespace, room, { snapshot: source.snapshot });
    await client.compactRoom(namespace, room);
    const proof = verifyFrozenFlockMigration(
      readNativeFlockSnapshot({ dataDir: root, namespace, room }),
      sources
    );
    const journalPath = path.join(root, 'owner-manifest.sqlite3');
    const journal = new NativeRepoMigrationJournal(journalPath);
    const competing = new NativeRepoMigrationJournal(journalPath);
    closers.push(
      () => journal.close(),
      () => competing.close()
    );
    const intent = {
      migrationId: 'migration-1',
      binding: 'account/workspace',
      namespace,
      room,
      targetGeneration: 'native-v1-generation-1',
      sources: sources.map((source) => ({
        sourceId: source.sourceId,
        sha256: sha256(source.snapshot),
      })),
    };
    expect(journal.owner(intent.binding, room)).toBe('legacy');
    journal.freeze(intent);
    expect(competing.owner(intent.binding, room)).toBe('frozen');
    expect(() => competing.freeze({ ...intent, migrationId: 'migration-2' })).toThrow(/different/);
    expect(() => journal.publish(intent.binding, room, intent.migrationId)).toThrow(/verified/);
    journal.verify(intent.binding, intent.migrationId, proof);
    expect(journal.owner(intent.binding, room)).toBe('frozen');
    competing.publish(intent.binding, room, intent.migrationId);
    expect(journal.owner(intent.binding, room)).toBe('native');
    expect(() => journal.abort(intent.binding, room, intent.migrationId)).toThrow(
      /cannot fall back/
    );
    journal.publish(intent.binding, room, intent.migrationId);
    expect(journal.owner('another-account/workspace', room)).toBe('legacy');
  });
});

it('coordinates whole wf/mf/sr/Meta binary groups, freezes real users, and rolls durable state back', async () => {
  const { root, client } = await nativeFixture();
  const journal = new NativeRepoMigrationJournal(path.join(root, 'coordinator.sqlite3'));
  closers.push(() => journal.close());
  const binding = 'synthetic-local-profile';
  const admission = new NativeRoomMigrationAdmission(journal, binding);
  const rooms: NativeFlockRoom[] = [
    room,
    { kind: 'flock', id: `${namespace}:mf:machine-a` },
    { kind: 'flock', id: `${namespace}:sr` },
    { kind: 'meta', id: 'meta' },
  ];
  const sources = frozenSources();
  const readerWriter = admission.admit('legacy', rooms);
  let reachedSource = false;
  const coordinator = createNativeRoomMigrationCoordinatorLegacy({
    binding,
    namespace,
    targetGeneration: 'published-0.1.0',
    directory: root,
    dataDir: root,
    journal,
    client,
    admission,
    freezeExternalOwners: async () => {
      expect(() => admission.admit('legacy', rooms)).toThrow(/frozen/);
      if (journal.routeGroup(binding, rooms).owner === 'legacy') expect(reachedSource).toBe(false);
      readerWriter.release();
    },
  });
  await coordinator.migrate(
    rooms.map((room) => ({
      room,
      sources: sources.map((source) => ({
        sourceId: source.sourceId,
        snapshot: async () => {
          reachedSource = true;
          return source.snapshot;
        },
      })),
    }))
  );
  expect(reachedSource).toBe(true);
  expect(journal.routeGroup(binding, rooms).owner).toBe('native');
  await expect(
    coordinator.rollback([room], {
      mergeAndPersist: async () => {
        throw new Error('partial group must never reach legacy');
      },
    })
  ).rejects.toThrow(/complete room group/);
  expect(() => admission.admit('legacy', rooms)).toThrow(/owner/);
  const nativeLease = admission.admit('native', rooms);
  nativeLease.release();
  for (const room of rooms) {
    await client.flockBatch(namespace, room, [
      { op: 'delete', key: ['project', 'first'] },
      { op: 'put', key: ['native', 'whole-room'], value: room.id },
    ]);
  }
  // A real native Meta snapshot is the same lossless Flock binary format in 0.1.0.
  await client.compactRoom(namespace, rooms[3]!);
  expect(
    Flock.strictFromFile(
      readNativeFlockSnapshot({ dataDir: root, namespace, room: rooms[3]! }).bytes
    ).get(['native', 'whole-room'])
  ).toBe('meta');
  const restored = new Map<string, Uint8Array>();
  await expect(
    coordinator.rollback(rooms, {
      mergeAndPersist: async () => {
        throw new Error('crashed before durable legacy merge');
      },
    })
  ).rejects.toThrow(/crashed/);
  // Simulate another process/new startup opening the same FULL journal: route
  // remains native, but persistent maintenance independently refuses admission.
  const restartedJournal = new NativeRepoMigrationJournal(path.join(root, 'coordinator.sqlite3'));
  closers.push(() => restartedJournal.close());
  const restartedAdmission = new NativeRoomMigrationAdmission(restartedJournal, binding);
  expect(restartedJournal.routeGroup(binding, rooms).owner).toBe('native');
  expect(() => restartedAdmission.admit('native', rooms)).toThrow(/persistent rollback/);
  expect(() => restartedAdmission.admit('legacy', rooms)).toThrow(/persistent rollback/);
  await coordinator.rollback(rooms, {
    mergeAndPersist: async (room, native) => {
      const before = sources[0]!.snapshot;
      const merged = Flock.strictFromFile(before);
      merged.strictImportFile(native);
      const file = path.join(root, `legacy-${sha256(Buffer.from(room.id))}.flock`);
      const handle = await fs.open(file, 'w', 0o600);
      try {
        await handle.writeFile(merged.exportFile());
        await handle.sync();
      } finally {
        await handle.close();
      }
      const after = await fs.readFile(file);
      restored.set(room.id, after);
      return { before, after };
    },
  });
  expect(journal.routeGroup(binding, rooms).owner).toBe('legacy');
  restartedAdmission.admit('legacy', rooms).release();
  expect(rooms.some((room) => restartedJournal.isMaintained(binding, room))).toBe(false);
  admission.admit('legacy', rooms).release();
  for (const room of rooms) {
    const merged = Flock.strictFromFile(restored.get(room.id)!);
    for (const source of sources) merged.strictImportFile(source.snapshot);
    expect(merged.get(['project', 'old'])).toBeUndefined();
    expect(merged.get(['project', 'first'])).toBeUndefined();
    expect(merged.getEntry(['project', 'first'])).toBeDefined();
    expect(merged.get(['native', 'whole-room'])).toBe(room.id);
  }
});

it('resumes a frozen multi-source room exclusively from immutable archives after an import fails', async () => {
  const { root, client } = await nativeFixture();
  const journal = new NativeRepoMigrationJournal(path.join(root, 'coordinator.sqlite3'));
  closers.push(() => journal.close());
  const binding = 'synthetic-local-profile';
  const admission = new NativeRoomMigrationAdmission(journal, binding);
  let imports = 0;
  const failedClient = new Proxy(client, {
    get(target, property) {
      if (property === 'importRoomState')
        return async (...args: Parameters<typeof client.importRoomState>) => {
          if (++imports === 2) {
            throw new Error('injected pre-send interruption');
          }
          return client.importRoomState(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const coordinator = createNativeRoomMigrationCoordinatorLegacy({
    binding,
    namespace,
    targetGeneration: 'published-0.1.0',
    directory: root,
    dataDir: root,
    journal,
    client: failedClient,
    admission,
    freezeExternalOwners: async () => {},
  });
  const input = [
    {
      room,
      sources: frozenSources().map((source) => ({
        sourceId: source.sourceId,
        snapshot: async () => source.snapshot,
      })),
    },
  ];
  await expect(coordinator.migrate(input)).rejects.toThrow(/interruption/);
  expect(journal.routeGroup(binding, [room]).owner).toBe('frozen');
  expect(() => admission.admit('legacy', [room])).toThrow(/frozen/);
  // A restarted coordinator cannot ask a changed live replica for a new source.
  await coordinator.migrate([
    {
      room,
      sources: [
        {
          sourceId: 'changed-inventory',
          snapshot: async () => {
            throw new Error('must not reread unfrozen source');
          },
        },
      ],
    },
  ]);
  expect(journal.routeGroup(binding, [room]).owner).toBe('native');
  expect((await client.flockGet(namespace, room, ['project', 'second'])).value).toEqual({
    title: 'Second device',
  });
});
