import { describe, it, expect } from 'vitest';
import { LoroDoc, LoroMap, LoroList } from 'loro-crdt';
import {
  createLoroSessionData,
  readSessionHistory,
  type SessionData,
  type SessionTurn,
  type SessionEntry,
  type SessionTurnStatus,
  applyHistoryAction,
} from '../src/session-data';
import type { SessionId } from '../src/ids';
import type { StoredLodyOperation } from '../src/session-orchestration';
import { createHistoryWriter } from '../src/history-writer';
import { planOperationProgress } from '../src/session-data/operation-progress';
const sid = 'actions' as SessionId;
const row = (id: string, role: SessionTurn['role'] = 'assistant'): SessionEntry => ({
  id,
  role,
  timestamp: '2026-01-01T00:00:00Z',
  items: [{ type: 'text', text: id }],
  fileDiff: [],
});

describe('operation progress local history writes', () => {
  const operation = (): StoredLodyOperation => ({
    workspaceId: 'workspace' as StoredLodyOperation['workspaceId'],
    ownerMachineId: 'machine' as StoredLodyOperation['ownerMachineId'],
    requesterSessionId: sid,
    requesterUserId: 'user',
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
        target: { sessionId: 'child' as SessionId, userTurnId: 'input' },
      },
    ],
  });
  const action = (op = operation()) => ({
    kind: 'operation-progress' as const,
    operation: op,
    timestamp: '2026-01-01T00:00:00Z',
    statuses: [['child\0input', 'running']] as const,
  });

  it('follows imported duplicate cards and uncommitted row shifts without stale positions', async () => {
    const doc = new LoroDoc();
    const data = createLoroSessionData({ sessionId: sid, doc });
    await data.commands.applyHistoryAction(action());
    const peer = new LoroDoc();
    peer.import(doc.export({ mode: 'snapshot' }));
    const peerWriter = createHistoryWriter(peer);
    const card = planOperationProgress([], operation(), action().timestamp)[0]!;
    peerWriter.append({ ...card, id: `${card.id}:duplicate:peer` });
    doc.import(peer.export({ mode: 'update' }));
    doc.getList('history').insert(0, row('pending') as never);
    expect(
      await data.commands.applyHistoryAction({
        ...action(),
        statuses: [['child\0input', 'succeeded']],
      })
    ).toEqual({ matched: true });
    peer.import(doc.export({ mode: 'update' }));
    expect(peer.toJSON()).toEqual(doc.toJSON());
    expect(await data.history.readAll()).toHaveLength(2);
    expect((await data.history.readAll())[0]?.id).toBe('pending');
    data.dispose();
  });

  it('merges concurrent canonical copies without regressing a terminal target and converges by local updates', () => {
    const left = new LoroDoc();
    const right = new LoroDoc();
    const leftWriter = createHistoryWriter(left);
    const rightWriter = createHistoryWriter(right);
    leftWriter.updateOperationProgress(action());
    rightWriter.updateOperationProgress({ ...action(), statuses: [['child\0input', 'succeeded']] });
    left.import(right.export({ mode: 'update' }));
    expect(leftWriter.readStored()).toHaveLength(2);
    const observer = new LoroDoc();
    observer.import(left.export({ mode: 'snapshot' }));
    const unsubscribe = left.subscribeLocalUpdates((update) => observer.import(update));
    expect(leftWriter.updateOperationProgress(action())).toBe(true);
    expect(leftWriter.readStored()).toHaveLength(1);
    expect(leftWriter.readStored()[0]).toMatchObject({
      items: [{ items: [{ status: 'succeeded' }] }],
    });
    right.import(left.export({ mode: 'update' }));
    expect(right.toJSON()).toEqual(left.toJSON());
    // A transport subscribed only to local updates must receive the reconciliation.
    expect(observer.toJSON()).toEqual(left.toJSON());
    const count = right.opCount();
    expect(rightWriter.updateOperationProgress(action())).toBe(false);
    expect(right.opCount()).toBe(count);
    unsubscribe();
    observer.free();
  });

  it('retains the canonical card metadata when an older alias precedes it', () => {
    const doc = new LoroDoc();
    const writer = createHistoryWriter(doc);
    const card = planOperationProgress([], operation(), action().timestamp)[0]!;
    writer.append({ ...card, id: `${card.id}:duplicate:first`, timestamp: '2025-01-01T00:00:00Z' });
    writer.append(row('between'));
    writer.append(card);
    const list = doc.getList('history');
    const canonical = list.get(2) as LoroMap;
    canonical.set('future', { retained: true });
    expect(writer.updateOperationProgress(action())).toBe(true);
    expect(writer.readStored().map((entry) => entry.id)).toEqual(['between', card.id]);
    expect(writer.readStored()[1]).toMatchObject({
      timestamp: card.timestamp,
      future: { retained: true },
    });
    expect((list.get(1) as LoroMap).id).toBe(canonical.id);
  });

  it('treats unchanged progress with stored extension fields as a no-op', () => {
    const doc = new LoroDoc();
    const writer = createHistoryWriter(doc);
    writer.updateOperationProgress(action());
    const card = doc.getList('history').get(0) as LoroMap;
    const content = (card.get('items') as LoroList).get(0) as LoroMap;
    content.set('future', { retained: true });
    const item = (content.get('items') as LoroList).get(0) as LoroMap;
    (item.get('target') as LoroMap).set('futureTarget', { retained: true });
    doc.commit();
    const before = doc.toJSON();
    const count = doc.opCount();
    expect(writer.updateOperationProgress(action())).toBe(false);
    expect(doc.opCount()).toBe(count);
    expect(doc.toJSON()).toEqual(before);
    expect(
      writer.updateOperationProgress({ ...action(), statuses: [['child\0input', 'succeeded']] })
    ).toBe(true);
    expect(writer.readStored()[0]).toMatchObject({
      items: [
        {
          future: { retained: true },
          items: [{ status: 'succeeded', target: { futureTarget: { retained: true } } }],
        },
      ],
    });
    expect(writer.updateOperationProgress(action())).toBe(false);
  });
});
for (const backend of ['loro'] as const)
  describe(`history actions ${backend}`, () => {
    const create = () => createLoroSessionData({ sessionId: sid, doc: new LoroDoc() });
    const seed = async (data: SessionData) => {
      for (const t of [row('u', 'user'), row('a'), row('other')]) await data.commands.appendTurn(t);
    };
    it('updates the selected user and keeps status/read paired', async () => {
      const data = create();
      await seed(data);
      await data.commands.applyHistoryAction({
        kind: 'user-status',
        turnId: 'u',
        status: 'pending',
      });
      const before = await data.history.readAll();
      await data.commands.applyHistoryAction({
        kind: 'user-status',
        turnId: 'u',
        status: 'processing',
        deliveredSteer: true,
      });
      const after = await data.history.readAll();
      expect(after[0]).toMatchObject({
        status: 'processing',
        read: true,
        inputConfig: { _lodyDeliveryKind: 'steer' },
      });
      expect(after.slice(1)).toEqual(before.slice(1));
      expect(
        (
          await data.commands.applyHistoryAction({
            kind: 'user-status',
            turnId: 'u',
            status: 'pending',
            requeueUndelivered: true,
          })
        ).matched
      ).toBe(false);
      expect(await data.history.readAll()).toEqual(after);
    });
    it.each(['switch_mode', 'execute'] as const)(
      'merges pending %s review content before the user answers',
      async (kind) => {
        const data = create();
        const preview = [
          { type: 'content' as const, content: { type: 'text' as const, text: '{}' } },
        ];
        const review = [
          {
            type: 'content' as const,
            content: { type: 'text' as const, text: '# Plan\n\nAdd a regression test.' },
          },
          {
            type: 'content' as const,
            content: { type: 'text' as const, text: 'Requesting approval to implement' },
          },
        ];
        await data.commands.appendTurn({
          ...row('a'),
          items: [
            { type: 'tool_call', toolCallId: 'c', kind, status: 'in_progress', content: preview },
          ],
        });
        const request = {
          sessionId: 'acp',
          toolCall: { toolCallId: 'c', content: review },
          options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' as const }],
        };
        await data.commands.applyHistoryAction({
          kind: 'permission-request',
          requestId: 'review',
          request,
        });
        const expected = kind === 'switch_mode' ? review : preview;
        expect((await data.history.readAll())[0]?.items?.[0]).toMatchObject({
          content: expected,
          permissionRequest: { requestId: 'review', options: request.options },
        });
        const item = (await data.history.readAll())[0]?.items?.[0];
        expect(item?.type === 'tool_call' && item.permissionRequest?.outcome).toBeUndefined();

        // A request without content must not erase the displayed review.
        await data.commands.applyHistoryAction({
          kind: 'permission-request',
          requestId: 'review',
          request: { ...request, toolCall: { toolCallId: 'c' } },
        });
        expect((await data.history.readAll())[0]?.items?.[0]).toMatchObject({ content: expected });
        await data.commands.respondPermission('review', { outcome: 'cancelled' });
        await data.commands.applyHistoryAction({
          kind: 'permission-request',
          requestId: 'review',
          request: { ...request, toolCall: { toolCallId: 'c', content: preview } },
        });
        expect((await data.history.readAll())[0]?.items?.[0]).toMatchObject({
          content: expected,
          permissionRequest: { outcome: { outcome: 'cancelled' } },
        });
        data.dispose();
      }
    );
    it('finishes only the requested assistant and preserves its original end time', async () => {
      const data = create();
      await seed(data);
      await data.commands.applyHistoryAction({
        kind: 'finish-assistant',
        turnId: 'a',
        endedAt: 42,
      });
      await data.commands.applyHistoryAction({
        kind: 'finish-assistant',
        turnId: 'a',
        endedAt: 99,
      });
      const history = await data.history.readAll();
      expect(history[1]).toMatchObject({ finished: true, endedAt: 42 });
      expect(history[2]?.finished).toBeUndefined();
    });
    it('sums token usage on the selected assistant, across finish and reopen', async () => {
      const data = create();
      await seed(data);
      const usage = (inputTokens: number, cacheReadInputTokens = 0) => ({
        inputTokens,
        outputTokens: 5,
        cacheReadInputTokens,
        cacheCreationInputTokens: 1,
        reasoningOutputTokens: 2,
      });
      await data.commands.applyHistoryAction({
        kind: 'assistant-token-usage',
        turnId: 'a',
        add: usage(10, 1000),
      });
      await data.commands.applyHistoryAction({
        kind: 'finish-assistant',
        turnId: 'a',
        endedAt: 42,
      });
      // A late report after finalization adds instead of replacing.
      await data.commands.applyHistoryAction({
        kind: 'assistant-token-usage',
        turnId: 'a',
        add: usage(3),
      });
      const history = await data.history.readAll();
      expect(history[1]?.tokenUsage).toEqual({
        inputTokens: 13,
        outputTokens: 10,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 2,
        reasoningOutputTokens: 4,
      });
      expect(history[2]?.tokenUsage).toBeUndefined();
      expect(
        (
          await data.commands.applyHistoryAction({
            kind: 'assistant-token-usage',
            turnId: 'u',
            add: usage(1),
          })
        ).matched
      ).toBe(false);
    });
    it('sums a known per-turn cost and keeps mixed unknown costs unknown', async () => {
      const data = create();
      await seed(data);
      const usage = (inputTokens: number, costUSD: number | null | undefined) => ({
        inputTokens,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 1,
        reasoningOutputTokens: 2,
        ...(costUSD !== undefined ? { costUSD } : {}),
      });
      await data.commands.applyHistoryAction({
        kind: 'assistant-token-usage',
        turnId: 'a',
        add: usage(10, 0.5),
      });
      await data.commands.applyHistoryAction({
        kind: 'assistant-token-usage',
        turnId: 'a',
        add: usage(3, 0.25),
      });
      expect((await data.history.readAll())[1]?.tokenUsage).toMatchObject({ costUSD: 0.75 });

      // Once a contribution has no tariff, the turn total is unknown rather than partial.
      await data.commands.applyHistoryAction({
        kind: 'assistant-token-usage',
        turnId: 'a',
        add: usage(1, undefined),
      });
      await data.commands.applyHistoryAction({
        kind: 'assistant-token-usage',
        turnId: 'a',
        add: usage(1, 0.1),
      });
      expect((await data.history.readAll())[1]?.tokenUsage).toMatchObject({ costUSD: null });
    });
  });

