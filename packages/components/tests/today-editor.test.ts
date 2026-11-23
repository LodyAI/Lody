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
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  TODAY_MENTION_CHAR as M,
  createTodayPageUndo,
  openTodayOutline,
  readTodayText,
} from '@lody/shared';
import { bindLoroText } from '../src/components/today/editor/loro-lexical-binding';
import { TodayDaySection } from '../src/components/today/today-day-section';
import type { TodayPageStoreCache } from '../src/providers/today-page-store-cache';
import { createTodayPageStore } from '../src/lib/today/today-page-store';
import { createTestI18n, withTestI18n } from './test-i18n';
import { resolveMentionKey } from '../src/components/today/editor/mention-keys';
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

  it("⌥→/⌥← zoom elsewhere, but on the Mac only from the node's end or start (word moves stay)", () => {
    const alt = { altKey: true };
    expect(resolveOutlineKey(key('ArrowRight', alt), { ...base, offset: 1 }, 'other')).toEqual({
      type: 'zoom-in',
    });
    expect(resolveOutlineKey(key('ArrowRight', alt), { ...base, offset: 1 }, 'mac')).toBeNull();
    expect(resolveOutlineKey(key('ArrowRight', alt), { ...base, offset: 3 }, 'mac')).toEqual({
      type: 'zoom-in',
    });
    expect(resolveOutlineKey(key('ArrowLeft', alt), { ...base, offset: 0 }, 'mac')).toEqual({
      type: 'zoom-out',
    });
    expect(resolveOutlineKey(key('ArrowLeft', alt), { ...base, offset: 2 }, 'mac')).toBeNull();
  });

  it('Mod+A leaves a partial text selection to the editor, then selects the node', () => {
    const mod = { metaKey: true };
    expect(resolveOutlineKey(key('a', mod), { ...base, offset: 1 }, 'mac')).toBeNull();
    expect(
      resolveOutlineKey(
        key('a', mod),
        { ...base, offset: 0, anchor: 0, focus: 3, hasSelection: true },
        'mac'
      )
    ).toEqual({ type: 'select-from-text' });
    expect(resolveOutlineKey(key('a', mod), { ...base, length: 0 }, 'mac')).toEqual({
      type: 'select-from-text',
    });
    expect(
      resolveOutlineKey(key('a', { ctrlKey: true }), { ...base, length: 0 }, 'mac')
    ).toBeNull();
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
  it('replaces an `@query` mid-sentence with a mention in place, and one undo brings it back', async () => {
    const { createTodayPageStoreCache } = await import('../src/providers/today-page-store-cache');
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { getTodayDocId } = await import('@lody/shared');
    const cache = createTodayPageStoreCache({
      releaseDelayMs: 1000,
      idleCap: 2,
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
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
        if ($isRangeSelection(selection)) selection.insertText('ask @fix later');
      },
      { discrete: true }
    );
    expect(store.getSnapshot().visible.map((n) => n.text)).toEqual(['ask @fix later']);
    // The caret right after `@fix`, mid-sentence.
    controller.editor.update(() => $setSelectionOffsets(8), { discrete: true });
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
    expect(controller.getPicker()).toMatchObject({ query: 'fix', start: 4 });
    controller.pickerItems = [{ kind: 'session', id: 'sess-1' }];
    controller.acceptPicker({ kind: 'session', id: 'sess-1' });
    const [node] = store.getSnapshot().visible;
    expect(node).toMatchObject({
      text: `ask ${M} later`,
      mentions: [{ start: 4, kind: 'session', id: 'sess-1' }],
    });
    store.undo.undo();
    expect(store.getSnapshot().visible[0]).toMatchObject({ text: 'ask @fix later', mentions: [] });
    controller.dispose();
    root.remove();
  });
});

