import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import {
  TODAY_MENTION_CHAR,
  createTodayPageUndo,
  insertTodayRich,
  openTodayOutline,
  readTodayText,
  parseTodayPasteText,
  type TodayOutline,
  getLoroStreamIdForDocId,
  getTodayDocId,
  getTodayDocIdPrefix,
  isTodayDocOfUser,
  parseTodayDate,
  parseTodayDocId,
  type TodayDate,
  type WorkspaceId,
} from '../src';

const ws = 'ws1' as WorkspaceId;
const date = (value: string) => {
  const parsed = parseTodayDate(value);
  if (!parsed) throw new Error(`invalid test date ${value}`);
  return parsed;
};

describe('Today page identity', () => {
  it('round-trips a local user id whose colon would split the stream id', () => {
    const docId = getTodayDocId('local:abc-1', date('2026-11-20'));
    expect(docId).toBe('today-local%3Aabc-1-2026-11-20');
    expect(parseTodayDocId(docId)).toEqual({ userId: 'local:abc-1', date: '2026-11-20' });
    expect(getLoroStreamIdForDocId(ws, docId)).toBe('ws1:td:local%3Aabc-1:2026-11-20');
  });

  it('does not let a shorter user id claim pages of a user id it prefixes', () => {
    const other = getTodayDocId('abc-def', date('2026-11-20'));
    expect(other.startsWith(getTodayDocIdPrefix('abc'))).toBe(true);
    expect(isTodayDocOfUser(other, 'abc')).toBe(false);
    expect(isTodayDocOfUser(other, 'abc-def')).toBe(true);
  });

  it('rejects impossible dates and non-canonical encodings', () => {
    expect(parseTodayDate('2026-02-30')).toBeNull();
    expect(parseTodayDate('2026-1-05')).toBeNull();
    expect(parseTodayDocId('today-local%3aabc-2026-11-20')).toBeNull();
    expect(parseTodayDocId('today--2026-11-20')).toBeNull();
    expect(parseTodayDocId('today-abc-2026-11-2x')).toBeNull();
  });

  it('refuses to build a page id for an empty user', () => {
    expect(() => getTodayDocId('', date('2026-11-20') as TodayDate)).toThrow();
  });
});

/** A node label with each mention written as `@id`. */
function label(node: { text: string; mentions: readonly { start: number; id: string }[] }) {
  let out = '';
  let cursor = 0;
  for (const mention of node.mentions) {
    out += `${node.text.slice(cursor, mention.start)}@${mention.id}`;
    cursor = mention.start + 1;
  }
  return out + node.text.slice(cursor);
}

/** Outline as indented text: two spaces per level, `[x]` for collapsed, `@id` for mentions. */
function render(outline: TodayOutline): string {
  return outline
    .getAllNodes()
    .map((node) => `${'  '.repeat(node.depth)}${label(node)}${node.collapsed ? ' [x]' : ''}`)
    .join('\n');
}

const session = (id: string) => ({ kind: 'session', id });

function build(lines: string): { doc: LoroDoc; outline: TodayOutline; ids: Map<string, string> } {
  const doc = new LoroDoc();
  const outline = openTodayOutline(doc);
  outline.paste({ kind: 'page-start' }, parseTodayPasteText(lines));
  const ids = new Map(outline.getAllNodes().map((node) => [node.text, node.id] as const));
  return { doc, outline, ids };
}

const idOf = (ids: Map<string, string>, text: string) => {
  const id = ids.get(text);
  if (!id) throw new Error(`no node ${text}`);
  return id as Parameters<TodayOutline['split']>[0];
};

