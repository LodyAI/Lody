import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectEngine, readEngineEndpoint } from '@loro-dev/loro-repo-client/node';
import { NativeRepoHostLegacy } from './native-repo-host';
import { NativeFileIndexPilotLegacy } from './native-file-index-pilot';
import { LoroRepo } from 'loro-repo';
import { createCliSqliteRepoStore } from './sqlite-repo-store';
import { publishCodeCollabFileIndexFlock } from '../code-collab/code-collab-flock-publish';
import { getCodeCollabFileIndexFlockDocId, type WorkspaceId, type SessionId } from '@lody/shared';
import type { ChildProcess } from 'node:child_process';
import { nodeProcessLive, terminateChildTreeLegacy } from '@lody/shared/node/process';

const require = createRequire(import.meta.url);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  cleanups.length = 0;
  if (failures.length) throw new AggregateError(failures, 'Native host test cleanup failed');
});

describe('daemon-owned native Repo host', () => {
  it('shares one child across callers, survives an attached client closing, and reopens durable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lody-native-host-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const entry = join(root, 'host.mjs');
    await build({
      entryPoints: [join(import.meta.dirname, 'native-repo-host-entry.ts')],
      outfile: entry,
      platform: 'node',
      format: 'esm',
      bundle: true,
      plugins: [
        {
          name: 'external-native-package',
          setup(builder) {
            builder.onResolve({ filter: /^@loro-dev\/loro-repo-engine$/ }, () => ({
              path: require.resolve('@loro-dev/loro-repo-engine'),
              external: true,
            }));
          },
        },
      ],
    });
    const dataDir = join(root, 'data');
    let child!: ChildProcess;
    let firstSpawn = true;
    let denySignals = false;
    const owner = new NativeRepoHostLegacy(
      { dataDir, entry },
      {
        nodeProcess: {
          ...nodeProcessLive,
          spawn(command, args, options) {
            if (firstSpawn) {
              firstSpawn = false;
              throw new Error('Synthetic transient spawn failure');
            }
            child = nodeProcessLive.spawn(command, args, options);
            return child;
          },
          kill(pid, signal) {
            if (denySignals && signal !== 0)
              throw Object.assign(new Error('Synthetic signal denial'), { code: 'EPERM' });
            nodeProcessLive.kill(pid, signal);
          },
        },
      }
    );
    cleanups.push(() => owner.close());
    await expect(owner.client()).rejects.toThrow('Synthetic transient spawn failure');
    const [a, b] = await Promise.all([owner.client(), owner.client()]);
    expect(a).toBe(b);
    const first = await readEngineEndpoint(dataDir);
    expect(first.pid).not.toBe(process.pid);
    const room = { kind: 'flock' as const, id: 'local:fi:test' };
    await a.createRoom('test', room);
    await a.flockBatch('test', room, [{ op: 'put', key: ['file'], value: true }]);
    const attached = await connectEngine(dataDir);
    await attached.close();
    expect((await b.flockGet('test', room, ['file'])).value).toBe(true);
    let reset!: () => void;
    const resetObserved = new Promise<void>((resolve) => {
      reset = resolve;
    });
    const subscription = await a.flockSubscribe('test', room, {}, (_value, info) => {
      if (info.resetReason === 'reconnect') reset();
    });
    await terminateChildTreeLegacy(child, { processGroup: false, graceMs: 0, killWaitMs: 2000 });
    await resetObserved;
    expect((await b.flockGet('test', room, ['file'])).value).toBe(true);
    expect((await readEngineEndpoint(dataDir)).runId).not.toBe(first.runId);
    await subscription.unsubscribe();
    denySignals = true;
    await expect(owner.close()).rejects.toThrow();
    denySignals = false;
    await owner.close();
    await expect(owner.client()).rejects.toThrow('closed');
    const reopened = new NativeRepoHostLegacy({ dataDir, entry });
    cleanups.push(() => reopened.close());
    const client = await reopened.client();
    const next = await readEngineEndpoint(dataDir);
    expect(next.runId).not.toBe(first.runId);
    expect((await client.flockGet('test', room, ['file'])).value).toBe(true);
  });

  it('fails a missing bundle without acquiring an engine or poisoning a later owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lody-native-host-missing-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const owner = new NativeRepoHostLegacy({
      dataDir: join(root, 'data'),
      entry: join(root, 'absent.js'),
    });
    cleanups.push(() => owner.close());
    await expect(owner.client()).rejects.toThrow('bundle is missing');
  });

  it('migrates the real local FI/FIS producer, serves a read-only view, and rolls both rooms back after native writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lody-native-pilot-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const entry = join(root, 'host.mjs');
    await build({
      entryPoints: [join(import.meta.dirname, 'native-repo-host-entry.ts')],
      outfile: entry,
      platform: 'node',
      format: 'esm',
      bundle: true,
      plugins: [
        {
          name: 'external-native-package',
          setup(builder) {
            builder.onResolve({ filter: /^@loro-dev\/loro-repo-engine$/ }, () => ({
              path: require.resolve('@loro-dev/loro-repo-engine'),
              external: true,
            }));
          },
        },
      ],
    });
    const sqlite = await createCliSqliteRepoStore(
      'lw_pilot' as WorkspaceId,
      undefined,
      join(root, 'legacy')
    );
    cleanups.push(async () => sqlite.sqliteStore.close());
    const repo = await LoroRepo.create({ storageAdapter: sqlite.storageAdapter });
    cleanups.push(() => repo.destroy());
    const workspaceId = 'lw_pilot' as WorkspaceId;
    const owner = 'synthetic-owner' as SessionId;
    const roomId = getCodeCollabFileIndexFlockDocId(workspaceId, owner);
    const legacy = await repo.openFlockDoc(roomId);
    legacy.flock.set(['old.txt'], true, 1);
    legacy.flock.set(['deleted.txt'], true, 2);
    legacy.flock.delete(['deleted.txt'], 3);
    legacy.flock.commit();
    await repo.flush();
    const options = { directory: root, workspaceId, userId: 'local:pilot', repo, host: { entry } };
    const pilot = new NativeFileIndexPilotLegacy({ ...options, mode: 'native' });
    cleanups.push(() => pilot.close());
    const store = await pilot.store(owner);
    expect(await pilot.ownsRoom(roomId)).toBe(true);
    expect(await pilot.ownsRoom('foreign:fi:owner')).toBe(false);
    await publishCodeCollabFileIndexFlock({
      store,
      flockDocId: roomId,
      fileIndex: { 'fresh.txt': true },
      updatedAtMs: 10,
      reconcileRemote: false,
    });
    pilot.markPublished(owner);
    let ready!: () => void;
    const observed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const lease = await pilot.source.subscribe(owner, (state) => {
      if (state.status === 'ready' && state.fileIndex['fresh.txt'] === true) ready();
    });
    expect(lease).not.toBeNull();
    await observed;
    await lease!.release();
    // The old replica has not been dual-written by native publication.
    expect((await repo.openFlockDoc(roomId)).flock.get(['fresh.txt'])).toBeUndefined();
    await pilot.close();
    const reopened = new NativeFileIndexPilotLegacy({ ...options, mode: 'existing' });
    cleanups.push(() => reopened.close());
    expect(await reopened.ownsRoom(roomId)).toBe(true);
    await reopened.close();
    const rollback = new NativeFileIndexPilotLegacy({ ...options, mode: 'rollback' });
    cleanups.push(() => rollback.close());
    await rollback.store(owner);
    expect(await rollback.ownsRoom(roomId)).toBe(false);
    expect(await rollback.source.subscribe(owner, () => {})).toBeNull();
    const restored = (await repo.openFlockDoc(roomId)).flock;
    expect(restored.get(['fresh.txt'])).toBe(true);
    expect(restored.get(['old.txt'])).toBeUndefined();
    expect(restored.getEntry(['old.txt'])).toBeDefined();
    expect(restored.get(['deleted.txt'])).toBeUndefined();
  });
});
