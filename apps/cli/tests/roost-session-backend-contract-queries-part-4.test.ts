import {
  buildReplayPromptFromHistory,
  createReplayPromptBuilder,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  getMachineRoomId,
  resolveLatestSessionGoalFromHistory,
  SessionHistoryReadQuerySchema,
  type SessionGoalMessage,
  type SessionHistoryInput,
  type SessionHistoryReadQuery,
  type SessionId,
} from '@lody/shared';
import { readSessionHistoryMetadata } from '@lody/shared/session-data';
import { Identity } from '@loro-dev/roost';
import { RoostHostError, RoostNativeClient } from '@loro-dev/roost-node';
import { NodeLodyHistory } from '@loro-dev/roost/lody-history';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCommandSessionHistoryFactory, type AuthContext } from '../src/lib/command-runtime';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import { RoostDispatchIndex } from '../src/session/roost-dispatch-index';
import { RoostHistoryGeneration } from '../src/session/roost-history-generation';
import { loadRoostOwnerSeedLegacy } from '../src/session/roost-writer-identity';
import {
  createSessionBackend,
  disposeSessionBackend,
  type SessionBackendFactory,
} from '../src/session/session-backend';
import { assertOwnerInspection } from './roost-session-backend-contract-queries-helpers';
import {
  coldHistoryHandlerFixture,
  nativeAssistant,
  nativeDirectory,
  nativeFixture,
  nativeUser,
  registerRoostNativeBackendSuite,
} from './roost-session-backend-test-helpers';

registerRoostNativeBackendSuite();

it('reselects the latest row when metadata changes between the two owner requests', async () => {
  const fixture = await coldHistoryHandlerFixture(1);
  const sessionId = [...fixture.docs.keys()][0]!;
  let client: Awaited<ReturnType<SessionBackendFactory>> | undefined;
  try {
    await fixture.ready(sessionId);
    await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'append', {
      entry: nativeUser('first-choice'),
    });
    const doc = fixture.docs.get(sessionId)!;
    const owner = await createSessionBackend(doc);
    await fixture.repo.upsertDocMeta(getMachineRoomId('test-machine'), {
      id: 'test-machine',
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    });
    let changed = false;
    const factory = createCommandSessionHistoryFactory(
      () => ({ repo: fixture.repo, isEncryptedWorkspace: () => false }) as LoroDocumentManager,
      { userId: 'test-user', machineId: 'test-machine', token: 'synthetic-token' } as AuthContext,
      'test-workspace',
      async (_target, run) =>
        run({
          requestSessionHistoryRead: async (request: {
            sessionId: SessionId;
            query: SessionHistoryReadQuery;
          }) => {
            const query = SessionHistoryReadQuerySchema.parse(request.query);
            if (query.kind === 'readAll')
              throw new Error('Whole-history fallback is forbidden for this owner');
            if (query.kind === 'readSelection' && !changed) {
              changed = true;
              await owner.appendHistoryTurn(nativeUser('new-choice'));
            }
            return fixture.rpc.readSessionHistoryForRpc(request.sessionId, query);
          },
        } as never)
    );
    client = await factory(doc, await doc.getMetaState());
    expect(await client.readHistorySelection((rows) => [rows.length - 1])).toEqual([
      nativeUser('new-choice'),
    ]);
  } finally {
    await client?.dispose();
    await fixture.close();
  }
});

