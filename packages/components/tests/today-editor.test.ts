// @vitest-environment jsdom
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setCompositionKey,
  createEditor,
} from 'lexical';
import { registerPlainText } from '@lexical/plain-text';
import { LoroDoc } from 'loro-crdt';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TODAY_MENTION_CHAR as M,
  createTodayPageUndo,
  openTodayOutline,
  readTodayText,
} from '@lody/shared';
import { bindLoroText } from '../src/components/today/editor/loro-lexical-binding';
import { resolveOutlineKey } from '../src/components/today/editor/outline-keys';
import {
  safeRichDiff,
  safeTextDiff,
  transformOffset,
} from '../src/components/today/editor/text-diff';
import {
  $readComposerValue,
  $readSelectionOffsets,
  $setSelectionOffsets,
  $writeComposerValue,
} from '../src/ui/mention/composer-document';
import { MentionDecoratorNode } from '../src/ui/mention/mention-node';

describe('Today text diff', () => {
  it('never splits a surrogate pair', () => {
    expect(safeTextDiff('a😀b', 'a😁b')).toEqual({ start: 1, deleteCount: 2, insert: '😁' });
  });

  it('tells two adjacent mentions apart by their conversation, not just their character', () => {
    const a = { start: 0, kind: 'session', id: 'A' };
    const b = { start: 1, kind: 'session', id: 'B' };
    expect(
      safeRichDiff(
        { text: `${M}${M}`, mentions: [a, b] },
        { text: M, mentions: [{ ...b, start: 0 }] }
      )
    ).toEqual({ start: 0, deleteCount: 1, insert: { text: '', mentions: [] } });
    expect(
      safeRichDiff(
        { text: `x${M}`, mentions: [{ ...a, start: 1 }] },
        { text: `x${M}`, mentions: [{ ...b, start: 1 }] }
      )
    ).toEqual({
      start: 1,
      deleteCount: 1,
      insert: { text: M, mentions: [{ start: 0, kind: 'session', id: 'B' }] },
    });
  });

  it('keeps a caret before text a peer inserts at the caret, and after text inserted before it', () => {
    expect(transformOffset(3, [{ retain: 3 }, { insert: 'xy' }])).toBe(3);
    expect(transformOffset(3, [{ retain: 1 }, { insert: 'xy' }])).toBe(5);
    expect(transformOffset(3, [{ retain: 1 }, { delete: 4 }])).toBe(1);
  });
});

describe('Today outline keys', () => {
  const base = {
    composing: false,
    offset: 0,
    length: 3,
    hasSelection: false,
    onFirstLine: true,
    onLastLine: true,
  };
  const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => ({
    key: k,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 0,
    ...mods,
  });

  it('ignores every outline key while an IME composition is confirming', () => {
    expect(resolveOutlineKey(key('Enter', { isComposing: true }), base, 'mac')).toBeNull();
    expect(resolveOutlineKey(key('Enter', { keyCode: 229 }), base, 'mac')).toBeNull();
    expect(resolveOutlineKey(key('Process'), base, 'mac')).toBeNull();
  });

  it('maps Enter, Shift+Enter, Tab and boundary Backspace/Delete', () => {
    expect(resolveOutlineKey(key('Enter'), { ...base, offset: 2 }, 'mac')).toEqual({
      type: 'split',
    });
    expect(resolveOutlineKey(key('Enter'), { ...base, length: 0 }, 'mac')).toEqual({
      type: 'enter-empty',
    });
    expect(resolveOutlineKey(key('Enter', { shiftKey: true }), base, 'mac')).toBeNull();
    expect(resolveOutlineKey(key('Tab', { shiftKey: true }), base, 'mac')).toEqual({
      type: 'outdent',
    });
    expect(resolveOutlineKey(key('Backspace'), base, 'mac')).toEqual({ type: 'merge-previous' });
    expect(resolveOutlineKey(key('Backspace'), { ...base, offset: 1 }, 'mac')).toBeNull();
    expect(resolveOutlineKey(key('Delete'), { ...base, offset: 3 }, 'mac')).toEqual({
      type: 'merge-next',
    });
  });

  it('moves nodes with Mod+Shift+arrows, folds with Mod+arrows, crosses nodes only at line edges', () => {
    expect(
      resolveOutlineKey(key('ArrowUp', { metaKey: true, shiftKey: true }), base, 'mac')
    ).toEqual({ type: 'move-up' });
    expect(resolveOutlineKey(key('ArrowDown', { ctrlKey: true }), base, 'other')).toEqual({
      type: 'expand',
    });
    expect(resolveOutlineKey(key('ArrowUp', { metaKey: true }), base, 'mac')).toEqual({
      type: 'collapse',
    });
    expect(resolveOutlineKey(key('ArrowDown'), { ...base, onLastLine: false }, 'mac')).toBeNull();
    expect(resolveOutlineKey(key('ArrowDown'), base, 'mac')).toEqual({ type: 'focus-next' });
    expect(resolveOutlineKey(key('Escape'), base, 'mac')).toEqual({ type: 'block-select' });
  });
});

