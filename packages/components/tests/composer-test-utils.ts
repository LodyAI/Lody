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
 * Drive a composer in jsdom the way a person editing it would. For the mention
 * editor an edit replaces only the changed span of text, at the caret, through
 * the real Lexical editor, so the primitive's own update path (owner publish,
 * trigger detection, chip movement) runs exactly as for typing. A composer
 * without mention sources is a plain textarea and is edited natively.
 * Offsets are composer-string offsets.
 */
export type ComposerTestHandle = {
  element: HTMLElement;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  /** Whether input is refused: the textarea's `disabled`, the editor's `data-disabled`. */
  readonly disabled: boolean;
  setSelectionRange(start: number, end?: number): void;
  /** Make the text `next`, retyping only the span that differs. */
  edit(next: string, caret?: number): void;
  /** Type `text` at the caret, replacing any selection. */
  type(text: string): void;
  /** Select all text, as the textarea's `select()` did. */
  select(): void;
  focus(): void;
  blur(): void;
  dispatchEvent(event: Event): boolean;
  getAttribute(name: string): string | null;
};

function lexicalEditorOf(element: HTMLElement): LexicalEditor | null {
  return (element as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor ?? null;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string, caret: number) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    textarea,
    value
  );
  textarea.setSelectionRange(caret, caret);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

export function composerHandle(element: HTMLElement): ComposerTestHandle {
  const editor = lexicalEditorOf(element);
  const textarea = element instanceof HTMLTextAreaElement ? element : null;
  if (!editor && !textarea) throw new Error('not a mounted composer');

  const replace = (start: number, end: number, text: string) => {
    if (textarea) {
      const value = textarea.value;
      setTextareaValue(
        textarea,
        value.slice(0, start) + text + value.slice(end),
        start + text.length
      );
      return;
    }
    editor!.update(
      () => {
        $setSelectionOffsets(start, end);
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        if (text) selection.insertRawText(text);
        else selection.removeText();
      },
      { discrete: true }
    );
  };

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
    get disabled() {
      return textarea ? textarea.disabled : element.hasAttribute('data-disabled');
    },
    setSelectionRange(start, end = start) {
      act(() => setComposerSelection(element, start, end));
    },
    edit(next, caret) {
      act(() => {
        const previous = getComposerText(element);
        const diff = getTextDiff(previous, next);
        if (diff) {
          // Retype from the first difference to the end, as a person editing
          // the tail would; keep a common suffix only when a chip lives in it.
          const chipInSuffix = Array.from(
            element.querySelectorAll<HTMLElement>('[data-mention-start]')
          ).some((chip) => Number(chip.dataset.mentionStart) >= diff.prevEnd);
          if (chipInSuffix) replace(diff.start, diff.prevEnd, next.slice(diff.start, diff.nextEnd));
          else replace(diff.start, previous.length, next.slice(diff.start));
        }
        if (caret !== undefined) setComposerSelection(element, caret, caret);
      });
    },
    type(text) {
      act(() => {
        const { start, end } = getComposerSelection(element);
        replace(start, end, text);
      });
    },
    select() {
      act(() => setComposerSelection(element, 0, getComposerText(element).length));
    },
    focus() {
      act(() => element.focus());
    },
    blur() {
      act(() => element.blur());
    },
    dispatchEvent(event) {
      return element.dispatchEvent(event);
    },
    getAttribute(name) {
      return element.getAttribute(name);
    },
  };
}

/** The composer rendered inside `container`: the mention editor or its plain textarea. */
export function composerIn(container: ParentNode): ComposerTestHandle {
  const element = container.querySelector<HTMLElement>('[data-composer-editor], textarea');
  if (!element) throw new Error('no composer rendered');
  return composerHandle(element);
}
