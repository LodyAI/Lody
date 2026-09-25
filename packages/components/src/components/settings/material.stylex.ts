import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';

const RULE = `color-mix(in oklab, transparent, ${colors.label} 8%)`;

/**
 * How a settings group is drawn. By default a group is a card: the raised fill
 * with the card rung's hairline and contact shadow, its rows ruled apart and
 * its heading inset to the rows' copy — the grouped list the mobile settings
 * screens and the settings dialogs keep.
 *
 * The desktop settings pane and the project window take `settingsFlat`: a group
 * is a heading and rows on the page itself, with no box and no rule between
 * rows. A thin rule above each section is the only line, so a group without a
 * heading still ends where the next begins.
 */
export const settingsMaterial = stylex.defineVars({
  groupFill: colors.raisedBackground,
  groupShadow: shadow.card,
  groupRadius: radius.large,
  /** How far a group's rows reach past the column, so their copy meets the headings. */
  groupBleed: '0px',
  /** The rule between two rows of a group, as a box-shadow. */
  rowRule: `inset 0 1px 0 ${RULE}`,
  /** A pressable row's corners, for the fill under the pointer. */
  rowRadius: '0px',
  /** A heading's inset from the group's edge. */
  headingInset: space[4],
  /** The rule above a section, as a box-shadow, and the space under it. */
  sectionRule: 'none',
  sectionRuleGap: '0px',
  /** A group that destroys something, drawn on its edge. */
  dangerShadow: `0 0 0 0.5px color-mix(in oklab, ${colors.destructive} 45%, transparent), ${shadow.card}`,
  /** An empty catalog's region. */
  emptyFill: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
});

export const settingsFlat = stylex.createTheme(settingsMaterial, {
  groupFill: 'transparent',
  groupShadow: 'none',
  groupRadius: radius.medium,
  groupBleed: space[4],
  rowRule: 'none',
  rowRadius: radius.medium,
  headingInset: '0px',
  sectionRule: `inset 0 1px 0 ${RULE}`,
  sectionRuleGap: space[4],
  dangerShadow: 'none',
  emptyFill: 'transparent',
});
