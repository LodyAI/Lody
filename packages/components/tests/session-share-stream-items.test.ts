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
});