describe('Today outline structure', () => {
  it('builds a nested outline from indented paste text', () => {
    const { outline } = build('a\n  b\n    c\nd');
    expect(render(outline)).toBe('a\n  b\n    c\nd');
  });

  it('splits at the caret, keeping the original node on the left half', () => {
    const { outline, ids } = build('hello world\nnext');
    const focus = outline.split(idOf(ids, 'hello world'), 5);
    expect(render(outline)).toBe('hello\n world\nnext');
    expect(outline.getNode(idOf(ids, 'hello world'))?.text).toBe('hello');
    expect(focus).toMatchObject({ offset: 0 });
  });

  it('puts the right half first among expanded children', () => {
    const { outline, ids } = build('parent\n  child');
    outline.split(idOf(ids, 'parent'), 6);
    expect(render(outline)).toBe('parent\n  \n  child');
  });

  it('splitting at the start inserts an empty node before and keeps the identity', () => {
    const { outline, ids } = build('keep');
    const id = idOf(ids, 'keep');
    outline.split(id, 0);
    expect(render(outline)).toBe('\nkeep');
    expect(outline.getNode(id)?.text).toBe('keep');
  });

  it('Enter on an empty nested last child outdents it, otherwise creates a sibling', () => {
    const { outline, ids } = build('p\n  x\n  y');
    outline.split(idOf(ids, 'y'), 1);
    const empty = outline.getAllNodes().find((node) => node.text === '' && node.depth === 1);
    outline.enterOnEmpty(empty!.id);
    expect(render(outline)).toBe('p\n  x\n  y\n');
    outline.enterOnEmpty(outline.getAllNodes().at(-1)!.id);
    expect(render(outline)).toBe('p\n  x\n  y\n\n');
  });

  it('indents under the previous sibling and expands it when folded', () => {
    const { outline, ids } = build('a\n  a1\nb');
    outline.setCollapsed(idOf(ids, 'a'), true);
    outline.indent([idOf(ids, 'b')]);
    expect(render(outline)).toBe('a\n  a1\n  b');
  });

  it('outdents directly: following siblings become children of the outdented node', () => {
    const { outline, ids } = build('p\n  a\n  b\n  c\nq');
    outline.outdent([idOf(ids, 'b')]);
    expect(render(outline)).toBe('p\n  a\nb\n  c\nq');
  });

  it('a selection spanning parents indents and outdents each run of siblings as if on its own', () => {
    const tree = 'a\n  a1\n  a2\nb\nc';
    const indented = build(tree);
    indented.outline.indent([idOf(indented.ids, 'a2'), idOf(indented.ids, 'b')]);
    expect(render(indented.outline)).toBe('a\n  a1\n    a2\n  b\nc');

    const outdented = build(tree);
    outdented.outline.outdent([idOf(outdented.ids, 'a2'), idOf(outdented.ids, 'b')]);
    // a2 leaves a; the root b has nowhere to go; c is not pulled under b.
    expect(render(outdented.outline)).toBe('a\n  a1\na2\nb\nc');

    const gapped = build('p\n  a\n  b\n  c\n  d');
    gapped.outline.outdent([idOf(gapped.ids, 'a'), idOf(gapped.ids, 'c')]);
    expect(render(gapped.outline)).toBe('p\na\n  b\nc\n  d');
  });

  it('refuses to move a selection spanning parents up or down, leaving the tree as it was', () => {
    const tree = 'a\n  a1\n  a2\nb\nc';
    const { outline, ids } = build(tree);
    const selection = [idOf(ids, 'a2'), idOf(ids, 'b')];
    expect(outline.moveUp(selection)).toBe(false);
    expect(outline.moveDown(selection)).toBe(false);
    expect(render(outline)).toBe(tree);
  });

  it('merging into a folded node unfolds it, so the merged children stay visible', () => {
    const { outline, ids } = build('a\n  a1\nb\n  b1');
    outline.setCollapsed(idOf(ids, 'a'), true);
    outline.mergeWithPrevious(idOf(ids, 'b'));
    expect(render(outline)).toBe('ab\n  a1\n  b1');
  });

  it('merges into the previous visible node and re-parents children', () => {
    const { outline, ids } = build('a\nb\n  b1');
    const focus = outline.mergeWithPrevious(idOf(ids, 'b'));
    expect(render(outline)).toBe('ab\n  b1');
    expect(focus).toEqual({ nodeId: idOf(ids, 'a'), offset: 1 });
  });

  it("merging carries the moved node's mentions to their new offsets", () => {
    const { outline, ids } = build('ab\ncd');
    outline.insertMention(idOf(ids, 'cd'), 1, 0, session('s1'));
    outline.mergeWithPrevious(idOf(ids, 'cd'));
    expect(render(outline)).toBe('abc@s1d');
    expect(outline.getNode(idOf(ids, 'ab'))?.mentions).toEqual([
      { start: 3, kind: 'session', id: 's1' },
    ]);
  });

  it('moves a subtree among siblings and rejects a move into its own descendant', () => {
    const { outline, ids } = build('a\n  a1\nb');
    outline.moveDown([idOf(ids, 'a')]);
    expect(render(outline)).toBe('b\na\n  a1');
    const before = render(outline);
    expect(outline.moveTo([idOf(ids, 'a')], { parentId: idOf(ids, 'a1'), index: 0 })).toBe(false);
    expect(render(outline)).toBe(before);
  });

  it('splitting keeps a mention on whichever half holds it', () => {
    const { outline, ids } = build('see  now');
    outline.insertMention(idOf(ids, 'see  now'), 4, 0, session('s1'));
    const id = outline.getAllNodes()[0]!.id;
    outline.split(id, 4);
    expect(render(outline)).toBe('see \n@s1 now');
    expect(outline.getAllNodes()[1]!.mentions).toEqual([{ start: 0, kind: 'session', id: 's1' }]);
  });

  it('replaces the @query with a mention in place', () => {
    const { outline, ids } = build('ask @fix later');
    const id = idOf(ids, 'ask @fix later');
    expect(outline.insertMention(id, 4, 4, session('s1'))).toEqual({ nodeId: id, offset: 5 });
    expect(render(outline)).toBe('ask @s1 later');
  });

  it('reads two adjacent mentions of the same conversation as two', () => {
    const { outline, ids } = build('x');
    const id = idOf(ids, 'x');
    outline.insertMention(id, 1, 0, session('s1'));
    outline.insertMention(id, 2, 0, session('s1'));
    expect(outline.getNode(id)?.mentions).toEqual([
      { start: 1, kind: 'session', id: 's1' },
      { start: 2, kind: 'session', id: 's1' },
    ]);
  });

  it('does not extend a mention to text typed next to it, even by a peer without the style config', () => {
    const { doc, outline, ids } = build('ab');
    const id = idOf(ids, 'ab');
    outline.insertMention(id, 1, 0, session('s1'));
    const peer = new LoroDoc();
    peer.import(doc.export({ mode: 'snapshot' }));
    const text = openTodayOutline(peer).getText(id)!;
    text.insert(2, 'Z');
    text.insert(1, 'W');
    peer.commit();
    expect(readTodayText(text)).toEqual({
      text: `aW${TODAY_MENTION_CHAR}Zb`,
      mentions: [{ start: 2, kind: 'session', id: 's1' }],
    });
  });

  it('reads a bare U+FFFC as an unknown mention and ignores a mark on ordinary text', () => {
    const { outline, ids } = build('ab');
    const text = outline.getText(idOf(ids, 'ab'))!;
    text.insert(1, TODAY_MENTION_CHAR);
    text.mark({ start: 0, end: 1 }, 'mention', { kind: 'session', id: 'stray' });
    expect(readTodayText(text).mentions).toEqual([{ start: 1, kind: '', id: '' }]);
  });

  it('leaves no residue when one peer deletes a mention while another types after it', () => {
    const a = new LoroDoc();
    const outline = openTodayOutline(a);
    const focus = outline.insertFirst('hi ') as { nodeId: Parameters<TodayOutline['split']>[0] };
    outline.insertMention(focus.nodeId, 3, 0, session('s9'));
    const b = new LoroDoc();
    b.import(a.export({ mode: 'snapshot' }));
    outline.getText(focus.nodeId)!.delete(3, 1);
    a.commit();
    openTodayOutline(b).getText(focus.nodeId)!.insert(4, '!');
    b.commit();
    a.import(b.export({ mode: 'update' }));
    expect(outline.getNode(focus.nodeId)).toMatchObject({ text: 'hi !', mentions: [] });
  });

  it('inserts a node holding just a mention', () => {
    const { outline, ids } = build('a\n  b');
    const focus = outline.insertMentionNode({ parentId: idOf(ids, 'a'), index: 9 }, session('s7'));
    expect(render(outline)).toBe('a\n  b\n  @s7');
    expect(focus).toMatchObject({ offset: 'end' });
  });

  it('converting an unchanged prompt makes the line just the mention, children folded', () => {
    const { outline, ids } = build('prompt\n  detail');
    const id = idOf(ids, 'prompt');
    const snapshot = readTodayText(outline.getText(id)!);
    expect(outline.convertToMention(id, session('s9'), snapshot)).toBe(true);
    expect(render(outline)).toBe('@s9 [x]\n  detail');
  });

  it('converting a prompt edited meanwhile prefixes the mention and keeps the edit', () => {
    const { outline, ids } = build('prompt');
    const id = idOf(ids, 'prompt');
    const snapshot = readTodayText(outline.getText(id)!);
    outline.getText(id)!.insert(6, '!');
    expect(outline.convertToMention(id, session('s9'), snapshot)).toBe(true);
    expect(render(outline)).toBe('@s9 prompt!');
  });

  it('pastes multiple lines at the caret, joining the head and the tail', () => {
    const { outline, ids } = build('AB');
    outline.paste(
      { kind: 'text', nodeId: idOf(ids, 'AB'), offset: 1 },
      parseTodayPasteText('x\ny')
    );
    expect(render(outline)).toBe('Ax\nyB');
  });

  it('keeps a fenced code block as one node', () => {
    expect(
      parseTodayPasteText('intro\n```\nconst a = 1;\n  b\n```\nafter').map((f) => f.text)
    ).toEqual(['intro', '```\nconst a = 1;\n  b\n```', 'after']);
  });

  it('round-trips extracted fragments, including mentions', () => {
    const { outline, ids } = build('a\n  b\nc');
    outline.insertMention(idOf(ids, 'c'), 0, 0, session('sess-2'));
    const fragments = outline.extract([idOf(ids, 'a'), outline.getAllNodes()[2]!.id]);
    const target = openTodayOutline(new LoroDoc());
    target.paste({ kind: 'page-start' }, fragments);
    expect(render(target)).toBe('a\n  b\n@sess-2c');
  });

  it('pasting at the caret keeps mentions in the head, the pasted lines and the moved tail', () => {
    const { outline, ids } = build('AB');
    const id = idOf(ids, 'AB');
    outline.insertMention(id, 2, 0, session('tail'));
    outline.paste({ kind: 'text', nodeId: id, offset: 1 }, [
      {
        text: `x${TODAY_MENTION_CHAR}`,
        mentions: [{ start: 1, kind: 'session', id: 'p1' }],
        children: [],
      },
      { text: 'y', children: [] },
    ]);
    expect(render(outline)).toBe('Ax@p1\nyB@tail');
  });

  it('strips U+FFFC from pasted plain text', () => {
    expect(parseTodayPasteText(`a${TODAY_MENTION_CHAR}b`).map((fragment) => fragment.text)).toEqual(
      ['ab']
    );
  });

  it('merges two peers that created the same day offline into the union of roots', () => {
    const left = new LoroDoc();
    const right = new LoroDoc();
    openTodayOutline(left).paste({ kind: 'page-start' }, parseTodayPasteText('from left'));
    openTodayOutline(right).paste({ kind: 'page-start' }, parseTodayPasteText('from right'));
    left.import(right.export({ mode: 'update' }));
    expect(
      openTodayOutline(left)
        .getAllNodes()
        .map((node) => node.text)
        .sort()
    ).toEqual(['from left', 'from right']);
  });

  it('Delete at the end pulls the next node in and keeps its children', () => {
    const { outline, ids } = build('a\n  b\n    b1');
    const focus = outline.mergeWithNext(idOf(ids, 'a'));
    expect(render(outline)).toBe('ab\n  b1');
    expect(focus).toEqual({ nodeId: idOf(ids, 'a'), offset: 1 });
  });

  it('deleting nodes moves focus to the previous surviving node', () => {
    const { outline, ids } = build('a\nb\n  b1\nc');
    const focus = outline.deleteNodes([idOf(ids, 'b')]);
    expect(render(outline)).toBe('a\nc');
    expect(focus).toEqual({ nodeId: idOf(ids, 'a'), offset: 'end' });
  });

  it('ignores unknown root containers and node data keys', () => {
    const { doc, outline, ids } = build('a');
    doc.getMap('future').set('x', 1);
    outline.getText(idOf(ids, 'a'));
    doc
      .getTree('outline')
      .getNodeByID(idOf(ids, 'a') as never)
      ?.data.set('futureKey', 'v');
    doc.commit();
    expect(render(openTodayOutline(doc))).toBe('a');
  });
});

