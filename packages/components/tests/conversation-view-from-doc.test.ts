import { describe, expect, it, vi } from 'vitest';
import {
  createHistoryWriter,
  resolveSessionConversationConfig,
  type SessionHistory,
} from '@lody/shared';
import { LoroMap, LoroText, LoroList, type ContainerID } from 'loro-crdt';
import {
  collectConversationConfigSources,
  createConversationViewFromDoc,
  createConversationSession,
} from '../src/lib/conversation-view';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
  mirrorHistoryOf,
  reimport,
} from './conversation-view-fixtures';

const scalarsOf = (entry: Record<string, unknown>) => ({
  id: entry.id,
  role: entry.role,
  timestamp: entry.timestamp,
  status: entry.status,
  finished: entry.finished,
  endedAt: entry.endedAt,
  sendStatus: entry.sendStatus,
  userTurnId: entry.userTurnId,
  acpTurnId: entry.acpTurnId,
});

const openView = (
  rounds: number,
  options: { tailKeep?: number; maxHydrated?: number; hydrateItemBudget?: number } = {}
) => {
  const history = buildFixtureHistory(rounds);
  const doc = reimport(buildSessionDoc(history));
  const expected = mirrorHistoryOf(reimport(doc));
  const idle = createManualIdle();
  const view = createConversationViewFromDoc(doc, {
    sessionId: FIXTURE_SESSION_ID,
    tailKeep: options.tailKeep ?? 4,
    maxHydrated: options.maxHydrated ?? 6,
    scheduleIdle: idle.scheduleIdle,
    yieldToEventLoop: () => Promise.resolve(),
    hydrateChunkSize: 8,
    hydrateItemBudget: options.hydrateItemBudget ?? 10_000,
  });
  return { history, doc, expected, idle, view };
};

const turnMapAt = (
  view: ReturnType<typeof openView>['view'],
  doc: ReturnType<typeof openView>['doc'],
  i: number
) => {
  const cid = (doc.getList('history') as LoroList).getShallowValue()[i] as ContainerID;
  void view;
  return doc.getContainerById(cid) as LoroMap;
};