describe('user status on duplicate turn copies', () => {
  const withCopies = async (...statuses: SessionTurnStatus[]) => {
    const data = createLoroSessionData({ sessionId: sid, doc: new LoroDoc() });
    // Concurrent queue promotion and queued steering can store one turn twice.
    for (const status of statuses) await data.commands.appendTurn({ ...row('u', 'user'), status });
    await data.commands.appendTurn(row('next', 'user'));
    const copies = async () =>
      (await data.history.readAll())
        .filter((turn) => turn.id === 'u')
        .map((turn) => [turn.status, turn.inputConfig?._lodyDeliveryKind ?? null]);
    return { data, copies };
  };

  it('keeps every copy in step without regressing a settled one', async () => {
    const { data, copies } = await withCopies('pending', 'pending_apply');
    await data.commands.applyHistoryAction({ kind: 'user-status', turnId: 'u', status: 'handled' });
    expect(await copies()).toEqual([
      ['handled', null],
      ['handled', null],
    ]);

    const settled = await withCopies('handled', 'pending');
    await settled.data.commands.applyHistoryAction({
      kind: 'user-status',
      turnId: 'u',
      status: 'processing',
    });
    expect(await settled.copies()).toEqual([
      ['handled', null],
      ['processing', null],
    ]);
  });

  it('projects a steer verdict from the last copy onto steer-state copies only', async () => {
    const projection = {
      kind: 'user-status',
      turnId: 'u',
      status: 'handled',
      steerProjection: true,
      deliveredSteer: true,
    } as const;
    const { data, copies } = await withCopies('processing', 'pending', 'pending_apply');
    expect((await data.commands.applyHistoryAction(projection)).matched).toBe(true);
    expect(await copies()).toEqual([
      ['handled', 'steer'],
      ['pending', null],
      ['handled', 'steer'],
    ]);

    const settled = await withCopies('pending_apply', 'canceled');
    expect((await settled.data.commands.applyHistoryAction(projection)).matched).toBe(false);
    expect(await settled.copies()).toEqual([
      ['pending_apply', null],
      ['canceled', null],
    ]);
  });

  it.each([
    ['requeueUndelivered', { requeueUndelivered: true }],
    ['onlyPendingApply', { onlyPendingApply: true }],
  ] as const)('%s is vetoed by any started or settled copy', async (_name, flag) => {
    const requeue = { kind: 'user-status', turnId: 'u', status: 'pending', ...flag } as const;
    for (const blocker of ['processing', 'handled'] as const) {
      // The last copy alone would allow it, but the earlier copy already ran.
      const { data, copies } = await withCopies(blocker, 'pending_apply');
      expect((await data.commands.applyHistoryAction(requeue)).matched).toBe(false);
      expect(await copies()).toEqual([
        [blocker, null],
        ['pending_apply', null],
      ]);
    }

    const { data, copies } = await withCopies('pending_apply', 'pending_apply');
    expect((await data.commands.applyHistoryAction(requeue)).matched).toBe(true);
    expect(await copies()).toEqual([
      ['pending', null],
      ['pending', null],
    ]);
  });

  it('settles unclaimed input only while every copy still awaits a start', async () => {
    const settle = {
      kind: 'user-status',
      turnId: 'u',
      status: 'canceled',
      onlyAwaitingStart: true,
    } as const;
    const unclaimed = await withCopies('pending', 'seen');
    expect((await unclaimed.data.commands.applyHistoryAction(settle)).matched).toBe(true);
    expect(await unclaimed.copies()).toEqual([
      ['canceled', null],
      ['canceled', null],
    ]);
    for (const claimed of ['processing', 'handled', 'pending_apply'] as const) {
      const { data, copies } = await withCopies(claimed, 'pending');
      expect((await data.commands.applyHistoryAction(settle)).matched).toBe(false);
      expect(await copies()).toEqual([
        [claimed, null],
        ['pending', null],
      ]);
    }
  });
});

