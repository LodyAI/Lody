/**
 * The "there is more here" fade for a scrollable strip.
 *
 * A mask rather than an overlay gradient: these strips float over surfaces
 * whose colour the overlay would have to guess, and an opaque
 * `from-background` band would repaint whatever sits behind them.
 *
 * Shared because two surfaces need exactly this — the message queue and the
 * conversation outline rail — and they had drifted into separate copies of the
 * same gradient string, the same overflow epsilon, and the same
 * "return nothing when neither edge overflows" rule.
 */

/** Sub-pixel scroll offsets must not count as "there is more above". */
const OVERFLOW_EPSILON_PX = 1;

export interface ScrollEdgeOverflow {
  readonly top: boolean;
  readonly bottom: boolean;
}

export const NO_SCROLL_EDGE_OVERFLOW: ScrollEdgeOverflow = { top: false, bottom: false };

/** The element geometry {@link readScrollEdgeOverflow} needs. */
export type ScrollEdgeElement = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>;

/** Which edges of `element` currently have content beyond them. */
export function readScrollEdgeOverflow(element: ScrollEdgeElement): ScrollEdgeOverflow {
  const { scrollTop, scrollHeight, clientHeight } = element;
  return {
    top: scrollTop > OVERFLOW_EPSILON_PX,
    bottom: scrollTop + clientHeight < scrollHeight - OVERFLOW_EPSILON_PX,
  };
}

export function scrollEdgeOverflowEquals(a: ScrollEdgeOverflow, b: ScrollEdgeOverflow): boolean {
  return a.top === b.top && a.bottom === b.bottom;
}

/**
 * A `mask-image` that fades only the edges with content past them, so a strip
 * that has reached its end stops on a hard edge rather than implying more.
 *
 * Returns `undefined` when neither edge overflows — which is also the
 * not-scrollable case — so a short list pays for no mask and no extra
 * compositing layer.
 *
 * `fadeLengthPx` is per-surface: it should cover enough rows for the taper to
 * be visible, which depends on how tall and how contrasty those rows are.
 *
 * An edge that does not overflow is omitted, not drawn as a zero-length stop.
 * `transparent 0, #000 0` is what WKWebView gets for a list parked at the top
 * with more below, and it paints that masked layer solid black.
 */
export function buildScrollEdgeFadeMask(
  overflow: ScrollEdgeOverflow,
  fadeLengthPx: number
): string | undefined {
  if (!overflow.top && !overflow.bottom) return undefined;
  const fade = `${fadeLengthPx}px`;
  if (overflow.top && overflow.bottom) {
    return `linear-gradient(to bottom, transparent 0, #000 ${fade}, #000 calc(100% - ${fade}), transparent 100%)`;
  }
  if (overflow.bottom) {
    return `linear-gradient(to bottom, #000 0, #000 calc(100% - ${fade}), transparent 100%)`;
  }
  return `linear-gradient(to bottom, transparent 0, #000 ${fade}, #000 100%)`;
}
