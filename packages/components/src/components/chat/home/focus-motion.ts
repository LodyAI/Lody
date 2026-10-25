import { prefersReducedMotion } from './tiles';

/**
 * The motion of a "now" list opening over its column and closing back into its tile
 * (`now-board.tsx`). Real elements animated with the Web Animations API, never snapshots, so the
 * list is live while it moves and a press midway turns it around from where it is.
 *
 * The list's frame is the tile at the tile's size: the frame's own box moves between the tile's
 * and its column's (its head lays out at every size, so the title and count keep the tile's
 * places), and its rows hold the column's width, the tile's, throughout (so they never reflow).
 * `stage` and `board` are the column, not the whole board: the other column stays as it is. Both
 * ends of the motion are therefore the tile itself, and the swap with the real tile cannot be
 * seen. Positions are offsets, not client rects, so the board's step back does not skew them, and
 * closing measures the tile again.
 *
 * Choreographed, not simultaneous: one thing leads at a time, so the eye has something to follow.
 * - Opening. The rest of its column steps back (scaling toward the pressed tile and dimming out)
 *   as the frame grows. The tile's "Show all" goes at once; what the tile did not have (the rows
 *   it hid, and "Show less" at the foot) rises in while the frame grows, a few rows at a time, so
 *   it reads as more of the same list coming out.
 * - Closing is one motion, not opening played backwards (a finished ease-out reversed starts
 *   slowly) and not a sequence: the list scrolls home, and at once the frame lands in its tile on
 *   the same spring it opened with while the board comes forward with it; what the tile does not
 *   show is clipped by the shrinking frame and fades over its first third, and the tile's "Show
 *   all" fades back in as it lands, so the real tile replaces it unseen. Letting the extra rows
 *   leave first and the frame and board follow on delays read as things leaving one after another,
 *   the pace dropping halfway.
 *
 * Motion is springs, written as CSS `linear()` easings: their speed follows the distance, the
 * bulk of the move is over in about a third of a second, and they settle without a visible tail.
 */

type Box = { top: number; left: number; right: number; bottom: number };

export type FocusParts = {
  /** The column's box, which the opened frame fills. */
  stage: HTMLElement;
  /** The pressed tile, hidden under the frame while it is open. */
  tile: HTMLElement;
  /** The opened list's frame. */
  frame: HTMLElement;
  /** The frame's scrolling rows (the scroll area's viewport), scrolled home before closing. */
  rows: HTMLElement;
  /** The rest of the column under it, which steps back. */
  board: HTMLElement;
  /** What the tile did not show, which rises in while the frame grows. */
  late: readonly HTMLElement[];
  /**
   * What only the tile shows (a stand-in for its "Show all"), there at the tile's size only: it
   * goes as the frame leaves the tile and is back by the time it lands, so the swap with the
   * real tile shows nothing appearing.
   */
  early: readonly HTMLElement[];
};

/**
 * The one spring that opening and closing share (response: the period of the undamped spring,
 * in seconds; damping: 1 for no overshoot, lower for a little), so the list leaves exactly as it
 * came, and the depth the board steps back to. `slow` multiplies every time, for looking at the
 * motion frame by frame (Storybook's `ShowAllMotion`).
 */
export type FocusTuning = {
  response: number;
  damping: number;
  /** The board's scale when stepped back. */
  depth: number;
  slow: number;
};

/* About 95% of the way at 256ms, a hint of give (0.15% past) and settled by about 660ms. Opening
   once used a softer spring (0.5s, 0.86) and closing a stiffer one (0.3s, 1); the two read as
   two different things. */
