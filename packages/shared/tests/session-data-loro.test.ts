import { describe, expect, it, vi } from 'vitest';
import { Loro, isContainer, LoroList, LoroMap } from 'loro-crdt';
import type { SessionHistory } from '../src/schema';
import type { SessionId } from '../src/ids';
import { createHistoryWriter } from '../src/history-writer';
import {
  createLoroSessionData,
  pageVisibleTranscript,
  hashHistoryEntry,
  hashText,
  type SessionTurn,
} from '../src/session-data';
import {
  contractSessionId,
  runSessionDataContract,
  type SessionDataHarness,
} from './session-data-contract';

const makeHarness = (doc = new Loro()): SessionDataHarness => {
  let cursor: unknown;
  const data = createLoroSessionData({
    historyImportCursor: {
      read: () => cursor,
      write: (value) => {
        cursor = value;
      },
    },
    sessionId: contractSessionId,
    doc,
    durable: async () => {},
  });
  const writer = createHistoryWriter(doc);
  const findMap = (turnId: string): LoroMap | undefined => {
    const list = doc.getList('history');
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const value = list.get(index);
      if (isContainer(value) && value.kind() === 'Map' && (value as LoroMap).get('id') === turnId)
        return value as LoroMap;
    }
    return undefined;
  };
  return {
    data,
    injectStoredField(turnId, key, value) {
      const map = findMap(turnId);
      if (!map) throw new Error(`missing turn ${turnId}`);
      // Raw write: models a field a newer peer or an older build stored that the
      // current schema does not declare.
      map.set(key, value as Parameters<LoroMap['set']>[1]);
      doc.commit();
    },
    injectStoredItem(turnId, item) {
      const map = findMap(turnId);
      if (!map) throw new Error(`missing turn ${turnId}`);
      // Raw item append: models opaque content the current build must retain.
      (map.get('items') as LoroList).push(item as never);
      doc.commit();
    },
    peerSetField(turnId, key, value) {
      // A second independent writer over the same doc, as a peer would use.
      createHistoryWriter(doc).setField(turnId, key as never, value as never);
    },
    peerAppend(turn) {
      createHistoryWriter(doc).append(turn as unknown as SessionHistory);
    },
    readStored: () => writer.readStored() as SessionTurn[],
  };
};

runSessionDataContract('loro', () => makeHarness());

