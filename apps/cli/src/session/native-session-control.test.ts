import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startEngine } from '@loro-dev/loro-repo-engine';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import { LODY_SESSION_DOC_SCHEMA, type RepoClient } from '@loro-dev/loro-repo-client';
import { LoroDoc, LoroMap, LoroText, isContainer } from 'loro-crdt';
import { createNativeSessionQueuePort } from './native-session-control';
import { createNativeHistoryScalarWriter } from './native-session-history';

describe('native Session queue control', () => {
  let directory: string;
  let engine: ReturnType<typeof startEngine>;
  let client: RepoClient;
  let rival: RepoClient;
  const namespace = 'native-control-test';
  const room = { kind: 'loro_doc' as const, id: 'session-queue' };
  const makePort = (selected = client) =>
    createNativeSessionQueuePort({
      client: selected,
      namespace,
      sessionId: 'queue',
      writer: 'owner:test',
      now: () => 1000,
      editingLeaseMs: 100,
    });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lody-native-control-'));
    engine = startEngine({ dataDir: directory });
    client = await connectEngine(directory);
    rival = await connectEngine(directory);
    await client.createRoom(namespace, room, 'plaintext', { docSchema: LODY_SESSION_DOC_SCHEMA });
  });

  afterEach(async () => {
    await Promise.all([client?.close(), rival?.close()]);
    engine?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps missing queue reads empty without materializing queue or history', async () => {
    expect(await makePort().getMessageQueue()).toEqual([]);
    expect(await makePort().peekReadyMessageQueue()).toBeNull();
    await makePort().removeMessageQueueItem('absent');
    await makePort().reorderMessageQueue(['absent']);
    expect((await client.readDoc(namespace, room)).value).toEqual({});
  });

  it('reorders and removes imported MovableList rows without changing their identities or opaque fields', async () => {
    const legacy = new LoroDoc();
    const queue = legacy.getMovableList('mq');
    for (const id of ['a', 'b', 'c']) {
      const row = queue.insertContainer(queue.length, new LoroMap());
      row.set('task', id);
      row.set('userId', 'synthetic-user');
      row.set('timestamp', '2026-01-01T00:00:00Z');
      row.set('futureField', { untouched: id });
    }
    legacy.commit();
    await client.importRoomState(namespace, room, {
      snapshot: legacy.export({ mode: 'snapshot' }),
      enqueueOutbox: false,
    });
    const port = makePort();
    const before = await port.getMessageQueue();
    const [a, b, c] = before.map((row) => row.$cid);
    await port.reorderMessageQueue([c!, a!, c!, 'unknown']);
    const reordered = await port.getMessageQueue();
    expect(reordered.map((row) => row.$cid)).toEqual([c, a, b]);
    expect(reordered).toEqual([before[2], before[0], before[1]]);
    await port.removeMessageQueueItem(a!);
    expect(await port.getMessageQueue()).toEqual([before[2], before[1]]);
    const exported = new LoroDoc();
    exported.import((await client.exportLoroRaw(namespace, room)).bytes);
    expect(exported.getMovableList('mq').length).toBe(2);
    expect(exported.getMovableList('mq').get(0).id).toBe(queue.get(2).id);
  });

  it('replans against a concurrent append and retains unrelated rows after CAS rejection', async () => {
    await client.applyDocPatch(namespace, room, [
      {
        op: 'set',
        path: ['mq'],
        value: [
          { task: 'a', userId: 'synthetic-user', timestamp: '2026-01-01T00:00:00Z' },
          { task: 'b', userId: 'synthetic-user', timestamp: '2026-01-01T00:00:00Z' },
        ],
      },
    ]);
    let interfered = false;
    const racingPort = createNativeSessionQueuePort({
      namespace,
      sessionId: 'queue',
      writer: 'owner:test',
      now: () => 1000,
      editingLeaseMs: 100,
      client: {
        readDoc: client.readDoc.bind(client),
        transactCas: client.transactCas.bind(client),
        applyDocPatch: async (...args) => {
          if (!interfered) {
            interfered = true;
            await rival.applyDocPatch(namespace, room, [
              {
                op: 'arr_splice',
                path: ['mq'],
                at: 0,
                del: 0,
                items: [
                  {
                    task: 'concurrent',
                    userId: 'synthetic-user',
                    timestamp: '2026-01-01T00:00:00Z',
                  },
                ],
              },
            ]);
          }
          return await client.applyDocPatch(...args);
        },
      },
    });
    const [a, b] = await makePort().getMessageQueue();
    await racingPort.removeMessageQueueItem(a!.$cid);
    const after = await makePort().getMessageQueue();
    expect(after.map((row) => row.task)).toEqual(['concurrent', 'b']);
    expect(after[1]).toEqual(b);
  });

  it('observes editing leases and reports corrupt queue state instead of authoritatively empty', async () => {
    await client.applyDocPatch(namespace, room, [
      {
        op: 'set',
        path: ['mq'],
        value: [
          {
            task: 'editing',
            userId: 'synthetic-user',
            timestamp: '2026-01-01T00:00:00Z',
            isEditing: true,
            editingStartedAt: 950,
          },
        ],
      },
    ]);
    expect(await makePort().peekReadyMessageQueue()).toBeNull();
    await client.applyDocPatch(namespace, room, [
      {
        op: 'set',
        path: ['mq', 0, 'editingStartedAt'],
        value: 800,
      },
    ]);
    expect((await makePort().peekReadyMessageQueue())?.task).toBe('editing');
    await client.applyDocPatch(namespace, room, [
      {
        op: 'arr_splice',
        path: ['mq'],
        at: 1,
        del: 0,
        items: [false],
      },
    ]);
    await expect(makePort().getMessageQueue()).rejects.toThrow(
      'Invalid native Session queue identity'
    );
  });

  it('writes a selected scalar through shared HistoryWriter validation while preserving opaque siblings and legacy Text', async () => {
    const legacy = new LoroDoc();
    const history = legacy.getList('history');
    const turn = history.insertContainer(0, new LoroMap());
    turn.set('id', 'turn-a');
    turn.set('role', 'assistant');
    turn.set('timestamp', '2026-01-01T00:00:00Z');
    turn.setContainer('status', new LoroText()).insert(0, 'processing');
    turn.set('items', [{ type: 'future-item', opaque: { retain: true } }]);
    turn.set('futureField', { retain: 'extension' });
    legacy.commit();
    await client.importRoomState(namespace, room, {
      snapshot: legacy.export({ mode: 'snapshot' }),
      enqueueOutbox: false,
    });
    const scalarWriter = createNativeHistoryScalarWriter({
      client,
      namespace,
      sessionId: 'queue',
      writer: 'owner:test',
    });
    expect(
      await scalarWriter.setFieldAt({
        position: 0,
        turnId: 'wrong-id',
        field: 'status',
        value: 'handled',
      })
    ).toBe(false);
    await expect(
      scalarWriter.setFieldAt({
        position: 0,
        turnId: 'turn-a',
        field: 'status',
        value: 'invalid-status',
      })
    ).rejects.toThrow('Invalid history write');
    expect(
      await scalarWriter.setFieldAt({
        position: 0,
        turnId: 'turn-a',
        field: 'status',
        value: 'handled',
      })
    ).toBe(true);
    const exported = new LoroDoc();
    exported.import((await client.exportLoroRaw(namespace, room)).bytes);
    const stored = exported.getList('history').get(0) as LoroMap;
    expect(stored.id).toEqual(turn.id);
    expect(stored.get('items')).toEqual(turn.get('items'));
    expect(stored.get('futureField')).toEqual(turn.get('futureField'));
    expect(isContainer(stored.get('status')) && (stored.get('status') as LoroText).kind()).toBe(
      'Text'
    );
    expect((stored.get('status') as LoroText).toString()).toBe('handled');
  });

  it('updates a legacy inline turn atomically without changing its storage representation', async () => {
    const legacy = new LoroDoc();
    const turn = {
      id: 'inline-turn',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      status: 'processing',
      items: [{ type: 'future-item', opaque: { retained: true } }],
    };
    legacy.getList('history').insert(0, turn);
    legacy.commit();
    await client.importRoomState(namespace, room, {
      snapshot: legacy.export({ mode: 'snapshot' }),
      enqueueOutbox: false,
    });
    const writer = createNativeHistoryScalarWriter({
      client,
      namespace,
      sessionId: 'queue',
      writer: 'owner:test',
    });
    expect(
      await writer.setFieldAt({
        position: 0,
        turnId: turn.id,
        field: 'status',
        value: 'handled',
      })
    ).toBe(true);
    expect(
      await writer.setFieldAt({
        position: 0,
        turnId: turn.id,
        field: 'endedAt',
        value: 1000,
      })
    ).toBe(true);
    expect(
      await writer.setFieldAt({
        position: 0,
        turnId: turn.id,
        field: 'endedAt',
        value: undefined,
      })
    ).toBe(true);
    const exported = new LoroDoc();
    exported.import((await client.exportLoroRaw(namespace, room)).bytes);
    expect(exported.getList('history').get(0)).toEqual({ ...turn, status: 'handled' });
    expect(isContainer(exported.getList('history').get(0))).toBe(false);
    // Each controlled write supplies the canonical schema. This must reset the
    // persisted defaultObject override before inserting a new ordinary turn.
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
              id: 'new-map-turn',
              role: 'assistant',
              timestamp: '2026-01-01T00:00:00Z',
            },
          ],
        },
      ],
      { docSchema: LODY_SESSION_DOC_SCHEMA }
    );
    const reopened = new LoroDoc();
    reopened.import((await client.exportLoroRaw(namespace, room)).bytes);
    expect(isContainer(reopened.getList('history').get(0))).toBe(false);
    expect((reopened.getList('history').get(1) as LoroMap).kind()).toBe('Map');
  });

  it('preserves primitive scalar representation and omits cleared fields', async () => {
    await client.applyDocPatch(namespace, room, [
      {
        op: 'set',
        path: ['history'],
        value: [
          {
            id: 'primitive-turn',
            role: 'assistant',
            timestamp: '2026-01-01T00:00:00Z',
            status: 'processing',
          },
        ],
      },
    ]);
    const writer = createNativeHistoryScalarWriter({
      client,
      namespace,
      sessionId: 'queue',
      writer: 'owner:test',
    });
    expect(
      await writer.setFieldAt({
        position: 0,
        turnId: 'primitive-turn',
        field: 'status',
        value: 'handled',
      })
    ).toBe(true);
    expect(
      await writer.setFieldAt({
        position: 0,
        turnId: 'primitive-turn',
        field: 'endedAt',
        value: 1000,
      })
    ).toBe(true);
    expect(
      await writer.setFieldAt({
        position: 0,
        turnId: 'primitive-turn',
        field: 'endedAt',
        value: undefined,
      })
    ).toBe(true);
    const exported = new LoroDoc();
    exported.import((await client.exportLoroRaw(namespace, room)).bytes);
    const turn = exported.getList('history').get(0) as LoroMap;
    expect(turn.get('status')).toBe('handled');
    expect(turn.get('endedAt')).toBeUndefined();
  });

  it('rejects a stale position after concurrent insertion rather than writing its new neighbor', async () => {
    const legacy = new LoroDoc();
    legacy.getList('history').insert(0, {
      id: 'original',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      status: 'processing',
    });
    legacy.commit();
    await client.importRoomState(namespace, room, {
      snapshot: legacy.export({ mode: 'snapshot' }),
      enqueueOutbox: false,
    });
    let interfered = false;
    const writer = createNativeHistoryScalarWriter({
      namespace,
      sessionId: 'queue',
      writer: 'owner:test',
      client: {
        readDoc: client.readDoc.bind(client),
        transactCas: client.transactCas.bind(client),
        applyDocPatch: async (...args) => {
          if (!interfered && args[2][0]?.op === 'set' && args[2][0].path.length === 2) {
            interfered = true;
            await rival.applyDocPatch(namespace, room, [
              {
                op: 'arr_splice',
                path: ['history'],
                at: 0,
                del: 0,
                items: [
                  {
                    id: 'new-neighbor',
                    role: 'assistant',
                    timestamp: '2026-01-01T00:00:00Z',
                    status: 'processing',
                  },
                ],
              },
            ]);
          }
          return await client.applyDocPatch(...args);
        },
      },
    });
    expect(
      await writer.setFieldAt({
        position: 0,
        turnId: 'original',
        field: 'status',
        value: 'handled',
      })
    ).toBe(false);
    expect((await client.readDoc(namespace, room, ['history'])).value).toMatchObject([
      { id: 'new-neighbor', status: 'processing' },
      { id: 'original', status: 'processing' },
    ]);
  });
});
