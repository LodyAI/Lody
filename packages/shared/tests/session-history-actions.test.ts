import { describe, it, expect } from 'vitest';
import { LoroDoc, LoroMap, LoroList } from 'loro-crdt';
import {
  createLoroSessionData,
  readSessionHistory,
  requireSessionAccepted,
  type SessionData,
  type SessionTurn,
  type SessionEntry,
} from '../src/session-data';
import type { SessionId } from '../src/ids';
const sid = 'actions' as SessionId;
const row = (id: string, role: SessionTurn['role'] = 'assistant'): SessionEntry => ({
  id,
  role,
  timestamp: '2026-01-01T00:00:00Z',
  items: [{ type: 'text', text: id }],
  fileDiff: [],
});
for (const backend of ['loro'] as const)
  describe(`history actions ${backend}`, () => {
    const create = () => createLoroSessionData({ sessionId: sid, doc: new LoroDoc() });
    const seed = async (data: SessionData) => {
      for (const t of [row('u', 'user'), row('a'), row('other')])
        requireSessionAccepted(await data.commands.appendTurn(t));
    };
    it('updates the selected user and keeps status/read paired', async () => {
      const data = create();
      await seed(data);
      requireSessionAccepted(
        await data.commands.applyHistoryAction({
          kind: 'user-status',
          turnId: 'u',
          status: 'pending',
        })
      );
      const before = await data.history.readAll();
      requireSessionAccepted(
        await data.commands.applyHistoryAction({
          kind: 'user-status',
          turnId: 'u',
          status: 'processing',
          deliveredSteer: true,
        })
      );
      const after = await data.history.readAll();
      expect(after[0]).toMatchObject({
        status: 'processing',
        read: true,
        inputConfig: { _lodyDeliveryKind: 'steer' },
      });
      expect(after.slice(1)).toEqual(before.slice(1));
      expect(
        requireSessionAccepted(
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
      requireSessionAccepted(
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
        })
      );
      requireSessionAccepted(
        await data.commands.applyHistoryAction({
          kind: 'permission-request',
          requestId: 'new',
          request: {
            sessionId: 'acp',
            toolCall: { toolCallId: 'c', title: 'incoming' },
            options: [],
          },
        })
      );
      expect((await data.history.readAll())[0]?.items?.[0]).toMatchObject({
        title: 'existing',
        permissionRequest: { requestId: 'new', outcome: { outcome: 'cancelled' } },
      });
    });
    it('finishes only the requested assistant and preserves its original end time', async () => {
      const data = create();
      await seed(data);
      requireSessionAccepted(
        await data.commands.applyHistoryAction({
          kind: 'finish-assistant',
          turnId: 'a',
          endedAt: 42,
        })
      );
      requireSessionAccepted(
        await data.commands.applyHistoryAction({
          kind: 'finish-assistant',
          turnId: 'a',
          endedAt: 99,
        })
      );
      const history = await data.history.readAll();
      expect(history[1]).toMatchObject({ finished: true, endedAt: 42 });
      expect(history[2]?.finished).toBeUndefined();
    });
    it('rejects malformed content without changing history', async () => {
      const data = create();
      await seed(data);
      const before = await data.history.readAll();
      const result = await data.commands.applyHistoryAction({
        kind: 'assistant-items',
        turnId: 'a',
        mode: 'replace',
        items: [{ type: 'text', text: 42 } as never],
      });
      expect(result.status).toBe('rejected');
      expect(await data.history.readAll()).toEqual(before);
    });
    it('keeps proposal publication idempotent and refuses a stable-id collision', async () => {
      const data = create();
      const action = {
        kind: 'task-proposal' as const,
        turnId: 'proposal',
        timestamp: '2026-01-01T00:00:00Z',
        meta: { proposalId: 'p', title: 'task', proposedBy: { kind: 'agent' as const } },
      };
      requireSessionAccepted(await data.commands.applyHistoryAction(action));
      expect(requireSessionAccepted(await data.commands.applyHistoryAction(action)).matched).toBe(
        false
      );
      const before = await data.history.readAll();
      const result = await data.commands.applyHistoryAction({
        ...action,
        meta: { ...action.meta, proposalId: 'different' },
      });
      expect(result.status).toBe('rejected');
      expect(await data.history.readAll()).toEqual(before);
    });
  });
it('retains an opaque stored item during a named field action', async () => {
  const doc = new LoroDoc();
  const data = createLoroSessionData({ sessionId: sid, doc });
  requireSessionAccepted(await data.commands.appendTurn(row('a')));
  const map = doc.getList('history').get(0) as LoroMap;
  const items = map.get('items') as LoroList;
  items.push({ type: 'future', payload: { keep: true } });
  doc.commit();
  requireSessionAccepted(
    await data.commands.applyHistoryAction({ kind: 'finish-assistant', turnId: 'a', endedAt: 42 })
  );
  expect((await data.history.readAll())[0]?.items?.[1]).toEqual({
    type: 'future',
    payload: { keep: true },
  });
});

for (const backend of ['loro'] as const)
  it(`${backend}: an ended-steer fallback only changes pending_apply`, async () => {
    const data = createLoroSessionData({ sessionId: sid, doc: new LoroDoc() });
    requireSessionAccepted(
      await data.commands.appendTurn({ ...row('u', 'user'), status: 'pending_apply' })
    );
    const action = {
      kind: 'user-status' as const,
      turnId: 'u',
      status: 'pending' as const,
      onlyPendingApply: true,
    };
    expect(requireSessionAccepted(await data.commands.applyHistoryAction(action)).matched).toBe(
      true
    );
    requireSessionAccepted(
      await data.commands.applyHistoryAction({
        kind: 'user-status',
        turnId: 'u',
        status: 'processing',
      })
    );
    expect(requireSessionAccepted(await data.commands.applyHistoryAction(action)).matched).toBe(
      false
    );
    expect((await data.history.readAll())[0]).toMatchObject({ status: 'processing', read: true });
    expect(
      requireSessionAccepted(
        await data.commands.applyHistoryAction({ ...action, turnId: 'missing' })
      ).matched
    ).toBe(false);
    expect(
      requireSessionAccepted(
        await data.commands.applyHistoryAction({
          kind: 'user-status',
          turnId: 'missing',
          status: 'pending',
          requeueUndelivered: true,
        })
      ).matched
    ).toBe(true);
    requireSessionAccepted(
      await data.commands.appendTurn({ ...row('a'), fileDiff: [{ filePath: 'x', add: 1, del: 0 }] })
    );
    requireSessionAccepted(
      await data.commands.applyHistoryAction(
        JSON.parse(
          JSON.stringify({ kind: 'assistant-file-diff', turnId: 'a', change: { kind: 'clear' } })
        )
      )
    );
    expect((await data.history.readAll())[1]).not.toHaveProperty('fileDiff');
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

it('Loro structural actions report membership changes even without a target hint', async () => {
  const data = createLoroSessionData({ sessionId: sid, doc: new LoroDoc() });
  const changes: unknown[] = [];
  const subscription = data.history.observe((change) => changes.push(change));
  await subscription.initial;
  requireSessionAccepted(
    await data.commands.applyHistoryAction({ kind: 'upsert-turn', turn: row('a') })
  );
  expect(changes.at(-1)).toMatchObject({ kind: 'changed', from: 0, to: 1, structural: true });
  requireSessionAccepted(
    await data.commands.applyHistoryAction({ kind: 'remove-turn', turnId: 'a' })
  );
  expect(changes.at(-1)).toMatchObject({ kind: 'changed', from: 0, to: 0, structural: true });
  subscription.unsubscribe();
});