describe('Today to-dos', () => {
  const page = (lines: string) => {
    const doc = new LoroDoc();
    const outline = openTodayOutline(doc);
    outline.paste({ kind: 'page-start' }, parseTodayPasteText(lines));
    const undo = createTodayPageUndo(doc, { setTimer: () => () => {} });
    const rows = () => outline.getSnapshot().visible.map((node) => [node.text, node.todo]);
    const id = (label: string) => outline.getSnapshot().visible.find((n) => n.text === label)!.id;
    return { doc, outline, undo, rows, id };
  };

  it('cycles each node from its own state (text, to-do, done, text) as one undo step', () => {
    const { outline, undo, rows, id } = page('a\n- [ ] b\n- [x] c');
    expect(rows()).toEqual([
      ['a', undefined],
      ['b', 'todo'],
      ['c', 'done'],
    ]);
    undo.structural(() => outline.cycleTodo([id('a'), id('b'), id('c')]));
    expect(rows()).toEqual([
      ['a', 'todo'],
      ['b', 'done'],
      ['c', undefined],
    ]);
    undo.undo();
    expect(rows()).toEqual([
      ['a', undefined],
      ['b', 'todo'],
      ['c', 'done'],
    ]);
  });

  it('Enter in a to-do starts another unchecked to-do, and Enter on an empty one ends the list', () => {
    const { outline, rows, id } = page('- [x] ab');
    const created = outline.split(id('ab'), 1) as { nodeId: never };
    expect(rows()).toEqual([
      ['a', 'done'],
      ['b', 'todo'],
    ]);
    const empty = outline.split(created.nodeId, 1) as { nodeId: never };
    expect(rows().at(-1)).toEqual(['', 'todo']);
    expect(outline.enterOnEmpty(empty.nodeId)).toEqual({ nodeId: empty.nodeId, offset: 0 });
    expect(rows()).toEqual([
      ['a', 'done'],
      ['b', 'todo'],
      ['', undefined],
    ]);
  });

  it('keeps the state through copy and paste, and reaches a peer', () => {
    const { doc, outline, rows, id } = page('- [ ] a\n  - [x] a1');
    outline.paste({ kind: 'page-end' }, outline.extract([id('a')]));
    expect(rows()).toEqual([
      ['a', 'todo'],
      ['a1', 'done'],
      ['a', 'todo'],
      ['a1', 'done'],
    ]);
    const peer = new LoroDoc();
    peer.import(doc.export({ mode: 'snapshot' }));
    expect(
      openTodayOutline(peer)
        .getSnapshot()
        .visible.map((node) => node.todo)
    ).toEqual(['todo', 'done', 'todo', 'done']);
  });

  it('reads only Markdown task markers after a bullet as to-dos, and ignores an unknown stored state', () => {
    const { doc, outline, rows } = page('[ ] not a task\n- [X] done\n- [] text');
    expect(rows()).toEqual([
      ['[ ] not a task', undefined],
      ['done', 'done'],
      ['[] text', undefined],
    ]);
    const first = outline.getSnapshot().visible[0]!.id;
    doc.getTree('outline').getNodeByID(first)!.data.set('todo', 'later');
    doc.commit();
    expect(outline.getNode(first)?.todo).toBeUndefined();
  });
});