it('business full reads preserve normalization without rewriting opaque stored history', async () => {
  const doc = new LoroDoc();
  const list = doc.getList('history');
  list.insert(0, null);
  list.insert(1, {
    ...row('u', 'user'),
    inputConfig: { prompt: '  hello  ', mcpServerIds: [], future: 'keep' },
  });
  doc.commit();
  const data = createLoroSessionData({ sessionId: sid, doc });
  const before = doc.toJSON();
  const version = doc.version().toJSON();
  const projected = await readSessionHistory(data.history);
  expect(projected).toHaveLength(1);
  expect(projected[0]?.inputConfig).toMatchObject({ prompt: 'hello', mcpServerIds: [] });
  expect(projected[0]?.inputConfig).not.toHaveProperty('future');
  expect(await data.history.readAll()).toEqual(before.history);
  expect(doc.toJSON()).toEqual(before);
  expect(doc.version().toJSON()).toEqual(version);
});

it.each(['handled', 'failed', 'canceled', 'delivery_unknown'] as const)(
  'late steer projection cannot resurrect %s across peer import',
  async (status) => {
    const doc = new LoroDoc();
    const data = createLoroSessionData({ sessionId: sid, doc });
    await data.commands.appendTurn({ ...row('guide', 'user'), status: 'pending_apply' });
    await data.commands.applyHistoryAction({
      kind: 'user-status',
      turnId: 'guide',
      status,
      steerProjection: true,
    });
    const peer = new LoroDoc();
    peer.import(doc.export({ mode: 'snapshot' }));
    const imported = createLoroSessionData({ sessionId: sid, doc: peer });
    const result = await imported.commands.applyHistoryAction({
      kind: 'user-status',
      turnId: 'guide',
      status: 'processing',
      steerProjection: true,
      deliveredSteer: true,
    });
    expect(result.matched).toBe(false);
    expect(await imported.history.readTurn('guide')).toMatchObject({
      state: 'ready',
      turn: { status },
    });
  }
);