it('visibility changes, state programs, sparse aliases and reopen', async () => {
  let fixture = await nativeFixture();
  const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
  const owner = Identity.fromSeed(seed).owner();
  const client = new RoostNativeClient({
    dbPath: join(nativeDirectory, 'history.db'),
    seed,
    allowedOwners: [owner],
    maxQueuedRequests: 32,
    maxQueuedBytes: 8 * 1024 * 1024,
  });
  try {
    await client.ready;
    await new RoostHistoryGeneration(client, owner, fixture.doc.sessionId).replace(
      [
        {
          ...nativeAssistant('future-item'),
          finished: true,
          items: [{ type: 'future-item-type', opaque: 'synthetic' }],
        } as never,
      ],
      'unknown-stored-seed'
    );
  } finally {
    await client.close();
  }
  await fixture.backend.flushLocalWrites();
  await fixture.backend.appendHistoryTurn({
    ...nativeUser('visibility-user'),
    status: 'handled',
    read: true,
    items: [{ type: 'text', text: ' ' }],
  });
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('visibility-assistant'),
    items: [{ type: 'text', text: ' \n ' }],
  });
  await assertOwnerInspection(fixture);
  await fixture.backend.applyAgentBatch({
    targetAssistantEntryId: 'visibility-assistant',
    contents: [{ type: 'text', text: 'visible 😀 text' }],
    operationIds: ['visibility-fragment'],
  });
  await assertOwnerInspection(fixture);
  const setText = async (text: string) => {
    const read = await fixture.backend.readTurn('visibility-assistant');
    if (read.state !== 'ready') throw new Error('Missing assistant');
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: { ...read.turn, items: [{ type: 'text', text }] } as SessionHistoryInput,
    });
    await assertOwnerInspection(fixture);
  };
  await setText('');
  await setText('A😀B');
  await fixture.backend.applyHistoryAction({
    kind: 'finish-assistant',
    turnId: 'visibility-assistant',
    endedAt: 42,
  });
  await setText('long sealed state 😀 replacement');
  await setText(' \n ');
  await setText('state visible again');
  await fixture.backend.appendHistoryTurn({
    ...nativeUser('visibility-images'),
    status: 'handled',
    read: true,
    items: [
      {
        type: 'image_group',
        images: [{ imageId: 'synthetic-image', mimeType: 'image/png', sizeBytes: 1 }],
      },
    ],
  });
  await assertOwnerInspection(fixture);
  await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'visibility-user' });
  await assertOwnerInspection(fixture);
  await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'visibility-assistant' });
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('visibility-assistant'),
    items: [{ type: 'text', text: 'reinserted physical alias' }],
  });
  await assertOwnerInspection(fixture);
  const id = fixture.doc.sessionId;
  await fixture.close();
  fixture = await nativeFixture(id);
  await assertOwnerInspection(fixture);
});

it('external text change supersedes cached visibility and body selection', async () => {
  const fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn({
    ...nativeUser('foreign-visible'),
    status: 'handled',
    read: true,
  });
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('foreign-hidden'),
    finished: true,
    items: [{ type: 'text', text: ' ' }],
  });
  await assertOwnerInspection(fixture);
  const peer = await nativeFixture(fixture.doc.sessionId);
  const original = NodeLodyHistory.prototype.readActiveBranchMessages;
  let injected = false;
  const selected = vi
    .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages')
    .mockImplementation(async function (...args) {
      if (!injected) {
        injected = true;
        await peer.backend.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            ...nativeAssistant('foreign-hidden'),
            finished: true,
            items: [{ type: 'text', text: 'foreign state is now visible' }],
          },
        });
      }
      return original.apply(this, args);
    });
  try {
    const response = await fixture.backend.readHistoryInspection!({
      kind: 'readTranscript',
      limit: 3,
    });
    expect(injected).toBe(true);
    expect(response.success).toBe(true);
    expect(
      (response.result as { entries: SessionHistoryInput[] }).entries.map((row) => row.id)
    ).toEqual(['foreign-visible', 'foreign-hidden']);
  } finally {
    selected.mockRestore();
  }
  await assertOwnerInspection(fixture);
});

it.each(['indexRead', 'indexCompareWrite'])(
  'optional visibility cache %s failure preserves reads',
  async (method) => {
    let fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeUser('cache-fault-u'),
      status: 'handled',
      read: true,
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('cache-fault-a'),
      items: [{ type: 'text', text: 'unchanged visible body' }],
    });
    await fixture.backend.readHistoryQuery();
    const savedId = fixture.doc.sessionId;
    await fixture.close();
    fixture = await nativeFixture(savedId);
    const original = RoostNativeClient.prototype.request;
    let injected = false;
    RoostNativeClient.prototype.request = function (...args) {
      const command = args[0] as unknown as {
        method: string;
        keys?: { table: string }[];
        changes?: { table: string }[];
      };
      if (
        command.method === method &&
        (command.keys ?? command.changes ?? []).some(
          (row) => row.table === 'lody_transcript_visibility_v1'
        )
      ) {
        injected = true;
        return Promise.reject(new RoostHostError('storage'));
      }
      return original.apply(this, args);
    };
    try {
      await assertOwnerInspection(fixture);
      expect(injected).toBe(true);
    } finally {
      RoostNativeClient.prototype.request = original;
    }
  }
);

