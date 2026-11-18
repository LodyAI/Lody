import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import { ProcessReleaseFailed, processLayer } from '@lody/shared/node/process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  runCommandTextLegacy,
  startProcessLegacy,
  nodeProcessLive,
} from '@lody/shared/node/process';
import { rendererWfBindingKey } from '@lody/shared/renderer-room-migration';
import { nativeWorkspaceCatalogMigrationReceiptSchema } from '@lody/shared/native-workspace-catalog-migration';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { NativeRepoMigrationJournal, readNativeFlockSnapshot } from './native-repo-migration';
import { migrateLocalWorkspaceCatalogLegacy } from './native-workspace-catalog-migrate';

const require = createRequire(import.meta.url);
const roots = new Set<string>();
let output: string;
const accountId = 'local:migration-fixture';
const workspaceId = 'lw_migration_fixture';
const room = { kind: 'flock' as const, id: `${workspaceId}:wf:workspace` };
const binding = { accountId, workspaceId, roomId: room.id, contentMode: 'plaintext' as const };
beforeAll(async () => {
  const cache = path.resolve(import.meta.dirname, '../../../node_modules/.cache');
  await fs.mkdir(cache, { recursive: true });
  // The engine entry resolves and attests its own installed SDK closure.
  output = await fs.mkdtemp(path.join(cache, 'lody-wf-helper-build-'));
  roots.add(output);
  await build({
    entryPoints: Object.fromEntries(
      [
        'native-workspace-catalog-migrate',
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
  for (const root of roots)
    if (root !== output) {
      await fs.rm(root, { recursive: true, force: true });
      roots.delete(root);
    }
});
async function setup() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-wf-helper-'));
  roots.add(dataRoot);
  await fs.mkdir(path.join(dataRoot, 'native-repo'), { recursive: true });
  const database = new Database(path.join(dataRoot, 'native-repo', 'renderer-wf-owners.sqlite3'));
  database.exec(
    'CREATE TABLE renderer_wf_owners(binding TEXT PRIMARY KEY, revision TEXT, owner TEXT)'
  );
  database
    .prepare('INSERT INTO renderer_wf_owners VALUES (?, ?, ?)')
    .run(rendererWfBindingKey(binding), 'freeze-1', 'frozen');
  database.close();
  const oldPath = path.join(dataRoot, 'loro-repo', workspaceId, 'repo.sqlite3');
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  const store = new SqliteRepoStore({ path: oldPath });
  const repo = await LoroRepo.create({ storageAdapter: store.storage });
  const handle = await repo.openFlockDoc(room.id);
  handle.flock.put(['daemon-only'], { unknown: { retained: true } });
  handle.flock.put(['gone'], 'before');
  handle.flock.delete(['gone']);
  handle.flock.commit();
  await repo.persistFlockDocNow(room.id, handle.flock);
  await repo.flush();
  await repo.destroy();
  store.close();
  const renderer = new Flock();
  renderer.put(['renderer-only'], { retained: true });
  const request = {
    version: 1 as const,
    accountId,
    workspaceId,
    dataRoot,
    revision: 'freeze-1',
    sources: [
      {
        sourceId: 'renderer-idb-1',
        snapshotBase64: Buffer.from(renderer.exportFile()).toString('base64'),
      },
    ],
  };
  return {
    request,
    oldPath,
    options: {
      hostEntry: path.join(output, 'native-repo-independent-host.js'),
      executable: process.execPath,
    },
  };
}
describe('local whole-WF migration helper', () => {
  it('accepts a complete empty renderer inventory and still migrates the actual SQLite CRDT source', async () => {
    const { request, options } = await setup();
    const receipt = await migrateLocalWorkspaceCatalogLegacy({ ...request, sources: [] }, options);
    expect(receipt.sourceCount).toBe(1);
    const target = resolveLocalIndependentRepo({ platform: 'local', ...request });
    const actual = Flock.strictFromFile(
      readNativeFlockSnapshot({ dataDir: target.dataDir, namespace: workspaceId, room }).bytes
    );
    expect(actual.get(['daemon-only'])).toEqual({ unknown: { retained: true } });
    expect(actual.get(['gone'])).toBeUndefined();
  });
  it('merges the real SQLite and renderer replica, preserves old storage, and retries a lost completion without replacing its archive', async () => {
    const { request, oldPath, options } = await setup();
    const receipt = await migrateLocalWorkspaceCatalogLegacy(request, options);
    expect(receipt.sourceCount).toBe(2);
    const target = resolveLocalIndependentRepo({ platform: 'local', ...request });
    const snapshot = readNativeFlockSnapshot({
      dataDir: target.dataDir,
      namespace: workspaceId,
      room,
    });
    const actual = Flock.strictFromFile(snapshot.bytes);
    expect(actual.get(['daemon-only'])).toEqual({ unknown: { retained: true } });
    expect(actual.get(['renderer-only'])).toEqual({ retained: true });
    expect(actual.get(['gone'])).toBeUndefined();
    expect((await fs.stat(oldPath)).size).toBeGreaterThan(0);
    const later = new Flock();
    later.put(['not-in-original-inventory'], 'must not adopt');
    const retry = await migrateLocalWorkspaceCatalogLegacy(
      {
        ...request,
        sources: [
          {
            sourceId: 'changed-input-after-unknown-ack',
            snapshotBase64: Buffer.from(later.exportFile()).toString('base64'),
          },
        ],
      },
      options
    );
    expect(retry.sourceSha256).toBe(receipt.sourceSha256);
    expect(retry.targetSha256).toBe(receipt.targetSha256);
    const journal = new NativeRepoMigrationJournal(path.join(target.directory, 'routes.sqlite3'));
    try {
      expect(journal.routeGroup(JSON.stringify([accountId, workspaceId]), [room]).owner).toBe(
        'native'
      );
    } finally {
      journal.close();
    }
  });
  it('refuses mismatched freeze, an alive daemon and a live SDK writer without clearing their owner', async () => {
    const { request, oldPath, options } = await setup();
    await expect(
      migrateLocalWorkspaceCatalogLegacy({ ...request, revision: 'wrong' }, options)
    ).rejects.toThrow('freeze receipt');
    await fs.mkdir(path.join(request.dataRoot, 'run'));
    await fs.writeFile(
      path.join(request.dataRoot, 'run', 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        version: 'test',
        startedAt: 'fixture',
        socketPath: 'unused',
        controlSocketPath: 'unused',
      })
    );
    await expect(migrateLocalWorkspaceCatalogLegacy(request, options)).rejects.toThrow(
      'daemon remains alive'
    );
    await fs.rm(path.join(request.dataRoot, 'run', 'daemon.json'));
    const store = await SqliteRepoStore.open({ path: oldPath });
    const lease = await store.storage.acquireWriterLease?.();
    try {
      await expect(migrateLocalWorkspaceCatalogLegacy(request, options)).rejects.toThrow();
      const db = new Database(oldPath, { readonly: true });
      try {
        expect(
          (db.prepare('SELECT token FROM writer_owner').get() as { token: string }).token
        ).toBe(lease?.token);
      } finally {
        db.close();
      }
    } finally {
      await lease?.release();
      store.close();
    }
  });
  it('recovers a SIGKILL writer only through the published SDK strong process identity', async () => {
    const { request, oldPath, options } = await setup();
    const writerEntry = path.join(request.dataRoot, 'synthetic-writer.cjs');
    await fs.writeFile(
      writerEntry,
      `const { SqliteRepoStore } = require(${JSON.stringify(require.resolve('loro-repo/storage/sqlite'))});
      (async () => { const store = await SqliteRepoStore.open({path: process.argv[2]});
      await store.storage.acquireWriterLease(); process.stdout.write('LEASED\\n'); setInterval(() => {}, 100000); })();`
    );
    let ready!: () => void;
    let reject!: (error: unknown) => void;
    const leased = new Promise<void>((resolve, fail) => {
      ready = resolve;
      reject = fail;
    });
    const child = startProcessLegacy({
      command: process.execPath,
      args: [writerEntry, oldPath],
      processGroup: false,
      options: { stdio: ['ignore', 'pipe', 'pipe'] },
      onSpawned(handle) {
        handle.stdout?.on('data', (chunk) => {
          if (String(chunk).includes('LEASED')) ready();
        });
        handle.once('error', reject);
        handle.once('exit', () => reject(new Error('Synthetic writer exited before lease')));
      },
    });
    try {
      await leased;
      await expect(migrateLocalWorkspaceCatalogLegacy(request, options)).rejects.toThrow();
      if (!child.child.pid) throw new Error('Synthetic writer has no pid');
      nodeProcessLive.kill(child.child.pid, 'SIGKILL');
      expect((await child.exited).signal).toBe('SIGKILL');
      const db = new Database(oldPath, { readonly: true });
      try {
        expect(db.prepare('SELECT token FROM writer_owner').get()).toBeDefined();
      } finally {
        db.close();
      }
      const receipt = await migrateLocalWorkspaceCatalogLegacy(request, options);
      expect(receipt.sourceCount).toBe(2);
      const reopened = await SqliteRepoStore.open({ path: oldPath });
      try {
        const lease = await reopened.storage.acquireWriterLease?.();
        expect(lease).toBeDefined();
        await lease?.release();
      } finally {
        reopened.close();
      }
    } finally {
      await child.terminate({ graceMs: 0, killWaitMs: 2000 });
    }
  });

  it('uses a bounded strict stdin protocol and prints only a validated finite receipt', async () => {
    const { request } = await setup();
    const invoke = (payload: unknown) =>
      runCommandTextLegacy({
        command: process.execPath,
        args: [path.join(output, 'native-workspace-catalog-migrate.js')],
        input: JSON.stringify(payload),
        timeout: '20 seconds',
        maxOutputBytes: 8192,
        check: 'none',
      });
    const rejected = await invoke({
      ...request,
      room: 'attacker-room',
      command: 'write',
      secret: 'synthetic-secret',
    });
    expect(rejected.code, rejected.stderr).toBe(70);
    expect(rejected.stdout).toBe('');
    expect(rejected.stderr).not.toContain('synthetic-secret');
    const result = await invoke(request);
    expect(result.code, result.stderr).toBe(0);
    expect(
      nativeWorkspaceCatalogMigrationReceiptSchema.parse(JSON.parse(result.stdout)).sourceCount
    ).toBe(2);
    expect(result.stdout).not.toContain(
      request.sources.map((source) => source.snapshotBase64).join('')
    );
  });
});

afterAll(async () => {
  if (output) await fs.rm(output, { recursive: true, force: true });
});

async function mainCoordinatorFixture() {
  const { NativeWorkspaceCatalogMigrationLegacy } =
    await import('../../../../electron/src/main/services/native-workspace-catalog-migration');
  const { RendererWorkspaceFlockMigrationMainLegacy } =
    await import('../../../../electron/src/main/services/renderer-workspace-flock-migration');
  const { IndependentNativeRepoHostLegacy } =
    await import('@lody/shared/node/native-repo-independent-legacy');
  const { request, oldPath } = await setup();
  const marker = new Database(
    path.join(request.dataRoot, 'native-repo', 'renderer-wf-owners.sqlite3')
  );
  marker.prepare('DELETE FROM renderer_wf_owners').run();
  marker.close();
  const selected = resolveLocalIndependentRepo({ platform: 'local', ...request });
  const preflight = new IndependentNativeRepoHostLegacy({
    dataDir: selected.dataDir,
    binding: selected.binding,
    executable: process.execPath,
    entry: path.join(output, 'native-repo-independent-host.js'),
  });
  const old = await SqliteRepoStore.open({ path: oldPath });
  const writer = await old.storage.acquireWriterLease!();
  let oldClosed = false;
  const state = { paused: false, running: true };
  const dbName = `lody-loro-repo-db-${workspaceId}:a`;
  const other = new Flock();
  other.put(['second-renderer'], 'retained');
  let sources = [
    {
      sourceId: `renderer-idb:loro-repo@0.25.0:${dbName}`,
      dbName,
      present: true,
      snapshot: Uint8Array.from(Buffer.from(request.sources[0]!.snapshotBase64, 'base64')),
    },
    {
      sourceId: `renderer-idb:loro-repo@0.25.0:${dbName}-second`,
      dbName: `${dbName}-second`,
      present: true,
      snapshot: other.exportFile(),
    },
  ];
  const published = new Set<number>();
  const main = new RendererWorkspaceFlockMigrationMainLegacy({
    databasePath: path.join(request.dataRoot, 'native-repo', 'renderer-wf-owners.sqlite3'),
    registeredWindowIds: () => [1, 2],
    send: (id, message) => {
      if (message.phase === 'freeze') {
        const database = new Database(oldPath, { readonly: true });
        try {
          expect(
            (
              database.prepare('SELECT token FROM writer_owner').get() as
                | { token?: string }
                | undefined
            )?.token
          ).toBeUndefined();
        } finally {
          database.close();
        }
        main.acceptAck(id, message);
      } else main.acceptAck(id, { ...message, sources });
    },
    publishOwner: (id) => {
      published.add(id);
    },
    readCommittedOwner: async () => {
      const { readNativeWorkspaceFlockOwner } =
        await import('../../../../electron/src/main/services/native-workspace-routing');
      return readNativeWorkspaceFlockOwner(request.dataRoot, binding);
    },
  });
  for (const id of [1, 2]) {
    const registered = main.register(id, binding, main.beginRegistration(id));
    main.ready(id, registered.registrationId);
  }
  let entry = path.join(output, 'native-workspace-catalog-migrate.js');
  let preflightFailure: Error | undefined;
  const migrationOptions: ConstructorParameters<typeof NativeWorkspaceCatalogMigrationLegacy>[0] = {
    dataRoot: request.dataRoot,
    renderer: () => main,
    acquirePause: () => {
      if (state.paused) throw new Error('Overlapping pause owner');
      state.paused = true;
      return {
        stop: async () => {
          if (!oldClosed) {
            await writer.release();
            old.close();
            oldClosed = true;
          }
          state.running = false;
        },
        release: (options) => {
          state.paused = false;
          if (options?.resume !== false) state.running = true;
        },
      };
    },
    ensureData: async () => {
      if (preflightFailure) throw preflightFailure;
      await preflight.client();
    },
    launch: () => ({ executable: process.execPath, entry }),
  };
  const coordinator = new NativeWorkspaceCatalogMigrationLegacy(migrationOptions);
  return {
    migrationOptions,
    request,
    selected,
    main,
    coordinator,
    state,
    published,
    preflight,
    entry: (value: string) => {
      entry = value;
    },
    failPreflight: (failure: Error) => {
      preflightFailure = failure;
    },
    sources: (value: typeof sources) => {
      sources = value;
    },
    async close() {
      await coordinator.close();
      await preflight.close();
      main.close();
      if (!oldClosed) {
        await writer.release();
        old.close();
      }
    },
  };
}

it('coordinates a real helper, old SQLite writer and two renderer ports over one preflight engine', async () => {
  const f = await mainCoordinatorFixture();
  try {
    const [first, joined] = await Promise.all([
      f.coordinator.migrate(binding),
      f.coordinator.migrate(binding),
    ]);
    expect(joined).toBe(first);
    expect(first.receipt?.sourceCount).toBe(3);
    expect(f.state).toEqual({ paused: false, running: true });
    expect(f.published).toEqual(new Set([1, 2]));
    const client = await f.preflight.client();
    expect((await f.preflight.leaseInfo(client)).engineRunId).toBe(first.receipt?.engineRunId);
    const snapshot = readNativeFlockSnapshot({
      dataDir: f.selected.dataDir,
      namespace: workspaceId,
      room,
    });
    const actual = Flock.strictFromFile(snapshot.bytes);
    expect(actual.get(['daemon-only'])).toEqual({ unknown: { retained: true } });
    expect(actual.get(['renderer-only'])).toEqual({ retained: true });
    expect(actual.get(['second-renderer'])).toBe('retained');
    expect(actual.get(['gone'])).toBeUndefined();
    expect((await f.coordinator.migrate(binding)).receipt).toBeUndefined();
  } finally {
    await f.close();
  }
}, 30_000);

it('retains the execution pause after an unknown helper receipt and resumes the original archive', async () => {
  const f = await mainCoordinatorFixture();
  try {
    const wrapper = path.join(f.request.dataRoot, 'bad-receipt.mjs');
    await fs.writeFile(
      wrapper,
      `const write=process.stdout.write.bind(process.stdout);process.stdout.write=()=>true;await import(${JSON.stringify(new URL(`file://${path.join(output, 'native-workspace-catalog-migrate.js')}`).href)});write('{invalid-receipt}\\n');`
    );
    f.entry(wrapper);
    await expect(f.coordinator.migrate(binding)).rejects.toThrow();
    expect(f.main.status(binding).owner).toBe('frozen');
    expect(f.state).toEqual({ paused: true, running: false });
    const injected = new Flock();
    injected.put(['must-not-adopt'], 'changed after frozen source inventory');
    const dbName = `lody-loro-repo-db-${workspaceId}:a`;
    f.sources([
      {
        sourceId: `renderer-idb:loro-repo@0.25.0:${dbName}`,
        dbName,
        present: true,
        snapshot: injected.exportFile(),
      },
    ]);
    f.entry(path.join(output, 'native-workspace-catalog-migrate.js'));
    const receipt = await f.coordinator.migrate(binding);
    expect(receipt.receipt?.sourceCount).toBe(3);
    expect(f.state).toEqual({ paused: false, running: true });
    const snapshot = readNativeFlockSnapshot({
      dataDir: f.selected.dataDir,
      namespace: workspaceId,
      room,
    });
    expect(Flock.strictFromFile(snapshot.bytes).get(['must-not-adopt'])).toBeUndefined();
    expect(Flock.strictFromFile(snapshot.bytes).get(['second-renderer'])).toBe('retained');
  } finally {
    await f.close();
  }
}, 30_000);

it('close cancels and joins the actual helper without resuming the paused execution runtime', async () => {
  const f = await mainCoordinatorFixture();
  const { watch } = await import('node:fs');
  const ready = path.join(f.request.dataRoot, 'helper-ready');
  const socket = path.join('/tmp', `lody-hold-${crypto.randomUUID()}.sock`);
  let resolve!: () => void;
  const observed = new Promise<void>((r) => {
    resolve = r;
  });
  const watcher = watch(f.request.dataRoot, (_event, name) => {
    if (name === 'helper-ready') resolve();
  });
  try {
    const hold = path.join(f.request.dataRoot, 'hold-helper.mjs');
    await fs.writeFile(
      hold,
      `import {createServer} from 'node:net';import {writeFile} from 'node:fs/promises';const server=createServer();server.listen(${JSON.stringify(socket)},async()=>{await writeFile(${JSON.stringify(ready)},'ready');});`
    );
    f.entry(hold);
    const pending = f.coordinator.migrate(binding);
    void pending.catch(() => {});
    await observed;
    expect(f.state).toEqual({ paused: true, running: false });
    await Promise.all([f.coordinator.close(), f.coordinator.close()]);
    await expect(pending).rejects.toThrow();
    expect(f.coordinator.isReleased()).toBe(true);
    expect(f.state).toEqual({ paused: false, running: false });
    expect(f.main.status(binding).owner).toBe('frozen');
    expect(f.published.size).toBe(0);
  } finally {
    watcher.close();
    await f.close();
    await fs.rm(socket, { force: true });
  }
}, 30_000);

it('refuses an unavailable host before pausing execution or freezing the existing legacy owner', async () => {
  const f = await mainCoordinatorFixture();
  try {
    f.failPreflight(new Error('synthetic unsupported native host'));
    await expect(f.coordinator.migrate(binding)).rejects.toThrow();
    expect(f.state).toEqual({ paused: false, running: true });
    expect(f.main.status(binding).owner).toBe('legacy');
    await expect(fs.stat(f.selected.dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const old = new Database(
      path.join(f.request.dataRoot, 'loro-repo', workspaceId, 'repo.sqlite3'),
      { readonly: true }
    );
    try {
      expect(
        (old.prepare('SELECT token FROM writer_owner').get() as { token: string }).token
      ).toBeTruthy();
    } finally {
      old.close();
    }
    await f.coordinator.close();
    expect(f.state).toEqual({ paused: false, running: true });
  } finally {
    await f.close();
  }
}, 30_000);

effectIt.effect(
  'keeps the same failed process recovery owner and freeze epoch until its helper is proven gone',
  () =>
    Effect.gen(function* () {
      const { NativeWorkspaceCatalogMigration, nativeWorkspaceCatalogMigrationLayer } =
        yield* Effect.promise(
          () => import('../../../../electron/src/main/services/native-workspace-catalog-migration')
        );
      const f = yield* Effect.promise(mainCoordinatorFixture);
      const table = new FakeProcessTable();
      table.queueSpawn({ ignores: ['SIGTERM', 'SIGKILL'] });
      let pid = 0;
      let signalSpawn!: () => void;
      const spawned = new Promise<void>((resolve) => {
        signalSpawn = resolve;
      });
      const layer = nativeWorkspaceCatalogMigrationLayer({
        ...f.migrationOptions,
        helperTimeoutMs: 1,
      }).pipe(
        Layer.provideMerge(
          processLayer({
            nodeProcess: {
              ...table.api,
              spawn: (command, args, options) => {
                const child = table.api.spawn(command, args, options);
                pid = child.pid!;
                signalSpawn();
                return child;
              },
            },
          })
        )
      );
      yield* Effect.gen(function* () {
        const service = yield* NativeWorkspaceCatalogMigration;
        const first = yield* Effect.forkScoped(service.migrate(binding));
        yield* Effect.promise(() => spawned);
        yield* TestClock.adjust('10 seconds');
        const failure = yield* Fiber.await(first);
        expect(Exit.isFailure(failure)).toBe(true);
        if (Exit.isSuccess(failure)) throw new Error('Expected helper cleanup failure');
        const release = failure.cause.reasons.flatMap((reason) =>
          Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed
            ? [reason.defect]
            : []
        )[0];
        expect(release).toBeDefined();
        expect(table.isAlive(pid)).toBe(true);
        expect(f.state).toEqual({ paused: true, running: false });
        const revision = f.main.status(binding).revision;
        const retry = yield* Effect.forkScoped(service.migrate(binding));
        yield* TestClock.adjust('10 seconds');
        const rejected = yield* Fiber.await(retry);
        expect(Exit.isFailure(rejected)).toBe(true);
        if (Exit.isSuccess(rejected)) throw new Error('Unreleased helper was reused');
        expect(
          rejected.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect === release
          )
        ).toBe(true);
        expect(f.main.status(binding).revision).toBe(revision);
        expect(table.spawned).toHaveLength(1);
        expect(f.published.size).toBe(0);
        table.exitOnItsOwn(pid);
        yield* service.recover;
        yield* service.close;
        expect(table.isAlive(pid)).toBe(false);
        expect(f.state).toEqual({ paused: false, running: false });
      }).pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.ensuring(Effect.promise(() => f.close()))
      );
    })
);
