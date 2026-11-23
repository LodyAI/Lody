import { openReaderView, flushReaderChanges } from './conversation-view-fixtures';
import { describe, expect, it } from 'vitest';
import { HistoryEntryWriteSchema, parseHistoryWrite, type SessionHistory } from '@lody/shared';
import { LoroText, type LoroList, type LoroMap } from 'loro-crdt';

import { createHistoryWriter } from '../src/lib/conversation-view';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
  mirrorHistoryOf,
  reimport,
} from './conversation-view-fixtures';

const PEER = 7;

const openWriterDoc = async (history: readonly SessionHistory[] = []) => {
  const doc = buildSessionDoc(history, PEER);
  const idle = createManualIdle();
  const view = await openReaderView(doc, {
    sessionId: FIXTURE_SESSION_ID,
    tailKeep: 2,
    maxHydrated: 4,
    scheduleIdle: idle.scheduleIdle,
  });
  return { doc, view, writer: createHistoryWriter(doc) };
};

describe('createHistoryWriter', () => {
  it('appends readable history with editable streaming text across snapshot reload', async () => {
    const history = buildFixtureHistory(8).map((entry) =>
      parseHistoryWrite(HistoryEntryWriteSchema, entry)
    ) as SessionHistory[];
    const { doc, view, writer } = await openWriterDoc();
    for (const entry of history) writer.append(entry);

    // Raw Mirror writes are not the storage oracle: schema storage hints can
    // intentionally give new writes a different layout. Check values against
    // authored input, and the streaming contract against real containers.
    const restored = reimport(doc);
    expect(mirrorHistoryOf(restored)).toEqual(history);
    const restoredView = await openReaderView(restored, {
      sessionId: FIXTURE_SESSION_ID,
      scheduleIdle: createManualIdle().scheduleIdle,
    });
    const range = restoredView.acquireRange(0, history.length);
    await range.ready;
    expect(history.map((_, index) => restoredView.turn(index))).toEqual(history);
    const row = restored.getList('history').get(0) as LoroMap;
    expect(row.get('id')).toBe(history[0]!.id);
    const item = (row.get('items') as LoroList).get(0) as LoroMap;
    const text = item.get('text') as LoroText;
    expect(text).toBeInstanceOf(LoroText);
    const cid = text.id;
    text.insert(text.length, ' continued');
    restored.commit();
    await flushReaderChanges();
    expect((item.get('text') as LoroText).id).toBe(cid);
    expect(restoredView.turn(0)?.items?.[0]).toEqual({
      type: 'text',
      text: 'Round 0: please inspect module-0. continued',
    });
    expect(mirrorHistoryOf(reimport(restored))[0]?.items?.[0]).toEqual(
      restoredView.turn(0)?.items?.[0]
    );
    expect(view.turnCount).toBe(history.length);
    expect(view.turn(history.length - 1)).toEqual(history[history.length - 1]);
    range.release();
    restoredView.dispose();
    view.dispose();
  });

  it('replaces a turn the view has evicted by reading it back from the doc', async () => {
    const history = buildFixtureHistory(6);
    const { doc, view, writer } = await openWriterDoc(history);
    expect(view.isHydrated(1)).toBe(false);
    const before = writer.read('a-0')!;
    expect(before).toEqual(history[1]);
    expect(writer.replace('a-0', { ...before, finished: false })).toBe(true);
    expect(mirrorHistoryOf(reimport(doc))[1]).toEqual({ ...history[1], finished: false });
    expect(writer.replace('missing', before)).toBe(false);
  });
});
