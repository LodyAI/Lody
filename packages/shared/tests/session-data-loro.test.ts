import { describe, expect, it, vi } from 'vitest';
import { Loro, isContainer, LoroMap } from 'loro-crdt';
import type { SessionHistory } from '../src/schema';
import { createHistoryWriter } from '../src/history-writer';
import {
  createLoroSessionData,
  pageVisibleTranscript,
  type SessionTurn,
} from '../src/session-data';
import {
  contractSessionId,
  runSessionDataContract,
  type SessionDataHarness,
} from './session-data-contract';

const makeHarness = (doc = new Loro()): SessionDataHarness => {
  const data = createLoroSessionData({
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
    for (let index = 0; index < 5; index += 1) {
      await harness.data.commands.appendTurn({
        id: `turn-${index}`,
        role: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'text', text: `body ${index}` }],
        fileDiff: [],
      });
    }
    const toJSON = vi.spyOn(LoroMap.prototype, 'toJSON');
    try {
      const read = await harness.data.history.readTurn('turn-1');
      expect(read.state).toBe('ready');
      // Exactly the target body is materialized; identity checks are shallow.
      expect(toJSON).toHaveBeenCalledTimes(1);
    } finally {
      toJSON.mockRestore();
    }
  });
});
