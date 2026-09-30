import { focus } from '../tokens/scales.stylex';

export type FocusModality = 'keyboard' | 'pointer';

/** Keys that move focus or a selection. Escape, Enter and Space act; they do not navigate. */
const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

const varName = (reference: string): string => /var\((--[^),\s]+)/.exec(reference)?.[1] ?? '';

const isTextEntry = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement &&
    !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(
      target.type
    )
  );
};

/**
 * Draw focus rings only for a person navigating with the keyboard.
 *
 * `:focus-visible` is the browser's guess, and it guesses from the last input
 * of any kind: press Escape to close a dialog you opened with the mouse, and
 * the control it hands focus back to lights up as if you had tabbed to it. This
 * tracks the modality from what navigates — Tab and arrow keys outside a text
 * field make it `keyboard`, a pointer press makes it `pointer` — and while it
 * is `pointer`, `focus.ringWidth` is zero on the document, so every ring that
 * reads it disappears and nothing else about the control changes.
 *
 * The modality is also published as `data-focus-modality` on `<html>`, for
 * styles this package does not own. Returns a function that uninstalls it.
 */
export function installFocusModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  const ringWidth = varName(focus.ringWidth);
  let current: FocusModality | null = null;

  const set = (next: FocusModality) => {
    if (next === current) return;
    current = next;
    root.dataset.focusModality = next;
    if (!ringWidth) return;
    if (next === 'pointer') root.style.setProperty(ringWidth, '0px');
    else root.style.removeProperty(ringWidth);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!NAVIGATION_KEYS.has(event.key)) return;
    if (event.key !== 'Tab' && isTextEntry(event.target)) return;
    set('keyboard');
  };
  const onPointerDown = () => set('pointer');

  set('pointer');
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  return () => {
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
    delete root.dataset.focusModality;
    if (ringWidth) root.style.removeProperty(ringWidth);
  };
}
