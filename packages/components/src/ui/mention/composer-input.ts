/**
 * The composer input is a contenteditable element managed by a Lexical editor.
 * Its text and caret are not DOM properties the way a textarea's `value` and
 * `selectionStart` are, so everything outside the editor reads and writes them
 * through these functions, in composer-string offsets (UTF-16, as before).
 *
 * The element itself remains the ref every caller holds: focus, blur, `closest`,
 * `contains`, floating-ui anchoring and `document.activeElement` checks are
 * ordinary DOM.
 */

export type ComposerInputElement = HTMLDivElement;

export type ComposerSelection = { start: number; end: number };

export interface ComposerController {
  getText(): string;
  getSelection(): ComposerSelection;
  setSelection(start: number, end?: number): void;
  isComposing(): boolean;
  /** Client rect of a zero-width caret at `offset`, one line high. */
  getCaretRect(offset: number): DOMRect;
  /** Client rects covering `start..end`, one per line box. */
  getRangeRects(start: number, end: number): DOMRect[];
}

const controllers = new WeakMap<Element, ComposerController>();

/** @internal Called by the composer editor for its root element. */
export function registerComposerController(element: Element, controller: ComposerController) {
  controllers.set(element, controller);
  return () => {
    if (controllers.get(element) === controller) controllers.delete(element);
  };
}

export function getComposerController(
  element: Element | null | undefined
): ComposerController | null {
  return element ? (controllers.get(element) ?? null) : null;
}

/** Whether `element` is a mounted composer editor. */
export function isComposerInput(element: unknown): element is ComposerInputElement {
  return element instanceof Element && controllers.has(element);
}

/** The composer's current text; empty when the editor is not mounted. */
export function getComposerText(element: Element | null | undefined): string {
  return getComposerController(element)?.getText() ?? '';
}

/** The composer's selection; a caret at the end when it has none. */
export function getComposerSelection(element: Element | null | undefined): ComposerSelection {
  const controller = getComposerController(element);
  if (!controller) return { start: 0, end: 0 };
  return controller.getSelection();
}

/** Select `start..end` in composer-string offsets. Does not move focus. */
export function setComposerSelection(
  element: Element | null | undefined,
  start: number,
  end: number = start
): void {
  getComposerController(element)?.setSelection(start, end);
}

export function isComposerComposing(element: Element | null | undefined): boolean {
  return getComposerController(element)?.isComposing() ?? false;
}

/** Caret geometry for menus and hovers anchored to a text offset. */
export function getComposerCaretRect(element: Element, offset: number): DOMRect {
  const controller = getComposerController(element);
  return controller ? controller.getCaretRect(offset) : element.getBoundingClientRect();
}

/** Geometry of a text range, for hit-testing hovers over committed mentions. */
export function getComposerRangeRects(element: Element, start: number, end: number): DOMRect[] {
  return getComposerController(element)?.getRangeRects(start, end) ?? [];
}