describe('Today zoomed subtree', () => {
  it("lists a folded root's descendants from depth 0, and Enter on its title adds a first child", () => {
    const doc = new LoroDoc();
    const outline = openTodayOutline(doc);
    outline.paste({ kind: 'page-start' }, parseTodayPasteText('a\n  b\n    c\n  d\ne'));
    const id = (text: string) => outline.getAllNodes().find((node) => node.text === text)!.id;
    outline.setCollapsed(id('a'), true);
    const rows = () => outline.getSubtree(id('a'))!.visible.map((node) => [node.text, node.depth]);
    expect(rows()).toEqual([
      ['b', 0],
      ['c', 1],
      ['d', 0],
    ]);
    outline.split(id('e'), 1, { intoChildren: true });
    expect(outline.getSubtree(id('e'))!.visible.map((node) => node.text)).toEqual(['']);
    outline.split(id('e'), 0, { intoChildren: true });
    expect(outline.getSubtree(id('e'))!.visible.map((node) => node.text)).toEqual(['', '']);
    expect(outline.getNode(id('e'))?.parentId).toBeNull();
    expect(outline.getSubtree('9@9' as never)).toBeNull();
  });
});

describe('Today snapshot caches', () => {
  it('match a page opened afresh after every local edit, undo, redo and merged peer edit', () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const doc = new LoroDoc();
    doc.setPeerId(1);
    const outline = openTodayOutline(doc);
    outline.paste({ kind: 'page-start' }, parseTodayPasteText('a\n  b\n    c\n  d\ne\n  f'));
    const undo = createTodayPageUndo(doc, { setTimer: () => () => {} });
    const peerDoc = new LoroDoc();
    peerDoc.setPeerId(2);
    peerDoc.import(doc.export({ mode: 'snapshot' }));
    const peer = openTodayOutline(peerDoc);
    const shape = (snapshot: ReturnType<TodayOutline['getSnapshot']>) => ({
      isEmpty: snapshot.isEmpty,
      rows: snapshot.visible.map((node) => [
        node.id,
        node.parentId,
        node.depth,
        node.text,
        JSON.stringify(node.mentions),
        node.collapsed,
        node.hasChildren,
        node.todo,
      ]),
    });
    for (let step = 0; step < 400; step += 1) {
      const all = outline.getAllNodes();
      const node = all.length ? pick(all) : undefined;
      const id = node?.id;
      const action = Math.floor(random() * 14);
      if (!id || all.length < 3) outline.paste({ kind: 'page-end' }, parseTodayPasteText('n\n  m'));
      else if (action === 0) undo.structural(() => outline.split(id, Math.floor(random() * 3)));
      else if (action === 1) undo.editText(outline.getText(id)!, (text) => text.insert(0, 'x'));
      else if (action === 2) {
        const text = outline.getText(id)!;
        if (text.length) undo.editText(text, (target) => target.delete(0, 1));
      } else if (action === 3) undo.structural(() => outline.mergeWithPrevious(id));
      else if (action === 4) undo.structural(() => outline.indent([id]));
      else if (action === 5) undo.structural(() => outline.outdent([id]));
      else if (action === 6) undo.structural(() => outline.moveDown([id]));
      else if (action === 7) outline.setCollapsed(id, !node.collapsed);
      else if (action === 8) undo.structural(() => outline.cycleTodo([id]));
      else if (action === 9 && all.length > 6) undo.structural(() => outline.deleteNodes([id]));
      else if (action === 10)
        undo.structural(() =>
          outline.paste({ kind: 'after', nodeId: id }, parseTodayPasteText('p\n  q'))
        );
      else if (action === 11) undo.undo();
      else if (action === 12) undo.redo();
      else {
        const theirs = peer.getAllNodes();
        const target = theirs.length ? pick(theirs).id : undefined;
        if (target) {
          if (random() < 0.5) peer.split(target, 1);
          else peer.indent([target]);
          peer.getText(target)?.insert(0, 'y');
          peerDoc.commit();
        }
        doc.import(peerDoc.export({ mode: 'update', from: doc.oplogVersion() }));
        peerDoc.import(doc.export({ mode: 'update', from: peerDoc.oplogVersion() }));
      }
      const fresh = openTodayOutline(doc);
      expect(shape(outline.getSnapshot()), `step ${step} action ${action}`).toEqual(
        shape(fresh.getSnapshot())
      );
      const zoomed = pick(outline.getAllNodes())?.id;
      if (zoomed) {
        expect(shape(outline.getSubtree(zoomed)!), `step ${step} subtree`).toEqual(
          shape(fresh.getSubtree(zoomed)!)
        );
      }
      fresh.dispose();
    }
  });
});

