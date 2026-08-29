import { describe, expect, it } from 'vitest';

import { Loro } from 'loro-crdt';
import { Mirror, schema } from 'loro-mirror';

import { sessionDocSchema } from '../src/schema';
import type { SessionId } from '../src/ai';

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
  return new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: sessionId }, history: [] },
  });
}

describe('session doc forward compatibility', () => {
  it('keeps writing after a newer peer adds an undeclared root key', () => {
    const doc = new Loro();
    const mirror = createSessionMirror(doc);

    // The crashing path in production: the mirror is already open when the
    // newer peer's update arrives, so the unknown key enters state via events.
    doc.import(createFutureDocSnapshot());

    expect(() => {
      mirror.setState((state) => {
        state.session.title = 'renamed by the older client';
      });
    }).not.toThrow();

    expect(doc.toJSON().futureFeature).toEqual({ id: 'op-1', state: 'preparing' });
  });

  it('preserves the undeclared root key through a full-state update', () => {
    const doc = new Loro();
    const mirror = createSessionMirror(doc);
    doc.import(createFutureDocSnapshot());

    mirror.setState((state) => ({ ...state, session: { ...state.session, title: 'rebuilt' } }));

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

    olderMirror.setState((state) => {
      state.session.title = 'edited by the older client';
    });
    newerMirror.setState((state) => {
      state.futureFeature.state = 'failed';
    });

    olderDoc.import(newerDoc.export({ mode: 'update', from: olderDoc.version() }));
    newerDoc.import(olderDoc.export({ mode: 'update', from: newerDoc.version() }));

    expect(newerMirror.getState().futureFeature).toEqual({ id: 'op-1', state: 'failed' });
    expect(newerMirror.getState().session.title).toBe('edited by the older client');
    expect(olderDoc.toJSON().futureFeature).toEqual({ id: 'op-1', state: 'failed' });
  });
});