it('reopening after an older writer ignores stale visibility', async () => {
  let fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn({
    ...nativeUser('legacy-writer-u'),
    status: 'handled',
    read: true,
  });
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('legacy-writer-a'),
    items: [{ type: 'text', text: ' ' }],
  });
  await assertOwnerInspection(fixture);
  const original = RoostDispatchIndex.prototype.plan;
  RoostDispatchIndex.prototype.plan = async function (...args) {
    const plan = await original.apply(this, args);
    plan.puts = plan.puts.filter((row) => row.table !== 'lody_transcript_visibility_v1');
    delete (plan as unknown as { nextVisibility?: unknown }).nextVisibility;
    return plan;
  };
  try {
    const read = await fixture.backend.readTurn('legacy-writer-a');
    if (read.state !== 'ready') throw new Error('Missing prior');
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: {
        ...read.turn,
        items: [{ type: 'text', text: 'older writer made this visible' }],
      } as SessionHistoryInput,
    });
  } finally {
    RoostDispatchIndex.prototype.plan = original;
  }
  const id = fixture.doc.sessionId;
  await fixture.close();
  fixture = await nativeFixture(id);
  await assertOwnerInspection(fixture);
});

it.each(['active', 'paused', 'cleared'] as const)(
  'certified goal %s matches the complete projection',
  async (status) => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeUser(`goal-user-${status}`),
      status: 'handled',
      read: true,
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant(`goal-assistant-${status}`),
      finished: true,
      items: [
        { type: 'goal', threadId: 'certified-goal', objective: 'Synthetic goal objective', status },
      ],
    });
    const expected = resolveLatestSessionGoalFromHistory(await fixture.backend.readHistory());
    expect(
      (await fixture.backend.readHistoryInspection!({ kind: 'readLatestGoal' })).result
    ).toEqual(expected);
    expect(await fixture.backend.readLatestGoal()).toEqual(expected);
    const id = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(id);
    expect(
      (await reopened.backend.readHistoryInspection!({ kind: 'readLatestGoal' })).result
    ).toEqual(expected);
    expect(await reopened.backend.readLatestGoal()).toEqual(expected);
  }
);

it('serves certified goals and replay when the unrelated field index is unavailable', async () => {
  const fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn(nativeUser('independent-user'));
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('independent-goal'),
    finished: true,
    items: [
      { type: 'goal', threadId: 'independent', objective: 'Synthetic objective', status: 'active' },
    ],
  });
  const complete = await fixture.backend.readHistory();
  vi.spyOn(RoostDispatchIndex.prototype, 'checkpoint').mockResolvedValue(undefined);
  vi.spyOn(RoostDispatchIndex.prototype, 'rebuild').mockRejectedValue(
    new Error('Unrelated field index unavailable')
  );
  expect(await fixture.backend.readLatestGoal()).toEqual(
    resolveLatestSessionGoalFromHistory(complete)
  );
  expect((await fixture.backend.readHistoryInspection!({ kind: 'readLatestGoal' })).result).toEqual(
    resolveLatestSessionGoalFromHistory(complete)
  );
  const replay = buildReplayPromptFromHistory({ history: complete });
  expect(await fixture.backend.readHistoryReplay?.()).toEqual(replay);
  expect(
    (await fixture.backend.readHistoryInspection!({ kind: 'readReplayPrompt' })).result
  ).toEqual(replay);
  expect(
    (
      await fixture.backend.foldHistory(
        () => createReplayPromptBuilder(),
        (builder, entry) => builder.add(entry)
      )
    ).finish()
  ).toEqual(replay);
});