it('updates one matching batch receipt while preserving the original user input and other batches', async () => {
  const data = createLoroSessionData({ sessionId: sid, doc: new LoroDoc() });
  const input = {
    ...row('user', 'user'),
    inputConfig: { prompt: 'current request', chainDepth: 0 },
  };
  await data.commands.appendTurn(input);
  for (const id of ['one', 'two'])
    await data.commands.appendTurn({
      ...row(id, 'system'),
      items: [
        {
          type: 'operation_completion_batch',
          batchId:
            id === 'one'
              ? '00000000-0000-4000-8000-000000000001'
              : '00000000-0000-4000-8000-000000000002',
          memberCount: 8,
          deliveryStatus: 'prepared',
        },
      ],
    });
  expect(
    (
      await data.commands.applyHistoryAction({
        kind: 'operation-batch-status',
        turnId: 'one',
        batchId: 'wrong',
        status: 'unknown',
      })
    ).matched
  ).toBe(false);
  await data.commands.applyHistoryAction({
    kind: 'operation-batch-status',
    turnId: 'one',
    batchId: '00000000-0000-4000-8000-000000000001',
    status: 'unknown',
  });
  const history = await data.history.readAll();
  expect(history[0]).toEqual(input);
  expect(history[1]?.items?.[0]).toMatchObject({
    batchId: '00000000-0000-4000-8000-000000000001',
    deliveryStatus: 'unknown',
  });
  expect(history[2]?.items?.[0]).toMatchObject({
    batchId: '00000000-0000-4000-8000-000000000002',
    deliveryStatus: 'prepared',
  });
  expect(
    (
      await data.commands.applyHistoryAction({
        kind: 'operation-batch-status',
        turnId: 'one',
        batchId: '00000000-0000-4000-8000-000000000001',
        status: 'unknown',
      })
    ).matched
  ).toBe(false);
});

