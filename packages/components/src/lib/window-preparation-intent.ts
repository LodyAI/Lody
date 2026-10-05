import { prepareDesktopWindow } from './desktop-window';
import { isMacOSElectronRenderer } from './electron';

/** One row intent per renderer; explicit window-opening intent skips hover delay. */
export function installWindowPreparationIntent(root: Document = document): () => void {
  if (!isMacOSElectronRenderer()) return () => {};
  let row: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const clear = () => {
    clearTimeout(timer);
    release?.();
    release = undefined;
    row = null;
  };
  const enter = (event: Event) => {
    if ((event as PointerEvent).pointerType === 'touch') return;
    const next =
      event.target instanceof Element ? event.target.closest('[data-sidebar-session-id]') : null;
    const immediate =
      event.type === 'focusin' ||
      (event as MouseEvent).metaKey ||
      (event as MouseEvent).ctrlKey ||
      (event.type === 'pointerdown' && (event as MouseEvent).button === 1);
    if (next === row && (!immediate || release)) return;
    if (next !== row) {
      clear();
      row = next;
    }
    clearTimeout(timer);
    const id = next?.getAttribute('data-sidebar-session-id');
    const prepare = () => {
      if (id && next?.isConnected && next.getAttribute('data-sidebar-session-id') === id)
        release = prepareDesktopWindow(id);
    };
    if (id) {
      if (immediate) prepare();
      else timer = setTimeout(prepare, 40);
    }
  };
  const modifier = (event: KeyboardEvent) => {
    if ((event.key !== 'Meta' && event.key !== 'Control') || event.repeat || !row) return;
    clearTimeout(timer);
    release?.();
    release = undefined;
    const id = row.getAttribute('data-sidebar-session-id');
    if (id && row.isConnected) release = prepareDesktopWindow(id);
  };
  const leave = (event: Event) => {
    const destination = (event as MouseEvent | FocusEvent).relatedTarget;
    if (row && destination instanceof Node && row.contains(destination)) return;
    clear();
  };
  // Session row controls stop propagation; capture observes their actual intent.
  root.addEventListener('pointerover', enter, true);
  root.addEventListener('pointerdown', enter, true);
  root.addEventListener('keydown', modifier, true);
  root.addEventListener('pointerout', leave, true);
  root.addEventListener('focusin', enter, true);
  root.addEventListener('focusout', leave, true);
  root.addEventListener('click', clear, true);
  root.addEventListener('visibilitychange', clear);
  root.defaultView?.addEventListener('blur', clear);
  return () => {
    root.removeEventListener('click', clear, true);
    root.removeEventListener('visibilitychange', clear);
    root.defaultView?.removeEventListener('blur', clear);
    clear();
    root.removeEventListener('pointerover', enter, true);
    root.removeEventListener('pointerdown', enter, true);
    root.removeEventListener('keydown', modifier, true);
    root.removeEventListener('pointerout', leave, true);
    root.removeEventListener('focusin', enter, true);
    root.removeEventListener('focusout', leave, true);
  };
}
