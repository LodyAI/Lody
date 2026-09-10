import { describe, expect, it } from 'vitest';
import { Loro, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { Mirror, schema } from 'loro-mirror';

const definition = schema({
  rows: schema.LoroList(schema.LoroMap({ text: schema.LoroText(), count: schema.Number() })),
  title: schema.LoroText(),
  tree: schema.LoroTree({ text: schema.LoroText() }),
});
const open = (doc: Loro) => new Mirror({ doc, schema: definition });
const textAt = (doc: Loro, index: number) =>
  (doc.getList('rows').get(index) as LoroMap).get('text') as LoroText;

describe('Mirror single-text path copies', () => {
  it('retains old snapshots, sibling identity, cid descriptors and synchronous notifications', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.setState({
      rows: [
        { text: '前😀后', count: 0 },
        { text: 'untouched', count: 1 },
      ],
    });
    const before = mirror.getState();
    const descriptor = Object.getOwnPropertyDescriptor(before.rows[0], '$cid');
    expect(descriptor).toMatchObject({ writable: false, enumerable: false, configurable: false });
    const published: unknown[] = [];
    const unsubscribe = mirror.subscribe((state) => published.push(state));
    textAt(doc, 0).update('前🌱中后');
    doc.commit();
    const next = mirror.getState();
    expect(next.rows).toEqual(doc.getList('rows').toJSON());
    expect(before.rows[0]!.text).toBe('前😀后');
    expect(next.rows[1]).toBe(before.rows[1]);
    expect(Object.getOwnPropertyDescriptor(next.rows[0], '$cid')).toEqual(descriptor);
    expect(published).toEqual([next]);
    // Subsequent Mirror-authored writes must still work with the retained descriptors.
    mirror.setState((state) => {
      state.rows[0]!.text += '!';
    });
    expect(textAt(doc, 0).toString()).toBe('前🌱中后!');
    doc.getText('title').update('root text');
    doc.commit();
    expect(mirror.getState().title).toBe('root text');
    unsubscribe();
    mirror.dispose();
  });

  it('converges after concurrent text edits, peer insertion and mixed batches', () => {
    const left = new Loro();
    const a = open(left);
    a.setState({ rows: [{ text: 'base', count: 0 }] });
    const right = new Loro();
    right.import(left.export({ mode: 'snapshot' }));
    const b = open(right);
    textAt(left, 0).insert(0, 'left-');
    left.commit();
    b.setState((state) => {
      state.rows[0]!.text += '-right';
    });
    left.import(right.export({ mode: 'update', from: left.version() }));
    right.import(left.export({ mode: 'update', from: right.version() }));
    expect(a.getState().rows).toEqual(b.getState().rows);
    expect(a.getState().rows[0]!.text).toBe('left-base-right');
    b.setState((state) => {
      state.rows.unshift({ text: 'inserted', count: 1 });
    });
    left.import(right.export({ mode: 'update', from: left.version() }));
    textAt(left, 1).update('new position');
    left.commit();
    expect(a.getState().rows[1]!.text).toBe('new position');
    // Two event targets use the general path, including new subtree construction.
    textAt(left, 1).update('mixed');
    (left.getList('rows').get(1) as LoroMap).set('count', 2);
    left.commit();
    right.import(left.export({ mode: 'update', from: right.version() }));
    expect(a.getState().rows).toEqual(left.getList('rows').toJSON());
    expect(b.getState().rows).toEqual(a.getState().rows);
    left.getList('rows').delete(0, 1);
    left.commit();
    textAt(left, 0).update('after deletion');
    left.commit();
    expect(a.getState().rows).toEqual(left.getList('rows').toJSON());
    a.dispose();
    b.dispose();
  });

  it('keeps the general tree-id and newly created text paths', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const node = doc.getTree('tree').createNode();
    const text = node.data.setContainer('text', new LoroText());
    text.update('tree before');
    doc.commit();
    const before = mirror.getState();
    text.update('tree after');
    doc.commit();
    expect(mirror.getState().tree[0]!.data.text).toBe('tree after');
    expect(before.tree[0]!.data.text).toBe('tree before');
    const row = doc.getList('rows').pushContainer(new LoroMap());
    row.set('count', 1);
    row.setContainer('text', new LoroText()).update('new subtree');
    doc.commit();
    expect(mirror.getState().rows).toEqual(doc.getList('rows').toJSON());
    expect(doc.getList('rows')).toBeInstanceOf(LoroList);
    mirror.dispose();
  });
});
