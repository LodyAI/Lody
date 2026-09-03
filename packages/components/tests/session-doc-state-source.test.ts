import { describe, expect, it } from 'vitest';
import { LoroDoc, type LoroList, type LoroMap, type LoroText } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import {
  sessionDocSchema,
  type SessionDocMeta,
  type SessionHistoryInput,
  type SessionId,
} from '@lody/shared';
import type { SessionDocState } from '../src/atoms/runtime';
import {
  createSessionDocStateSource,
  readSessionDocHistoryRevision,
  SessionHistoryWriteThroughMirrorError,
} from '../src/providers/session-doc-state-source';
import {
  appendHistoryEntry,
  createSessionControlMirror,
  replaceHistoryEntry,
} from '../src/lib/conversation-view';

const sessionId = 'session-bridge' as SessionId;

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
        items: [{ type: 'text', text: `answer ${index}` }] as never,
      };

const docWithTurns = (count: number): LoroDoc => {
  const doc = new LoroDoc();
  for (let index = 0; index < count; index += 1) appendHistoryEntry(doc, turn(index));
  return doc;
};

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const mirrorHistory = (doc: LoroDoc): unknown =>
  plain(
    new Mirror({ doc, schema: sessionDocSchema, ignoreUnknownProperties: true }).getState().history
  );

