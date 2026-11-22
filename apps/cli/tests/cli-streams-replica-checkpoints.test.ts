/**
 * The daemon and one-shot CLI commands open the same `repo.sqlite3` with their
 * own in-memory replicas. Streams progress must therefore belong to the replica
 * that loaded it: a process that hydrated before another process advanced data
 * and cursor has to bootstrap, not resume at that tail. Meta/Flock cursors are
 * replica-bound; LoroDoc cursor writes are daemon-only; commands can seed covered progress.
 *
 * Drives the real CLI composition (`createCliSqliteRepoStore` +
 * `createCliStreamsTransport` + `LoroRepo`) against a scripted Streams server.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import {
  getLoroMetaStreamId,
  DEFAULT_LORO_STREAMS_BASE_URL,
  LEGACY_LORO_STREAMS_BASE_URL,
  getLoroStreamIdForDocId,
  getWorkspaceFlockDocId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroStreamsTokenProviderLegacy } from '@lody/platform';
import { LoroRepo } from 'loro-repo';
import {
  createCliSqliteRepoStore,
  createCliIncompleteRecoveryStore,
  hasPersistedFlockRemoteState,
  createDocumentRemoteCursorStore,
  ProcessDocumentRemoteCursorStore,
  type CliSqliteRepoStore,
  type DocumentCursorScope,
} from '../src/lib/loro/sqlite-repo-store';
import { createCliStreamsTransport } from '../src/lib/loro/streams-transport';
import type { Logger } from '../src/utils/logger';

import { Effect, Layer } from 'effect';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import {
  makeLoroStreamsTokenProvider,
  makeLoroStreamsTokenWebPorts,
  LoroStreamsTokenPorts,
} from '@lody/shared';
import { LoroDocumentManager } from '../src/lib/loro/doc';
import { WorkspacePresenceOwnersLive } from '../src/lib/loro/workspace-presence';
import { presencePlatformLayer } from '../src/platform/presence';
import {
  bindWorkspacePresenceApplicationLegacy,
  createCliPresenceRuntimeLegacy,
  recoverCliPresenceApplicationShutdown,
  WorkspacePresenceLegacyFailure,
} from '../src/lib/loro/presence-legacy';
import { CliMachineMonitorRuntime } from '../src/lib/loro/machine-monitor';
import { CliPromptSuggestions } from '../src/lib/loro/prompt-suggestions';

const workspaceId = 'ws-replica-checkpoints' as WorkspaceId;
const gatewayBaseUrl = 'https://streams.checkpoint.invalid';
const tail100 = '00000000000000000100';
const keyA = ['m', 'doc-a', 'title'];

const silentLogger = new Proxy({}, { get: () => () => {} }) as Logger;

const tokenProvider = {
  getToken: async () => 'streams-jwt',
  getGatewayBaseUrl: () => gatewayBaseUrl,
  getShardHostSuffix: () => undefined,
  invalidate: () => {},
  createAuthCallback: () => async () => 'streams-jwt',
} as unknown as LoroStreamsTokenProviderLegacy;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

const metaSnapshotWithA = (): Uint8Array => {
  const server = new Flock('server');
  server.put(keyA, 'A');
  return server.exportFile();
};

/** Streams serving `snapshot` at offset 100; catch-up from 100 has nothing new. */
function createStreamsServer(
  snapshot: Uint8Array,
  respond?: (url: URL, method: string, init?: RequestInit) => Response | undefined
) {
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(url);
      const intercepted = respond?.(url, init?.method ?? 'GET', init);
      if (intercepted) return intercepted;
      if (init?.method === 'POST') {
        const headers = new Headers(init.headers);
        return new Response(null, {
          headers: {
            'Producer-Epoch': headers.get('Producer-Epoch') ?? '0',
            'Producer-Seq': headers.get('Producer-Seq') ?? '0',
            'Stream-Next-Offset': tail100,
            'Stream-Up-To-Date': 'true',
          },
        });
      }
      if (url.pathname.endsWith('/bootstrap')) {
        return new Response(
          new Blob([
            '--cp\r\nContent-Type: application/octet-stream\r\n\r\n',
            toArrayBuffer(snapshot),
            '\r\n--cp--\r\n',
          ]),
          {
            headers: {
              'Content-Type': 'multipart/mixed; boundary=cp',
              'Stream-Snapshot-Offset': tail100,
              'Stream-Next-Offset': tail100,
              'Stream-Up-To-Date': 'true',
            },
          }
        );
      }
      return new Response(null, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': url.searchParams.get('offset') ?? tail100,
          'Stream-Up-To-Date': 'true',
        },
      });
    })
  );
  const bootstraps = () => requests.filter((url) => url.pathname.endsWith('/bootstrap')).length;
  return { bootstraps, requests };
}

type CliProcess = {
  store: CliSqliteRepoStore;
  repo: LoroRepo;
  documentRemoteCursorStore: ReturnType<typeof createDocumentRemoteCursorStore>;
};

let dataDir: string;
const openProcesses = new Set<CliProcess>();
const originalDataDir = process.env.LODY_DATA_DIR;

/** One daemon or one-shot command: its own connection and in-memory replica. */
async function openCliProcess(scope: DocumentCursorScope = 'shared-durable'): Promise<CliProcess> {
  const store = await createCliSqliteRepoStore(workspaceId);
  const repo = await LoroRepo.create({
    storageAdapter: store.storageAdapter,
    metaDebounceCommitMs: 0,
  });
  const cliProcess = {
    store,
    repo,
    documentRemoteCursorStore: createDocumentRemoteCursorStore(store, scope),
  };
  openProcesses.add(cliProcess);
  return cliProcess;
}

