import { prepareDesktopWindow } from './desktop-window';
import { isMacOSElectronRenderer } from './electron';

/** One debounced row intent per renderer; menu items hold their own request. */
export function installWindowPreparationIntent(root: Document = document): () => void {
  if (!isMacOSElectronRenderer()) return () => {};
  let row: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const clear = () => { clearTimeout(timer); release?.(); release = undefined; row = null; };
  const enter = (event: Event) => {
    const next = event.target instanceof Element
      ? event.target.closest('[data-sidebar-session-id]') : null;
    if (next === row) return;
    clear();
    row = next;
    const id = next?.getAttribute('data-sidebar-session-id');
    if (id) timer = setTimeout(() => { if (next?.isConnected) release = prepareDesktopWindow(id); }, 150);
  };
  const leave = (event: Event) => {
    const destination = (event as MouseEvent | FocusEvent).relatedTarget;
    if (row && destination instanceof Node && row.contains(destination)) return;
    clear();
  };
  // Session row controls stop propagation; capture observes their actual intent.
  root.addEventListener('pointerover', enter, true);
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
    root.removeEventListener('pointerout', leave, true);
    root.removeEventListener('focusin', enter, true);
    root.removeEventListener('focusout', leave, true);
  };
}
