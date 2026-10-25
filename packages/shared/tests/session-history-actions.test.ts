import { describe, it, expect, vi } from 'vitest';
import { LoroDoc, LoroMap, LoroList } from 'loro-crdt';
import {
  createLoroSessionData,
  readSessionHistory,
  type SessionData,
  type SessionTurn,
  type SessionEntry,
  type SessionTurnStatus,
  applyHistoryAction,
  planHistoryAction,
  type HistoryAction,
} from '../src/session-data';
import type { SessionId } from '../src/ids';
import type { StoredLodyOperation } from '../src/session-orchestration';
import { createHistoryWriter } from '../src/history-writer';
import {
  planOperationProgress,
  getOperationProgressTurnId,
  findProgressMessageId,
} from '../src/session-data/operation-progress';
const sid = 'actions' as SessionId;
const row = (id: string, role: SessionTurn['role'] = 'assistant'): SessionEntry => ({
  id,
  role,
  timestamp: '2026-01-01T00:00:00Z',
  items: [{ type: 'text', text: id }],
  fileDiff: [],
});

describe('immutable history action plans', () => {
  it('matches shared action semantics, owns new input, and preserves previous snapshots', () => {
    const initial: SessionEntry[] = [
      row('u', 'user'),
      {
        ...row('a'),
        items: [
          { type: 'text', text: 'retained'.repeat(32768) },
          {
            type: 'tool_call',
            toolCallId: 'permission',
            status: 'pending',
            permissionRequest: { requestId: 'r', options: [] },
          },
          {
            type: 'tool_call',
            toolCallId: 'compact-old',
            status: 'in_progress',
            activityKind: 'context_compaction',
          },
          {
            type: 'tool_call',
            toolCallId: 'compact-last',
            status: 'in_progress',
            activityKind: 'context_compaction',
          },
        ],
      },
      row('other'),
    ];
    const actions: HistoryAction[] = [
      { kind: 'user-status', turnId: 'u', status: 'processing', deliveredSteer: true },
      {
        kind: 'assistant-items',
        turnId: 'a',
        mode: 'append',
        items: [{ type: 'text', text: 'new' }],
      },
      { kind: 'finish-assistant', turnId: 'a', endedAt: 42, permissionWaitMs: 7 },
      { kind: 'finish-assistant', turnId: 'a', endedAt: 99 },
      { kind: 'upsert-turn', turn: row('inserted'), beforeTurnId: 'other' },
      { kind: 'remove-turn', turnId: 'inserted' },
      { kind: 'remove-turn', turnId: 'missing' },
    ];
    let current = initial;
    for (const action of actions) {
      const before = structuredClone(current);
      const reference = applyHistoryAction(structuredClone(current), structuredClone(action));
      const planned = planHistoryAction(current, action);
      expect(planned.turns).toEqual(reference.turns);
      expect(planned.matched).toBe(reference.matched);
      expect(current).toEqual(before);
      if (action.kind === 'finish-assistant') {
        expect(planned.turns[1]?.items?.[0]).toBe(current[1]?.items?.[0]);
        expect(planned.turns[1]).toMatchObject({
          endedAt: 42,
          permissionWaitMs: 7,
          items: [
            { type: 'text' },
            { toolCallId: 'permission', permissionRequest: { outcome: { outcome: 'cancelled' } } },
            { toolCallId: 'compact-last', status: 'failed' },
            { type: 'text', text: 'new' },
          ],
        });
      }
      if (action.kind === 'assistant-items') {
        (action.items[0] as { text: string }).text = 'caller mutation';
        expect(planned.turns[1]?.items?.at(-1)).toEqual({ type: 'text', text: 'new' });
      }
      if (action.kind === 'upsert-turn') {
        action.turn.items = [];
        expect(planned.turns[2]?.items).toEqual([{ type: 'text', text: 'inserted' }]);
      }
      if (action.kind === 'finish-assistant' && action.endedAt === 99)
        expect(planned.changes).toEqual([]);
      current = planned.turns;
    }
    expect(initial[1]?.finished).toBeUndefined();
    expect(initial[1]?.items?.length).toBe(4);
  });
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

  it('creates, changes and repeats progress without exporting history or unrelated turns', async () => {
    const doc = new LoroDoc();
    const writer = createHistoryWriter(doc);
    for (let i = 0; i < 128; i++)
      writer.append({ ...row(`old-${i}`), items: [{ type: 'text', text: 'body'.repeat(1024) }] });
    const data = createLoroSessionData({ sessionId: sid, doc, writer });
    const history = doc.getList('history');
    const before = doc.toJSON();
    const oldIds = Array.from({ length: history.length }, (_, i) => (history.get(i) as LoroMap).id);
    const originalMapJson = LoroMap.prototype.toJSON;
    const originalListJson = LoroList.prototype.toJSON;
    const originalGet = LoroMap.prototype.get;
    let reads = new Set<string>();
    let forbidOldIdentities = false;
    const mapJson = vi
      .spyOn(LoroMap.prototype, 'toJSON')
      .mockImplementation(function (this: LoroMap) {
        if (oldIds.includes(this.id)) throw new Error('unrelated turn exported');
        if (reads.has(this.id)) throw new Error('card exported twice in one update');
        reads.add(this.id);
        return originalMapJson.call(this);
      });
    const listJson = vi
      .spyOn(LoroList.prototype, 'toJSON')
      .mockImplementation(function (this: LoroList) {
        if (this.id === history.id) throw new Error('full history exported');
        return originalListJson.call(this);
      });
    const get = vi.spyOn(LoroMap.prototype, 'get').mockImplementation(function (
      this: LoroMap,
      key: string
    ) {
      if (oldIds.includes(this.id) && (forbidOldIdentities || (key !== 'id' && key !== 'role')))
        throw new Error('unrelated body or repeated identity read');
      return originalGet.call(this, key);
    });
    try {
      expect(await data.commands.applyHistoryAction(action())).toEqual({ matched: true });
      for (let i = 0; i < 12; i++) {
        reads = new Set();
        forbidOldIdentities = i > 0;
        const count = doc.opCount();
        expect(await data.commands.applyHistoryAction(action())).toEqual({ matched: false });
        expect(doc.opCount()).toBe(count);
      }
      reads = new Set();
      forbidOldIdentities = false;
      expect(
        await data.commands.applyHistoryAction({
          ...action(),
          statuses: [['child\0input', 'succeeded']],
        })
      ).toEqual({ matched: true });
      reads = new Set();
      expect(await data.commands.applyHistoryAction(action())).toEqual({ matched: false });
    } finally {
      get.mockRestore();
      listJson.mockRestore();
      mapJson.mockRestore();
    }
    expect(doc.toJSON().history.slice(0, 128)).toEqual(before.history);
    expect(await data.history.readTurn(getOperationProgressTurnId(sid, 'op'))).toMatchObject({
      state: 'ready',
      turn: { items: [{ items: [{ status: 'succeeded' }] }] },
    });
    expect(oldIds).toEqual(Array.from({ length: 128 }, (_, i) => (history.get(i) as LoroMap).id));
    data.dispose();
  });

  it.each(['map', 'inline'] as const)(
    'merges %s duplicates in place and matches the full-history planner',
    async (storage) => {
      const doc = new LoroDoc();
      const writer = createHistoryWriter(doc);
      const data = createLoroSessionData({ sessionId: sid, doc, writer });
      const card = planOperationProgress([], operation(), action().timestamp)[0]!;
      writer.append(row('before'));
      writer.append(card);
      writer.append(row('between'));
      const duplicate = { ...card, id: `${card.id}:duplicate:old` };
      if (storage === 'map') writer.append(duplicate);
      else doc.getList('history').push(duplicate as never);
      writer.append(row('after'));
      const list = doc.getList('history');
      (list.get(1) as LoroMap).set('future', { retained: true });
      doc.commit();
      const siblingIds = [0, 2, 4].map((i) => (list.get(i) as LoroMap).id);
      const before = await data.history.readAll();
      const expected = planOperationProgress(
        before,
        operation(),
        action().timestamp,
        action().statuses
      );
      expect(await data.commands.applyHistoryAction(action())).toEqual({ matched: true });
      expect(await data.history.readAll()).toEqual(expected);
      expect([0, 2, 3].map((i) => (list.get(i) as LoroMap).id)).toEqual(siblingIds);
      expect(await data.history.readTurn(card.id)).toMatchObject({
        state: 'ready',
        turn: { future: { retained: true } },
      });
      data.dispose();
    }
  );

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

  it.each(['map', 'inline'] as const)(
    'repairs an alias-only %s card in place, even when its content is unchanged',
    (storage) => {
      const doc = new LoroDoc();
      const writer = createHistoryWriter(doc);
      const card = planOperationProgress(
        [],
        operation(),
        action().timestamp,
        action().statuses
      )[0]!;
      writer.append(row('before'));
      const legacy = { ...card, id: `${card.id}:duplicate:legacy`, future: { retained: true } };
      const list = doc.getList('history');
      if (storage === 'map') {
        writer.append(legacy);
        (list.get(1) as LoroMap).set('future', legacy.future);
      } else list.push(legacy as never);
      writer.append(row('after'));
      const containerId = storage === 'map' ? (list.get(1) as LoroMap).id : undefined;
      const siblings = [0, 2].map((index) => (list.get(index) as LoroMap).id);
      expect(writer.updateOperationProgress(action())).toBe(true);
      const history = writer.readStored();
      expect(history.map((entry) => entry.id)).toEqual(['before', card.id, 'after']);
      expect(history[1]).toMatchObject({ ...card, future: legacy.future });
      expect(findProgressMessageId(history, operation())).toBe(card.id);
      if (storage === 'map') expect((list.get(1) as LoroMap).id).toBe(containerId);
      expect([0, 2].map((index) => (list.get(index) as LoroMap).id)).toEqual(siblings);
      const count = doc.opCount();
      expect(writer.updateOperationProgress(action())).toBe(false);
      expect(doc.opCount()).toBe(count);
    }
  );

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

  it('invalidates warm positions on checkout and pending identity or role edits without committing a no-op', () => {
    const doc = new LoroDoc();
    const writer = createHistoryWriter(doc);
    writer.updateOperationProgress(action());
    const oldFrontiers = doc.frontiers();
    const list = doc.getList('history');
    list.insert(0, row('shift') as never);
    doc.commit();
    expect(writer.updateOperationProgress(action())).toBe(false);
    doc.checkout(oldFrontiers);
    expect(writer.updateOperationProgress(action())).toBe(false);
    doc.attach();
    const card = list.get(1) as LoroMap;
    card.set('id', `${getOperationProgressTurnId(sid, 'op')}:duplicate:pending`);
    expect(writer.updateOperationProgress(action())).toBe(true);
    expect(writer.readStored().map((entry) => entry.id)).toEqual([
      'shift',
      getOperationProgressTurnId(sid, 'op'),
    ]);
    doc.getMap('session').set('pending', true);
    const pending = doc.getPendingTxnLength();
    expect(writer.updateOperationProgress(action())).toBe(false);
    expect(writer.updateOperationProgress(action())).toBe(false);
    expect(doc.getPendingTxnLength()).toBe(pending);
    card.set('role', 'assistant');
    expect(writer.updateOperationProgress(action())).toBe(true);
    expect(writer.readStored().map((entry) => entry.role)).toEqual([
      'assistant',
      'assistant',
      'system',
    ]);
  });

  it.each(['canonical', 'alias-only'] as const)(
    'rejects invalid progress before mutating or deleting %s cards',
    async (identity) => {
      const doc = new LoroDoc();
      const data = createLoroSessionData({ sessionId: sid, doc });
      await data.commands.applyHistoryAction(action());
      const id = getOperationProgressTurnId(sid, 'op');
      if (identity === 'alias-only') {
        (doc.getList('history').get(0) as LoroMap).set('id', `${id}:duplicate:first`);
        doc.commit();
      }
      await data.commands.appendTurn({
        ...planOperationProgress([], operation(), action().timestamp)[0]!,
        id: `${id}:duplicate:old`,
      });
      const before = doc.toJSON();
      const count = doc.opCount();
      await expect(
        data.commands.applyHistoryAction({
          ...action(),
          statuses: [['child\0input', 'invalid' as never]],
        })
      ).rejects.toThrow();
      expect(doc.opCount()).toBe(count);
      expect(doc.toJSON()).toEqual(before);
      data.dispose();
    }
  );
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
    it('preserves permission outcomes when a request is repeated', async () => {
      const data = create();
      await data.commands.appendTurn({
        ...row('a'),
        items: [
          {
            type: 'tool_call',
            toolCallId: 'c',
            status: 'pending',
            title: 'existing',
            permissionRequest: {
              requestId: 'old',
              options: [],
              outcome: { outcome: 'cancelled' },
            },
          },
        ],
      });
      await data.commands.applyHistoryAction({
        kind: 'permission-request',
        requestId: 'new',
        request: {
          sessionId: 'acp',
          toolCall: { toolCallId: 'c', title: 'incoming' },
          options: [],
        },
      });
      expect((await data.history.readAll())[0]?.items?.[0]).toMatchObject({
        title: 'existing',
        permissionRequest: { requestId: 'new', outcome: { outcome: 'cancelled' } },
      });
    });
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
    it('does not price legacy tokens from a later known delta', async () => {
      const data = create();
      await seed(data);
      await data.commands.applyHistoryAction({
        kind: 'assistant-token-usage',
        turnId: 'a',
        add: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      });
      await data.commands.applyHistoryAction({
        kind: 'assistant-token-usage',
        turnId: 'a',
        add: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          costUSD: 0.5,
        },
      });
      expect((await data.history.readAll())[1]?.tokenUsage).toMatchObject({ costUSD: null });
    });
    it('rejects a negative token cost without changing history', async () => {
      const data = create();
      await seed(data);
      const before = await data.history.readAll();
      await expect(
        data.commands.applyHistoryAction({
          kind: 'assistant-token-usage',
          turnId: 'a',
          add: {
            inputTokens: 1,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            reasoningOutputTokens: 0,
            costUSD: -0.01,
          },
        })
      ).rejects.toThrow();
      expect(await data.history.readAll()).toEqual(before);
    });
    it('rejects malformed token usage without changing history', async () => {
      const data = create();
      await seed(data);
      const before = await data.history.readAll();
      await expect(
        data.commands.applyHistoryAction({
          kind: 'assistant-token-usage',
          turnId: 'a',
          add: {
            inputTokens: -1,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            reasoningOutputTokens: 0,
          },
        })
      ).rejects.toThrow();
      expect(await data.history.readAll()).toEqual(before);
    });
    it('rejects malformed content without changing history', async () => {
      const data = create();
      await seed(data);
      const before = await data.history.readAll();
      await expect(
        data.commands.applyHistoryAction({
          kind: 'assistant-items',
          turnId: 'a',
          mode: 'replace',
          items: [{ type: 'text', text: 42 } as never],
        })
      ).rejects.toThrow();
      expect(await data.history.readAll()).toEqual(before);
    });
  });
