import {
  createNativeSessionBackend,
  type NativeSessionBackendHostPorts,
} from './native-session-backend';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoroDoc, LoroList, LoroMap, LoroText, isContainer } from 'loro-crdt';
import { startEngine } from '@loro-dev/loro-repo-engine';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import { LODY_SESSION_DOC_SCHEMA, type RepoClient } from '@loro-dev/loro-repo-client';
import {
  hashHistoryEntryForVersion,
  hashText,
  type SessionTurn,
  type HistoryImportInput,
} from '@lody/shared/session-data';
import { parseSessionNotification, type StoredLodyOperation } from '@lody/shared';
import { createNativeSessionWriter, type NativeSessionWriter } from './native-session-writer';
import {
  makeNativeSessionReader,
  type NativeSessionReader,
  type NativeSessionReadView,
} from './native-session-reader';

const namespace = 'native-writer-test';
const room = { kind: 'loro_doc' as const, id: 'session-writer' };

describe('native Session domain commands', () => {
  let directory: string;
  let engine: ReturnType<typeof startEngine>;
  let client: RepoClient;
  let rival: RepoClient;
  let scope: Scope.Closeable;
  let reader: NativeSessionReader;
  let writer: NativeSessionWriter;
  const docs: LoroDoc[] = [];
  const options = () => ({ client, reader, namespace, sessionId: 'writer', writer: 'owner:test' });
  const exported = async () => {
    const doc = new LoroDoc();
    docs.push(doc);
    doc.import((await client.exportLoroRaw(namespace, room)).bytes);
    return doc;
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lody-native-domain-'));
    engine = startEngine({ dataDir: directory });
    client = await connectEngine(directory, { autoReconnect: false });
    rival = await connectEngine(directory, { autoReconnect: false });
    scope = Effect.runSync(Scope.make());
    await client.createRoom(namespace, room, 'plaintext', { docSchema: LODY_SESSION_DOC_SCHEMA });
    const legacy = new LoroDoc();
    docs.push(legacy);
    legacy.getMap('session').set('id', 'writer');
    const list = legacy.getList('history');
    const first = list.pushContainer(new LoroMap());
    first.set('id', 'duplicate');
    first.set('role', 'user');
    first.set('timestamp', 'synthetic');
    first.set('status', 'pending');
    first.set('read', false);
    first
      .setContainer('items', new LoroList())
      .push({ type: 'future-item', opaque: { stored: 'map' } });
    first.setContainer('inputConfig', new LoroMap()).set('modelId', 'old-model');
    list.push({
      id: 'duplicate',
      role: 'user',
      timestamp: 'synthetic',
      status: 'pending',
      read: false,
      items: [{ type: 'future-item', opaque: { stored: 'inline' } }],
      futureField: { retained: true },
      $cid: 'synthetic-inline-literal-cid',
    });
    const unrelated = list.pushContainer(new LoroMap());
    unrelated.set('id', 'unrelated');
    unrelated.set('role', 'assistant');
    unrelated.set('timestamp', 'synthetic');
    unrelated.set('items', [{ type: 'future-item', opaque: { body: 'synthetic '.repeat(5000) } }]);
    const permission = list.pushContainer(new LoroMap());
    permission.set('id', 'permission');
    permission.set('role', 'assistant');
    permission.set('timestamp', 'synthetic');
    const tool = permission.setContainer('items', new LoroList()).pushContainer(new LoroMap());
    tool.set('type', 'tool_call');
    tool.set('toolCallId', 'tool');
    tool.set('status', 'pending');
    tool.setContainer('title', new LoroText()).insert(0, 'Stored title');
    const request = tool.setContainer('permissionRequest', new LoroMap());
    request.set('requestId', 'request');
    request.set('options', []);
    request.set('futureField', { retained: true });
    legacy.commit();
    await client.importRoomState(namespace, room, {
      snapshot: legacy.export({ mode: 'snapshot' }),
      enqueueOutbox: false,
    });
    reader = await Effect.runPromise(
      Scope.provide(
        makeNativeSessionReader({
          dataDir: directory,
          namespace,
          sessionId: 'writer',
          client,
        }),
        scope
      )
    );
    writer = createNativeSessionWriter(options());
  });
  afterEach(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await Promise.all([client.close(), rival.close()]);
    engine.stop();
    for (const doc of docs.splice(0)) doc.free();
    await rm(directory, { recursive: true, force: true });
  });

  const tailInput = async () => {
    await writer.appendTurn({
      id: 'provider-boundary',
      role: 'assistant',
      timestamp: 'synthetic',
      finished: true,
      acpTurnId: 'provider-turn',
      items: [],
    });
    await writer.appendTurn({
      id: 'old-tail-user',
      role: 'user',
      timestamp: 'synthetic',
      status: 'handled',
      items: [{ type: 'text', text: 'old user' }],
    });
    await writer.appendTurn({
      id: 'old-tail-assistant',
      role: 'assistant',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'old assistant' }],
    });
    return {
      expectedUserTurnId: 'old-tail-user',
      expectedForkTurnId: 'provider-turn',
      replacement: {
        id: 'replacement',
        role: 'user' as const,
        timestamp: 'synthetic',
        status: 'pending' as const,
        read: false,
        items: [{ type: 'text', text: 'replacement user' }],
      },
    };
  };

  it('updates every eligible duplicate through shared guards without reading unrelated transcript bodies', async () => {
    const original = (await exported()).getList('history').toJSON();
    const protectedReader: NativeSessionReader = {
      ...reader,
      query: <A>(operation: (view: NativeSessionReadView) => A) =>
        reader.query((view) =>
          operation({
            ...view,
            readQuery: () => {
              throw new Error('Status commands must not scan items');
            },
            valueAt(path) {
              if (
                path[0] === 'history' &&
                (path.includes('items') || (path.length === 2 && path[1] !== 1))
              )
                throw new Error('Unrelated transcript read is unavailable');
              return view.valueAt(path);
            },
          })
        ),
    };
    const command = createNativeSessionWriter({ ...options(), reader: protectedReader });
    expect(
      await command.applyHistoryAction({
        kind: 'user-status',
        turnId: 'duplicate',
        status: 'canceled',
        onlyAwaitingStart: true,
      })
    ).toEqual({ matched: true });
    const stored = (await exported()).getList('history');
    expect(stored.get(0).toJSON()).toMatchObject({
      status: 'canceled',
      read: true,
      items: original[0].items,
    });
    expect(stored.get(1)).toEqual({ ...original[1], status: 'canceled', read: true });
    expect(stored.get(2).toJSON()).toEqual(original[2]);
    expect(isContainer(stored.get(1))).toBe(false);
  });

  it('rechecks duplicate-copy cancellation guards after a native concurrent processing claim', async () => {
    let injected = false;
    const racing = createNativeSessionWriter({
      ...options(),
      client: {
        transactCas: client.transactCas.bind(client),
        applyDocPatch: async (...args) => {
          if (!injected) {
            injected = true;
            await rival.applyDocPatch(namespace, room, [
              { op: 'set', path: ['history', 0, 'status'], value: 'processing' },
            ]);
          }
          return await client.applyDocPatch(...args);
        },
      },
    });
    expect(
      await racing.applyHistoryAction({
        kind: 'user-status',
        turnId: 'duplicate',
        status: 'canceled',
        onlyAwaitingStart: true,
      })
    ).toEqual({ matched: false });
    const stored = reader.history.readRange(0, 2);
    expect(stored).toMatchObject([
      { state: 'ready', turn: { status: 'processing' } },
      { state: 'ready', turn: { status: 'pending' } },
    ]);
    expect(
      await writer.applyHistoryAction({
        kind: 'user-status',
        turnId: 'duplicate',
        status: 'pending',
        requeueUndelivered: true,
      })
    ).toEqual({ matched: false });
  });

  it('appends validated Map/Text storage and reopens one assistant without replacing stored provenance', async () => {
    await writer.appendTurn({
      id: 'authored',
      role: 'user',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'authored text' }],
    });
    const first = await exported();
    const authored = first.getList('history').get(4) as LoroMap;
    expect(authored.kind()).toBe('Map');
    const textItem = (authored.get('items') as LoroList).get(0) as LoroMap;
    expect((textItem.get('text') as LoroText).kind()).toBe('Text');
    expect(authored.get('role')).toBe('user');
    const author = {
      v: 1 as const,
      kind: 'agent' as const,
      sessionId: 'origin',
      turnId: 'origin-turn',
      name: 'Synthetic agent',
    };
    await writer.openAssistantTurn({
      turnId: 'assistant',
      userTurnId: 'authored',
      timestamp: 'synthetic',
      author,
    });
    await writer.setTurnField('assistant', 'finished', { kind: 'set', value: true });
    await writer.setTurnField('assistant', 'endedAt', { kind: 'set', value: 1000 });
    await writer.openAssistantTurn({
      turnId: 'assistant',
      userTurnId: 'different',
      timestamp: 'later',
      author: { v: 1, kind: 'system' },
      modelInfo: { modelId: 'new-model', name: 'New model' },
    });
    expect(reader.history.readTurn('assistant')).toMatchObject({
      state: 'ready',
      turn: {
        userTurnId: 'authored',
        author,
        finished: false,
        modelInfo: { modelId: 'new-model', name: 'New model' },
      },
    });
    expect(reader.history.readTurn('assistant').turn).not.toHaveProperty('endedAt');
    await expect(
      writer.appendTurn({
        id: 'bad',
        role: 'user',
        timestamp: 'synthetic',
        items: [{ type: 'future-new-item' }],
      })
    ).rejects.toThrow('Invalid history write');
    expect(reader.history.readTurn('bad')).toEqual({ state: 'missing' });
  });

  it('answers exactly one permission and preserves old tool/Text identities and opaque request fields', async () => {
    const before = await exported();
    const toolBefore = ((before.getList('history').get(3) as LoroMap).get('items') as LoroList).get(
      0
    ) as LoroMap;
    expect(
      await writer.respondPermission(
        'request',
        { outcome: 'selected', optionId: 'allow' },
        { turnId: 'permission' }
      )
    ).toBe(true);
    expect(await writer.respondPermission('request', { outcome: 'cancelled' })).toBe(false);
    const after = await exported();
    const toolAfter = ((after.getList('history').get(3) as LoroMap).get('items') as LoroList).get(
      0
    ) as LoroMap;
    expect(toolAfter.id).toBe(toolBefore.id);
    expect((toolAfter.get('title') as LoroText).id).toBe((toolBefore.get('title') as LoroText).id);
    expect((toolAfter.get('permissionRequest') as LoroMap).toJSON()).toMatchObject({
      outcome: { outcome: 'selected', optionId: 'allow' },
      futureField: { retained: true },
    });
  });

  it('does not overwrite a concurrent permission outcome after CAS retries', async () => {
    let injected = false;
    const racing = createNativeSessionWriter({
      ...options(),
      client: {
        transactCas: client.transactCas.bind(client),
        applyDocPatch: async (...args) => {
          if (!injected) {
            injected = true;
            await rival.applyDocPatch(namespace, room, [
              {
                op: 'set',
                path: ['history', 3, 'items', 0, 'permissionRequest', 'outcome'],
                value: { outcome: 'selected', optionId: 'other' },
              },
            ]);
          }
          return await client.applyDocPatch(...args);
        },
      },
    });
    expect(
      await racing.respondPermission('request', { outcome: 'selected', optionId: 'allow' })
    ).toBe(false);
    expect(reader.history.readTurn('permission')).toMatchObject({
      state: 'ready',
      turn: {
        items: [{ permissionRequest: { outcome: { outcome: 'selected', optionId: 'other' } } }],
      },
    });
  });

  it('repairs an alias-only operation card in place without scanning unrelated bodies', async () => {
    const operation: StoredLodyOperation = {
      workspaceId: 'workspace' as StoredLodyOperation['workspaceId'],
      ownerMachineId: 'machine' as StoredLodyOperation['ownerMachineId'],
      requesterSessionId: 'requester' as StoredLodyOperation['requesterSessionId'],
      requesterUserId: 'synthetic-user',
      operationId: 'op',
      kind: 'session_create_many',
      fingerprint: 'synthetic',
      canonicalCommand: {},
      frozenContinuationConfig: { inputConfig: {} },
      initiatorChainDepth: 0,
      createdAt: '2026-01-01T00:00:00Z',
      deadlineAt: '2026-01-02T00:00:00Z',
      state: 'active',
      items: [
        {
          status: 'active',
          inputDurable: true,
          target: {
            sessionId: 'child' as StoredLodyOperation['requesterSessionId'],
            userTurnId: 'input',
          },
        },
      ],
    };
    const action = { kind: 'operation-progress' as const, operation, timestamp: 'synthetic' };
    expect(await writer.applyHistoryAction(action)).toEqual({ matched: true });
    await rival.applyDocPatch(namespace, room, [
      {
        op: 'set',
        path: ['history', 4, 'id'],
        value: 'operation-progress:requester:op:duplicate:old',
      },
      { op: 'set', path: ['history', 4, 'futureField'], value: { retained: true } },
    ]);
    const before = (await exported()).getList('history').get(4) as LoroMap;
    const protectedReader: NativeSessionReader = {
      ...reader,
      query: <A>(operation: (view: NativeSessionReadView) => A) =>
        reader.query((view) =>
          operation({
            ...view,
            readQuery: () => {
              throw new Error('Progress must use scalar ownership');
            },
            valueAt(path) {
              if (path[0] === 'history' && path.length === 2 && Number(path[1]) < 4)
                throw new Error('Unrelated transcript read is unavailable');
              return view.valueAt(path);
            },
          })
        ),
    };
    const command = createNativeSessionWriter({ ...options(), reader: protectedReader });
    expect(
      await command.applyHistoryAction({ ...action, statuses: [['child\0input', 'running']] })
    ).toEqual({ matched: true });
    const after = (await exported()).getList('history').get(4) as LoroMap;
    expect(after.id).toBe(before.id);
    expect(after.toJSON()).toMatchObject({
      id: 'operation-progress:requester:op',
      futureField: { retained: true },
      items: [{ items: [{ status: 'running' }] }],
    });
    const checkpoint = reader.checkpoint();
    expect(await command.applyHistoryAction(action)).toEqual({ matched: false });
    expect(reader.checkpoint()).toEqual(checkpoint);
  });

  it('commits imported history and its versioned cursor together and safely appends a refresh suffix', async () => {
    await client.applyDocPatch(namespace, room, [
      { op: 'arr_splice', path: ['history'], at: 0, del: 4, items: [] },
    ]);
    const turn: SessionTurn = {
      id: 'imported-1',
      role: 'user',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'imported one' }],
    };
    const replay = (history: SessionTurn[]) => {
      const turnHashes = history.map((entry) => hashHistoryEntryForVersion(entry, 2));
      return {
        history,
        turnHashes,
        replayDigest: hashText(turnHashes.join('\n')),
        hashVersion: 2,
        droppedNotifications: 0,
      };
    };
    const first = replay([turn]);
    expect(await writer.applyHistoryImport({ mode: 'initialize', replay: first })).toEqual({
      status: 'accepted',
      appended: 1,
    });
    const second = replay([
      turn,
      { ...turn, id: 'imported-2', items: [{ type: 'text', text: 'imported two' }] },
    ]);
    expect(
      await writer.applyHistoryImport({
        mode: 'refresh',
        replay: second,
        externalHistory: {
          importedTurnCount: 1,
          importedTurnHashes: first.turnHashes,
          replayDigest: first.replayDigest,
          hashVersion: 2,
        },
      })
    ).toEqual({ status: 'accepted', appended: 1 });
    const stored = await exported();
    expect(
      stored
        .getList('history')
        .toJSON()
        .map((entry) => entry.id)
    ).toEqual(['imported-1', 'imported-2']);
    expect(stored.getMap('externalHistoryCursor').toJSON()).toMatchObject({
      importedTurnHashes: second.turnHashes,
      hashVersion: 2,
    });
    const baseline = JSON.parse(
      stored.getMap('externalHistoryCursor').get('storedHistoryBaseline') as string
    );
    expect(baseline.hashVersion).toBe(2);
    expect(baseline.turnHashes).toHaveLength(2);
  });

  it('refuses an import if a peer populated the empty target before the conditional commit', async () => {
    await client.applyDocPatch(namespace, room, [
      { op: 'arr_splice', path: ['history'], at: 0, del: 4, items: [] },
    ]);
    const turn: SessionTurn = {
      id: 'imported',
      role: 'user',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'imported' }],
    };
    const hashes = [hashHistoryEntryForVersion(turn, 2)];
    const input: HistoryImportInput = {
      mode: 'initialize',
      replay: {
        history: [turn],
        turnHashes: hashes,
        replayDigest: hashText(hashes.join('\n')),
        hashVersion: 2,
        droppedNotifications: 0,
      },
    };
    let injected = false;
    const racing = createNativeSessionWriter({
      ...options(),
      client: {
        transactCas: client.transactCas.bind(client),
        applyDocPatch: async (...args) => {
          if (!injected) {
            injected = true;
            await rival.applyDocPatch(namespace, room, [
              {
                op: 'arr_splice',
                path: ['history'],
                at: 0,
                del: 0,
                items: [
                  {
                    id: 'peer',
                    role: 'user',
                    timestamp: 'synthetic',
                    items: [{ type: 'text', text: 'peer' }],
                  },
                ],
              },
            ]);
          }
          return await client.applyDocPatch(...args);
        },
      },
    });
    expect(await racing.applyHistoryImport(input)).toEqual({
      status: 'rejected',
      reason: { code: 'not_empty' },
    });
    expect(reader.history.readAll().map((entry) => entry.id)).toEqual(['peer']);
    await expect(client.readDoc(namespace, room, ['externalHistoryCursor'])).rejects.toMatchObject({
      code: 'invalid_patch',
    });
  });

  it('reports a lost import ACK as indeterminate while history and cursor remain inseparable', async () => {
    await client.applyDocPatch(namespace, room, [
      { op: 'arr_splice', path: ['history'], at: 0, del: 4, items: [] },
    ]);
    const turn: SessionTurn = {
      id: 'imported',
      role: 'user',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'imported' }],
    };
    const hashes = [hashHistoryEntryForVersion(turn, 2)];
    const uncertain = createNativeSessionWriter({
      ...options(),
      client: {
        transactCas: client.transactCas.bind(client),
        applyDocPatch: async (...args) => {
          await client.applyDocPatch(...args);
          throw new Error('disconnected after commit');
        },
      },
    });
    expect(
      await uncertain.applyHistoryImport({
        mode: 'initialize',
        replay: {
          history: [turn],
          turnHashes: hashes,
          replayDigest: hashText(hashes.join('\n')),
          hashVersion: 2,
          droppedNotifications: 0,
        },
      })
    ).toMatchObject({ status: 'indeterminate' });
    const stored = await exported();
    expect(
      stored
        .getList('history')
        .toJSON()
        .map((entry) => entry.id)
    ).toEqual(['imported']);
    expect(stored.getMap('externalHistoryCursor').toJSON()).toMatchObject({
      importedTurnHashes: hashes,
    });
  });

  it.each([false, true])(
    'preserves mixed inline/Map goals only with the verified literal artifact (enabled=%s)',
    async (enabled) => {
      const current = reader.history.readAt(1);
      if (current.state !== 'ready') throw new Error('Synthetic inline fixture is missing');
      await rival.applyDocPatch(
        namespace,
        room,
        [
          {
            op: 'set',
            path: ['history', 1],
            value: {
              ...current.turn,
              items: [
                ...(current.turn.items ?? []),
                {
                  type: 'goal',
                  threadId: 'cleared-old',
                  objective: 'Old synthetic goal',
                  status: 'cleared',
                },
              ],
            },
          },
        ],
        { docSchema: { ...LODY_SESSION_DOC_SCHEMA, defaultObject: 'value' } }
      );
      await rival.applyDocPatch(
        namespace,
        room,
        [
          { op: 'set', path: ['history', 2, 'finished'], value: true },
          { op: 'set', path: ['history', 3, 'finished'], value: true },
        ],
        { docSchema: LODY_SESSION_DOC_SCHEMA }
      );
      const before = reader.history.readAll();
      const checkpoint = reader.checkpoint();
      const compatibility = enabled
        ? await loadNativeRepoSdkCompatibility(import.meta.url)
        : undefined;
      if (enabled && !compatibility)
        throw new Error('This case requires the verified local SDK artifact');
      let inserted = false;
      const racingClient = {
        transactCas: client.transactCas.bind(client),
        applyDocPatch: async (...args: Parameters<RepoClient['applyDocPatch']>) => {
          if (!inserted) {
            inserted = true;
            await rival.applyDocPatch(
              namespace,
              room,
              [
                {
                  op: 'arr_splice',
                  path: ['history'],
                  at: 0,
                  del: 0,
                  items: [
                    {
                      id: 'concurrent-prefix',
                      role: 'system',
                      timestamp: 'synthetic',
                      items: [{ type: 'future-item', opaque: { retained: 'peer' } }],
                    },
                  ],
                },
              ],
              { docSchema: LODY_SESSION_DOC_SCHEMA }
            );
          }
          return client.applyDocPatch(...args);
        },
      };
      const command = enabled
        ? createNativeSessionWriter({ ...options(), client: racingClient, compatibility })
        : writer;
      const action = {
        kind: 'upsert-goal' as const,
        goal: {
          type: 'goal' as const,
          threadId: 'new-goal',
          objective: 'New synthetic goal',
          status: 'active' as const,
        },
        fallback: {
          id: 'goal-fallback',
          role: 'assistant' as const,
          timestamp: 'synthetic',
          items: [{ type: 'text' as const, text: 'Initial streaming text' }],
        },
      };
      if (!enabled) {
        await expect(command.applyHistoryAction(action)).rejects.toThrow(
          'unsupported_mixed_atomic_insertion'
        );
        expect(reader.checkpoint()).toEqual(checkpoint);
        expect(reader.history.readAll()).toEqual(before);
        expect(isContainer((await exported()).getList('history').get(1))).toBe(false);
        expect(reader.history.readTurn('goal-fallback')).toEqual({ state: 'missing' });
        return;
      }
      const prefixId = ((await exported()).getList('history').get(0) as LoroMap).id;
      await expect(command.applyHistoryAction(action)).resolves.toEqual({ matched: true });
      const stored = (await exported()).getList('history');
      expect((stored.get(1) as LoroMap).id).toBe(prefixId);
      expect(stored.get(0).toJSON()).toMatchObject({
        id: 'concurrent-prefix',
        items: [{ opaque: { retained: 'peer' } }],
      });
      expect(stored.get(2)).toMatchObject({
        id: 'duplicate',
        $cid: 'synthetic-inline-literal-cid',
        futureField: { retained: true },
        items: [{ type: 'future-item', opaque: { stored: 'inline' } }],
      });
      expect(isContainer(stored.get(2))).toBe(false);
      const fallback = stored.get(stored.length - 1) as LoroMap;
      expect(fallback.kind()).toBe('Map');
      const text = (fallback.get('items') as LoroList).get(0) as LoroMap;
      expect((text.get('text') as LoroText).kind()).toBe('Text');
      expect((text.get('text') as LoroText).toString()).toBe('Initial streaming text');
      expect(reader.history.readTurn('goal-fallback')).toMatchObject({
        state: 'ready',
        turn: {
          items: [{ text: 'Initial streaming text' }, { type: 'goal', threadId: 'new-goal' }],
        },
      });
    }
  );

  it('replaces a Map tail and conditionally rolls back its range while retaining later appends and a read acknowledgement', async () => {
    const input = await tailInput();
    const before = await exported();
    const prefix = before.getList('history').get(2) as LoroMap;
    const result = await writer.replaceEditableTail(input);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('Synthetic tail was refused');
    expect(result.previousUserTurnId).toBe('duplicate');
    await writer.appendTurn({
      id: 'later',
      role: 'system',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'later' }],
    });
    await writer.markTurnSeen('replacement');
    const later = (await exported()).getList('history').get(6) as LoroMap;
    await Promise.all([result.rollback(), result.rollback()]);
    const restored = (await exported()).getList('history');
    expect(restored.toJSON().map((entry) => entry.id)).toEqual([
      'duplicate',
      'duplicate',
      'unrelated',
      'permission',
      'provider-boundary',
      'old-tail-user',
      'old-tail-assistant',
      'later',
    ]);
    expect((restored.get(2) as LoroMap).id).toBe(prefix.id);
    expect((restored.get(7) as LoroMap).id).toBe(later.id);
    await expect(result.rollback()).rejects.toThrow('stale_rollback');
  });

  it('refuses compensation after an owned range was edited', async () => {
    const result = await writer.replaceEditableTail(await tailInput());
    if (result.status !== 'accepted') throw new Error('Synthetic tail was refused');
    await writer.applyHistoryAction({
      kind: 'user-status',
      turnId: 'replacement',
      status: 'processing',
    });
    await expect(result.rollback()).rejects.toThrow('stale_rollback');
    expect(reader.history.readTurn('replacement')).toMatchObject({
      state: 'ready',
      turn: { status: 'processing' },
    });
    expect(reader.history.readTurn('old-tail-user')).toEqual({ state: 'missing' });
  });

  it.each([false, true])(
    'conditionally restores a mixed old editable tail only with the verified literal artifact (enabled=%s)',
    async (enabled) => {
      await writer.appendTurn({
        id: 'provider-boundary',
        role: 'assistant',
        timestamp: 'synthetic',
        finished: true,
        acpTurnId: 'provider-turn',
        items: [],
      });
      await rival.applyDocPatch(
        namespace,
        room,
        [
          {
            op: 'arr_splice',
            path: ['history'],
            at: 5,
            del: 0,
            items: [
              {
                id: 'old-inline-user',
                role: 'user',
                timestamp: 'synthetic',
                items: [{ type: 'text', text: 'old inline' }],
              },
            ],
          },
        ],
        { docSchema: { ...LODY_SESSION_DOC_SCHEMA, defaultObject: 'value' } }
      );
      await writer.appendTurn({
        id: 'old-map-assistant',
        role: 'assistant',
        timestamp: 'synthetic',
        items: [{ type: 'text', text: 'old map' }],
      });
      const before = reader.history.readAll();
      const checkpoint = reader.checkpoint();
      const compatibility = enabled
        ? await loadNativeRepoSdkCompatibility(import.meta.url)
        : undefined;
      if (enabled && !compatibility)
        throw new Error('This case requires the verified local SDK artifact');
      const command = enabled ? createNativeSessionWriter({ ...options(), compatibility }) : writer;
      const result = await command.replaceEditableTail({
        expectedUserTurnId: 'old-inline-user',
        expectedForkTurnId: 'provider-turn',
        replacement: {
          id: 'replacement',
          role: 'user',
          timestamp: 'synthetic',
          items: [{ type: 'text', text: 'new' }],
        },
      });
      if (!enabled) {
        expect(result).toEqual({ status: 'rejected', reason: { code: 'unsupported' } });
        expect(reader.checkpoint()).toEqual(checkpoint);
        expect(reader.history.readAll()).toEqual(before);
        return;
      }
      expect(result.status).toBe('accepted');
      if (result.status !== 'accepted')
        throw new Error('Verified artifact did not accept the mixed tail');
      await result.rollback();
      expect(reader.history.readAll()).toEqual(before);
      const restored = (await exported()).getList('history');
      expect(isContainer(restored.get(5))).toBe(false);
      expect((restored.get(6) as LoroMap).kind()).toBe('Map');
      expect(
        ((restored.get(6) as LoroMap).get('items') as LoroList).get(0).get('text').kind()
      ).toBe('Text');
    }
  );

  it('uses the shared seen guard at commit time rather than regressing a processing turn', async () => {
    await rival.applyDocPatch(namespace, room, [
      { op: 'set', path: ['history', 0, 'status'], value: 'processing' },
    ]);
    // The newest duplicate remains pending, just like the existing targeted writer.
    expect(await writer.markTurnSeen('duplicate')).toBe(true);
    await writer.applyHistoryAction({
      kind: 'user-status',
      turnId: 'duplicate',
      status: 'processing',
    });
    expect(await writer.markTurnSeen('duplicate')).toBe(false);
    expect(reader.history.readTurn('duplicate')).toMatchObject({
      state: 'ready',
      turn: { status: 'processing' },
    });
  });
  it('streams a sparse Text tail without sending old bodies and retries each operation identity once', async () => {
    await writer.appendTurn({
      id: 'stream',
      role: 'assistant',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'prefix' }],
    });
    // A historical opaque item is stored ahead of the active tail.
    await client.applyDocPatch(namespace, room, [
      {
        op: 'arr_splice',
        path: ['history', 4, 'items'],
        at: 0,
        del: 0,
        items: [{ type: 'future-item', opaque: 'synthetic'.repeat(60000) }],
      },
    ]);
    const before = await exported();
    const tailId = (before.getList('history').get(4) as LoroMap).get('items') as LoroList;
    const textId = ((tailId.get(1) as LoroMap).get('text') as LoroText).id;
    const sent: unknown[] = [];
    const guarded = createNativeSessionWriter({
      ...options(),
      client: {
        transactCas: client.transactCas.bind(client),
        async applyDocPatch(ns, selected, patch, opts) {
          sent.push(patch);
          return client.applyDocPatch(ns, selected, patch, opts);
        },
      },
    });
    const input = {
      targetAssistantEntryId: 'stream',
      entryBound: true,
      operationIds: ['chunk-1'],
      notifications: [
        {
          sessionId: 'synthetic',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '🦜' } },
        },
      ],
    } as const;
    await guarded.applyAgentBatch(input);
    const checkpoint = reader.checkpoint();
    await guarded.applyAgentBatch(input);
    expect(reader.checkpoint()).toEqual(checkpoint);
    expect(JSON.stringify(sent).length).toBeLessThan(2000);
    const after = await exported();
    const items = (after.getList('history').get(4) as LoroMap).get('items') as LoroList;
    expect((items.get(1) as LoroMap).get('text')).toMatchObject({ id: textId });
    expect(((items.get(1) as LoroMap).get('text') as LoroText).toString()).toBe('prefix🦜');
    expect((items.get(0) as LoroMap).toJSON()).toMatchObject({
      type: 'future-item',
      opaque: 'synthetic'.repeat(60000),
    });
    await expect(
      guarded.applyAgentBatch({
        ...input,
        notifications: [
          {
            sessionId: 'synthetic',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'conflict' },
            },
          },
        ],
      })
    ).rejects.toMatchObject({ issues: [{ code: 'operation_identity_conflict' }] });
    expect(reader.checkpoint()).toEqual(checkpoint);
  });

  it('replans a streaming chunk after a concurrent CAS change without losing peer text', async () => {
    await writer.appendTurn({
      id: 'stream',
      role: 'assistant',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'start' }],
    });
    let raced = false;
    const guarded = createNativeSessionWriter({
      ...options(),
      client: {
        transactCas: client.transactCas.bind(client),
        async applyDocPatch(ns, selected, patch, opts) {
          if (!raced) {
            raced = true;
            await rival.applyDocPatch(namespace, room, [
              {
                op: 'str_splice',
                path: ['history', 4, 'items', 0, 'text'],
                at: 5,
                del: 0,
                ins: ':peer',
              },
            ]);
          }
          return client.applyDocPatch(ns, selected, patch, opts);
        },
      },
    });
    await guarded.applyAgentBatch({
      targetAssistantEntryId: 'stream',
      entryBound: true,
      operationIds: ['race-chunk'],
      notifications: [
        {
          sessionId: 'synthetic',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ':owner' },
          },
        },
      ],
    });
    expect(reader.history.readTurn('stream')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'start:peer:owner' }] },
    });
  });

  it('copies only from detached authoritative snapshots, preserving opaque stored data and target initialization', async () => {
    const snapshot = await writer.snapshots.capture();
    const selection = snapshot.history.filter((turn) => turn.id === 'permission');
    snapshot.history.length = 0;
    await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = Effect.runSync(Scope.make());
    const forkRoom = { kind: 'loro_doc' as const, id: 'session-fork' };
    await client.createRoom(namespace, forkRoom, 'plaintext', {
      docSchema: LODY_SESSION_DOC_SCHEMA,
    });
    const forkReader = await Effect.runPromise(
      Scope.provide(
        makeNativeSessionReader({ dataDir: directory, namespace, sessionId: 'fork', client }),
        scope
      )
    );
    const fork = createNativeSessionWriter({ ...options(), sessionId: 'fork', reader: forkReader });
    await fork.appendTurn({ id: 'initial', role: 'system', timestamp: 'synthetic', items: [] });
    await fork.snapshots.copyFrom(snapshot, selection as never);
    expect(forkReader.history.readAll()).toMatchObject([
      { id: 'permission', items: [{ permissionRequest: { futureField: { retained: true } } }] },
      { id: 'initial' },
    ]);
    const checkpoint = forkReader.checkpoint();
    await expect(fork.snapshots.copyFrom(snapshot, selection as never)).rejects.toMatchObject({
      issues: [{ code: 'copy_target_conflict' }],
    });
    await expect(
      fork.snapshots.copyFrom({ history: selection } as never, [] as never)
    ).rejects.toMatchObject({ issues: [{ code: 'invalid_snapshot' }] });
    expect(forkReader.checkpoint()).toEqual(checkpoint);
  });

  it('keeps child streaming in its original run while preserving unrelated root output and opaque child history', async () => {
    await writer.appendTurn({
      id: 'nested',
      role: 'assistant',
      timestamp: 'synthetic',
      acpTurnId: 'root-turn',
      items: [],
    });
    const emit = async (payload: Record<string, unknown>, identity: string) =>
      writer.applyAgentBatch({
        targetAssistantEntryId: 'nested',
        operationIds: [identity],
        notifications: [
          parseSessionNotification({
            sessionId: 'root',
            update: {
              sessionUpdate: 'subagent_event',
              event: { version: 1, sessionId: 'root', runId: 'child', ...payload },
            },
          }),
        ],
      });
    await emit(
      {
        type: 'snapshot',
        snapshot: {
          state: 'running',
          parentRunId: null,
          support: { stream: ['text', 'tool'], progress: false, cancel: false, outputRead: 'none' },
        },
      },
      'child-register'
    );
    await emit(
      {
        type: 'output',
        nativeTurnId: 'child-turn',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first' } },
      },
      'child-start'
    );
    const before = await exported();
    const task = ((before.getList('history').get(4) as LoroMap).get('items') as LoroList).get(
      0
    ) as LoroMap;
    const run = task.get('run') as LoroMap;
    const childItems = run.get('items') as LoroList;
    const childTextId = ((childItems.get(0) as LoroMap).get('text') as LoroText).id;
    await client.applyDocPatch(namespace, room, [
      {
        op: 'arr_splice',
        path: ['history', 4, 'items', 0, 'run', 'items'],
        at: 0,
        del: 0,
        items: [{ type: 'future-child', opaque: 'synthetic'.repeat(50000) }],
      },
    ]);
    const sent: unknown[] = [];
    const guarded = createNativeSessionWriter({
      ...options(),
      client: {
        transactCas: client.transactCas.bind(client),
        async applyDocPatch(ns, selected, patch, opts) {
          sent.push(patch);
          return client.applyDocPatch(ns, selected, patch, opts);
        },
      },
    });
    const notification = parseSessionNotification({
      sessionId: 'root',
      update: {
        sessionUpdate: 'subagent_event',
        event: {
          version: 1,
          sessionId: 'root',
          runId: 'child',
          type: 'output',
          nativeTurnId: 'child-turn',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ':next' },
          },
        },
      },
    });
    await guarded.applyAgentBatch({
      targetAssistantEntryId: 'nested',
      notifications: [notification],
    });
    expect(JSON.stringify(sent).length).toBeLessThan(2000);
    const after = await exported();
    const nextTask = ((after.getList('history').get(4) as LoroMap).get('items') as LoroList).get(
      0
    ) as LoroMap;
    const nextChildren = (nextTask.get('run') as LoroMap).get('items') as LoroList;
    expect(((nextChildren.get(1) as LoroMap).get('text') as LoroText).id).toBe(childTextId);
    expect(((nextChildren.get(1) as LoroMap).get('text') as LoroText).toString()).toBe(
      'first:next'
    );
    expect((after.getList('history').get(4) as LoroMap).get('acpTurnId')).toBe('root-turn');
    expect((nextChildren.get(0) as LoroMap).toJSON()).toMatchObject({
      type: 'future-child',
      opaque: 'synthetic'.repeat(50000),
    });
  });

  it('recovers a committed agent batch after a lost ACK and skips already accepted members of an overlapping retry', async () => {
    await writer.appendTurn({ id: 'stream', role: 'assistant', timestamp: 'synthetic', items: [] });
    let loseAck = true;
    const guarded = createNativeSessionWriter({
      ...options(),
      client: {
        transactCas: client.transactCas.bind(client),
        async applyDocPatch(ns, selected, patch, opts) {
          const result = await client.applyDocPatch(ns, selected, patch, opts);
          if (loseAck) {
            loseAck = false;
            throw new Error('synthetic lost ACK');
          }
          return result;
        },
      },
    });
    const chunk = (text: string) =>
      parseSessionNotification({
        sessionId: 'root',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      });
    await expect(
      guarded.applyAgentBatch({
        targetAssistantEntryId: 'stream',
        operationIds: ['first'],
        notifications: [chunk('first')],
      })
    ).rejects.toThrow('synthetic lost ACK');
    await guarded.applyAgentBatch({
      targetAssistantEntryId: 'stream',
      operationIds: ['first', 'second'],
      notifications: [chunk('first'), chunk(':second')],
    });
    expect(reader.history.readTurn('stream')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'first:second' }] },
    });
    const checkpoint = reader.checkpoint();
    await guarded.applyAgentBatch({
      targetAssistantEntryId: 'stream',
      operationIds: ['first', 'second'],
      notifications: [chunk('first'), chunk(':second')],
    });
    expect(reader.checkpoint()).toEqual(checkpoint);
  });
  it('serves the actual SessionBackend history/dispatch/fork and agent ports from one native owner', async () => {
    let initialized = false;
    const backend = createNativeSessionBackend({
      reader: () => {
        if (!initialized) throw new Error('Synthetic backend not initialized');
        return reader;
      },
      writer,
      host: {} as NativeSessionBackendHostPorts,
    });
    initialized = true;
    await backend.openAssistantTurn({
      turnId: 'backend-assistant',
      timestamp: '2026-01-01T00:00:00Z',
    });
    await backend.applyAgentBatch({
      targetAssistantEntryId: 'backend-assistant',
      entryBound: true,
      notifications: [
        parseSessionNotification({
          sessionId: 'synthetic',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Backend reply' },
          },
        }),
      ],
    });
    await backend.setPlan([{ content: 'Synthetic plan', priority: 'medium', status: 'pending' }]);
    expect(await backend.readTurn('backend-assistant')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'Backend reply' }], plan: [{ content: 'Synthetic plan' }] },
    });
    const dispatch = await backend.readDispatchSelection(
      ['duplicate'],
      (rows) => rows.find((entry) => entry.id === 'duplicate')?.id
    );
    expect(dispatch).toMatchObject({
      turnId: 'duplicate',
      turn: { state: 'ready', turn: { role: 'user' } },
    });
    expect(
      await backend.readHistorySelection((rows) =>
        rows.flatMap((entry, index) => (entry.id === 'backend-assistant' ? [index] : []))
      )
    ).toMatchObject([{ id: 'backend-assistant' }]);
    const snapshot = await backend.captureForkSnapshot();
    expect(snapshot.backendKind).toBe('loro');
    await expect(
      backend.importForkHistory({ ...snapshot, backendKind: 'roost' }, [])
    ).rejects.toThrow('Cannot import roost');
    await expect(
      backend.importForkHistory(snapshot, snapshot.history.slice(-1))
    ).rejects.toMatchObject({ issues: [{ code: 'copy_target_conflict' }] });
    expect(await backend.readHistoryCount()).toBe(5);
  });
});
