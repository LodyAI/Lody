import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import {
  openTodayOutline,
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

/** Outline as indented text: two spaces per level, `[x]` for collapsed, `@id` for sessions. */
function render(outline: TodayOutline): string {
  return outline
    .getAllNodes()
    .map((node) => {
      const label = node.sessionId ? `@${node.sessionId}` : node.text;
      return `${'  '.repeat(node.depth)}${label}${node.collapsed ? ' [x]' : ''}`;
    })
    .join('\n');
}

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

  it('merges into the previous visible node and re-parents children', () => {
    const { outline, ids } = build('a\nb\n  b1');
    const focus = outline.mergeWithPrevious(idOf(ids, 'b'));
    expect(render(outline)).toBe('ab\n  b1');
    expect(focus).toEqual({ nodeId: idOf(ids, 'a'), offset: 1 });
  });

  it('block-selects a previous session node instead of merging into it', () => {
    const { outline, ids } = build('s\nb');
    outline.convertToSession(idOf(ids, 's'), 'sess-1');
    const focus = outline.mergeWithPrevious(idOf(ids, 'b'));
    expect(focus).toEqual({ blockSelect: [idOf(ids, 's')] });
    expect(render(outline)).toBe('@sess-1\nb');
  });

  it('moves a subtree among siblings and rejects a move into its own descendant', () => {
    const { outline, ids } = build('a\n  a1\nb');
    outline.moveDown([idOf(ids, 'a')]);
    expect(render(outline)).toBe('b\na\n  a1');
    const before = render(outline);
    expect(outline.moveTo([idOf(ids, 'a')], { parentId: idOf(ids, 'a1'), index: 0 })).toBe(false);
    expect(render(outline)).toBe(before);
  });

  it('converting to a session keeps children folded under it', () => {
    const { outline, ids } = build('prompt\n  detail');
    outline.convertToSession(idOf(ids, 'prompt'), 'sess-9', { collapseChildren: true });
    expect(render(outline)).toBe('@sess-9 [x]\n  detail');
    expect(outline.getSnapshot().visible.map((node) => node.sessionId ?? node.text)).toEqual([
      'sess-9',
    ]);
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

  it('round-trips extracted fragments, including sessions', () => {
    const { outline, ids } = build('a\n  b\nc');
    outline.convertToSession(idOf(ids, 'c'), 'sess-2');
    const fragments = outline.extract([idOf(ids, 'a'), idOf(ids, 'c')]);
    const target = openTodayOutline(new LoroDoc());
    target.paste({ kind: 'page-start' }, fragments);
    expect(render(target)).toBe('a\n  b\n@sess-2');
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
