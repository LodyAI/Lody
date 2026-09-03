import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { sessionDocSchema, type SessionHistoryInput, type SessionId } from '@lody/shared';

import { sessionControlDocSchema } from '../src/lib/conversation-view/control-doc-schema';
import { createConversationViewFromDoc } from '../src/lib/conversation-view/conversation-view';
import {
  appendHistoryEntry,
  replaceHistoryEntry,
} from '../src/lib/conversation-view/history-writer';

const sessionId = 'session-1' as SessionId;

const turn = (index: number): SessionHistoryInput =>
  index % 2 === 0
    ? {
        id: `u${index}`,
        role: 'user',
        timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        status: 'seen',
        read: true,
        finished: true,
        fileDiff: [],
        items: [{ type: 'text', text: `prompt ${index}` }] as never,
        inputConfig: {
          prompt: `prompt ${index}`,
          cliType: 'builtin',
          agentType: 'claude',
        } as never,
      }
    : {
        id: `a${index}`,
        role: 'assistant',
        timestamp: `2026-01-01T00:01:${String(index % 60).padStart(2, '0')}.000Z`,
        finished: true,
        endedAt: 1_700_000_000_000 + index,
        fileDiff: [],
        items: [
          { type: 'thought', text: `thinking ${index}` },
          {
            type: 'tool_call',
            toolCallId: `tc${index}`,
            title: 'Run ls',
            kind: 'execute',
            status: 'completed',
            content: [{ type: 'terminal_command', command: 'ls', cwd: '/x' }],
          },
          { type: 'text', text: `answer ${index}` },
        ] as never,
      };

function docWithTurns(count: number): LoroDoc {
  const doc = new LoroDoc();
  for (let index = 0; index < count; index += 1) appendHistoryEntry(doc, turn(index));
  return doc;
}

const fullHistory = (doc: LoroDoc): unknown[] =>
  JSON.parse(
    JSON.stringify(
      new Mirror({ doc, schema: sessionDocSchema, ignoreUnknownProperties: true }).getState()
        .history
    )
  );

describe('sessionControlDocSchema', () => {
  it('never materializes history and keeps control-plane writes working', () => {
    const doc = docWithTurns(2_000);
    const start = performance.now();
    const mirror = new Mirror({
      doc,
      schema: sessionControlDocSchema,
      ignoreUnknownProperties: true,
      initialState: { session: { id: sessionId } },
    });
    const elapsed = performance.now() - start;
    const state = mirror.getState() as Record<string, unknown>;
    expect(state.history).toBeUndefined();
    // 2,000 turns / ~14k containers: the full-schema Mirror needs hundreds of
    // ms here; an ignored root must cost nothing that scales with history.
    expect(elapsed).toBeLessThan(150);

    mirror.setState((prev) => ({
      ...prev,
      mq: [{ $cid: 'q1', prompt: 'queued', inputConfig: {}, timestamp: 't' } as never],
    }));
    doc.commit();
    expect(doc.getList('history').length).toBe(2_000);
    expect((doc.toJSON() as { mq: unknown[] }).mq).toHaveLength(1);
  });
});

