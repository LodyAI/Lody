import * as stylex from '@stylexjs/stylex';

/** Today outline geometry shared by the rows and the surface around them. */
export const todayOutline = stylex.defineConsts({
  /**
   * How far a row's fold toggle hangs left of the text column, so the bullet
   * dot lines up with the date heading: toggle 16 + gap 4 + the dot's inset in
   * its 16px box (5). The surface reserves it beyond its gutter.
   */
  foldOverhang: '25px',
});
