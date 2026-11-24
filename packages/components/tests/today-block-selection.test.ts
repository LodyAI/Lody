import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import {
  TODAY_MENTION_CHAR,
  openTodayOutline,
  parseTodayPasteText,
  type TodayNodeView,
} from '@lody/shared';
import {
  blockRange,
  parseTodayClipboard,
  resolveBlockKey,
  serializeTodayFragments,
  todayMentionMarkdown,
  topLevelSelection,
} from '../src/components/today/editor/block-selection';

function outline(text: string) {
  const model = openTodayOutline(new LoroDoc());
  model.paste({ kind: 'page-start' }, parseTodayPasteText(text));
  const visible = model.getSnapshot().visible;
  const id = (label: string) => visible.find((node) => node.text === label)!.id;
  return { model, visible: visible as TodayNodeView[], id };
}

describe('Today block selection', () => {
  it('selects the swept rows in document order, either direction', () => {
    const { visible, id } = outline('a\n  a1\n  a2\nb\nc');
    expect(blockRange(visible, id('c'), id('a2'))).toEqual([id('a2'), id('b'), id('c')]);
  });

  it('keeps only top-level roots so a selected parent carries its children once', () => {
    const { visible, id } = outline('a\n  a1\nb');
    expect(topLevelSelection(visible, [id('a'), id('a1'), id('b')])).toEqual([id('a'), id('b')]);
  });

  it('maps block keys: Backspace deletes, Enter edits, plain characters do nothing', () => {
    const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
      key: k,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      isComposing: false,
      keyCode: 0,
      ...mods,
    });
    expect(resolveBlockKey(key('Backspace'), 'mac')).toEqual({ type: 'delete' });
    expect(resolveBlockKey(key('Enter'), 'mac')).toEqual({ type: 'edit' });
    expect(resolveBlockKey(key('x'), 'mac')).toBeNull();
    expect(resolveBlockKey(key('ArrowDown', { shiftKey: true }), 'mac')).toEqual({
      type: 'extend',
      step: 1,
    });
    expect(resolveBlockKey(key('c', { metaKey: true }), 'mac')).toBeNull();
    expect(resolveBlockKey(key('Escape'), 'mac')).toEqual({ type: 'clear' });
    expect(resolveBlockKey(key('z', { metaKey: true }), 'mac')).toEqual({ type: 'undo' });
    expect(resolveBlockKey(key('z', { metaKey: true, shiftKey: true }), 'mac')).toEqual({
      type: 'redo',
    });
    expect(resolveBlockKey(key('y', { ctrlKey: true }), 'other')).toEqual({ type: 'redo' });
    expect(resolveBlockKey(key('y', { metaKey: true }), 'mac')).toBeNull();
  });

  it('copies blocks as indented text with mention links plus a payload that pastes back exactly', () => {
    const { model, id } = outline('a\n  b\nc');
    model.insertMention(id('c'), 1, 0, { kind: 'session', id: 'sess-1' });
    const fragments = model.extract([id('a'), id('c')]);
    const plain = serializeTodayFragments(fragments, (mention) =>
      todayMentionMarkdown(mention, { workspaceId: 'ws1', title: 'Fix [login]' })
    );
    expect(plain).toBe('- a\n  - b\n- c[@Fix \\[login\\]](lody://session/sess-1?workspace=ws1)');
    const parsed = parseTodayClipboard({ json: JSON.stringify({ v: 2, fragments }), text: plain });
    expect(parsed).toEqual(fragments);
    const target = openTodayOutline(new LoroDoc());
    target.paste({ kind: 'page-start' }, parsed!);
    expect(target.getAllNodes()[2]!.mentions).toEqual([
      { start: 1, kind: 'session', id: 'sess-1' },
    ]);
  });

  it('turns pasted same-workspace conversation links into mentions, bare or Markdown', async () => {
    const { linkifyTodayText } = await import('../src/components/today/editor/block-selection');
    const { readPastedSessionLink } = await import('../src/lib/session-deep-link');
    const resolve = (link: string) => readPastedSessionLink(link, 'ws1')?.sessionId ?? null;
    expect(
      linkifyTodayText(
        'see [@Fix \\[x\\]](lody://session/s1?workspace=ws1) and lody://session/s2. Not lody://session/s3?workspace=other',
        resolve
      )
    ).toEqual({
      text: `see ${TODAY_MENTION_CHAR} and ${TODAY_MENTION_CHAR}. Not lody://session/s3?workspace=other`,
      mentions: [
        { start: 4, kind: 'session', id: 's1' },
        { start: 10, kind: 'session', id: 's2' },
      ],
    });
  });
});

