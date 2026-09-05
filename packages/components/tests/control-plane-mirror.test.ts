import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';
import { LoroDoc, type LoroList, type LoroMap, type LoroText } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import {
  createControlPlaneDoc,
  createConversationViewFromDoc,
  createHistoryWriter,
  CONTROL_PLANE_IGNORED_ROOT_KEYS,
  sessionControlPlaneSchema,
  type ConversationView,
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
 * `HistoryWriter.append` never consults the view (it inserts at the tail), so a
 * bulk fixture build can skip creating one. Attaching a live view here ran a
 * full event pass — tail hydrate, LRU, summaries — per appended turn: ~900 ms
 * of test-only work that pushed this file's setup past the 5 s budget on a
 * two-worker CI runner.
 */
const unattachedView = {
  turnCount: 0,
  index: () => undefined,
  indexOf: () => -1,
  turn: () => undefined,
} as unknown as ConversationView;

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
  const writer = createHistoryWriter(doc, unattachedView);
  for (const entry of buildFixtureHistory(turnCount)) writer.append(entry);
  const fresh = new LoroDoc();
  fresh.import(doc.export({ mode: 'snapshot' }));
  return fresh;
};

describe('control-plane Mirror (history: Ignore)', () => {
  it('constructs in under 30 ms on a 2,000-turn doc and never materializes history', () => {
    // Warm the wasm and JIT paths on a small doc so the measurement is the construction alone.
    const warm = new LoroDoc();
    controlPlaneMirror(warm).dispose();

    const doc = buildLargeDoc();
    expect((doc.getList('history') as LoroList).length).toBe(2000);
    const samples: number[] = [];
    let mirror: Mirror<typeof sessionControlPlaneSchema> | null = null;
    for (let i = 0; i < 3; i += 1) {
      mirror?.dispose();
      const started = performance.now();
      mirror = controlPlaneMirror(doc);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    // Deliberate wall-clock assertion (task requirement). The measured median is
    // ~1 ms and a Mirror that DID materialize this history costs ~272 ms, so the
    // bound sits between two values an order of magnitude apart on either side.
    expect(samples[1]).toBeLessThan(30);
    const state = mirror!.getState() as { history?: unknown; session?: unknown };
    expect(state.history).toBeUndefined();
    expect((state.session as { id?: string }).id).toBe(FIXTURE_SESSION_ID);
    mirror!.dispose();
  });

  it('leaves an untouched root from a newer peer intact when writing', () => {
    // Forward compatibility (see providers/AGENTS.md): the facade answers root
    // enumeration with nothing, so a root this build does not declare and that
    // never changes during the session is invisible to Mirror state. What must
    // still hold is the part that matters — a control-plane write never deletes
    // or rewrites it.
    const doc = new LoroDoc();
    doc.getMap('session').set('id', FIXTURE_SESSION_ID);
    doc.getMap('futureFeature').set('state', 'preparing');
    doc.commit();
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

  it('keeps a stray write to the history key out of the document', () => {
    // Nothing should reach `setState` with a `history` key any more. If a path
    // is ever missed, an ignored field is skipped on WRITE, so the durable list
    // is untouched — the miss stays an in-memory phantom on that Mirror rather
    // than a second, divergent copy of the conversation in the doc. Reading it
    // back is what `SessionDocState` (which omits `history`) rules out.
    const doc = buildLargeDoc(4);
    const view = createConversationViewFromDoc(doc, {
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

  it('does not see history events, but still sees other roots and unknown roots', () => {
    const doc = new LoroDoc();
    const idle = createManualIdle();
    const view = createConversationViewFromDoc(doc, {
      sessionId: FIXTURE_SESSION_ID,
      scheduleIdle: idle.scheduleIdle,
    });
    const writer = createHistoryWriter(doc, view);
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
    writer.append(buildFixtureHistory(3)[4] as SessionHistory);
    expect(notifications).toBe(0);
    expect((mirror.getState() as { history?: unknown }).history).toBeUndefined();
    expect(view.turnCount).toBe(5);

    // A control-plane root written directly on the doc still flows through.
    doc.getMap('session').set('title', 'renamed');
    doc.commit();
    expect(notifications).toBe(1);
    expect((mirror.getState().session as { title?: string }).title).toBe('renamed');

    // A root this build does not declare (a newer peer's) also arrives via events.
    doc.getMap('futureFeature').set('state', 'preparing');
    doc.commit();
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
