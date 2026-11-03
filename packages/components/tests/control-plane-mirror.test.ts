import {
  createControlPlaneDoc,
  CONTROL_PLANE_IGNORED_ROOT_KEYS,
  sessionControlPlaneSchema,
} from '@lody/shared';
import { openReaderView, flushReaderChanges } from './conversation-view-fixtures';
import { describe, expect, it } from 'vitest';

import { LoroDoc, type LoroList, type LoroMap } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { createConversationSession, createHistoryWriter } from '../src/lib/conversation-view';
import {
  buildFixtureHistory,
  createManualIdle,
  FIXTURE_SESSION_ID,
} from './conversation-view-fixtures';

const controlPlaneMirror = (doc: LoroDoc) =>
  new Mirror({
    doc: createControlPlaneDoc(doc, { ignoredRootKeys: CONTROL_PLANE_IGNORED_ROOT_KEYS }),
    schema: sessionControlPlaneSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: FIXTURE_SESSION_ID } },
  });

const buildLargeDoc = (turnCount = 1_000): LoroDoc => {
  const doc = new LoroDoc();
  doc.setPeerId(3);
  doc.getMap('session').set('id', FIXTURE_SESSION_ID);
  const writer = createHistoryWriter(doc);
  for (const entry of buildFixtureHistory(turnCount)) writer.append(entry);
  const fresh = new LoroDoc();
  fresh.import(doc.export({ mode: 'snapshot' }));
  return fresh;
};

describe('control-plane Mirror (history: Ignore)', () => {
  it('leaves an untouched root from a newer peer intact when writing', async () => {
    // Forward compatibility (see providers/AGENTS.md): the facade answers root
    // enumeration with nothing, so a root this build does not declare and that
    // never changes during the session is invisible to Mirror state. What must
    // still hold is the part that matters — a control-plane write never deletes
    // or rewrites it.
    const doc = new LoroDoc();
    doc.getMap('session').set('id', FIXTURE_SESSION_ID);
    doc.getMap('futureFeature').set('state', 'preparing');
    doc.commit();
    await flushReaderChanges();
    const before = JSON.stringify(doc.getMap('futureFeature').toJSON());

    const mirror = controlPlaneMirror(doc);
    expect((mirror.getState() as Record<string, unknown>).futureFeature).toBeUndefined();
    mirror.setState((draft: { session: Record<string, unknown> }) => {
      draft.session.title = 'renamed';
    });

    expect(JSON.stringify(doc.getMap('futureFeature').toJSON())).toBe(before);
    expect(doc.getMap('session').get('title')).toBe('renamed');
    mirror.dispose();
  });

  it('keeps a stray write to the history key out of the document', async () => {
    // Nothing should reach `setState` with a `history` key any more. If a path
    // is ever missed, an ignored field is skipped on WRITE, so the durable list
    // is untouched — the miss stays an in-memory phantom on that Mirror rather
    // than a second, divergent copy of the conversation in the doc. Reading it
    // back is what `SessionDocState` (which omits `history`) rules out.
    const doc = buildLargeDoc(4);
    const view = await openReaderView(doc, {
      sessionId: FIXTURE_SESSION_ID,
      scheduleIdle: createManualIdle().scheduleIdle,
    });
    const mirror = controlPlaneMirror(doc);
    const before = (doc.getList('history') as LoroList).length;

    mirror.setState((draft: Record<string, unknown>) => {
      draft.history = [{ id: 'bogus', role: 'user', timestamp: 't' }];
    });

    expect((doc.getList('history') as LoroList).length).toBe(before);
    expect(view.turnCount).toBe(before);
    expect(view.indexOf('bogus')).toBe(-1);
    // Memory-only, as `schema.Ignore` defines: the phantom never reaches Loro.
    expect((mirror.getState() as Record<string, unknown>).history).toEqual([
      { id: 'bogus', role: 'user', timestamp: 't' },
    ]);
    mirror.dispose();
    view.dispose();
  });
});

describe.each([true, false])('shared writer with windowed=%s', (windowed) => {
  it('preserves opaque history while appending and updating known fields', async () => {
    const doc = new LoroDoc();
    const seed = createHistoryWriter(doc);
    const entry = buildFixtureHistory(1)[0]!;
    seed.append(entry);
    const map = doc.getList('history').get(0) as LoroMap;
    const items = map.get('items') as LoroList;
    items.push({ type: 'future-card', opaque: { body: 'keep' } });
    map.set('futureField', { value: 42 });
    doc.commit();
    await flushReaderChanges();
    const before = map.toJSON();
    const idle = createManualIdle();
    const session = createConversationSession(doc, {
      sessionId: FIXTURE_SESSION_ID,
      windowed,
      scheduleIdle: idle.scheduleIdle,
    });
    session.historyWriter.append({ ...entry, id: 'new-turn' });
    session.historyWriter.setField(entry.id, 'finished', true);
    expect(map.toJSON()).toEqual({ ...before, finished: true });
    expect(doc.getList('history').length).toBe(2);
    expect(() => session.historyWriter.setField(entry.id, 'finished', 'bad' as never)).toThrow();
    expect(map.get('finished')).toBe(true);
    session.history.dispose();
    session.mirror.dispose();
  });
});
