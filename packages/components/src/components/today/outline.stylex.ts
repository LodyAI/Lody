import * as stylex from '@stylexjs/stylex';
import { createContext } from 'react';

/**
 * At the window's edge (pinned, sidebar hidden) a top row has no margin left
 * of its fold toggle, so the row's "⋯" button sits at the row's end instead.
 */
export const TodayMoreAtEndContext = createContext(false);

/** Today outline geometry shared by the rows and the surface around them. */
export const todayOutline = stylex.defineConsts({
  /**
   * How far a row's fold toggle hangs left of the text column, so the bullet
   * dot's left edge lines up with the date heading: the 12px toggle (it sits
   * flush against the bullet box) + the dot's inset in its 16px box (5). The
   * toggle's centre is 14px left of the dot's. The surface reserves it beyond
   * its gutter.
   */
  foldOverhang: '17px',
});

/** The scroll surface: a zoomed node without children shows its "+" while it is hovered. */
export const todaySurfaceMarker = stylex.defineMarker();