describe('Today folds', () => {
  const sync = (from: LoroDoc, to: LoroDoc) =>
    to.import(from.export({ mode: 'update', from: to.oplogVersion() }));

  it('a peer folding a node does not fold it for a viewer already on the page, who still folds it themselves', () => {
    const mine = build('a\n  a1\nb');
    const peerDoc = new LoroDoc();
    peerDoc.import(mine.doc.export({ mode: 'snapshot' }));
    const peer = openTodayOutline(peerDoc);
    peer.setCollapsed(idOf(mine.ids, 'a'), true);
    sync(peerDoc, mine.doc);
    expect(render(mine.outline)).toBe('a\n  a1\nb');
    expect(mine.outline.getSnapshot().visible.map((node) => node.text)).toEqual(['a', 'a1', 'b']);
    // Opening the page afresh inherits the stored fold.
    expect(render(openTodayOutline(mine.doc))).toBe('a [x]\n  a1\nb');
    // This viewer's own fold applies (and is stored), although the document already says folded.
    let viewChanges = 0;
    mine.outline.onViewChange(() => (viewChanges += 1));
    mine.outline.setCollapsed(idOf(mine.ids, 'a'), true);
    expect(viewChanges).toBe(1);
    expect(mine.outline.getSnapshot().visible.map((node) => node.text)).toEqual(['a', 'b']);
  });

  it('folding is not an undo step', () => {
    const doc = new LoroDoc();
    const outline = openTodayOutline(doc);
    outline.paste({ kind: 'page-start' }, parseTodayPasteText('a\n  a1'));
    const undo = createTodayPageUndo(doc, { setTimer: () => () => {} });
    const a = outline.getAllNodes()[0]!.id;
    undo.editText(outline.getText(a)!, (text) => text.insert(1, 'b'));
    undo.endGroup();
    outline.setCollapsed(a, true);
    undo.undo();
    expect(render(outline)).toBe('a [x]\n  a1');
  });
});

