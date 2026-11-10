import { $getSelection, $isRangeSelection, type LexicalEditor } from 'lexical';
import { act } from 'react';
import { $setSelectionOffsets } from '../src/ui/mention/composer-document';
import {
  getComposerSelection,
  getComposerText,
  setComposerSelection,
} from '../src/ui/mention/composer-input';
import { getTextDiff } from '../src/ui/mention/mention-input-core';

/**
 * Drive the composer editor in jsdom the way a person editing it would: an edit
 * replaces only the changed span of text, at the caret, through the real Lexical
 * editor, so the primitive's own update path (owner publish, trigger detection,
 * chip movement) runs exactly as for typing. Offsets are composer-string offsets.
 */
export type ComposerTestHandle = {
  element: HTMLElement;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end?: number): void;
  /** Make the text `next`, retyping only the span that differs. */
  edit(next: string, caret?: number): void;
  /** Type `text` at the caret, replacing any selection. */
  type(text: string): void;
  focus(): void;
  dispatchEvent(event: Event): boolean;
};

function lexicalEditorOf(element: HTMLElement): LexicalEditor {
  const editor = (element as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (!editor) throw new Error('not a mounted composer editor');
  return editor;
}

function insertAt(editor: LexicalEditor, start: number, end: number, text: string) {
  editor.update(
    () => {
      $setSelectionOffsets(start, end);
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertRawText(text);
    },
    { discrete: true }
  );
}

export function composerHandle(element: HTMLElement): ComposerTestHandle {
  const editor = lexicalEditorOf(element);
  return {
    element,
    get value() {
      return getComposerText(element);
    },
    get selectionStart() {
      return getComposerSelection(element).start;
    },
    get selectionEnd() {
      return getComposerSelection(element).end;
    },
    setSelectionRange(start, end = start) {
      act(() => setComposerSelection(element, start, end));
    },
    edit(next, caret) {
      act(() => {
        const diff = getTextDiff(getComposerText(element), next);
        if (diff) {
          insertAt(editor, diff.start, diff.prevEnd, next.slice(diff.start, diff.nextEnd));
        }
        if (caret !== undefined) setComposerSelection(element, caret, caret);
      });
    },
    type(text) {
      act(() => {
        const { start, end } = getComposerSelection(element);
        insertAt(editor, start, end, text);
      });
    },
    focus() {
      act(() => element.focus());
    },
    dispatchEvent(event) {
      return element.dispatchEvent(event);
    },
  };
}

/** The composer editor rendered inside `container`. */
export function composerIn(container: ParentNode): ComposerTestHandle {
  const element = container.querySelector<HTMLElement>('[data-composer-editor]');
  if (!element) throw new Error('no composer editor rendered');
  return composerHandle(element);
}