describe('Today LoroText binding', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function setup(initial: string) {
    const doc = new LoroDoc();
    const outline = openTodayOutline(doc);
    const focus = outline.insertFirst(initial) as { nodeId: never };
    const text = outline.getText(focus.nodeId)!;
    const undo = createTodayPageUndo(doc, { setTimer: () => () => {} });
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    const editor = createEditor({
      namespace: 'today-test',
      nodes: [MentionDecoratorNode],
      onError: (error) => {
        throw error;
      },
    });
    editor.setRootElement(root);
    cleanups.push(registerPlainText(editor), () => root.remove());
    const binding = bindLoroText({ editor, text, undo, isComposing: () => false });
    cleanups.push(binding.dispose);
    return { doc, outline, nodeId: focus.nodeId, text, editor, undo };
  }

  const editorMentions = (editor: ReturnType<typeof setup>['editor']) =>
    editor
      .getEditorState()
      .read(() =>
        $readComposerValue().mentions.map((mention) => [mention.start, mention.kind, mention.value])
      );

  it('shows mentions as chips and deletes exactly the one removed when two sit side by side', () => {
    const { outline, nodeId, text, editor } = setup('x');
    outline.insertMention(nodeId, 1, 0, { kind: 'session', id: 'A' });
    outline.insertMention(nodeId, 2, 0, { kind: 'session', id: 'B' });
    expect(editorMentions(editor)).toEqual([
      [1, 'session', 'A'],
      [2, 'session', 'B'],
    ]);
    editor.update(
      () => {
        $setSelectionOffsets(1, 2);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.removeText();
      },
      { discrete: true }
    );
    expect(readTodayText(text).mentions).toEqual([{ start: 1, kind: 'session', id: 'B' }]);
  });

  it('writes a mention replaced in place, although the text is unchanged', () => {
    const { outline, nodeId, text, editor } = setup('x');
    outline.insertMention(nodeId, 1, 0, { kind: 'session', id: 'A' });
    editor.update(
      () => $writeComposerValue(`x${M}`, [{ start: 1, end: 2, value: 'B', kind: 'session' }]),
      { discrete: true }
    );
    expect(readTodayText(text)).toEqual({
      text: `x${M}`,
      mentions: [{ start: 1, kind: 'session', id: 'B' }],
    });
    expect(editorMentions(editor)).toEqual([[1, 'session', 'B']]);
  });

  it('writes local typing into the node text as one undoable step', () => {
    const { text, editor, undo } = setup('ab');
    editor.update(() => $setSelectionOffsets(2), { discrete: true });
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText('c');
      },
      { discrete: true }
    );
    expect(text.toString()).toBe('abc');
    undo.undo();
    expect(text.toString()).toBe('ab');
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('ab');
  });

  it('applies a peer’s edit before the caret and keeps the caret on the same character', () => {
    const { doc, text, editor } = setup('hello');
    editor.update(() => $setSelectionOffsets(5), { discrete: true });
    const peer = new LoroDoc();
    peer.import(doc.export({ mode: 'snapshot' }));
    const peerText = peer.getContainerById(text.id) as typeof text;
    peerText.insert(0, '>> ');
    peer.commit();
    doc.import(peer.export({ mode: 'update', from: doc.oplogVersion() }));
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('>> hello');
    expect(editor.getEditorState().read(() => $readSelectionOffsets())).toEqual({
      start: 8,
      end: 8,
    });
  });
});