async function closeCliProcess(cliProcess: CliProcess): Promise<void> {
  openProcesses.delete(cliProcess);
  await cliProcess.repo.destroy();
  cliProcess.store.sqliteStore.close();
}

async function withTransport<T>(
  cliProcess: CliProcess,
  run: (adapter: Awaited<ReturnType<typeof createCliStreamsTransport>>['adapter']) => Promise<T>,
  baseUrl = gatewayBaseUrl
): Promise<T> {
  const { adapter } = await createCliStreamsTransport({
    content: { mode: 'plaintext' },
    incompleteRecoveryStore: createCliIncompleteRecoveryStore(
      cliProcess.store,
      cliProcess.documentRemoteCursorStore instanceof ProcessDocumentRemoteCursorStore
        ? 'process'
        : 'shared-durable'
    ),
    workspaceId,
    tokenProvider: { ...tokenProvider, getGatewayBaseUrl: () => baseUrl },
    repo: cliProcess.repo,
    documentRemoteCursorStore: cliProcess.documentRemoteCursorStore,
    logger: silentLogger,
  });
  try {
    return await run(adapter);
  } finally {
    await adapter.close();
  }
}

const syncMeta = (cliProcess: CliProcess) =>
  withTransport(cliProcess, (adapter) => adapter.syncMeta(cliProcess.repo.getMeta()));

const syncDoc = (cliProcess: CliProcess, docId: string, doc: LoroDoc) =>
  withTransport(cliProcess, (adapter) => adapter.syncDoc(docId, doc));

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-replica-checkpoints-'));
  process.env.LODY_DATA_DIR = dataDir;
});