describe('Today to-dos in the clipboard and on block keys', () => {
  it('copies to-dos as Markdown tasks and pastes both forms back with their state', () => {
    const { model, id } = outline('- [ ] a\n  - [x] a1\nb');
    const fragments = model.extract([id('a'), id('b')]);
    const text = serializeTodayFragments(fragments, () => '');
    expect(text).toBe('- [ ] a\n  - [x] a1\n- b');
    const state = (parsed: ReturnType<typeof parseTodayClipboard>) =>
      parsed!.map((fragment) => [fragment.todo, fragment.children.map((child) => child.todo)]);
    expect(state(parseTodayClipboard({ text }))).toEqual([
      ['todo', ['done']],
      [undefined, []],
    ]);
    expect(state(parseTodayClipboard({ json: JSON.stringify({ v: 2, fragments }) }))).toEqual([
      ['todo', ['done']],
      [undefined, []],
    ]);
  });

  it('Mod+Enter cycles the to-do state; plain Enter still edits', () => {
    const key = (mods: Partial<KeyboardEvent>) => ({
      key: 'Enter',
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      isComposing: false,
      keyCode: 13,
      ...mods,
    });
    expect(resolveBlockKey(key({ metaKey: true }), 'mac')).toEqual({ type: 'cycle-todo' });
    expect(resolveBlockKey(key({ ctrlKey: true }), 'other')).toEqual({ type: 'cycle-todo' });
    expect(resolveBlockKey(key({ metaKey: true, isComposing: true }), 'mac')).toBeNull();
    expect(resolveBlockKey(key({}), 'mac')).toEqual({ type: 'edit' });
  });
});

describe('Today convert-to-task prompt', () => {
  it('is the node text followed by its children as an indented list, folded ones included', async () => {
    const { buildConvertPrompt } = await import('../src/components/today/editor/block-selection');
    const { model, id } = outline('Refactor sync\n  keep it deterministic\n    no sleeps\nother');
    model.setCollapsed(id('Refactor sync'), true);
    model.insertMentionNode(
      { parentId: id('Refactor sync'), index: 9 },
      { kind: 'session', id: 'sess-7' }
    );
    model.insertMention(id('Refactor sync'), 0, 0, { kind: 'session', id: 'sess-1' });
    const [fragment] = model.extract([id('Refactor sync')]);
    const link = (mention: { id: string }) => `[@${mention.id}](lody://session/${mention.id})`;
    expect(buildConvertPrompt(fragment!, link)).toBe(
      '[@sess-1](lody://session/sess-1)Refactor sync\n- keep it deterministic\n  - no sleeps\n- [@sess-7](lody://session/sess-7)'
    );
  });
});

describe('Today Mod+A on a block selection', () => {
  it('climbs one ancestor per press, to the common ancestor of several, then the whole day, then stops', async () => {
    const { escalateSelection } = await import('../src/components/today/editor/block-selection');
    const { visible, id } = outline('a\n  b\n    c\n    d\n  e\nf');
    expect(escalateSelection(visible, [id('c')])).toEqual([id('b')]);
    expect(escalateSelection(visible, [id('b')])).toEqual([id('a')]);
    expect(escalateSelection(visible, [id('c'), id('e')])).toEqual([id('a')]);
    expect(escalateSelection(visible, [id('a')])).toEqual([id('a'), id('f')]);
    expect(escalateSelection(visible, [id('c'), id('f')])).toEqual([id('a'), id('f')]);
    expect(escalateSelection(visible, [id('a'), id('f')])).toBeNull();
  });
});

describe('Today convert-to-task prompt with ancestors', () => {
  it('nests the node and its subtree under its parents, outermost first', async () => {
    const { buildConvertPrompt } = await import('../src/components/today/editor/block-selection');
    const { model, id } = outline(
      'Launch\n  Docs\n    Write the guide\n      cover install\n    other'
    );
    const [fragment] = model.extract([id('Write the guide')]);
    const ancestors = [id('Launch'), id('Docs')].map((nodeId) => {
      const node = model.getNode(nodeId)!;
      return { text: node.text, mentions: [...node.mentions] };
    });
    expect(buildConvertPrompt(fragment!, () => '', ancestors)).toBe(
      '- Launch\n  - Docs\n    - Write the guide\n      - cover install'
    );
    expect(buildConvertPrompt(fragment!, () => '')).toBe('Write the guide\n- cover install');
  });
});

describe('Today block selection covers subtrees', () => {
  it('shows every descendant of a selected parent as selected, since it is deleted with it', async () => {
    const { selectionCovers } = await import('../src/components/today/editor/block-selection');
    const { visible, id } = outline('p\n  c1\n  c2\n  c3\nq');
    const range = blockRange(visible, id('c2'), id('p'));
    expect(range).toEqual([id('p'), id('c1'), id('c2')]);
    const covered = selectionCovers(visible, range);
    expect([...covered].sort()).toEqual([id('p'), id('c1'), id('c2'), id('c3')].sort());
    expect(covered.has(id('q'))).toBe(false);
  });
});

describe('Today block selection keyboard extension', () => {
  it('extends past the children a selected parent already covers, and stops at the day edge', async () => {
    const { extendFocus } = await import('../src/components/today/editor/block-selection');
    const { visible, id } = outline('p\n  c1\n  c2\ns');
    expect(extendFocus(visible, id('p'), id('p'), 1)).toBe(id('s'));
    expect(extendFocus(visible, id('c2'), id('c2'), -1)).toBe(id('c1'));
    expect(extendFocus(visible, id('s'), id('p'), 1)).toBe(id('c1'));
    expect(extendFocus(visible, id('s'), id('s'), 1)).toBeNull();
    expect(extendFocus(visible, id('p'), id('p'), -1)).toBeNull();
  });
});
