import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import {
  rendererFlockGroupKey,
  rendererFlockGroupScope,
} from '@lody/shared/renderer-flock-room-group';
import { readLegacySqliteFlockSource } from './legacy-sqlite-flock-source';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import {
  NativeRoomMigrationAdmission,
  createNativeRoomMigrationCoordinatorLegacy,
} from './native-repo-room-migration';
import { nativeMachineCatalogMigrationReceiptSchema } from '@lody/shared/native-machine-catalog-migration';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { NativeRepoMigrationJournal, readNativeFlockSnapshot } from './native-repo-migration';
import {
  migrateLocalMachineCatalogLegacy,
  prepareLegacyMachineMetaOverlay,
} from './native-machine-catalog-migrate';

const require = createRequire(import.meta.url);
const verifiedSdk = await loadNativeRepoSdkCompatibility(import.meta.url);
const roots = new Set<string>();
const cleanup: Array<() => Promise<unknown>> = [];
let output: string;
const accountId = 'local:migration-fixture';
const workspaceId = 'lw_migration_fixture';
const machineId = 'synthetic-machine';
const room = { kind: 'flock' as const, id: `${workspaceId}:mf:${machineId}` };
const group = {
  accountId,
  workspaceId,
  domain: 'machine' as const,
  contentMode: 'plaintext' as const,
  roomIds: [room.id],
};
const binding = JSON.stringify([accountId, workspaceId]);
beforeAll(async () => {
  await fs.mkdir(path.resolve(import.meta.dirname, '../../..', 'node_modules/.cache'), {
    recursive: true,
  });
  output = await fs.mkdtemp(
    path.resolve(import.meta.dirname, '../../..', 'node_modules/.cache/mf-helper-')
  );
  roots.add(output);
  await build({
    entryPoints: Object.fromEntries(
      [
        'native-machine-catalog-migrate',
        'native-repo-independent-host',
        'native-repo-independent-engine',
      ].map((name) => [name, path.join(import.meta.dirname, `${name}-entry.ts`)])
    ),
    outdir: output,
    platform: 'node',
    format: 'esm',
    bundle: true,
    banner: {
      js: "import { createRequire as __req } from 'node:module'; const require = __req(import.meta.url);",
    },
    plugins: [
      {
        name: 'real-native-dependencies',
        setup(builder) {
          builder.onResolve({ filter: /^[^./]|^@/ }, (args) => {
            if (args.path.startsWith('node:')) return { path: args.path, external: true };
            if (args.path.startsWith('@lody/shared/'))
              return {
                path: path.resolve(
                  import.meta.dirname,
                  '../../../../..',
                  'packages/shared/src',
                  args.path.slice('@lody/shared/'.length) + '.ts'
                ),
              };
            if (
              [
                '@loro-dev/loro-repo-engine',
                '@loro-dev/flock-wasm',
                'better-sqlite3',
                'loro-crdt',
              ].includes(args.path)
            )
              return { path: require.resolve(args.path), external: true };
            return undefined;
          });
        },
      },
    ],
  });
});
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close())
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length) throw new AggregateError(failures, 'MF fixture cleanup unconfirmed');
  for (const root of roots)
    if (root !== output) {
      await fs.rm(root, { recursive: true, force: true });
      roots.delete(root);
    }
});