afterEach(async () => {
  for (const cliProcess of [...openProcesses]) await closeCliProcess(cliProcess);
  vi.unstubAllGlobals();
  if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
  else process.env.LODY_DATA_DIR = originalDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('CLI Streams checkpoints are bound to the replica that loaded them', () => {
  it.each([false, true])(
    'attaches cloud ephemeral rooms only when enabled (%s)',
    async (attachCloudEphemeralSinks) => {
      const seen = new Set<string>();
      const requested = new Map<string, () => void>();
      const roomsReady = Promise.all(
        ['presence', 'machine-monitor'].map(
          (room) => new Promise<void>((resolve) => requested.set(room, resolve))
        )
      );
      const server = createStreamsServer(metaSnapshotWithA(), (url, method, init) => {
        const ephemeral = url.searchParams.get('ephemeral');
        if (ephemeral) seen.add(ephemeral);
        if (ephemeral && method === 'GET') requested.get(ephemeral)?.();
        if (ephemeral && method === 'GET') {
          let stopped = false;
          let stop = () => {};
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: bootstrap\ndata: \n\n'));
              stop = () => {
                if (!stopped) {
                  stopped = true;
                  controller.close();
                }
              };
              init?.signal?.addEventListener('abort', stop, { once: true });
            },
            cancel() {
              stopped = true;
              init?.signal?.removeEventListener('abort', stop);
            },
          });
          return new Response(body, {
            headers: { 'Content-Type': 'text/event-stream', 'Stream-SSE-Data-Encoding': 'base64' },
          });
        }
        return undefined;
      });
      const app = makeApplicationRuntime(
        WorkspacePresenceOwnersLive.pipe(
          Layer.provide(presencePlatformLayer(silentLogger, globalThis.fetch))
        ),
        {
          recover: recoverCliPresenceApplicationShutdown,
          project: (cause) => new WorkspacePresenceLegacyFailure(cause),
        }
      );
      bindWorkspacePresenceApplicationLegacy(app);
      const cli = await openCliProcess('process');
      const manager = new LoroDocumentManager({
        repo: cli.repo,
        workspaceId,
        userId: 'synthetic-user',
        logger: silentLogger,
        metaSub: null,
        sqliteRepoStore: cli.store,
        documentRemoteCursorStore: cli.documentRemoteCursorStore,
        attachCloudEphemeralSinks,
        presenceRuntime: await createCliPresenceRuntimeLegacy(workspaceId),
        machineMonitorRuntime: new CliMachineMonitorRuntime({ workspaceId, logger: silentLogger }),
        promptSuggestions: new CliPromptSuggestions(workspaceId, silentLogger),
        streamsTokens: {
          createTokenProvider: () =>
            makeLoroStreamsTokenProvider({
              endpoint: 'https://synthetic.invalid/token',
              workspaceId,
            }).pipe(
              Effect.provideService(
                LoroStreamsTokenPorts,
                makeLoroStreamsTokenWebPorts({
                  credential: Effect.succeed('synthetic'),
                  fetchImpl: async () =>
                    new Response(
                      JSON.stringify({ token: 'synthetic', expiresIn: 900, gatewayBaseUrl })
                    ),
                })
              )
            ),
        },
      });
      vi.useFakeTimers({
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      try {
        const attaching = manager.attachRemoteStreamsTransport();
        await attaching;
        if (attachCloudEphemeralSinks) await roomsReady;
        expect((await syncMeta(cli)).ok).toBe(true);
        expect(cli.repo.getMeta().get(keyA)).toBe('A');
        expect(server.bootstraps()).toBe(1);
        expect(seen.has('presence')).toBe(attachCloudEphemeralSinks);
        expect(seen.has('machine-monitor')).toBe(attachCloudEphemeralSinks);
        if (!attachCloudEphemeralSinks) expect([...seen]).toEqual([]);
        await manager.detachRemoteStreamsTransport();
        await manager.detachRemoteStreamsTransport();
      } finally {
        openProcesses.delete(cli);
        vi.useRealTimers();
        await manager.cleanUp({ fast: true });
        await app.closeLegacy();
      }
    }
  );

  it.each(['import', 'importBatch'] as const)(
    'preserves pending-only %s updates across a SQLite restart',
    async (method) => {
      const remote = new LoroDoc();
      remote.setPeerId(1n);
      remote.getText('t').insert(0, 'base|');
      const snapshot = remote.export({ mode: 'snapshot' });
      const beforeA = remote.oplogVersion();
      remote.getText('t').push('A');
      const updateA = remote.export({ mode: 'update', from: beforeA });
      const beforeB = remote.oplogVersion();
      remote.getText('t').push('B');
      const updateB = remote.export({ mode: 'update', from: beforeB });

      const daemon = await openCliProcess();
      const docId = `session-pending-${method}`;
      const doc = (await daemon.repo.openPersistedDoc(docId)).doc;
      doc.import(snapshot);
      await daemon.repo.flush();
      const applied = doc.oplogVersion().encode();

      const imported = method === 'import' ? doc.import(updateB) : doc.importBatch([updateB]);
      // B has been received, but cannot emit an applied change before A arrives.
      expect(imported.success.size).toBe(0);
      expect(imported.pending?.size).toBeGreaterThan(0);
      expect(doc.getText('t').toString()).toBe('base|');
      expect(doc.oplogVersion().encode()).toEqual(applied);
      await daemon.repo.flush();
      await closeCliProcess(daemon);

      const restarted = await openCliProcess();
      const restored = (await restarted.repo.openPersistedDoc(docId)).doc;
      expect(restored.getText('t').toString()).toBe('base|');
      expect(restored.oplogVersion().encode()).toEqual(applied);
      restored.import(updateA);
      expect(restored.getText('t').toString()).toBe('base|AB');
      expect(restored.oplogVersion().encode()).toEqual(remote.oplogVersion().encode());
      await restarted.repo.flush();
      await closeCliProcess(restarted);

      const reopened = await openCliProcess();
      const complete = (await reopened.repo.openPersistedDoc(docId)).doc;
      expect(complete.getText('t').toString()).toBe('base|AB');
      expect(complete.oplogVersion().encode()).toEqual(remote.oplogVersion().encode());
    }
  );

  it('recognizes remote catalog history only after real Streams persistence, across restart and purge', async () => {
    const daemon = await openCliProcess();
    const docId = getWorkspaceFlockDocId(workspaceId);
    const local = await daemon.repo.openFlockDoc(docId);
    local.flock.set(['project', 'locally-authored'], 'local');
    await daemon.repo.flush();
    expect(hasPersistedFlockRemoteState(daemon.store.dbPath, docId)).toBe(false);
    const remote = new Flock('remote');
    remote.set(['project', 'remote-project'], 'remote');
    createStreamsServer(remote.exportFile());
    expect(
      (await withTransport(daemon, (adapter) => adapter.syncFlockDoc(docId, local.flock))).ok
    ).toBe(true);
    expect(local.flock.get(['project', 'remote-project'])).toBe('remote');
    expect(hasPersistedFlockRemoteState(daemon.store.dbPath, docId)).toBe(true);
    await closeCliProcess(daemon);
    const restarted = await openCliProcess();
    expect(hasPersistedFlockRemoteState(restarted.store.dbPath, docId)).toBe(true);
    await restarted.store.storageAdapter.deleteFlockDoc?.(docId);
    expect(hasPersistedFlockRemoteState(restarted.store.dbPath, docId)).toBe(false);
  });

  it('bootstraps a process that hydrated before another process advanced the shared file', async () => {
    const server = createStreamsServer(metaSnapshotWithA());
    // The one-shot command opens first, while the file is still empty.
    const oneShot = await openCliProcess('process');
    const daemon = await openCliProcess('shared-durable');

    expect((await syncMeta(daemon)).ok).toBe(true);
    expect(daemon.repo.getMeta().get(keyA)).toBe('A');
    expect(server.bootstraps()).toBe(1);

    // The file now holds A and the daemon's offset-100 checkpoint, but the
    // one-shot replica never loaded A: resuming at 100 would skip it forever.
    expect((await syncMeta(oneShot)).ok).toBe(true);
    expect(oneShot.repo.getMeta().get(keyA)).toBe('A');
    expect(server.bootstraps()).toBe(2);

    // Meta progress lives with the replica checkpoints, not in the shared
    // LoroDoc cursor table.
    const metaStreamSuffix = `/${encodeURIComponent(getLoroMetaStreamId(workspaceId))}`;
    const sharedRows = oneShot.store.sqliteStore.db
      .prepare('SELECT stream_url FROM remote_cursors')
      .all() as Array<{ stream_url: string }>;
    expect(sharedRows.filter((row) => row.stream_url.endsWith(metaStreamSuffix))).toEqual([]);
  });

  it('bootstraps a doc a one-shot command loaded before the daemon advanced it', async () => {
    const docId = 'session-one-shot';
    const remote = new LoroDoc();
    remote.getText('t').insert(0, 'A');
    const server = createStreamsServer(remote.export({ mode: 'snapshot' }));
    // The one-shot command opens the session doc first, while it is still empty.
    const oneShot = await openCliProcess('process');
    const oneShotDoc = (await oneShot.repo.openPersistedDoc(docId)).doc;
    const daemon = await openCliProcess('shared-durable');
    const daemonDoc = (await daemon.repo.openPersistedDoc(docId)).doc;

    expect((await syncDoc(daemon, docId, daemonDoc)).ok).toBe(true);
    expect(daemonDoc.getText('t').toString()).toBe('A');
    expect(server.bootstraps()).toBe(1);

    // The shared file now holds A and the daemon's offset-100 doc cursor; the
    // one-shot replica never loaded A and must not resume at that tail.
    expect((await syncDoc(oneShot, docId, oneShotDoc)).ok).toBe(true);
    expect(oneShotDoc.getText('t').toString()).toBe('A');
    expect(server.bootstraps()).toBe(2);
  });

  it.each(['meta', 'flock'] as const)(
    'resumes %s across gateway aliases without bootstrap',
    async (kind) => {
      const server = createStreamsServer(metaSnapshotWithA());
      const id = 'named-flock';
      const first = await openCliProcess();
      const sync = async (cli: CliProcess, baseUrl: string) => {
        const flock =
          kind === 'meta' ? cli.repo.getMeta() : (await cli.repo.openFlockDoc(id)).flock;
        const result = await withTransport(
          cli,
          (adapter) =>
            kind === 'meta' ? adapter.syncMeta(flock) : adapter.syncFlockDoc(id, flock),
          baseUrl
        );
        expect(result.ok).toBe(true);
        expect(flock.get(keyA)).toBe('A');
      };
      await sync(first, LEGACY_LORO_STREAMS_BASE_URL);
      await first.repo.flush();
      await closeCliProcess(first);
      expect(server.bootstraps()).toBe(1);
      const next = await openCliProcess();
      await sync(next, DEFAULT_LORO_STREAMS_BASE_URL);
      expect(server.bootstraps()).toBe(1);
    }
  );

  it('freezes a process cursor with document load before another connection advances it', async () => {
    const id = 'session-atomic';
    const remote = new LoroDoc();
    remote.getText('t').insert(0, 'cached');
    const server = createStreamsServer(remote.export({ mode: 'snapshot' }));
    const daemon = await openCliProcess();
    const doc = (await daemon.repo.openPersistedDoc(id)).doc;
    expect((await syncDoc(daemon, id, doc)).ok).toBe(true);
    const oneShot = await openCliProcess('process');
    const loaded = (await oneShot.repo.openPersistedDoc(id)).doc;
    const row = daemon.store.sqliteStore.db
      .prepare('SELECT stream_url FROM remote_cursors')
      .get() as { stream_url: string };
    const original = await daemon.documentRemoteCursorStore.load(row.stream_url);
    if (!original) throw new Error('missing cursor');
    await daemon.documentRemoteCursorStore.save({ ...original, nextOffset: '200' });
    const before = daemon.store.sqliteStore.db.prepare('SELECT * FROM remote_cursors').all();
    server.requests.length = 0;
    expect((await syncDoc(oneShot, id, loaded)).ok).toBe(true);
    expect(server.bootstraps()).toBe(0);
    expect(server.requests.some((url) => url.searchParams.get('offset') === tail100)).toBe(true);
    expect(daemon.store.sqliteStore.db.prepare('SELECT * FROM remote_cursors').all()).toEqual(
      before
    );
  });

  it('uses only HEAD after a daemon persists an unchanged incomplete tail', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const author = new LoroDoc();
    author.getText('t').insert(0, 'prefix');
    author.commit();
    const from = author.version();
    author.getText('t').push('|tail');
    author.commit();
    const dependent = author.export({ mode: 'update', from });
    const frame = new Uint8Array(4 + dependent.byteLength);
    new DataView(frame.buffer).setUint32(0, dependent.byteLength);
    frame.set(dependent, 4);
    const methods: string[] = [];
    const server = createStreamsServer(new Uint8Array(), (url, method) => {
      methods.push(method);
      if (method === 'HEAD')
        return new Response(null, {
          headers: {
            'Stream-Next-Offset': tail100,
            'Stream-Snapshot-Offset': '-1',
            'Content-Type': 'application/octet-stream',
          },
        });
      if (url.pathname.endsWith('/bootstrap'))
        return new Response(
          '--cp\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--cp--\r\n',
          {
            headers: {
              'Content-Type': 'multipart/mixed; boundary=cp',
              'Stream-Snapshot-Offset': '-1',
              'Stream-Next-Offset': '-1',
              'Stream-Up-To-Date': 'false',
            },
          }
        );
      return new Response(toArrayBuffer(frame), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': tail100,
          'Stream-Up-To-Date': 'true',
        },
      });
    });
    const daemon = await openCliProcess();
    const id = 'incomplete';
    const doc = (await daemon.repo.openPersistedDoc(id)).doc;
    const url = `${gatewayBaseUrl}/ds/lody/${getLoroStreamIdForDocId(workspaceId, id)}`;
    const records = createCliIncompleteRecoveryStore(daemon.store, 'shared-durable');
    await withTransport(daemon, async (adapter) => {
      const live = adapter.joinDocRoom(id, doc);
      void live.firstSyncedWithRemote.catch(() => {});
      try {
        await vi.waitFor(async () => expect(await records.load(url)).not.toBeNull(), {
          interval: 0,
        });
      } finally {
        live.unsubscribe();
      }
    });
    await closeCliProcess(daemon);
    const restarted = await openCliProcess('process');
    const loaded = (await restarted.repo.openPersistedDoc(id)).doc;
    methods.length = 0;
    const before = server.bootstraps();
    expect((await syncDoc(restarted, id, loaded)).ok).toBe(false);
    expect(methods).toEqual(['HEAD']);
    expect(server.bootstraps()).toBe(before);
    expect(loaded.getText('t').toString()).toBe('');
    author.free();
  });

  it('shares recovery metadata across connections while command writes remain private', async () => {
    const daemon = await openCliProcess();
    const url = `${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/recovery`;
    const alias = `${DEFAULT_LORO_STREAMS_BASE_URL}/ds/lody/recovery`;
    const record = {
      streamUrl: url,
      observedTailOffset: tail100,
      observedSnapshotOffset: null,
      attempts: 1,
      updatedAtMs: 0,
    };
    await createCliIncompleteRecoveryStore(daemon.store, 'shared-durable').save(record);
    const command = await openCliProcess('process');
    const privateStore = createCliIncompleteRecoveryStore(command.store, 'process');
    expect(await privateStore.load(alias)).toEqual({ ...record, streamUrl: alias });
    await privateStore.save({ ...record, observedTailOffset: '200' });
    await privateStore.delete?.(alias);
    expect(await privateStore.load(url)).toBeNull();
    const restarted = createCliIncompleteRecoveryStore(command.store, 'shared-durable');
    expect(await restarted.load(alias)).toEqual({ ...record, streamUrl: alias });
    await restarted.delete?.(alias);
    expect(await createCliIncompleteRecoveryStore(daemon.store, 'process').load(url)).toBeNull();
  });

  it('seeds a covered large session from SQLite without bootstrap or shared cursor writes', async () => {
    const docId = 'session-covered';
    const remote = new LoroDoc();
    remote.setPeerId('1');
    const body = 'synthetic history|'.repeat(100_000);
    remote.getText('t').insert(0, body);
    const server = createStreamsServer(remote.export({ mode: 'snapshot' }));
    const daemon = await openCliProcess('shared-durable');
    const daemonDoc = (await daemon.repo.openPersistedDoc(docId)).doc;
    expect((await syncDoc(daemon, docId, daemonDoc)).ok).toBe(true);
    const rows = () => daemon.store.sqliteStore.db.prepare('SELECT * FROM remote_cursors').all();
    const before = rows();
    expect(before).toHaveLength(1);

    const oneShot = await openCliProcess('process');
    const doc = (await oneShot.repo.openPersistedDoc(docId)).doc;
    expect(doc.getText('t').toString()).toBe(body);
    server.requests.length = 0;
    expect((await syncDoc(oneShot, docId, doc)).ok).toBe(true);
    expect(server.bootstraps()).toBe(0);
    expect(server.requests.some((url) => url.searchParams.get('offset') === tail100)).toBe(true);
    expect(doc.oplogVersion().toJSON()).toEqual(remote.oplogVersion().toJSON());
    expect(rows()).toEqual(before);

    const cursorRow = before[0] as { stream_url: string };
    const cursor = await oneShot.documentRemoteCursorStore.load(cursorRow.stream_url);
    expect(cursor).not.toBeNull();
    if (!cursor) throw new Error('missing covered cursor');
    await oneShot.documentRemoteCursorStore.save({ ...cursor, nextOffset: '200' });
    expect((await oneShot.documentRemoteCursorStore.load(cursor.streamUrl))?.nextOffset).toBe(
      '200'
    );
    await oneShot.documentRemoteCursorStore.delete?.(cursor.streamUrl);
    expect(await oneShot.documentRemoteCursorStore.load(cursor.streamUrl)).toBeNull();
    expect(rows()).toEqual(before);
  });

  it.each([{}, { '1': 'invalid' }, { '1': -1 }])(
    'bootstraps instead of seeding an invalid cursor version %j',
    async (serverLowerBoundVersion) => {
      const docId = 'session-invalid-seed';
      const remote = new LoroDoc();
      remote.setPeerId('1');
      remote.getText('t').insert(0, 'complete history');
      const server = createStreamsServer(remote.export({ mode: 'snapshot' }));
      const daemon = await openCliProcess();
      const doc = (await daemon.repo.openPersistedDoc(docId)).doc;
      expect((await syncDoc(daemon, docId, doc)).ok).toBe(true);
      const rows = daemon.store.sqliteStore.db
        .prepare('SELECT stream_url FROM remote_cursors')
        .all() as Array<{ stream_url: string }>;
      const streamUrl = rows[0]?.stream_url;
      if (!streamUrl) throw new Error('missing daemon cursor');
      const cursor = await daemon.documentRemoteCursorStore.load(streamUrl);
      if (!cursor) throw new Error('missing daemon cursor');
      const invalid = { ...cursor, serverLowerBoundVersion };
      await daemon.documentRemoteCursorStore.save(invalid);
      const oneShot = await openCliProcess('process');
      const restored = (await oneShot.repo.openPersistedDoc(docId)).doc;
      expect((await syncDoc(oneShot, docId, restored)).ok).toBe(true);
      expect(server.bootstraps()).toBe(2);
      expect(restored.getText('t').toString()).toBe('complete history');
      expect(await daemon.documentRemoteCursorStore.load(streamUrl)).toEqual(invalid);
    }
  );

  it('does not repair a corrupt daemon cursor row while bootstrapping a command', async () => {
    const docId = 'session-corrupt-cursor';
    const remote = new LoroDoc();
    remote.getText('t').insert(0, 'complete history');
    const server = createStreamsServer(remote.export({ mode: 'snapshot' }));
    const daemon = await openCliProcess();
    expect((await syncDoc(daemon, docId, (await daemon.repo.openPersistedDoc(docId)).doc)).ok).toBe(
      true
    );
    daemon.store.sqliteStore.db
      .prepare('UPDATE remote_cursors SET server_lower_bound_version = ?')
      .run('invalid json');
    const rows = () => daemon.store.sqliteStore.db.prepare('SELECT * FROM remote_cursors').all();
    const before = rows();
    const oneShot = await openCliProcess('process');
    const doc = (await oneShot.repo.openPersistedDoc(docId)).doc;
    expect((await syncDoc(oneShot, docId, doc)).ok).toBe(true);
    expect(server.bootstraps()).toBe(2);
    expect(doc.getText('t').toString()).toBe('complete history');
    expect(rows()).toEqual(before);
  });

  it('bootstraps a pending-only replica and restores its missing causal prefix without writing shared cursors', async () => {
    const docId = 'session-pending-seed';
    const remote = new LoroDoc();
    remote.setPeerId('1');
    remote.getText('t').insert(0, 'A');
    remote.commit();
    const beforeU2 = remote.oplogVersion();
    remote.getText('t').push('B');
    remote.commit();
    const u2 = remote.export({ mode: 'update', from: beforeU2 });
    const oneShot = await openCliProcess('process');
    const oldDoc = (await oneShot.repo.openPersistedDoc(docId)).doc;
    expect(oldDoc.import(u2).pending?.size).toBeGreaterThan(0);
    // Pinned Loro 1.17.0 retains pending separately from both version vectors.
    expect([...oldDoc.oplogVersion().toJSON()]).toEqual([]);
    expect([...oldDoc.version().toJSON()]).toEqual([]);
    expect(oldDoc.exportPendingUpdates()?.byteLength).toBeGreaterThan(0);

    createStreamsServer(remote.export({ mode: 'snapshot' }));
    const daemon = await openCliProcess();
    expect((await syncDoc(daemon, docId, (await daemon.repo.openPersistedDoc(docId)).doc)).ok).toBe(
      true
    );
    const rows = () => daemon.store.sqliteStore.db.prepare('SELECT * FROM remote_cursors').all();
    const before = rows();
    const row = before[0] as { stream_url: string };
    expect(
      (await daemon.documentRemoteCursorStore.load(row.stream_url))?.serverLowerBoundVersion
    ).toEqual({ '1': 2 });
    const recovery = createStreamsServer(remote.export({ mode: 'snapshot' }));
    expect((await syncDoc(oneShot, docId, oldDoc)).ok).toBe(true);
    expect(recovery.bootstraps()).toBe(1);
    expect(oldDoc.getText('t').toString()).toBe('AB');
    expect(oldDoc.version().toJSON()).toEqual(remote.version().toJSON());
    expect(oldDoc.exportPendingUpdates()).toBeUndefined();
    expect(rows()).toEqual(before);
  });

  it.each(['pending', 'detached'] as const)(
    'refuses a seed for a %s replica even when its oplog covers the cursor',
    async (state) => {
      const docId = 'session-applied-seed';
      const remote = new LoroDoc();
      remote.setPeerId('1');
      remote.getText('t').insert(0, 'A');
      remote.commit();
      const prefix = remote.frontiers();
      remote.getText('t').push('B');
      remote.commit();
      createStreamsServer(remote.export({ mode: 'snapshot' }));
      const daemon = await openCliProcess();
      expect(
        (await syncDoc(daemon, docId, (await daemon.repo.openPersistedDoc(docId)).doc)).ok
      ).toBe(true);
      const rows = () => daemon.store.sqliteStore.db.prepare('SELECT * FROM remote_cursors').all();
      const before = rows();
      const row = before[0] as { stream_url: string };
      const oneShot = await openCliProcess('process');
      const doc = (await oneShot.repo.openPersistedDoc(docId)).doc;
      if (state === 'pending') {
        remote.getText('t').push('C');
        remote.commit();
        const beforeD = remote.oplogVersion();
        remote.getText('t').push('D');
        remote.commit();
        expect(
          doc.import(remote.export({ mode: 'update', from: beforeD })).pending?.size
        ).toBeGreaterThan(0);
        expect([...doc.version().toJSON()]).toEqual([['1', 2]]);
        expect(doc.exportPendingUpdates()?.byteLength).toBeGreaterThan(0);
      } else {
        doc.checkout(prefix);
        expect([...doc.version().toJSON()]).toEqual([['1', 1]]);
      }
      expect([...doc.oplogVersion().toJSON()]).toEqual([['1', 2]]);
      const cursors = oneShot.documentRemoteCursorStore;
      if (!(cursors instanceof ProcessDocumentRemoteCursorStore))
        throw new Error('missing process cursor store');
      cursors.bindDocument(getLoroStreamIdForDocId(workspaceId, docId), doc);
      expect(await cursors.load(row.stream_url)).toBeNull();
      expect(rows()).toEqual(before);
      if (state === 'detached') doc.attach();
    }
  );

  it('rejects a future peer even when every other peer clock is covered', async () => {
    const docId = 'session-future-peer';
    const remote = new LoroDoc();
    remote.setPeerId('1');
    remote.getText('t').insert(0, 'base|');
    const server = createStreamsServer(remote.export({ mode: 'snapshot' }));
    const daemon = await openCliProcess();
    const daemonDoc = (await daemon.repo.openPersistedDoc(docId)).doc;
    expect((await syncDoc(daemon, docId, daemonDoc)).ok).toBe(true);
    remote.setPeerId('2');
    remote.getText('t').push('new peer');
    const rows = daemon.store.sqliteStore.db
      .prepare('SELECT stream_url FROM remote_cursors')
      .all() as Array<{ stream_url: string }>;
    const streamUrl = rows[0]?.stream_url;
    if (!streamUrl) throw new Error('missing daemon cursor');
    const cursor = await daemon.documentRemoteCursorStore.load(streamUrl);
    if (!cursor) throw new Error('missing daemon cursor');
    // Capture a cursor with an uncovered peer alongside the older durable doc.
    await daemon.documentRemoteCursorStore.save({
      ...cursor,
      serverLowerBoundVersion: Object.fromEntries(remote.version().toJSON()),
    });
    const future = await daemon.documentRemoteCursorStore.load(streamUrl);
    const oneShot = await openCliProcess('process');
    const oldDoc = (await oneShot.repo.openPersistedDoc(docId)).doc;
    expect(oldDoc.getText('t').toString()).toBe('base|');
    const recovery = createStreamsServer(remote.export({ mode: 'snapshot' }));
    expect((await syncDoc(oneShot, docId, oldDoc)).ok).toBe(true);
    expect(recovery.bootstraps()).toBe(1);
    expect(oldDoc.getText('t').toString()).toBe('base|new peer');
    expect(oldDoc.oplogVersion().toJSON()).toEqual(remote.oplogVersion().toJSON());
    expect(await daemon.documentRemoteCursorStore.load(streamUrl)).toEqual(future);
    expect(server.bootstraps()).toBe(1);
  });

  it('does not advance the checkpoint past data that failed to persist before a crash', async () => {
    const server = createStreamsServer(metaSnapshotWithA());
    const daemon = await openCliProcess();
    const storage = daemon.store.storageAdapter;
    const diskFull = () => new Error('SQLITE_FULL: database or disk is full');
    const save = storage.save.bind(storage);
    storage.save = async (payload) => {
      if (payload.type === 'meta-update') throw diskFull();
      await save(payload);
    };
    // loro-repo commits metadata through the atomic `saveMany` when the adapter has it.
    const saveMany = storage.saveMany?.bind(storage);
    expect(saveMany).toBeDefined();
    storage.saveMany = async (payloads) => {
      if (payloads.some((payload) => payload.type === 'meta-update')) throw diskFull();
      await saveMany?.(payloads);
    };

    const result = await syncMeta(daemon).catch((error: unknown) => ({ ok: false, error }));
    expect(result.ok).toBe(false);
    expect(daemon.repo.getMeta().get(keyA)).toBe('A');

    // Crash: the process dies without the shutdown flush.
    openProcesses.delete(daemon);
    daemon.store.sqliteStore.close();

    const restarted = await openCliProcess();
    expect(restarted.repo.getMeta().get(keyA)).toBeUndefined();
    expect((await syncMeta(restarted)).ok).toBe(true);
    expect(restarted.repo.getMeta().get(keyA)).toBe('A');
    expect(server.bootstraps()).toBe(2);
  });

  it('resumes from its own durable checkpoint after a restart instead of bootstrapping again', async () => {
    const server = createStreamsServer(metaSnapshotWithA());
    const daemon = await openCliProcess();
    expect((await syncMeta(daemon)).ok).toBe(true);
    await closeCliProcess(daemon);

    const restarted = await openCliProcess();
    expect(restarted.repo.getMeta().get(keyA)).toBe('A');
    expect((await syncMeta(restarted)).ok).toBe(true);
    expect(server.bootstraps()).toBe(1);
  });
});