describe('Today page undo', () => {
  function setup(lines = '') {
    const doc = new LoroDoc();
    const outline = openTodayOutline(doc);
    if (lines) outline.paste({ kind: 'page-start' }, parseTodayPasteText(lines));
    let pending: (() => void) | undefined;
    const undo = createTodayPageUndo(doc, {
      setTimer: (callback) => {
        pending = callback;
        return () => {
          pending = undefined;
        };
      },
    });
    const restores: unknown[] = [];
    undo.onRestore((intent) => restores.push(intent));
    const fireIdle = () => pending?.();
    return { doc, outline, undo, restores, fireIdle };
  }

  const type = (ctx: ReturnType<typeof setup>, nodeId: string, offset: number, value: string) => {
    ctx.undo.setSelection({ nodeId: nodeId as never, anchor: offset, focus: offset });
    ctx.undo.editText(ctx.outline.getText(nodeId as never)!, (text) => text.insert(offset, value));
  };

  it('undoes typing and the following Enter as two separate steps', () => {
    const ctx = setup();
    ctx.undo.clear();
    const { nodeId } = ctx.outline.insertFirst() as { nodeId: string };
    ctx.undo.clear();
    type(ctx, nodeId, 0, 'a');
    type(ctx, nodeId, 1, 'b');
    ctx.undo.structural(() => ctx.outline.split(nodeId as never, 2));
    expect(ctx.outline.getAllNodes().map((n) => n.text)).toEqual(['ab', '']);
    ctx.undo.undo();
    expect(ctx.outline.getAllNodes().map((n) => n.text)).toEqual(['ab']);
    ctx.undo.undo();
    expect(ctx.outline.getAllNodes().map((n) => n.text)).toEqual(['']);
  });

  it('starts a new step after the idle timer closes the typing group', () => {
    const ctx = setup('x');
    ctx.undo.clear();
    const id = ctx.outline.getAllNodes()[0]!.id;
    type(ctx, id, 1, 'a');
    ctx.fireIdle();
    type(ctx, id, 2, 'b');
    ctx.undo.undo();
    expect(ctx.outline.getAllNodes()[0]!.text).toBe('xa');
  });

  it('restores the caret captured before the undone step', () => {
    const ctx = setup('hello');
    ctx.undo.clear();
    const id = ctx.outline.getAllNodes()[0]!.id;
    type(ctx, id, 5, '!');
    ctx.undo.undo();
    expect(ctx.restores.at(-1)).toEqual({ nodeId: id, offset: 5 });
  });

  it('undoing a deleted mention brings back the character and its mark', () => {
    const ctx = setup('ab');
    const id = ctx.outline.getAllNodes()[0]!.id;
    ctx.outline.insertMention(id, 1, 0, session('s1'));
    ctx.undo.clear();
    ctx.undo.editText(ctx.outline.getText(id)!, (text) => text.delete(1, 1));
    expect(ctx.outline.getNode(id)?.mentions).toEqual([]);
    ctx.undo.undo();
    expect(ctx.outline.getNode(id)?.mentions).toEqual([{ start: 1, kind: 'session', id: 's1' }]);
  });

  it('writes rich text with insertTodayRich as one splice', () => {
    const ctx = setup('ab');
    const id = ctx.outline.getAllNodes()[0]!.id;
    ctx.undo.editText(ctx.outline.getText(id)!, (text) =>
      insertTodayRich(text, 1, {
        text: `-${TODAY_MENTION_CHAR}-`,
        mentions: [{ start: 1, kind: 'session', id: 's2' }],
      })
    );
    expect(label(ctx.outline.getNode(id)!)).toBe('a-@s2-b');
  });

  it('does not undo system commits', () => {
    const ctx = setup('a');
    ctx.undo.clear();
    ctx.doc.getMap('today').set('v', 1);
    ctx.doc.commit({ origin: 'sys:init' });
    expect(ctx.undo.canUndo()).toBe(false);
  });
});
