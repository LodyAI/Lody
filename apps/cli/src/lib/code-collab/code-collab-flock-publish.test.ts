import { Flock } from '@loro-dev/flock-wasm';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEngine } from '@loro-dev/loro-repo-engine';
import {
  connectEngine,
  connectSocketTransport,
  readEngineEndpoint,
} from '@loro-dev/loro-repo-client/node';
import { RepoClient } from '@loro-dev/loro-repo-client';
import { createNativeLocalCodeCollabPublicationStore } from './code-collab-native-publication-store';

import {
  CODE_COLLAB_FILE_INDEX_LIMITS,
  buildCodeCollabFileIndexState,
  readCodeCollabFileIndexFromFlock,
  readCodeCollabFileGenerations,
  type CodeCollabFileIndexWritableFlock,
  type CodeCollabV2FileTreeState,
} from '@lody/shared';
import {
  publishCodeCollabFileIndexFlock as publishWithStore,
  publishCodeCollabFileIndexSignalFlock,
} from './code-collab-flock-publish';
import {
  createLegacyCodeCollabPublicationStore,
  type CodeCollabFlockRepo,
} from './code-collab-publication-store';

function publishCodeCollabFileIndexFlock(
  args: Omit<Parameters<typeof publishWithStore>[0], 'store'> & { repo: CodeCollabFlockRepo }
) {
  const { repo, ...publication } = args;
  return publishWithStore({ ...publication, store: createLegacyCodeCollabPublicationStore(repo) });
}

function makeFlock(
  initial: Record<string, unknown>,
  events: string[]
): {
  readonly flock: CodeCollabFileIndexWritableFlock;
  readonly replace: (next: Record<string, unknown>) => void;
  readonly snapshot: () => Record<string, unknown>;
} {
  const values = new Map(Object.entries(initial));
  const generations = new Map<string, unknown>();
  return {
    flock: {
      scan: () => [
        ...[...values].map(([key, value]) => ({ key: [key], value })),
        ...[...generations].map(([key, value]) => ({ key: [key, 'v'], value })),
      ],
      set: (keys, value) => {
        const key = keys[0];
        if (keys.length === 2) {
          generations.set(key, value);
          return;
        }
        events.push(`set:${key}`);
        values.set(key, value);
      },
      delete: (keys) => {
        const key = keys[0];
        if (keys.length === 2) {
          generations.delete(key);
          return;
        }
        events.push(`delete:${key}`);
        values.delete(key);
      },
      commit: () => {
        events.push('commit');
      },
    },
    replace: (next) => {
      values.clear();
      for (const [key, value] of Object.entries(next)) {
        values.set(key, value);
      }
    },
    snapshot: () => Object.fromEntries(values),
  };
}

