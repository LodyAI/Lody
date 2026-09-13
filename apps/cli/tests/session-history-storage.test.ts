import { createSessionAgentWrites } from '../src/lib/loro/session-agent-writes';
import { describe, expect, it, vi } from 'vitest';
import { Loro, isContainer, LoroList, LoroMap } from 'loro-crdt';
import type { SessionHistory } from '@lody/shared';
import type { SessionId } from '@lody/shared/ids';
import { createHistoryWriter } from '@lody/shared';
import {
  createLoroSessionData as createStoredSession,
  pageVisibleTranscript,
  hashHistoryEntry,
  hashText,
  type SessionTurn,
} from '@lody/shared/session-data';
import {
  storageSessionId,
  runStoredHistoryCases,
  type StoredHistoryFixture,
} from './session-history-storage-cases';

const createLoroSessionData = (options: Parameters<typeof createStoredSession>[0]) => {
  const data = createStoredSession(options);
  return { ...data, commands: { ...data.commands, ...createSessionAgentWrites(data.writer) } };
};

const makeHarness = (doc = new Loro()): StoredHistoryFixture => {
  let cursor: unknown;
  const data = createLoroSessionData({
    historyImportCursor: {
      read: () => cursor,
      write: (value) => {
        cursor = value;
      },
    },
    sessionId: storageSessionId,
    doc,
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

runStoredHistoryCases(() => makeHarness());

describe('loro session data adapter', () => {
  it('converges two replicas after UI- and agent-side domain writes', async () => {
    const left = new Loro();
    const right = new Loro();
    const leftData = createLoroSessionData({
      sessionId: storageSessionId,
      doc: left,
    });
    const rightData = createLoroSessionData({
      sessionId: storageSessionId,
      doc: right,
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

  it('keeps a detached capture usable after source teardown', async () => {
    const source = createLoroSessionData({
      sessionId: storageSessionId,
      doc: new Loro(),
    });
    const target = createLoroSessionData({
      sessionId: 'fork-target' as SessionId,
      doc: new Loro(),
    });
    await source.commands.appendTurn({
      id: 'u',
      role: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      items: [{ type: 'text', text: 'captured' }],
      fileDiff: [],
    });
    const snapshot = await source.snapshots.capture();
    source.dispose();
    const selection = snapshot.history;
    expect((await target.snapshots.copyFrom(snapshot, selection)).status).toBe('accepted');
    expect(await target.history.readTurn('u')).toMatchObject({
      state: 'ready',
      turn: { items: [{ type: 'text', text: 'captured' }] },
    });
  });

  it('binds an imported history write, its stored baseline and the cursor with no await gap', async () => {
    const doc = new Loro();
    let cursorState: unknown;
    const data = createLoroSessionData({
      sessionId: storageSessionId,
      doc,
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