describe('Today @ picker with people', () => {
  it('lists people with avatars beside conversations, and a picked person becomes a chip that opens their Today', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { TodayEditorContext } =
      await import('../src/components/today/editor/today-editor-context');
    const { TodayMembersContext } = await import('../src/components/today/today-members');
    const { TodaySessionPicker } = await import('../src/components/today/today-mention-picker');
    const { parseTodayPasteText } = await import('@lody/shared');
    const store = createTodayPageStore({
      docId: 'today-u1-2026-11-17',
      doc: new LoroDoc(),
      registered: true,
      join: async () => ({ room: { unsubscribe: () => {} }, synced: Promise.resolve() }),
      register: async () => {},
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
    });
    store.outline.paste({ kind: 'page-start' }, parseTodayPasteText('ask'));
    const cache = {
      peek: () => store,
      acquire: async () => store,
      releaseRef: () => {},
    } as unknown as TodayPageStoreCache;
    const controller = new TodayEditorController(cache);
    const opened: string[] = [];
    controller.onOpenMember = (userId) => opened.push(userId);
    const members = new Map([
      ['u1', { userId: 'u1', name: 'Me' }],
      ['u2', { userId: 'u2', name: 'Alice Wong', image: 'https://example.invalid/a.png' }],
      ['u3', { userId: 'u3', name: 'Bob' }],
    ]);
    const sessions = [
      {
        slug: 's',
        sessionId: 'sess-al' as never,
        title: 'Align the release',
        activityAt: 1,
        projectKey: 'chat' as const,
      },
    ];
    const surface = document.createElement('div');
    document.body.append(surface);
    const root = createRoot(surface);
    await act(async () =>
      root.render(
        withTestI18n(
          createElement(
            TodayEditorContext.Provider,
            { value: controller },
            createElement(
              TodayMembersContext.Provider,
              { value: members },
              createElement(TodayDaySection, {
                cache,
                userId: 'u1',
                date: '2026-11-17' as never,
                today: '2026-11-17' as never,
                isTop: true,
                onEmptyChange: () => {},
              }),
              createElement(TodaySessionPicker, { items: sessions })
            )
          ),
          createTestI18n()
        )
      )
    );
    const id = store.getSnapshot().visible[0]!.id;
    await act(async () => controller.activate(store, id, 'end'));
    await act(async () =>
      controller.editor.update(
        () => {
          $setSelectionOffsets(3);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) selection.insertText(' @al');
        },
        { discrete: true }
      )
    );
    const options = () =>
      [...surface.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => [
        option.dataset.todayPickerKind,
        option.textContent,
      ]);
    expect(options()).toEqual([
      ['member', 'AWAlice Wong'],
      ['session', 'Align the release'],
    ]);
    const tab = (label: string) =>
      [...surface.querySelectorAll<HTMLElement>('[role="tab"]')].find(
        (t) => t.textContent === label
      )!;
    await act(async () => tab('Sessions').click());
    expect(options()).toEqual([['session', 'Align the release']]);
    await act(async () => tab('People').click());
    expect(options()).toEqual([['member', 'AWAlice Wong']]);
    const editable = surface.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await act(async () => {
      window.getSelection()?.removeAllRanges();
      editable.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });
    expect(store.getSnapshot().visible[0]).toMatchObject({
      text: `ask ${M}`,
      mentions: [{ start: 4, kind: 'member', id: 'u2' }],
    });
    await act(async () => controller.deactivate());
    const chip = surface.querySelector<HTMLElement>('[data-today-member="u2"]')!;
    expect(chip.textContent).toBe('AWAlice Wong');
    await act(async () => chip.click());
    expect(opened).toEqual(['u2']);
    // A member who left the workspace keeps the chip, named as unknown.
    members.delete('u2');
    await act(async () => void store.outline.insertMention(id, 0, 0, { kind: 'member', id: 'u2' }));
    expect(surface.querySelector('[data-today-member="u2"]')?.textContent).toBe('Unknown member');
    act(() => root.unmount());
    controller.dispose();
    store.dispose();
    surface.remove();
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
  it('a composition committed after a peer edit keeps the caret right after the composed text', () => {
    const doc = new LoroDoc();
    const outline = openTodayOutline(doc);
    const focus = outline.insertFirst('abc') as { nodeId: never };
    const text = outline.getText(focus.nodeId)!;
    const undo = createTodayPageUndo(doc, { setTimer: () => () => {} });
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    const editor = createEditor({
      namespace: 'today-ime-commit',
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

    // The IME composes `Z` after `a` while a peer appends `X`.
    composing = true;
    editor.update(() => $setSelectionOffsets(1), { discrete: true });
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText('Z');
      },
      { discrete: true }
    );
    peerText.insert(3, 'X');
    peer.commit();
    doc.import(peer.export({ mode: 'update', from: doc.oplogVersion() }));
    // The composition commits.
    composing = false;
    editor.update(() => $getRoot().getFirstDescendant()?.markDirty(), { discrete: true });
    expect(text.toString()).toBe('aZbcX');
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('aZbcX');
    expect(editor.getEditorState().read(() => $readSelectionOffsets())).toEqual({
      start: 2,
      end: 2,
    });
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
      retryDelayMs: () => 1000,
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

  it('keeps text an IME was still composing when a click moves editing to another node', async () => {
    const { createTodayPageStoreCache } = await import('../src/providers/today-page-store-cache');
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { getTodayDocId, parseTodayPasteText } = await import('@lody/shared');
    const cache = createTodayPageStoreCache({
      releaseDelayMs: 1000,
      idleCap: 2,
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
      repo: {
        openDoc: async () => ({ doc: new LoroDoc(), joinRoom: async () => null }),
        isRegistered: async () => true,
        upsertDocMeta: async () => {},
        unloadDoc: async () => {},
        observeDocs: () => ({ docIds: [], unsubscribe: () => {} }),
      },
    });
    const store = await cache.acquire(getTodayDocId('me', '2026-11-19' as never));
    store.outline.paste({ kind: 'page-start' }, parseTodayPasteText('one\ntwo'));
    const [first, second] = store.getSnapshot().visible;
    const controller = new TodayEditorController(cache);
    const editable = () => {
      const root = document.createElement('div');
      root.contentEditable = 'true';
      document.body.append(root);
      return root;
    };
    const type = (value: string, compose: boolean) =>
      controller.editor.update(
        () => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) throw new Error('no caret');
          if (compose) $setCompositionKey(selection.anchor.key);
          selection.insertText(value);
        },
        { discrete: true }
      );
    const rootA = editable();
    controller.activate(store, first!.id, 'end');
    controller.attachRoot(rootA);
    // The preedit is on screen but not yet in the document.
    type('你好', true);
    expect(store.getSnapshot().visible[0]!.text).toBe('one');
    // The click activates the other row: React unmounts this editable and mounts that one.
    controller.activate(store, second!.id, 'end');
    controller.attachRoot(null);
    const rootB = editable();
    controller.attachRoot(rootB);
    type('!', false);
    expect(store.getSnapshot().visible.map((node) => node.text)).toEqual(['one你好', 'two!']);
    store.undo.undo();
    store.undo.undo();
    expect(store.getSnapshot().visible.map((node) => node.text)).toEqual(['one', 'two']);
    controller.dispose();
    rootA.remove();
    rootB.remove();
  });

  it('Enter over a selected range replaces it with the line break', async () => {
    const { createTodayPageStoreCache } = await import('../src/providers/today-page-store-cache');
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { getTodayDocId, parseTodayPasteText } = await import('@lody/shared');
    const cache = createTodayPageStoreCache({
      releaseDelayMs: 1000,
      idleCap: 2,
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
      repo: {
        openDoc: async () => ({ doc: new LoroDoc(), joinRoom: async () => null }),
        isRegistered: async () => true,
        upsertDocMeta: async () => {},
        unloadDoc: async () => {},
        observeDocs: () => ({ docIds: [], unsubscribe: () => {} }),
      },
    });
    const store = await cache.acquire(getTodayDocId('me', '2026-11-22' as never));
    store.outline.paste({ kind: 'page-start' }, parseTodayPasteText('abcdef'));
    const [only] = store.getSnapshot().visible;
    const controller = new TodayEditorController(cache);
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    controller.activate(store, only!.id, 'end');
    controller.attachRoot(root);
    const textNode = root.querySelector('span')?.firstChild ?? root.firstChild!;
    window.getSelection()!.setBaseAndExtent(textNode, 2, textNode, 4);
    root.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().visible.map((node) => node.text)).toEqual(['ab', 'ef']);
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
      retryDelayMs: () => 1000,
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

describe('Today @ trigger', () => {
  it('opens at a line start or after a space or mention, never inside a word or across lines', async () => {
    const { findPickerTrigger } =
      await import('../src/components/today/editor/today-editor-controller');
    expect(findPickerTrigger('@fi', 3)).toEqual({ start: 0, query: 'fi' });
    expect(findPickerTrigger('see ＠fix the bug', 16)).toEqual({ start: 4, query: 'fix the bug' });
    expect(findPickerTrigger(`${M}@x`, 3)).toEqual({ start: 1, query: 'x' });
    expect(findPickerTrigger('mail a@b', 8)).toBeNull();
    expect(findPickerTrigger('@a\nb', 4)).toBeNull();
    expect(findPickerTrigger('@fix later', 4)).toEqual({ start: 0, query: 'fix' });
  });
});

describe('Today mention keys', () => {
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
  const at = (anchor: number, focus = anchor) => ({ anchor, focus });

  it('← and Backspace after a mention select it first; ← again moves before it', () => {
    expect(resolveMentionKey(key('ArrowLeft'), at(3), [2])).toEqual({
      type: 'select',
      anchor: 3,
      focus: 2,
    });
    expect(resolveMentionKey(key('Backspace'), at(3), [2])).toEqual({
      type: 'select',
      anchor: 3,
      focus: 2,
    });
    expect(resolveMentionKey(key('ArrowLeft'), at(3, 2), [2])).toEqual({
      type: 'collapse',
      offset: 2,
    });
    // A selected mention is deleted by the editor itself.
    expect(resolveMentionKey(key('Backspace'), at(3, 2), [2])).toBeNull();
    expect(resolveMentionKey(key('ArrowLeft'), at(4), [2])).toBeNull();
  });

  it('→ and Delete before a mention are symmetric', () => {
    expect(resolveMentionKey(key('ArrowRight'), at(2), [2])).toEqual({
      type: 'select',
      anchor: 2,
      focus: 3,
    });
    expect(resolveMentionKey(key('Delete'), at(2), [2])).toEqual({
      type: 'select',
      anchor: 2,
      focus: 3,
    });
    expect(resolveMentionKey(key('ArrowRight'), at(2, 3), [2])).toEqual({
      type: 'collapse',
      offset: 3,
    });
  });

  it('leaves word deletion, Shift extension and IME to the editor; Enter opens a selected mention', () => {
    expect(resolveMentionKey(key('Backspace', { altKey: true }), at(3), [2])).toBeNull();
    expect(resolveMentionKey(key('Backspace', { metaKey: true }), at(3), [2])).toBeNull();
    expect(resolveMentionKey(key('ArrowLeft', { shiftKey: true }), at(3), [2])).toBeNull();
    expect(resolveMentionKey(key('ArrowLeft', { keyCode: 229 }), at(3), [2])).toBeNull();
    expect(resolveMentionKey(key('Enter'), at(2, 3), [2])).toEqual({ type: 'open', start: 2 });
    expect(resolveMentionKey(key('Enter', { altKey: true }), at(3, 2), [2])).toEqual({
      type: 'menu',
      start: 2,
    });
    expect(resolveMentionKey(key('Enter'), at(3), [2])).toBeNull();
  });
});

describe('Today editor around mentions', () => {
  async function mount(lines: string) {
    const { createTodayPageStoreCache } = await import('../src/providers/today-page-store-cache');
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { getTodayDocId, parseTodayPasteText } = await import('@lody/shared');
    const cache = createTodayPageStoreCache({
      releaseDelayMs: 1000,
      idleCap: 2,
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
      repo: {
        openDoc: async () => ({ doc: new LoroDoc(), joinRoom: async () => null }),
        isRegistered: async () => true,
        upsertDocMeta: async () => {},
        unloadDoc: async () => {},
        observeDocs: () => ({ docIds: [], unsubscribe: () => {} }),
      },
    });
    const store = await cache.acquire(getTodayDocId('me', '2026-11-23' as never));
    store.outline.paste({ kind: 'page-start' }, parseTodayPasteText(lines));
    const [node] = store.getSnapshot().visible;
    const controller = new TodayEditorController(cache);
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    const opened: string[] = [];
    controller.onOpenSession = (sessionId) => opened.push(sessionId);
    const press = async (k: string) => {
      // jsdom does not mirror Lexical's selection into the DOM as a browser
      // does; without a DOM selection the controller reads Lexical's.
      window.getSelection()?.removeAllRanges();
      root.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    };
    const selection = () => controller.editor.read(() => $readSelectionOffsets());
    const done = () => {
      controller.dispose();
      root.remove();
    };
    return { store, nodeId: node!.id, controller, root, press, selection, opened, done };
  }

  it('walks past a mention in two steps each way, and Enter on it opens the conversation', async () => {
    const ctx = await mount('ab');
    ctx.store.outline.insertMention(ctx.nodeId, 1, 0, { kind: 'session', id: 's1' });
    ctx.controller.activate(ctx.store, ctx.nodeId, 2);
    ctx.controller.attachRoot(ctx.root);
    await ctx.press('ArrowLeft');
    expect(ctx.selection()).toEqual({ start: 1, end: 2 });
    await ctx.press('Enter');
    expect(ctx.opened).toEqual(['s1']);
    expect(ctx.store.getSnapshot().visible).toHaveLength(1);
    await ctx.press('ArrowLeft');
    expect(ctx.selection()).toEqual({ start: 1, end: 1 });
    await ctx.press('ArrowRight');
    expect(ctx.selection()).toEqual({ start: 1, end: 2 });
    await ctx.press('ArrowRight');
    expect(ctx.selection()).toEqual({ start: 2, end: 2 });
    ctx.done();
  });

  it('Backspace after a mention selects it, and only a second Backspace deletes it', async () => {
    const ctx = await mount('ab');
    ctx.store.outline.insertMention(ctx.nodeId, 1, 0, { kind: 'session', id: 's1' });
    ctx.controller.activate(ctx.store, ctx.nodeId, 2);
    ctx.controller.attachRoot(ctx.root);
    await ctx.press('Backspace');
    expect(ctx.store.outline.getNode(ctx.nodeId)?.mentions).toHaveLength(1);
    expect(ctx.selection()).toEqual({ start: 1, end: 2 });
    await ctx.press('Backspace');
    expect(ctx.store.outline.getNode(ctx.nodeId)).toMatchObject({ text: 'ab', mentions: [] });
    ctx.done();
  });
});

describe('Today day section opening', () => {
  it('reports a day found empty after syncing, and reports it again once it holds content', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const date = '2026-11-19' as never;
    const store = createTodayPageStore({
      docId: 'today-u1-2026-11-19',
      doc: new LoroDoc(),
      registered: true,
      join: async () => ({ room: { unsubscribe: () => {} }, synced: Promise.resolve() }),
      register: async () => {},
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
    });
    const cache = {
      peek: () => store,
      acquire: async () => store,
      releaseRef: () => {},
    } as unknown as TodayPageStoreCache;
    const reports: Array<[string, boolean]> = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        withTestI18n(
          createElement(TodayDaySection, {
            cache,
            userId: 'u1',
            date,
            today: '2026-11-20' as never,
            isTop: false,
            onEmptyChange: (day: string, empty: boolean) => reports.push([day, empty]),
          }),
          createTestI18n()
        )
      )
    );
    expect(reports).toEqual([['2026-11-19', true]]);
    await act(async () => void store.outline.insertFirst('written later'));
    expect(reports.at(-1)).toEqual(['2026-11-19', false]);
    act(() => root.unmount());
    container.remove();
    store.dispose();
  });

  it('shows a failed open with Retry, and Retry opens the day', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const date = '2026-11-20' as never;
    let failNext = true;
    const store = createTodayPageStore({
      docId: 'today-u1-2026-11-20',
      doc: new LoroDoc(),
      registered: false,
      join: async () => null,
      register: async () => {},
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
    });
    store.outline.insertFirst('opened');
    const cache = {
      peek: () => undefined,
      acquire: async () => {
        if (failNext) {
          failNext = false;
          throw new Error('storage unavailable');
        }
        return store;
      },
      releaseRef: () => {},
    } as unknown as TodayPageStoreCache;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const i18n = createTestI18n();
    await act(async () =>
      root.render(
        withTestI18n(
          createElement(TodayDaySection, {
            cache,
            userId: 'u1',
            date,
            today: date,
            isTop: true,
            onEmptyChange: () => {},
          }),
          i18n
        )
      )
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't open this day.");
    await act(async () => alert!.querySelector('button')!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('opened');
    act(() => root.unmount());
    container.remove();
    store.dispose();
  });
});

describe('Today to-dos and the selection bar', () => {
  async function render(lines: string) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { TodayEditorContext } =
      await import('../src/components/today/editor/today-editor-context');
    const { TodaySelectionBar } = await import('../src/components/today/today-selection-bar');
    const { parseTodayPasteText } = await import('@lody/shared');
    const store = createTodayPageStore({
      docId: 'today-u1-2026-11-18',
      doc: new LoroDoc(),
      registered: true,
      join: async () => ({ room: { unsubscribe: () => {} }, synced: Promise.resolve() }),
      register: async () => {},
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
    });
    store.outline.paste({ kind: 'page-start' }, parseTodayPasteText(lines));
    const cache = {
      peek: () => store,
      acquire: async () => store,
      releaseRef: () => {},
    } as unknown as TodayPageStoreCache;
    const controller = new TodayEditorController(cache);
    const surface = document.createElement('div');
    surface.tabIndex = -1;
    document.body.append(surface);
    controller.attachSurface(surface);
    const converted: string[] = [];
    const root = createRoot(surface);
    await act(async () =>
      root.render(
        withTestI18n(
          createElement(
            TodayEditorContext.Provider,
            { value: controller },
            createElement(TodayDaySection, {
              cache,
              userId: 'u1',
              date: '2026-11-18' as never,
              today: '2026-11-18' as never,
              isTop: true,
              onEmptyChange: () => {},
            }),
            createElement(TodaySelectionBar, {
              onConvert: (_store: unknown, nodeId: string) => converted.push(nodeId),
            })
          ),
          createTestI18n()
        )
      )
    );
    const rows = () => store.getSnapshot().visible.map((node) => [node.text, node.todo]);
    const row = (index: number) =>
      surface.querySelectorAll<HTMLElement>('[data-today-node]')[index]!;
    const bar = () => surface.querySelector<HTMLElement>('[role="toolbar"]');
    const barButton = (label: string) =>
      [...(bar()?.querySelectorAll('button') ?? [])].find(
        (button) => button.getAttribute('aria-label') === label || button.textContent === label
      )!;
    const click = (element: Element) =>
      act(async () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
    const done = () => {
      act(() => root.unmount());
      controller.dispose();
      store.dispose();
      surface.remove();
    };
    return { store, controller, surface, rows, row, bar, barButton, click, converted, done };
  }

  const pointer = (type: string, init: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
    return event;
  };

  it('a bullet click selects the node and offers its actions; the bar turns it into a to-do, marks it done, and back', async () => {
    const ctx = await render('write the spec\nb');
    expect(ctx.bar()).toBeNull();
    const bullet = ctx.row(0).querySelector('[data-today-bullet]')!;
    await act(async () => {
      bullet.dispatchEvent(pointer('pointerdown', { clientX: 5, clientY: 5 }));
      window.dispatchEvent(pointer('pointerup', { clientX: 5, clientY: 5 }));
    });
    expect(ctx.row(0).getAttribute('aria-selected')).toBe('true');
    expect(ctx.bar()).not.toBeNull();
    await ctx.click(ctx.barButton('Turn into to-do'));
    expect(ctx.rows()[0]).toEqual(['write the spec', 'todo']);
    expect(ctx.row(0).querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe(
      'false'
    );
    await ctx.click(ctx.barButton('Mark as done'));
    await ctx.click(ctx.barButton('Back to plain text'));
    expect(ctx.rows()[0]).toEqual(['write the spec', undefined]);
    expect(ctx.row(0).querySelector('[role="checkbox"]')).toBeNull();
    await ctx.click(ctx.barButton('Convert to task'));
    expect(ctx.converted).toEqual([ctx.store.getSnapshot().visible[0]!.id]);
    await ctx.click(ctx.barButton('Delete'));
    expect(ctx.rows()).toEqual([['b', undefined]]);
    expect(ctx.bar()).toBeNull();
    ctx.done();
  });

  it('waits for a drag-selection to be released, then acts on every selected row', async () => {
    const ctx = await render('a\n- [ ] b\nc');
    const ids = ctx.store.getSnapshot().visible.map((node) => node.id);
    const text = ctx.row(0).lastElementChild as HTMLElement;
    await act(async () => {
      ctx.controller.pointerDown(ctx.store, ids[0]!, text, {
        clientX: 0,
        clientY: 0,
        shiftKey: false,
      });
      ctx.controller.selectBlocks(ctx.store, [ids[0]!, ids[1]!]);
    });
    expect(ctx.bar()).toBeNull();
    await act(async () => {
      window.dispatchEvent(pointer('pointerup'));
    });
    expect(ctx.bar()).not.toBeNull();
    expect(ctx.barButton('Convert to task').disabled).toBe(true);
    const mod = navigator.platform.includes('Mac') ? { metaKey: true } : { ctrlKey: true };
    await act(async () => {
      ctx.controller.onBlockKey(new KeyboardEvent('keydown', { key: 'Enter', ...mod }));
    });
    expect(ctx.rows()).toEqual([
      ['a', 'todo'],
      ['b', 'done'],
      ['c', undefined],
    ]);
    ctx.done();
  });

  it('the checkbox swaps to-do and done, and an empty line hides its dot until edited', async () => {
    const ctx = await render('- [ ] a');
    await ctx.click(ctx.row(0).querySelector('[role="checkbox"]')!);
    expect(ctx.rows()).toEqual([['a', 'done']]);
    await ctx.click(ctx.row(0).querySelector('[role="checkbox"]')!);
    expect(ctx.rows()).toEqual([['a', 'todo']]);
    const id = ctx.store.getSnapshot().visible[0]!.id;
    await act(async () => void ctx.store.outline.split(id, 1));
    const empty = ctx.store.getSnapshot().visible[1]!.id;
    const quiet = () => ctx.row(1).querySelector('[data-today-dot="quiet"]');
    expect(quiet()).toBeNull();
    await act(async () => void ctx.store.outline.enterOnEmpty(empty));
    expect(quiet()).not.toBeNull();
    await act(async () => ctx.controller.activate(ctx.store, empty, 'end'));
    expect(quiet()).toBeNull();
    ctx.done();
  });

  it('Mod+Enter while editing cycles the node, which stays in editing', async () => {
    const ctx = await render('abc');
    const id = ctx.store.getSnapshot().visible[0]!.id;
    await act(async () => ctx.controller.activate(ctx.store, id, 1));
    const editable = ctx.row(0).querySelector<HTMLElement>('[contenteditable]')!;
    const mod = navigator.platform.includes('Mac') ? { metaKey: true } : { ctrlKey: true };
    const press = () =>
      act(async () => {
        window.getSelection()?.removeAllRanges();
        editable.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mod })
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    await press();
    expect(ctx.rows()).toEqual([['abc', 'todo']]);
    await press();
    expect(ctx.rows()).toEqual([['abc', 'done']]);
    expect(ctx.controller.isActive(ctx.store, id)).toBe(true);
    await press();
    expect(ctx.rows()).toEqual([['abc', undefined]]);
    ctx.done();
  });
});

describe('Today focus view', () => {
  async function zoomed(lines: string, rootText: string | null) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { TodayEditorContext } =
      await import('../src/components/today/editor/today-editor-context');
    const { parseTodayPasteText } = await import('@lody/shared');
    const store = createTodayPageStore({
      docId: 'today-u1-2026-11-16',
      doc: new LoroDoc(),
      registered: true,
      join: async () => ({ room: { unsubscribe: () => {} }, synced: Promise.resolve() }),
      register: async () => {},
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
    });
    store.outline.paste({ kind: 'page-start' }, parseTodayPasteText(lines));
    const id = (text: string) => store.outline.getAllNodes().find((n) => n.text === text)!.id;
    const cache = {
      peek: () => store,
      acquire: async () => store,
      releaseRef: () => {},
    } as unknown as TodayPageStoreCache;
    const controller = new TodayEditorController(cache);
    const events: string[] = [];
    controller.onZoom = (_store, nodeId) => events.push(`zoom:${nodeId}`);
    controller.onZoomOut = () => events.push('out');
    controller.onNodeMenu = (_store, nodeId) => events.push(`menu:${nodeId}`);
    const root = rootText ? id(rootText) : null;
    controller.setFocus({ date: '2026-11-16' as never, rootId: root });
    const surface = document.createElement('div');
    surface.tabIndex = -1;
    document.body.append(surface);
    controller.attachSurface(surface);
    const reactRoot = createRoot(surface);
    await act(async () =>
      reactRoot.render(
        withTestI18n(
          createElement(
            TodayEditorContext.Provider,
            { value: controller },
            createElement(TodayDaySection, {
              cache,
              userId: 'u1',
              date: '2026-11-16' as never,
              today: '2026-11-16' as never,
              isTop: true,
              onEmptyChange: () => {},
              zoomRoot: root,
            })
          ),
          createTestI18n()
        )
      )
    );
    const rows = () =>
      [...surface.querySelectorAll<HTMLElement>('[data-today-node]')].map((row) =>
        row.textContent?.replaceAll('\u200b', '')
      );
    const mod = navigator.platform.includes('Mac') ? { metaKey: true } : { ctrlKey: true };
    const pressIn = async (key: string, init: KeyboardEventInit = {}) =>
      act(async () => {
        window.getSelection()?.removeAllRanges();
        surface
          .querySelector<HTMLElement>('[contenteditable="true"]')!
          .dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
          );
        await Promise.resolve();
        await Promise.resolve();
      });
    const done = () => {
      act(() => reactRoot.unmount());
      controller.dispose();
      store.dispose();
      surface.remove();
    };
    return { store, controller, surface, id, root, rows, events, mod, pressIn, done };
  }

  it('a bullet click zooms in and "⋯" opens the node menu', async () => {
    const ctx = await zoomed('a\n  b', null);
    const row = ctx.surface.querySelectorAll<HTMLElement>('[data-today-node]')[1]!;
    await act(async () => {
      row
        .querySelector('[data-today-bullet]')!
        .dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 })
        );
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 5, clientY: 5 }));
    });
    await act(async () => row.querySelector<HTMLElement>('[data-today-more]')!.click());
    expect(ctx.events).toEqual([`zoom:${ctx.id('b')}`, `menu:${ctx.id('b')}`]);
    ctx.done();
  });

  it('shows the zoomed node as the title over its subtree and keeps keys inside it', async () => {
    const ctx = await zoomed('a\n  b\n    c\n  d\ne', 'b');
    expect(ctx.rows()).toEqual(['b', 'c']);
    await act(async () => ctx.controller.activate(ctx.store, ctx.id('b'), 1));
    await ctx.pressIn('Enter');
    expect(ctx.rows()).toEqual(['b', '', 'c']);
    await act(async () => ctx.controller.activate(ctx.store, ctx.id('b'), 0));
    await ctx.pressIn('Enter');
    expect(ctx.rows()).toEqual(['b', '', '', 'c']);
    expect(ctx.store.outline.getNode(ctx.id('b'))?.parentId).toBe(ctx.id('a'));
    await act(async () => ctx.controller.activate(ctx.store, ctx.id('c'), 'end'));
    await ctx.pressIn('Tab', { shiftKey: true });
    expect(ctx.store.outline.getNode(ctx.id('c'))?.parentId).toBe(ctx.id('b'));
    await act(async () => ctx.controller.activate(ctx.store, ctx.id('b'), 0));
    await ctx.pressIn('ArrowUp');
    expect(ctx.controller.isActive(ctx.store, ctx.id('b'))).toBe(true);
    await ctx.pressIn('Backspace');
    expect(ctx.store.outline.getNode(ctx.id('b'))?.text).toBe('b');
    await act(async () => ctx.controller.selectBlocks(ctx.store, [ctx.id('c')]));
    const block = (key: string, init: KeyboardEventInit) =>
      act(
        async () => void ctx.controller.onBlockKey(new KeyboardEvent('keydown', { key, ...init }))
      );
    await block('a', ctx.mod);
    expect(ctx.controller.getBlockSelection()?.ids).toEqual([ctx.id('b')]);
    await block('a', ctx.mod);
    expect(ctx.controller.getBlockSelection()?.ids).toEqual([ctx.id('b')]);
    await block('Backspace', {});
    expect(ctx.store.outline.getNode(ctx.id('b'))).toBeDefined();
    await block('ArrowLeft', { altKey: true });
    expect(ctx.events).toEqual(['out']);
    ctx.done();
  });

  it('a zoomed node without children starts its first child from the "+" or a press on the empty surface', async () => {
    const ctx = await zoomed('a\n  b\nc', 'b');
    expect(ctx.rows()).toEqual(['b']);
    await act(async () =>
      ctx.surface.querySelector<HTMLElement>('[data-today-add-child]')!.click()
    );
    const [child] = ctx.store.outline.childIds(ctx.id('b'));
    expect(ctx.rows()).toEqual(['b', '']);
    expect(ctx.controller.isActive(ctx.store, child!)).toBe(true);
    expect(ctx.surface.querySelector('[data-today-add-child]')).toBeNull();
    await act(async () => void ctx.store.undo.undo());
    expect(ctx.rows()).toEqual(['b']);
    const press = (target: Element) =>
      act(
        async () =>
          void target.dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
          )
      );
    await press(ctx.surface.querySelector('[data-today-node]')!);
    expect(ctx.rows()).toEqual(['b']);
    await press(ctx.surface.querySelector('section') ?? ctx.surface);
    const [pressed] = ctx.store.outline.childIds(ctx.id('b'));
    expect(ctx.rows()).toEqual(['b', '']);
    expect(ctx.controller.isActive(ctx.store, pressed!)).toBe(true);
    ctx.done();
  });

  it('shows what was typed in a folded node’s subtree once the caret leaves the line', async () => {
    const folded = await zoomed('a\n  b\n  c', 'a');
    await act(async () => void folded.store.outline.setCollapsed(folded.id('a'), true));
    const type = (value: string) =>
      act(async () =>
        folded.controller.editor.update(
          () => {
            $setSelectionOffsets($readComposerValue().text.length);
            const selection = $getSelection();
            if ($isRangeSelection(selection)) selection.insertText(value);
          },
          { discrete: true }
        )
      );
    const blank = await act(async () => folded.store.outline.split(folded.id('c'), 1)!.nodeId);
    expect(folded.surface.querySelector('[data-today-dot="quiet"]')).not.toBeNull();
    await act(async () => folded.controller.activate(folded.store, blank, 'end'));
    await type('new');
    await act(async () => folded.controller.activate(folded.store, folded.id('b'), 'end'));
    await type('!');
    await act(async () => folded.controller.activate(folded.store, folded.id('a'), 'end'));
    expect(folded.rows()).toEqual(['a', 'b!', 'c', 'new']);
    expect(folded.surface.querySelector('[data-today-dot="quiet"]')).toBeNull();
    folded.done();
  });

  it('repeated Enter on empty lines and Shift+Tab keep every line inside the zoomed node', async () => {
    const ctx = await zoomed('a\n  b\n    c\n      d\ne', 'b');
    const inside = () =>
      ctx.store.outline.getAllNodes().every((node) => {
        if (['a', 'b', 'e'].includes(node.text)) return true;
        for (let id = node.parentId; id; id = ctx.store.outline.getNode(id)?.parentId ?? null) {
          if (id === ctx.id('b')) return true;
        }
        return false;
      });
    const blank = await act(async () => ctx.store.outline.split(ctx.id('d'), 1)!.nodeId);
    await act(async () => ctx.controller.activate(ctx.store, blank, 0));
    for (let press = 0; press < 3; press += 1) {
      await ctx.pressIn('Enter');
      expect(inside()).toBe(true);
    }
    expect(ctx.rows()).toEqual(['b', 'c', 'd', '', '', '']);
    for (const id of [ctx.id('d'), ctx.store.outline.childIds(ctx.id('b')).at(-1)!]) {
      await act(async () => ctx.controller.activate(ctx.store, id, 0));
      for (let press = 0; press < 3; press += 1) {
        await ctx.pressIn('Tab', { shiftKey: true });
        expect(inside()).toBe(true);
      }
      expect(ctx.store.outline.getNode(id)?.parentId).toBe(ctx.id('b'));
    }
    await act(async () => ctx.controller.selectBlocks(ctx.store, [ctx.id('c'), ctx.id('d')]));
    await act(
      async () =>
        void ctx.controller.onBlockKey(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))
    );
    expect(inside()).toBe(true);
    ctx.done();
  });

  it('inside a zoomed node, folded or not, merges and deletion take neighbours from its subtree', async () => {
    const ctx = await zoomed('a\n  b\n  c\n  d\ne', 'a');
    const press = async (key: string, atEnd: boolean) =>
      act(async () => {
        const editable = ctx.surface.querySelector<HTMLElement>('[contenteditable="true"]')!;
        const text = editable.querySelector('span')!.firstChild!;
        window.getSelection()!.collapse(text, atEnd ? text.textContent!.length : 0);
        editable.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    await act(async () => ctx.controller.activate(ctx.store, ctx.id('d'), 'end'));
    await press('Delete', true);
    expect(ctx.store.outline.getAllNodes().map((node) => node.text)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    await act(async () => void ctx.store.outline.setCollapsed(ctx.id('a'), true));
    await act(async () => ctx.controller.activate(ctx.store, ctx.id('c'), 0));
    await press('Backspace', false);
    expect(ctx.rows()).toEqual(['a', 'bc', 'd']);
    await act(async () => ctx.controller.selectBlocks(ctx.store, [ctx.id('d')]));
    await act(
      async () => void ctx.controller.onBlockKey(new KeyboardEvent('keydown', { key: 'Backspace' }))
    );
    expect(ctx.rows()).toEqual(['a', 'bc']);
    expect(ctx.controller.isActive(ctx.store, ctx.id('bc'))).toBe(true);
    ctx.done();
  });

  it('says the zoomed node is gone when a peer deletes it, and offers the way back', async () => {
    const ctx = await zoomed('a\n  b', 'b');
    await act(async () => void ctx.store.outline.deleteNodes([ctx.id('b')]));
    expect(ctx.surface.textContent).toContain('This node was deleted.');
    await act(async () =>
      [...ctx.surface.querySelectorAll('button')]
        .find((b) => b.textContent === 'Back to the parent')!
        .click()
    );
    expect(ctx.events).toEqual(['out']);
    ctx.done();
  });
});

describe('Today block selection on the surface', () => {
  async function setup() {
    const { createTodayPageStoreCache } = await import('../src/providers/today-page-store-cache');
    const { TodayEditorController } =
      await import('../src/components/today/editor/today-editor-controller');
    const { getTodayDocId, parseTodayPasteText } = await import('@lody/shared');
    const unloaded: string[] = [];
    const cache = createTodayPageStoreCache({
      releaseDelayMs: 1000,
      idleCap: 2,
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
      repo: {
        openDoc: async () => ({ doc: new LoroDoc(), joinRoom: async () => null }),
        isRegistered: async () => true,
        upsertDocMeta: async () => {},
        unloadDoc: async (docId) => void unloaded.push(docId),
        observeDocs: () => ({ docIds: [], unsubscribe: () => {} }),
      },
    });
    const docId = getTodayDocId('me', '2026-11-20' as never);
    const store = await cache.acquire(docId);
    store.outline.paste({ kind: 'page-start' }, parseTodayPasteText('a\nb'));
    const controller = new TodayEditorController(cache);
    const surface = document.createElement('div');
    document.body.append(surface);
    controller.attachSurface(surface);
    const ids = store.getSnapshot().visible.map((node) => node.id);
    const press = (key: string, mods: KeyboardEventInit = {}) =>
      controller.onBlockKey(new KeyboardEvent('keydown', { key, ...mods }));
    const texts = () => store.getSnapshot().visible.map((node) => node.text);
    return { cache, controller, docId, store, surface, ids, press, texts, unloaded };
  }

  it('undoes and redoes a deleted selection with the keyboard, even though nothing is selected after', async () => {
    const ctx = await setup();
    ctx.controller.selectBlocks(ctx.store, ctx.ids);
    ctx.press('Backspace');
    expect(ctx.texts()).toEqual([]);
    const mod = navigator.platform.includes('Mac') ? { metaKey: true } : { ctrlKey: true };
    expect(ctx.press('z', mod)).toBe(true);
    await Promise.resolve();
    expect(ctx.texts()).toEqual(['a', 'b']);
    expect(ctx.press('z', { ...mod, shiftKey: true })).toBe(true);
    await Promise.resolve();
    expect(ctx.texts()).toEqual([]);
    ctx.controller.dispose();
    ctx.surface.remove();
  });

  it('pasting lines over a block selection turns this workspace’s conversation links into mentions', async () => {
    const ctx = await setup();
    ctx.controller.workspaceId = 'ws1';
    ctx.controller.selectBlocks(ctx.store, [ctx.ids[0]!]);
    // jsdom has no DataTransfer: a minimal clipboard with only plain text.
    const items: Record<string, string> = {
      'text/plain': 'see lody://session/s1?workspace=ws1\nplain',
    };
    const event = new Event('paste', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => items[type] ?? '' },
    });
    expect(ctx.controller.onBlockPaste(event)).toBe(true);
    const pasted = ctx.store.getSnapshot().visible[1]!;
    expect(pasted.mentions).toEqual([{ start: 4, kind: 'session', id: 's1' }]);
    ctx.controller.dispose();
    ctx.surface.remove();
  });

  it('a conversation dropped in the gutter beside the readable column lands in the day at that height', async () => {
    const ctx = await setup();
    const rect = (left: number, top: number, right: number, bottom: number) =>
      ({
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
        x: left,
        y: top,
      }) as DOMRect;
    const day = document.createElement('section');
    day.dataset.todayDate = '2026-11-20';
    day.getBoundingClientRect = () => rect(440, 0, 1160, 100);
    ctx.ids.forEach((id, index) => {
      const row = document.createElement('div');
      row.dataset.todayNode = id;
      row.getBoundingClientRect = () => rect(440, index * 28, 1160, index * 28 + 28);
      day.append(row);
    });
    ctx.surface.append(day);
    ctx.controller.registerDay('2026-11-20' as never, ctx.store);
    // Nothing of the day is under the pointer: it is in the gutter, left of the column.
    const elementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = () => [ctx.surface];
    try {
      ctx.controller.dropExternal('s1', 100, 50);
    } finally {
      document.elementsFromPoint = elementsFromPoint;
    }
    expect(
      ctx.store.getSnapshot().visible.map((node) => node.mentions[0]?.id ?? node.text)
    ).toEqual(['a', 'b', 's1']);
    ctx.controller.dispose();
    ctx.surface.remove();
  });

  it('a page pinned and released before its acquire lands is not left held', async () => {
    const ctx = await setup();
    ctx.controller.selectBlocks(ctx.store, [ctx.ids[0]!]);
    // Disposed in the same tick, before the pin's acquire resolved.
    ctx.controller.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.cache.releaseRef(ctx.docId);
    await ctx.cache.releaseIdle();
    expect(ctx.unloaded).toEqual([ctx.docId]);
    ctx.surface.remove();
  });
});

