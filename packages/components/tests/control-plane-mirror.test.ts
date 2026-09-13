import { openReaderView, flushReaderChanges } from './conversation-view-fixtures';
import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';
import { LoroDoc, type LoroList, type LoroMap, type LoroText } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import {
  createConversationSession,
  createControlPlaneDoc,
  createHistoryWriter,
  CONTROL_PLANE_IGNORED_ROOT_KEYS,
  sessionControlPlaneSchema,
} from '../src/lib/conversation-view';
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

/**
 * 2,000 turns written through the production writer, so the container shape is
 * exactly what a Mirror write produces (~30k containers).
 *
 * Kept deliberately rich: a full Mirror over this doc costs ~272 ms locally
 * against the 30 ms bound below, so the assertion still fails loudly if the
 * control-plane Mirror ever starts walking `history`. A plain one-text-item
 * fixture builds faster but materializes in ~45 ms, which would leave the
 * bound with no usable margin.
 */
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
  it('does not materialize history when opening a long doc', async () => {
    // Warm the wasm and JIT paths on a small doc so the measurement is the construction alone.
    const warm = new LoroDoc();
    controlPlaneMirror(warm).dispose();

    const doc = buildLargeDoc();
    expect((doc.getList('history') as LoroList).length).toBe(2000);
    const mirror = controlPlaneMirror(doc);
    const state = mirror!.getState() as { history?: unknown; session?: unknown };
    expect(state.history).toBeUndefined();
    expect((state.session as { id?: string }).id).toBe(FIXTURE_SESSION_ID);
    mirror!.dispose();
  });

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

  it('does not see history events, but still sees other roots and unknown roots', async () => {
    const doc = new LoroDoc();
    const idle = createManualIdle();
    const view = await openReaderView(doc, {
      sessionId: FIXTURE_SESSION_ID,
      scheduleIdle: idle.scheduleIdle,
    });
    const writer = createHistoryWriter(doc);
    for (const entry of buildFixtureHistory(2)) writer.append(entry);

    const mirror = controlPlaneMirror(doc);
    let notifications = 0;
    mirror.subscribe(() => {
      notifications += 1;
    });

    // Streaming into the tail turn and appending a turn: invisible to the Mirror.
    const list = doc.getList('history') as LoroList;
    const last = list.get(list.length - 1) as LoroMap;
    const items = last.get('items') as LoroList;
    ((items.get(items.length - 1) as LoroMap).get('text') as LoroText).insert(0, 'more ');
    doc.commit();
    await flushReaderChanges();
    writer.append(buildFixtureHistory(3)[4] as SessionHistory);
    await flushReaderChanges();
    expect(notifications).toBe(0);
    expect((mirror.getState() as { history?: unknown }).history).toBeUndefined();
    expect(view.turnCount).toBe(5);

    // A control-plane root written directly on the doc still flows through.
    doc.getMap('session').set('title', 'renamed');
    doc.commit();
    await flushReaderChanges();
    expect(notifications).toBe(1);
    expect((mirror.getState().session as { title?: string }).title).toBe('renamed');

    // A root this build does not declare (a newer peer's) also arrives via events.
    doc.getMap('futureFeature').set('state', 'preparing');
    doc.commit();
    await flushReaderChanges();
    expect((mirror.getState() as Record<string, unknown>).futureFeature).toEqual({
      state: 'preparing',
    });

    // And Mirror writes to other roots keep working on the facade.
    mirror.setState((draft: { mq?: unknown[] }) => {
      draft.mq = [{ $cid: 'q1', task: 'hello', timestamp: 't', isEditing: false }] as never;
    });
    expect((doc.getMovableList('mq').toJSON() as unknown[]).length).toBe(1);
    expect(view.turnCount).toBe(5);
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

it.each([true, false])(
  'store disposal leaves detached captures readable in windowed=%s',
  async (windowed) => {
    const store = createConversationSession(new LoroDoc(), {
      sessionId: FIXTURE_SESSION_ID,
      windowed,
    });
    const snapshot = await store.sessionData.snapshots.capture();
    store.dispose();
    expect(snapshot.history).toEqual([]);
  }
);
