import { prefersReducedMotion } from './tiles';

/**
 * The motion of a "now" list opening over its board and closing back into its tile
 * (`now-board.tsx`). Real elements animated with the Web Animations API, never snapshots, so the
 * list is live while it moves and a press midway turns it around from where it is.
 *
 * The list's frame is the tile at the tile's size: the frame's own box moves between the tile's
 * and the board's (its head lays out at every size, so the title and count keep the tile's
 * places), its rows hold the board's width throughout (so they never reflow, and the first
 * column is the tile's rows), and a stand-in sits where the tile's "Show all" was. Both ends of
 * the motion are therefore the tile itself, and the swap with the real tile cannot be seen.
 * Positions are offsets, not client rects, so the board's step back does not skew them, and
 * closing measures the tile again.
 *
 * Choreographed, not simultaneous: one thing leads at a time, so the eye has something to follow.
 * - Opening. The rest of the board steps back (scaling toward the pressed tile and dimming
 *   out) as the frame grows. The stand-in goes at once; what the tile did not have (the rows it
 *   hid and the way back) rises in while the frame grows, a few rows at a time, so it reads as
 *   more of the same list coming out.
 * - Closing is its own motion, not opening played backwards (a finished ease-out reversed starts
 *   slowly): the list scrolls home, the extra rows go first and quickly, the frame lands in its
 *   tile without bouncing, the stand-in returns as it lands, and the board comes forward with it.
 *
 * Motion is springs, written as CSS `linear()` easings: their speed follows the distance, the
 * bulk of the move is over in about a third of a second, and they settle without a visible tail.
 */

type Box = { top: number; left: number; right: number; bottom: number };

export type FocusParts = {
  /** The board's box, which the opened frame fills. */
  stage: HTMLElement;
  /** The pressed tile, hidden under the frame while it is open. */
  tile: HTMLElement;
  /** The opened list's frame. */
  frame: HTMLElement;
  /** The frame's scrolling rows, held at the board's width while the frame moves. */
  rows: HTMLElement;
  /** The board under it, which steps back. */
  board: HTMLElement;
  /** What the tile did not show, which rises in while the frame grows. */
  late: readonly HTMLElement[];
  /** What only the tile showed (its "Show all"), there at the tile's size only. */
  early: readonly HTMLElement[];
};

/**
 * The spring constants (response: the period of the undamped spring, in seconds; damping: 1 for
 * no overshoot, lower for a little) and the depth the board steps back to. `slow` multiplies
 * every time, for looking at the motion frame by frame (Storybook's `ShowAllMotion`).
 */
export type FocusTuning = {
  openResponse: number;
  openDamping: number;
  closeResponse: number;
  closeDamping: number;
  /** The board's scale when stepped back. */
  depth: number;
  slow: number;
};

export const FOCUS_TUNING: FocusTuning = {
  openResponse: 0.5,
  openDamping: 0.86,
  closeResponse: 0.4,
  closeDamping: 1,
  depth: 0.94,
  slow: 1,
};

let tuning: FocusTuning = FOCUS_TUNING;

/** Storybook's knobs; the product never calls it. */
export function tuneFocusMotion(next: Partial<FocusTuning>): void {
  tuning = { ...FOCUS_TUNING, ...next };
}

const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)';
/** Rows that rise in one after another; the rest come with the last of them. */
const STAGGERED_ROWS = 8;

type Spring = { easing: string; duration: number };

const springCache = new Map<string, Spring>();

/**
 * A spring from rest at 0 to 1 as a `linear()` easing and the time it takes to settle within a
 * thousandth. Falls back to an ease-out of the same length where `linear()` is not supported.
 */
export function spring(response: number, damping: number): Spring {
  const cacheKey = `${response}:${damping}`;
  const cached = springCache.get(cacheKey);
  if (cached) return cached;
  const omega = (2 * Math.PI) / response;
  const zeta = Math.min(Math.max(damping, 0.1), 1);
  const position = (t: number) => {
    if (zeta >= 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    return (
      1 -
      Math.exp(-zeta * omega * t) *
        (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t))
    );
  };
  // Settled once the motion that is left can no longer be seen.
  let settle = 0.05;
  const step = 1 / 240;
  for (let t = 0; t < 3; t += step) {
    if (Math.exp(-zeta * omega * t) * (1 + omega * t) < 0.001) {
      settle = t;
      break;
    }
  }
  const samples = Math.max(12, Math.ceil(settle * 60));
  const points: string[] = [];
  for (let index = 0; index <= samples; index += 1) {
    points.push(position((settle * index) / samples).toFixed(4));
  }
  points[samples] = '1';
  const supported =
    typeof CSS !== 'undefined' && CSS.supports?.('animation-timing-function', 'linear(0, 1)');
  const result = {
    easing: supported ? `linear(${points.join(', ')})` : EASE_OUT,
    duration: settle * 1000,
  };
  springCache.set(cacheKey, result);
  return result;
}

export function canAnimateFocus(element: Element | null): element is HTMLElement {
  return (
    element != null &&
    typeof (element as HTMLElement).animate === 'function' &&
    !prefersReducedMotion()
  );
}

/** The tile's box inside the board, as insets, from offsets (which ignore transforms). */
function tileBox(stage: HTMLElement, tile: HTMLElement): Box {
  let top = 0;
  let left = 0;
  let element: HTMLElement | null = tile;
  while (element && element !== stage) {
    top += element.offsetTop;
    left += element.offsetLeft;
    element = element.offsetParent as HTMLElement | null;
  }
  return {
    top,
    left,
    right: stage.clientWidth - left - tile.offsetWidth,
    bottom: stage.clientHeight - top - tile.offsetHeight,
  };
}