it('retains an opaque stored item during a named field action', async () => {
  const doc = new LoroDoc();
  const data = createLoroSessionData({ sessionId: sid, doc });
  await data.commands.appendTurn(row('a'));
  const map = doc.getList('history').get(0) as LoroMap;
  const items = map.get('items') as LoroList;
  items.push({ type: 'future', payload: { keep: true } });
  doc.commit();
  await data.commands.applyHistoryAction({ kind: 'finish-assistant', turnId: 'a', endedAt: 42 });
  expect((await data.history.readAll())[0]?.items?.[1]).toEqual({
    type: 'future',
    payload: { keep: true },
  });
});

for (const backend of ['loro'] as const)
  it(`${backend}: an ended-steer fallback only changes pending_apply`, async () => {
    const data = createLoroSessionData({ sessionId: sid, doc: new LoroDoc() });
    await data.commands.appendTurn({ ...row('u', 'user'), status: 'pending_apply' });
    const action = {
      kind: 'user-status' as const,
      turnId: 'u',
      status: 'pending' as const,
      onlyPendingApply: true,
    };
    expect((await data.commands.applyHistoryAction(action)).matched).toBe(true);
    await data.commands.applyHistoryAction({
      kind: 'user-status',
      turnId: 'u',
      status: 'processing',
    });
    expect((await data.commands.applyHistoryAction(action)).matched).toBe(false);
    expect((await data.history.readAll())[0]).toMatchObject({ status: 'processing', read: true });
    expect((await data.commands.applyHistoryAction({ ...action, turnId: 'missing' })).matched).toBe(
      false
    );
    expect(
      (
        await data.commands.applyHistoryAction({
          kind: 'user-status',
          turnId: 'missing',
          status: 'pending',
          requeueUndelivered: true,
        })
      ).matched
    ).toBe(true);
    await data.commands.appendTurn({ ...row('a'), fileDiff: [{ filePath: 'x', add: 1, del: 0 }] });
    await data.commands.applyHistoryAction(
      JSON.parse(
        JSON.stringify({ kind: 'assistant-file-diff', turnId: 'a', change: { kind: 'clear' } })
      )
    );
    expect((await data.history.readAll())[1]).not.toHaveProperty('fileDiff');
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

it('Loro structural actions report membership changes even without a target hint', async () => {
  const data = createLoroSessionData({ sessionId: sid, doc: new LoroDoc() });
  const changes: unknown[] = [];
  const subscription = data.history.observe((change) => changes.push(change));
  await subscription.initial;
  await data.commands.applyHistoryAction({ kind: 'upsert-turn', turn: row('a') });
  expect(changes.at(-1)).toMatchObject({ kind: 'structure', from: 0, to: 1 });
  await data.commands.applyHistoryAction({ kind: 'remove-turn', turnId: 'a' });
  expect(changes.at(-1)).toMatchObject({ kind: 'structure', from: 0, to: 0 });
  subscription.unsubscribe();
});

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
