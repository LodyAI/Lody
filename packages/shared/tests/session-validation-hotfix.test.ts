import { describe, expect, it } from 'vitest';
import { Loro, LoroList, LoroMap } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { sessionDocSchema } from '../src/schema';
import { MessageContentSchema } from '../src/message-schemas';
import type { SessionId } from '../src/ids';

const id = 'synthetic-validation-hotfix' as SessionId;
const open = (doc: Loro, validateUpdates: boolean) =>
  new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    validateUpdates,
    initialState: { session: { id }, history: [] },
  });
const append = (mirror: ReturnType<typeof open>) =>
  mirror.setState((state) => {
    state.history.push({
      id: 'new-user',
      role: 'user',
      timestamp: '2026-09-07T00:00:00Z',
      items: [{ type: 'text', text: 'hello' }],
      fileDiff: [],
    });
  });

describe('temporary session validation bypass', () => {
  it.each(['live import', 'snapshot reopen'])(
    'preserves incompatible history on %s while writing and merging',
    (mode) => {
      const peer = new Loro();
      peer.getMap('session').set('id', id);
      const row = peer.getList('history').pushContainer(new LoroMap());
      row.set('id', 'old');
      row.set('role', 'assistant');
      row.set('timestamp', '2026-09-06T00:00:00Z');
      const items = row.setContainer('items', new LoroList());
      const future = items.pushContainer(new LoroMap());
      future.set('type', 'future_operation_progress');
      future.set('payload', { revision: 1 });
      const damaged = items.pushContainer(new LoroMap());
      damaged.set('type', 'text');
      damaged.set('text', 42);
      peer.commit();
      const snapshot = peer.export({ mode: 'snapshot' });
      const strictDoc = new Loro();
      strictDoc.import(snapshot);
      const strict = open(strictDoc, true);
      expect(() => append(strict)).toThrow('State validation failed');
      strict.dispose();

      const doc = new Loro();
      if (mode === 'snapshot reopen') doc.import(snapshot);
      const versionBeforeOpen = doc.version().toJSON();
      const mirror = open(doc, false);
      if (mode === 'snapshot reopen') expect(doc.version().toJSON()).toEqual(versionBeforeOpen);
      else doc.import(snapshot);
      const before = doc.getList('history').toJSON()[0];
      append(mirror);
      mirror.setState((state) => {
        const user = state.history[1]!;
        user.read = true;
        const text = user.items![0]!;
        if (text.type === 'text') text.text += ' streamed';
      });
      expect(doc.getList('history').toJSON()[0]).toEqual(before);
      expect(doc.getList('history').toJSON()[1].items).toEqual([
        { type: 'text', text: 'hello streamed' },
      ]);
      // The future peer edits its opaque item concurrently with the older client's append.
      future.set('payload', { revision: 2 });
      peer.commit();
      doc.import(peer.export({ mode: 'update', from: doc.version() }));
      peer.import(doc.export({ mode: 'update', from: peer.version() }));
      // Opening a schema also registers empty root containers without CRDT ops.
      // Compare the shared history, not those local empty-root projections.
      expect(doc.getList('history').toJSON()).toEqual(peer.getList('history').toJSON());
      expect(doc.getList('history').toJSON()[0].items).toEqual([
        { type: 'future_operation_progress', payload: { revision: 2 } },
        { type: 'text', text: 42 },
      ]);
      expect((doc.getList('history').get(0) as LoroMap).id).toBe(row.id);
      expect(((doc.getList('history').get(0) as LoroMap).get('items') as LoroList).id).toBe(
        items.id
      );
      mirror.dispose();
    }
  );

  it('does not loosen the explicit external message parser', () => {
    expect(MessageContentSchema.safeParse({ type: 'future_operation_progress' }).success).toBe(
      false
    );
    expect(MessageContentSchema.safeParse({ type: 'text', text: 42 }).success).toBe(false);
  });
});