// These cases intentionally exercise the published SDK through the real daemon composition.
describe('CLI gateway namespace fences retain offline SQLite data', () => {
  for (const kind of ['doc', 'flock', 'meta'] as const) {
    for (const [status, code] of [
      [404, 'space_not_found'],
      [410, 'space_generation_fenced'],
    ] as const) {
      it(`${kind}: ${status} ${code} cannot auto-create or upload the namespace and preserves drafts across reopen`, async () => {
        const methods: string[] = [];
        createStreamsServer(new Uint8Array(), (_url, method) => {
          methods.push(method);
          return method === 'GET'
            ? new Response(null, { status, headers: { 'Stream-Error-Code': code } })
            : undefined;
        });
        const daemon = await openCliProcess();
        const id = 'offline-draft';
        const doc = kind === 'doc' ? (await daemon.repo.openPersistedDoc(id)).doc : undefined;
        const flock =
          kind === 'meta'
            ? daemon.repo.getMeta()
            : kind === 'flock'
              ? (await daemon.repo.openFlockDoc(id)).flock
              : undefined;
        if (doc) {
          doc.getMap('data').set('draft', 'unsent CLI text');
          doc.commit();
        } else flock!.put(['draft'], 'unsent CLI text');
        await daemon.repo.flush();
        const result = await withTransport(daemon, (adapter) =>
          doc
            ? adapter.syncDoc(id, doc)
            : kind === 'meta'
              ? adapter.syncMeta(flock!)
              : adapter.syncFlockDoc(id, flock!)
        );
        expect(result.ok).toBe(false);
        expect(methods.some((method) => method === 'PUT' || method === 'POST')).toBe(false);
        await daemon.repo.flush();
        await closeCliProcess(daemon);
        const restarted = await openCliProcess();
        if (kind === 'doc') {
          expect((await restarted.repo.openPersistedDoc(id)).doc.getMap('data').get('draft')).toBe(
            'unsent CLI text'
          );
        } else {
          const restored =
            kind === 'meta'
              ? restarted.repo.getMeta()
              : (await restarted.repo.openFlockDoc(id)).flock;
          expect(restored.get(['draft'])).toBe('unsent CLI text');
        }
      });
    }
  }
});