afterAll(async () => {
  await fs.rm(output, { recursive: true, force: true });
});
async function setup() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-mf-helper-'));
  roots.add(dataRoot);
  await fs.mkdir(path.join(dataRoot, 'native-repo'), { recursive: true });
  const db = new Database(
    path.join(dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3')
  );
  db.exec(
    'CREATE TABLE renderer_flock_group_owners(scope TEXT PRIMARY KEY,group_json TEXT,revision TEXT,owner TEXT); CREATE TABLE renderer_flock_group_rooms(binding TEXT,room_id TEXT,group_scope TEXT)'
  );
  db.prepare('INSERT INTO renderer_flock_group_owners VALUES (?,?,?,?)').run(
    rendererFlockGroupScope(group),
    rendererFlockGroupKey(group),
    'freeze-1',
    'frozen'
  );
  db.prepare('INSERT INTO renderer_flock_group_rooms VALUES (?,?,?)').run(
    JSON.stringify([accountId, workspaceId, 'plaintext']),
    room.id,
    rendererFlockGroupScope(group)
  );
  db.close();
  const oldPath = path.join(dataRoot, 'loro-repo', workspaceId, 'repo.sqlite3');
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  const old = await SqliteRepoStore.open({ path: oldPath });
  const repo = await LoroRepo.create({ storageAdapter: old.storage });
  const handle = await repo.openFlockDoc(room.id);
  handle.flock.put(['unknown'], { retained: true });
  handle.flock.put(['gone'], 'before', 1);
  handle.flock.delete(['gone'], 2);
  repo.getMeta().put(['m', 'agent-synthetic-agent'], {
    id: 'synthetic-agent',
    machineId,
    name: 'Old provider',
    cliType: 'custom',
    agentType: 'custom',
    env: { TOKEN: 'SYNTHETIC_PRIVATE' },
    customAcp: { command: 'synthetic-acp', args: [] },
    prompt: 'SYNTHETIC_PROMPT',
  });
  await repo.persistFlockDocNow(room.id, handle.flock);
  await repo.flush();
  await repo.destroy();
  await old.close();
  const renderer = new Flock();
  renderer.put(['renderer-only'], true);
  const meta = new Flock();
  const request = {
    version: 1 as const,
    dataRoot,
    group,
    revision: 'freeze-1',
    sources: [
      {
        sourceId: 'renderer-idb',
        metaSnapshotBase64: Buffer.from(meta.exportFile()).toString('base64'),
        rooms: [
          {
            roomId: room.id,
            snapshotBase64: Buffer.from(renderer.exportFile()).toString('base64'),
          },
        ],
      },
    ],
  };
  const selected = resolveLocalIndependentRepo({
    platform: 'local',
    dataRoot,
    accountId,
    workspaceId,
  });
  return {
    request,
    oldPath,
    selected,
    options: {
      executable: process.execPath,
      hostEntry: path.join(output, 'native-repo-independent-host.js'),
    },
  };
}
describe('actual local MF complete-source migration helper', () => {
  it('merges original SQLite/Meta and renderer binaries, preserves tombstones/private launch data and gives the entry only a safe receipt', async () => {
    const f = await setup();
    const result = await runCommandTextLegacy({
      check: 'none',
      command: process.execPath,
      args: [path.join(output, 'native-machine-catalog-migrate.js')],
      input: JSON.stringify(f.request),
      timeout: 30_000,
      maxOutputBytes: 8192,
    });
    if (!verifiedSdk) {
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('native_machine_catalog_migration_failed');
      expect(result.stderr).not.toContain('SYNTHETIC_PRIVATE');
      await expect(fs.stat(f.selected.directory)).rejects.toThrow();
      return;
    }
    expect(result.code, result.stderr).toBe(0);
    const receipt = nativeMachineCatalogMigrationReceiptSchema.parse(JSON.parse(result.stdout));
    expect(receipt.sourceCount).toBe(2);
    expect(result.stdout).not.toContain('SYNTHETIC_PRIVATE');
    expect(result.stdout).not.toContain('SYNTHETIC_PROMPT');
    const target = Flock.strictFromFile(
      readNativeFlockSnapshot({ dataDir: f.selected.dataDir, namespace: workspaceId, room }).bytes
    );
    expect(target.get(['unknown'])).toEqual({ retained: true });
    expect(target.get(['renderer-only'])).toBe(true);
    expect(target.get(['gone'])).toBeUndefined();
    expect(target.get(['agentConfig', 'synthetic-agent'])).toMatchObject({
      name: 'Old provider',
      env: { TOKEN: 'SYNTHETIC_PRIVATE' },
      customAcp: { command: 'synthetic-acp' },
      prompt: 'SYNTHETIC_PROMPT',
    });
    expect(
      Flock.strictFromFile(
        readLegacySqliteFlockSource({ databasePath: f.oldPath, room: { kind: 'meta', id: 'meta' } })
          .snapshot
      ).get(['m', 'agent-synthetic-agent'])
    ).toMatchObject({ prompt: 'SYNTHETIC_PROMPT' });
  });
  it('does not reuse a previous immutable source archive after rollback and new durable legacy edits', async () => {
    const f = await setup();
    if (!verifiedSdk) {
      await expect(migrateLocalMachineCatalogLegacy(f.request, f.options)).rejects.toThrow(
        'verified SDK artifact'
      );
      expect(
        Flock.strictFromFile(
          readLegacySqliteFlockSource({ databasePath: f.oldPath, room }).snapshot
        ).get(['unknown'])
      ).toEqual({ retained: true });
      await expect(fs.stat(f.selected.directory)).rejects.toThrow();
      return;
    }
    const first = await migrateLocalMachineCatalogLegacy(f.request, f.options);
    const host = new IndependentNativeRepoHostLegacy({
      ...f.options,
      entry: f.options.hostEntry,
      dataDir: f.selected.dataDir,
      binding: f.selected.binding,
    });
    cleanup.push(() => host.close());
    const client = await host.client();
    const journal = new NativeRepoMigrationJournal(
      path.join(f.selected.directory, 'routes.sqlite3')
    );
    cleanup.push(async () => journal.close());
    const old = await SqliteRepoStore.open({ path: f.oldPath });
    cleanup.push(async () => old.close());
    const repo = await LoroRepo.create({ storageAdapter: old.storage });
    cleanup.push(() => repo.destroy());
    const handle = await repo.openFlockDoc(room.id);
    const coordinator = createNativeRoomMigrationCoordinatorLegacy({
      binding,
      namespace: workspaceId,
      targetGeneration: 'engine-0.1.0-v1',
      directory: f.selected.directory,
      dataDir: f.selected.dataDir,
      journal,
      client,
      admission: new NativeRoomMigrationAdmission(journal, binding),
      freezeExternalOwners: async () => {},
    });
    await coordinator.rollback([room], {
      async mergeAndPersist(_room, bytes) {
        const before = readLegacySqliteFlockSource({ databasePath: f.oldPath, room }).snapshot;
        handle.flock.strictImportFile(bytes);
        await repo.persistFlockDocNow(room.id, handle.flock);
        await repo.flush();
        return {
          before,
          after: readLegacySqliteFlockSource({ databasePath: f.oldPath, room }).snapshot,
        };
      },
    });
    handle.flock.put(['after-rollback'], 'new durable generation');
    await repo.persistFlockDocNow(room.id, handle.flock);
    await repo.flush();
    await repo.destroy();
    await old.close();
    await host.close();
    journal.close();
    const second = await migrateLocalMachineCatalogLegacy(
      { ...f.request, revision: 'freeze-1' },
      f.options
    );
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    expect(
      Flock.strictFromFile(
        readNativeFlockSnapshot({ dataDir: f.selected.dataDir, namespace: workspaceId, room }).bytes
      ).get(['after-rollback'])
    ).toBe('new durable generation');
    expect(
      (await fs.readdir(f.selected.directory)).filter((name) => /^mf-sources-.*\.json$/.test(name))
    ).toHaveLength(2);
  });
  it('reports other daemon MF/Meta owners through the readonly entry preflight without creating a native owner', async () => {
    const f = await setup();
    const old = await SqliteRepoStore.open({ path: f.oldPath });
    const repo = await LoroRepo.create({ storageAdapter: old.storage });
    try {
      const other = await repo.openFlockDoc(`${workspaceId}:mf:other-machine`);
      other.flock.put(['future'], { retained: true });
      repo.getMeta().put(['m', 'agent-other'], {
        machineId: 'meta-only-machine',
        env: { TOKEN: 'SYNTHETIC_PRIVATE' },
      });
      await repo.persistFlockDocNow(`${workspaceId}:mf:other-machine`, other.flock);
      await repo.flush();
    } finally {
      await repo.destroy();
      await old.close();
    }
    const result = await runCommandTextLegacy({
      check: 'exit-0',
      command: process.execPath,
      args: [
        path.join(output, 'native-machine-catalog-migrate.js'),
        '--inspect-local-machine-catalog',
      ],
      input: JSON.stringify(f.request),
      timeout: 15_000,
      maxOutputBytes: 8192,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      otherMachineOwners: ['meta-only-machine', 'other-machine'],
    });
    expect(result.stdout).not.toContain('SYNTHETIC_PRIVATE');
    await expect(fs.stat(f.selected.directory)).rejects.toThrow();
    await expect(migrateLocalMachineCatalogLegacy(f.request, f.options)).rejects.toThrow(
      verifiedSdk ? 'single-machine inventory' : 'verified SDK artifact'
    );
    await expect(fs.stat(f.selected.directory)).rejects.toThrow();
  });
  it('rejects a stale freeze before creating a native profile', async () => {
    const f = await setup();
    await expect(
      migrateLocalMachineCatalogLegacy({ ...f.request, revision: 'wrong-freeze' }, f.options)
    ).rejects.toThrow('freeze witness');
    await expect(fs.stat(f.selected.directory)).rejects.toThrow();
  });
});

