/**
 * The daemon and one-shot CLI commands open the same `repo.sqlite3` with their
 * own in-memory replicas. Streams progress must therefore belong to the replica
 * that loaded it: a process that hydrated before another process advanced data
 * and cursor has to bootstrap, not resume at that tail. Meta/Flock cursors are
 * replica-bound; LoroDoc cursors are durable for the daemon only.
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
import { getLoroMetaStreamId, type WorkspaceId } from '@lody/shared';
import type { LoroStreamsTokenProvider } from '@lody/platform';
import { LoroRepo } from 'loro-repo';
import {
  createCliSqliteRepoStore,
  createDocumentRemoteCursorStore,
  type CliSqliteRepoStore,
  type DocumentCursorScope,
} from '../src/lib/loro/sqlite-repo-store';
import { createCliStreamsTransport } from '../src/lib/loro/streams-transport';
import type { Logger } from '../src/utils/logger';
import { formatErrorMessage, formatErrorWithCauses } from '../src/utils/format-error';

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
} as unknown as LoroStreamsTokenProvider;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

const metaSnapshotWithA = (): Uint8Array => {
  const server = new Flock('server');
  server.put(keyA, 'A');
  return server.exportFile();
};

/** Streams serving `snapshot` at offset 100; catch-up from 100 has nothing new. */
function createStreamsServer(snapshot: Uint8Array) {
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(url);
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
  return { bootstraps };
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
  logger: Logger = silentLogger
): Promise<T> {
  const { adapter } = await createCliStreamsTransport({
    workspaceId,
    tokenProvider,
    repo: cliProcess.repo,
    documentRemoteCursorStore: cliProcess.documentRemoteCursorStore,
    logger,
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
  it('logs safe HTTP failure context through the CLI transport composition', async () => {
    const records: unknown[][] = [];
    const logger = new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) => {
            records.push(args);
          },
      }
    ) as Logger;
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('synthetic-secret-body', {
          status: 503,
          headers: { 'X-Request-Id': 'cli-request-503' },
        })
    );
    const cliProcess = await openCliProcess();
    const result = await withTransport(
      cliProcess,
      (adapter) => adapter.syncMeta(cliProcess.repo.getMeta()),
      logger
    );
    expect(result.ok).toBe(false);
    const wrapped = new Error('synthetic-secret-wrapper', { cause: result.error });
    expect(formatErrorMessage(wrapped)).toContain('status=503');
    expect(formatErrorMessage(wrapped)).not.toContain('synthetic-secret');
    expect(formatErrorWithCauses(wrapped)).toContain('requestId=cli-request-503');
    expect(formatErrorWithCauses(wrapped)).not.toContain('synthetic-secret');
    expect(formatErrorMessage(new Error('ordinary failure'))).toBe('ordinary failure');
    expect(records).toContainEqual([
      '[loro-streams] transport failure',
      expect.objectContaining({
        workspaceId,
        failures: [
          expect.objectContaining({
            streamsCode: 'server_error',
            retryable: true,
            failureKind: 'server',
            streamsContext: expect.objectContaining({
              source: 'http',
              status: 503,
              requestId: 'cli-request-503',
            }),
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain('synthetic-secret-body');
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