describe('Code Collab Flock publication', () => {
  it('bumps only changed paths and invalidates unchanged rows when the comparison base changes', async () => {
    const local = makeFlock({}, []);
    const repo = {
      openFlockDoc: async () => ({ flock: local.flock, syncOnce: async () => undefined }),
      flush: async () => undefined,
    };
    const files = {
      'a.ts': { kind: 'text' as const, change: { diff: [1, 0] as [number, number] } },
      'b.ts': { kind: 'text' as const, change: { diff: [2, 0] as [number, number] } },
    };
    const publish = (
      fileIndex: typeof files,
      resetDiffGenerations = false,
      bumpDiffPaths?: readonly string[]
    ) =>
      publishCodeCollabFileIndexFlock({
        repo,
        flockDocId: 'workspace:fi:owner',
        fileIndex,
        updatedAtMs: 1,
        reconcileRemote: false,
        resetDiffGenerations,
        bumpDiffPaths,
      });
    await publish(files);
    const first = readCodeCollabFileGenerations(local.flock);
    await publish({ ...files, 'a.ts': { ...files['a.ts'], change: { diff: [3, 0] } } });
    const second = readCodeCollabFileGenerations(local.flock);
    expect(second['a.ts']).not.toBe(first['a.ts']);
    expect(second['b.ts']).toBe(first['b.ts']);
    const current = readCodeCollabFileIndexFromFlock(local.flock);
    await publish(current as typeof files, false, ['a.ts']);
    const sameStats = readCodeCollabFileGenerations(local.flock);
    expect(sameStats['a.ts']).not.toBe(second['a.ts']);
    expect(sameStats['b.ts']).toBe(second['b.ts']);
    await publish(current as typeof files, true);
    const third = readCodeCollabFileGenerations(local.flock);
    expect(third['a.ts']).not.toBe(second['a.ts']);
    expect(third['b.ts']).not.toBe(second['b.ts']);
    expect(readCodeCollabFileIndexFromFlock(local.flock)).toEqual(current);
  });

  it('does not apply a stale file index when cancellation wins a pending pre-sync', async () => {
    const events: string[] = [];
    const local = makeFlock({ 'old.ts': true }, events);
    const controller = new AbortController();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const work = publishCodeCollabFileIndexFlock({
      repo: {
        openFlockDoc: async () => ({
          flock: local.flock,
          syncOnce: async () => {
            ready();
            await pending;
          },
        }),
        flush: async () => {
          throw new Error('Cancelled pre-sync must not flush');
        },
      },
      signal: controller.signal,
      flockDocId: 'workspace:fi:owner',
      fileIndex: { 'stale.ts': true },
      updatedAtMs: 1,
      reconcileRemote: true,
    });
    const cancelled = expect(work).rejects.toThrow('cancelled');
    await started;
    controller.abort(new Error('cancelled'));
    await cancelled;
    release();
    await pending;
    expect(local.snapshot()).toEqual({ 'old.ts': true });
  });

  it('cleans an oversized legacy index in bounded commits and converges to the bounded state', async () => {
    const flock = new Flock();
    const legacy: CodeCollabV2FileTreeState = {};
    // Synthetic store-like paths: long, multi-byte and JSON-escaped segments.
    for (let index = 0; index < 4_000; index += 1) {
      legacy[`.pnpm-store/v10/index/${String(index).padStart(6, '0')}-缓存-"q"\\name@1.0.0.json`] =
        true;
    }
    for (const [key, value] of Object.entries(legacy)) {
      flock.set([key], value);
      flock.set([key, 'v'], { g: 'legacy' });
    }
    flock.commit();

    const tree: CodeCollabV2FileTreeState = { src: { kind: 'lazy' } };
    for (let index = 0; index < 1_200; index += 1) tree[`src/file-${index}.ts`] = true;
    const target = buildCodeCollabFileIndexState(tree, {
      'src/file-1.ts': { diff: [2, 1] },
      'src/removed.ts': { diff: [0, 4], del: true },
    });

    let exportedFrom = flock.version();
    const exportedBundleBytes: number[] = [];
    const recordExport = async () => {
      const bundle = flock.exportJson(exportedFrom);
      exportedFrom = flock.version();
      exportedBundleBytes.push(new TextEncoder().encode(JSON.stringify(bundle)).byteLength);
    };
    const result = await publishCodeCollabFileIndexFlock({
      repo: {
        openFlockDoc: async () => ({ flock, syncOnce: recordExport }),
        flush: async () => undefined,
      },
      flockDocId: 'workspace:fi:owner',
      fileIndex: target,
      updatedAtMs: 1_800_000_000_000,
      reconcileRemote: false,
    });

    expect(result.changed).toBe(true);
    expect(readCodeCollabFileIndexFromFlock(flock)).toEqual(target);
    const generations = readCodeCollabFileGenerations(flock);
    expect(Object.keys(generations).sort()).toEqual(['src/file-1.ts', 'src/removed.ts']);
    expect(target['src/removed.ts']).toEqual({
      kind: 'deleted',
      change: { diff: [0, 4], del: true },
    });
    expect(exportedBundleBytes.length).toBeGreaterThan(1);
    for (const bytes of exportedBundleBytes) {
      expect(bytes).toBeLessThanOrEqual(CODE_COLLAB_FILE_INDEX_LIMITS.maxBytes);
    }
    // The complete published state also fits one bundle.
    const full = new TextEncoder().encode(JSON.stringify(flock.exportJson())).byteLength;
    expect(full - countTombstoneBytes(flock)).toBeLessThanOrEqual(
      CODE_COLLAB_FILE_INDEX_LIMITS.maxBytes
    );
    // A generation-only reset still commits and syncs, without rewriting file rows.
    const lastExport = exportedBundleBytes.length;
    const reset = await publishCodeCollabFileIndexFlock({
      repo: {
        openFlockDoc: async () => ({ flock, syncOnce: recordExport }),
        flush: async () => undefined,
      },
      flockDocId: 'workspace:fi:owner',
      fileIndex: target,
      updatedAtMs: 1_800_000_000_001,
      reconcileRemote: false,
      resetDiffGenerations: true,
    });
    expect(reset.changed).toBe(true);
    expect(readCodeCollabFileIndexFromFlock(flock)).toEqual(target);
    for (const path of Object.keys(generations))
      expect(readCodeCollabFileGenerations(flock)[path]).not.toBe(generations[path]);
    expect(exportedBundleBytes.slice(lastExport).length).toBeGreaterThan(0);
    for (const bytes of exportedBundleBytes.slice(lastExport))
      expect(bytes).toBeLessThanOrEqual(CODE_COLLAB_FILE_INDEX_LIMITS.maxBytes);
  });
});