describe('createConversationViewFromDoc', () => {
  it.each([
    ['map', 'sticky-role'],
    ['map', null],
    ['legacy JSON', 'sticky-role'],
    ['legacy JSON', null],
  ] as const)('preserves sticky Role on a send before idle: %s / %s', async (storage, roleId) => {
    const history = buildFixtureHistory(50).map((turn) => ({
      ...turn,
      inputConfig: turn.role === 'user' ? { modeId: 'default' } : undefined,
    })) as SessionHistory[];
    history[0]!.inputConfig = { agentRoleId: 'older-role', agentRoleRevision: 1 } as never;
    history[2]!.inputConfig = {
      agentRoleId: roleId,
      ...(roleId ? { agentRoleRevision: 2 } : {}),
    } as never;
    const doc = reimport(buildSessionDoc(history));
    const target = doc.getList('history').get(2) as LoroMap;
    if (storage === 'legacy JSON') {
      target.set('inputConfig', history[2]!.inputConfig as never);
      doc.commit();
    }
    const expected = resolveSessionConversationConfig(mirrorHistoryOf(reimport(doc)));
    const before = doc.version().toJSON();
    const idle = createManualIdle();
    const toJSON = LoroMap.prototype.toJSON;
    const guard = vi.spyOn(LoroMap.prototype, 'toJSON').mockImplementation(function () {
      if (this.id === target.id) throw new Error('Role lookup materialized an old turn body');
      return toJSON.call(this);
    });
    const view = createConversationViewFromDoc(doc, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 2,
      maxHydrated: 2,
      scheduleIdle: idle.scheduleIdle,
    });
    const resolve = () =>
      resolveSessionConversationConfig(collectConversationConfigSources(view, view.turnCount - 2));
    try {
      expect(resolve().agentRoleId).toBe(expected.agentRoleId);
      expect(resolve().agentRoleRevision).toBe(expected.agentRoleRevision);
      expect(view.isHydrated(2)).toBe(false);
      expect(doc.version().toJSON()).toEqual(before);
      const selection = resolve();
      createHistoryWriter(doc).append({
        id: 'early-send',
        role: 'user',
        timestamp: 'synthetic',
        items: [{ type: 'text', text: 'synthetic' }],
        inputConfig: {
          agentRoleId: selection.agentRoleId ?? null,
          agentRoleRevision: selection.agentRoleRevision,
        },
      });
      idle.runAll();
      await view.ready;
      expect(resolve().agentRoleId).toBe(roleId);
    } finally {
      guard.mockRestore();
      view.dispose();
    }
    expect(resolveSessionConversationConfig(mirrorHistoryOf(reimport(doc))).agentRoleId).toBe(
      roleId
    );
  });

  it('refreshes old user Role metadata on peer edits and insertion before idle', () => {
    const { doc, view } = openView(12, { tailKeep: 0, maxHydrated: 0 });
    const peer = reimport(doc);
    const row = peer.getList('history').get(2) as LoroMap;
    const config = row.get('inputConfig') as LoroMap;
    const sync = () => {
      peer.commit();
      doc.import(peer.export({ mode: 'update', from: doc.version() }));
    };
    config.set('agentRoleId', null);
    config.delete('agentRoleRevision');
    sync();
    expect(view.index(2)?.inputConfig?.agentRoleId).toBeNull();
    expect(view.index(2)?.inputConfig?.agentRoleRevision).toBeUndefined();
    row.set('inputConfig', { agentRoleId: 'replacement-role', agentRoleRevision: 3 });
    sync();
    expect(view.index(2)?.inputConfig?.agentRoleId).toBe('replacement-role');
    row.delete('inputConfig');
    sync();
    expect(view.index(2)?.inputConfig).toBeUndefined();
    const inserted = peer.getList('history').insertContainer(0, new LoroMap());
    inserted.set('id', 'remote-role');
    inserted.set('role', 'user');
    inserted.set('inputConfig', { agentRoleId: 'inserted-role', agentRoleRevision: 4 });
    sync();
    expect(view.index(0)?.inputConfig?.agentRoleId).toBe('inserted-role');
    expect(view.isHydrated(0)).toBe(false);
    expect(view.isHydrated(3)).toBe(false);
    view.dispose();
  });

  it('releases only its own containers after an insertion shifts overlapping leases', async () => {
    const { doc, view } = openView(6, { tailKeep: 0, maxHydrated: 1 });
    const first = view.acquireRange(2, 3);
    const second = view.acquireRange(1, 3);
    await Promise.all([first.ready, second.ready]);
    const inserted = doc.getList('history').insertContainer(0, new LoroMap());
    inserted.set('id', 'inserted');
    inserted.set('role', 'system');
    doc.commit();
    first.release();
    first.release(); // A repeated cleanup cannot remove the other owner's pin.
    const unrelated = view.acquireRange(8, 9);
    await unrelated.ready;
    unrelated.release();
    expect(view.isHydrated(view.indexOf('a-0'))).toBe(true);
    expect(view.isHydrated(view.indexOf('u-1'))).toBe(true);
    second.release();
    expect(
      Array.from({ length: view.turnCount }, (_, i) => view.isHydrated(i)).filter(Boolean)
    ).toHaveLength(1);
    view.dispose();
  });

  it('stops chunked hydration when its lease is released', async () => {
    const doc = reimport(buildSessionDoc(buildFixtureHistory(6)));
    let resume!: () => void;
    const view = createConversationViewFromDoc(doc, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      maxHydrated: 0,
      hydrateChunkSize: 1,
      scheduleIdle: createManualIdle().scheduleIdle,
      yieldToEventLoop: () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    });
    const range = view.acquireRange(0, 8);
    expect(view.isHydrated(0)).toBe(true);
    range.release();
    resume();
    await range.ready;
    expect(Array.from({ length: view.turnCount }, (_, i) => view.isHydrated(i)).some(Boolean)).toBe(
      false
    );
    view.dispose();
  });

  it('releases pins when chunked hydration fails', async () => {
    const doc = reimport(buildSessionDoc(buildFixtureHistory(3)));
    const view = createConversationViewFromDoc(doc, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      maxHydrated: 0,
      hydrateChunkSize: 1,
      scheduleIdle: createManualIdle().scheduleIdle,
      yieldToEventLoop: () => Promise.reject(new Error('synthetic hydration failure')),
    });
    const range = view.acquireRange(0, 4);
    await expect(range.ready).rejects.toThrow('synthetic hydration failure');
    expect(view.isHydrated(0)).toBe(false);
    view.dispose();
  });

  it('indexes every turn eagerly with the scalars Mirror exposes', () => {
    const { expected, view } = openView(12);
    expect(view.turnCount).toBe(expected.length);
    expected.forEach((entry, i) => {
      const row = view.index(i)!;
      expect(scalarsOf(row as unknown as Record<string, unknown>)).toEqual(
        scalarsOf(entry as unknown as Record<string, unknown>)
      );
      expect(view.indexOf(entry.id)).toBe(i);
    });
    expect(view.indexOf('missing')).toBe(-1);
  });

  it('resolves item counts for the hydrated tail and leaves the rest to the idle pass', async () => {
    // The eager pass is one shallow read per turn: counts would cost two more
    // container crossings each and nothing needs them before first paint.
    const { expected, idle, view } = openView(12, { tailKeep: 4 });
    const tailFrom = expected.length - 4;
    for (let i = 0; i < tailFrom; i += 1) expect(view.index(i)?.itemCount).toBeUndefined();
    for (let i = tailFrom; i < expected.length; i += 1) {
      expect(view.index(i)?.itemCount).toBe(expected[i]!.items?.length ?? 0);
      expect(view.index(i)?.planCount).toBe(expected[i]!.plan?.length ?? 0);
    }
    idle.runAll();
    await view.ready;
    expected.forEach((entry, i) => {
      expect(view.index(i)?.itemCount).toBe(entry.items?.length ?? 0);
      expect(view.index(i)?.planCount).toBe(entry.plan?.length ?? 0);
    });
  });

  it('hydrates the tail eagerly and everything else on demand, equal to Mirror output', async () => {
    const { expected, view } = openView(12, { tailKeep: 4 });
    const n = expected.length;
    for (let i = 0; i < n; i += 1) expect(view.isHydrated(i)).toBe(i >= n - 4);
    expect(view.turn(n - 1)).toEqual(expected[n - 1]);
    expect(view.turn(0)).toBeUndefined();

    const range = view.acquireRange(0, 5);
    await range.ready;
    for (let i = 0; i < 5; i += 1) expect(view.turn(i)).toEqual(expected[i]);
    // Hydration filled summaries and the user's shallow config on the index.
    expect(view.index(0)?.summary?.headText).toContain('Round 0');
    expect(view.index(1)?.summary?.toolCalls).toBe(1);
    expect(view.index(2)?.inputConfig).toEqual({
      agentRoleId: 'role-1',
      agentRoleRevision: 1,
      modeId: 'plan',
      modelId: 'sonnet',
      cliType: 'builtin',
      agentType: 'claude',
      configOptionValues: { effort: 'low' },
    });
    range.release();
  });

  it('evicts unpinned, non-tail turns once maxHydrated is exceeded', async () => {
    const { view } = openView(20, { tailKeep: 2, maxHydrated: 6 });
    const range = view.acquireRange(0, 8); // pinned: 8 + tail 2 = 10 hydrated, over the cap but exempt
    await range.ready;
    for (let i = 0; i < 8; i += 1) expect(view.isHydrated(i)).toBe(true);
    range.release();
    let hydrated = 0;
    for (let i = 0; i < view.turnCount; i += 1) if (view.isHydrated(i)) hydrated += 1;
    expect(hydrated).toBe(6);
    expect(view.isHydrated(view.turnCount - 1)).toBe(true);
    // The most recently used turns survive.
    expect(view.isHydrated(7)).toBe(true);
    expect(view.isHydrated(0)).toBe(false);
  });

  it('chunks a large acquireRange and emits range changes per chunk', async () => {
    const { expected, view } = openView(30, { tailKeep: 2, maxHydrated: 500 });
    const changes: string[] = [];
    view.subscribe((change) => changes.push(change.kind));
    const range = view.acquireRange(0, expected.length);
    await range.ready;
    for (let i = 0; i < expected.length; i += 1) expect(view.turn(i)).toEqual(expected[i]);
    expect(changes.filter((kind) => kind === 'range').length).toBeGreaterThan(1);
    range.release();
  });

  it('applies streamed text and scalar updates to the hydrated tail and the index', () => {
    const { doc, view } = openView(6, { tailKeep: 2 });
    const last = view.turnCount - 1;
    const before = view.turn(last)!;
    const untouched = view.turn(last - 1)!;
    const versionBefore = view.version;
    const changes: { kind: string; from?: number; to?: number }[] = [];
    view.subscribe((change) => changes.push(change));

    const turnMap = turnMapAt(view, doc, last);
    const items = turnMap.get('items') as LoroList;
    const textItem = items.get(items.length - 1) as LoroMap;
    const text = textItem.get('text') as LoroText;
    text.insert(text.length, ' streamed');
    turnMap.set('finished', false);
    turnMap.delete('endedAt');
    doc.commit();

    const after = view.turn(last)!;
    expect(after).not.toBe(before);
    expect(after).toEqual(mirrorHistoryOf(reimport(doc))[last]);
    expect(after.items![0]).toBe(before.items![0]); // untouched items keep identity
    expect(view.turn(last - 1)).toBe(untouched);
    expect(view.index(last)?.finished).toBe(false);
    expect(view.index(last)?.endedAt).toBeUndefined();
    expect(view.index(last)?.summary?.headText).toContain('Answer for round');
    expect(view.version).toBeGreaterThan(versionBefore);
    expect(changes.some((change) => change.kind === 'tail' && change.from === last)).toBe(true);
  });

  it('sees appended turns, hydrates them into the tail, and ignores their own child events', () => {
    const { doc, view } = openView(4, { tailKeep: 3 });
    const list = doc.getList('history') as LoroList;
    const map = list.insertContainer(list.length, new LoroMap());
    map.set('id', 'u-appended');
    map.set('role', 'user');
    map.set('timestamp', '2026-01-02T00:00:00.000Z');
    const items = map.setContainer('items', new (list.constructor as new () => LoroList)());
    const item = items.insertContainer(0, new LoroMap());
    item.set('type', 'text');
    item.setContainer('text', new LoroText()).insert(0, 'appended text');
    doc.commit();

    expect(view.turnCount).toBe(9);
    expect(view.indexOf('u-appended')).toBe(8);
    expect(view.index(8)?.itemCount).toBe(1);
    expect(view.isHydrated(8)).toBe(true);
    expect(view.turn(8)).toEqual(mirrorHistoryOf(reimport(doc))[8]);
    expect(view.turn(8)!.items![0]).toEqual({ type: 'text', text: 'appended text' });
  });

  it('removes deleted turns from the index and hydrated set', () => {
    const { doc, view } = openView(4, { tailKeep: 2 });
    const list = doc.getList('history') as LoroList;
    const removedId = view.index(1)!.id;
    list.delete(1, 1);
    doc.commit();
    expect(view.turnCount).toBe(7);
    expect(view.indexOf(removedId)).toBe(-1);
    expect(view.turn(view.turnCount - 1)).toEqual(mirrorHistoryOf(reimport(doc))[6]);
    expect(view.index(1)?.id).toBe('u-1');
    expect(view.index(0)?.id).toBe('u-0');
  });

  it('fills summaries and shallow config for non-hydrated turns in idle chunks and resolves ready', async () => {
    const { expected, idle, view } = openView(30, { tailKeep: 2 });
    let indexChanges = 0;
    view.subscribe((change) => {
      if (change.kind === 'index') indexChanges += 1;
    });
    expect(view.index(0)?.summary).toBeUndefined();
    idle.runAll();
    await view.ready;
    expect(indexChanges).toBeGreaterThan(0);
    expected.forEach((entry, i) => {
      const row = view.index(i)!;
      expect(row.summary).toBeDefined();
      const firstText = entry.items?.find((item) => item.type === 'text');
      expect(row.summary?.headText).toBe(
        firstText && 'text' in firstText ? String(firstText.text).slice(0, 960) : ''
      );
      if (entry.role === 'user') {
        expect(row.inputConfig?.modeId).toBe((entry.inputConfig as { modeId: string }).modeId);
      }
    });
    expect(view.index(3)?.summary).toMatchObject({ toolCalls: 1, thoughts: 1 });
    expect(view.index(7)?.summary?.textChars).toBeGreaterThan(0);
  });

  it('re-summarizes a non-hydrated turn after its items change', async () => {
    const { doc, idle, view } = openView(10, { tailKeep: 2 });
    idle.runAll();
    await view.ready;
    const target = 3;
    const headBefore = view.index(target)?.summary?.headText;
    const turnMap = turnMapAt(view, doc, target);
    const items = turnMap.get('items') as LoroList;
    const textItem = items.get(items.length - 1) as LoroMap;
    (textItem.get('text') as LoroText).insert(0, 'PREFIX ');
    doc.commit();
    expect(view.index(target)?.summary).toBeUndefined();
    idle.runAll();
    expect(view.index(target)?.summary?.headText).not.toBe(headBefore);
    expect(view.index(target)?.summary?.headText.startsWith('PREFIX ')).toBe(true);
    expect(view.isHydrated(target)).toBe(false);
  });

  it('stops observing the doc after dispose', () => {
    const { doc, view } = openView(4, { tailKeep: 2 });
    const changes: unknown[] = [];
    view.subscribe((change) => changes.push(change));
    view.dispose();
    (doc.getList('history') as LoroList).delete(0, 1);
    doc.commit();
    expect(changes).toEqual([]);
  });
});

