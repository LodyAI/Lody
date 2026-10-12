import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { it as effectIt } from '@effect/vitest';
import { TestClock } from 'effect/testing';
import { LoroDoc } from 'loro-crdt';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  createSessionMirror,
  getLoroMetaStreamId,
  getLoroStreamIdForDocId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroStreamsTokenProvider } from '@lody/platform';
import {
  manifestSchema,
  hashBytes,
  migratedMetadata,
  prepareDocument,
  type Journal,
  type Manifest,
} from './model';
import { freezeSource, loadJournal, sourceDocumentPath } from './source';
import { migrateSnapshot, migrationStep, MigrationRuntime } from './engine';
import { openMigrationTarget } from './target';
import {
  collectAttachmentFiles,
  collectHistoricalAttachmentFiles,
  resolveArchivedAttachment,
  migrateAttachments,
  validateAttachments,
} from './attachments';
import { SessionAttachmentTransfer } from '../session-attachment-transfer';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function temporary() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-migration-test-'));
  roots.push(dir);
  return dir;
}
function fixture(): { manifest: Manifest; original: LoroDoc; bytes: Uint8Array } {
  const original = new LoroDoc();
  const mirror = createSessionMirror({
    doc: original,
    initialState: { session: { id: 'one' as SessionId }, history: [] },
  });
  mirror.historyWriter.update(() => [
    {
      id: 'u1',
      role: 'user',
      timestamp: '2026-10-12T00:00:00.000Z',
      items: [{ type: 'text', text: 'Keep this conversation' }],
    },
  ]);
  const other = new LoroDoc();
  other.import(original.export({ mode: 'snapshot' }));
  other.getMap('opaqueFutureRoot').set('secretToSchema', 'preserve opaque data');
  other.commit();
  original.import(other.export({ mode: 'update' }));
  mirror.dispose();
  const bytes = original.export({ mode: 'snapshot' });
  const manifest = manifestSchema.parse({
    version: 2,
    sourcePath: '/synthetic/source',
    sourceWorkspaceId: 'lw_source',
    sourceMachineId: 'local-machine',
    sourceUserId: 'local:owner',
    sourceName: 'OSS',
    targetWorkspaceId: 'cloud',
    targetMachineId: 'cloud-machine',
    targetUserId: 'cloud-owner',
    deployment: 'https://test.invalid',
    migrationId: 'a'.repeat(32),
    createdAt: '2026-10-12T00:00:00.000Z',
    machineMeta: { id: 'local-machine', name: 'Local', os: 'test', cliVersion: 'test' },
    flocks: [],
    documents: [
      {
        id: 'session-one',
        meta: {
          id: 'one',
          machineId: 'local-machine',
          userId: 'local:owner',
          latestUserMsgId: 'u1',
          processingUserMsgId: 'u1',
          status: { type: 'running' },
          title: 'Same title',
        },
        sha256: hashBytes(bytes),
      },
    ],
  });
  return { manifest, original, bytes };
}

