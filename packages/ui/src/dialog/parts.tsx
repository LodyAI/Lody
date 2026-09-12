import * as stylex from '@stylexjs/stylex';
import { useCallback, useState, type ReactNode, type Ref } from 'react';
import { appendClassName } from '../internal/class-name';
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