describe('Today session picker', () => {
  it('replaces the `@query` with a mention, and one undo brings the text back', async () => {
    const { createTodayPageStoreCache } = await import('../src/providers/today-page-store-cache');
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { getTodayDocId } = await import('@lody/shared');
    const cache = createTodayPageStoreCache({
      releaseDelayMs: 1000,
      idleCap: 2,
      setTimer: () => () => {},
      repo: {
        openDoc: async () => ({ doc: new LoroDoc(), joinRoom: async () => null }),
        isRegistered: async () => true,
        upsertDocMeta: async () => {},
        unloadDoc: async () => {},
        observeDocs: () => ({ docIds: [], unsubscribe: () => {} }),
      },
    });
    const store = await cache.acquire(getTodayDocId('me', '2026-11-20' as never));
    const controller = new TodayEditorController(cache);
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    controller.startPage(store);
    controller.attachRoot(root);
    controller.editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText('@fix');
      },
      { discrete: true }
    );
    expect(store.getSnapshot().visible.map((n) => n.text)).toEqual(['@fix']);
    // While an IME composes (a full-width ＠ typed through it), the menu waits.
    controller.editor.update(() => $setCompositionKey($getRoot().getFirstDescendant()!.getKey()), {
      discrete: true,
    });
    controller.editor.update(() => $getRoot().getFirstDescendant()!.markDirty(), {
      discrete: true,
    });
    expect(controller.getPicker()).toBeNull();
    controller.editor.update(() => $setCompositionKey(null), { discrete: true });
    controller.editor.update(() => $getRoot().getFirstDescendant()!.markDirty(), {
      discrete: true,
    });
    expect(controller.getPicker()?.query).toBe('fix');
    controller.pickerItems = ['sess-1'];
    controller.acceptPicker('sess-1');
    const [node] = store.getSnapshot().visible;
    expect(node?.mentions).toEqual([{ start: 0, kind: 'session', id: 'sess-1' }]);
    store.undo.undo();
    expect(store.getSnapshot().visible[0]).toMatchObject({ text: '@fix', mentions: [] });
    controller.dispose();
    root.remove();
  });
});

describe('Today LoroText binding under IME', () => {
  it('shows a peer edit made during a composition that ends without change, and later typing lands where typed', async () => {
    const doc = new LoroDoc();
    const outline = openTodayOutline(doc);
    const focus = outline.insertFirst('abc') as { nodeId: never };
    const text = outline.getText(focus.nodeId)!;
    const undo = createTodayPageUndo(doc, { setTimer: () => () => {} });
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    const editor = createEditor({
      namespace: 'today-ime',
      onError: (error) => {
        throw error;
      },
    });
    editor.setRootElement(root);
    const stopPlain = registerPlainText(editor);
    let composing = false;
    const binding = bindLoroText({ editor, text, undo, isComposing: () => composing });
    const peer = new LoroDoc();
    peer.import(doc.export({ mode: 'snapshot' }));
    const peerText = peer.getContainerById(text.id) as typeof text;
    const sync = () => doc.import(peer.export({ mode: 'update', from: doc.oplogVersion() }));

    composing = true;
    peerText.insert(0, 'X');
    peer.commit();
    sync();
    composing = false;
    root.dispatchEvent(new Event('compositionend'));
    await Promise.resolve();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('Xabc');

    peerText.insert(4, 'Y');
    peer.commit();
    sync();
    editor.update(() => $setSelectionOffsets(1), { discrete: true });
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText('!');
      },
      { discrete: true }
    );
    expect(text.toString()).toBe('X!abcY');
    binding.dispose();
    stopPlain();
    root.remove();
  });
});

describe('Today outline keys read the live caret', () => {
  it('merges on Backspace right after the caret moved to the start, before Lexical saw it', async () => {
    const { createTodayPageStoreCache } = await import('../src/providers/today-page-store-cache');
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { getTodayDocId, parseTodayPasteText } = await import('@lody/shared');
    const cache = createTodayPageStoreCache({
      releaseDelayMs: 1000,
      idleCap: 2,
      setTimer: () => () => {},
      repo: {
        openDoc: async () => ({ doc: new LoroDoc(), joinRoom: async () => null }),
        isRegistered: async () => true,
        upsertDocMeta: async () => {},
        unloadDoc: async () => {},
        observeDocs: () => ({ docIds: [], unsubscribe: () => {} }),
      },
    });
    const store = await cache.acquire(getTodayDocId('me', '2026-11-21' as never));
    store.outline.paste({ kind: 'page-start' }, parseTodayPasteText('one\ntwo'));
    const [, second] = store.getSnapshot().visible;
    const controller = new TodayEditorController(cache);
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    controller.activate(store, second!.id, 'end');
    controller.attachRoot(root);
    // The browser moved the caret (Home) but Lexical has not synced it yet.
    const textNode = root.querySelector('span')?.firstChild ?? root.firstChild!;
    window.getSelection()!.collapse(textNode, 0);
    root.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().visible.map((node) => node.text)).toEqual(['onetwo']);
    controller.dispose();
    root.remove();
  });
});