it.each(
  (['replay', 'fold'] as const).flatMap((operation) =>
    (['page', 'first-body', 'last-body'] as const).map((pauseAt) => ({ operation, pauseAt }))
  )
)(
  'stops $operation after the pending $pauseAt read settles on close and drains accepted writes',
  async ({ operation, pauseAt }) => {
    const fixture = await nativeFixture();
    const entries = [nativeUser('close-user'), nativeAssistant('close-assistant')];
    for (const entry of entries) await fixture.backend.appendHistoryTurn(entry);
    const original = await fixture.backend.readHistory();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closingStarted = Promise.withResolvers<void>();
    const members = NodeLodyHistory.prototype.readActiveBranchMembers;
    const messages = NodeLodyHistory.prototype.readActiveBranchMessages;
    let paused = false;
    const pause = async () => {
      if (paused) return;
      paused = true;
      entered.resolve();
      await release.promise;
    };
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMembers').mockImplementation(
      async function (...args) {
        const page = await members.apply(this, args);
        if (pauseAt === 'page' && args[1]?.from === 0) await pause();
        return page;
      }
    );
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages').mockImplementation(
      async function (...args) {
        const page = await messages.apply(this, args);
        const target = pauseAt === 'first-body' ? entries[0]!.id : entries[1]!.id;
        if (pauseAt !== 'page' && args[1].includes(target)) await pause();
        return page;
      }
    );
    const dispose = fixture.backend.dispose!.bind(fixture.backend);
    vi.spyOn(fixture.backend, 'dispose').mockImplementation(async () => {
      const closing = dispose();
      closingStarted.resolve();
      await closing;
    });
    const visited: string[] = [];
    const read = (
      operation === 'replay'
        ? fixture.backend.readHistoryReplay!()
        : fixture.backend.foldHistory(
            () => visited,
            (ids, entry) => {
              ids.push(entry.id);
            }
          )
    ).then(
      (value) => ({ status: 'ready' as const, value }),
      (error: unknown) => ({ status: 'failed' as const, error })
    );
    let closing: Promise<void> | undefined;
    let write: Promise<void> | undefined;
    let closed = false;
    const appended = nativeUser('close-accepted-write');
    try {
      await entered.promise;
      write = fixture.backend.appendHistoryTurn(appended);
      closing = disposeSessionBackend(fixture.doc).then(() => {
        closed = true;
      });
      await closingStarted.promise;
      expect(closed).toBe(false);
      release.resolve();
      const result = await read;
      expect(result).toMatchObject({
        status: 'failed',
        error: new Error('Roost session backend is disposed'),
      });
      if (operation === 'fold')
        expect(visited).toEqual(pauseAt === 'last-body' ? [entries[0]!.id] : []);
      await write;
      await closing;
      expect(closed).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([read, ...(write ? [write] : []), ...(closing ? [closing] : [])]);
      vi.restoreAllMocks();
      await fixture.close();
    }
    const reopened = await nativeFixture(fixture.doc.sessionId);
    expect(await reopened.backend.readHistory()).toEqual([...original, appended]);
    await reopened.close();
  }
);

it('reuses unchanged transcript visibility while recalculating a written tail', async () => {
  const fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn({
    ...nativeUser('visibility-prefix'),
    status: 'handled',
    read: true,
  });
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('visibility-live'),
    items: [{ type: 'text', text: ' ' }],
  });
  const before = await fixture.backend.readHistoryQuery({ transcriptVisibility: true });
  const original = NodeLodyHistory.prototype.lookupMember;
  vi.spyOn(NodeLodyHistory.prototype, 'lookupMember').mockImplementation(function (identity) {
    if (identity.businessId === 'visibility-prefix')
      throw new Error('Unchanged visibility unavailable');
    return original.call(this, identity);
  });
  await fixture.backend.applyAgentBatch({
    targetAssistantEntryId: 'visibility-live',
    contents: [{ type: 'text', text: 'now visible' }],
    operationIds: ['visible-tail-write'],
  });
  const response = await fixture.backend.readHistoryInspection!({
    kind: 'readTranscript',
    limit: 1,
  });
  expect(response.result).toMatchObject({
    total: 2,
    positions: [1],
    entries: [{ id: 'visibility-live', items: [{ type: 'text', text: ' now visible' }] }],
  });
  const after = await fixture.backend.readHistoryQuery({ transcriptVisibility: true });
  expect(after[0]).toEqual(before[0]);
  expect(after[1]?.items?.[0]).toMatchObject({ _textNonBlank: true });
});

