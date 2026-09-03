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

/** 2,000 turns written through the writer (equivalent to Mirror writes, and fast). */
const buildLargeDoc = (): LoroDoc => {
  const doc = new LoroDoc();
  doc.setPeerId(3);
  doc.getMap('session').set('id', FIXTURE_SESSION_ID);
  const idle = createManualIdle();
  const view = createConversationViewFromDoc(doc, {
    sessionId: FIXTURE_SESSION_ID,
    scheduleIdle: idle.scheduleIdle,
  });
  const writer = createHistoryWriter(doc, view);
  for (const entry of buildFixtureHistory(1000)) writer.append(entry);
  view.dispose();
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
    // Deliberate wall-clock assertion (task requirement): the old path costs
    // seconds here, so the bound is far from the measured ~1 ms median.
    expect(samples[1]).toBeLessThan(30);
    const state = mirror!.getState() as { history?: unknown; session?: unknown };
    expect(state.history).toBeUndefined();
    expect((state.session as { id?: string }).id).toBe(FIXTURE_SESSION_ID);
    mirror!.dispose();
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
