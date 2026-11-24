import { isImeComposingNativeKeyboardEvent } from '@/lib/ime';
/**
 * Keyboard → outline intent, shared by the active node editor and block
 * selection. Behavior: specs/today-outline.md (Outline editing). Returns null
 * when the key belongs to the text editor (or the browser).
 */
export type OutlineIntent =
  | { type: 'split' }
  | { type: 'enter-empty' }
  | { type: 'indent' }
  | { type: 'outdent' }
  | { type: 'merge-previous' }
  | { type: 'merge-next' }
  | { type: 'move-up' }
  | { type: 'move-down' }
  | { type: 'collapse' }
  | { type: 'expand' }
  | { type: 'focus-previous' }
  | { type: 'focus-next' }
  | { type: 'focus-previous-end' }
  | { type: 'focus-next-start' }
  | { type: 'block-select' }
  | { type: 'cycle-todo' }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  /** Shift+Up/Down reached the first/last line: select to the node edge. */
  | { type: 'extend-text'; anchor: number; focus: number }
  /** Shift+Up/Down with the selection already at the node edge: select the node. */
  | { type: 'select-from-text' };

export type OutlineKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'isComposing' | 'keyCode'
>;

export type OutlineCaretContext = {
  /** Selection collapsed caret offset (the selection start otherwise). */
  offset: number;
  /** Unordered selection ends; `focus` is the end that moves. Default: `offset`. */
  anchor?: number;
  focus?: number;
  length: number;
  hasSelection: boolean;
  onFirstLine: boolean;
  onLastLine: boolean;
};

/**
 * True while an IME composition owns the key. Safari reports the confirming
 * Enter after compositionend with keyCode 229, so `isComposing` alone misses it.
 */
export const isImeKey: (event: OutlineKeyEvent) => boolean = isImeComposingNativeKeyboardEvent;

export function resolveOutlineKey(
  event: OutlineKeyEvent,
  caret: OutlineCaretContext,
  platform: 'mac' | 'other'
): OutlineIntent | null {
  if (isImeKey(event)) return null;
  const mod = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const plain = !mod && !event.altKey && !event.shiftKey;
  switch (event.key) {
    case 'Enter':
      if (mod && !event.shiftKey && !event.altKey) return { type: 'cycle-todo' };
      if (event.shiftKey || mod || event.altKey) return null;
      return caret.length === 0 ? { type: 'enter-empty' } : { type: 'split' };
    case 'Tab':
      if (mod || event.altKey) return null;
      return event.shiftKey ? { type: 'outdent' } : { type: 'indent' };
    case 'Backspace':
      return plain && caret.offset === 0 && !caret.hasSelection ? { type: 'merge-previous' } : null;
    case 'Delete':
      return plain && caret.offset === caret.length && !caret.hasSelection
        ? { type: 'merge-next' }
        : null;
    case 'ArrowUp':
    case 'ArrowDown': {
      const up = event.key === 'ArrowUp';
      // Option+Shift+arrows select by paragraph on macOS: leave them to the system.
      if (platform === 'mac' && event.altKey && event.shiftKey && !mod) return null;
      if ((mod || event.altKey) && event.shiftKey) return { type: up ? 'move-up' : 'move-down' };
      if (event.shiftKey && !mod && !event.altKey) {
        return resolveShiftVertical(up ? -1 : 1, {
          anchor: caret.anchor ?? caret.offset,
          focus: caret.focus ?? caret.offset,
          length: caret.length,
          focusOnFirstLine: caret.onFirstLine,
          focusOnLastLine: caret.onLastLine,
        });
      }
      if (mod && !event.altKey) return { type: up ? 'collapse' : 'expand' };
      if (!plain || caret.hasSelection) return null;
      if (up && caret.onFirstLine) return { type: 'focus-previous' };
      if (!up && caret.onLastLine) return { type: 'focus-next' };
      return null;
    }
    case 'ArrowLeft':
      if (event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        const atStart = !caret.hasSelection && caret.offset === 0;
        return platform !== 'mac' || atStart ? { type: 'zoom-out' } : null;
      }
      return plain && !caret.hasSelection && caret.offset === 0
        ? { type: 'focus-previous-end' }
        : null;
    case 'ArrowRight':
      if (event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        const atEnd = !caret.hasSelection && caret.offset === caret.length;
        return platform !== 'mac' || atEnd ? { type: 'zoom-in' } : null;
      }
      return plain && !caret.hasSelection && caret.offset === caret.length
        ? { type: 'focus-next-start' }
        : null;
    case 'Escape':
      return plain ? { type: 'block-select' } : null;
    case 'a':
    case 'A': {
      if (!mod || event.shiftKey || event.altKey) return null;
      const start = Math.min(caret.anchor ?? caret.offset, caret.focus ?? caret.offset);
      const end = Math.max(caret.anchor ?? caret.offset, caret.focus ?? caret.offset);
      return caret.length === 0 || (start === 0 && end === caret.length)
        ? { type: 'select-from-text' }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Shift+Up/Down while editing (SiYuan's order): on the first/last line the
 * selection first extends to the node's start/end; once its moving end is
 * already there, the next press selects the whole node. Elsewhere the browser
 * extends by a line. Behavior: specs/today-outline.md (Outline editing).
 */
export function resolveShiftVertical(
  step: -1 | 1,
  caret: {
    anchor: number;
    focus: number;
    length: number;
    focusOnFirstLine: boolean;
    focusOnLastLine: boolean;
  }
): OutlineIntent | null {
  const edge = step < 0 ? 0 : caret.length;
  if (caret.focus === edge) return { type: 'select-from-text' };
  if (step < 0 ? caret.focusOnFirstLine : caret.focusOnLastLine) {
    return { type: 'extend-text', anchor: caret.anchor, focus: edge };
  }
  return null;
}
