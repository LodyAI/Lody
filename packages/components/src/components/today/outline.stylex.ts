import * as stylex from '@stylexjs/stylex';

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
