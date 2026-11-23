/** Set while the person scrolls the element; native thumbs are transparent otherwise. */
export const SCROLLBAR_SCROLLING_ATTRIBUTE = 'data-scrollbar-scrolling';
/** Set while the pointer is over the element's own scrollbar gutter; the thumb widens. */
export const SCROLLBAR_HOVER_ATTRIBUTE = 'data-scrollbar-hover';

/** Base UI's ScrollArea ends its `scrolling` state after the same pause. */
const SCROLL_PAUSE_MS = 500;

const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

const isTextEntry = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement);

/** Whether a pointer event lands on `element`'s own scrollbar rather than its content. */
const isOverScrollbar = (element: Element, event: PointerEvent): boolean => {
  const { clientWidth, clientHeight, offsetWidth, offsetHeight, clientLeft, clientTop } =
    element as HTMLElement;
  const vertical =
    element.scrollHeight > clientHeight && offsetWidth - clientLeft * 2 > clientWidth;
  const horizontal =
    element.scrollWidth > clientWidth && offsetHeight - clientTop * 2 > clientHeight;
  return (
    (vertical && (event.offsetX >= clientWidth || event.offsetX < 0)) ||
    (horizontal && event.offsetY >= clientHeight)
  );
};

/**
 * Show native scrollbars the way overlay scrollbars behave: hidden at rest,
 * visible while the person scrolls, and visible and wider while the pointer is
 * on the scrollbar itself. A native scrollbar keeps its full gutter as the hit
 * area, so only its thumb changes.
 *
 * Only scrolls that follow the person's own input (wheel, touch, scroll keys,
 * a press on the scrollbar) reveal the thumb; a scroll the app makes, such as a
 * conversation following a streaming reply, leaves it hidden. The states are
 * published as attributes for `nativeScrollbar` and product-wide CSS. Returns a
 * function that uninstalls it.
 */
export function installScrollbarPresence(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  let intentUntil = -Infinity;
  let pressed = false;
  let hovered: Element | null = null;
  const pauses = new Map<Element, number>();

  const intend = (event: Event) => {
    intentUntil = event.timeStamp + SCROLL_PAUSE_MS;
  };
  const setHovered = (next: Element | null) => {
    if (next === hovered) return;
    hovered?.removeAttribute(SCROLLBAR_HOVER_ATTRIBUTE);
    hovered = next;
    hovered?.setAttribute(SCROLLBAR_HOVER_ATTRIBUTE, '');
  };

  const onScroll = (event: Event) => {
    if (!pressed && event.timeStamp > intentUntil) return;
    const target = event.target === doc ? doc.scrollingElement : event.target;
    if (!(target instanceof Element)) return;
    view.clearTimeout(pauses.get(target));
    target.setAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE, '');
    pauses.set(
      target,
      view.setTimeout(() => {
        pauses.delete(target);
        target.removeAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE);
      }, SCROLL_PAUSE_MS)
    );
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!SCROLL_KEYS.has(event.key)) return;
    if (isTextEntry(event.target) && event.key !== 'PageUp' && event.key !== 'PageDown') return;
    intend(event);
  };
  const onPointerMove = (event: PointerEvent) => {
    const target = event.target;
    setHovered(target instanceof Element && isOverScrollbar(target, event) ? target : null);
  };
  const onPointerDown = (event: PointerEvent) => {
    onPointerMove(event);
    if (hovered) pressed = true;
  };
  const onPointerUp = (event: PointerEvent) => {
    pressed = false;
    onPointerMove(event);
  };
  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget === null) setHovered(null);
  };

  const listeners = [
    ['scroll', onScroll],
    ['wheel', intend],
    ['touchmove', intend],
    ['keydown', onKeyDown],
    ['pointermove', onPointerMove],
    ['pointerdown', onPointerDown],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerUp],
    ['pointerout', onPointerOut],
  ] as const;
  for (const [type, listener] of listeners)
    doc.addEventListener(type, listener as EventListener, { capture: true, passive: true });
  return () => {
    for (const [type, listener] of listeners)
      doc.removeEventListener(type, listener as EventListener, { capture: true });
    for (const [element, pause] of pauses) {
      view.clearTimeout(pause);
      element.removeAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE);
    }
    pauses.clear();
    setHovered(null);
  };
}