describe('Today Shift+Up/Down while editing', () => {
  const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => ({
    key: k,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 0,
    ...mods,
  });
  const caret = (anchor: number, focus: number, length: number, first = true, last = true) => ({
    offset: Math.min(anchor, focus),
    anchor,
    focus,
    length,
    hasSelection: anchor !== focus,
    onFirstLine: first,
    onLastLine: last,
  });

  it('first selects to the node edge, and only a further press selects the node', () => {
    expect(resolveOutlineKey(key('ArrowUp', { shiftKey: true }), caret(4, 4, 9), 'mac')).toEqual({
      type: 'extend-text',
      anchor: 4,
      focus: 0,
    });
    expect(resolveOutlineKey(key('ArrowUp', { shiftKey: true }), caret(4, 0, 9), 'mac')).toEqual({
      type: 'select-from-text',
    });
    expect(resolveOutlineKey(key('ArrowDown', { shiftKey: true }), caret(2, 5, 9), 'mac')).toEqual({
      type: 'extend-text',
      anchor: 2,
      focus: 9,
    });
    expect(resolveOutlineKey(key('ArrowDown', { shiftKey: true }), caret(0, 0, 0), 'mac')).toEqual({
      type: 'select-from-text',
    });
  });

  it('leaves Shift+arrows inside a node to the browser away from its first/last line', () => {
    expect(
      resolveOutlineKey(key('ArrowUp', { shiftKey: true }), caret(20, 20, 40, false, false), 'mac')
    ).toBeNull();
    expect(
      resolveOutlineKey(
        key('ArrowUp', { shiftKey: true, isComposing: true }),
        caret(4, 0, 9),
        'mac'
      )
    ).toBeNull();
  });

  it('keeps Mod+Shift for moving nodes and gives Option+Shift back to the Mac', () => {
    expect(
      resolveOutlineKey(key('ArrowUp', { shiftKey: true, metaKey: true }), caret(0, 0, 3), 'mac')
    ).toEqual({ type: 'move-up' });
    expect(
      resolveOutlineKey(key('ArrowUp', { shiftKey: true, altKey: true }), caret(0, 0, 3), 'mac')
    ).toBeNull();
    expect(
      resolveOutlineKey(key('ArrowUp', { shiftKey: true, altKey: true }), caret(0, 0, 3), 'other')
    ).toEqual({ type: 'move-up' });
  });

  it('Esc after a Shift+Up selection returns to the text selection it came from', async () => {
    const { createTodayPageStoreCache } = await import('../src/providers/today-page-store-cache');
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { getTodayDocId, parseTodayPasteText } = await import('@lody/shared');
    const cache = createTodayPageStoreCache({
      releaseDelayMs: 1000,
      idleCap: 2,
      setTimer: () => () => {},
      repo: {
        openDoc: async () => ({ doc: new LoroDoc(), joinRoom: async () => null }),
        isRegistered: async () => true,
        upsertDocMeta: async () => {},
        unloadDoc: async () => {},
        observeDocs: () => ({ docIds: [], unsubscribe: () => {} }),
      },
    });
    const store = await cache.acquire(getTodayDocId('me', '2026-11-22' as never));
    store.outline.paste({ kind: 'page-start' }, parseTodayPasteText('one\nhello'));
    const [, second] = store.getSnapshot().visible;
    const controller = new TodayEditorController(cache);
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    controller.activate(store, second!.id, 'end');
    controller.attachRoot(root);
    const textNode = () => root.querySelector('span')?.firstChild ?? root.firstChild!;
    const press = async () => {
      root.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    };
    window.getSelection()!.setBaseAndExtent(textNode(), 3, textNode(), 1);
    await press();
    expect(controller.editor.read(() => $readSelectionOffsets())).toEqual({ start: 0, end: 3 });
    expect(controller.getBlockSelection()).toBeNull();
    window.getSelection()!.setBaseAndExtent(textNode(), 3, textNode(), 0);
    await press();
    expect(controller.getBlockSelection()?.ids).toEqual([second!.id]);
    controller.onBlockKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(controller.getBlockSelection()).toBeNull();
    expect(controller.isActive(store, second!.id)).toBe(true);
    controller.attachRoot(root);
    expect(controller.editor.read(() => $readSelectionOffsets())).toEqual({ start: 0, end: 3 });
    controller.dispose();
    root.remove();
  });
});
