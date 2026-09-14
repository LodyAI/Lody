import { it, expect, vi } from 'vitest';
import { LoroDoc, LoroList, LoroMap } from 'loro-crdt';
import { createLoroSessionData, type SessionDataChange } from '../src/session-data';
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
    data = createLoroSessionData({ doc, sessionId, writer });
  const sibling = list.get(1);
  await data.commands.applyHistoryAction({
    kind: 'user-status',
    turnId: 'old',
    status: 'processing',
  });
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
  const data = createLoroSessionData({ doc, sessionId, writer });
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
  data.dispose();
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
  const data = createLoroSessionData({ doc, sessionId, writer });
  expect(
    await data.commands.replaceEditableTail({
      expectedUserTurnId: 'u',
      expectedForkTurnId: undefined,
      replacement: turn('replacement'),
    })
  ).toEqual({ status: 'indeterminate', cause: error });
  expect(writer.read('replacement')).toBeDefined();
});

it('reuses pending reads while observing uncommitted replacement, duplicates and renames', () => {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  for (let i = 0; i < 100; i++) writer.append(turn(`t${i}`));
  const data = createLoroSessionData({ doc, sessionId, writer });
  const list = doc.getList('history');
  const read = (id: string) => data.history.readTurn(id);
  const originalFrontiers = doc.frontiers();
  try {
    doc.getMap('session').set('id', 'pending');
    const pending = doc.getPendingTxnLength();
    expect(pending).toBeGreaterThan(0);
    expect(read('t99')).toMatchObject({ state: 'ready', turn: { id: 't99' } });
    const get = vi.spyOn(LoroList.prototype, 'get');
    try {
      for (let i = 0; i < 10; i++)
        expect(read(`t${i}`)).toMatchObject({ state: 'ready', turn: { id: `t${i}` } });
      expect(get.mock.calls.length).toBeLessThan(100);
      expect(doc.getPendingTxnLength()).toBe(pending);
    } finally {
      get.mockRestore();
    }
    list.delete(99, 1);
    list.insert(99, { ...turn('t0'), items: [{ type: 'text', text: 'newest' }] });
    expect(read('t99')).toEqual({ state: 'missing' });
    expect(read('t0')).toMatchObject({ turn: { items: [{ text: 'newest' }] } });
    list.delete(99, 1);
    expect(read('t0')).toMatchObject({ turn: { items: [{ text: 't0' }] } });
    const first = list.get(0) as LoroMap;
    first.set('id', 'renamed');
    expect(read('t0')).toEqual({ state: 'missing' });
    expect(read('renamed')).toMatchObject({ state: 'ready' });
    doc.commit();
    first.set('id', 'next');
    expect(read('next')).toMatchObject({ state: 'ready' });
    doc.commit();
    first.set('id', 'last');
    expect(read('next')).toEqual({ state: 'missing' });
    expect(read('last')).toMatchObject({ state: 'ready' });
    doc.commit();
    // Checkout changes state without reducing oplog opCount.
    doc.checkout(originalFrontiers);
    expect(read('last')).toEqual({ state: 'missing' });
    expect(read('t99')).toMatchObject({ state: 'ready' });
    doc.attach();
    expect(read('last')).toMatchObject({ state: 'ready' });
    const peer = doc.fork();
    try {
      (peer.getList('history').get(0) as LoroMap).set('id', 'remote');
      doc.import(peer.export({ mode: 'update' }));
      expect(read('last')).toEqual({ state: 'missing' });
      expect(read('remote')).toMatchObject({ state: 'ready' });
    } finally {
      peer.free();
    }
  } finally {
    data.dispose();
    doc.free();
  }
});

it('distinguishes turn identity edits from nested IDs and ordinary content changes', async () => {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  writer.append(turn('first'));
  writer.append(turn('second'));
  const data = createLoroSessionData({ doc, sessionId, writer });
  const changes: SessionDataChange[] = [];
  const observation = data.history.observe((change) => changes.push(change));
  await observation.initial;
  try {
    const map = doc.getList('history').get(1) as LoroMap;
    const nested = map.setContainer('future', new LoroMap());
    nested.set('id', 'nested');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'changed', ids: ['second'] }]);
    nested.set('id', 'nested-renamed');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'changed', ids: ['second'] }]);
    map.set('status', 'seen');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'changed', ids: ['second'] }]);
    map.set('id', 'renamed');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'structure', from: 1, to: 2 }]);
    map.delete('id');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'structure', from: 1, to: 2 }]);
    map.set('id', 'restored');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'structure', from: 1, to: 2 }]);
    expect(data.history.readTurn('restored')).toMatchObject({ turn: { id: 'restored' } });
  } finally {
    observation.unsubscribe();
    data.dispose();
    doc.free();
  }
});
