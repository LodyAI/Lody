// @vitest-environment jsdom
import { $getRoot, $getSelection, $isRangeSelection, createEditor } from 'lexical';
import { registerPlainText } from '@lexical/plain-text';
import { LoroDoc } from 'loro-crdt';
import { afterEach, describe, expect, it } from 'vitest';
import { createTodayPageUndo, openTodayOutline } from '@lody/shared';
import { bindLoroText } from '../src/components/today/editor/loro-lexical-binding';
import { resolveOutlineKey } from '../src/components/today/editor/outline-keys';
import { safeTextDiff, transformOffset } from '../src/components/today/editor/text-diff';
import { $readSelectionOffsets, $setSelectionOffsets } from '../src/ui/mention/composer-document';

describe('Today text diff', () => {
  it('never splits a surrogate pair', () => {
    expect(safeTextDiff('a😀b', 'a😁b')).toEqual({ start: 1, deleteCount: 2, insert: '😁' });
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
      onError: (error) => {
        throw error;
      },
    });
    editor.setRootElement(root);
    cleanups.push(registerPlainText(editor), () => root.remove());
    const binding = bindLoroText({ editor, text, undo, isComposing: () => false });
    cleanups.push(binding.dispose);
    return { doc, text, editor, undo };
  }

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
  it('turns an `@query` node into a session node, and one undo brings the text back', async () => {
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
    expect(controller.getPicker()?.query).toBe('fix');
    controller.pickerItems = ['sess-1'];
    controller.acceptPicker('sess-1');
    const [node] = store.getSnapshot().visible;
    expect(node).toMatchObject({ kind: 'session', sessionId: 'sess-1' });
    store.undo.undo();
    expect(store.getSnapshot().visible[0]).toMatchObject({ kind: 'text', text: '@fix' });
    controller.dispose();
    root.remove();
  });
});
