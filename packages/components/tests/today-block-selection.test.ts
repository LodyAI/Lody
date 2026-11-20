import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { openTodayOutline, parseTodayPasteText, type TodayNodeView } from '@lody/shared';
import {
  blockRange,
  parseTodayClipboard,
  resolveBlockKey,
  serializeTodayFragments,
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
    const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
      ({ key: k, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false, keyCode: 0, ...mods });
    expect(resolveBlockKey(key('Backspace'), 'mac')).toEqual({ type: 'delete' });
    expect(resolveBlockKey(key('Enter'), 'mac')).toEqual({ type: 'edit' });
    expect(resolveBlockKey(key('x'), 'mac')).toBeNull();
    expect(resolveBlockKey(key('ArrowDown', { shiftKey: true }), 'mac')).toEqual({ type: 'extend', step: 1 });
    expect(resolveBlockKey(key('c', { metaKey: true }), 'mac')).toBeNull();
    expect(resolveBlockKey(key('Escape'), 'mac')).toEqual({ type: 'clear' });
  });

  it('copies blocks as indented text plus a structured payload that pastes back exactly', () => {
    const { model, id } = outline('a\n  b\nc');
    model.convertToSession(id('c'), 'sess-1');
    const fragments = model.extract([id('a'), id('c')]);
    const plain = serializeTodayFragments(fragments, (sessionId) => `lody://session/${sessionId}`);
    expect(plain).toBe('- a\n  - b\n- lody://session/sess-1');
    const parsed = parseTodayClipboard({ json: JSON.stringify({ v: 1, fragments }), text: plain });
    expect(parsed).toEqual(fragments);
    expect(parseTodayClipboard({ text: plain })?.map((f) => f.text)).toEqual(['a', 'lody://session/sess-1']);
  });
});
