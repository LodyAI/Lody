import { NativeMachineCatalogCleanupError } from '@lody/shared/node/native-machine-catalog-observations';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Cause, Effect, Exit, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { startEngine } from '@loro-dev/loro-repo-engine';
import {
  connectEngine,
  connectSocketTransport,
  readEngineEndpoint,
} from '@loro-dev/loro-repo-client/node';
import {
  LODY_SESSION_DOC_SCHEMA,
  type RepoClient,
  type SubscriptionHandle,
} from '@loro-dev/loro-repo-client';
import { makeNativeSessionReader, type NativeSessionReader } from './native-session-reader';

const namespace = 'native-reader-test';
const room = { kind: 'loro_doc' as const, id: 'session-reader' };

describe('native Session read projection', () => {
  let directory: string;
  let engine: ReturnType<typeof startEngine>;
  let client: RepoClient;
  let scope: Scope.Closeable;
  let reader: NativeSessionReader;
  const gates: Array<() => void> = [];

  const acquire = async (
    selected: Pick<RepoClient, 'subscribeDoc'> = client,
    onFailure?: (error: Error) => void
  ) => {
    reader = await Effect.runPromise(
      Scope.provide(
        makeNativeSessionReader({
          dataDir: directory,
          namespace,
          sessionId: 'reader',
          onFailure,
          client: {
            get connectionState() {
              return client.connectionState;
            },
            subscribeDoc: selected.subscribeDoc.bind(selected),
            onConnectionStateChange: client.onConnectionStateChange.bind(client),
          },
        }),
        scope
      )
    );
    return reader;
  };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'lody-native-reader-'));
    engine = startEngine({ dataDir: directory });
    client = await connectEngine(directory, { autoReconnect: false });
    scope = Effect.runSync(Scope.make());
    await client.createRoom(namespace, room, 'plaintext', { docSchema: LODY_SESSION_DOC_SCHEMA });
    const legacy = new LoroDoc();
    legacy.getMap('session').set('id', 'reader');
    const history = legacy.getList('history');
    const user = history.insertContainer(0, new LoroMap());
    user.set('id', 'user-1');
    user.set('role', 'user');
    user.set('timestamp', 'synthetic');
    user.set('userId', 'synthetic-owner');
    user.setContainer('status', new LoroText()).insert(0, 'pending');
    user.set('inputConfig', { modelId: 'synthetic-model' });
    const assistant = history.insertContainer(1, new LoroMap());
    assistant.set('id', 'assistant-1');
    assistant.set('role', 'assistant');
    assistant.set('timestamp', 'synthetic');
    assistant.set('userTurnId', 'user-1');
    const items = assistant.setContainer('items', new LoroList());
    items.push({ type: 'future-item', opaque: { retained: true } });
    const text = items.pushContainer(new LoroMap());
    text.set('type', 'text');
    text.setContainer('text', new LoroText()).insert(0, 'before');
    history.push({
      id: 'inline',
      role: 'system',
      timestamp: 'synthetic',
      items: [{ type: 'future-item', opaque: { retained: 'inline' } }],
      futureField: ['keep'],
    });
    legacy.commit();
    await client.importRoomState(namespace, room, {
      snapshot: legacy.export({ mode: 'snapshot' }),
      enqueueOutbox: false,
    });
    legacy.free();
  });

  afterEach(async () => {
    for (const release of gates.splice(0)) release();
    const closing = await Effect.runPromiseExit(Scope.close(scope, Exit.void));
    await client.close();
    if (Exit.isFailure(closing)) {
      const retained = closing.cause.reasons.flatMap((reason) =>
        Cause.isDieReason(reason) && reason.defect instanceof NativeMachineCatalogCleanupError
          ? [reason.defect]
          : []
      );
      if (!retained.length)
        throw new Error('Native reader scope cleanup failed', { cause: closing.cause });
      // Terminal fixture transport loss is real cleanup proof, including a
      // server-side room deletion that invalidated the old subscription ID.
      await Promise.all(retained.map((error) => error.retryCleanup()));
    }
    engine.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('reads initial raw oplog through the existing shallow/history contracts without authoring state', async () => {
    const before = await client.inspectDocCausal(namespace, room);
    await acquire();
    expect(reader.history.count()).toBe(3);
    const rows = reader.history.readDirectory(0, 3);
    expect(rows.map((row) => row.turnId)).toEqual(['user-1', 'assistant-1', 'inline']);
    expect(rows[0]?.scalars?.status).toBe('pending');
    expect(rows[0]?.inputConfig).toMatchObject({ modelId: 'synthetic-model' });
    expect(rows[1]).not.toHaveProperty('items');
    expect(reader.history.readModelSummaryAt(1)?.itemCount).toBe(2);
    expect(reader.history.readTurn('inline')).toMatchObject({
      state: 'ready',
      turn: {
        futureField: ['keep'],
        items: [{ type: 'future-item', opaque: { retained: 'inline' } }],
      },
    });
    expect(reader.readLatestUserId()).toBe('synthetic-owner');
    expect(reader.history.readTurnOutput('user-1')).toHaveLength(2);
    expect(reader.checkpoint().roomTxId).toBe(before.roomTxId);
    const after = await client.inspectDocCausal(namespace, room);
    expect(after.version).toEqual(before.version);
    expect(after.roomTxId).toBe(before.roomTxId);
  });

  it.each(['absent-map', 'missing-id'] as const)(
    'reads and observes history with %s without backfilling content',
    async (shape) => {
      await client.deleteRoom(namespace, room);
      await client.createRoom(namespace, room, 'plaintext', { docSchema: LODY_SESSION_DOC_SCHEMA });
      const legacy = new LoroDoc();
      if (shape === 'missing-id') legacy.getMap('session').set('futureField', 'retained');
      legacy.getList('history').push({
        id: 'minimal',
        role: 'user',
        timestamp: 'synthetic',
        items: [{ type: 'future-item', opaque: { retained: true } }],
      });
      legacy.commit();
      await client.importRoomState(namespace, room, {
        snapshot: legacy.export({ mode: 'snapshot' }),
        enqueueOutbox: false,
      });
      legacy.free();
      const before = await client.inspectDocCausal(namespace, room);
      await acquire();
      expect(reader.history.count()).toBe(1);
      expect(reader.history.readTurn('minimal')).toMatchObject({
        state: 'ready',
        turn: {
          items: [{ type: 'future-item', opaque: { retained: true } }],
        },
      });
      const after = await client.inspectDocCausal(namespace, room);
      expect(after.version).toEqual(before.version);
      expect(after.roomTxId).toBe(before.roomTxId);
      const changed = Promise.withResolvers<void>();
      const observed = reader.history.observe((event) => {
        if (event.kind === 'structure') changed.resolve();
      });
      await observed.initial;
      await client.applyDocPatch(
        namespace,
        room,
        [
          {
            op: 'arr_splice',
            path: ['history'],
            at: 1,
            del: 0,
            items: [
              {
                id: 'later',
                role: 'system',
                timestamp: 'synthetic',
              },
            ],
          },
        ],
        { docSchema: LODY_SESSION_DOC_SCHEMA }
      );
      await changed.promise;
      expect(reader.history.readDirectory(0, 2).map((row) => row.turnId)).toEqual([
        'minimal',
        'later',
      ]);
      await expect(client.readDoc(namespace, room, ['session', 'id'])).rejects.toMatchObject({
        code: 'invalid_patch',
        detail: 'path not found',
      });
      observed.unsubscribe();
    }
  );

  it('uses narrow-subscription watermarks to import streaming deltas and notify only the affected turn', async () => {
    await acquire();
    const changed = Promise.withResolvers<void>();
    const updates: unknown[] = [];
    const observation = reader.history.observe((event) => {
      updates.push(event);
      if (event.kind === 'changed' && event.ids.includes('assistant-1')) changed.resolve();
    });
    expect((await observation.initial).map((row) => row.turnId)).toHaveLength(3);
    const ack = await client.applyDocPatch(
      namespace,
      room,
      [
        {
          op: 'str_splice',
          path: ['history', 1, 'items', 1, 'text'],
          at: 6,
          del: 0,
          ins: ' after',
        },
      ],
      { docSchema: LODY_SESSION_DOC_SCHEMA }
    );
    await changed.promise;
    expect(updates).toContainEqual({ kind: 'changed', ids: ['assistant-1'] });
    expect(updates).not.toContainEqual({ kind: 'changed', ids: ['user-1'] });
    expect(reader.history.readTurn('assistant-1')).toMatchObject({
      state: 'ready',
      turn: {
        items: [
          { type: 'future-item', opaque: { retained: true } },
          { type: 'text', text: 'before after' },
        ],
      },
    });
    expect(reader.checkpoint().roomTxId).toBe(ack.roomTxId);
    observation.unsubscribe();
    // This namespace has never needed a compacted snapshot. The cold read and
    // streaming catch-up therefore had to work from actual raw Loro oplog bytes.
    const db = new Database(
      path.join(directory, 'namespaces', `ns_${Buffer.from(namespace).toString('hex')}.sqlite3`),
      { readonly: true, fileMustExist: true }
    );
    try {
      expect(
        db
          .prepare(
            'SELECT count(*) AS n FROM v2_room_snapshots WHERE room_kind = 1 AND room_id = ?'
          )
          .get(room.id)
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('opens a large history under a tiny IPC frame budget and streams through a narrow watermark', async () => {
    await client.applyDocPatch(
      namespace,
      room,
      [
        {
          op: 'arr_splice',
          path: ['history'],
          at: 3,
          del: 0,
          items: Array.from({ length: 40 }, (_, index) => ({
            id: `bulk-${index}`,
            role: 'assistant',
            timestamp: 'synthetic',
            items: [{ type: 'text', text: 'synthetic body '.repeat(1024) }],
          })),
        },
      ],
      { docSchema: LODY_SESSION_DOC_SCHEMA }
    );
    await client.close();
    engine.stop();
    engine = startEngine({ dataDir: directory, maxFrameBytes: 4096 });
    client = await connectEngine(directory, { autoReconnect: false });
    await acquire();
    expect(reader.history.count()).toBe(43);
    expect(reader.history.readDirectory(40, 43).map((row) => row.turnId)).toEqual([
      'bulk-37',
      'bulk-38',
      'bulk-39',
    ]);
    const changed = Promise.withResolvers<void>();
    const observed = reader.history.observe((event) => {
      if (event.kind === 'changed' && event.ids.includes('assistant-1')) changed.resolve();
    });
    await observed.initial;
    await client.applyDocPatch(
      namespace,
      room,
      [
        {
          op: 'str_splice',
          path: ['history', 1, 'items', 1, 'text'],
          at: 6,
          del: 0,
          ins: ' narrow',
        },
      ],
      { docSchema: LODY_SESSION_DOC_SCHEMA }
    );
    await changed.promise;
    expect(reader.history.readTurn('assistant-1')).toMatchObject({
      state: 'ready',
      turn: {
        items: [{ type: 'future-item' }, { type: 'text', text: 'before narrow' }],
      },
    });
    expect(reader.history.readAt(42)).toMatchObject({ state: 'ready', turn: { id: 'bulk-39' } });
    observed.unsubscribe();
  });

  it('catches a compaction gap without rebuilding JSON and keeps sparse reads coherent', async () => {
    const gate = Promise.withResolvers<void>();
    gates.push(() => gate.resolve());
    const selected: Pick<RepoClient, 'subscribeDoc'> = {
      subscribeDoc: async (...args) => {
        const handle = await client.subscribeDoc(...args);
        const visible = handle.whenVisible.bind(handle);
        handle.whenVisible = async (tx) => {
          await gate.promise;
          return await visible(tx);
        };
        return handle;
      },
    };
    await acquire(selected);
    const old = reader.checkpoint();
    await client.applyDocPatch(
      namespace,
      room,
      [
        {
          op: 'str_splice',
          path: ['history', 1, 'items', 1, 'text'],
          at: 6,
          del: 0,
          ins: ' compacted',
        },
      ],
      { docSchema: LODY_SESSION_DOC_SCHEMA }
    );
    await client.compactRoom(namespace, room);
    const ack = await client.applyDocPatch(
      namespace,
      room,
      [
        {
          op: 'set',
          path: ['history', 0, 'read'],
          value: true,
        },
      ],
      { docSchema: LODY_SESSION_DOC_SCHEMA }
    );
    expect(reader.checkpoint().roomTxId).toBe(ack.roomTxId);
    expect(reader.checkpoint().roomTxId).toBeGreaterThan(old.roomTxId);
    expect(reader.history.readTurn('assistant-1')).toMatchObject({
      state: 'ready',
      turn: {
        items: [{ type: 'future-item' }, { type: 'text', text: 'before compacted' }],
      },
    });
    expect(reader.history.readDirectory(0, 1)[0]?.scalars?.read).toBe(true);
    gate.resolve();
  });

  it('refreshes a warm identity index synchronously and reports remote identity edits structurally', async () => {
    const gate = Promise.withResolvers<void>();
    gates.push(() => gate.resolve());
    await acquire({
      subscribeDoc: async (...args) => {
        const handle = await client.subscribeDoc(...args);
        const visible = handle.whenVisible.bind(handle);
        handle.whenVisible = async (tx) => {
          await gate.promise;
          return await visible(tx);
        };
        return handle;
      },
    });
    expect(reader.history.readTurn('assistant-1').state).toBe('ready');
    const structural = Promise.withResolvers<void>();
    const changes: unknown[] = [];
    const observation = reader.history.observe((event) => {
      changes.push(event);
      if (event.kind === 'structure') structural.resolve();
    });
    await observation.initial;
    await client.applyDocPatch(
      namespace,
      room,
      [
        {
          op: 'set',
          path: ['history', 1, 'id'],
          value: 'renamed',
        },
      ],
      { docSchema: LODY_SESSION_DOC_SCHEMA }
    );
    // No notification gate has been released: this read must catch up itself.
    expect(reader.history.readTurn('renamed')).toMatchObject({
      state: 'ready',
      turn: { id: 'renamed' },
    });
    expect(reader.history.readTurn('assistant-1')).toEqual({ state: 'missing' });
    await structural.promise;
    expect(changes).toContainEqual({ kind: 'structure', from: 1, to: 3 });
    observation.unsubscribe();
    gate.resolve();
  });

  it('fences reads immediately but retains a failed narrow subscription ACK until actual transport loss', async () => {
    let handle!: SubscriptionHandle;
    const lateAck = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const failures: Error[] = [];
    await acquire(
      {
        subscribeDoc: async (...args) => {
          handle = await client.subscribeDoc(...args);
          const release = handle.unsubscribe.bind(handle);
          handle.unsubscribe = () => {
            void release().catch(() => undefined);
            released.resolve();
            return lateAck.promise;
          };
          return handle;
        },
      },
      (error) => failures.push(error)
    );
    const changed: unknown[] = [];
    const observation = reader.history.observe((event) => changed.push(event));
    await observation.initial;
    const closing = Effect.runPromiseExit(Scope.close(scope, Exit.void));
    await released.promise;
    expect(handle.isClosed).toBe(true);
    expect(() => reader.history.count()).toThrow('closed');
    await client.applyDocPatch(
      namespace,
      room,
      [
        {
          op: 'set',
          path: ['history', 0, 'read'],
          value: true,
        },
      ],
      { docSchema: LODY_SESSION_DOC_SCHEMA }
    );
    expect(changed).toEqual([]);
    lateAck.reject(new Error('delayed native unsubscribe failure'));
    const result = await closing;
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isSuccess(result)) throw new Error('Lost unsubscribe ACK was incorrectly confirmed');
    const retained = result.cause.reasons.flatMap((reason) =>
      Cause.isDieReason(reason) && reason.defect instanceof NativeMachineCatalogCleanupError
        ? [reason.defect]
        : []
    );
    expect(retained.length).toBeGreaterThan(0);
    await expect(retained[0]!.retryCleanup()).rejects.toMatchObject({
      code: 'cleanup_unconfirmed',
    });
    expect(client.connectionState).toBe('connected');
    await client.close();
    await retained[0]!.retryCleanup();
    scope = Effect.runSync(Scope.make());
    expect(failures).toEqual([]);
    observation.unsubscribe();
  });

  it('does not merge a deleted/recreated room into its old read projection', async () => {
    const gate = Promise.withResolvers<void>();
    gates.push(() => gate.resolve());
    await acquire({
      subscribeDoc: async (...args) => {
        const handle = await client.subscribeDoc(...args);
        const visible = handle.whenVisible.bind(handle);
        handle.whenVisible = async (tx) => {
          await gate.promise;
          return await visible(tx);
        };
        return handle;
      },
    });
    await client.deleteRoom(namespace, room);
    await client.createRoom(namespace, room, 'plaintext', { docSchema: LODY_SESSION_DOC_SCHEMA });
    await client.applyDocPatch(
      namespace,
      room,
      [
        { op: 'set', path: ['session'], value: { id: 'reader' } },
        {
          op: 'set',
          path: ['history'],
          value: [{ id: 'replacement', role: 'system', timestamp: 'synthetic' }],
        },
      ],
      { docSchema: LODY_SESSION_DOC_SCHEMA }
    );
    expect(() => reader.history.readAll()).toThrow('causal anchor');
    gate.resolve();
  });

  it('fences an engine run replacement even when its durable room data is retained', async () => {
    const gate = Promise.withResolvers<void>();
    gates.push(() => gate.resolve());
    const failed = Promise.withResolvers<Error>();
    await acquire(
      {
        subscribeDoc: async (...args) => {
          const handle = await client.subscribeDoc(...args);
          const visible = handle.whenVisible.bind(handle);
          handle.whenVisible = async (tx) => {
            await gate.promise;
            return await visible(tx);
          };
          return handle;
        },
      },
      failed.resolve
    );
    const disconnected = Promise.withResolvers<void>();
    const stopListening = client.onConnectionStateChange((state) => {
      if (state === 'closed') disconnected.resolve();
    });
    engine.stop();
    await disconnected.promise;
    stopListening();
    engine = startEngine({ dataDir: directory });
    const endpoint = await readEngineEndpoint(directory);
    await client.reconnectWith(await connectSocketTransport(endpoint.socket));
    expect((await failed.promise).message).toContain('generation changed');
    expect(() => reader.history.count()).toThrow('generation changed');
  });
});
