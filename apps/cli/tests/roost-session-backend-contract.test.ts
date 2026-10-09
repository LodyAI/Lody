import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoroRepo } from 'loro-repo';
import { SessionDocument } from '../src/lib/loro/doc';
import { installRoostNodeSessionBackend } from '../src/session/roost-node-session';
import { createSessionBackend, type SessionBackendFactory } from '../src/session/session-backend';
import { NodeLodyHistory } from '@loro-dev/roost/lody-history';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  getMachineRoomId,
  getSessionRoomId,
  SessionStatusFactory,
  type SessionId,
  type SessionHistoryInput,
} from '@lody/shared';
import { createCommandSessionHistoryFactory, type AuthContext } from '../src/lib/command-runtime';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import {
  hashHistoryEntryForVersion,
  hashText,
  type HistoryImportInput,
} from '@lody/shared/session-data';
import { Identity } from '@loro-dev/roost';
import { RoostNativeClient } from '@loro-dev/roost-node';
import { RoostHistoryGeneration } from '../src/session/roost-history-generation';
import { encodeRoostContent } from '../src/session/roost-history-port';
import type { SessionBackendContractFixtureFactory } from './session-backend-contract';
import { defineSessionBackendContract } from './session-backend-contract';
let nativeDirectory: string;
let ordinal = 0;
const nativeFixtures = new Set<{ close(): Promise<void> }>();
beforeAll(async () => {
  nativeDirectory = await mkdtemp(join(tmpdir(), 'lody-production-roost-'));
  installRoostNodeSessionBackend({
    dbPath: join(nativeDirectory, 'history.db'),
    seed: new Uint8Array(32).fill(39),
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const fixture of nativeFixtures) await fixture.close();
  await rm(nativeDirectory, { recursive: true, force: true });
});
const nativeUser = (id: string): SessionHistoryInput => ({
  id,
  role: 'user',
  userId: 'test-user',
  timestamp: '2026-10-09T00:00:00.000Z',
  status: 'pending',
  read: false,
  items: [{ type: 'text', text: id }],
  fileDiff: [],
});
const nativeAssistant = (id: string): SessionHistoryInput => ({
  id,
  role: 'assistant',
  timestamp: '2026-10-09T00:00:01.000Z',
  finished: false,
  items: [],
  fileDiff: [],
});
async function nativeFixture(
  id = `native-contract-${ordinal++}`,
  queued = false,
  factory?: SessionBackendFactory
) {
  const repo = await LoroRepo.create({});
  const sessionId = id as SessionId;
  await repo.upsertDocMeta(getSessionRoomId(sessionId), {
    id: sessionId,
    historyBackend: 'roost',
    userId: 'test-user',
    machineId: 'test-machine',
    status: SessionStatusFactory.idle(),
  });
  const doc = new SessionDocument(
    repo,
    sessionId,
    (room) => repo.unloadDoc(room),
    undefined,
    factory
  );
  doc.handle = await repo.openPersistedDoc(getSessionRoomId(sessionId));
  doc.composeSessionData(doc.handle.doc, undefined, { historyBackend: 'roost' });
  if (queued)
    await doc.pushMessageQueue({
      task: 'hello',
      userId: 'test-user',
      userTurnId: 'queue-turn',
      operationId: 'queue:queue-turn',
      timestamp: '2026-10-09T00:00:00.000Z',
      acpSessionConfig: {},
    });
  const backend = await createSessionBackend(doc, { historyBackend: 'roost' });
  let closed = false;
  const result = {
    repo,
    doc,
    backend,
    close: async () => {
      if (closed) return;
      closed = true;
      await doc.destroy({ preserveStatus: true });
      await repo.destroy();
      nativeFixtures.delete(result);
    },
  };
  nativeFixtures.add(result);
  return result;
}
const nativeContractFixture: SessionBackendContractFixtureFactory = async (options = {}) => {
  const fixture = await nativeFixture(undefined, true);
  const queueItem = (await fixture.backend.getMessageQueue())[0]!;
  let failed = false;
  const fail = (point: string) => {
    if (!failed && options.failOnceAt === point) {
      failed = true;
      throw new Error(`Injected ${point}`);
    }
  };
  const setRecord = fixture.doc.setQueuePromotionRecord.bind(fixture.doc);
  fixture.doc.setQueuePromotionRecord = async (id, record) => {
    await setRecord(id, record);
    const points = {
      prepared: 'prepared_receipt',
      history_accepted: 'history_receipt',
      activation_published: 'activation_receipt',
      queue_consumed: 'consumed_receipt',
    };
    if (record) fail(points[record.state]);
  };
  const append = fixture.backend.appendHistoryTurn.bind(fixture.backend);
  fixture.backend.appendHistoryTurn = async (entry) => {
    await append(entry);
    fail('history_acceptance');
  };
  const activate = fixture.doc.publishUserTurnActivation.bind(fixture.doc);
  fixture.doc.publishUserTurnActivation = async (id) => {
    await activate(id);
    fail('activation_publication');
  };
  const remove = fixture.doc.removeMessageQueueItem.bind(fixture.doc);
  fixture.doc.removeMessageQueueItem = async (cid) => {
    await remove(cid);
    fail('queue_consumption');
  };
  return {
    backend: fixture.backend,
    queueItem,
    entry: nativeUser(queueItem.userTurnId!),
    readCopies: async (id) =>
      (await fixture.backend.readHistory()).filter((entry) => entry.id === id),
    readQueueCids: async () => (await fixture.backend.getMessageQueue()).map((item) => item.$cid),
    readActivation: async () => (await fixture.doc.getMetaState())?.latestUserMsgId,
    readPromotionRecord: (id) => fixture.doc.getQueuePromotionRecord(id),
    dispose: fixture.close,
  };
};
defineSessionBackendContract('Production Roost SQLite', nativeContractFixture);

describe('Production Roost history semantics', () => {
  it('uses the target owner RPC factory instead of the installed native factory and propagates owner failures', async () => {
    const owner = await nativeFixture();
    await owner.backend.appendHistoryTurn(nativeUser('remote-u'));
    await owner.repo.upsertDocMeta(getMachineRoomId('test-machine'), {
      id: 'test-machine',
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    });
    const auth = {
      token: 'synthetic-cli-token',
      machineId: 'source-machine',
      userId: 'test-user',
    } as AuthContext;
    let denied = false;
    const factory = createCommandSessionHistoryFactory(
      () => ({ repo: owner.repo, waitUntilMetaSynced: async () => true }) as LoroDocumentManager,
      auth,
      'test-workspace',
      async (target, run) => {
        expect(target.machineId).toBe('test-machine');
        expect(target.auth).toBe(auth);
        return run({
          requestSessionHistoryRead: async (request: {
            sessionId: string;
            ownerSessionId: string;
          }) => {
            expect(request.sessionId).toBe(owner.doc.sessionId);
            expect(request.ownerSessionId).toBe(owner.doc.sessionId);
            return {
              type: 'session/history-read_response',
              sessionId: owner.doc.sessionId,
              success: !denied,
              ...(denied
                ? { error: 'Owner access refused' }
                : { result: await owner.backend.readHistory() }),
            };
          },
          requestSessionHistoryWrite: async (request: {
            sessionId: string;
            ownerSessionId: string;
            operation: string;
            payload: { entry: SessionHistoryInput };
          }) => {
            expect(request.ownerSessionId).toBe(owner.doc.sessionId);
            if (request.operation !== 'append') throw new Error('Unsupported test operation');
            await owner.backend.appendHistoryTurn(request.payload.entry);
            return {
              type: 'session/history-write_response',
              sessionId: owner.doc.sessionId,
              operation: request.operation,
              success: true,
              historyCount: await owner.backend.history.count(),
            };
          },
        } as never);
      }
    );
    const client = await nativeFixture(owner.doc.sessionId, false, factory);
    expect(await client.backend.readHistory()).toMatchObject([{ id: 'remote-u' }]);
    await client.backend.appendHistoryTurn(nativeUser('remote-added'));
    expect((await owner.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'remote-u',
      'remote-added',
    ]);
    denied = true;
    await expect(client.backend.readHistory()).rejects.toThrow('Owner access refused');
    expect((await owner.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'remote-u',
      'remote-added',
    ]);
  });

  it('publishes logical corrections to observers and keeps streaming reads bounded', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('observed-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('observed-a'));
    const changes: unknown[] = [];
    const observation = fixture.backend.history.observe((change) => changes.push(change));
    await observation.initial;
    const full = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
      .mockRejectedValue(new Error('Full hydration is forbidden'));
    const page = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage')
      .mockRejectedValue(new Error('Streaming branch reload is forbidden'));
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'observed-u',
      status: 'seen',
    });
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'observed-a',
      contents: [{ type: 'text', text: 'bounded output' }],
      operationIds: ['bounded-output'],
    });
    expect(await fixture.backend.readTurn('observed-a')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'bounded output' }] },
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        { kind: 'changed', ids: ['observed-u'] },
        { kind: 'changed', ids: ['observed-a'] },
      ])
    );
    observation.unsubscribe();
    const observed = [...changes];
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'observed-u',
      status: 'processing',
    });
    expect(changes).toEqual(observed);
    full.mockRestore();
    page.mockRestore();
  });

  it('allows concurrent readers to follow an atomic generation and fences the old writer', async () => {
    const seed = new Uint8Array(32).fill(39);
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'generation.db'),
      seed,
      allowedOwners: [owner],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    try {
      await client.ready;
      const writer = new RoostHistoryGeneration(client, owner, 'generation-race');
      const reader = new RoostHistoryGeneration(client, owner, 'generation-race');
      const old = reader.history;
      await writer.replace([nativeUser('generation-u')], 'generation-replace');
      await Promise.all([reader.resolve(), reader.resolve(), reader.resolve()]);
      expect(
        (await reader.history.readActiveBranch('generation-race')).messages.map(
          (row) => row.businessId
        )
      ).toEqual(['generation-u']);
      await expect(
        old.acceptToView({
          viewId: 'generation-race',
          expectedRevision: 0n,
          expectedHead: null,
          operationId: 'old-writer',
          input: {
            kind: 'message',
            businessId: 'stale-u',
            segmentId: 'primary',
            parents: [],
            content: encodeRoostContent(nativeUser('stale-u')),
          },
        })
      ).rejects.toMatchObject({ code: 'stale' });
      const cursor = await reader.history.observedEventCursor();
      await reader.history.accept({
        kind: 'publication',
        businessId: 'generation-race',
        segmentId: 'newer',
        parents: [],
        content: encodeRoostContent(null),
      });
      await expect(reader.replace([], 'stale-generation', cursor)).rejects.toMatchObject({
        code: 'stale',
      });
      expect(
        (await reader.history.readActiveBranch('generation-race')).messages.map(
          (row) => row.businessId
        )
      ).toEqual(['generation-u']);
    } finally {
      await client.close();
    }
  });

  it('copies opaque stored values into an empty target without validating them as newly authored items', async () => {
    const id = `opaque-${ordinal++}` as SessionId;
    const seed = new Uint8Array(32).fill(39);
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'history.db'),
      seed,
      allowedOwners: [owner],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    const opaque = {
      ...nativeUser('opaque-u'),
      extension: { version: 2 },
      items: [{ type: 'future_item', opaque: ['unchanged'] }],
    };
    try {
      await client.ready;
      await new RoostHistoryGeneration(client, owner, id).replace([opaque as never], 'stored-seed');
    } finally {
      await client.close();
    }
    const source = await nativeFixture(id);
    const target = await nativeFixture();
    const snapshot = await source.backend.captureForkSnapshot();
    await source.close();
    await target.backend.importForkHistory(snapshot, snapshot.history);
    expect(await target.backend.readHistory()).toEqual([opaque]);
    await target.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'opaque-u',
      status: 'seen',
    });
    expect(await target.backend.readHistory()).toMatchObject([
      { extension: opaque.extension, items: opaque.items, status: 'seen' },
    ]);
  });

  it('republishes a committed history correction after its control cursor write fails', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('cursor-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('cursor-a'));
    const before = await fixture.doc.getRoostHistoryCursor();
    const spy = vi
      .spyOn(fixture.doc, 'setRoostHistoryCursor')
      .mockRejectedValueOnce(new Error('Injected cursor failure'));
    await expect(
      fixture.backend.applyHistoryAction({
        kind: 'user-status',
        turnId: 'cursor-u',
        status: 'seen',
      })
    ).rejects.toThrow('Injected cursor failure');
    spy.mockRestore();
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'cursor-u',
      status: 'seen',
    });
    expect(await fixture.backend.readTurn('cursor-u')).toMatchObject({
      state: 'ready',
      turn: { status: 'seen' },
    });
    expect((await fixture.doc.getRoostHistoryCursor())?.historyRevision).toBeGreaterThan(
      before!.historyRevision!
    );
  });

  it('restores only the owned editable tail while retaining later appends and refuses concurrent edits', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('editable-u'));
    const result = await fixture.backend.replaceEditableTail({
      expectedUserTurnId: 'editable-u',
      expectedForkTurnId: undefined,
      replacement: nativeUser('replacement-u') as never,
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('Expected editable tail');
    await fixture.backend.appendHistoryTurn(nativeAssistant('later-a'));
    await result.rollback();
    expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'editable-u',
      'later-a',
    ]);
    const conflict = await nativeFixture();
    await conflict.backend.appendHistoryTurn(nativeUser('conflict-u'));
    const conflicting = await conflict.backend.replaceEditableTail({
      expectedUserTurnId: 'conflict-u',
      expectedForkTurnId: undefined,
      replacement: nativeUser('changed-u') as never,
    });
    if (conflicting.status !== 'accepted') throw new Error('Expected editable tail');
    await conflict.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: { ...nativeUser('changed-u'), items: [{ type: 'text', text: 'peer edit' }] } as never,
    });
    await expect(conflicting.rollback()).rejects.toThrow('rollback_conflict');
    expect(await conflict.backend.readTurn('changed-u')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'peer edit' }] },
    });
  });

  it('keeps an import baseline with its native commit when the Loro cursor projection fails', async () => {
    const fixture = await nativeFixture();
    const entry = { ...nativeUser('import-u'), status: 'handled' as const, read: true };
    const hashes = [hashHistoryEntryForVersion(entry as never, 2)];
    const input: HistoryImportInput = {
      mode: 'initialize',
      replay: {
        history: [entry as never],
        turnHashes: hashes,
        replayDigest: hashText(hashes.join('\n')),
        hashVersion: 2,
        droppedNotifications: 0,
      },
    };
    const spy = vi
      .spyOn(fixture.doc, 'setExternalHistoryCursor')
      .mockRejectedValueOnce(new Error('Injected import cursor failure'));
    expect(await fixture.backend.applyHistoryImport(input)).toMatchObject({
      status: 'indeterminate',
    });
    spy.mockRestore();
    await fixture.close();
    const reopened = await nativeFixture(fixture.doc.sessionId);
    expect(
      await reopened.backend.applyHistoryImport({
        ...input,
        mode: 'refresh',
        externalHistory: {
          importedTurnCount: 1,
          importedTurnHashes: hashes,
          replayDigest: input.replay.replayDigest,
          hashVersion: 2,
        },
      })
    ).toMatchObject({ status: 'accepted', appended: 0 });
    expect(await reopened.backend.readHistory()).toMatchObject([{ id: 'import-u' }]);
    expect((await reopened.doc.getExternalHistoryCursor())?.importedTurnHashes).toEqual(hashes);
  });

  it('continues a permission-bearing assistant with sparse tool updates and text', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('live-permission-a'),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'live-tool',
          status: 'pending',
          permissionRequest: {
            requestId: 'live-request',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        },
      ],
    });
    expect(
      await fixture.backend.respondPermission('live-request', {
        outcome: 'selected',
        optionId: 'allow',
      })
    ).toBe(true);
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'live-permission-a',
      notifications: [
        {
          sessionId: 'acp-test',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'live-tool',
            status: 'completed',
          },
        },
        {
          sessionId: 'acp-test',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'continued after approval' },
          },
        },
      ],
      operationIds: ['permission-tool-update', 'permission-text-update'],
    });
    expect(await fixture.backend.readTurn('live-permission-a')).toMatchObject({
      state: 'ready',
      turn: {
        finished: false,
        items: [
          {
            status: 'completed',
            permissionRequest: { outcome: { outcome: 'selected', optionId: 'allow' } },
          },
          { text: 'continued after approval' },
        ],
      },
    });
    await fixture.close();
    expect(
      await (await nativeFixture(fixture.doc.sessionId)).backend.readTurn('live-permission-a')
    ).toMatchObject({
      state: 'ready',
      turn: {
        items: [
          { permissionRequest: { outcome: { optionId: 'allow' } } },
          { text: 'continued after approval' },
        ],
      },
    });
  });

  it('keeps a sealed user status correction separate from ongoing assistant output, including reopen', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('a'));
    await fixture.backend.applyHistoryAction({ kind: 'user-status', turnId: 'u', status: 'seen' });
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'u',
      status: 'processing',
    });
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'a',
      contents: [{ type: 'text', text: 'continued' }],
      operationIds: ['status-output'],
    });
    expect(await fixture.backend.readHistory()).toMatchObject([
      { id: 'u', status: 'processing' },
      { id: 'a', items: [{ type: 'text', text: 'continued' }], finished: false },
    ]);
    await fixture.close();
    const reopened = await nativeFixture(fixture.doc.sessionId);
    expect(await reopened.backend.readHistory()).toMatchObject([
      { id: 'u', status: 'processing' },
      { id: 'a', items: [{ type: 'text', text: 'continued' }] },
    ]);
  });

  it('answers an older permission by request id and continues the current assistant', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('permission-a'),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'tool',
          status: 'pending',
          permissionRequest: {
            requestId: 'native-request',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        },
      ],
    });
    await fixture.backend.appendHistoryTurn(nativeAssistant('current-a'));
    expect(
      await fixture.backend.respondPermission('native-request', {
        outcome: 'selected',
        optionId: 'allow',
      })
    ).toBe(true);
    expect(
      await fixture.backend.respondPermission('native-request', {
        outcome: 'selected',
        optionId: 'allow',
      })
    ).toBe(false);
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'current-a',
      contents: [{ type: 'text', text: 'current output' }],
      operationIds: ['permission-current-output'],
    });
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'permission-a',
      contents: [{ type: 'text', text: 'tool finished' }],
      operationIds: ['permission-late-output'],
    });
    expect(await fixture.backend.readTurn('permission-a')).toMatchObject({
      state: 'ready',
      turn: {
        items: [
          { permissionRequest: { outcome: { outcome: 'selected', optionId: 'allow' } } },
          { type: 'text', text: 'tool finished' },
        ],
      },
    });
    expect(await fixture.backend.readTurn('current-a')).toMatchObject({
      state: 'ready',
      turn: { finished: false, items: [{ text: 'current output' }] },
    });
  });

  it('copies a held source snapshot with a new Fork notice before target initialization', async () => {
    const source = await nativeFixture();
    const target = await nativeFixture();
    await source.backend.appendHistoryTurn(nativeUser('fork-u'));
    await target.backend.appendHistoryTurn({ ...nativeAssistant('target-init'), role: 'system' });
    const snapshot = await source.backend.captureForkSnapshot();
    await source.close();
    snapshot.history[0]!.items![0] = { type: 'text', text: 'authored copy' };
    await target.backend.importForkHistory(snapshot, [
      ...snapshot.history,
      {
        id: 'fork-origin',
        role: 'system',
        timestamp: '2026-10-09T00:00:00.000Z',
        items: [
          {
            type: 'system_notice',
            name: 'session_fork_origin',
            meta: {
              sourceSessionId: source.doc.sessionId,
              sourceTurnId: 'fork-u',
              sourceTitle: 'Source session',
            },
          },
        ],
        fileDiff: [],
      },
    ]);
    expect((await target.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'fork-u',
      'fork-origin',
      'target-init',
    ]);
    await expect(target.backend.importForkHistory(snapshot, snapshot.history)).rejects.toThrow(
      'copy_target_conflict'
    );
    await expect(
      target.backend.importForkHistory({ ...snapshot, storageSnapshot: { history: [] } }, [])
    ).rejects.toThrow('invalid_snapshot');
  });

  it('leaves the old branch intact if preparing a structural replacement fails', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('old-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('old-a'));
    const before = await fixture.backend.readHistory();
    const original = NodeLodyHistory.prototype.acceptToView;
    let stages = 0;
    const spy = vi
      .spyOn(NodeLodyHistory.prototype, 'acceptToView')
      .mockImplementation(async function (input) {
        if (input.operationId.startsWith('stage:') && ++stages === 2)
          throw new Error('Injected stage failure');
        return original.call(this, input);
      });
    await expect(
      fixture.backend.applyHistoryAction({
        kind: 'upsert-turn',
        turn: nativeUser('insert-u') as never,
        beforeTurnId: 'old-u',
      })
    ).rejects.toThrow('Injected stage failure');
    spy.mockRestore();
    expect(await fixture.backend.readHistory()).toEqual(before);
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: nativeUser('insert-u') as never,
      beforeTurnId: 'old-u',
    });
    await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'old-u' });
    expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'insert-u',
      'old-a',
    ]);
    await fixture.close();
    expect(
      (await (await nativeFixture(fixture.doc.sessionId)).backend.readHistory()).map(
        (entry) => entry.id
      )
    ).toEqual(['insert-u', 'old-a']);
  });

  it('refreshes count and position reads after a committed generation loses its reply', async () => {
    const source = await nativeFixture();
    for (const id of ['copied-one', 'copied-two', 'copied-three'])
      await source.backend.appendHistoryTurn(nativeUser(id));
    const snapshot = await source.backend.captureForkSnapshot();
    for (const reader of ['count', 'readAt', 'readDirectory'] as const) {
      const target = await nativeFixture();
      await target.backend.appendHistoryTurn(nativeUser('target-u'));
      await target.backend.appendHistoryTurn(nativeAssistant('target-a'));
      const original = RoostHistoryGeneration.prototype.replace;
      const spy = vi
        .spyOn(RoostHistoryGeneration.prototype, 'replace')
        .mockImplementationOnce(async function (...args) {
          await original.apply(this, args);
          throw new Error('Injected lost activation reply');
        });
      await expect(target.backend.importForkHistory(snapshot, snapshot.history)).rejects.toThrow(
        'Injected lost activation reply'
      );
      spy.mockRestore();
      if (reader === 'count') expect(await target.backend.history.count()).toBe(5);
      if (reader === 'readAt')
        expect(await target.backend.history.readAt(4)).toMatchObject({
          state: 'ready',
          turn: { id: 'target-a' },
        });
      if (reader === 'readDirectory')
        expect(await target.backend.history.readDirectory(4, 5)).toMatchObject([
          { position: 4, turnId: 'target-a' },
        ]);
      await target.backend.flushLocalWrites();
      expect(await target.doc.getRoostHistoryCursor()).toMatchObject({ historyCount: 5 });
      expect((await target.backend.readHistory()).map((entry) => entry.id)).toEqual([
        'copied-one',
        'copied-two',
        'copied-three',
        'target-u',
        'target-a',
      ]);
    }
  });

  it('deduplicates durable per-item retries and retains identical output with different identities', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('retry-a'),
      items: [{ type: 'text', text: 'start:' }],
    });
    const original = NodeLodyHistory.prototype.commitHistoryBatch;
    const spy = vi
      .spyOn(NodeLodyHistory.prototype, 'commitHistoryBatch')
      .mockImplementationOnce(async function (...args) {
        await original.apply(this, args);
        throw new Error('Injected lost native reply');
      });
    const input = {
      targetAssistantEntryId: 'retry-a',
      notifications: [
        {
          sessionId: 'acp-test',
          update: {
            sessionUpdate: 'agent_message_chunk' as const,
            content: { type: 'text' as const, text: 'same' },
          },
        },
      ],
      operationIds: ['output-once'],
    };
    await expect(fixture.backend.applyAgentBatch(input)).rejects.toThrow(
      'Injected lost native reply'
    );
    spy.mockRestore();
    await fixture.backend.applyAgentBatch(input);
    await fixture.backend.applyAgentBatch({ ...input, operationIds: ['output-twice'] });
    expect(await fixture.backend.readTurn('retry-a')).toMatchObject({
      state: 'ready',
      turn: { items: [{ type: 'text', text: 'start:samesame' }] },
    });
    await expect(
      fixture.backend.applyAgentBatch({
        ...input,
        notifications: [
          {
            sessionId: 'acp-test',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'changed' },
            },
          },
        ],
      })
    ).rejects.toThrow('identity conflict');
  });
});
