import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import type { SessionHistory, SessionId } from '@lody/shared';
import { createSharedChatStreamBuilder } from '../src/components/sharing/session-share-stream-items';

const sessionId = 'shared-session' as SessionId;
const turn = (id: string, text: string): SessionHistory => ({
  id,
  role: 'assistant',
  timestamp: '2026-09-12T00:00:00Z',
  fileDiff: [],
  items: [{ type: 'text', text }],
});

describe('shared history rendering boundary', () => {
  it('keeps unchanged rows without rereading their content as another turn streams', () => {
    const builder = createSharedChatStreamBuilder();
    let rejectReads = false;
    const first = turn('first', 'First visible answer');
    first.items = [
      {
        type: 'text',
        get text() {
          if (rejectReads) throw new Error('Unchanged body was read again');
          return 'First visible answer';
        },
      },
    ];
    const initial = builder.build([first, turn('live', 'Start')], sessionId);
    expect(initial.items).toHaveLength(2);
    expect(initial.items[0]).toMatchObject({ type: 'message', message: { id: 'first' } });
    rejectReads = true;
    const next = builder.build([first, turn('live', 'Start finished')], sessionId);
    expect(next.items[0]).toBe(initial.items[0]);
    expect(next.items[1]).toMatchObject({
      type: 'message',
      message: { items: [{ type: 'text', text: 'Start finished' }] },
    });
    builder.dispose();
  });

  it('filters invalid items in the read projection without changing the stored snapshot', () => {
    const doc = new LoroDoc();
    const raw = {
      ...turn('mixed', 'Visible'),
      items: [null, { type: 'future_item' }, { type: 'text', text: 'Visible' }],
    };
    doc.getList('history').push(raw);
    doc.commit();
    const before = doc.export({ mode: 'snapshot' });
    const history = doc.toJSON().history as SessionHistory[];
    const builder = createSharedChatStreamBuilder();
    const result = builder.build(history, sessionId);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type: 'message',
      message: { items: [{ type: 'text', text: 'Visible' }] },
    });
    expect(history[0]).toEqual(raw);
    expect(doc.export({ mode: 'snapshot' })).toEqual(before);
    builder.dispose();
    doc.free();
  });

  it('resets on target changes and can render again after disposal', () => {
    const builder = createSharedChatStreamBuilder();
    const first = builder.build([turn('same-id', 'First session')], sessionId);
    const next = builder.build([turn('same-id', 'Other session')], 'other' as SessionId);
    expect(next.items[0]).not.toBe(first.items[0]);
    expect(next.items[0]).toMatchObject({
      sessionId: 'other',
      message: { items: [{ type: 'text', text: 'Other session' }] },
    });
    expect(builder.build([], 'other' as SessionId).items).toEqual([{ type: 'empty' }]);
    builder.dispose();
    builder.dispose();
    expect(builder.build([turn('again', 'Reopened')], sessionId).items[0]).toMatchObject({
      type: 'message',
      message: { id: 'again' },
    });
    builder.dispose();
  });
});