export const FOCUS_TUNING: FocusTuning = {
  response: 0.4,
  damping: 0.9,
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

/** Where every moving part is right now, read from the running animations. */
type Pose = {
  frame: Keyframe;
  board: Keyframe;
  late: Keyframe[];
  early: Keyframe[];
};

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

  /**
   * While the frame moves: marked moving (its scrollbar stays hidden, `now-board.tsx`), and the
   * column's centre of depth at the tile. The frame keeps the column's width throughout (a tile
   * is as wide as its column), so its rows never reflow and need no holding.
   */
  private hold(): void {
    const { tile, frame, board } = this.parts;
    frame.dataset.focusMoving = '';
    board.style.transformOrigin = `${this.box.left + tile.offsetWidth / 2}px ${
      this.box.top + tile.offsetHeight / 2
    }px`;
  }

  /** Open and still: the scrollbar may show again. */
  private release(): void {
    delete this.parts.frame.dataset.focusMoving;
  }

  private releaseWhenOpen(): void {
    void this.settled('opening').then((open) => {
      if (open) this.release();
    });
  }

  /**
   * Where the motion is now. A turn starts a new motion from here rather than reversing the old
   * one: a spring's settling tail is long and unseen (opening looks done at about 300ms and ends
   * at about 870ms), so played backwards it held still while the rows faded and only then moved.
   */
  private pose(): Pose {
    const { frame, board, late, early } = this.parts;
    const style = getComputedStyle(frame);
    const boardStyle = getComputedStyle(board);
    return {
      frame: { top: style.top, left: style.left, right: style.right, bottom: style.bottom },
      board: { transform: boardStyle.transform, opacity: boardStyle.opacity },
      late: late.map((element) => {
        const lateStyle = getComputedStyle(element);
        return { opacity: lateStyle.opacity, transform: lateStyle.transform };
      }),
      early: early.map((element) => ({ opacity: getComputedStyle(element).opacity })),
    };
  }

  /** Replaces the running motion with `next`, which holds its first frame before the old goes. */
  private turn(next: (from: Pose | null) => Animation[]): void {
    const from = this.running() ? this.pose() : null;
    const previous = this.animations;
    this.animations = next(from);
    for (const animation of previous) animation.cancel();
  }

  private opening(from: Pose | null = null): Animation[] {
    const { frame, board, late, early } = this.parts;
    const slow = tuning.slow;
    const move = spring(tuning.response, tuning.damping);
    const moves = move.duration * slow;
    return [
      frame.animate([from?.frame ?? px(this.box), WHOLE], {
        duration: moves,
        easing: move.easing,
        fill: 'both',
      }),
      board.animate(
        [
          from?.board ?? { transform: 'scale(1)', opacity: 1 },
          { transform: `scale(${tuning.depth})`, opacity: 0 },
        ],
        { duration: moves, easing: move.easing, fill: 'both' }
      ),
      // The tile's "Show all" goes as soon as the frame leaves the tile.
      ...early.map((element, index) =>
        element.animate([from?.early[index] ?? { opacity: 1 }, { opacity: 0 }], {
          duration: 80 * slow,
          easing: 'linear',
          fill: 'both',
        })
      ),
      ...late.map((element, index) =>
        element.animate(
          [
            from?.late[index] ?? { opacity: 0, transform: 'translateY(4px)' },
            { opacity: 1, transform: 'translateY(0px)' },
          ],
          {
            duration: 200 * slow,
            // Turned back mid-close, the rows are already on their way: no stagger.
            delay: from ? 0 : (30 + Math.min(index, STAGGERED_ROWS) * 14) * slow,
            easing: EASE_OUT,
            fill: 'both',
          }
        )
      ),
    ];
  }

  private closing(from: Pose | null = null): Animation[] {
    const { frame, board, late, early } = this.parts;
    const slow = tuning.slow;
    // The same spring as opening: the list leaves exactly as it came.
    const move = spring(tuning.response, tuning.damping);
    const moves = move.duration * slow;
    // One start for everything: the frame, the board and the rows it takes away move together.
    return [
      frame.animate([from?.frame ?? WHOLE, px(this.box)], {
        duration: moves,
        easing: move.easing,
        fill: 'both',
      }),
      board.animate(
        [
          from?.board ?? { transform: `scale(${tuning.depth})`, opacity: 0 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        { duration: moves, easing: move.easing, fill: 'both' }
      ),
      // Clipped by the shrinking frame anyway; the fade keeps them from showing cut. The spring
      // covers most of its distance in its first third, so they are gone by then.
      ...late.map((element, index) =>
        element.animate([from?.late[index] ?? { opacity: 1 }, { opacity: 0 }], {
          duration: moves * 0.35,
          easing: 'linear',
          fill: 'both',
        })
      ),
      // The tile's "Show all" is back as the frame arrives (about three quarters of the way at a
      // fifth of the motion, nearly all of it by two fifths), so the real tile replaces it unseen.
      ...early.map((element, index) =>
        element.animate([from?.early[index] ?? { opacity: 0 }, { opacity: 1 }], {
          duration: moves * 0.2,
          delay: moves * 0.2,
          easing: 'linear',
          fill: 'both',
        })
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
    // Read where the motion is before anything changes, then land where the tile is now (it may
    // have moved while the list was open), everything starting together from there.
    const from = this.running() ? this.pose() : null;
    this.box = tileBox(this.parts.stage, this.parts.tile);
    this.parts.rows.scrollTop = 0;
    this.hold();
    this.turn(() => this.closing(from));
    return this.settled('closing');
  }

  /** Back toward open from wherever the close has got to. */
  reopen(): void {
    if (this.phase === 'opening') return;
    this.phase = 'opening';
    this.turn((from) => this.opening(from));
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