it('never revives a removed MF provider from archived Meta and preserves unknown fields on an explicit legacy mapping', () => {
  const meta = new Flock('meta-replica');
  const config = {
    id: 'synthetic-agent',
    machineId,
    name: 'Legacy provider',
    cliType: 'custom',
    agentType: 'custom',
    env: { TOKEN: 'SYNTHETIC' },
    customAcp: { command: 'synthetic-acp', args: [] },
    future: { kept: true },
  };
  meta.put(['m', 'agent-synthetic-agent'], config, 1);
  const empty = new Flock('mf-replica');
  const mapped = Flock.strictFromFile(
    prepareLegacyMachineMetaOverlay({
      meta: meta.exportFile(),
      flock: empty.exportFile(),
      workspaceId,
      machineId,
    })
  );
  expect(mapped.get(['agentConfig', config.id])).toMatchObject({
    future: { kept: true },
    env: { TOKEN: 'SYNTHETIC' },
  });
  empty.put(['agentConfig', config.id], config, 1);
  empty.delete(['agentConfig', config.id], 2);
  const overlay = Flock.strictFromFile(
    prepareLegacyMachineMetaOverlay({
      meta: meta.exportFile(),
      flock: empty.exportFile(),
      workspaceId,
      machineId,
    })
  );
  empty.strictImportFile(overlay.exportFile());
  expect(empty.get(['agentConfig', config.id])).toBeUndefined();
});