describe('CLI Flock snapshot catch-up cost', () => {
  it.each([
    'small-snapshot',
    'large-snapshot',
    'local-draft',
    'missing-size',
    'probe-failed',
    'exact-byte-offsets',
  ] as const)('%s survives SQLite reopen with the matching cursor', async (scenario) => {
    const source = new Flock('cost-source');
    source.put(keyA, 'A');
    createStreamsServer(source.exportFile());
    const cli = await openCliProcess();
    expect((await syncMeta(cli)).ok).toBe(true);
    const from = source.version();
    source.put(keyA, 'B');
    const snapshot = source.exportFile();
    const payload = new TextEncoder().encode(JSON.stringify(source.exportJson(from)));
    const update = new Uint8Array(4 + payload.byteLength);
    new DataView(update.buffer).setUint32(0, payload.byteLength, false);
    update.set(payload, 4);
    const tail =
      scenario === 'exact-byte-offsets' ? '90071992547410968577' : '00000000000004000000';
    if (scenario === 'exact-byte-offsets') {
      const store = cli.repo.getReplicaCheckpointStore({ kind: 'meta', flock: cli.repo.getMeta() });
      const url = `${gatewayBaseUrl}/ds/lody/${encodeURIComponent(getLoroMetaStreamId(workspaceId))}`;
      const cursor = await store.load(url);
      expect(cursor).not.toBeNull();
      await store.save({ ...cursor!, nextOffset: '90071992547409920000' });
    }
    const requests: { method: string; url: URL }[] = [];
    createStreamsServer(snapshot, (url, method) => {
      requests.push({ url, method });
      if (method === 'HEAD' && scenario === 'probe-failed')
        return new Response(null, { status: 503 });
      if (method === 'GET' && url.pathname.includes('/snapshot/') && scenario === 'missing-size')
        return new Response(null);
      if (method === 'HEAD')
        return new Response(null, {
          headers: {
            'Stream-Next-Offset': tail,
            'Stream-Snapshot-Offset': tail,
          },
        });
      if (method === 'GET' && url.pathname.includes('/snapshot/'))
        return new Response(null, {
          headers: {
            'Content-Length': String(
              scenario === 'large-snapshot' ? 20 * 1024 * 1024 : snapshot.byteLength
            ),
          },
        });
      if (url.pathname.endsWith('/bootstrap'))
        return new Response(
          new Blob([
            '--cp\r\nContent-Type: application/octet-stream\r\n\r\n',
            toArrayBuffer(snapshot),
            '\r\n--cp--\r\n',
          ]),
          {
            headers: {
              'Content-Type': 'multipart/mixed; boundary=cp',
              'Stream-Snapshot-Offset': tail,
              'Stream-Next-Offset': tail,
              'Stream-Up-To-Date': 'true',
            },
          }
        );
      if (method === 'GET')
        return new Response(toArrayBuffer(update), {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Stream-Next-Offset': tail,
            'Stream-Up-To-Date': 'true',
          },
        });
      return undefined;
    });
    if (scenario === 'local-draft') cli.repo.getMeta().put(['draft'], 'offline CLI edit');
    expect((await syncMeta(cli)).ok).toBe(true);
    expect(cli.repo.getMeta().get(keyA)).toBe('B');
    expect(requests.some(({ url }) => url.pathname.endsWith('/bootstrap'))).toBe(
      scenario === 'small-snapshot' || scenario === 'exact-byte-offsets'
    );
    if (scenario === 'local-draft') {
      expect(cli.repo.getMeta().get(['draft'])).toBe('offline CLI edit');
      expect(requests.some(({ method }) => method === 'POST')).toBe(true);
    }
    await closeCliProcess(cli);
    const reopened = await openCliProcess();
    expect(reopened.repo.getMeta().get(keyA)).toBe('B');
    if (scenario === 'local-draft')
      expect(reopened.repo.getMeta().get(['draft'])).toBe('offline CLI edit');
    const request = requests.find(
      ({ method, url }) =>
        method === 'HEAD' ||
        (method === 'GET' &&
          !url.pathname.includes('/snapshot/') &&
          !url.pathname.endsWith('/bootstrap'))
    )!;
    const streamUrl = `${request.url.origin}${request.url.pathname}`;
    const checkpoint = await reopened.repo
      .getReplicaCheckpointStore({ kind: 'meta', flock: reopened.repo.getMeta() })
      .load(streamUrl);
    expect(checkpoint?.nextOffset).toBe(tail);
  });
});
