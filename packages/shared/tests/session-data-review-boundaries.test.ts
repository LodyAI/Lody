import { it, expect, vi } from 'vitest';
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { resolveLatestSessionGoalFromHistory } from '../src/goal';
import {
  createLoroSessionData,
  readSessionHistoryMetadata,
  type SessionDataChange,
} from '../src/session-data';
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

it.each(['json', 'containers', 'text'] as const)(
  'goal inspection matches complete history for %s storage without changing it',
  (shape) => {
    const goal = (status = 'active') => ({
      type: 'goal',
      threadId: '',
      objective: 'Keep working',
      status,
      extension: { retained: ['opaque'] },
    });
    const fixtures = [
      [],
      [{ items: [goal()] }, ...Array.from({ length: 85 }, (_, i) => turn(`ordinary-${i}`))],
      [{ items: [goal()] }, { items: [goal('paused')] }],
      [{ items: [goal(), goal('cleared')] }],
      [{ items: [goal('future-status')] }],
      [{ items: [goal()] }, { items: [{ type: 'goal', threadId: 'bad', status: 'active' }] }],
      [{ items: [{ ...goal(), objective: 5 }] }],
      [{ items: [{ ...goal(), status: {} }] }],
      [null, [], 'invalid', { role: 'system', items: [goal()] }],
      [{ items: { goal: goal() } }],
      [{ items: [{ type: 'tool_call', output: goal() }] }],
      [
        { timestamp: 'later', items: [goal()] },
        { timestamp: 'earlier', items: [goal('complete')] },
      ],
    ];
    const fill = (map: LoroMap, value: Record<string, unknown>) => {
      for (const [key, field] of Object.entries(value)) {
        if (Array.isArray(field)) {
          const list = map.setContainer(key, new LoroList());
          for (const item of field) {
            if (item && typeof item === 'object' && !Array.isArray(item))
              fill(list.pushContainer(new LoroMap()), item);
            else list.push(item as never);
          }
        } else if (field && typeof field === 'object') {
          fill(map.setContainer(key, new LoroMap()), field as Record<string, unknown>);
        } else if (shape === 'text' && typeof field === 'string') {
          map.setContainer(key, new LoroText()).insert(0, field);
        } else map.set(key, field as never);
      }
    };
    for (const fixture of fixtures) {
      const doc = new LoroDoc();
      const list = doc.getList('history');
      for (const entry of fixture) {
        if (shape !== 'json' && entry && typeof entry === 'object' && !Array.isArray(entry))
          fill(list.pushContainer(new LoroMap()), entry);
        else list.push(entry as never);
      }
      doc.commit();
      const data = createLoroSessionData({ doc, sessionId });
      try {
        const reference = resolveLatestSessionGoalFromHistory(data.history.readAll());
        const version = doc.oplogVersion().encode();
        const actual = data.readLatestGoal();
        expect(actual).toEqual(reference);
        if (actual) actual.objective = 'caller mutation';
        expect(data.readLatestGoal()).toEqual(reference);
        expect(doc.oplogVersion().encode()).toEqual(version);
      } finally {
        data.dispose();
      }
    }
  }
);

