import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { control, radius, space, text } from '../tokens/scales.stylex';

/**
 * One token group for a control that stays pressed, a set of them, and the bar
 * that holds them.
 *
 * They are one family for the reason `disclosure` covers three layouts of one
 * idea: a `ToggleGroup` is a row of `Toggle`s that answer to one value and a
 * `Toolbar` is the row itself, so what a pressed control looks like and how far
 * apart two of them stand cannot become three decisions in three files.
 *
 * It is deliberately not the `field` group. A Switch stores a value in a form —
 * it takes a name, answers to a `Field.Root` and can be invalid — while a
 * Toggle states that an option is on right now: bold, wrapped lines, this
 * filter. Nothing here has a name, a validity or a message under it.
 *
 * The size ladder is `control`'s rather than `Button`'s, though a Button and a
 * Toggle standing in one bar have to line up. They line up because both read
 * the same scale, not because one reads the other's group: a component group is
 * not another component's to name, which is the rule that keeps a menu from
 * reaching for `field.background`. `mini` is off that ladder, so it is stated
 * here the way `Button` states its own.
 */
export const toggle = stylex.defineVars({
  heightMini: '24px',
  heightSmall: control.small,
  heightMedium: control.medium,
  heightLarge: control.large,
  paddingXMini: '8px',
  paddingXSmall: '10px',
  paddingXMedium: '12px',
  paddingXLarge: '14px',
  radiusMini: '6px',
  radiusSmall: radius.small,
  radiusMedium: radius.medium,
  textMini: text.footnoteSize,
  text: text.subheadlineSize,
  gap: '6px',
  // What a toggle holds: the 16 every other holder in this package gives a
  // glyph, because this package's icons state 100% of whatever holds them.
  iconSize: '16px',
  // At rest a toggle is a ghost Button — it is about the thing it acts on — and
  // under the pointer it becomes the thing.
  label: colors.secondaryLabel,
  hover: colors.hoverFill,
  activeLabel: colors.label,
  /**
   * Pressed is the well rung: `wellBackground` under `shadow.inset`, which is
   * the pair the ladder gives every sunken thing here.
   *
   * The rules say ink is for a stored state, and a toggle does store one — but
   * ink is what a control that **already sits in a well** becomes when it is on.
   * A Switch's off state occupies the well, so on has to leave it; a Checkbox's
   * empty box is the same. A toggle rests on nothing at all, so the well is
   * still free, and sinking into it is the plainest thing this system can say
   * about a button that has been pressed and stayed down. It also keeps a bar
   * of eight toggles from reading as eight primary buttons.
   */
  pressedBackground: colors.wellBackground,
  pressedWell: shadow.inset,
  // Between the members of one set: they answer to one value, so they stand
  // closer than the clusters of a bar do.
  groupGap: space[1],
  // Between the clusters of a bar, and either side of the line between two.
  barGap: space[2],
  ring: colors.accent,
  ringWidth: '2px',
  // The family's one disabled value; the rules give the whole control 45%.
  disabledOpacity: '0.45',
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced
 * palette; see `button.tokens.stylex.ts` for why a group declared only at the
 * document root keeps the root palette inside a themed subtree.
 */
export const togglePaletteTheme = stylex.createTheme(toggle, {
  label: colors.secondaryLabel,
  hover: colors.hoverFill,
  activeLabel: colors.label,
  pressedBackground: colors.wellBackground,
  pressedWell: shadow.inset,
  ring: colors.accent,
});
