import { openReaderView, flushReaderChanges } from './conversation-view-fixtures';
import { describe, expect, it } from 'vitest';
import { schema, Mirror, type SchemaType } from 'loro-mirror';
import { LoroDoc, LoroMap, LoroText, type LoroList } from 'loro-crdt';
import { sessionHistorySchema } from '@lody/shared';
import { createHistoryWriter } from '../src/lib/conversation-view';
import { getMapFieldSchema, writeMapEntry } from '../../shared/src/history-materializer';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
} from './conversation-view-fixtures';

// Optional hint shape without a dependency on a not-yet-published Mirror type.
const hinted = (storageSchema: SchemaType) => {
  const field = schema.Any({ defaultLoroText: false });
  Object.assign(field.options, { storageSchema });
  return field;
};

describe('optional string storage layouts', () => {
  it('writes the same fresh container shape as an explicit Mirror layout', async () => {
    const layout = schema.LoroList(
      schema.LoroMap({
        output: schema.LoroText(),
        title: schema.String(),
      })
    );
    const mapSchema = schema.LoroMap({
      content: hinted(layout),
      markdown: hinted(schema.LoroText()),
    });
    const reference = new LoroDoc();
    const mirror = new Mirror({
      doc: reference,
      schema: schema({
        root: schema.LoroMap({
          content: layout,
          markdown: schema.LoroText(),
        }),
      }),
    });
    const content = [{ output: 'streaming output', title: 'metadata' }];
    mirror.setState({ root: { content, markdown: '# Plan' } });
    const doc = new LoroDoc();
    const root = doc.getMap('root');
    writeMapEntry(root, mapSchema, 'content', content, undefined);
    writeMapEntry(root, mapSchema, 'markdown', '# Plan', undefined);
    expect(root.toJSON()).toEqual(reference.getMap('root').toJSON());
    const block = (root.get('content') as LoroList).get(0) as LoroMap;
    expect((block.get('output') as LoroText).kind()).toBe('Text');
    expect(block.get('title')).toBe('metadata');
    expect((root.get('markdown') as LoroText).kind()).toBe('Text');
    // Wrong-shaped legacy values keep ordinary Any inference, not a forced list.
    expect(getMapFieldSchema(mapSchema, 'content', 'legacy')?.type).toBe('any');
    writeMapEntry(root, mapSchema, 'content', 'legacy', undefined);
    expect(root.get('content')).toBe('legacy');
    mirror.dispose();
  });

  it('HistoryWriter preserves old Text ids and primitive strings with hinted schemas', async () => {
    const history = buildFixtureHistory(1);
    const doc = buildSessionDoc(history);
    const turn = doc.getList('history').get(1) as LoroMap;
    const item = (turn.get('items') as LoroList).get(1) as LoroMap;
    const legacyTitle = item.setContainer('title', new LoroText());
    legacyTitle.insert(0, 'old title');
    const titleId = legacyTitle.id;
    item.set('toolName', 'legacy primitive');
    doc.commit();
    await flushReaderChanges();
    const itemSchema = sessionHistorySchema.definition.items.itemSchema;
    const definition = itemSchema.definition as Record<string, SchemaType>;
    const previousToolName = definition.toolName;
    const oldDefault = itemSchema.catchallType.options.defaultLoroText;
    try {
      definition.toolName = hinted(schema.LoroText());
      itemSchema.catchallType.options.defaultLoroText = false;
      const idle = createManualIdle();
      const view = await openReaderView(doc, {
        sessionId: FIXTURE_SESSION_ID,
        scheduleIdle: idle.scheduleIdle,
      });
      const writer = createHistoryWriter(doc);
      const before = writer.read('a-0')!;
      const items = [...before.items!];
      items[1] = { ...items[1], title: 'changed title', toolName: 'changed primitive' } as never;
      writer.replace('a-0', { ...before, items });
      expect((item.get('title') as LoroText).id).toBe(titleId);
      expect((item.get('title') as LoroText).toString()).toBe('changed title');
      expect(item.get('toolName')).toBe('changed primitive');
      view.dispose();
    } finally {
      itemSchema.catchallType.options.defaultLoroText = oldDefault;
      if (previousToolName) definition.toolName = previousToolName;
      else delete definition.toolName;
    }
  });
});