it('retains state overlays while reusing the field projection after membership changes', async () => {
  const fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn(nativeUser('retained-status'));
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('retained-finish'),
    userTurnId: 'retained-status',
  });
  await fixture.backend.applyHistoryAction({
    kind: 'user-status',
    turnId: 'retained-status',
    status: 'handled',
  });
  await fixture.backend.applyHistoryAction({
    kind: 'finish-assistant',
    turnId: 'retained-finish',
    endedAt: 84,
  });
  for (let index = 0; index < 65; index++)
    await fixture.backend.appendHistoryTurn({
      ...nativeUser(`membership-${index}`),
      status: 'handled',
    });
  const before = await fixture.backend.readHistory();
  await fixture.backend.readHistoryQuery();
  await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'membership-3' });
  const rediscovery = vi
    .spyOn(RoostDispatchIndex.prototype, 'rebuild')
    .mockRejectedValue(new Error('Repeated field discovery unavailable'));
  const rows = await readSessionHistoryMetadata(fixture.backend.history);
  expect(rows.map((row) => row.id)).toEqual(
    before.filter((row) => row.id !== 'membership-3').map((row) => row.id)
  );
  expect(rows[0]).toMatchObject({ id: 'retained-status', status: 'handled' });
  expect(rows[1]).toMatchObject({ id: 'retained-finish', finished: true, endedAt: 84 });
  expect(await fixture.backend.readDispatchHistory(['retained-status'])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'retained-status', status: 'handled' }),
      expect.objectContaining({ id: 'retained-finish', endedAt: 84 }),
    ])
  );
  rediscovery.mockRestore();
  vi.spyOn(RoostDispatchIndex.prototype, 'checkpoint').mockResolvedValueOnce(undefined);
  expect(await readSessionHistoryMetadata(fixture.backend.history)).toEqual(rows);
  expect((await fixture.backend.readHistory()).slice(0, 2)).toMatchObject([
    { id: 'retained-status', status: 'handled' },
    { id: 'retained-finish', finished: true, endedAt: 84 },
  ]);
});

it('rediscovers fields after an external write interrupts structural projection reuse', async () => {
  const fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn(nativeUser('rebase-user'));
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('rebase-output'),
    items: [{ type: 'text', text: 'before' }],
  });
  await fixture.backend.appendHistoryTurn(nativeUser('rebase-remove'));
  await fixture.backend.readHistoryQuery();
  const peer = await nativeFixture(fixture.doc.sessionId);
  const original = RoostDispatchIndex.prototype.rebuild;
  let injected = false;
  vi.spyOn(RoostDispatchIndex.prototype, 'rebuild').mockImplementation(
    async function (cursor, count, pages, verify) {
      const interleaved = async function* () {
        for await (const page of pages) {
          if (!injected) {
            injected = true;
            await peer.backend.applyHistoryAction({
              kind: 'user-status',
              turnId: 'rebase-user',
              status: 'handled',
            });
          }
          yield page;
        }
      };
      return original.call(this, cursor, count, interleaved(), verify);
    }
  );
  await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'rebase-remove' });
  expect(injected).toBe(true);
  const rows = await readSessionHistoryMetadata(fixture.backend.history);
  expect(rows.map((row) => row.id)).toEqual(['rebase-user', 'rebase-output']);
  expect(rows[0]).toMatchObject({ status: 'handled' });
  expect(await fixture.backend.readHistory()).toEqual(await peer.backend.readHistory());
});

