import { describe, expect, it } from 'vitest';

import { Loro, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { Mirror, schema, validateSchema } from 'loro-mirror';

import { sessionDocSchema, sessionHistorySchema } from '../src/schema';
import { createSessionMirror as createProductionSessionMirror } from '../src/session-mirror';
import { MessageContentSchema } from '../src/message-schemas';
import type { SessionId } from '../src/ids';

/**
 * Session docs are shared between clients built against different schema
 * versions. A peer on a newer build writes root keys this build does not
 * declare (`forkOperation` was the first one to reach production), so every
 * Mirror over a session doc must be constructed with
 * `ignoreUnknownProperties`. Without it, loro-mirror rejects the whole state
 * with `State validation failed: Unknown property: <key>` and the older client
 * can never write to that session again.
 */

const sessionId = 'session-forward-compat' as SessionId;

/** A future build's schema: today's schema plus one undeclared root container. */
const futureDocSchema = schema({
  ...sessionDocSchema.definition,
  futureFeature: schema.LoroMap({
    id: schema.String(),
    state: schema.String(),
  }),
});

function createFutureDocSnapshot(): Uint8Array {
  const doc = new Loro();
  const mirror = new Mirror({ doc, schema: futureDocSchema });
  mirror.setState((state) => ({
    ...state,
    session: { id: sessionId },
    history: [],
    futureFeature: { id: 'op-1', state: 'preparing' },
  }));
  return doc.export({ mode: 'snapshot' });
}

function createSessionMirror(doc: Loro) {
  return createProductionSessionMirror({
    doc,
    initialState: { session: { id: sessionId }, history: [] },
  });
}

// Synthetic future peer: raw Loro writes model a type this reader was built
// before. No cast makes that type part of the application's MessageContent.
function createFutureHistoryDoc(kind: 'future' | 'future-object-text' | 'malformed-known') {
  const doc = new Loro();
  doc.setPeerId('100');
  const mirror = createSessionMirror(doc);
  mirror.dispose();
  const turn = doc.getList('history').pushContainer(new LoroMap());
  turn.set('id', 'future-turn');
  turn.set('role', 'system');
  turn.set('timestamp', '2026-01-01T00:00:00.000Z');
  const items = turn.setContainer('items', new LoroList());
  const future = items.pushContainer(new LoroMap());
  future.set('type', kind === 'malformed-known' ? 'text' : 'future_operation_progress');
  if (kind !== 'future') {
    future.setContainer('text', new LoroMap()).set('futureValue', 42);
  }
  const payload = future.setContainer('payload', new LoroMap());
  const label = payload.setContainer('label', new LoroText());
  label.insert(0, 'created');
  const text = items.pushContainer(new LoroMap());
  text.set('type', 'text');
  text.setContainer('text', new LoroText()).insert(0, 'before');
  doc.commit();
  return { doc, future, label };
}

describe('session doc forward compatibility', () => {
  it.each(
    (['live import', 'snapshot reopen'] as const).flatMap((mode) =>
      (['future', 'future-object-text', 'malformed-known'] as const).map((kind) => ({ mode, kind }))
    )
  )('keeps sending and editing around $kind history after $mode', ({ mode, kind }) => {
    const peer = createFutureHistoryDoc(kind);
    const snapshot = peer.doc.export({ mode: 'snapshot' });
    const doc = new Loro();
    doc.setPeerId('200');
    if (mode === 'snapshot reopen') doc.import(snapshot);
    const beforeOpen = doc.version().toJSON();
    const mirror = createSessionMirror(doc);
    if (mode === 'snapshot reopen') expect(doc.version().toJSON()).toEqual(beforeOpen);
    if (mode === 'live import') doc.import(snapshot);
    const version = doc.version().toJSON();
    const original = doc.toJSON().history[0];
    expect(mirror.getState().history[0]?.items?.[0]?.type).toBe(original.items[0].type);
    expect(doc.version().toJSON()).toEqual(version);

    mirror.setState((state) => ({
      ...state,
      history: [
        ...state.history,
        {
          id: 'new-user-turn',
          role: 'user',
          timestamp: '2026-01-01T00:00:01.000Z',
          items: [{ type: 'text', text: 'hello' }],
        },
      ],
    }));
    expect(doc.toJSON().history[0]).toEqual(original);
    mirror.setState({ externalHistoryCursor: { importedTurnHashes: ['still-writable'] } });
    mirror.setState((state) => {
      state.history[0]!.items![1]!.text = 'after';
    });
    // Concurrent future-field edits must survive this reader's local writes.
    peer.label.update('running');
    peer.doc.commit();
    doc.import(peer.doc.export({ mode: 'update', from: doc.version() }));
    peer.doc.import(doc.export({ mode: 'update', from: peer.doc.version() }));

    expect(doc.toJSON()).toEqual(peer.doc.toJSON());
    expect(doc.toJSON().history).toHaveLength(2);
    expect(doc.toJSON().externalHistoryCursor.importedTurnHashes).toEqual(['still-writable']);
    expect(doc.toJSON().history[0].items[1].text).toBe('after');
    expect(doc.getContainerById(peer.future.id)?.toJSON()).toEqual({
      ...original.items[0],
      payload: { label: 'running' },
    });
    expect(doc.getContainerById(peer.label.id)?.toJSON()).toBe('running');
    mirror.dispose();
  });

  it('keeps malformed known items and untyped items invalid', () => {
    for (const item of [{ type: 'text' }, { type: 42 }, {}]) {
      const result = validateSchema(sessionHistorySchema, {
        id: 'invalid-turn',
        role: 'system',
        timestamp: '2026-01-01T00:00:00.000Z',
        items: [item],
      });
      expect(result.valid).toBe(false);
    }
    // Storage compatibility does not authorize a future type as new input.
    expect(MessageContentSchema.safeParse({ type: 'future_operation_progress' }).success).toBe(
      false
    );
    expect(
      MessageContentSchema.safeParse({ type: 'text', text: { futureValue: 42 } }).success
    ).toBe(false);
  });

  it('keeps writing after a newer peer adds an undeclared root key', () => {
    const doc = new Loro();
    const mirror = createSessionMirror(doc);

    // The crashing path in production: the mirror is already open when the
    // newer peer's update arrives, so the unknown key enters state via events.
    doc.import(createFutureDocSnapshot());

    expect(() => {
      mirror.setState({ externalHistoryCursor: { importedTurnHashes: ['older-client'] } });
    }).not.toThrow();

    expect(doc.toJSON().futureFeature).toEqual({ id: 'op-1', state: 'preparing' });
  });

  it('preserves the undeclared root key through a full-state update', () => {
    const doc = new Loro();
    const mirror = createSessionMirror(doc);
    doc.import(createFutureDocSnapshot());

    mirror.setState((state) => ({
      ...state,
      externalHistoryCursor: { importedTurnHashes: ['rebuilt'] },
    }));

    expect(doc.toJSON().futureFeature).toEqual({ id: 'op-1', state: 'preparing' });
  });

  it('does not lose concurrent edits made by the newer peer', () => {
    const snapshot = createFutureDocSnapshot();

    const olderDoc = new Loro();
    const olderMirror = createSessionMirror(olderDoc);
    olderDoc.import(snapshot);

    const newerDoc = new Loro();
    newerDoc.import(snapshot);
    const newerMirror = new Mirror({ doc: newerDoc, schema: futureDocSchema });

    olderMirror.setState({ externalHistoryCursor: { importedTurnHashes: ['older-client'] } });
    newerMirror.setState((state) => {
      state.futureFeature.state = 'failed';
    });

    olderDoc.import(newerDoc.export({ mode: 'update', from: olderDoc.version() }));
    newerDoc.import(olderDoc.export({ mode: 'update', from: newerDoc.version() }));

    expect(newerMirror.getState().futureFeature).toEqual({ id: 'op-1', state: 'failed' });
    expect(newerMirror.getState().externalHistoryCursor?.importedTurnHashes).toEqual([
      'older-client',
    ]);
    expect(olderDoc.toJSON().futureFeature).toEqual({ id: 'op-1', state: 'failed' });
  });
});