describe('ConversationView', () => {
  it('indexes every turn eagerly, hydrates the tail, and matches the Mirror state', () => {
    const doc = docWithTurns(60);
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 5, maxHydrated: 10 });
    expect(view.turnCount).toBe(60);
    expect(view.index(0)).toMatchObject({ id: 'u0', role: 'user', itemCount: 1 });
    expect(view.index(1)).toMatchObject({ id: 'a1', role: 'assistant', itemCount: 3 });
    expect(view.indexOf('a59')).toBe(59);
    expect(view.isHydrated(59)).toBe(true);
    expect(view.isHydrated(0)).toBe(false);
    expect(view.turn(0)).toBeUndefined();

    const expected = fullHistory(doc);
    expect(JSON.parse(JSON.stringify(view.turn(59)))).toEqual(expected[59]);
    expect(JSON.parse(JSON.stringify(view.readAll()))).toEqual(expected);
    view.dispose();
  });

  it('hydrates ranges on demand and evicts beyond maxHydrated, never the tail', async () => {
    const doc = docWithTurns(60);
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 5, maxHydrated: 10 });
    await view.ensureRange(0, 8);
    expect(view.isHydrated(0)).toBe(true);
    expect(view.isHydrated(7)).toBe(true);
    await view.ensureRange(20, 40);
    // 5 tail + 20 range > 10: the oldest untouched turns are evicted first.
    expect(view.isHydrated(0)).toBe(false);
    expect(view.isHydrated(59)).toBe(true);
    view.dispose();
  });

  it('follows appends, in-place updates and deletes through doc events', () => {
    const doc = docWithTurns(10);
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 3 });
    const changes: string[] = [];
    view.subscribe((change) => changes.push(change.kind));
    const versionBefore = view.version;

    appendHistoryEntry(doc, turn(10));
    expect(view.turnCount).toBe(11);
    expect(view.index(10)?.id).toBe('u10');
    expect(view.isHydrated(10)).toBe(false);
    expect(view.version).toBeGreaterThan(versionBefore);

    replaceHistoryEntry(doc, 'a9', { ...turn(9), finished: false, endedAt: undefined });
    expect(view.index(9)).toMatchObject({ id: 'a9', finished: false });
    expect(view.turn(9)).toMatchObject({ id: 'a9', finished: false });

    doc.getList('history').delete(0, 1);
    doc.commit();
    expect(view.turnCount).toBe(10);
    expect(view.indexOf('u0')).toBe(-1);
    expect(view.indexOf('a9')).toBe(8);
    expect(JSON.parse(JSON.stringify(view.readAll()))).toEqual(fullHistory(doc));
    expect(changes).toEqual(expect.arrayContaining(['index', 'tail']));
    view.dispose();
  });

  it('exposes plan and item counts on index rows without hydrating', () => {
    const doc = docWithTurns(4);
    replaceHistoryEntry(doc, 'a3', {
      ...turn(3),
      plan: [{ content: 'step 1', status: 'pending', priority: 'medium' }] as never,
    });
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 0 });
    expect(view.index(3)).toMatchObject({ id: 'a3', itemCount: 3, planCount: 1 });
    expect(view.index(1)?.planCount).toBeUndefined();
    expect(view.isHydrated(3)).toBe(false);
    view.dispose();
  });

  it('retain() protects a range from eviction until released', async () => {
    const doc = docWithTurns(60);
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 5, maxHydrated: 10 });
    const release = view.retain(0, 8);
    await view.ensureRange(0, 8);
    await view.ensureRange(20, 40);
    expect(view.isHydrated(0)).toBe(true);
    expect(view.isHydrated(7)).toBe(true);
    release();
    await view.ensureRange(40, 50);
    expect(view.isHydrated(0)).toBe(false);
    view.dispose();
  });

  it('readAll() hands back the same objects for unchanged turns across changes', () => {
    const doc = docWithTurns(30);
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 3, maxHydrated: 5 });
    const first = view.readAll();
    expect(view.readAll()).toBe(first);

    appendHistoryEntry(doc, turn(30));
    const second = view.readAll();
    expect(second).not.toBe(first);
    expect(second).toHaveLength(31);
    for (let i = 0; i < 30; i += 1) expect(second[i]).toBe(first[i]);

    replaceHistoryEntry(doc, 'a11', { ...turn(11), finished: false, endedAt: undefined });
    const third = view.readAll();
    expect(third[11]).not.toBe(second[11]);
    expect(third[11]).toMatchObject({ id: 'a11', finished: false });
    expect(third[10]).toBe(second[10]);
    expect(third[12]).toBe(second[12]);
    expect(JSON.parse(JSON.stringify(third))).toEqual(fullHistory(doc));
    // A full read does not pin the LRU: the window stays bounded.
    expect(view.isHydrated(0)).toBe(false);
    view.dispose();
  });
});
