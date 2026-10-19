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
 * instead, so it arrives and leaves with the board rather than fading in settled. Without typed
 * transitions, or under reduced motion, it simply changes.
 */
export function morph(update: () => void) {
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
  document.startViewTransition({ update: () => flushSync(update), types: ['home-board'] });
}