describe('loro session data adapter', () => {
  it('converges two replicas after UI- and agent-side domain writes', async () => {
    const left = new Loro();
    const right = new Loro();
    const leftData = createLoroSessionData({
      sessionId: contractSessionId,
      doc: left,
      durability: 'unavailable',
    });
    const rightData = createLoroSessionData({
      sessionId: contractSessionId,
      doc: right,
      durability: 'unavailable',
    });

    await leftData.commands.appendTurn({
      id: 'user-1',
      role: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      items: [{ type: 'text', text: 'hi' }],
      fileDiff: [],
      status: 'pending',
    });
    right.import(left.export({ mode: 'update' }));

    // Agent-side replica streams an answer into the shared turn.
    await rightData.commands.appendTurn({
      id: 'assistant-1',
      role: 'assistant',
      userTurnId: 'user-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      items: [{ type: 'text', text: 'hello' }],
      fileDiff: [],
    });
    left.import(right.export({ mode: 'update' }));

    // UI-side replica acknowledges read on its own copy.
    await leftData.commands.setTurnField('user-1', 'read', { kind: 'set', value: true });
    right.import(left.export({ mode: 'update' }));

    for (const doc of [left, right]) {
      const ids = doc
        .getList('history')
        .toJSON()
        .map((turn) => (turn as { id: string }).id);
      expect(ids).toEqual(['user-1', 'assistant-1']);
    }
    const readUser = await rightData.history.readTurn('user-1');
    expect(readUser.state === 'ready' && readUser.turn.read).toBe(true);
  });

  it('clears a field without disturbing unrelated stored keys', async () => {
    const harness = makeHarness();
    await harness.data.commands.appendTurn({
      id: 'a',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      items: [{ type: 'text', text: 'x' }],
      fileDiff: [],
      finished: true,
      endedAt: 99,
    });
    harness.injectStoredField('a', 'futureField', { nested: [1, 2] });

    await harness.data.commands.setTurnField('a', 'finished', { kind: 'clear' });
    const stored = harness.readStored().find((turn) => turn.id === 'a') as Record<string, unknown>;
    expect(Object.hasOwn(stored, 'finished')).toBe(false);
    expect(stored.endedAt).toBe(99);
    expect(stored.futureField).toEqual({ nested: [1, 2] });
  });

  it('keeps a bad raw slot addressable without shifting its neighbours', async () => {
    const doc = new Loro();
    const harness = makeHarness(doc);
    // A corrupt slot no client wrote: a raw non-map value in the history list.
    doc.getList('history').insert(0, 'not-a-turn');
    doc.commit();

    expect(await harness.data.history.count()).toBe(1);
    expect((await harness.data.history.readRange(0, 1))[0]?.state).toBe('invalid');

    await harness.data.commands.appendTurn({
      id: 'valid',
      role: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      items: [{ type: 'text', text: 'ok' }],
      fileDiff: [],
    });
    // The invalid slot keeps its raw position; the valid turn stays at index 1.
    expect(await harness.data.history.count()).toBe(2);
    const range = await harness.data.history.readRange(0, 2);
    expect(range.map((entry) => (entry.state === 'ready' ? entry.turn.id : entry.state))).toEqual([
      'invalid',
      'valid',
    ]);

    const page = await pageVisibleTranscript(harness.data.history, {
      limit: 5,
      isVisible: () => true,
    });
    expect(page.turns.map((turn) => turn.id)).toEqual(['valid']);
    expect(page.hasMore).toBe(false);
  });

  it('refuses to claim durability when no barrier exists, and rejects a forged receipt', async () => {
    const doc = new Loro();
    const data = createLoroSessionData({
      sessionId: contractSessionId,
      doc,
      durability: 'unavailable',
    });
    const result = await data.commands.appendTurn({
      id: 'turn',
      role: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      items: [{ type: 'text', text: 'x' }],
      fileDiff: [],
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    // No barrier was provided: the public promise must not silently succeed.
    await expect(data.durability.waitDurable(result.receipt)).rejects.toMatchObject({
      code: 'unavailable',
    });
    // A caller-shaped object is not a capability this store issued.
    await expect(
      data.durability.waitDurable({
        sessionId: contractSessionId,
        kind: 'append',
        turnIds: ['turn'],
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_receipt' });
  });

  it('invalidates every snapshot handle when the source store closes', async () => {
    const doc = new Loro();
    const data = createLoroSessionData({
      sessionId: contractSessionId,
      doc,
      durability: 'unavailable',
    });
    const snapshots = data.snapshots;
    expect(snapshots.capabilities.copy).toBe(true);
    const snapshot = await snapshots.capture();
    expect(snapshot.sessionId).toBe(contractSessionId);
    await data.commands.appendTurn({
      id: 'turn',
      role: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      items: [{ type: 'text', text: 'x' }],
      fileDiff: [],
    });
    // The store's teardown hook invalidates the source of every handle.
    snapshots.closeSource();
    const closed = expect.objectContaining({ code: 'source_closed' });
    await expect(snapshots.capture()).rejects.toThrowError(closed);
    await expect(snapshot.read()).rejects.toThrowError(closed);
    await expect(snapshots.copyFrom(snapshot, [])).rejects.toThrowError(closed);
    expect(() => snapshots.release(snapshot)).not.toThrow();
  });

  it('keeps an operation capture usable after source teardown until release', async () => {
    const source = createLoroSessionData({
      sessionId: contractSessionId,
      doc: new Loro(),
      durability: 'unavailable',
    });
    const target = createLoroSessionData({
      sessionId: 'fork-target' as SessionId,
      doc: new Loro(),
      durability: 'unavailable',
    });
    await source.commands.appendTurn({
      id: 'u',
      role: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      items: [{ type: 'text', text: 'captured' }],
      fileDiff: [],
    });
    const snapshot = await source.snapshots.capture({ lifetime: 'operation' });
    source.snapshots.closeSource();
    const selection = await snapshot.read();
    expect((await target.snapshots.copyFrom(snapshot, selection)).status).toBe('accepted');
    expect(await target.history.readTurn('u')).toMatchObject({
      state: 'ready',
      turn: { items: [{ type: 'text', text: 'captured' }] },
    });
    source.snapshots.release(snapshot);
    source.snapshots.release(snapshot);
    await expect(snapshot.read()).rejects.toMatchObject({ code: 'released' });
    await expect(target.snapshots.copyFrom(snapshot, selection)).rejects.toMatchObject({
      code: 'released',
    });
  });

  it('reports source_closed on a cross-store copy after the source store closes', async () => {
    const sourceDoc = new Loro();
    const source = createLoroSessionData({
      sessionId: contractSessionId,
      doc: sourceDoc,
      durability: 'unavailable',
    });
    const targetDoc = new Loro();
    const target = createLoroSessionData({
      sessionId: 'target-session' as SessionId,
      doc: targetDoc,
      durability: 'unavailable',
    });
    const snapshot = await source.snapshots.capture();
    source.snapshots.closeSource();
    // The target store stays open, but the handle's source is gone.
    await expect(target.snapshots.copyFrom(snapshot, [])).rejects.toThrowError(
      expect.objectContaining({ code: 'source_closed' })
    );
    await expect(snapshot.read()).rejects.toThrowError(
      expect.objectContaining({ code: 'source_closed' })
    );
  });

  it('binds an imported history write, its stored baseline and the cursor with no await gap', async () => {
    const doc = new Loro();
    let cursorState: unknown;
    const data = createLoroSessionData({
      sessionId: contractSessionId,
      doc,
      durability: 'unavailable',
      historyImportCursor: {
        read: () => cursorState,
        write: (value) => {
          cursorState = value;
        },
      },
    });
    const history: SessionTurn[] = [
      { id: 'a', role: 'user', timestamp: 'synthetic', items: [{ type: 'text', text: 'x' }] },
    ];
    const hashes = history.map(hashHistoryEntry);
    const result = await data.commands.applyHistoryImport({
      mode: 'initialize',
      replay: {
        history,
        turnHashes: hashes,
        replayDigest: hashText(hashes.join('\n')),
        droppedNotifications: 0,
      },
    });
    expect(result).toMatchObject({ status: 'accepted', appended: 1 });
    const cursor = cursorState as { importedTurnHashes: string[]; storedHistoryBaseline: string };
    expect(cursor.importedTurnHashes).toEqual(hashes);
    expect(JSON.parse(cursor.storedHistoryBaseline).turnHashes).toEqual(
      createHistoryWriter(doc).readStored().map(hashHistoryEntry)
    );
  });

  it('reports an accepted write whose post-accept side effect failed', async () => {
    const doc = new Loro();
    const data = createLoroSessionData({
      sessionId: contractSessionId,
      doc,
      durable: async () => {},
      afterAccept: () => {
        throw new Error('notification failed');
      },
    });
    const result = await data.commands.appendTurn({
      id: 'turn',
      role: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      items: [{ type: 'text', text: 'x' }],
      fileDiff: [],
    });
    // Applied, but its side effect failed: never a pre-write rejection.
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.postAcceptError).toBeInstanceOf(Error);
    expect((await data.history.readTurn('turn')).state).toBe('ready');
  });

  it('reads one turn by shallow identity without materializing unrelated bodies', async () => {
    const doc = new Loro();
    const harness = makeHarness(doc);
    for (let index = 0; index < 10; index += 1) {
      await harness.data.commands.appendTurn({
        id: `a${index}`,
        role: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'text', text: `body ${index}` }],
        fileDiff: [],
      });
    }
    // Record which turn bodies are materialized while resolving the first id,
    // which sits at the far end of the list.
    const bodies: string[] = [];
    const original = LoroMap.prototype.toJSON;
    const spy = vi.spyOn(LoroMap.prototype, 'toJSON').mockImplementation(function () {
      const id = this.get('id');
      if (typeof id === 'string') bodies.push(id);
      return original.call(this);
    });
    try {
      const read = await harness.data.history.readTurn('a0');
      expect(read.state === 'ready' && read.turn.id).toBe('a0');
      // Identity is read shallowly: only the target body is materialized.
      expect(bodies).toEqual(['a0']);
    } finally {
      spy.mockRestore();
    }
  });
});
