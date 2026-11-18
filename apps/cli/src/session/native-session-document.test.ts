import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { LoroDoc } from 'loro-crdt';
import { startEngine } from '@loro-dev/loro-repo-engine';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import { LODY_SESSION_DOC_SCHEMA, type RepoClient } from '@loro-dev/loro-repo-client';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import {
  type SessionId,
  type WorkspaceId,
  type SessionHistoryInput,
  type MessageQueueItemInput,
} from '@lody/shared';
import { SessionDocument } from '@/lib/loro/doc';
import { createSessionBackend } from './session-backend';
import { createNativeSessionDocumentFactory } from './native-session-document-owner';
import type { NativeSessionDocumentFactory } from './native-session-document';

const id = 'native-document' as SessionId;
const namespace = 'native-document-test';
const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const room = { kind: 'loro_doc' as const, id: `session-${id}` };
const user = (turnId: string): SessionHistoryInput => ({
  id: turnId,
  role: 'user',
  timestamp: '2026-11-18T00:00:00Z',
  status: 'pending',
  userId: 'synthetic-owner',
  items: [{ type: 'text', text: 'Synthetic request' }],
  fileDiff: [],
});
const queued = (turnId: string) =>
  ({
    task: 'Synthetic request',
    userId: 'synthetic-owner',
    userTurnId: turnId,
    operationId: `queue:${turnId}`,
    timestamp: '2026-11-18T00:00:00Z',
    acpSessionConfig: {},
  }) as MessageQueueItemInput;

const installedSessionSdk = await loadNativeRepoSdkCompatibility(import.meta.url);
if (process.env.LODY_NATIVE_SESSION_ACCEPTANCE === '1' && !installedSessionSdk?.setValue)
  throw new Error('Native Session acceptance requires a verified local SDK artifact');
// The formal 0.1.0 lane exercises refusal below. These positive cases are a
// separate, honestly skipped local-artifact acceptance lane, never substituted.
const localSessionAcceptance = describe.skipIf(!installedSessionSdk?.setValue);

