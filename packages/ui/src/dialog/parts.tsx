import * as stylex from '@stylexjs/stylex';
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { appendClassName } from '../internal/class-name';
import { dialog } from './dialog.tokens.stylex';
import { modal } from './surface';

export interface DialogSectionProps {
  children?: ReactNode;
  className?: string;
}

/**
 * The heading block. A Dialog, an AlertDialog and a Drawer all open with a title
 * and, usually, one sentence about it; the pair is one block with one gap, so
 * the panel's own `gap` separates it from the body rather than from the
 * sentence it belongs to.
 */
export function DialogHeader({ children, className }: DialogSectionProps) {
  const sx = stylex.props(modal.header);
  return (
    <div className={appendClassName(sx.className, className)} style={sx.style}>
      {children}
    </div>
  );
}

/**
 * The answers. They run from the end of a wide panel and stack in reverse on a
 * narrow one, so the affirmative answer is the last one read and the nearest to
 * the thumb in both shapes.
 */
export function DialogFooter({ children, className }: DialogSectionProps) {
  const sx = stylex.props(modal.footer);
  return (
    <div className={appendClassName(sx.className, className)} style={sx.style}>
      {children}
    </div>
  );
}

/**
 * The horizontal centre of `element`, as an offset from the window's
 * inline-start edge, kept current while the element or the window resizes.
 *
 * It is measured rather than stated with CSS anchor positioning: the element a
 * panel centres on usually sits inside another modal panel, and that panel is
 * centred with a `transform`. The Chromium that Electron ships resolves
 * `anchor()` against the untransformed box, so the panel landed half a parent
 * panel's width away from the element it named.
 */
export function useInlineCentre(element: Element | null | undefined): number | null {
  const [centre, setCentre] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element) {
      setCentre(null);
      return undefined;
    }
    const measure = () => {
      const box = element.getBoundingClientRect();
      const mid = box.left + box.width / 2;
      const rtl = getComputedStyle(element).direction === 'rtl';
      setCentre(rtl ? document.documentElement.clientWidth - mid : mid);
    };
    measure();
    // The element can move without resizing — a centred parent slides when the
    // window narrows — so the window's resize is watched as well as its own.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [element]);
  return centre;
}

/**
 * Where a panel opened with `centerOn` puts its centre: on the element's, held
 * far enough in that the panel keeps `dialog.inset` of window on both sides —
 * the room `max-width` already keeps — so an element near the window's edge
 * pulls the panel toward it without pushing it off.
 */
function panelCentreAt(centre: number, width: CSSProperties['width']): string {
  const panelWidth = typeof width === 'number' ? `${width}px` : (width ?? dialog.width);
  const reach = `min(${panelWidth}, 100vw - ${dialog.inset}) / 2 + ${dialog.inset} / 2`;
  return `clamp(calc(${reach}), ${centre}px, calc(100% - (${reach})))`;
}

/**
 * Composes a panel's `width` and its measured centre into the popup's `style`,
 * in whichever form the caller used — Base UI lets `style` be an object or a
 * callback of the popup's state. Both travel as inline style rather than as a
 * class, because a second `width` or inset declaration on the panel would race
 * the rung's own in the sheet rather than reliably follow it.
 */
export function mergePanelLayout<S>(
  style: CSSProperties | ((state: S) => CSSProperties | undefined) | undefined,
  { width, centre }: { width: CSSProperties['width']; centre: number | null }
): typeof style {
  if (width === undefined && centre === null) return style;
  const layout: CSSProperties = {};
  if (width !== undefined) layout.width = width;
  if (centre !== null) layout.insetInlineStart = panelCentreAt(centre, width);
  if (typeof style === 'function') {
    return (state: S) => ({ ...style(state), ...layout });
  }
  return { ...style, ...layout };
}

/**
 * Tracks the panel element while still handing it to the caller's ref.
 *
 * The panel is what every popup inside the dialog has to mount into. A modal
 * traps focus in its own subtree and locks the scroll outside it by DOM
 * position, so a Select or a Menu portalled to the body is "outside" the dialog:
 * focus is dragged back the moment the list opens and the wheel never reaches
 * it. `Content` names the panel to `PopupContainerProvider` so the lists under
 * it mount inside the subtree the dialog is guarding.
 *
 * It is state rather than a ref on purpose. React attaches a child's refs
 * before its parent's, so a popup that mounts in the same commit as the panel —
 * a Select rendered open inside a dialog rendered open — reads the ref while it
 * is still null and portals itself to the body, which is the one case this
 * whole mechanism exists to prevent. Holding the element in state re-renders
 * the subtree once the panel exists, so the provider hands down an element
 * rather than a box that may not have been filled yet.
 */
/**
 * How many modals are open above a point in the tree.
 *
 * A portal mounts into `document.body`, so DOM position cannot say whether a
 * dialog opened inside another dialog — React context can, since it follows
 * the component tree across the portal. `Content` hands its children the next
 * depth here, and the family's backdrops read it to draw a lighter veil over
 * the panel they were opened from.
 */
const ModalDepthContext = createContext(0);

/** The number of ancestor modals this subtree sits inside. */
export function useModalDepth(): number {
  return useContext(ModalDepthContext);
}

/** Everything inside this modal counts as one level deeper. */
export function ModalDepthProvider({ children }: { children: ReactNode }) {
  const depth = useContext(ModalDepthContext);
  return <ModalDepthContext.Provider value={depth + 1}>{children}</ModalDepthContext.Provider>;
}

export function usePanelContainer<T extends HTMLElement>(forwarded: Ref<T>) {
  const [container, setContainer] = useState<T | null>(null);
  const ref = useCallback(
    (node: T | null) => {
      setContainer(node);
      if (typeof forwarded === 'function') forwarded(node);
      else if (forwarded) (forwarded as { current: T | null }).current = node;
    },
    [forwarded]
  );
  return { ref, container };
}
