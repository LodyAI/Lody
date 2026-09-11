import { describe, expect, it } from 'vitest';
import {
  HistoryEntryWriteSchema,
  parseHistoryWrite,
  sessionDocSchema,
  type PermissionOutcome,
  type SessionHistory,
} from '@lody/shared';
import { LoroDoc, LoroText, type LoroList, type LoroMap } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { createConversationViewFromDoc, createHistoryWriter } from '../src/lib/conversation-view';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
  mirrorHistoryOf,
  reimport,
} from './conversation-view-fixtures';

const PEER = 7;

/** Container kinds and values at every path, with op-derived ids stripped. */
const shapeOf = (doc: LoroDoc): unknown => {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if ('cid' in record && 'value' in record) {
        return { kind: String(record.cid).split(':').pop(), value: strip(record.value) };
      }
      return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, strip(v)]));
    }
    return node;
  };
  return strip((doc as unknown as { getDeepValueWithID(): unknown }).getDeepValueWithID());
};

const openWriterDoc = (history: readonly SessionHistory[] = []) => {
  const doc = buildSessionDoc(history, PEER);
  const idle = createManualIdle();
  const view = createConversationViewFromDoc(doc, {
    sessionId: FIXTURE_SESSION_ID,
    tailKeep: 2,
    maxHydrated: 4,
    scheduleIdle: idle.scheduleIdle,
  });
  return { doc, view, writer: createHistoryWriter(doc) };
};

const mirrorOver = (doc: LoroDoc) =>
  new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: FIXTURE_SESSION_ID }, history: [] },
  });

describe('createHistoryWriter', () => {
  it('appends readable history with editable streaming text across snapshot reload', async () => {
    const history = buildFixtureHistory(8).map((entry) =>
      parseHistoryWrite(HistoryEntryWriteSchema, entry)
    ) as SessionHistory[];
    const { doc, view, writer } = openWriterDoc();
    for (const entry of history) writer.append(entry);

    // Raw Mirror writes are not the storage oracle: schema storage hints can
    // intentionally give new writes a different layout. Check values against
    // authored input, and the streaming contract against real containers.
    const restored = reimport(doc);
    expect(mirrorHistoryOf(restored)).toEqual(history);
    const restoredView = createConversationViewFromDoc(restored, {
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

  it('rejects an entry that fails the session history schema', () => {
    const { writer } = openWriterDoc();
    expect(() =>
      writer.append({
        id: 'bad',
        role: 'user',
        items: [{ type: 'text' }],
      } as unknown as SessionHistory)
    ).toThrow(/Invalid history write/i);
  });

  const replaceCases: Array<[string, (turn: SessionHistory) => SessionHistory]> = [
    ['scalar promotion (status/read)', (turn) => ({ ...turn, status: 'pending', read: false })],
    ['cleared endedAt and finished', (turn) => ({ ...turn, finished: false, endedAt: undefined })],
    [
      'tool call meta update',
      (turn) => {
        const items = [...turn.items!];
        items[1] = { ...(items[1] as object), title: 'accepted tool' } as never;
        return { ...turn, items };
      },
    ],
    [
      'text change, appended item, and dropped item',
      (turn) => {
        const items = [...turn.items!];
        items[2] = { ...(items[2] as object), text: 'rewritten answer' } as never;
        items.splice(0, 1);
        items.push({ type: 'text', text: 'trailing' } as never);
        return { ...turn, items };
      },
    ],
    [
      'fileDiff and modelInfo replaced with fresh objects',
      (turn) => ({
        ...turn,
        fileDiff: [{ filePath: 'x.ts', add: 2, del: 0, cc: { v: 1, fileId: 'f' } }],
        modelInfo: {
          modelId: 'test',
          name: 'opus',
          _meta: { provider: 'anthropic', effort: 'high' },
        },
      }),
    ],
  ];

  for (const [label, mutate] of replaceCases) {
    it(`replaces a turn in place like Mirror: ${label}`, () => {
      const history = buildFixtureHistory(3);
      const target = history[3]!; // a-1
      const reference = buildSessionDoc(history, PEER);
      const mirror = mirrorOver(reference);
      const referenceState = mirror.getState().history as unknown as SessionHistory[];
      const referenceTurn = referenceState.find((entry) => entry.id === target.id)!;
      mirror.setState((draft: { history: SessionHistory[] }) => {
        const index = draft.history.findIndex((entry) => entry.id === target.id);
        draft.history[index] = mutate(referenceTurn);
      });

      const { doc, view, writer } = openWriterDoc(history);
      const targetIndex = view.indexOf(target.id);
      const range = view.acquireRange(targetIndex, targetIndex + 1); // hydrates synchronously
      const current = view.turn(targetIndex)!;
      expect(writer.replace(target.id, mutate(current))).toBe(true);

      expect(shapeOf(doc)).toEqual(shapeOf(reference));
      expect(mirrorHistoryOf(reimport(doc))).toEqual(mirrorHistoryOf(reimport(reference)));
      expect(view.turn(view.indexOf(target.id))).toEqual(
        mirrorHistoryOf(reimport(reference)).find((entry) => entry.id === target.id)
      );
      range.release();
    });
  }

  it('replaces a turn the view has evicted by reading it back from the doc', () => {
    const history = buildFixtureHistory(6);
    const { doc, view, writer } = openWriterDoc(history);
    expect(view.isHydrated(1)).toBe(false);
    const before = writer.read('a-0')!;
    expect(before).toEqual(history[1]);
    expect(writer.replace('a-0', { ...before, finished: false })).toBe(true);
    expect(mirrorHistoryOf(reimport(doc))[1]).toEqual({ ...history[1], finished: false });
    expect(writer.replace('missing', before)).toBe(false);
  });

  it('records a permission outcome exactly like the Mirror draft mutation', () => {
    const history = buildFixtureHistory(4); // a-3 carries req-3 without an outcome
    const outcome = { outcome: 'selected', optionId: 'allow' } as PermissionOutcome;
    const reference = buildSessionDoc(history, PEER);
    const mirror = mirrorOver(reference);
    mirror.setState((draft: { history: SessionHistory[] }) => {
      for (const entry of draft.history) {
        for (const item of entry.items ?? []) {
          const request = (
            item as { permissionRequest?: { requestId?: string; outcome?: unknown } }
          ).permissionRequest;
          if (request?.requestId === 'req-3') {
            request.outcome = outcome;
            return;
          }
        }
      }
    });

    const { doc, writer } = openWriterDoc(history);
    expect(writer.respondPermission('req-3', outcome)).toBe(true);
    expect(shapeOf(doc)).toEqual(shapeOf(reference));
    expect(mirrorHistoryOf(reimport(doc))).toEqual(mirrorHistoryOf(reimport(reference)));

    const { doc: hinted, writer: hintedWriter } = openWriterDoc(history);
    expect(hintedWriter.respondPermission('req-3', outcome, { turnId: 'a-3' })).toBe(true);
    expect(shapeOf(hinted)).toEqual(shapeOf(reference));
    expect(hintedWriter.respondPermission('nope', outcome)).toBe(false);
  });
});