const px = (box: Box) => ({
  top: `${box.top}px`,
  left: `${box.left}px`,
  right: `${box.right}px`,
  bottom: `${box.bottom}px`,
});
const WHOLE = { top: '0px', left: '0px', right: '0px', bottom: '0px' };

/** The frame's horizontal padding (`tileStyles.tile`), which the held rows leave room for. */
const FRAME_PADDING_PX = 2 * 10;

/**
 * One list's motion, from opening to gone. `close` resolves `true` once it is back in its tile,
 * or `false` when it was turned around (or cancelled) first.
 */
export class FocusMotion {
  private animations: Animation[] = [];
  private phase: 'opening' | 'closing' = 'opening';
  private box: Box;

  constructor(private readonly parts: FocusParts) {
    this.box = tileBox(parts.stage, parts.tile);
    this.hold();
    this.animations = this.opening();
    this.releaseWhenOpen();
  }

  /** While the frame moves: rows at the board's width with no scrollbar, and the board's
      centre of depth at the tile. */
  private hold(): void {
    const { stage, tile, rows, board } = this.parts;
    rows.style.width = `${stage.clientWidth - FRAME_PADDING_PX}px`;
    rows.style.overflowY = 'hidden';
    board.style.transformOrigin = `${this.box.left + tile.offsetWidth / 2}px ${
      this.box.top + tile.offsetHeight / 2
    }px`;
  }

  /** Open and still: the rows follow the board again, so a window resize reflows them. */
  private release(): void {
    this.parts.rows.style.width = '';
    this.parts.rows.style.overflowY = '';
  }

  private releaseWhenOpen(): void {
    void this.settled('opening').then((open) => {
      if (open) this.release();
    });
  }

  private opening(): Animation[] {
    const { frame, board, late, early } = this.parts;
    const slow = tuning.slow;
    const grow = spring(tuning.openResponse, tuning.openDamping);
    const back = spring(tuning.closeResponse, 1);
    return [
      frame.animate([px(this.box), WHOLE], {
        duration: grow.duration * slow,
        easing: grow.easing,
        fill: 'both',
      }),
      board.animate(
        [
          { transform: 'scale(1)', opacity: 1 },
          { transform: `scale(${tuning.depth})`, opacity: 0 },
        ],
        { duration: back.duration * slow, easing: back.easing, fill: 'both' }
      ),
      ...early.map((element) =>
        element.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 80 * slow,
          easing: 'linear',
          fill: 'both',
        })
      ),
      ...late.map((element, index) =>
        element.animate(
          [
            { opacity: 0, transform: 'translateY(4px)' },
            { opacity: 1, transform: 'translateY(0px)' },
          ],
          {
            duration: 200 * slow,
            delay: (30 + Math.min(index, STAGGERED_ROWS) * 14) * slow,
            easing: EASE_OUT,
            fill: 'both',
          }
        )
      ),
    ];
  }

  private closing(): Animation[] {
    const { frame, board, late, early } = this.parts;
    const slow = tuning.slow;
    const land = spring(tuning.closeResponse, tuning.closeDamping);
    const lands = land.duration * slow;
    return [
      ...late.map((element) =>
        element.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 90 * slow,
          easing: 'linear',
          fill: 'both',
        })
      ),
      frame.animate([WHOLE, px(this.box)], {
        duration: lands,
        delay: 40 * slow,
        easing: land.easing,
        fill: 'both',
      }),
      // The tile's "Show all" returns as the frame arrives (nine tenths of the way at 35%).
      ...early.map((element) =>
        element.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 120 * slow,
          delay: 40 * slow + lands * 0.35,
          easing: 'linear',
          fill: 'both',
        })
      ),
      // The board comes forward as the frame lands, arriving with it.
      board.animate(
        [
          { transform: `scale(${tuning.depth})`, opacity: 0 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        { duration: lands, delay: 100 * slow, easing: land.easing, fill: 'both' }
      ),
    ];
  }

  private running(): boolean {
    return this.animations.some((animation) => animation.playState === 'running');
  }

  private async settled(phase: 'opening' | 'closing'): Promise<boolean> {
    const animations = this.animations;
    try {
      await Promise.all(animations.map((animation) => animation.finished));
    } catch {
      return false;
    }
    return this.animations === animations && this.phase === phase;
  }

  close(): Promise<boolean> {
    if (this.phase === 'closing') return this.settled('closing');
    this.phase = 'closing';
    if (this.running()) {
      // Still opening: turn the same motion around from where it is.
      for (const animation of this.animations) animation.reverse();
    } else {
      // The tile may have moved while the list was open: land where it is now.
      this.box = tileBox(this.parts.stage, this.parts.tile);
      this.parts.rows.scrollTop = 0;
      this.hold();
      const previous = this.animations;
      // The new motion holds its first frame (`fill: both`) before the old one lets go.
      this.animations = this.closing();
      for (const animation of previous) animation.cancel();
    }
    return this.settled('closing');
  }

  /** Back toward open from wherever the close has got to. */
  reopen(): void {
    if (this.phase === 'opening') return;
    this.phase = 'opening';
    for (const animation of this.animations) animation.reverse();
    this.releaseWhenOpen();
  }

  get closingNow(): boolean {
    return this.phase === 'closing';
  }

  cancel(): void {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.release();
    this.parts.board.style.transformOrigin = '';
  }
}