function countTombstoneBytes(flock: Flock): number {
  const bundle = flock.exportJson() as { entries: Record<string, { d?: unknown }> };
  let bytes = 0;
  for (const [key, record] of Object.entries(bundle.entries)) {
    if (record.d === undefined) {
      bytes += new TextEncoder().encode(
        `${JSON.stringify(key)}:${JSON.stringify(record)},`
      ).byteLength;
    }
  }
  return bytes;
}

describe('native local Code Collab publication', () => {
  const namespace = 'publication-test';
  const workspaceId = 'workspace';
  const indexId = `${workspaceId}:fi:owner`;
  const signalId = `${workspaceId}:fis:owner`;
  const room = { kind: 'flock' as const, id: indexId };

  async function withEngine(run: (client: RepoClient, dataDir: string) => Promise<void>) {
    const dataDir = await mkdtemp(join(tmpdir(), 'lody-native-publication-'));
    let engine: ReturnType<typeof startEngine> | undefined;
    let client: RepoClient | undefined;
    try {
      engine = startEngine({ dataDir });
      client = await connectEngine(dataDir);
      await run(client, dataDir);
    } finally {
      try {
        await client?.close();
      } finally {
        engine?.stop();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }

  it('persists bounded file rows and generations, dedupes unchanged state, and advances only its signal room', async () => {
    await withEngine(async (client) => {
      const store = createNativeLocalCodeCollabPublicationStore({ client, namespace, workspaceId });
      const fileIndex = {
        'a.ts': { kind: 'text' as const, change: { diff: [2, 1] as [number, number] } },
        src: { kind: 'lazy' as const },
      };
      const first = await publishWithStore({
        store,
        flockDocId: indexId,
        fileIndex,
        updatedAtMs: 1,
        reconcileRemote: false,
      });
      const state = await client.flockScan(namespace, room);
      expect(readCodeCollabFileIndexFromFlock({ scan: () => state.entries })).toEqual(fileIndex);
      expect(readCodeCollabFileGenerations({ scan: () => state.entries })).toEqual(
        first.generations
      );
      expect(first.changed).toBe(true);
      expect(
        await publishWithStore({
          store,
          flockDocId: indexId,
          fileIndex,
          updatedAtMs: 2,
          reconcileRemote: true,
        })
      ).toEqual({ changed: false, generations: first.generations });
      expect((await client.flockScan(namespace, room)).roomTxId).toBe(state.roomTxId);
      expect(
        await publishCodeCollabFileIndexSignalFlock({ store, flockDocId: signalId, updatedAtMs: 2 })
      ).toEqual({ changed: true, revision: 1 });
      expect(
        (await client.flockGet(namespace, { kind: 'flock', id: signalId }, ['s'])).value
      ).toEqual({ v: 1, r: 1 });
      await expect(store.open('another-workspace:fi:owner')).rejects.toThrow(
        'outside this workspace'
      );
      await expect(store.open(`${workspaceId}:wf:catalog`)).rejects.toThrow(
        'outside this workspace'
      );
      await expect(client.flockScan(namespace, { kind: 'meta', id: 'meta' })).rejects.toThrow();
    });
  });

  it('replans an actual rejected CAS without replacing an unrelated room', async () => {
    await withEngine(async (client) => {
      const native = createNativeLocalCodeCollabPublicationStore({
        client,
        namespace,
        workspaceId,
      });
      const signalRoom = { kind: 'flock' as const, id: signalId };
      await client.createRoom(namespace, signalRoom);
      await client.flockBatch(namespace, signalRoom, [
        { op: 'put', key: ['s'], value: { v: 1, r: 7 } },
      ]);
      let injectConflict = true;
      const store = {
        async open(id: string, signal?: AbortSignal) {
          const acquired = await native.open(id, signal);
          return {
            ...acquired,
            async commit(...args: Parameters<typeof acquired.commit>) {
              if (injectConflict) {
                injectConflict = false;
                await client.flockBatch(namespace, room, [
                  { op: 'put', key: ['obsolete.ts'], value: true },
                ]);
              }
              return acquired.commit(...args);
            },
          };
        },
      };
      await publishWithStore({
        store,
        flockDocId: indexId,
        fileIndex: { 'current.ts': true },
        updatedAtMs: 1,
        reconcileRemote: false,
      });
      const state = await client.flockScan(namespace, room);
      expect(readCodeCollabFileIndexFromFlock({ scan: () => state.entries })).toEqual({
        'current.ts': true,
      });
      expect((await client.flockGet(namespace, signalRoom, ['s'])).value).toEqual({ v: 1, r: 7 });
    });
  });

  it('does not replay an unknown write when the committed response is lost', async () => {
    await withEngine(async (inspector, dataDir) => {
      await inspector.createRoom(namespace, room);
      const before = await inspector.flockScan(namespace, room);
      const transport = await connectSocketTransport((await readEngineEndpoint(dataDir)).socket);
      let responses = 0;
      const client = new RepoClient({
        send: (message) => transport.send(message),
        onMessage: (listener) =>
          transport.onMessage((message) => {
            responses++;
            if (responses === 3) void transport.close();
            else listener(message);
          }),
        onClose: (listener) => transport.onClose(listener),
        close: () => transport.close(),
      });
      try {
        const store = createNativeLocalCodeCollabPublicationStore({
          client,
          namespace,
          workspaceId,
        });
        await expect(
          publishWithStore({
            store,
            flockDocId: indexId,
            fileIndex: { 'committed.ts': true },
            updatedAtMs: 1,
            reconcileRemote: false,
          })
        ).rejects.toThrow('publication failed');
        const after = await inspector.flockScan(namespace, room);
        expect(readCodeCollabFileIndexFromFlock({ scan: () => after.entries })).toEqual({
          'committed.ts': true,
        });
        expect(after.roomTxId).toBe(before.roomTxId + 1);
        expect(responses).toBe(3);
      } finally {
        await client.close();
      }
    });
  });
});

it('retains persisted Cloud FI fences without a factory while unrelated legacy publication and Session metadata remain usable', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createHash } = await import('node:crypto');
  const { mkdir, readFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { LoroRepo } = await import('loro-repo');
  const {
    cloudFileIndexAuthorityId,
    cloudFileIndexSelectionPath,
    listCloudFileIndexSelections,
    unavailableCloudFileIndexBackend,
  } = await import('./code-collab-cloud-file-index-selection');
  const root = await mkdtemp(join(tmpdir(), 'lody-cloud-fi-admission-'));
  const workspace = 'cloud-fi-workspace' as import('@lody/shared').WorkspaceId;
  const account = 'cloud-fi-account';
  const authority = cloudFileIndexAuthorityId('https://deployment.example', 'https://auth.example');
  const filename = cloudFileIndexSelectionPath(root, account, workspace, authority);
  await mkdir(dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec(
    'PRAGMA synchronous=FULL;CREATE TABLE file_index_binding(version INTEGER,account TEXT,workspace TEXT,authority TEXT,machine TEXT,cohort TEXT,selected TEXT);CREATE TABLE file_index_owners(owner TEXT PRIMARY KEY,stage TEXT)'
  );
  database.prepare('INSERT INTO file_index_binding VALUES(1,?,?,?,?,?,?)').run(
    account,
    workspace,
    authority,
    'machine',
    createHash('sha256')
      .update(JSON.stringify(['frozen', 'native']))
      .digest('hex'),
    JSON.stringify(['frozen', 'native'])
  );
  database.prepare('INSERT INTO file_index_owners VALUES(?,?)').run('native', 'native');
  database.prepare('INSERT INTO file_index_owners VALUES(?,?)').run('frozen', 'frozen');
  database.close();
  const before = await readFile(filename);
  const repo = await LoroRepo.create({});
  try {
    const selection = listCloudFileIndexSelections(root, account, workspace, authority);
    expect(selection.flatMap((value) => value.owners.map((owner) => owner.owner)).sort()).toEqual([
      'frozen',
      'native',
    ]);
    expect(
      listCloudFileIndexSelections(
        root,
        account,
        workspace,
        cloudFileIndexAuthorityId('https://other.example', 'https://auth.example')
      )
    ).toEqual([]);
    const backend = unavailableCloudFileIndexBackend(
      repo,
      workspace,
      selection.flatMap((value) => value.owners.map((owner) => owner.owner))
    );
    for (const owner of ['native', 'frozen']) {
      expect(await backend.ownsRoom(`${workspace}:fi:${owner}`)).toBe(true);
      expect(await backend.ownsRoom(`${workspace}:fis:${owner}`)).toBe(true);
      await expect(backend.store(owner)).rejects.toThrow('recovery required');
      expect(() => repo.openFlockDoc(`${workspace}:fi:${owner}`)).toThrow('recovery required');
      const snapshots: unknown[] = [];
      const observer = await backend.source.subscribe(owner, (state) => snapshots.push(state));
      expect(snapshots).toEqual([
        { status: 'error', code: 'native_cloud_index_recovery_required' },
      ]);
      await observer?.release();
    }
    expect(
      await backend.source.subscribe('unselected', () => {
        throw new Error('Unselected owner must remain legacy');
      })
    ).toBeNull();
    const roomId = `${workspace}:fi:unselected`;
    await publishWithStore({
      store: await backend.store('unselected'),
      flockDocId: roomId,
      fileIndex: { 'healthy.txt': true },
      updatedAtMs: 1,
      reconcileRemote: false,
    });
    expect(readCodeCollabFileIndexFromFlock((await repo.openFlockDoc(roomId)).flock)).toEqual({
      'healthy.txt': true,
    });
    await repo.upsertDocMeta('session-unrelated', { type: 'session', title: 'still writable' });
    await repo.flush();
    expect(await repo.getDocMeta('session-unrelated')).toMatchObject({
      meta: { title: 'still writable' },
      deleted: false,
    });
    await backend.close();
    expect(await readFile(filename)).toEqual(before);
  } finally {
    await repo.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