/** Real StreamsCrdt HTTP framing, deterministic in-memory server; no network or sleeps. */
function server() {
  const rooms = new Map<string, LoroDoc | Flock>();
  const writes: string[] = [];
  const offsets = new Map<string, number>();
  let failNextPost = false;
  let casSupported = true;
  let beforeCas: ((id: string) => void) | undefined;
  let loseResponse: ((method: string, id: string) => boolean) | undefined;
  const offset = (id: string) => String(offsets.get(id) ?? 0).padStart(20, '0');
  const bump = (id: string) => offsets.set(id, (offsets.get(id) ?? 0) + 1);
  const headers = (id: string) => ({
    'Content-Type': 'application/octet-stream',
    'Stream-Next-Offset': offset(id),
    'Stream-Up-To-Date': 'true',
    'Stream-Extensions': 'append-cas',
  });
  const apply = async (id: string, room: LoroDoc | Flock, body: RequestInit['body']) => {
    if (!body) return;
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at < bytes.length;) {
      const length = view.getUint32(at, false);
      at += 4;
      const payload = bytes.slice(at, at + length);
      at += length;
      if (room instanceof LoroDoc) room.import(payload);
      else room.importJson(JSON.parse(new TextDecoder().decode(payload)));
    }
    writes.push(id);
    bump(id);
  };
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : input);
    const parts = url.pathname.split('/');
    const id = decodeURIComponent(parts[3] ?? '');
    if (!id) return Response.json({ extensions: casSupported ? ['append-cas'] : [] });
    if (init?.method === 'PUT') {
      const already = rooms.has(id);
      if (!already) {
        const room =
          id.endsWith(':meta') || /:(mf|sr|ti|wf)(:|$)/.test(id) ? new Flock() : new LoroDoc();
        rooms.set(id, room);
        await apply(id, room, init.body);
      }
      if (loseResponse?.('PUT', id)) throw new Error('Response lost after durable create');
      return new Response(null, { status: already ? 200 : 201, headers: headers(id) });
    }
    const room = rooms.get(id);
    if (!room) return new Response('missing', { status: 404 });
    if (init?.method === 'POST') {
      if (failNextPost) return new Response('denied', { status: 403 });
      const sent = new Headers(init.headers);
      if (url.pathname.endsWith('/append-cas')) {
        beforeCas?.(id);
        if (sent.get('Stream-Expected-Offset') !== offset(id))
          return new Response(null, { status: 412, headers: headers(id) });
      }
      await apply(id, room, init.body);
      if (loseResponse?.('POST', id)) throw new Error('Response lost after durable append');
      return new Response(null, {
        headers: {
          ...headers(id),
          'Producer-Epoch': sent.get('Producer-Epoch') ?? '0',
          'Producer-Seq': sent.get('Producer-Seq') ?? '0',
        },
      });
    }
    if (url.pathname.endsWith('/bootstrap')) {
      const snapshot =
        room instanceof LoroDoc ? room.export({ mode: 'snapshot' }) : room.exportFile();
      return new Response(
        new Blob([
          '--test\r\nContent-Type: application/octet-stream\r\n\r\n',
          snapshot.slice().buffer as ArrayBuffer,
          '\r\n--test--\r\n',
        ]),
        {
          headers: {
            ...headers(id),
            'Content-Type': 'multipart/mixed; boundary=test',
            'Stream-Snapshot-Offset': offset(id),
          },
        }
      );
    }
    return new Response(null, { headers: headers(id) });
  });
  return {
    rooms,
    writes,
    failPost: () => {
      failNextPost = true;
    },
    allowPost: () => {
      failNextPost = false;
    },
    disableCas: () => {
      casSupported = false;
    },
    beforeCas: (hook: (id: string) => void) => {
      beforeCas = hook;
    },
    loseResponse: (hook: (method: string, id: string) => boolean) => {
      loseResponse = hook;
    },
    mutate: (id: string, update: (room: LoroDoc | Flock) => void) => {
      const room = rooms.get(id);
      if (!room) throw new Error('Missing synthetic room');
      update(room);
      bump(id);
    },
  };
}
const provider = {
  getToken: async () => 'synthetic',
  getGatewayBaseUrl: () => 'https://streams.migration.invalid',
  getShardHostSuffix: () => undefined,
  invalidate: () => {},
  createAuthCallback: () => async () => 'synthetic',
} as unknown as LoroStreamsTokenProvider;
const run = (
  manifest: Manifest,
  journal: Journal,
  dir: string,
  target: Awaited<ReturnType<typeof openMigrationTarget>>
) =>
  Effect.runPromise(
    migrateSnapshot(manifest, journal, dir).pipe(
      Effect.provideService(MigrationRuntime, {
        target,
        transfer: new SessionAttachmentTransfer('synthetic'),
        progress: () => {},
      })
    )
  );

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}