describe('createSessionDocStateSource (ConversationView enabled)', () => {
  it('exposes the view and bridges history lazily with the full-Mirror value', () => {
    const doc = docWithTurns(12);
    const source = createSessionDocStateSource({ doc, sessionId, conversationViewEnabled: true });
    expect(source.conversationView?.turnCount).toBe(12);

    const state = source.getState();
    expect(Object.keys(state)).toEqual(expect.arrayContaining(['session', 'mq', 'history']));
    expect(plain(state.history)).toEqual(mirrorHistory(doc));
    // Same snapshot while nothing changed, and the same history array on it.
    expect(source.getState()).toBe(state);
    expect(source.getState().history).toBe(state.history);
    source.dispose();
  });

  it('notifies on history appends and keeps unchanged entries identity-stable', () => {
    const doc = docWithTurns(6);
    const source = createSessionDocStateSource({ doc, sessionId, conversationViewEnabled: true });
    const before = source.getState();
    const beforeHistory = before.history;
    const seen: SessionDocState[] = [];
    source.subscribe((state) => seen.push(state));

    appendHistoryEntry(doc, turn(6));

    expect(seen).toHaveLength(1);
    const after = seen[0]!;
    expect(after).not.toBe(before);
    expect(after.session).toBe(before.session);
    expect(readSessionDocHistoryRevision(after)).not.toBe(readSessionDocHistoryRevision(before));
    expect(after.history).toHaveLength(7);
    expect(after.history[0]).toBe(beforeHistory[0]);
    expect(after.history[5]).toBe(beforeHistory[5]);
    expect(plain(after.history)).toEqual(mirrorHistory(doc));
    source.dispose();
  });

  it('re-materializes only the changed turn on an in-place update', () => {
    const doc = docWithTurns(6);
    const source = createSessionDocStateSource({ doc, sessionId, conversationViewEnabled: true });
    const beforeHistory = source.getState().history;

    replaceHistoryEntry(doc, 'a3', { ...turn(3), finished: false, endedAt: undefined });

    const afterHistory = source.getState().history;
    expect(afterHistory[3]).not.toBe(beforeHistory[3]);
    expect(afterHistory[3]).toMatchObject({ id: 'a3', finished: false });
    expect(afterHistory[2]).toBe(beforeHistory[2]);
    expect(afterHistory[4]).toBe(beforeHistory[4]);
    expect(plain(afterHistory)).toEqual(mirrorHistory(doc));
    source.dispose();
  });

  it('keeps control-plane writes on the Mirror and reports them synchronously', () => {
    const doc = docWithTurns(4);
    const source = createSessionDocStateSource({ doc, sessionId, conversationViewEnabled: true });
    const seen: SessionDocState[] = [];
    source.subscribe((state) => seen.push(state));

    source.setState((draft: SessionDocMeta) => {
      draft.mq = [{ $cid: 'q1', prompt: 'queued', inputConfig: {}, timestamp: 't' } as never];
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.mq).toHaveLength(1);
    expect((doc.toJSON() as { mq: unknown[] }).mq).toHaveLength(1);
    // The history revision did not move: the same lazy array is handed out.
    expect(readSessionDocHistoryRevision(seen[0]!)).toBe(
      readSessionDocHistoryRevision(source.getState())
    );
    expect(doc.getList('history').length).toBe(4);
    source.dispose();
  });

  it('rejects every setState shape that reaches history', () => {
    const doc = docWithTurns(2);
    const source = createSessionDocStateSource({ doc, sessionId, conversationViewEnabled: true });

    expect(() => source.setState({ history: [] } as never)).toThrow(
      SessionHistoryWriteThroughMirrorError
    );
    expect(() =>
      source.setState((draft: SessionDocMeta) => {
        draft.history.push(turn(2) as never);
      })
    ).toThrow(SessionHistoryWriteThroughMirrorError);
    expect(() =>
      source.setState((draft: SessionDocMeta) => {
        draft.history = [];
      })
    ).toThrow(SessionHistoryWriteThroughMirrorError);
    expect(() =>
      source.setState((prev) => ({ ...(prev as object), history: [] }) as never)
    ).toThrow(SessionHistoryWriteThroughMirrorError);

    // Nothing leaked into the doc or the view.
    expect(doc.getList('history').length).toBe(2);
    expect(source.conversationView?.turnCount).toBe(2);
    // And the Mirror still accepts a control write afterwards.
    source.setState((draft: SessionDocMeta) => {
      draft.session.title = 'still writable';
    });
    expect(source.getState().session.title).toBe('still writable');
    source.dispose();
  });
});

describe('createSessionControlMirror', () => {
  it('keeps history out of the control Mirror across appends, replaces and text deltas', () => {
    const doc = docWithTurns(4);
    const mirror = createSessionControlMirror(doc, sessionId);
    const internals = mirror as unknown as { containerRegistry: Map<string, unknown> };
    const registeredBefore = internals.containerRegistry.size;
    let notifications = 0;
    mirror.subscribe(() => {
      notifications += 1;
    });

    appendHistoryEntry(doc, turn(4));
    replaceHistoryEntry(doc, 'a1', { ...turn(1), finished: false, endedAt: undefined });
    const tail = doc.getContainerById(
      (doc.getList('history').getShallowValue() as string[])[4] as never
    ) as LoroMap;
    const items = tail.get('items') as LoroList;
    const text = (items.get(0) as LoroMap).get('text') as LoroText;
    text.insert(text.length, ' streamed');
    doc.commit();

    const state = mirror.getState() as Record<string, unknown>;
    expect('history' in state).toBe(false);
    expect(internals.containerRegistry.size).toBe(registeredBefore);
    expect(notifications).toBeGreaterThan(0);

    mirror.setState((draft: SessionDocMeta) => {
      draft.session.title = 'control still writes';
    });
    expect((doc.toJSON() as { session: { title: string } }).session.title).toBe(
      'control still writes'
    );
    expect(doc.getList('history').length).toBe(5);
    mirror.dispose();
  });
});

describe('createSessionDocStateSource (ConversationView disabled)', () => {
  it('is the full Mirror: no view, eager history, setState writes history', () => {
    const doc = docWithTurns(3);
    const source = createSessionDocStateSource({ doc, sessionId, conversationViewEnabled: false });
    expect(source.conversationView).toBeNull();
    const state = source.getState();
    expect(readSessionDocHistoryRevision(state)).toBe(state.history);
    expect(plain(state.history)).toEqual(mirrorHistory(doc));

    source.setState((draft: SessionDocMeta) => {
      draft.history.push(turn(3) as never);
    });
    expect(doc.getList('history').length).toBe(4);
    expect(source.getState().history).toHaveLength(4);
    source.dispose();
  });
});