describe('Open Today command', () => {
  it('is listed only while the Today experiment is on, and never masks the mounted command', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { createStore, Provider } = await import('jotai');
    const { experimentalFeaturesEnabledAtom, todayExperimentEnabledAtom, todayFeatureEnabledAtom } =
      await import('../src/atoms/settings');
    const { TodayCommandPlaceholder } = await import('../src/components/today/today-command');
    const { commands, getCommandKeybindings, useCommand } = await import('../src/lib/commands');
    const { useAtomValue } = await import('jotai');
    let opened = 0;
    // Stands in for the sidebar: the real command, mounted after the placeholder.
    function RealTodayCommand() {
      const enabled = useAtomValue(todayFeatureEnabledAtom);
      useCommand(
        {
          id: 'today.open',
          title: 'Open Today',
          category: 'Navigation',
          keybindings: getCommandKeybindings('today.open'),
          run: () => {
            opened += 1;
          },
        },
        enabled
      );
      return null;
    }
    const store = createStore();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(
          Provider,
          { store },
          createElement(TodayCommandPlaceholder),
          createElement(RealTodayCommand)
        )
      )
    );
    expect(commands.list().some((command) => command.id === 'today.open')).toBe(false);
    await act(async () => {
      store.set(experimentalFeaturesEnabledAtom, true);
      store.set(todayExperimentEnabledAtom, true);
    });
    expect(commands.get('today.open')?.title).toBe('Open Today');
    expect(commands.getDefaultKeybindingsFor('today.open')).toEqual(['Mod+Shift+d']);
    expect(commands.execute('today.open')).toBe(true);
    expect(opened).toBe(1);
    await act(async () => store.set(todayExperimentEnabledAtom, false));
    expect(commands.list().some((command) => command.id === 'today.open')).toBe(false);
    act(() => root.unmount());
  });
});
