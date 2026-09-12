import { it, expect, vi } from 'vitest';
import { LoroDoc, LoroList, LoroMap } from 'loro-crdt';
import { createLoroSessionData, requireSessionAccepted } from '../src/session-data';
import { createHistoryWriter } from '../src/history-writer';
import type { SessionId } from '../src/ids';
const sessionId = 'review-boundaries' as SessionId;
const turn = (id: string) => ({
  id,
  role: 'user' as const,
  timestamp: 'synthetic',
  items: [{ type: 'text' as const, text: id }],
  status: 'pending' as const,
});
it('inline legacy rows remain writable without changing their opaque data or siblings', async () => {
  const doc = new LoroDoc(),
    list = doc.getList('history');
  list.insert(0, {
    ...turn('old'),
    items: [{ type: 'future_item', payload: 'keep' }],
    future: { x: 1 },
  });
  list.insert(1, turn('other'));
  doc.commit();
  const writer = createHistoryWriter(doc),
    data = createLoroSessionData({ doc, sessionId, writer, durability: 'unavailable' });
  const sibling = list.get(1);
  requireSessionAccepted(
    await data.commands.applyHistoryAction({
      kind: 'user-status',
      turnId: 'old',
      status: 'processing',
    })
  );
  expect(list.get(0)).toMatchObject({
    status: 'processing',
    read: true,
    items: [{ type: 'future_item', payload: 'keep' }],
    future: { x: 1 },
  });
  writer.setField('old', 'read', undefined);
  expect(list.get(0)).not.toHaveProperty('read');
  writer.replace('old', { ...writer.read('old')!, status: 'handled' });
  expect(list.get(0)).toMatchObject({ status: 'handled' });
  writer.update((rows) => {
    rows[0]!.status = 'seen';
    return rows;
  });
  expect(list.get(0)).toMatchObject({ status: 'seen' });
  expect(list.get(1)).toEqual(sibling);
  const before = doc.toJSON();
  expect(() => writer.updateEntry('old', (row) => ({ ...row, status: 'bad' as never }))).toThrow();
  expect(doc.toJSON()).toEqual(before);
  const reopened = new LoroDoc();
  reopened.import(doc.export({ mode: 'snapshot' }));
  expect(reopened.toJSON()).toEqual(before);
});
it('body reads reuse a shallow ID index and follow duplicate, renamed and shifted IDs', async () => {
  const doc = new LoroDoc(),
    writer = createHistoryWriter(doc);
  for (let n = 0; n < 128; n++) writer.append(turn(`t${n}`));
  const data = createLoroSessionData({ doc, sessionId, writer, durability: 'unavailable' });
  await data.history.readTurn('t0');
  const get = vi.spyOn(LoroList.prototype, 'get');
  try {
    for (let n = 0; n < 128; n++) {
      const read = await data.history.readTurn(`t${n}`);
      expect(read).toMatchObject({ state: 'ready', turn: { id: `t${n}` } });
    }
    expect(get.mock.calls.length).toBeLessThan(512);
  } finally {
    get.mockRestore();
  }
  const list = doc.getList('history');
  list.insert(0, turn('head'));
  doc.commit();
  expect(await data.history.readTurn('t0')).toMatchObject({ state: 'ready', turn: { id: 't0' } });
  const map = list.get(1) as LoroMap;
  map.set('id', 'renamed');
  doc.commit();
  expect(await data.history.readTurn('t0')).toEqual({ state: 'missing' });
  expect(await data.history.readTurn('renamed')).toMatchObject({ state: 'ready' });
  list.insert(list.length, { ...turn('head'), items: [{ type: 'text', text: 'newest' }] });
  doc.commit();
  expect(await data.history.readTurn('head')).toMatchObject({
    state: 'ready',
    turn: { items: [{ text: 'newest' }] },
  });
  list.delete(list.length - 1, 1);
  doc.commit();
  expect(await data.history.readTurn('head')).toMatchObject({
    state: 'ready',
    turn: { items: [{ text: 'head' }] },
  });
  data.snapshots.closeSource();
});
it('unknown failure after tail replacement reaches the indeterminate phase', async () => {
  const doc = new LoroDoc(),
    writer = createHistoryWriter(doc);
  writer.append(turn('u'));
  const error = new Error('commit outcome unknown');
  const real = writer.updateWithRollback;
  writer.updateWithRollback = (update) => {
    real(update);
    throw error;
  };
  const data = createLoroSessionData({ doc, sessionId, writer, durability: 'unavailable' });
  expect(
    await data.commands.replaceEditableTail({
      expectedUserTurnId: 'u',
      expectedForkTurnId: undefined,
      replacement: turn('replacement'),
    })
  ).toEqual({ status: 'indeterminate', cause: error });
  expect(writer.read('replacement')).toBeDefined();
});