it.each(['local', 'owner'] as const)(
  'rechecks a certified goal after an index-only generation switch (%s)',
  async (entry) => {
    let muted = false;
    const onChanges = RoostNativeClient.prototype.onChanges;
    vi.spyOn(RoostNativeClient.prototype, 'onChanges').mockImplementation(
      function (stream, listener, options) {
        return onChanges.call(
          this,
          stream,
          (cursor, key) => {
            if (!muted) listener(cursor, key);
          },
          options
        );
      }
    );
    const fixture = await nativeFixture();
    const goal: SessionGoalMessage = {
      type: 'goal',
      threadId: 'generation-goal',
      objective: 'Synthetic objective',
      status: 'active',
    };
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('before-generation'),
      finished: true,
      items: [goal],
    });
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'history.db'),
      seed,
      allowedOwners: [owner],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    try {
      await client.ready;
      muted = true;
      const generation = new RoostHistoryGeneration(client, owner, fixture.doc.sessionId);
      await generation.replace(
        [
          {
            ...nativeAssistant('after-generation'),
            finished: true,
            items: [{ ...goal, status: 'cleared' }],
          },
        ],
        'certified-goal-switch'
      );
      const raw = client.stream(`lody-session:${fixture.doc.sessionId}`);
      const pointer = {
        table: 'lody_history_generation_v1',
        key: new TextEncoder().encode('next'),
      };
      const [activation] = await raw.readIndex([pointer]);
      if (!activation) throw new Error('Missing activation');
      await raw.compareAndWriteIndex(
        [{ ...pointer, value: activation }],
        [{ ...pointer, value: null }]
      );
      expect(await fixture.backend.readLatestGoal()).toEqual(goal);
      const observed = NodeLodyHistory.prototype.observedEventCursor;
      let switched = false;
      vi.spyOn(NodeLodyHistory.prototype, 'observedEventCursor').mockImplementation(
        async function () {
          const cursor = await observed.call(this);
          if (!switched) {
            switched = true;
            await raw.compareAndWriteIndex(
              [{ ...pointer, value: null }],
              [{ ...pointer, value: activation }]
            );
            expect(await observed.call(this)).toBe(cursor);
          }
          return cursor;
        }
      );
      const result =
        entry === 'local'
          ? await fixture.backend.readLatestGoal()
          : (await fixture.backend.readHistoryInspection!({ kind: 'readLatestGoal' })).result;
      expect(result).toEqual({ ...goal, status: 'cleared' });
      expect(switched).toBe(true);
    } finally {
      muted = false;
      await client.close();
    }
  }
);

it('retries a fallback range when a foreign append changes the page count', async () => {
  const fixture = await nativeFixture();
  for (let i = 0; i < 45; i++) await fixture.backend.appendHistoryTurn(nativeUser(`p2-range-${i}`));
  const peer = await nativeFixture(fixture.doc.sessionId);
  await fixture.backend.flushLocalWrites();
  await peer.backend.flushLocalWrites();
  const read = NodeLodyHistory.prototype.readActiveBranchPage;
  let injected = false;
  vi.spyOn(RoostDispatchIndex.prototype, 'checkpoint').mockResolvedValueOnce(undefined);
  vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage').mockImplementation(
    async function (viewId, input) {
      if (!injected && input?.from === 0) {
        injected = true;
        await peer.backend.appendHistoryTurn(nativeUser('p2-foreign-append'));
      }
      return read.call(this, viewId, input);
    }
  );
  const result = await fixture.backend.history.readRange(0, 1);
  expect(injected).toBe(true);
  expect(result[0]).toMatchObject({ state: 'ready', turn: { id: 'p2-range-0' } });
});

it('uses body-page cursors in member pages before and after sparse membership changes', async () => {
  const fixture = await nativeFixture();
  for (let i = 0; i < 48; i++)
    await fixture.backend.appendHistoryTurn(nativeUser(`p2-cursor-${i}`));
  let owner: NodeLodyHistory | undefined;
  const read = NodeLodyHistory.prototype.readActiveBranchMembers;
  const hook = vi
    .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMembers')
    .mockImplementation(function (...args) {
      owner = this;
      return read.apply(this, args);
    });
  await fixture.backend.history.readLatestDirectoryPage!(7);
  hook.mockRestore();
  if (!owner) throw new Error('Missing Native owner');
  for (const sparse of [false, true]) {
    if (sparse)
      await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'p2-cursor-17' });
    const latest = await owner.readActiveBranchPage(fixture.doc.sessionId, {
      latest: true,
      limit: 7,
    });
    expect(latest.cursor).toBeDefined();
    const bodies = await owner.readActiveBranchPage(fixture.doc.sessionId, {
      before: latest.cursor!,
      limit: 7,
    });
    const fields = await owner.readActiveBranchMembers(fixture.doc.sessionId, {
      before: latest.cursor!,
      limit: 7,
    });
    expect(fields.startPosition).toBe(bodies.startPosition);
    expect(fields.totalCount).toBe(bodies.totalCount);
    expect(
      fields.members.map((m) => [m.businessId, m.segmentId, Buffer.from(m.turnId).toString('hex')])
    ).toEqual(
      bodies.messages.map((m) => [m.businessId, m.segmentId, Buffer.from(m.turnId).toString('hex')])
    );
  }
});