describe('createConversationViewFromDoc item budgets', () => {
  it('defers tail turns beyond the item budget to the idle pass, then hydrates them', async () => {
    const history = buildFixtureHistory(10);
    const doc = reimport(buildSessionDoc(history));
    const idle = createManualIdle();
    const view = createConversationViewFromDoc(doc, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 6,
      hydrateItemBudget: 8, // two or three fixture turns
      scheduleIdle: idle.scheduleIdle,
    });
    const n = view.turnCount;
    expect(view.isHydrated(n - 1)).toBe(true);
    let eager = 0;
    for (let i = n - 6; i < n; i += 1) if (view.isHydrated(i)) eager += 1;
    expect(eager).toBeGreaterThan(0);
    expect(eager).toBeLessThan(6);
    idle.runAll();
    await view.ready;
    for (let i = n - 6; i < n; i += 1) expect(view.isHydrated(i)).toBe(true);
    expect(view.turn(n - 6)).toEqual(mirrorHistoryOf(reimport(doc))[n - 6]);
  });

  it('cuts acquireRange chunks by item budget and still hydrates everything', async () => {
    const { expected, view } = openView(12, {
      tailKeep: 2,
      maxHydrated: 500,
      hydrateItemBudget: 12,
    });
    let rangeChanges = 0;
    view.subscribe((change) => {
      if (change.kind === 'range') rangeChanges += 1;
    });
    const range = view.acquireRange(0, expected.length);
    await range.ready;
    for (let i = 0; i < expected.length; i += 1) expect(view.turn(i)).toEqual(expected[i]);
    expect(rangeChanges).toBeGreaterThan(1);
    range.release();
  });
});

