import * as stylex from '@stylexjs/stylex';

/**
 * The settings type scale, as multiples of the person's `--ui-font-size`
 * (14px by default). Sizes are computed from the root size rather than `em`,
 * so a caption inside a heading, or a title inside a dialog's own `h2`, cannot
 * compound into a size the scale does not have.
 *
 * Three sizes and two weights. Settings is mostly Chinese or English prose in
 * short lines: nothing is smaller than `caption` (12px at the default size —
 * below it a Han character's strokes close up), and anything that stacks takes
 * `leading` (CJK has no descenders to open the gap between lines). Weight is a
 * heading's job only: Chinese falls back to PingFang, where every step above
 * regular is heavier than Inter's, so labels, helpers and values stay regular
 * and a heading is medium. Only a page's title is semibold. Controls keep
 * `@lody/ui`'s own control size and weight.
 */
export const settingsType = stylex.defineConsts({
  /** Section headings' companions: helper lines, meta, counts, notes. */
  caption: 'calc(var(--ui-font-size, 14px) * 0.857)',
  /** A page's own title, above its sections. */
  title: 'calc(var(--ui-font-size, 14px) * 1.286)',
  /** Line height for a label, a helper, and anything else that stacks. */
  leading: '1.45',
  /** A section heading or a group's name. */
  headingWeight: '500',
  /** A page's title, the one semibold string on the page. */
  titleWeight: '600',
});