describe('native Session formal SDK capability boundary', () => {
  it('refuses a selected body without verified literal-write capability before touching old history or Meta', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-native-session-capability-'));
    const engine = startEngine({ dataDir: directory });
    const client = await connectEngine(directory, { autoReconnect: false });
    const repo = await LoroRepo.create({});
    const existing = await repo.openPersistedDoc(room.id);
    existing.doc.getMap('session').set('id', id);
    existing.doc.getMap('opaque').set('retained', 'synthetic old body');
    existing.doc.commit();
    await repo.upsertDocMeta(room.id, { id, title: 'Synthetic untouched old Meta' });
    await repo.persistDocNow(room.id, existing.doc);
    await client.createRoom(namespace, room, 'plaintext', { docSchema: LODY_SESSION_DOC_SCHEMA });
    const nativeBefore = await client.inspectDocCausal(namespace, room);
    const metaBefore = await repo.getDocMeta(room.id);
    const oldBefore = existing.doc.export({ mode: 'snapshot' });
    const factory = createNativeSessionDocumentFactory({
      binding: { accountId: 'synthetic-owner', workspaceId: 'workspace' as WorkspaceId },
      ownsRoom: (value) => value === room.id,
      acquire: async () => ({
        dataDir: directory,
        namespace,
        client,
        writer: 'synthetic-denied',
        contentMode: 'plaintext',
        compatibility: undefined as never,
        requiredSdkArtifactId: 'unverified',
        closeTimeoutMs: 1000,
        editingLeaseMs: 30000,
        now: () => 1234,
        assertCurrent() {},
        waitUntilSynced: async () => false,
        onBackgroundFailure() {},
      }),
    });
    const doc = new SessionDocument(
      repo,
      id,
      () => repo.unloadDoc(room.id),
      undefined,
      undefined,
      factory
    );
    try {
      await expect(doc.init({ historyBackend: 'loro', remoteSync: false })).rejects.toThrow(
        'compatibility required'
      );
      expect((await client.inspectDocCausal(namespace, room)).version).toEqual(
        nativeBefore.version
      );
      expect(await repo.getDocMeta(room.id)).toEqual(metaBefore);
      expect(existing.doc.export({ mode: 'snapshot' })).toEqual(oldBefore);
      expect(existing.doc.getMap('opaque').get('retained')).toBe('synthetic old body');
    } finally {
      await doc.destroy();
      await factory.close();
      await repo.destroy();
      await client.close();
      engine.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('legacy Session physical writer retirement', () => {
  it('keeps captured WASM containers read-only across actual SDK persistence and unload while preserving complete stored state', async () => {
    const { SqliteRepoStore } = await import('loro-repo/storage/sqlite');
    const { freezeLegacySessionLoroDocument } =
      await import('@lody/shared/session-data/legacy-freeze');
    const { readFrozenLegacySessionSqlite } =
      await import('@lody/shared/node/native-session-legacy-source');
    const directory = await mkdtemp(join(tmpdir(), 'lody-session-physical-freeze-'));
    const path = join(directory, 'repo.sqlite3'),
      storage = new SqliteRepoStore({ path });
    const repo = await LoroRepo.create({ storageAdapter: storage.storage });
    const handle = await repo.openPersistedDoc('session-captured');
    const held = handle.doc.getText('future'),
      map = handle.doc.getMap('opaque');
    held.insert(0, 'Accepted legacy state');
    map.set('bytes', new Uint8Array([0, 255]));
    map.set('unknown', { retained: true });
    handle.doc.commit();
    const original = handle.doc.export({ mode: 'snapshot' }),
      cid = held.id;
    try {
      freezeLegacySessionLoroDocument(handle.doc);
      expect(() => held.insert(0, 'forbidden')).toThrow();
      await repo.persistDocNow('session-captured', handle.doc);
      expect(() => map.set('late', true)).toThrow();
      await repo.unloadDoc('session-captured');
      expect(() => held.delete(0, 1)).toThrow();
      expect(() => handle.doc.attach()).toThrow('retired');
      const stored = readFrozenLegacySessionSqlite({
        path,
        workspaceId: 'synthetic',
        sessionId: 'captured',
      });
      expect(stored.present).toBe(true);
      const decoded = LoroDoc.fromSnapshot(stored.snapshot),
        expected = LoroDoc.fromSnapshot(original);
      try {
        expect(decoded.getText('future').id).toBe(cid);
        expect(decoded.toJSON()).toEqual(expected.toJSON());
        const a = decoded.version(),
          b = expected.version();
        try {
          expect(a.compare(b)).toBe(0);
        } finally {
          a.free();
          b.free();
        }
      } finally {
        decoded.free();
        expected.free();
      }
      const missing = readFrozenLegacySessionSqlite({
        path,
        workspaceId: 'synthetic',
        sessionId: 'absent',
      });
      expect(missing).toMatchObject({ present: false, byteLength: 0 });
      expect(missing.snapshot.byteLength).toBe(0);
    } finally {
      await repo.destroy();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it('drains an already held unpersisted legacy Doc per Session, retains failed original persistence for retry, and leaves a sibling writable', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdir } = await import('node:fs/promises');
  const { createCliSqliteRepoStore } = await import('@/lib/loro/sqlite-repo-store');
  const { LoroDocumentManager } = await import('@/lib/loro/doc');
  const { getLogger } = await import('@/utils/logger');
  const { resolveLocalNativeSessionPaths } =
    await import('@lody/shared/node/native-session-routing');
  const { readFrozenLegacySessionSqlite } =
    await import('@lody/shared/node/native-session-legacy-source');
  const root = await mkdtemp(join(tmpdir(), 'lody-session-manager-drain-')),
    previous = process.env.LODY_DATA_DIR;
  process.env.LODY_DATA_DIR = root;
  const binding = {
    accountId: 'local:synthetic',
    workspaceId: 'lw_synthetic' as WorkspaceId,
    dataRoot: root,
  };
  const store = await createCliSqliteRepoStore(
    binding.workspaceId,
    undefined,
    join(root, 'classic')
  );
  const repo = await LoroRepo.create({ storageAdapter: store.storageAdapter });
  const persist = repo.persistDocNow.bind(repo);
  let fail = false;
  repo.persistDocNow = async (...args) => {
    if (fail && args[0] === 'session-held') {
      fail = false;
      throw new Error('Original target persistence failed');
    }
    return persist(...args);
  };
  const manager = new LoroDocumentManager({
    repo,
    workspaceId: binding.workspaceId,
    userId: binding.accountId,
    sqliteRepoStore: store,
    metaSub: null,
    logger: getLogger('session-drain-test'),
  });
  try {
    const held = await repo.openPersistedDoc('session-held'),
      sibling = await repo.openPersistedDoc('session-sibling');
    const text = held.doc.getText('opaque');
    text.insert(0, 'Accepted before freeze');
    held.doc.commit();
    expect(
      readFrozenLegacySessionSqlite({
        path: store.dbPath,
        workspaceId: binding.workspaceId,
        sessionId: 'held',
      }).present
    ).toBe(false);
    const selected = resolveLocalNativeSessionPaths(binding);
    await mkdir(selected.directory, { recursive: true });
    const journal = new DatabaseSync(selected.journalPath);
    try {
      journal.exec(
        'CREATE TABLE native_loro_document_migrations(binding TEXT,room_id TEXT,manifest TEXT,stage TEXT)'
      );
      journal.prepare('INSERT INTO native_loro_document_migrations VALUES(?,?,?,?)').run(
        selected.migrationBinding,
        'session-held',
        JSON.stringify({
          family: 'session',
          binding: selected.migrationBinding,
          namespace: binding.workspaceId,
          roomId: 'session-held',
          migrationId: 'held-doc-fixture',
          targetGeneration: 'stable-test-schema',
          sourceIds: ['classic-held'],
        }),
        'frozen'
      );
    } finally {
      journal.close();
    }
    const nonce = '00000000-0000-4000-8000-000000000002';
    fail = true;
    await expect(manager.freezeLegacySessionForNative('held' as SessionId, nonce)).rejects.toThrow(
      'Original target persistence failed'
    );
    expect(() => text.insert(0, 'late')).toThrow();
    sibling.doc.getText('independent').insert(0, 'Sibling remains writable');
    sibling.doc.commit();
    await repo.persistDocNow('session-sibling', sibling.doc);
    expect(() =>
      manager.freezeLegacySessionForNative(
        'held' as SessionId,
        '00000000-0000-4000-8000-000000000003'
      )
    ).toThrow('nonce');
    const receipt = await manager.freezeLegacySessionForNative('held' as SessionId, nonce);
    expect(receipt.source.present).toBe(true);
    const snapshot = readFrozenLegacySessionSqlite({
      path: store.dbPath,
      workspaceId: binding.workspaceId,
      sessionId: 'held',
    });
    const decoded = LoroDoc.fromSnapshot(snapshot.snapshot);
    try {
      expect(decoded.getText('opaque').toString()).toBe('Accepted before freeze');
    } finally {
      decoded.free();
    }
    expect(() => repo.openPersistedDoc('session-held')).toThrow('frozen');
    expect(sibling.doc.getText('independent').toString()).toBe('Sibling remains writable');
    expect(
      await manager.freezeLegacySessionForNative('held' as SessionId, nonce, 'assert')
    ).toMatchObject({ ownerGeneration: receipt.ownerGeneration, source: receipt.source });
  } finally {
    await manager.cleanUp({ preserveSessionStatus: true });
    if (previous === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it('retains actual Cloud-shaped legacy Session authoring without probing a local independent binding', async () => {
  const { LoroDocumentManager } = await import('@/lib/loro/doc');
  const { getLogger } = await import('@/utils/logger');
  const repo = await LoroRepo.create({});
  const sessionId = 'cloud-legacy-session' as SessionId;
  await repo.upsertDocMeta(`session-${sessionId}`, { id: sessionId, historyBackend: 'loro' });
  const manager = new LoroDocumentManager({
    repo,
    workspaceId: 'cloud_workspace' as WorkspaceId,
    userId: 'cloud-user',
    metaSub: null,
    logger: getLogger('native-session-cloud-legacy'),
  });
  try {
    const doc = await manager.getOrCreateSessionDoc(sessionId, {
      historyBackend: 'loro',
      skipAutoRead: true,
    });
    const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
    await backend.appendUserTurn(user('cloud-user-turn'));
    expect(await backend.readTurn('cloud-user-turn')).toMatchObject({
      state: 'ready',
      turn: { id: 'cloud-user-turn' },
    });
    expect((await doc.getMetaState())?.latestUserMsgId).toBe('cloud-user-turn');
  } finally {
    await manager.cleanUp({ preserveSessionStatus: true });
  }
});

localSessionAcceptance('native SessionDocument production backend composition', () => {
  let directory: string;
  let engine: ReturnType<typeof startEngine>;
  let client: RepoClient;
  let repo: LoroRepo;
  let factory: NativeSessionDocumentFactory;
  const documents: SessionDocument[] = [];
  const selectedIds = new Set<SessionId>();
  const background: unknown[] = [];
  const open = async (options: { skipAutoRead?: boolean } = { skipAutoRead: true }) => {
    const doc = new SessionDocument(
      repo,
      id,
      async () => {
        throw new Error('Native body must not unload an old Repo room');
      },
      undefined,
      undefined,
      factory
    );
    documents.push(doc);
    await doc.init({ ...options, historyBackend: 'loro', remoteSync: false });
    return doc;
  };
  beforeEach(async () => {
    selectedIds.clear();
    selectedIds.add(id);
    directory = await mkdtemp(join(tmpdir(), 'lody-native-session-document-'));
    engine = startEngine({ dataDir: directory });
    client = await connectEngine(directory, { autoReconnect: false });
    await client.createRoom(namespace, room, 'plaintext', { docSchema: LODY_SESSION_DOC_SCHEMA });
    repo = await LoroRepo.create({});
    await repo.upsertDocMeta(room.id, { id, historyBackend: 'loro', title: 'Synthetic session' });
    // This is the actual old body owner. A native selection must never open it,
    // even when metadata remains in its existing independently-owned workspace.
    repo.openPersistedDoc = async () => {
      throw new Error('Old body opened after native selection');
    };
    const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
    if (!proof?.setValue) throw new Error('This suite requires the pinned local SDK artifact');
    factory = createNativeSessionDocumentFactory({
      binding: { accountId: 'synthetic-owner', workspaceId: 'workspace' as WorkspaceId },
      ownsRoom: (roomId) => selectedIds.has(roomId.slice('session-'.length) as SessionId),
      acquire: async (sessionId) =>
        selectedIds.has(sessionId)
          ? {
              dataDir: directory,
              namespace,
              client,
              writer: 'daemon:synthetic',
              contentMode: 'plaintext',
              compatibility: proof,
              requiredSdkArtifactId: proof.artifactId,
              closeTimeoutMs: 1000,
              editingLeaseMs: 30000,
              now: () => 1234,
              assertCurrent() {},
              waitUntilSynced: async () => false,
              onBackgroundFailure: (error) => background.push(error),
            }
          : undefined,
    });
  });
  afterEach(async () => {
    for (const doc of documents.splice(0)) await doc.destroy({ preserveStatus: true });
    await factory?.close();
    await repo?.destroy();
    await client?.close();
    engine?.stop();
    await rm(directory, { recursive: true, force: true });
    expect(background.splice(0)).toEqual([]);
  });
  it('uses real native history/control and existing Meta without opening a legacy body; restart retains queue identity and history', async () => {
    const doc = await open();
    const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
    expect(doc.handle).toBeNull();
    expect(Reflect.get(doc, 'mirror')).toBeNull();
    await doc.recordHumanInputReceipt('input-1', 'synthetic-owner');
    await doc.appendUserTurn(user('input-1'));
    expect((await doc.getMetaState())?.latestUserMsgId).toBe('input-1');
    expect((await doc.getDocState())?.humanInputReceipts?.['input-1']?.userId).toBe(
      'synthetic-owner'
    );
    expect(await backend.readTurn('input-1')).toMatchObject({
      state: 'ready',
      turn: { id: 'input-1' },
    });
    await doc.pushMessageQueue(queued('input-2'));
    const queue = await doc.getMessageQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.$cid).toEqual(expect.any(String));
    await doc.pushMessageQueue(queued('input-2'));
    await expect(
      doc.pushMessageQueue({ ...queued('input-2'), task: 'Conflicting request' })
    ).rejects.toThrow('identity conflict');
    expect((await doc.getMessageQueue())[0]?.$cid).toBe(queue[0]?.$cid);
    await doc.flushLocalWrites();
    await doc.destroy({ preserveStatus: true });
    await expect(backend.appendUserTurn(user('retired'))).rejects.toThrow('retired');
    const restarted = await open();
    expect((await restarted.getMessageQueue())[0]?.$cid).toBe(queue[0]?.$cid);
    const next = await createSessionBackend(restarted, { historyBackend: 'loro' });
    const item = (await restarted.getMessageQueue())[0]!;
    expect(next.getQueueOperationId(item)).toBe('queue:input-2');
    await next.promoteQueuedTurn({ operationId: 'queue:input-2', item, entry: user('input-2') });
    expect(await restarted.getMessageQueue()).toEqual([]);
    expect((await next.readHistory()).map((turn) => turn.id)).toEqual(['input-1', 'input-2']);
    expect((await restarted.getMetaState())?.queuePromotionLedger?.['queue:input-2']?.state).toBe(
      'queue_consumed'
    );
    expect((await restarted.getMetaState())?.latestUserMsgId).toBe('input-2');
  });
  it('keeps opaque i64 exact in requested bodies, streaming inline writes, full export and captured turn copy', async () => {
    const value = 9007199254740993n;
    await client.applyDocPatch(namespace, room, [
      { op: 'set', path: ['history'], value: [] },
      { op: 'arr_splice', path: ['history'], at: 0, del: 0, items: [null, null] },
      {
        op: 'set_value',
        path: ['history', 0],
        value: {
          ...user('i64-user'),
          future: { number: value },
          $cid: 'literal-i64-user',
        } as never,
      },
      {
        op: 'set_value',
        path: ['history', 1],
        value: {
          id: 'i64-assistant',
          role: 'assistant',
          userTurnId: 'i64-user',
          timestamp: 'synthetic',
          future: value,
          items: [
            { type: 'future-item', opaque: { number: value } },
            { type: 'text', text: 'before' },
          ],
        },
      },
    ]);
    const doc = await open();
    const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
    const rawRead = client.readDoc.bind(client);
    let fullReadsAllowed = false;
    let peerInserted = false;
    client.readDoc = async (...args) => {
      if (!fullReadsAllowed && args[2]?.length === 1 && args[2][0] === 'history')
        throw new Error('Unrequested complete history read');
      if (!peerInserted && args[2]?.[0] === 'history' && args[2]?.[1] === 0) {
        peerInserted = true;
        await client.applyDocPatch(namespace, room, [
          {
            op: 'arr_splice',
            path: ['history'],
            at: 0,
            del: 0,
            items: [{ id: 'concurrent-prefix', role: 'system', timestamp: 'synthetic', items: [] }],
          },
        ]);
      }
      return rawRead(...args);
    };
    expect(await backend.readTurn('i64-user')).toMatchObject({
      state: 'ready',
      turn: { future: { number: value }, $cid: 'literal-i64-user' },
    });
    expect(peerInserted).toBe(true);
    expect((await backend.history.readRange(0, 3))[2]).toMatchObject({
      state: 'ready',
      turn: { future: value, items: [{ opaque: { number: value } }, { text: 'before' }] },
    });
    expect(await backend.history.readTurnForDisplay!('i64-assistant')).toMatchObject({
      state: 'ready',
      turn: { future: value },
    });
    await backend.applyHistoryAction({ kind: 'user-status', turnId: 'i64-user', status: 'seen' });
    await backend.applyAgentBatch({
      targetAssistantEntryId: 'i64-assistant',
      entryBound: true,
      operationIds: ['synthetic-i64-token'],
      notifications: [
        {
          sessionId: 'synthetic',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ':after' },
          },
        },
      ] as never,
    });
    expect((await rawRead(namespace, room, ['history', 1])).value).toMatchObject({
      status: 'seen',
      future: { number: value },
      $cid: 'literal-i64-user',
    });
    expect((await rawRead(namespace, room, ['history', 2])).value).toMatchObject({
      future: value,
      items: [{ opaque: { number: value } }, { text: 'before:after' }],
    });
    fullReadsAllowed = true;
    expect((await backend.readHistory())[1]).toMatchObject({ future: { number: value } });
    const snapshot = await backend.captureForkSnapshot();
    expect(snapshot.history[1]).toMatchObject({ future: { number: value } });
    const forkId = 'i64-fork' as SessionId;
    selectedIds.add(forkId);
    await client.createRoom(namespace, { kind: 'loro_doc', id: `session-${forkId}` }, 'plaintext', {
      docSchema: LODY_SESSION_DOC_SCHEMA,
    });
    const target = await factory(
      forkId,
      { read: async () => undefined, patch: async () => {}, flush: () => repo.flush() },
      { historyBackend: 'loro' }
    );
    if (!target) throw new Error('Selected copy target required');
    try {
      await target.initialize(undefined, { skipAutoRead: true, remoteSync: false });
      await target.backend.importForkHistory(snapshot, snapshot.history);
      expect(await target.backend.readTurn('i64-user')).toMatchObject({
        state: 'ready',
        turn: { future: { number: value } },
      });
    } finally {
      await target.close();
    }
  });
  it('loads the shared Node kernel as a real main bundle without legacy Repo/Flock and commits through the same engine', async () => {
    const { build } = await import('esbuild');
    const { pathToFileURL } = await import('node:url');
    const output = await mkdtemp(join(import.meta.dirname, 'native-session-main-smoke-'));
    const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
    if (!proof) throw new Error('Local artifact proof required');
    const entry = join(output, 'main.mjs');
    const shared = join(
      import.meta.dirname,
      '../../../../packages/shared/src/node/native-session.ts'
    );
    try {
      await build({
        entryPoints: [shared],
        outfile: entry,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node26',
        external: ['loro-crdt', '@loro-dev/loro-repo-client', '@loro-dev/loro-repo-client/*'],
        banner: {
          js: "import {createRequire as __require} from 'node:module';const require=__require(import.meta.url);",
        },
        plugins: [
          {
            name: 'no-legacy-data-runtime',
            setup(builder) {
              builder.onResolve(
                { filter: /^(?:loro-repo(?:\/|$)|@loro-dev\/flock-wasm(?:\/|$))/ },
                (args) => {
                  throw new Error(`Legacy runtime in main Session kernel: ${args.path}`);
                }
              );
            },
          },
        ],
      });
      const imported = (await import(
        pathToFileURL(entry).href
      )) as typeof import('@lody/shared/node/native-session');
      const nativeFactory = imported.createNativeSessionDocumentFactory({
        binding: factory.binding,
        ownsRoom: (value) => value === room.id,
        acquire: async () => ({
          dataDir: directory,
          namespace,
          client,
          writer: 'main:synthetic',
          contentMode: 'plaintext',
          compatibility: proof,
          requiredSdkArtifactId: proof.artifactId,
          closeTimeoutMs: 1000,
          editingLeaseMs: 30000,
          now: () => 1234,
          assertCurrent() {},
          waitUntilSynced: async () => false,
          onBackgroundFailure: (error) => background.push(error),
        }),
      });
      try {
        const body = await nativeFactory(
          id,
          { read: async () => undefined, patch: async () => {}, flush: () => repo.flush() },
          { historyBackend: 'loro' }
        );
        if (!body) throw new Error('Missing native main body');
        await body.initialize(
          { history: [user('main-bundle')] },
          { skipAutoRead: true, remoteSync: false }
        );
        const registry = new imported.NativeSessionSnapshotRegistry();
        const domain = imported.createNativeSessionDomainService({
          owner: body,
          generation: 'main-scope',
          principalId: 'synthetic-owner',
          snapshots: registry,
          assertCurrent() {},
        });
        try {
          expect(
            await domain.read({ kind: 'turn', turnId: 'main-bundle' }, 'main-scope')
          ).toMatchObject({ state: 'ready', turn: { id: 'main-bundle' } });
          await domain.execute({ kind: 'humanReceipt', inputId: 'main-bundle' }, 'main-scope');
          expect((await body.control.read()).humanInputReceipts?.['main-bundle']?.userId).toBe(
            'synthetic-owner'
          );
        } finally {
          domain.close();
          registry.close();
          await body.close();
        }
      } finally {
        await nativeFactory.close();
      }
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
  it('drives the shipped renderer ConversationView and actual queue writer through native domain commands with no renderer Doc', async () => {
    const { createNativeSessionDomainService, NativeSessionSnapshotRegistry } =
      await import('./native-session-domain-service');
    const { createNativeSessionIpcSource } =
      await import('../../../../packages/components/src/providers/native-session-ipc');
    const { createNativeSessionDocStore } =
      await import('../../../../packages/components/src/providers/native-session-store');
    const { createDirectWorkspaceWriter } =
      await import('../../../../packages/components/src/providers/workspace-writer-impl');
    type Transport = import('@lody/shared/native-session-domain').NativeSessionDomainTransport;
    type Event = import('@lody/shared/native-session-domain').NativeSessionEvent;
    const owner = await factory(
      id,
      {
        read: async () => (await repo.getDocMeta(room.id))?.meta as never,
        patch: async (patch) => {
          await repo.upsertDocMeta(room.id, patch);
        },
        flush: () => repo.flush(),
      },
      { historyBackend: 'loro' }
    );
    if (!owner) throw new Error('Native route required');
    await owner.initialize(undefined, { skipAutoRead: true, remoteSync: false });
    const registry = new NativeSessionSnapshotRegistry();
    const bodyOwners = new Map([[id, owner]]);
    registry.bindRealm('window-registration', {
      windowId: 1,
      registrationId: 'window-registration',
      workspaceId: 'workspace',
    });
    let selection = 0;
    const releasedGrants = new Set<string>();
    const listeners = new Set<(event: Event) => void>();
    const { NativeSessionMainLegacy } =
      await import('../../../electron/src/main/services/native-session-domain');
    const main = new NativeSessionMainLegacy({
      acquire: async (windowId, registrationId, sessionId) => {
        if (
          windowId !== 1 ||
          registrationId !== 'window-registration' ||
          !bodyOwners.has(sessionId)
        )
          throw Object.assign(new Error('Denied product scope'), { code: 'access_denied' });
        const generation = `server-${++selection}`;
        const service = createNativeSessionDomainService({
          owner: bodyOwners.get(sessionId)!,
          generation,
          principalId: 'synthetic-owner',
          snapshots: registry,
          snapshotRealm: 'window-registration',
          assertCurrent() {
            if (releasedGrants.has(generation)) throw new Error('Retired grant');
          },
        });
        return {
          generation,
          domain: service,
          assertCurrent() {
            if (releasedGrants.has(generation)) throw new Error('Retired grant');
          },
          release: async () => {
            releasedGrants.add(generation);
          },
        };
      },
      retireSnapshots: (_window, registrationId) =>
        registrationId
          ? registry.retireRegistration(registrationId)
          : registry.retireWindow(_window),
      closeSnapshots: () => registry.close(),
      send: (_window, event) => {
        for (const listener of listeners) listener(structuredClone(event));
      },
    });
    let loseUnobserveAck = false;
    const transport: Transport = {
      read: async (request) =>
        structuredClone(await main.read(1, request, request.query, request.expectedGeneration)),
      execute: async (request) =>
        structuredClone(
          await main.execute(1, request, request.command, request.expectedGeneration)
        ),
      observe: async (request) => structuredClone(await main.observe(1, request)),
      unobserve: async (request) => {
        const ack = await main.unobserve(1, request, request.leaseId);
        if (loseUnobserveAck) {
          loseUnobserveAck = false;
          throw new Error('Synthetic lost release ACK');
        }
        return ack;
      },
      cancelObservation: (request) => main.cancelObservation(1, request),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const source = createNativeSessionIpcSource({
      registrationId: 'window-registration',
      sessionId: id,
      requestId: 'source-1',
      transport,
    });
    let store: Awaited<ReturnType<typeof createNativeSessionDocStore>> | undefined;
    try {
      store = await createNativeSessionDocStore(source, 'synthetic-owner');
      await store.history.ready;
      expect(store.doc).toBeUndefined();
      expect(() => store!.setState({})).toThrow('explicit domain');
      const controlReady = deferred<void>();
      const detachControl = source.subscribe(() => {
        if (source.getSnapshot()?.humanInputReceipts?.['rendered-user']) controlReady.resolve();
      });
      await store.nativeBody!.recordHumanInputReceipt('rendered-user', 'synthetic-owner');
      await controlReady.promise;
      detachControl();
      const membershipReady = deferred<void>();
      const detachMembership = store.history.subscribe(() => {
        if (store!.history.indexOf('rendered-user') >= 0) membershipReady.resolve();
      });
      const { createSessionSendResources } =
        await import('../../../../packages/components/src/lib/session-send-resources');
      const { writeUserTurn } =
        await import('../../../../packages/components/src/lib/session-send-delivery');
      const writer = createDirectWorkspaceWriter({
        repo: repo as never,
        acquireSessionStore: async () => store!,
        releaseSessionStoreRef() {},
        acquirePreviewVisualCommentStore: async () => {
          throw new Error('Unrelated preview');
        },
        releasePreviewVisualCommentStoreRef() {},
      });
      const resources = createSessionSendResources({
        acquire: async () => store!,
        releaseRef() {},
      });
      try {
        await writeUserTurn({ repo, writer, sendResources: resources } as never, {
          sessionId: id,
          entry: user('rendered-user') as never,
          delivery: { kind: 'dispatch' },
        });
      } finally {
        await resources.dispose();
      }

      expect(
        ((await repo.getDocMeta(room.id))?.meta as import('@lody/shared').SessionMeta)
          .latestUserMsgId
      ).toBe('rendered-user');
      expect(await source.sessionData.history.readTurn('rendered-user')).toMatchObject({
        state: 'ready',
        turn: { items: [{ text: 'Synthetic request' }] },
      });
      await membershipReady.promise;
      detachMembership();
      const lease = store.history.acquireRange(0, 1);
      await lease.ready;
      expect(store.history.turn(0)?.id).toBe('rendered-user');
      lease.release();
      await writer.enqueueSessionMessage(id, queued('renderer-queued') as never);
      const queue = await owner.control.getMessageQueue();
      expect(queue).toHaveLength(1);
      const meta = (await repo.getDocMeta(room.id))?.meta as import('@lody/shared').SessionMeta;
      expect(owner.control.hasCausalFrontiers(meta.messageQueueUpdateVersion!.frontiers)).toBe(
        true
      );
      await writer.updateSessionMessage(id, queue[0]!.$cid, { task: 'Updated synthetic request' });
      expect((await owner.control.getMessageQueue())[0]?.task).toBe('Updated synthetic request');
      await writer.removeSessionMessage(id, queue[0]!.$cid);
      expect(await owner.control.getMessageQueue()).toEqual([]);
      const before = await client.inspectDocCausal(namespace, room);
      await expect(
        main.execute(
          1,
          { registrationId: 'window-registration', sessionId: id, requestId: 'stale-command' },
          { kind: 'append', turn: user('stale') as never },
          'old-server'
        )
      ).rejects.toMatchObject({ code: 'restart_required' });
      expect((await client.inspectDocCausal(namespace, room)).version).toEqual(before.version);
      const immutable = await source.sessionData.snapshots.capture();
      loseUnobserveAck = true;
      await expect(source.close()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      expect(source.cleanupPending).toBe(true);
      expect(client.connectionState).toBe('connected');
      await source.close();
      expect(source.cleanupPending).toBe(false);
      await expect(
        main.observe(1, {
          registrationId: 'window-registration',
          sessionId: id,
          requestId: 'source-1',
        })
      ).rejects.toMatchObject({ code: 'restart_required' });
      const targetId = 'native-copy-after-source-close' as SessionId;
      selectedIds.add(targetId);
      await client.createRoom(
        namespace,
        { kind: 'loro_doc', id: `session-${targetId}` },
        'plaintext',
        { docSchema: LODY_SESSION_DOC_SCHEMA }
      );
      const target = await factory(
        targetId,
        { read: async () => undefined, patch: async () => {}, flush: async () => {} },
        { historyBackend: 'loro' }
      );
      if (!target) throw new Error('Native copy destination required');
      await target.initialize(undefined, { skipAutoRead: true, remoteSync: false });
      bodyOwners.set(targetId, target);
      const destination = createNativeSessionIpcSource({
        registrationId: 'window-registration',
        sessionId: targetId,
        requestId: 'copy-target',
        transport,
      });
      try {
        await destination.ready;
        await destination.sessionData.snapshots.copyFrom(immutable, immutable.history);
        expect(await destination.sessionData.history.readTurn('rendered-user')).toMatchObject({
          state: 'ready',
          turn: { id: 'rendered-user' },
        });
        registry.retireRegistration('window-registration');
        await expect(
          destination.sessionData.snapshots.copyFrom(immutable, immutable.history)
        ).rejects.toThrow();
        expect(await target.backend.readHistory()).toHaveLength(1);
      } finally {
        await destination.close();
        await target.close();
      }
      const nextSource = createNativeSessionIpcSource({
        registrationId: 'window-registration',
        sessionId: id,
        requestId: 'source-2',
        transport,
      });
      try {
        await nextSource.ready;
        expect(await nextSource.sessionData.history.count()).toBe(1);
        await nextSource.sessionData.commands.appendTurn(user('reopened-renderer') as never);
        expect((await owner.backend.readHistory()).map((turn) => turn.id)).toEqual([
          'rendered-user',
          'reopened-renderer',
        ]);
        expect(
          ((await repo.getDocMeta(room.id))?.meta as import('@lody/shared').SessionMeta)
            .latestUserMsgId
        ).toBe('rendered-user');
      } finally {
        await nextSource.close();
      }
    } finally {
      store?.dispose();
      await source.close();
      await main.close();
      expect(releasedGrants.size).toBe(selection);
      registry.close();
      await owner.close();
    }
  });
  it('binds the actual native Meta owner to dispatch and rechecks a newer activation at its CAS head', async () => {
    const { META_ROOM } = await import('@loro-dev/loro-repo-client');
    const { createNativeWorkspaceMeta } = await import('@lody/shared/node/native-workspace-meta');
    const { acquireNativeSessionDomainGrant } =
      await import('@lody/shared/node/native-session-domain-grant');
    const { NativeSessionSnapshotRegistry } = await import('./native-session-domain-service');
    const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
    if (!proof) throw new Error('Actual local artifact required');
    await client.createRoom('workspace', META_ROOM);
    await client.flockBatch('workspace', META_ROOM, [
      { op: 'put', key: ['e', room.id], value: true },
      { op: 'put', key: ['m', room.id, 'id'], value: id },
    ]);
    const metadata = createNativeWorkspaceMeta({
      binding: factory.binding,
      generation: 'actual-meta',
      client,
      sdkCompatibility: proof,
      sdkArtifactId: proof.artifactId,
      assertCurrent() {},
    });
    const snapshots = new NativeSessionSnapshotRegistry();
    const grant = await acquireNativeSessionDomainGrant({
      factory,
      metadata: { ...metadata, owner: 'native', binding: factory.binding },
      sessionId: id,
      scopeGeneration: 'trusted-window',
      principalId: 'synthetic-owner',
      snapshots,
      assertCurrent() {},
    });
    const rival = await connectEngine(directory, { autoReconnect: false });
    const flockBatch = client.flockBatch.bind(client);
    let interfered = false;
    client.flockBatch = async (...args) => {
      if (
        !interfered &&
        args[0] === 'workspace' &&
        args[2].some((op) => op.op === 'put' && op.key.includes('latestUserMsgId'))
      ) {
        interfered = true;
        await rival.applyDocPatch(namespace, room, [
          {
            op: 'arr_splice',
            path: ['history'],
            at: 1,
            del: 0,
            items: [user('newer-rival') as never],
          },
        ]);
        await rival.flockBatch('workspace', META_ROOM, [
          { op: 'put', key: ['m', room.id, 'latestUserMsgId'], value: 'newer-rival' },
        ]);
      }
      return flockBatch(...args);
    };
    try {
      await grant.domain.execute(
        { kind: 'dispatchUserTurn', turn: user('older-dispatch') as never },
        grant.generation
      );
      expect(interfered).toBe(true);
      expect((await metadata.document(room.id).read())?.latestUserMsgId).toBe('newer-rival');
      expect(
        await grant.domain.read({ kind: 'range', from: 0, to: 2 }, grant.generation)
      ).toMatchObject([
        { state: 'ready', turn: { id: 'older-dispatch' } },
        { state: 'ready', turn: { id: 'newer-rival' } },
      ]);
      let lost = false;
      client.flockBatch = async (...args) => {
        const result = await flockBatch(...args);
        if (!lost && args[2].some((op) => op.op === 'put' && op.key.includes('latestUserMsgId'))) {
          lost = true;
          throw new Error('Synthetic unknown Meta ACK');
        }
        return result;
      };
      await expect(
        grant.domain.execute(
          { kind: 'dispatchUserTurn', turn: user('unknown-ack') as never },
          grant.generation
        )
      ).rejects.toThrow('unknown Meta ACK');
      expect(await grant.domain.read({ kind: 'count' }, grant.generation)).toBe(3);
      expect(
        (await rival.flockGet('workspace', META_ROOM, ['m', room.id, 'latestUserMsgId'])).value
      ).toBe('unknown-ack');
    } finally {
      client.flockBatch = flockBatch;
      await grant.release();
      await metadata.close();
      snapshots.close();
      await rival.close();
    }
  });
  it('uses the actual external SDK through the main public Meta facet without exposing private fields or replaying unknown writes', async () => {
    const sdk = await import('loro-repo');
    const { META_ROOM } = await import('@loro-dev/loro-repo-client');
    const { createNativeWorkspaceMeta } = await import('@lody/shared/node/native-workspace-meta');
    const { NativeWorkspaceMetaMainLegacy } =
      await import('../../../electron/src/main/services/native-workspace-meta');
    const { createNativeWorkspaceMetaAdapter } =
      await import('../../../../packages/components/src/providers/electron-native-workspace-meta');
    const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
    if (!proof) throw new Error('Actual native artifact required');
    const namedFactory = Reflect.get(LoroRepo, 'createWithExternalMetadata');
    const NotCommitted = Reflect.get(sdk, 'ExternalMetadataNotCommittedError');
    if (typeof namedFactory !== 'function' || typeof NotCommitted !== 'function')
      throw new Error('Final external Meta SDK required');
    await client.createRoom('workspace', META_ROOM);
    await client.flockBatch('workspace', META_ROOM, [
      { op: 'put', key: ['e', room.id], value: true },
      {
        op: 'put',
        key: ['m', room.id],
        value: {
          id,
          machineId: 'machine',
          userId: 'synthetic-owner',
          title: 'Visible title',
          env: { SECRET: 'synthetic-private-env' },
          customAcp: { command: 'synthetic-private-command' },
          lastModel: { name: 'Visible model', env: 'synthetic-private-model' },
          project: {
            kind: 'github',
            repoFullName: 'synthetic/repository',
            branch: 'main',
            env: 'synthetic-private-project',
          },
          opaque: 9007199254740993n,
        },
      },
      { op: 'put', key: ['e', 'machine-machine'], value: true },
      {
        op: 'put',
        key: ['m', 'machine-machine'],
        value: {
          id: 'machine',
          name: 'Visible machine',
          cliVersion: 'synthetic',
          os: 'synthetic',
          sessions: [id],
          acpCapabilities: { private: 'synthetic-private-cache' },
          env: { SECRET: 'synthetic-private-machine' },
        },
      },
      { op: 'put', key: ['e', 'agent-private'], value: true },
      { op: 'put', key: ['m', 'agent-private'], value: { prompt: 'synthetic-private-prompt' } },
    ]);
    const metadata = createNativeWorkspaceMeta({
      binding: factory.binding,
      generation: 'native-meta',
      client,
      sdkCompatibility: proof,
      sdkArtifactId: proof.artifactId,
      assertCurrent() {},
    });
    const listeners = new Set<(event: unknown) => void>();
    const main = new NativeWorkspaceMetaMainLegacy({
      acquire: async (windowId, registrationId) => {
        if (windowId !== 1 || registrationId !== 'meta-registration')
          throw Object.assign(new Error('Denied'), { code: 'access_denied' });
        return {
          generation: 'public-generation',
          binding: factory.binding,
          actorId: 'synthetic-owner',
          machineId: 'machine',
          metadata,
          allowsFlock: () => false,
          assertCurrent() {},
        };
      },
      send: (_window, event) => {
        for (const listener of listeners) listener(structuredClone(event));
      },
    });
    let loseCommit = false,
      loseRelease = false;
    const transport = {
      read: (scope: never) => main.read(1, scope),
      commit: async (request: any) => {
        const reply = await main.commit(1, request, request.command, request.expectedGeneration);
        if (loseCommit) {
          loseCommit = false;
          throw new Error('Synthetic lost committed reply');
        }
        return reply;
      },
      flush: (request: any) => main.flush(1, request, request.expectedGeneration),
      observe: (scope: never) => main.observe(1, scope),
      unobserve: async (request: any) => {
        const receipt = await main.unobserve(1, request, request.leaseId);
        if (loseRelease) {
          loseRelease = false;
          throw new Error('Synthetic lost release reply');
        }
        return receipt;
      },
      cancelObservation: (scope: never) => main.cancelObservation(1, scope),
    };
    const source = createNativeWorkspaceMetaAdapter({
      registrationId: 'meta-registration',
      requestId: () => 'public-meta-source',
      transport: transport as never,
      listen: (listener) => {
        const receive = (event: unknown) =>
          listener(event as import('@lody/shared/native-workspace-meta-ipc').WorkspaceMetaEvent);
        listeners.add(receive);
        return () => {
          listeners.delete(receive);
        };
      },
      knownNotCommitted: () => Reflect.construct(NotCommitted, []) as Error,
    });
    const external = (await Reflect.apply(namedFactory, LoroRepo, [
      {},
      source.adapter,
    ])) as LoroRepo;
    try {
      expect(Reflect.get(external, 'metadataMode')).toBe('external');
      expect(() => external.getMeta()).toThrow();
      const visible = await source.adapter.read();
      expect(visible.docs.find((row) => row.docId === room.id)?.meta).toMatchObject({
        title: 'Visible title',
        lastModel: { name: 'Visible model' },
        project: { kind: 'github', repoFullName: 'synthetic/repository' },
      });
      expect(visible.docs.find((row) => row.docId === 'agent-private')).toBeUndefined();
      expect(JSON.stringify(visible)).not.toContain('synthetic-private');
      await expect(
        external.upsertDocMeta(room.id, { env: { SECRET: 'renderer-must-not-write' } })
      ).rejects.toBeInstanceOf(NotCommitted);
      // Creation must not enter attachment/send admission; retain the real
      // metadata producer while making this unrelated UI-only seam explicit.
      vi.doMock('../../../../packages/components/src/lib/session-send-admission', () => ({
        acceptSessionUserTurn() {
          throw new Error('Unexpected send during metadata creation');
        },
      }));
      vi.doMock('../../../../packages/components/src/lib/session-send-delivery', () => ({
        dispatchUserTurn() {
          throw new Error('Unexpected dispatch during metadata creation');
        },
        steerUserTurn() {
          throw new Error('Unexpected steer during metadata creation');
        },
      }));
      const { createSessionSubmission } =
        await import('../../../../packages/components/src/lib/session-submission');
      const published = new Map<string, unknown>();
      const submissions = createSessionSubmission({
        runtime: {
          workspaceId: 'workspace',
          writer: {
            upsertDocMeta: (docId: string, patch: Record<string, unknown>) =>
              external.upsertDocMeta(docId, patch as never),
          },
          ensureDocStream: async () => {},
        } as never,
        assertSessionCreateAllowed() {},
        recordWorkspaceActivity() {},
        publishSessionMeta: (docId, meta) => {
          published.set(docId, meta);
        },
        readSessionMeta: () => undefined,
        recordChat() {},
        onRpcDelivered() {},
      });
      const created = await submissions.createSession({
        sessionId: 'actual-submission' as SessionId,
        machineId: 'machine',
        userId: 'synthetic-owner',
        cliType: 'acp',
        agentType: 'codex',
        title: 'Real producer shape',
      } as never);
      expect(created.sessionMeta.status).toEqual({ type: 'idle' });
      expect(published.get('session-actual-submission')).toMatchObject({
        status: { type: 'idle' },
      });
      expect((await external.getDocMeta('session-actual-submission'))?.meta.status).toEqual({
        type: 'idle',
      });
      await external.upsertDocMeta(room.id, { title: 'Accepted public edit' });
      expect((await metadata.document(room.id).read())?.env).toEqual({
        SECRET: 'synthetic-private-env',
      });
      expect((await metadata.document(room.id).read())?.title).toBe('Accepted public edit');
      await expect(
        main.commit(
          1,
          { registrationId: 'meta-registration', requestId: 'foreign-machine' },
          { kind: 'upsert-doc', docId: room.id, patch: { machineId: 'foreign' } },
          'public-generation'
        )
      ).rejects.toMatchObject({ code: 'not_committed' });
      await external.upsertDocMeta(`preview-comment-${id}`, {});
      await expect(
        main.commit(
          1,
          { registrationId: 'meta-registration', requestId: 'private-preview' },
          {
            kind: 'upsert-doc',
            docId: `preview-comment-${id}`,
            patch: { title: 'Forbidden private metadata' },
          },
          'public-generation'
        )
      ).rejects.toMatchObject({ code: 'not_committed' });
      loseCommit = true;
      await expect(
        external.upsertDocMeta(room.id, { title: 'Committed with unknown reply' })
      ).rejects.toThrow();
      await expect(
        external.upsertDocMeta(room.id, { title: 'Never replay this' })
      ).rejects.toThrow();
      expect((await metadata.document(room.id).read())?.title).toBe('Committed with unknown reply');
      // A failed external write lane does not destroy independent catalog reads.
      expect((await external.getDocMeta(room.id))?.meta.title).toBe('Committed with unknown reply');
      expect(source.getHealth().status).toBe('failed');
      loseRelease = true;
      await expect(source.close()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      expect(source.cleanupPending).toBe(true);
      await source.close();
      expect(source.cleanupPending).toBe(false);
    } finally {
      await external.destroy().catch(() => undefined);
      await source.close();
      await main.close();
      await metadata.close();
    }
  });
  it('confirms exact main cancellation before a delayed observe reply and never revives its retired source', async () => {
    const { createNativeSessionDomainService, NativeSessionSnapshotRegistry } =
      await import('./native-session-domain-service');
    const { createNativeSessionIpcSource } =
      await import('../../../../packages/components/src/providers/native-session-ipc');
    const { NativeSessionMainLegacy } =
      await import('../../../electron/src/main/services/native-session-domain');
    type Transport = import('@lody/shared/native-session-domain').NativeSessionDomainTransport;
    type Event = import('@lody/shared/native-session-domain').NativeSessionEvent;
    const body = await factory(
      id,
      { read: async () => undefined, patch: async () => {}, flush: () => repo.flush() },
      { historyBackend: 'loro' }
    );
    if (!body) throw new Error('Native route required');
    await body.initialize(undefined, { skipAutoRead: true, remoteSync: false });
    const registry = new NativeSessionSnapshotRegistry();
    const listeners = new Set<(event: Event) => void>();
    const acquired = deferred<void>();
    const reply = deferred<void>();
    let released = false;
    const main = new NativeSessionMainLegacy({
      acquire: async () => ({
        generation: 'late-scope',
        domain: createNativeSessionDomainService({
          owner: body,
          generation: 'late-scope',
          principalId: 'synthetic-owner',
          snapshots: registry,
          assertCurrent() {},
        }),
        assertCurrent() {},
        release: async () => {
          released = true;
        },
      }),
      send: (_window, event) => {
        for (const listener of listeners) listener(event);
      },
    });
    const transport: Transport = {
      read: (request) => main.read(1, request, request.query, request.expectedGeneration),
      execute: (request) => main.execute(1, request, request.command, request.expectedGeneration),
      observe: async (request) => {
        const value = await main.observe(1, request);
        acquired.resolve();
        await reply.promise;
        return value;
      },
      unobserve: (request) => main.unobserve(1, request, request.leaseId),
      cancelObservation: (request) => main.cancelObservation(1, request),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const source = createNativeSessionIpcSource({
      transport,
      registrationId: 'late-window',
      sessionId: id,
      requestId: 'same-logical-request',
    });
    try {
      await acquired.promise;
      await source.close();
      expect(released).toBe(true);
      expect(source.cleanupPending).toBe(false);
      expect(source.getSnapshot()).toBeUndefined();
      reply.resolve();
      await expect(source.ready).rejects.toMatchObject({ code: 'restart_required' });
      expect(source.available).toBe(false);
      await expect(
        main.observe(1, {
          registrationId: 'late-window',
          sessionId: id,
          requestId: 'same-logical-request',
        })
      ).rejects.toMatchObject({ code: 'restart_required' });
      expect((await body.control.read()).session.id).toBe(id); // borrowed body/engine remain healthy
    } finally {
      reply.resolve();
      await source.close();
      await main.close();
      registry.close();
      await body.close();
    }
  });
  it.each([
    'prepared_receipt',
    'history_acceptance',
    'history_receipt',
    'activation_publication',
    'activation_receipt',
    'queue_consumption',
    'consumed_receipt',
  ] as const)(
    'keeps queue/activation recovery after actual %s failure and owner replacement',
    async (point) => {
      const doc = await open();
      await doc.pushMessageQueue(queued('recover'));
      const item = (await doc.getMessageQueue())[0]!;
      const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
      let consumed = false;
      const fail = (phase: string) => {
        if (!consumed && phase === point) {
          consumed = true;
          throw new Error(`Synthetic ${point} failure`);
        }
      };
      const metadataWrite = repo.upsertDocMeta.bind(repo);
      repo.upsertDocMeta = async (...args) => {
        const result = await metadataWrite(...args);
        const patch = args[1] as {
          latestUserMsgId?: string;
          queuePromotionLedger?: Record<string, { state: string }>;
        };
        if (patch.latestUserMsgId === 'recover') fail('activation_publication');
        const state = patch.queuePromotionLedger?.['queue:recover']?.state;
        if (state)
          fail(
            (
              {
                prepared: 'prepared_receipt',
                history_accepted: 'history_receipt',
                activation_published: 'activation_receipt',
                queue_consumed: 'consumed_receipt',
              } as Record<string, string>
            )[state]!
          );
        return result;
      };
      const bodyWrite = client.applyDocPatch.bind(client);
      client.applyDocPatch = async (...args) => {
        const result = await bodyWrite(...args);
        if (args[2].some((op) => 'path' in op && op.path[0] === 'history'))
          fail('history_acceptance');
        if (args[2].some((op) => 'path' in op && op.path[0] === 'mq')) fail('queue_consumption');
        return result;
      };
      await expect(
        backend.promoteQueuedTurn({ operationId: 'queue:recover', item, entry: user('recover') })
      ).rejects.toThrow('Synthetic');
      expect(consumed).toBe(true);
      // Replace the exact document owner; history and independently persisted Meta
      // are the durable witnesses, never an in-memory "applied" flag.
      await doc.destroy({ preserveStatus: true });
      const restarted = await open();
      const next = await createSessionBackend(restarted, { historyBackend: 'loro' });
      await next.promoteQueuedTurn({ operationId: 'queue:recover', item, entry: user('recover') });
      expect((await next.readHistory()).filter((turn) => turn.id === 'recover')).toHaveLength(1);
      expect(await restarted.getMessageQueue()).toEqual([]);
      expect((await restarted.getMetaState())?.latestUserMsgId).toBe('recover');
      expect((await restarted.getMetaState())?.queuePromotionLedger?.['queue:recover']?.state).toBe(
        'queue_consumed'
      );
    }
  );
  it('opens missing legacy session/id read-only and publishes ACP config only for the latest matching user', async () => {
    const legacy = new LoroDoc();
    legacy.getList('history').push({ ...user('old'), futureField: { retained: true } });
    legacy.commit();
    await client.importRoomState(namespace, room, {
      snapshot: legacy.export({ mode: 'snapshot' }),
      enqueueOutbox: false,
    });
    legacy.free();
    const before = await client.inspectDocCausal(namespace, room);
    const doc = await open();
    expect((await doc.getDocState())?.session.id).toBe(id);
    expect((await client.inspectDocCausal(namespace, room)).version).toEqual(before.version);
    expect(
      await doc.applyAcpRuntimeConfigPatch('missing', { acpSessionId: 'runtime' as never })
    ).toBe(false);
    expect(
      await doc.applyAcpRuntimeConfigPatch('old', {
        acpSessionId: 'runtime' as never,
        modelId: 'model',
      })
    ).toBe(true);
    await doc.appendUserTurn(user('new'));
    expect(
      await doc.applyAcpRuntimeConfigPatch('old', {
        acpSessionId: 'runtime' as never,
        modelId: 'stale',
      })
    ).toBe(false);
    expect((await doc.getDocState())?.acpRuntimeConfig?.modelId).toBe('model');
    const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
    expect(await backend.readTurn('old')).toMatchObject({
      state: 'ready',
      turn: { futureField: { retained: true } },
    });
  });
});

localSessionAcceptance(
  'persistent native Session body selection and complete binary migration',
  () => {
    it('coordinates actual Meta, legacy CLI drain and all-window bodies, recovering archived sources and a creation receipt without author replay', async () => {
      const { randomUUID } = await import('node:crypto');
      const { DatabaseSync } = await import('node:sqlite');
      const { mkdir } = await import('node:fs/promises');
      const { build } = await import('esbuild');
      const { META_ROOM } = await import('@loro-dev/loro-repo-client');
      const { readEngineEndpoint } = await import('@loro-dev/loro-repo-client/node');
      const {
        NativeLocalSessionOwnerLegacy,
        readLocalNativeSessionRoute,
        readLocalNativeSessionMigration,
      } = await import('./native-session-owner');
      const { resolveLocalIndependentRepo } =
        await import('@lody/shared/node/native-repo-independent-paths');
      const { createNativeWorkspaceMeta } = await import('@lody/shared/node/native-workspace-meta');
      const { NativeLoroDocumentVerifierLegacy } =
        await import('@lody/shared/node/native-document-verification');
      const { NativeSessionMigrationMainLegacy } =
        await import('../../../electron/src/main/services/native-session-migration');
      const { workspaceMetaCommandSchema } = await import('@lody/shared/native-workspace-meta-ipc');
      const upsert = (docId: string, patch: Record<string, unknown>) => {
        const command = workspaceMetaCommandSchema.parse({ kind: 'upsert-doc', docId, patch });
        if (command.kind !== 'upsert-doc') throw new Error('Expected upsert');
        return command;
      };
      const { RendererSessionBodyMigrationMainLegacy } =
        await import('../../../electron/src/main/services/renderer-session-body-migration');
      const { SessionNativeBodyMigrationControlLegacy } =
        await import('./session-native-body-migration');
      const { LoroDocumentManager } = await import('@/lib/loro/doc');
      const { createNativeWorkspaceDirectory } =
        await import('@lody/shared/node/native-workspace-directory');
      const { WorkspaceCatalogSyncLegacy } =
        await import('@/lib/loro/workspace-catalog-sync-legacy');
      const { createCliSqliteRepoStore } = await import('@/lib/loro/sqlite-repo-store');
      const { readFrozenLegacySessionSqlite } =
        await import('@lody/shared/node/native-session-legacy-source');
      const { getLogger } = await import('@/utils/logger');
      const root = await mkdtemp(join(tmpdir(), 'lody-session-coordinator-'));
      const oldDataRoot = process.env.LODY_DATA_DIR;
      process.env.LODY_DATA_DIR = root;
      const failures: unknown[] = [];
      const cleanups: Array<() => Promise<unknown> | unknown> = [];
      cleanups.push(async () => {
        if (oldDataRoot === undefined) delete process.env.LODY_DATA_DIR;
        else process.env.LODY_DATA_DIR = oldDataRoot;
        if (!failures.length) await rm(root, { recursive: true, force: true });
      });
      try {
        const binding = {
          accountId: 'local:synthetic',
          workspaceId: 'lw_synthetic' as WorkspaceId,
          dataRoot: root,
        };
        const selected = resolveLocalIndependentRepo({ platform: 'local', ...binding });
        await mkdir(selected.directory, { recursive: true });
        const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
        if (!proof?.setValue) throw new Error('Verified SDK required');
        const engine = startEngine({ dataDir: selected.dataDir });
        cleanups.push(() => engine.stop());
        const client = await connectEngine(selected.dataDir, { autoReconnect: false });
        cleanups.push(() => client.close());
        const endpoint = await readEngineEndpoint(selected.dataDir);
        const owner = new NativeLocalSessionOwnerLegacy({
          ...binding,
          compatibility: proof,
          host: {
            client: async () => client,
            leaseInfo: async () => ({
              engineRunId: endpoint.runId,
              controlId: 'main-migration',
              sdkArtifactId: proof.artifactId,
              pid: process.pid,
              clientGeneration: endpoint.runId,
            }),
            close: async () => {},
          },
          writer: 'main-coordinator',
          closeTimeoutMs: 1000,
          editingLeaseMs: 30000,
          now: () => 1234,
          onBackgroundFailure: (error) => {
            throw error;
          },
        });
        cleanups.push(() => owner.close());
        await client.createRoom(binding.workspaceId, META_ROOM);
        const metadata = createNativeWorkspaceMeta({
          binding,
          generation: 'coordinator-meta',
          client,
          sdkCompatibility: proof,
          sdkArtifactId: proof.artifactId,
          assertCurrent() {},
        });
        cleanups.push(() => metadata.close());
        let managerOwnsStore = false;
        const store = await createCliSqliteRepoStore(
          binding.workspaceId,
          undefined,
          join(root, 'classic')
        );
        cleanups.push(() => (managerOwnsStore ? undefined : store.sqliteStore.close()));
        const namedFactory = Reflect.get(LoroRepo, 'createWithExternalMetadata');
        if (typeof namedFactory !== 'function') throw new Error('External Metadata SDK required');
        const legacyRepo = (await Reflect.apply(namedFactory, LoroRepo, [
          { storageAdapter: store.storageAdapter },
          metadata.externalMetadata,
        ])) as LoroRepo;
        cleanups.push(() => (managerOwnsStore ? undefined : legacyRepo.destroy()));
        const directoryClient = await connectEngine(selected.dataDir, { autoReconnect: false });
        cleanups.push(() => directoryClient.close());
        const directory = createNativeWorkspaceDirectory({
          namespace: binding.workspaceId,
          getClient: async () => directoryClient,
          sdkCompatibility: proof,
          getClientArtifactId: async () => proof.artifactId,
          assertAccess: () => metadata.assertCurrent(),
          authority: {
            get: () => ({ synced: true, generation: metadata.generation }),
            subscribe: () => () => {},
          },
        });
        cleanups.push(() => directory.close());
        await directory.listEntries();
        const catalogLogs: unknown[][] = [];
        const logger: import('@/utils/logger').Logger = {
          ...getLogger('session-coordinator'),
          debug: (...args) => {
            catalogLogs.push(args);
          },
        };
        const manager = new LoroDocumentManager({
          workspaceDirectory: directory,
          // The test borrows these actual Node ports; their original close
          // owners remain separately registered above this manager facade.
          nativeWorkspaceMetaOwner: {
            metadata,
            directory,
            externalMetadata: metadata.externalMetadata,
            close: async () => {},
          } as never,
          repo: legacyRepo,
          userId: binding.accountId,
          workspaceId: binding.workspaceId,
          metaSub: null,
          sqliteRepoStore: store,
          logger,
        });
        managerOwnsStore = true;
        cleanups.push(() => manager.cleanUp({ preserveSessionStatus: true }));
        const catalog = new WorkspaceCatalogSyncLegacy(
          legacyRepo,
          binding.workspaceId,
          logger,
          false,
          true,
          true
        );
        cleanups.push(() => catalog.close());
        expect(await catalog.ready(undefined, 0)).toBe(false);
        expect(await manager.catalogBaselineReady(undefined, 0)).toBe(true);
        expect(!manager.isTransportRecovering()).toBe(true);
        expect(manager.isTransportConnected()).toBe(false);
        expect(manager.hasCompletedInitialMetaSync()).toBe(false);
        await expect(legacyRepo.joinMetaRoom()).rejects.toThrow('external metadata mode');
        expect(
          catalogLogs.some((args) =>
            String(args[0]).includes('Catalog reader acquisition/baseline/cleanup failed')
          )
        ).toBe(false);

        const sessionId = randomUUID() as SessionId,
          roomId = `session-${sessionId}`;
        await metadata.externalMetadata.commit({
          kind: 'upsert-doc',
          docId: roomId,
          patch: {
            id: sessionId,
            userId: binding.accountId,
            machineId: 'machine',
            historyBackend: 'loro',
            status: { type: 'idle' },
          },
        });
        const raw = await legacyRepo.openPersistedDoc(roomId);
        raw.doc.getMap('unknown').set('kept', { bytes: new Uint8Array([255, 0]), future: true });
        raw.doc.getList('history').push(user('cli-retained'));
        raw.doc.commit();
        const capturedText = raw.doc.getText('future');
        capturedText.insert(0, 'Accepted before migration');
        raw.doc.commit();
        const renderer = new LoroDoc();
        renderer.getList('history').push(user('renderer-retained'));
        renderer.commit();
        const rendererSnapshot = renderer.export({ mode: 'snapshot' });
        renderer.free();
        const baseName = `lody-loro-repo-db-${binding.workspaceId}`;
        const databases = new Map<string, Map<string, Uint8Array>>([
          [baseName, new Map([[sessionId, rendererSnapshot]])],
          [`${baseName}:empty`, new Map()],
        ]);
        let registrationId = randomUUID(),
          windowController!: InstanceType<typeof RendererSessionBodyMigrationMainLegacy>;
        const held = new Set<SessionId>();
        let busy = false,
          publicationBlocked = false;
        let loseBeforeReservation: string | undefined, disabledControlFor: string | undefined;
        const control = new SessionNativeBodyMigrationControlLegacy({
          accountId: binding.accountId,
          workspaceId: binding.workspaceId,
          generation: () => manager.getSessionBodyMigrationGeneration(),
          unavailable: () => false,
          tryBarrier: (id) => {
            if (held.has(id)) return null;
            held.add(id);
            return () => held.delete(id);
          },
          snapshot: () =>
            ({
              hasActiveTurn: busy,
              hasBlockingPendingCreate: false,
              releaseBlocked: false,
            }) as never,
          pending: () => null,
          cached: () => null,
          retire: async () => {},
          flush: async () => {},
          freeze: (id, nonce, phase) => manager.freezeLegacySessionForNative(id, nonce, phase),
          route: (id) => readLocalNativeSessionRoute(binding, `session-${id}`),
        });
        cleanups.push(() => control.close());
        const makeWindows = () => {
          windowController = new RendererSessionBodyMigrationMainLegacy({
            binding: {
              accountId: binding.accountId,
              workspaceId: binding.workspaceId,
              contentMode: 'plaintext',
            },
            databasePath: join(root, 'window-fences.sqlite3'),
            registeredWindowIds: () => [1],
            admit: (window, registration) => {
              if (window !== 1 || registration !== registrationId)
                throw new Error('Retired window');
            },
            readCommittedOwner: (id) => readLocalNativeSessionRoute(binding, `session-${id}`),
            send: (_window, request) => {
              if (request.phase === 'publish' && publicationBlocked)
                throw new Error('Publication IPC unavailable');
              const names = [...databases.keys()].sort();
              const sources = names.map((dbName) => {
                const snapshot = databases.get(dbName)!.get(request.sessionId);
                return {
                  dbName,
                  sourceId: `renderer-idb:loro-doc-layout4:${dbName}`,
                  present: !!snapshot,
                  snapshot: snapshot ?? new Uint8Array(),
                };
              });
              windowController.acknowledge(1, {
                ...request,
                ...(request.phase === 'enumerate'
                  ? { databases: sources.map(({ dbName, sourceId }) => ({ dbName, sourceId })) }
                  : request.phase === 'capture'
                    ? { sources }
                    : {}),
              });
            },
          });
          windowController.register(1, registrationId);
          windowController.ready(1, registrationId);
          return windowController;
        };
        makeWindows();
        cleanups.push(() => windowController.close());
        const cache = join(import.meta.dirname, '../../node_modules/.cache');
        await mkdir(cache, { recursive: true });
        const compiled = await mkdtemp(join(cache, 'session-verifier-'));
        cleanups.push(() =>
          failures.length ? undefined : rm(compiled, { recursive: true, force: true })
        );
        await build({
          entryPoints: {
            'native-repo-independent-host': join(
              import.meta.dirname,
              '../lib/loro/native-repo-independent-host-entry.ts'
            ),
            'native-repo-independent-engine': join(
              import.meta.dirname,
              '../lib/loro/native-repo-independent-engine-entry.ts'
            ),
          },
          outdir: compiled,
          bundle: true,
          platform: 'node',
          format: 'esm',
          banner: {
            js: "import { createRequire as __req } from 'node:module'; const require = __req(import.meta.url);",
          },
          plugins: [
            {
              name: 'shared-host-source',
              setup(builder) {
                builder.onResolve({ filter: /^@lody\/shared\/node\// }, (args) => ({
                  path: join(
                    import.meta.dirname,
                    '../../../../packages/shared/src/node',
                    `${args.path.split('/').at(-1)}.ts`
                  ),
                }));
              },
            },
          ],
        });
        const verifier = new NativeLoroDocumentVerifierLegacy({
          directory: join(root, 'verification'),
          compatibility: proof,
          launch: {
            executable: process.execPath,
            entry: join(compiled, 'native-repo-independent-host.js'),
          },
        });
        cleanups.push(() => verifier.close());
        const resolve = async (window: number, registration: string) => {
          if (window !== 1 || registration !== registrationId)
            throw new Error('Retired product frame');
          const expected = registrationId;
          return {
            ...binding,
            machineId: 'machine',
            metadata,
            owner,
            windows: windowController,
            assertCurrent() {
              if (expected !== registrationId) throw new Error('Retired product frame');
            },
            control: async (
              request: import('@lody/shared/native-session-body-control').NativeSessionBodyFreezeRequest
            ) => {
              if (request.sessionId === disabledControlFor)
                throw new Error('CLI intentionally unavailable for Roost');
              const reply = await control.handle(request);
              if (request.phase === 'freeze' && request.sessionId === loseBeforeReservation) {
                loseBeforeReservation = undefined;
                throw new Error('Capture reply lost before reservation');
              }
              return reply.ok && (reply.phase === 'freeze' || reply.phase === 'assert')
                ? {
                    ...reply,
                    snapshot: readFrozenLegacySessionSqlite({
                      path: store.dbPath,
                      workspaceId: binding.workspaceId,
                      sessionId: request.sessionId,
                    }).snapshot,
                  }
                : reply;
            },
          };
        };
        const makeCoordinator = () =>
          new NativeSessionMigrationMainLegacy({
            resolve,
            verifyState: async (_scope, input) => {
              await verifier.verify(input);
            },
          });
        let coordinator = makeCoordinator();
        cleanups.push(() => coordinator.close());
        const importState = client.importRoomState.bind(client);
        let lose = true;
        busy = true;
        await coordinator.ensureMigrated(1, registrationId, sessionId);
        expect(readLocalNativeSessionRoute(binding, roomId)).toBe('legacy');
        capturedText.insert(0, 'Still writable while busy. ');
        raw.doc.commit();
        busy = false;
        client.importRoomState = async (...args) => {
          const result = await importState(...args);
          if (lose && args[1].id === roomId) {
            lose = false;
            throw new Error('Lost import ACK');
          }
          return result;
        };
        await expect(coordinator.ensureMigrated(1, registrationId, sessionId)).rejects.toThrow(
          'Lost import ACK'
        );
        expect(readLocalNativeSessionRoute(binding, roomId)).toBe('frozen');
        expect(() => capturedText.insert(0, 'late')).toThrow();
        expect(held.has(sessionId)).toBe(true);
        const manifest = readLocalNativeSessionMigration(binding, roomId)!.manifest;
        expect(
          (await owner.readArchivedSources(sessionId))?.map((source) => source.sourceId).sort()
        ).toEqual([...manifest.sourceIds].sort());
        client.importRoomState = importState;
        await coordinator.close();
        await windowController.close();
        registrationId = randomUUID();
        makeWindows();
        coordinator = makeCoordinator();
        const newDb = `${baseName}:new-profile`;
        databases.set(newDb, new Map([[sessionId, rendererSnapshot]]));
        await expect(coordinator.ensureMigrated(1, registrationId, sessionId)).rejects.toThrow(
          'unarchived'
        );
        expect(readLocalNativeSessionRoute(binding, roomId)).toBe('frozen');
        databases.set(newDb, new Map());
        publicationBlocked = true;
        await expect(coordinator.ensureMigrated(1, registrationId, sessionId)).rejects.toThrow(
          'Publication IPC unavailable'
        );
        expect(readLocalNativeSessionRoute(binding, roomId)).toBe('native');
        expect(held.has(sessionId)).toBe(true);
        const publishedHead = await client.inspectDocCausal(binding.workspaceId, {
          kind: 'loro_doc',
          id: roomId,
        });
        publicationBlocked = false;
        await coordinator.ensureMigrated(1, registrationId, sessionId);
        expect(
          (await client.inspectDocCausal(binding.workspaceId, { kind: 'loro_doc', id: roomId }))
            .version
        ).toEqual(publishedHead.version);
        expect(held.has(sessionId)).toBe(false);
        expect(readLocalNativeSessionMigration(binding, roomId)!.manifest).toEqual(manifest);
        publicationBlocked = true;
        await coordinator.ensureMigrated(1, registrationId, sessionId);
        publicationBlocked = false;
        const exported = LoroDoc.fromSnapshot(
          (await client.exportLoroRaw(binding.workspaceId, { kind: 'loro_doc', id: roomId })).bytes
        );
        try {
          expect(exported.getMap('unknown').get('kept')).toEqual({
            bytes: new Uint8Array([255, 0]),
            future: true,
          });
          expect(exported.getList('history').length).toBe(2);
        } finally {
          exported.free();
        }
        const archivedFull = (await owner.readArchivedSources(sessionId))!;
        const archivedPresent = archivedFull.find((value) => value.present !== false)!;
        const archiveDb = new DatabaseSync(join(selected.directory, 'session-routes.sqlite3'));
        try {
          archiveDb
            .prepare(
              'UPDATE native_loro_document_migration_sources SET bytes=? WHERE source_id=? AND room_id=?'
            )
            .run(new Uint8Array([1, 2, 3]), archivedPresent.sourceId, roomId);
          await expect(owner.readArchivedSources(sessionId)).rejects.toThrow('corrupt');
          expect(
            (await client.inspectDocCausal(binding.workspaceId, { kind: 'loro_doc', id: roomId }))
              .version
          ).toEqual(publishedHead.version);
          archiveDb
            .prepare(
              'UPDATE native_loro_document_migration_sources SET bytes=? WHERE source_id=? AND room_id=?'
            )
            .run(archivedPresent.bytes, archivedPresent.sourceId, roomId);
          expect(
            (await owner.readArchivedSources(sessionId))?.map((value) => value.sourceId).sort()
          ).toEqual([...manifest.sourceIds].sort());
        } finally {
          archiveDb.close();
        }
        const createdId = randomUUID(),
          createdRoom = `session-${createdId}`,
          patch = {
            id: createdId,
            userId: binding.accountId,
            machineId: 'machine',
            createdAt: '2026-11-18T00:00:00Z',
            cliType: 'acp',
            agentType: 'codex',
            historyBackend: 'loro',
            status: { type: 'idle' },
            title: 'Original title',
          };
        const apply = client.applyDocPatch.bind(client);
        let loseBody = true;
        client.applyDocPatch = async (...args) => {
          const value = await apply(...args);
          if (loseBody && args[1].id === createdRoom) {
            loseBody = false;
            throw new Error('Lost create-body ACK');
          }
          return value;
        };
        await expect(
          coordinator.createSession(1, registrationId, upsert(createdRoom, patch), () => {})
        ).rejects.toThrow('Lost create-body ACK');
        client.applyDocPatch = apply;
        const bodyHead = await client.inspectDocCausal(binding.workspaceId, {
          kind: 'loro_doc',
          id: createdRoom,
        });
        await metadata.document(createdRoom).patch({ title: 'Changed after receipt' });
        databases.set(`${baseName}:after-created`, new Map());
        await coordinator.ensureMigrated(1, registrationId, createdId);
        expect((await metadata.document(createdRoom).read())?.title).toBe('Changed after receipt');
        expect(
          (
            await client.inspectDocCausal(binding.workspaceId, {
              kind: 'loro_doc',
              id: createdRoom,
            })
          ).version
        ).toEqual(bodyHead.version);
        expect(held.has(createdId as SessionId)).toBe(false);
        const interrupted = randomUUID(),
          interruptedRoom = `session-${interrupted}`,
          interruptedCommand = upsert(interruptedRoom, { ...patch, id: interrupted });
        loseBeforeReservation = interrupted;
        await expect(
          coordinator.createSession(1, registrationId, interruptedCommand, () => {})
        ).rejects.toMatchObject({ code: 'not_committed' });
        expect(readLocalNativeSessionRoute(binding, interruptedRoom)).toBe('frozen');
        expect((await metadata.readDocumentCreationState(interruptedRoom)).pristine).toBe(true);
        await expect(
          coordinator.createSession(1, registrationId, interruptedCommand, () => {})
        ).rejects.toThrow();
        expect((await metadata.readDocumentCreationState(interruptedRoom)).pristine).toBe(true);
        expect(readLocalNativeSessionRoute(binding, interruptedRoom)).toBe('frozen');

        const roostId = randomUUID(),
          roostRoom = `session-${roostId}`;
        disabledControlFor = roostId;
        await coordinator.createSession(
          1,
          registrationId,
          upsert(roostRoom, { ...patch, id: roostId, historyBackend: 'roost' }),
          () => {}
        );
        await coordinator.ensureMigrated(1, registrationId, roostId);
        expect((await metadata.document(roostRoom).read())?.historyBackend).toBe('roost');
        expect(readLocalNativeSessionMigration(binding, roostRoom)).toBeUndefined();
        expect(
          readFrozenLegacySessionSqlite({
            path: store.dbPath,
            workspaceId: binding.workspaceId,
            sessionId: roostId,
          }).present
        ).toBe(false);
        // The actual CLI document-drain producer admits creation from pristine
        // complete Meta state, not from a missing projected value or tombstone.
        await manager.registerMachine('machine' as import('@lody/shared').MachineId, {
          name: 'Synthetic machine',
        });
        const { documentDomainMigrationScope } =
          await import('@lody/shared/renderer-document-domain-migration');
        const scheduleScope = documentDomainMigrationScope({
          domain: 'schedule_definition',
          id: randomUUID(),
        });
        const creationNonce = randomUUID();
        const createRequest = {
          accountId: binding.accountId,
          workspaceId: binding.workspaceId,
          scope: scheduleScope,
          nonce: creationNonce,
          purpose: 'create' as const,
          phase: 'prepare' as const,
        };
        expect(
          await manager.handleNativeDocumentDomainMigrationControl(createRequest)
        ).toMatchObject({ ok: true, prepared: true, purpose: 'create' });
        expect(
          (await metadata.readDocumentCreationState(scheduleScope.metadataDocId)).pristine
        ).toBe(true);
        expect(
          await manager.handleNativeDocumentDomainMigrationControl({
            ...createRequest,
            phase: 'abort',
          })
        ).toMatchObject({ ok: true, released: true });
        expect(
          await manager.handleNativeDocumentDomainMigrationControl({
            ...createRequest,
            purpose: undefined,
          })
        ).toMatchObject({ ok: false });
        await metadata.externalMetadata.commit({
          kind: 'upsert-doc',
          docId: scheduleScope.metadataDocId,
          patch: {
            id: scheduleScope.id,
            userId: binding.accountId,
            machineId: 'machine',
            nativeDocumentCreation: {
              version: 1,
              family: scheduleScope.domain,
              reservationId: creationNonce,
              creationIntentSha256: 'a'.repeat(64),
            },
          },
        });
        expect(
          await manager.handleNativeDocumentDomainMigrationControl({
            ...createRequest,
            nonce: randomUUID(),
          })
        ).toMatchObject({ ok: false });
        expect(
          await manager.handleNativeDocumentDomainMigrationControl(createRequest)
        ).toMatchObject({ ok: true, prepared: true });
        expect(
          await manager.handleNativeDocumentDomainMigrationControl({
            ...createRequest,
            phase: 'abort',
          })
        ).toMatchObject({ ok: true, released: true });
        await metadata.externalMetadata.commit({
          kind: 'delete-doc',
          docId: scheduleScope.metadataDocId,
        });
        expect(
          await manager.handleNativeDocumentDomainMigrationControl(createRequest)
        ).toMatchObject({ ok: false });
        expect(
          (await metadata.readDocumentCreationState(scheduleScope.metadataDocId)).pristine
        ).toBe(false);
        const previewScope = documentDomainMigrationScope({
          domain: 'preview_comments',
          id: roostId,
        });
        const previewRequest = { ...createRequest, scope: previewScope, nonce: randomUUID() };
        expect(
          await manager.handleNativeDocumentDomainMigrationControl(previewRequest)
        ).toMatchObject({ ok: true, prepared: true });
        expect(
          await manager.handleNativeDocumentDomainMigrationControl({
            ...previewRequest,
            phase: 'abort',
          })
        ).toMatchObject({ ok: true, released: true });
        await metadata.document(roostRoom).patch({ machineId: 'foreign-machine' });
        expect(
          await manager.handleNativeDocumentDomainMigrationControl(previewRequest)
        ).toMatchObject({ ok: false });
        await metadata.document(roostRoom).patch({ machineId: 'machine' });
        const oldGeneration = metadata.generation;
        Reflect.set(metadata, 'generation', 'replacement-generation');
        expect(manager.isTransportRecovering()).toBe(true);
        expect(await manager.catalogBaselineReady(undefined, 0)).toBe(false);
        Reflect.set(metadata, 'generation', oldGeneration);
        expect(manager.isTransportRecovering()).toBe(true);
        await directoryClient.close();
        expect(manager.isTransportRecovering()).toBe(true);
        expect(await manager.catalogBaselineReady(undefined, 0)).toBe(false);
      } finally {
        for (const cleanup of cleanups.reverse()) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw new AggregateError(failures, 'Coordinator test resources remain owned');
      }
    });
    it('reserves actual native Meta once, reconciles lost typed-body acknowledgement without replay, and survives a new engine process', async () => {
      const { randomUUID } = await import('node:crypto');
      const { mkdir } = await import('node:fs/promises');
      const { META_ROOM } = await import('@loro-dev/loro-repo-client');
      const { readEngineEndpoint } = await import('@loro-dev/loro-repo-client/node');
      const {
        NativeLocalSessionOwnerLegacy,
        readLocalNativeSessionRoute,
        readLocalNativeSessionMigration,
      } = await import('./native-session-owner');
      const { resolveLocalIndependentRepo } =
        await import('@lody/shared/node/native-repo-independent-paths');
      const { createNativeWorkspaceMeta } = await import('@lody/shared/node/native-workspace-meta');
      const {
        reserveNativeSessionMetadata,
        calculateNativeSessionCreationIntentSha256,
        assertNativeSessionMetadataReservation,
      } = await import('@lody/shared/node/native-session-meta-reservation');
      const { readFrozenLegacySessionSqlite } =
        await import('@lody/shared/node/native-session-legacy-source');
      const root = await mkdtemp(join(tmpdir(), 'lody-session-create-'));
      const binding = {
        accountId: 'local:synthetic',
        workspaceId: 'lw_synthetic' as WorkspaceId,
        dataRoot: root,
      };
      const selected = resolveLocalIndependentRepo({ platform: 'local', ...binding });
      await mkdir(selected.directory, { recursive: true });
      const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
      if (!proof?.setValue) throw new Error('Verified SDK required');
      let engine = startEngine({ dataDir: selected.dataDir });
      let client = await connectEngine(selected.dataDir, { autoReconnect: false });
      const make = async () => {
        const endpoint = await readEngineEndpoint(selected.dataDir);
        return new NativeLocalSessionOwnerLegacy({
          ...binding,
          compatibility: proof,
          host: {
            client: async () => client,
            leaseInfo: async () => ({
              engineRunId: endpoint.runId,
              controlId: 'create-test',
              sdkArtifactId: proof.artifactId,
              pid: process.pid,
              clientGeneration: endpoint.runId,
            }),
            close: async () => {},
          },
          writer: 'create-test',
          closeTimeoutMs: 1000,
          editingLeaseMs: 30000,
          now: () => 1234,
          onBackgroundFailure: (error) => {
            throw error;
          },
        });
      };
      let owner = await make();
      await client.createRoom(binding.workspaceId, META_ROOM);
      const metadata = createNativeWorkspaceMeta({
        binding,
        generation: 'create-meta',
        client,
        sdkCompatibility: proof,
        sdkArtifactId: proof.artifactId,
        assertCurrent() {},
      });
      const sessionId = randomUUID() as SessionId,
        reservationId = randomUUID();
      const patch = {
        id: sessionId,
        userId: binding.accountId,
        machineId: 'machine',
        createdAt: '2026-11-18T00:00:00Z',
        cliType: 'acp',
        agentType: 'codex',
        historyBackend: 'loro',
        status: { type: 'idle' },
        title: 'Original creation',
      };
      const creationIntentSha256 = calculateNativeSessionCreationIntentSha256({
        binding,
        sessionId,
        patch,
      });
      const input = { sessionId, reservationId, creationIntentSha256 };
      const absence = () => ({
        sources: [
          readFrozenLegacySessionSqlite({
            path: join(root, 'absent-old.sqlite3'),
            workspaceId: binding.workspaceId,
            sessionId,
          }),
        ],
        assertCurrent() {
          expect(readLocalNativeSessionRoute(binding, `session-${sessionId}`)).toBe('frozen');
        },
      });
      const reservation = reserveNativeSessionMetadata({
        owner: metadata,
        ...input,
        patch,
        actorId: binding.accountId,
        machineId: 'machine',
        assertCurrent() {},
        absenceWitness: absence,
      });
      const apply = client.applyDocPatch.bind(client);
      let lose = true;
      client.applyDocPatch = async (...args) => {
        const reply = await apply(...args);
        if (lose && args[1].id === `session-${sessionId}`) {
          lose = false;
          throw new Error('Lost typed body ACK');
        }
        return reply;
      };
      try {
        await expect(
          owner.createNew(input, { ...reservation, drainLegacy: async () => absence() })
        ).rejects.toThrow('Lost typed body ACK');
        expect(readLocalNativeSessionRoute(binding, `session-${sessionId}`)).toBe('frozen');
        expect(await metadata.document(`session-${sessionId}`).read()).toMatchObject({
          title: 'Original creation',
          nativeSessionCreation: { reservationId },
        });
        const before = await client.inspectDocCausal(binding.workspaceId, {
          kind: 'loro_doc',
          id: `session-${sessionId}`,
        });
        const metaBefore = await client.flockGet(binding.workspaceId, META_ROOM, [
          'e',
          `session-${sessionId}`,
        ]);
        client.applyDocPatch = apply;
        await owner.createNew(input, { ...reservation, drainLegacy: async () => absence() });
        expect(readLocalNativeSessionRoute(binding, `session-${sessionId}`)).toBe('native');
        expect(
          (
            await client.inspectDocCausal(binding.workspaceId, {
              kind: 'loro_doc',
              id: `session-${sessionId}`,
            })
          ).version
        ).toEqual(before.version);
        expect(
          (await client.flockGet(binding.workspaceId, META_ROOM, ['e', `session-${sessionId}`]))
            .roomTxId
        ).toBe(metaBefore.roomTxId);
        await metadata.document(`session-${sessionId}`).patch({ title: 'Later edited title' });
        const stableGeneration = owner.targetGeneration;
        await metadata.close();
        await owner.close();
        await client.close();
        engine.stop();
        engine = startEngine({ dataDir: selected.dataDir });
        client = await connectEngine(selected.dataDir, { autoReconnect: false });
        owner = await make();
        expect(owner.targetGeneration).toBe(stableGeneration);
        expect(readLocalNativeSessionMigration(binding, `session-${sessionId}`)).toMatchObject({
          stage: 'native',
          manifest: {
            migrationId: reservationId,
            origin: 'created',
            creationIntentSha256,
            targetGeneration: stableGeneration,
            sourceIds: [],
          },
        });
        const recovered = createNativeWorkspaceMeta({
          binding,
          generation: 'new-process-meta',
          client,
          sdkCompatibility: proof,
          sdkArtifactId: proof.artifactId,
          assertCurrent() {},
        });
        try {
          await owner.createNew(input, {
            drainLegacy: async () => {
              throw new Error('Published restart must not redrain');
            },
            reserveMetadata: async () => {
              throw new Error('Published restart must not reauthor');
            },
            assertReservation: () =>
              assertNativeSessionMetadataReservation({
                owner: recovered,
                ...input,
                actorId: binding.accountId,
                machineId: 'machine',
                assertCurrent() {},
              }),
          });
          expect((await recovered.document(`session-${sessionId}`).read())?.title).toBe(
            'Later edited title'
          );
          const meta = recovered.document(`session-${sessionId}`);
          const facet: import('@lody/shared/node/native-session-document').NativeSessionMetadataPort =
            {
              read: async () =>
                (await meta.read()) as import('@lody/shared').SessionMeta | undefined,
              patch: (fields) => meta.patch(fields),
              flush: () => meta.flush(),
              update: (transform) =>
                meta.update((current) => transform(current as import('@lody/shared').SessionMeta)),
            };
          const body = await owner.factory(sessionId, facet, { historyBackend: 'loro' });
          if (!body) throw new Error('Native new body missing');
          await body.initialize(undefined, { skipAutoRead: true, remoteSync: false });
          await body.backend.appendUserTurn(user('first-created-turn'));
          expect(await body.backend.readHistory()).toHaveLength(1);
        } finally {
          await recovered.close();
        }
      } finally {
        await metadata.close();
        await owner.close();
        await client.close();
        engine.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
    it('freezes before draining, imports all control/history/unknown state, survives owner replacement, and rolls back only persisted exact state', async () => {
      const { NativeLocalSessionOwnerLegacy, readLocalNativeSessionRoute } =
        await import('./native-session-owner');
      const { resolveLocalIndependentRepo } =
        await import('@lody/shared/node/native-repo-independent-paths');
      const { readEngineEndpoint } = await import('@loro-dev/loro-repo-client/node');
      const { LoroMap, LoroText } = await import('loro-crdt');
      const root = await mkdtemp(join(tmpdir(), 'lody-session-routes-'));
      const binding = {
        accountId: 'local:synthetic',
        workspaceId: 'lw_synthetic' as WorkspaceId,
        dataRoot: root,
      };
      const selected = resolveLocalIndependentRepo({ platform: 'local', ...binding });
      const { mkdir } = await import('node:fs/promises');
      await mkdir(selected.directory, { recursive: true });
      const engine = startEngine({ dataDir: selected.dataDir });
      const clients: RepoClient[] = [];
      const owners: InstanceType<typeof NativeLocalSessionOwnerLegacy>[] = [];
      const docs: LoroDoc[] = [];
      const metadata = await LoroRepo.create({});
      try {
        const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
        if (!proof?.setValue) throw new Error('Pinned local SDK required');
        const endpoint = await readEngineEndpoint(selected.dataDir);
        const make = async () => {
          const client = await connectEngine(selected.dataDir, { autoReconnect: false });
          clients.push(client);
          const owner = new NativeLocalSessionOwnerLegacy({
            ...binding,
            compatibility: proof,
            host: {
              client: async () => client,
              leaseInfo: async () => ({
                engineRunId: endpoint.runId,
                controlId: 'synthetic-scope',
                sdkArtifactId: proof.artifactId,
                pid: process.pid,
                clientGeneration: 'synthetic-client',
              }),
              close: () => client.close(),
            },
            writer: 'native-test',
            closeTimeoutMs: 1000,
            editingLeaseMs: 30000,
            now: () => 1234,
            onBackgroundFailure: (error) => {
              throw error;
            },
          });
          owners.push(owner);
          return { owner, client };
        };
        const { owner, client } = await make();
        const meta = {
          read: async () => undefined,
          patch: async () => {},
          flush: () => metadata.flush(),
        };
        expect(await owner.factory(id, meta, { historyBackend: 'loro' })).toBeUndefined();
        expect(readLocalNativeSessionRoute(binding, room.id)).toBe('legacy');
        const legacy = new LoroDoc();
        docs.push(legacy);
        legacy.getMap('session').set('id', id);
        legacy.getMap('humanInputReceipts').set('old-input', { userId: 'synthetic-human' });
        legacy.getMap('futureRoot').set('opaque', { preserved: true });
        const row = legacy.getList('history').pushContainer(new LoroMap());
        row.set('id', 'old-input');
        row.set('role', 'user');
        row.set('timestamp', 'synthetic');
        row.setContainer('status', new LoroText()).insert(0, 'pending');
        row.set('items', [{ type: 'future-item', opaque: { preserved: true } }]);
        legacy
          .getList('history')
          .push({ ...user('inline'), futureField: { kept: true }, $cid: 'literal-cid' });
        legacy.commit();
        let saved = legacy.export({ mode: 'snapshot' });
        await owner.migrate(
          {
            sessionId: id,
            migrationId: 'synthetic-full-session',
            sourceIds: ['daemon-old', 'renderer-old'],
            historyBackend: 'loro',
          },
          {
            drainLegacy: async () => {
              expect(readLocalNativeSessionRoute(binding, room.id)).toBe('frozen');
              await expect(owner.factory(id, meta, { historyBackend: 'loro' })).rejects.toThrow(
                'migration/restart'
              );
              return [
                { sourceId: 'daemon-old', bytes: saved },
                { sourceId: 'renderer-old', bytes: saved },
              ];
            },
          }
        );
        expect(readLocalNativeSessionRoute(binding, room.id)).toBe('native');
        const migrated = new LoroDoc();
        docs.push(migrated);
        migrated.import((await client.exportLoroRaw(binding.workspaceId, room)).bytes);
        expect(migrated.toJSON().futureRoot).toEqual({ opaque: { preserved: true } });
        expect(migrated.getList('history').get(0)).toBeInstanceOf(LoroMap);
        expect(
          (migrated.getList('history').get(0) as InstanceType<typeof LoroMap>).get('status')
        ).toBeInstanceOf(LoroText);
        expect(migrated.getList('history').get(1)).toMatchObject({
          $cid: 'literal-cid',
          futureField: { kept: true },
        });
        await owner.close();
        const restarted = await make();
        const open = await restarted.owner.factory(id, meta, { historyBackend: 'loro' });
        if (!open) throw new Error('Persisted native route disappeared');
        await open.initialize(undefined, { skipAutoRead: true, remoteSync: false });
        await open.backend.appendUserTurn(user('after-migration'));
        const siblingId = 'independent-sibling' as SessionId;
        const siblingLegacy = new LoroDoc();
        docs.push(siblingLegacy);
        siblingLegacy.getMap('session').set('id', siblingId);
        siblingLegacy.commit();
        await restarted.owner.migrate(
          {
            sessionId: siblingId,
            migrationId: 'sibling-room',
            sourceIds: ['sibling-old', 'sibling-absent'],
            historyBackend: 'loro',
          },
          {
            drainLegacy: async () => [
              { sourceId: 'sibling-old', bytes: siblingLegacy.export({ mode: 'snapshot' }) },
              { sourceId: 'sibling-absent', present: false, bytes: new Uint8Array() },
            ],
          }
        );
        await expect(
          restarted.owner.migrate(
            {
              sessionId: 'unproven-empty' as SessionId,
              migrationId: 'empty-is-not-proof',
              sourceIds: ['unproven'],
              historyBackend: 'loro',
            },
            { drainLegacy: async () => [{ sourceId: 'unproven', bytes: new Uint8Array() }] }
          )
        ).rejects.toThrow('inventory is incomplete');
        await expect(
          restarted.owner.migrate(
            {
              sessionId: 'all-absent' as SessionId,
              migrationId: 'absence-is-not-existing',
              sourceIds: ['missing'],
              historyBackend: 'loro',
            },
            {
              drainLegacy: async () => [
                { sourceId: 'missing', present: false, bytes: new Uint8Array() },
              ],
            }
          )
        ).rejects.toThrow('requires a real body');
        const sibling = await restarted.owner.factory(siblingId, meta, { historyBackend: 'loro' });
        if (!sibling) throw new Error('Sibling native route missing');
        await sibling.initialize(undefined, { skipAutoRead: true, remoteSync: false });
        await sibling.backend.appendUserTurn(user('sibling-before-rollback'));
        const manifest = {
          migrationId: 'synthetic-full-session',
          binding: JSON.stringify([binding.accountId, binding.workspaceId]),
          namespace: binding.workspaceId,
          roomId: room.id,
          family: 'session' as const,
          targetGeneration: restarted.owner.targetGeneration,
          sourceIds: ['daemon-old', 'renderer-old'],
        };
        await expect(
          restarted.owner.rollback(manifest, {
            drainNative: async () => {},
            mergeAndFlushLegacy: async () => [
              { sourceId: 'daemon-old', bytes: saved },
              { sourceId: 'renderer-old', bytes: saved },
            ],
          })
        ).rejects.toThrow('exact native');
        expect(readLocalNativeSessionRoute(binding, room.id)).toBe('frozen');
        await restarted.owner.rollback(manifest, {
          drainNative: async () => {},
          mergeAndFlushLegacy: async (raw) => {
            legacy.import(raw);
            saved = legacy.export({ mode: 'snapshot' });
            // Model the real persisted-byte receipt: write then re-read the actual old
            // owner files. Returning a live merged LoroDoc is not rollback proof.
            const { writeFile, readFile } = await import('node:fs/promises');
            await Promise.all(
              ['daemon-old', 'renderer-old'].map((source) => writeFile(join(root, source), saved))
            );
            return Promise.all(
              ['daemon-old', 'renderer-old'].map(async (sourceId) => ({
                sourceId,
                bytes: await readFile(join(root, sourceId)),
              }))
            );
          },
        });
        expect(readLocalNativeSessionRoute(binding, room.id)).toBe('legacy');
        expect(legacy.getList('history').length).toBe(3);
        await sibling.backend.appendUserTurn(user('sibling-after-rollback'));
        expect((await sibling.backend.readHistory()).map((turn) => turn.id)).toEqual([
          'sibling-before-rollback',
          'sibling-after-rollback',
        ]);
      } finally {
        for (const owner of owners) await owner.close();
        for (const client of clients) await client.close();
        await metadata.destroy();
        engine.stop();
        for (const doc of docs) doc.free();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
);
