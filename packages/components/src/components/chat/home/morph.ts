import { flushSync } from 'react-dom';
import { prefersReducedMotion } from './tiles';

/*
 * Switching boards is one quiet View Transition, typed `home-board` so its rules in
 * `tailwind/index.css` touch nothing else: the rest of the page does not cross-fade (that read
 * as a flash), only three things move. The board's area eases to its new height while the two
 * boards cross-fade in full overlap, never scaled; the segments, their labels and the fold
 * control follow the same geometry change as the pill and heading. Labels have their own
 * topmost snapshots: the pill's DOM z-index does not survive extraction into the View Transition
 * overlay. The pill keeps its own name only across a switch, where its snapshot glides between
 * the segments; unfolding or folding (`home-dashboard.tsx`) it rides its segment's snapshot
 * instead, so it arrives and leaves with the board rather than fading in settled.
 *
 * The line and the heading hold still while a board is open (the board's slot keeps one height),
 * so the motion lives in the board, and it says where the board came from: switching, the
 * outgoing board drifts toward the segment left behind and the new one arrives from the side of
 * the segment pressed, the way the pill travels (`next` or `previous`).
 *
 * Unfolding and folding re-centre the stage, so the heading and the line travel. The board then
 * travels with them as one piece: fixed under the line, on the same curve, fading in as it rides
 * up into place or out as it rides down with the folding line (`unfold`, `fold`). Its snapshot has
 * no other side to glide from, so the line's measured travel (`anchor`, before and after the
 * update) is handed to the CSS as `--home-line-travel`. Growing the board's area out of the line,
 * unrolling it, or fading it in place while the line moved past it were each turned down: the
 * board and the line moved differently, and the page read as coming apart.
 *
 * Without typed transitions, or under reduced motion, it simply changes.
 */
export type MorphKind = 'next' | 'previous' | 'unfold' | 'fold';

export function morph(kind: MorphKind, update: () => void, anchor?: HTMLElement | null) {
  if (
    typeof document === 'undefined' ||
    typeof document.startViewTransition !== 'function' ||
    typeof ViewTransition === 'undefined' ||
    !('types' in ViewTransition.prototype) ||
    prefersReducedMotion()
  ) {
    update();
    return;
  }
  const root = document.documentElement;
  const before = anchor?.getBoundingClientRect().top ?? 0;
  let travel = '0px';
  const transition = document.startViewTransition({
    update: () => {
      flushSync(update);
      travel = `${(anchor?.getBoundingClientRect().top ?? before) - before}px`;
      root.style.setProperty('--home-line-travel', travel);
    },
    types: ['home-board', `home-board-${kind}`],
  });
  // A transition cut short by the next one leaves the next one's travel in place.
  void transition.finished.finally(() => {
    if (root.style.getPropertyValue('--home-line-travel') === travel) {
      root.style.removeProperty('--home-line-travel');
    }
  });
}