it('goal inspection leaves ordinary bodies and whole history unread', () => {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  writer.append({
    ...turn('goal-owner'),
    items: [{ type: 'goal', threadId: 'g', objective: 'Retain', status: 'active' }],
  });
  for (let i = 0; i < 85; i++) writer.append(turn(`ordinary-${i}`));
  const data = createLoroSessionData({ doc, sessionId, writer });
  const expected = resolveLatestSessionGoalFromHistory(data.history.readAll());
  const json = LoroMap.prototype.toJSON;
  const mapGuard = vi
    .spyOn(LoroMap.prototype, 'toJSON')
    .mockImplementation(function (this: LoroMap) {
      if (this.get('type') !== 'goal') throw new Error('ordinary body materialized');
      return json.call(this);
    });
  const listGuard = vi.spyOn(LoroList.prototype, 'toJSON').mockImplementation(() => {
    throw new Error('whole list materialized');
  });
  try {
    expect(data.readLatestGoal()).toEqual(expected);
  } finally {
    mapGuard.mockRestore();
    listGuard.mockRestore();
    data.dispose();
  }
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

it('reads display task summaries without materializing child bodies and loads one exact run on demand', () => {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  const body = 'SYNTHETIC_CHILD_BODY '.repeat(5000);
  writer.append({
    id: 'owner',
    role: 'assistant',
    timestamp: 'synthetic',
    items: ['a', 'b'].map((taskId) => ({
      type: 'subagent_task',
      taskId,
      status: 'in_progress',
      run: {
        sessionId: 'root',
        snapshot: {
          state: 'running',
          support: {
            stream: ['text', 'tool'],
            progress: false,
            cancel: false,
            outputRead: 'none',
          },
        },
        items: [
          {
            type: 'tool_call',
            toolCallId: taskId,
            status: 'completed',
            kind: 'edit',
            content: [{ type: 'diff', path: '/synthetic.txt', oldText: body, newText: body }],
          },
          { type: 'text', text: body + '\nLatest action' },
        ],
      },
    })),
  });
  doc.commit();
  const data = createLoroSessionData({ doc, sessionId, writer });
  const version = doc.oplogVersion().encode();
  const owner = doc.getList('history').get(0) as LoroMap;
  const tasks = owner.get('items') as LoroList;
  const taskA = tasks.get(0) as LoroMap;
  const runA = taskA.get('run') as LoroMap;
  const runB = (tasks.get(1) as LoroMap).get('run') as LoroMap;
  const childrenA = runA.get('items') as LoroList;
  const childrenB = runB.get('items') as LoroList;
  const forbidden = new Set([owner.id, taskA.id, runA.id, runB.id]);
  const json = LoroMap.prototype.toJSON;
  const guard = vi.spyOn(LoroMap.prototype, 'toJSON').mockImplementation(function (this: LoroMap) {
    if (forbidden.has(this.id)) throw new Error('eager subtree read');
    return json.call(this);
  });
  const get = LoroList.prototype.get;
  const listGuard = vi
    .spyOn(LoroList.prototype, 'get')
    .mockImplementation(function (this: LoroList, index) {
      if ((this.id === childrenA.id || this.id === childrenB.id) && index === 0)
        throw new Error('offscreen child body was read');
      return get.call(this, index);
    });
  try {
    const read = data.history.readTurnForDisplay('owner');
    expect(read.state).toBe('ready');
    if (read.state !== 'ready') throw new Error('missing display turn');
    expect(read.turn.items).toMatchObject([
      { taskId: 'a', run: { items: [{ type: 'text' }] } },
      { taskId: 'b', run: { items: [{ type: 'text' }] } },
    ]);
    const preview = JSON.stringify(read);
    expect(preview.length).toBeLessThan(3000);
    expect(preview).toContain('Latest action');
    expect(preview).not.toContain(body);
    expect(data.history.readSubagentRun('owner', 'other-root', 'a')).toBeUndefined();
    expect(data.history.readSubagentRun('other-owner', 'root', 'a')).toBeUndefined();
    forbidden.delete(runA.id);
    const run = data.history.readSubagentRun('owner', 'root', 'a');
    expect(run?.items).toHaveLength(2);
    expect(run?.items[1]).toEqual({ type: 'text', text: body + '\nLatest action' });
  } finally {
    guard.mockRestore();
    listGuard.mockRestore();
  }
  expect(data.history.readAll()[0]?.items).toHaveLength(2);
  expect(JSON.stringify(data.history.readAll())).toContain(body);
  expect(doc.oplogVersion().encode()).toEqual(version);
  data.dispose();
});

it('preserves stored extension keys that overlap Object prototype methods in display reads', () => {
  const doc = new LoroDoc();
  const row = doc.getList('history').insertContainer(0, new LoroMap());
  row.set('id', 'owner');
  row.set('role', 'assistant');
  row.set('timestamp', 'synthetic');
  row.set('toString', 'opaque-future-field');
  row.set('constructor', 'opaque-constructor');
  doc.commit();
  const data = createLoroSessionData({ doc, sessionId });
  try {
    expect(data.history.readTurnForDisplay('owner')).toEqual(data.history.readTurn('owner'));
  } finally {
    data.dispose();
  }
});

it.each(
  (['writer', 'inline'] as const).flatMap((storage) =>
    [false, true].map((emptyMcp) => ({ storage, emptyMcp }))
  )
)(
  'preserves every send-config field through $storage metadata (empty MCP: $emptyMcp)',
  async ({ storage, emptyMcp }) => {
    const doc = new LoroDoc(),
      writer = createHistoryWriter(doc);
    const config = {
      _lodyDeliveryKind: 'steer' as const,
      agentRoleId: 'synthetic-role',
      agentRoleRevision: 7,
      agentRoleSnapshot: {
        id: 'synthetic-role',
        revision: 7,
        name: 'Synthetic reviewer',
        emoji: '🔎',
      },
      modeId: 'plan',
      modelId: 'synthetic-model',
      cliType: 'builtin' as const,
      agentType: 'codex',
      memory: { providerId: 'synthetic-provider', memoryId: 'synthetic-memory' },
      mcpServerIds: emptyMcp ? [] : ['synthetic-mcp'],
      configOptionValues: { reasoning_effort: 'high', fast: false },
    };
    const entry = {
      ...turn('config-user'),
      inputConfig: {
        ...config,
        prompt: 'Synthetic stored prompt',
        inputBlocks: [{ type: 'text' as const, text: 'Synthetic input block' }],
      },
    };
    const list = doc.getList('history');
    if (storage === 'writer') writer.append(entry);
    else {
      list.push(entry);
      doc.commit();
    }
    const data = createLoroSessionData({ doc, sessionId, writer });
    const row = list.get(0);
    const forbidden = new Set<string>([list.id]);
    if (row instanceof LoroMap) {
      forbidden.add(row.id);
      for (const field of [row.get('items'), row.get('inputConfig')])
        if (field instanceof LoroMap || field instanceof LoroList) forbidden.add(field.id);
    }
    const mapJson = LoroMap.prototype.toJSON,
      listJson = LoroList.prototype.toJSON;
    const mapGuard = vi.spyOn(LoroMap.prototype, 'toJSON').mockImplementation(function () {
      if (forbidden.has(this.id)) throw new Error('Whole turn or input config materialized');
      return mapJson.call(this);
    });
    const listGuard = vi.spyOn(LoroList.prototype, 'toJSON').mockImplementation(function () {
      if (forbidden.has(this.id)) throw new Error('History or transcript body materialized');
      return listJson.call(this);
    });
    const version = doc.oplogVersion().encode();
    try {
      const metadata = await readSessionHistoryMetadata(data.history);
      expect(metadata[0]?.inputConfig).toEqual(config);
      expect(doc.oplogVersion().encode()).toEqual(version);
    } finally {
      mapGuard.mockRestore();
      listGuard.mockRestore();
      data.dispose();
      doc.free();
    }
  }
);

it('reads legacy text-container identities and configuration through metadata only', async () => {
  const doc = new LoroDoc(),
    row = doc.getList('history').pushContainer(new LoroMap());
  const text = (map: LoroMap, key: string, value: string) =>
    map.setContainer(key, new LoroText()).insert(0, value);
  text(row, 'id', 'legacy-user');
  text(row, 'role', 'user');
  text(row, 'timestamp', 'synthetic');
  text(row, 'userId', 'legacy-author');
  const config = row.setContainer('inputConfig', new LoroMap());
  text(config, 'modelId', 'legacy-model');
  text(config, 'modeId', 'legacy-mode');
  row
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap())
    .setContainer('text', new LoroText())
    .insert(0, 'old payload'.repeat(10000));
  doc.commit();
  const data = createLoroSessionData({ doc, sessionId });
  const full = vi.spyOn(data.history, 'readAll').mockImplementation(() => {
    throw new Error('whole history forbidden');
  });
  try {
    expect(await readSessionHistoryMetadata(data.history)).toMatchObject([
      {
        id: 'legacy-user',
        role: 'user',
        userId: 'legacy-author',
        inputConfig: { modelId: 'legacy-model', modeId: 'legacy-mode' },
      },
    ]);
  } finally {
    full.mockRestore();
    data.dispose();
  }
});