describe('body-independent configuration and tolerant summaries', () => {
  it('keeps explicit empty MCP selection and options current without reading turn bodies', () => {
    const { doc, view } = openView(12, { tailKeep: 0, maxHydrated: 0 });
    const peer = reimport(doc);
    const config = (peer.getList('history').get(22) as LoroMap).get('inputConfig') as LoroMap;
    const selection = config.setContainer('mcpServerIds', new LoroList());
    config.set('taskToolsEnabled', true);
    const options = config.get('configOptionValues') as LoroMap;
    options.set('effort', 'high');
    const sync = () => {
      peer.commit();
      doc.import(peer.export({ mode: 'update', from: doc.version() }));
    };
    const resolve = () =>
      resolveSessionConversationConfig(collectConversationConfigSources(view, 0));
    try {
      sync();
      expect(resolve()).toMatchObject({
        mcpServerIds: [],
        configOptionValues: { effort: 'high' },
        taskToolsEnabled: true,
      });
      expect(view.isHydrated(22)).toBe(false);
      selection.push('chosen-mcp');
      options.set('effort', 'low');
      config.set('taskToolsEnabled', false);
      sync();
      expect(resolve()).toMatchObject({
        mcpServerIds: ['chosen-mcp'],
        configOptionValues: { effort: 'low' },
        taskToolsEnabled: false,
      });
      selection.delete(0, 1);
      config.delete('configOptionValues');
      sync();
      expect(resolve().mcpServerIds).toEqual([]);
      expect(resolve().configOptionValues).toBeUndefined();
      expect(view.isHydrated(22)).toBe(false);
    } finally {
      view.dispose();
      peer.free();
      doc.free();
    }
  });

  it.each([false, true])(
    'isolates invalid stored items without rewriting history: windowed=%s',
    async (windowed) => {
      const doc = buildSessionDoc(buildFixtureHistory(1));
      const items = (doc.getList('history').get(1) as LoroMap).get('items') as LoroList;
      items.insert(0, null);
      items.insert(1, { type: 'future_extension' });
      items.insert(2, { type: 'text', text: 42 });
      doc.commit();
      const before = doc.getList('history').toJSON();
      const version = doc.version().toJSON();
      const idle = createManualIdle();
      const session = createConversationSession(doc, {
        sessionId: FIXTURE_SESSION_ID,
        windowed,
        scheduleIdle: idle.scheduleIdle,
      });
      try {
        // The windowed arm now reads through the session-data port, so the
        // snapshot populates asynchronously; drain the manual idle pass until
        // the initial directory, tail hydration and the background pass settle.
        await vi.waitFor(
          async () => {
            idle.runAll();
            const settled = await Promise.race([
              session.history.ready.then(() => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
            ]);
            if (!settled) throw new Error('background pass not settled yet');
          },
          { interval: 10, timeout: 10_000 }
        );
        expect(session.history.index(1)?.summary?.headText).toContain('Answer for round 0');
        expect(session.history.index(1)?.summary?.toolCalls).toBe(1);
        expect(session.history.turn(1)?.items?.[0]).toBeNull();
        expect(doc.getList('history').toJSON()).toEqual(before);
        expect(doc.version().toJSON()).toEqual(version);
      } finally {
        session.history.dispose();
        session.mirror.dispose();
        doc.free();
      }
    }
  );
});