describe('OSS migration', () => {
  it('preserves both CRDT authors and unknown roots while disabling pending execution', () => {
    const { manifest, original, bytes } = fixture();
    const entry = first(manifest.documents);
    const migrated = prepareDocument(bytes, entry, manifest);
    expect(original.oplogVersion().compare(migrated.oplogVersion())).toBe(-1);
    expect(migrated.getList('history').toJSON()).toEqual(original.getList('history').toJSON());
    expect(migrated.getMap('opaqueFutureRoot').toJSON()).toEqual(
      original.getMap('opaqueFutureRoot').toJSON()
    );
    const meta = migratedMetadata(entry.meta, manifest);
    expect(meta).toMatchObject({
      collaborationStopped: true,
      status: { type: 'idle' },
      machineId: 'cloud-machine',
      userId: 'cloud-owner',
    });
    expect(meta.latestUserMsgId).toBeUndefined();
    expect(meta.processingUserMsgId).toBeUndefined();
  });

  it('uploads all authors before discovery, preserves existing conversations, and resumes an interrupted upload', async () => {
    const { manifest, bytes, original } = fixture();
    const dir = await temporary();
    await fs.writeFile(sourceDocumentPath(dir, 'session-one'), bytes);
    manifest.flocks = [
      {
        id: 'cloud:mf:cloud-machine',
        rows: [{ key: ['localProject', 'new-project'], value: { rootPath: '/synthetic/project' } }],
      },
    ];
    const wire = server();
    const metaId = getLoroMetaStreamId('cloud' as WorkspaceId);
    const existing = new Flock();
    existing.set(['e', 'session-existing'], true);
    existing.set(['m', 'session-existing', 'title'], 'Same title');
    existing.commit();
    wire.rooms.set(metaId, existing);
    let target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    const journal = await loadJournal(dir, manifest.migrationId);
    wire.failPost();
    await expect(run(manifest, journal, dir, target)).rejects.toThrow();
    expect(existing.get(['e', 'session-one'])).toBeUndefined();
    await target.close();
    target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    wire.allowPost();
    const resumed = await loadJournal(dir, manifest.migrationId);
    await run(manifest, resumed, dir, target);
    await target.close();
    const cloud = wire.rooms.get(
      getLoroStreamIdForDocId('cloud' as WorkspaceId, 'session-one')
    ) as LoroDoc;
    expect(original.oplogVersion().compare(cloud.oplogVersion())).toBe(-1);
    expect(cloud.getList('history').toJSON()).toEqual(original.getList('history').toJSON());
    expect(existing.get(['e', 'session-one'])).toBe(true);
    expect(
      (wire.rooms.get('cloud:mf:cloud-machine') as Flock).get(['localProject', 'new-project'])
    ).toEqual({ rootPath: '/synthetic/project' });
    expect(existing.get(['m', 'session-existing', 'title'])).toBe('Same title');
    expect(
      wire.writes.indexOf(getLoroStreamIdForDocId('cloud' as WorkspaceId, 'session-one'))
    ).toBeLessThan(wire.writes.lastIndexOf(metaId));
    cloud.getMap('afterMigration').set('edited', true);
    cloud.commit();
    const before = wire.writes.length;
    target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    await run(manifest, await loadJournal(dir, manifest.migrationId), dir, target);
    await target.close();
    expect(wire.writes).toHaveLength(before);
    expect(cloud.getMap('afterMigration').get('edited')).toBe(true);
  });

  it('rejects an unrelated ID or a tombstone before uploading anything', async () => {
    const { manifest, bytes } = fixture();
    const dir = await temporary();
    await fs.writeFile(sourceDocumentPath(dir, 'session-one'), bytes);
    const wire = server();
    const meta = new Flock();
    meta.set(['e', 'session-one'], false);
    meta.commit();
    wire.rooms.set(getLoroMetaStreamId('cloud' as WorkspaceId), meta);
    const target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await expect(
        run(manifest, await loadJournal(dir, manifest.migrationId), dir, target)
      ).rejects.toThrow('collision');
    } finally {
      await target.close();
    }
    expect(wire.writes).toEqual([]);
    expect(meta.get(['e', 'session-one'])).toBe(false);
  });

  it('rejects Roost or corrupt snapshots without creating cloud records', async () => {
    const { manifest, bytes } = fixture();
    const dir = await temporary();
    await fs.writeFile(sourceDocumentPath(dir, 'session-one'), bytes);
    first(manifest.documents).meta.historyBackend = 'roost';
    const wire = server();
    const target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await expect(
        run(manifest, await loadJournal(dir, manifest.migrationId), dir, target)
      ).rejects.toThrow('Unsupported history backend');
    } finally {
      await target.close();
    }
    expect(wire.rooms.size).toBe(0);
  });

  it('backs up real SQLite without changing the source, including archived history', async () => {
    const { manifest, bytes } = fixture();
    const root = await temporary();
    const directory = path.join(root, 'loro-repo', manifest.sourceWorkspaceId);
    await fs.mkdir(directory, { recursive: true });
    const dbPath = path.join(directory, 'repo.sqlite3');
    const store = new SqliteRepoStore({ path: dbPath });
    const repo = await LoroRepo.create({ storageAdapter: store.storage, metaDebounceCommitMs: 0 });
    const { doc } = await repo.openPersistedDoc('session-one');
    doc.import(bytes);
    await repo.upsertDocMeta('session-one', {
      ...first(manifest.documents).meta,
      isArchived: true,
    });
    await repo.flush();
    await repo.destroy();
    store.close();
    const before = hashBytes(await fs.readFile(dbPath));
    const frozen = await freezeSource({ ...manifest, sourcePath: root }, path.join(root, 'backup'));
    expect(frozen.documents).toHaveLength(1);
    expect(first(frozen.documents).meta.isArchived).toBe(true);
    expect(hashBytes(await fs.readFile(dbPath))).toBe(before);
  });
  it('does not resurrect deleted index rows or replace existing project configuration', async () => {
    const { manifest } = fixture();
    manifest.flocks = [
      {
        id: 'cloud:mf:cloud-machine',
        rows: [{ key: ['localProject', 'project'], value: { rootPath: '/source' } }],
      },
    ];
    const wire = server();
    const flock = new Flock();
    flock.set(['localProject', 'project'], { rootPath: '/cloud' });
    flock.commit();
    wire.rooms.set('cloud:mf:cloud-machine', flock);
    let target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await expect(target.preflight(manifest, [])).rejects.toThrow('Index collision');
    } finally {
      await target.close();
    }
    expect(flock.get(['localProject', 'project'])).toEqual({ rootPath: '/cloud' });
    flock.delete(['localProject', 'project']);
    flock.commit();
    target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await expect(target.preflight(manifest, [])).rejects.toThrow('Index collision');
    } finally {
      await target.close();
    }
    expect(wire.writes).toEqual([]);
  });

  it('refuses an ambiguous empty reservation and never merges unrelated document bodies', async () => {
    const { manifest } = fixture();
    const entry = first(manifest.documents);
    const wire = server();
    const id = getLoroStreamIdForDocId('cloud' as WorkspaceId, entry.id);
    const occupied = new LoroDoc();
    wire.rooms.set(id, occupied);
    let target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await expect(target.preflight(manifest, [])).rejects.toThrow('empty stream collision');
    } finally {
      await target.close();
    }
    occupied.getText('body').insert(0, 'unrelated history');
    occupied.commit();
    target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await expect(target.preflight(manifest, [entry.id])).rejects.toThrow('Document ID collision');
    } finally {
      await target.close();
    }
    expect(occupied.getText('body').toString()).toBe('unrelated history');
    expect(wire.writes).toEqual([]);
  });

  it.each(['insert', 'delete'] as const)(
    'CAS rejects a concurrent %s without publishing its tentative row',
    async (mutation) => {
      const { manifest } = fixture();
      const indexId = 'cloud:mf:cloud-machine';
      const key = ['localProject', 'racing'];
      manifest.flocks = [{ id: indexId, rows: [{ key, value: { path: '/source' } }] }];
      const wire = server();
      const flock = new Flock();
      wire.rooms.set(indexId, flock);
      let injected = false;
      wire.beforeCas((id) => {
        if (id !== indexId || injected) return;
        injected = true;
        wire.mutate(id, () => {
          flock.set(key, { path: '/cloud' });
          if (mutation === 'delete') flock.delete(key);
          flock.commit();
        });
      });
      const target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
      try {
        await target.preflight(manifest, []);
        await expect(target.mergeIndexes(manifest)).rejects.toThrow('Index collision');
        expect(flock.get(key)).toEqual(mutation === 'delete' ? undefined : { path: '/cloud' });
        expect(wire.writes).toEqual([]);
      } finally {
        await target.close();
      }
    }
  );

  it('retries unrelated concurrent changes using a fresh replica and preserves both rows', async () => {
    const { manifest } = fixture();
    const indexId = 'cloud:mf:cloud-machine';
    manifest.flocks = [
      { id: indexId, rows: [{ key: ['localProject', 'new'], value: { path: '/source' } }] },
    ];
    const wire = server();
    const flock = new Flock();
    wire.rooms.set(indexId, flock);
    let injected = false;
    wire.beforeCas((id) => {
      if (id !== indexId || injected) return;
      injected = true;
      wire.mutate(id, () => {
        flock.set(['localProject', 'other'], { path: '/cloud' });
        flock.commit();
      });
    });
    const target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await target.mergeIndexes(manifest);
    } finally {
      await target.close();
    }
    expect(flock.get(['localProject', 'other'])).toEqual({ path: '/cloud' });
    expect(flock.get(['localProject', 'new'])).toEqual({ path: '/source' });
  });

  it('does not publish over a concurrent metadata tombstone', async () => {
    const { manifest } = fixture();
    const wire = server();
    const id = getLoroMetaStreamId('cloud' as WorkspaceId);
    const meta = new Flock();
    wire.rooms.set(id, meta);
    let injected = false;
    wire.beforeCas((stream) => {
      if (stream !== id || injected) return;
      injected = true;
      wire.mutate(id, () => {
        meta.set(['e', 'session-one'], false);
        meta.commit();
      });
    });
    const target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await expect(target.publish(first(manifest.documents), manifest)).rejects.toThrow(
        'collision'
      );
    } finally {
      await target.close();
    }
    expect(meta.get(['e', 'session-one'])).toBe(false);
    expect(meta.get(['m', 'session-one', 'ossMigrationId'])).toBeUndefined();
  });

  it('recovers a durable reservation whose success response and local receipt were lost', async () => {
    const { manifest, bytes } = fixture();
    const dir = await temporary();
    await fs.writeFile(sourceDocumentPath(dir, 'session-one'), bytes);
    const wire = server();
    const id = getLoroStreamIdForDocId('cloud' as WorkspaceId, 'session-one');
    let lost = false;
    wire.loseResponse((method, stream) => {
      if (method !== 'PUT' || stream !== id || lost) return false;
      lost = true;
      return true;
    });
    let target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await expect(
        run(manifest, await loadJournal(dir, manifest.migrationId), dir, target)
      ).rejects.toThrow();
    } finally {
      await target.close();
    }
    expect((await loadJournal(dir, manifest.migrationId)).reserved).toEqual([]);
    expect((wire.rooms.get(id) as LoroDoc).getMap('ossMigration').get('id')).toBe(
      manifest.migrationId
    );
    target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await run(manifest, await loadJournal(dir, manifest.migrationId), dir, target);
    } finally {
      await target.close();
    }
    expect((await loadJournal(dir, manifest.migrationId)).complete).toBe(true);
  });

  it.each(['edit', 'delete'] as const)(
    'continues after a lost index ACK and user %s without rewriting that row',
    async (mutation) => {
      const { manifest, bytes } = fixture();
      const dir = await temporary();
      await fs.writeFile(sourceDocumentPath(dir, 'session-one'), bytes);
      const id = 'cloud:mf:cloud-machine';
      const key = ['localProject', 'new'];
      manifest.flocks = [{ id, rows: [{ key, value: { path: '/source' } }] }];
      const wire = server();
      const flock = new Flock();
      wire.rooms.set(id, flock);
      let lost = false;
      wire.loseResponse((method, stream) => {
        if (method !== 'POST' || stream !== id || lost) return false;
        lost = true;
        return true;
      });
      let target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
      try {
        await expect(
          run(manifest, await loadJournal(dir, manifest.migrationId), dir, target)
        ).rejects.toThrow();
      } finally {
        await target.close();
      }
      expect(flock.get(key)).toEqual({ path: '/source' });
      wire.mutate(id, () => {
        if (mutation === 'edit') flock.set(key, { path: '/user-edited' });
        else flock.delete(key);
        flock.commit();
      });
      target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
      try {
        await run(manifest, await loadJournal(dir, manifest.migrationId), dir, target);
      } finally {
        await target.close();
      }
      expect(flock.get(key)).toEqual(mutation === 'edit' ? { path: '/user-edited' } : undefined);
      expect((await loadJournal(dir, manifest.migrationId)).complete).toBe(true);
      expect(
        (wire.rooms.get(getLoroMetaStreamId('cloud' as WorkspaceId)) as Flock).get([
          'e',
          'session-one',
        ])
      ).toBe(true);
    }
  );

  it('resumes partial metadata publication after user edits and deletion of imported data', async () => {
    const { manifest, bytes } = fixture();
    manifest.documents.push({
      ...first(manifest.documents),
      id: 'session-two',
      meta: { id: 'two' },
    });
    const dir = await temporary();
    for (const entry of manifest.documents)
      await fs.writeFile(sourceDocumentPath(dir, entry.id), bytes);
    const indexId = 'cloud:mf:cloud-machine';
    const key = ['localProject', 'new'];
    manifest.flocks = [{ id: indexId, rows: [{ key, value: { path: '/source' } }] }];
    const wire = server();
    const metaId = getLoroMetaStreamId('cloud' as WorkspaceId);
    let target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    let interrupted = false;
    const originalPublish = target.publish.bind(target);
    target.publish = async (...args) => {
      if (args[0].id === 'session-two' && !interrupted) {
        interrupted = true;
        throw new Error('Stopped after first publication');
      }
      await originalPublish(...args);
    };
    try {
      await expect(
        run(manifest, await loadJournal(dir, manifest.migrationId), dir, target)
      ).rejects.toThrow('Stopped after first');
    } finally {
      await target.close();
    }
    expect((await loadJournal(dir, manifest.migrationId)).published).toEqual(['session-one']);
    wire.mutate(indexId, (room) => {
      const flock = room as Flock;
      flock.set(key, { path: '/user-edit' });
      flock.commit();
    });
    wire.mutate(metaId, (room) => {
      const flock = room as Flock;
      flock.set(['e', 'session-one'], false);
      flock.commit();
    });
    target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await run(manifest, await loadJournal(dir, manifest.migrationId), dir, target);
    } finally {
      await target.close();
    }
    const meta = wire.rooms.get(metaId) as Flock;
    expect(meta.get(['e', 'session-one'])).toBe(false);
    expect(meta.get(['e', 'session-two'])).toBe(true);
    expect((wire.rooms.get(indexId) as Flock).get(key)).toEqual({ path: '/user-edit' });
    expect((await loadJournal(dir, manifest.migrationId)).complete).toBe(true);
  });

  it('refuses deployments without conditional append before writing any records', async () => {
    const { manifest, bytes } = fixture();
    const dir = await temporary();
    await fs.writeFile(sourceDocumentPath(dir, 'session-one'), bytes);
    const wire = server();
    wire.disableCas();
    const target = await openMigrationTarget(provider, 'cloud' as WorkspaceId);
    try {
      await expect(
        run(manifest, await loadJournal(dir, manifest.migrationId), dir, target)
      ).rejects.toThrow('append-cas');
    } finally {
      await target.close();
    }
    expect(wire.writes).toEqual([]);
    expect(wire.rooms.size).toBe(0);
  });

  it('disables schedule definitions without deleting their original history', () => {
    const { manifest } = fixture();
    const source = new LoroDoc();
    source.getMap('definition').set('enabled', true);
    source.getMap('definition').set('machineId', 'local-machine');
    source.commit();
    const bytes = source.export({ mode: 'snapshot' });
    const result = prepareDocument(
      bytes,
      { id: 'schedule-one', meta: {}, sha256: hashBytes(bytes) },
      manifest
    );
    expect(result.getMap('definition').get('enabled')).toBe(false);
    expect(result.getMap('definition').get('machineId')).toBe('cloud-machine');
    expect(source.oplogVersion().compare(result.oplogVersion())).toBe(-1);
  });

  it('rejects attachment references in opaque legacy contents before upload', () => {
    const doc = new LoroDoc();
    doc.getList('history').push({
      id: 'legacy',
      role: 'user',
      timestamp: '2026-10-12T00:00:00.000Z',
      contents: [{ type: 'image', url: 'local-only' }],
    });
    doc.commit();
    expect(() => collectAttachmentFiles(doc)).toThrow('Legacy attachment references');
  });

  it('validates attachment bytes and checkpoints uploads before changing history', async () => {
    const { manifest, original } = fixture();
    const dir = await temporary();
    const blob = Buffer.from('frozen attachment');
    await fs.mkdir(path.join(dir, 'blobs', 'one'), { recursive: true });
    await fs.writeFile(path.join(dir, 'blobs', 'one', 'file1'), blob);
    const mirror = createSessionMirror({ doc: original, initialState: {} });
    mirror.historyWriter.update((history) =>
      history.map((turn) => ({
        ...turn,
        items: [
          ...(turn.items ?? []),
          {
            type: 'file' as const,
            fileId: 'file1',
            fileName: 'note.txt',
            mimeType: 'text/plain',
            sizeBytes: blob.length,
            sha256: hashBytes(blob),
            textPreview: true,
            transport: 'local' as const,
            machineId: 'local-machine',
            uploadedAt: 1,
          },
        ],
      }))
    );
    mirror.dispose();
    await validateAttachments(original, 'one', dir, manifest.sourceMachineId);
    const receipt = await loadJournal(dir, manifest.migrationId);
    const transfer = new SessionAttachmentTransfer('synthetic');
    const upload = vi
      .spyOn(transfer, 'uploadValidatedSessionFile')
      .mockImplementation(async ({ file }) => {
        expect(await fs.readFile(file.absolutePath)).toEqual(blob);
        return {
          ...file,
          type: 'file',
          fileId: 'cloud-file',
          transport: 'r2',
          uploadedAt: 2,
          downloadUrl: 'https://test.invalid/file',
        };
      });
    const bytes = original.export({ mode: 'snapshot' });
    await migrateAttachments(original, 'one', dir, manifest, receipt, transfer);
    const finalMirror = createSessionMirror({ doc: original, initialState: {} });
    expect(first(finalMirror.historyWriter.readStored()).items).toContainEqual(
      expect.objectContaining({ fileId: 'cloud-file', transport: 'r2' })
    );
    finalMirror.dispose();
    const replay = new LoroDoc();
    replay.import(bytes);
    upload.mockImplementation(async () => {
      throw new Error('Already uploaded bytes must not be uploaded again');
    });
    await migrateAttachments(
      replay,
      'one',
      dir,
      manifest,
      await loadJournal(dir, manifest.migrationId),
      transfer
    );
    await fs.writeFile(path.join(dir, 'blobs', 'one', 'file1'), 'corrupt');
    const corrupted = new LoroDoc();
    corrupted.import(bytes);
    await expect(
      validateAttachments(corrupted, 'one', dir, manifest.sourceMachineId)
    ).rejects.toThrow('corrupt attachment');
  });
  it.each([false, true])(
    'preserves replaced attachments and rejects corruption after deletion=%s',
    async (deleted) => {
      const { manifest, original } = fixture();
      const dir = await temporary();
      const blobs = [Buffer.from('first'), Buffer.from('replacement with different length')];
      const files = blobs.map((blob, i) => ({
        type: 'file' as const,
        fileId: `file-${i}`,
        fileName: `file-${i}.txt`,
        mimeType: 'text/plain',
        transport: 'local' as const,
        machineId: manifest.sourceMachineId,
        sizeBytes: blob.length,
        sha256: hashBytes(blob),
        uploadedAt: i + 1,
        textPreview: true,
      }));
      const mirror = createSessionMirror({ doc: original, initialState: {} });
      mirror.historyWriter.update((history) =>
        history.map((turn) => (turn.id === 'u1' ? { ...turn, items: [first(files)] } : turn))
      );
      const past = original.frontiers();
      mirror.historyWriter.update((history) =>
        history.map((turn) => (turn.id === 'u1' ? { ...turn, items: [files[1]!] } : turn))
      );
      if (deleted)
        mirror.historyWriter.update((history) => history.filter((turn) => turn.id !== 'u1'));
      mirror.dispose();
      await fs.mkdir(path.join(dir, 'blobs', 'one'), { recursive: true });
      for (const [i, blob] of blobs.entries())
        await fs.writeFile(path.join(dir, 'blobs', 'one', `file-${i}`), blob);
      expect(collectHistoricalAttachmentFiles(original)).toHaveLength(2);
      expect(
        await validateAttachments(original, 'one', dir, manifest.sourceMachineId)
      ).toHaveLength(2);
      const sourceRoot = await temporary();
      const databaseDir = path.join(sourceRoot, 'loro-repo', manifest.sourceWorkspaceId);
      await fs.mkdir(databaseDir, { recursive: true });
      const store = new SqliteRepoStore({ path: path.join(databaseDir, 'repo.sqlite3') });
      const repo = await LoroRepo.create({
        storageAdapter: store.storage,
        metaDebounceCommitMs: 0,
      });
      (await repo.openPersistedDoc('session-one')).doc.import(
        original.export({ mode: 'snapshot' })
      );
      await repo.upsertDocMeta('session-one', first(manifest.documents).meta);
      await repo.flush();
      await repo.destroy();
      store.close();
      const sourceBlobs = path.join(sourceRoot, 'session-files', manifest.sourceWorkspaceId, 'one');
      await fs.mkdir(sourceBlobs, { recursive: true });
      for (const [i, blob] of blobs.entries())
        await fs.writeFile(path.join(sourceBlobs, `file-${i}`), blob);
      const frozen = path.join(sourceRoot, 'frozen');
      await freezeSource({ ...manifest, sourcePath: sourceRoot }, frozen);
      for (const [i, blob] of blobs.entries())
        expect(await fs.readFile(path.join(frozen, 'blobs', 'one', `file-${i}`))).toEqual(blob);
      await fs.writeFile(path.join(dir, 'blobs', 'one', 'file-1'), blobs[0]!);
      await expect(
        validateAttachments(original, 'one', dir, manifest.sourceMachineId)
      ).rejects.toThrow('corrupt');
      await fs.writeFile(path.join(dir, 'blobs', 'one', 'file-1'), blobs[1]!);
      const transfer = new SessionAttachmentTransfer('synthetic');
      const uploaded = vi
        .spyOn(transfer, 'uploadValidatedSessionFile')
        .mockImplementation(async ({ file }) => ({
          ...file,
          type: 'file',
          transport: 'r2',
          fileId: `cloud-${file.fileName.replace('.txt', '')}`,
          uploadedAt: 3,
          downloadUrl: 'https://test.invalid/file',
        }));
      await migrateAttachments(
        original,
        'one',
        dir,
        manifest,
        await loadJournal(dir, manifest.migrationId),
        transfer
      );
      expect(uploaded).toHaveBeenCalledTimes(2);
      if (deleted) expect(collectAttachmentFiles(original)).toEqual([]);
      else expect(first(collectAttachmentFiles(original)).fileId).toBe('cloud-file-1');
      const old = new LoroDoc();
      old.import(original.export({ mode: 'snapshot' }));
      old.checkout(past);
      expect(
        resolveArchivedAttachment(original, first(collectAttachmentFiles(old)), 'one').fileId
      ).toBe('cloud-file-0');
      await fs.rm(path.join(dir, 'blobs', 'one', 'file-0'));
      await expect(
        validateAttachments(old, 'one', dir, manifest.sourceMachineId)
      ).rejects.toThrow();
    }
  );

  it('archives a deleted historical attachment and resolves the original frontier to cloud bytes', async () => {
    const { manifest, original } = fixture();
    const dir = await temporary();
    const blob = Buffer.from('historical bytes');
    const file = {
      type: 'file' as const,
      fileId: 'past',
      fileName: 'past.txt',
      mimeType: 'text/plain',
      transport: 'local' as const,
      machineId: manifest.sourceMachineId,
      sizeBytes: blob.length,
      sha256: hashBytes(blob),
      uploadedAt: 1,
      textPreview: true,
      storageSessionId: 'deleted-parent',
    };
    const mirror = createSessionMirror({ doc: original, initialState: {} });
    mirror.historyWriter.update((history) => [
      ...history,
      {
        id: 'past-turn',
        role: 'user',
        timestamp: '2026-10-12T00:00:00Z',
        items: [file],
      },
    ]);
    const past = original.frontiers();
    mirror.historyWriter.update((history) => history.filter((turn) => turn.id !== 'past-turn'));
    mirror.dispose();
    expect(collectAttachmentFiles(original)).toEqual([]);
    expect(collectHistoricalAttachmentFiles(original)).toContainEqual(file);
    await fs.mkdir(path.join(dir, 'blobs', 'deleted-parent'), { recursive: true });
    await fs.writeFile(path.join(dir, 'blobs', 'deleted-parent', 'past'), blob);
    await validateAttachments(original, 'one', dir, manifest.sourceMachineId);
    const sourceRoot = await temporary();
    const databaseDir = path.join(sourceRoot, 'loro-repo', manifest.sourceWorkspaceId);
    await fs.mkdir(databaseDir, { recursive: true });
    const store = new SqliteRepoStore({ path: path.join(databaseDir, 'repo.sqlite3') });
    const repo = await LoroRepo.create({ storageAdapter: store.storage, metaDebounceCommitMs: 0 });
    (await repo.openPersistedDoc('session-one')).doc.import(original.export({ mode: 'snapshot' }));
    await repo.upsertDocMeta('session-one', first(manifest.documents).meta);
    await repo.flush();
    await repo.destroy();
    store.close();
    const sourceBlob = path.join(
      sourceRoot,
      'session-files',
      manifest.sourceWorkspaceId,
      'deleted-parent'
    );
    await fs.mkdir(sourceBlob, { recursive: true });
    await fs.writeFile(path.join(sourceBlob, 'past'), blob);
    const frozenDir = path.join(sourceRoot, 'frozen');
    await freezeSource({ ...manifest, sourcePath: sourceRoot }, frozenDir);
    expect(await fs.readFile(path.join(frozenDir, 'blobs', 'deleted-parent', 'past'))).toEqual(
      blob
    );
    await fs.rm(path.join(sourceBlob, 'past'));
    await expect(
      freezeSource({ ...manifest, sourcePath: sourceRoot }, path.join(sourceRoot, 'missing'))
    ).rejects.toThrow();
    const uploadedBlobs = new Map<string, Buffer>();
    const transfer = new SessionAttachmentTransfer('synthetic');
    vi.spyOn(transfer, 'uploadValidatedSessionFile').mockImplementation(async ({ file: input }) => {
      uploadedBlobs.set('relay-past', await fs.readFile(input.absolutePath));
      return {
        ...input,
        type: 'file',
        fileId: 'relay-past',
        transport: 'r2',
        uploadedAt: 2,
        downloadUrl: 'https://test.invalid/past',
      };
    });
    await migrateAttachments(
      original,
      'one',
      dir,
      manifest,
      await loadJournal(dir, manifest.migrationId),
      transfer
    );
    const cloud = new LoroDoc();
    cloud.import(original.export({ mode: 'snapshot' }));
    const old = new LoroDoc();
    old.import(cloud.export({ mode: 'snapshot' }));
    old.checkout(past);
    const oldFile = first(collectAttachmentFiles(old));
    expect(oldFile).toEqual(file);
    const reference = resolveArchivedAttachment(cloud, oldFile, 'one');
    expect(reference).toMatchObject({
      transport: 'r2',
      fileId: 'relay-past',
      textPreview: true,
      storageSessionId: 'deleted-parent',
    });
    expect(uploadedBlobs.get(reference.fileId)).toEqual(blob);
    await fs.rm(path.join(dir, 'blobs', 'deleted-parent', 'past'));
    await expect(validateAttachments(old, 'one', dir, manifest.sourceMachineId)).rejects.toThrow();
  });

  it('propagates cancellation into a real attachment fetch and awaits its release before ending the step', async () => {
    const dir = await temporary();
    const file = path.join(dir, 'blob');
    await fs.writeFile(file, 'bytes');
    let startedResolve: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const events: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('Missing upload abort signal');
        signal.addEventListener(
          'abort',
          () => {
            events.push('fetch-aborted');
            reject(signal.reason);
          },
          { once: true }
        );
        startedResolve();
      }).finally(() => {
        events.push('fetch-released');
      });
    });
    const transfer = new SessionAttachmentTransfer('synthetic', 'https://files.test.invalid');
    const controller = new AbortController();
    const execution = Effect.runPromiseExit(
      migrationStep((signal) =>
        transfer.uploadValidatedSessionFile({
          workspaceId: 'cloud' as WorkspaceId,
          sessionId: 'one' as SessionId,
          file: {
            absolutePath: file,
            fileName: 'a.txt',
            mimeType: 'text/plain',
            sizeBytes: 5,
            sha256: hashBytes('bytes'),
            textPreview: true,
          },
          signal,
        })
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            events.push('scope-released');
          })
        )
      ),
      { signal: controller.signal }
    );
    await started;
    controller.abort();
    const exit = await execution;
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(events).toEqual(['fetch-aborted', 'fetch-released', 'scope-released']);
  });
  effectIt.effect('bounds a stalled network step and aborts its fetch at the deadline', () =>
    Effect.gen(function* () {
      let aborted = false;
      let startedResolve: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      const fiber = yield* Effect.forkChild(
        migrationStep(
          (signal) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  reject(signal.reason);
                },
                { once: true }
              );
              startedResolve();
            })
        )
      );
      yield* Effect.promise(() => started);
      yield* TestClock.adjust('5 minutes');
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(aborted).toBe(true);
    })
  );
});