it('keeps manual Stop provenance on the exact user turn across peer import and shallow output reads', async () => {
  const doc = new LoroDoc();
  const data = createLoroSessionData({ sessionId: sid, doc });
  await data.commands.appendTurn({ ...row('stopped', 'user'), status: 'processing' });
  await data.commands.appendTurn({ ...row('other', 'user'), status: 'pending' });
  await data.commands.applyHistoryAction({
    kind: 'user-status',
    turnId: 'stopped',
    status: 'canceled',
    cancellationReason: 'user_stop',
  });
  const peer = new LoroDoc();
  peer.import(doc.export({ mode: 'snapshot' }));
  const copy = createLoroSessionData({ sessionId: sid, doc: peer });
  expect((await copy.history.readTurnOutput('stopped'))[0]).toMatchObject({
    id: 'stopped',
    status: 'canceled',
    cancellationReason: 'user_stop',
  });
  expect(await copy.history.readTurn('other')).toMatchObject({
    state: 'ready',
    turn: { status: 'pending' },
  });
  expect(await copy.history.readTurn('other')).not.toHaveProperty('turn.cancellationReason');
});

it('keeps update-interruption provenance on the user turn so peers can offer Continue', async () => {
  const doc = new LoroDoc();
  const data = createLoroSessionData({ sessionId: sid, doc });
  await data.commands.appendTurn({ ...row('interrupted', 'user'), status: 'processing' });
  await data.commands.applyHistoryAction({
    kind: 'user-status',
    turnId: 'interrupted',
    status: 'canceled',
    cancellationReason: 'machine_update',
  });
  const peer = new LoroDoc();
  peer.import(doc.export({ mode: 'snapshot' }));
  const copy = createLoroSessionData({ sessionId: sid, doc: peer });
  expect((await copy.history.readTurnOutput('interrupted'))[0]).toMatchObject({
    status: 'canceled',
    cancellationReason: 'machine_update',
  });
  expect(await copy.history.readTurn('interrupted')).toMatchObject({
    turn: { cancellationReason: 'machine_update' },
  });
});
