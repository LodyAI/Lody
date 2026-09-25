import * as stylex from '@stylexjs/stylex';
import { colors } from '../tokens/colors.stylex';
import { radius, space, text } from '../tokens/scales.stylex';

/**
 * A standing fact about the thing beside it: a plan tier, a machine's OS, a
 * status a row holds while nothing is happening.
 *
 * A Badge is the one part of this system that is on **no rung**. It sits on
 * whatever holds it — a page, a card, a menu row, a dialog panel — so it cannot
 * take a background from the ladder the way every other surface does: the
 * rules' own note about `hoverFill` and `selectedFill` collapsing on the
 * floating rung is what a badge would hit on three rungs out of six. Its fill
 * is therefore a film rather than a colour: the tone at a few percent over
 * *whatever is underneath*, which is the form `Button`'s destructive ghost
 * hover already takes. One declaration then reads correctly on every rung and
 * in both palettes.
 *
 * The words stay ink in every tone, and that is measured rather than preferred.
 * `warning` is `hsl(32 90% 48%)` in the light palette, which is 2.8:1 on a
 * near-white surface — a colour tuned for a 16px mark and a tint, where 3:1 is
 * the bar, used as 11px text where the bar is 4.5:1. A badge is never wordless,
 * so unlike an Alert's mark it does not need colour to say which kind it is:
 * the tint carries the tone and the word carries the fact.
 *
 * Which neutral ink carries it is a second measurement, and it went the other
 * way: see `label` below.
 */
export const badge = stylex.defineVars({
  // A 20px chip on the 16px corner: the rules put `radius.mini` on the small
  // things, and the control ladder starts four pixels above this.
  height: '20px',
  radius: radius.mini,
  paddingX: space[1.5],
  gap: space[1],
  // What a caller's glyph is given, because this package's glyphs state 100% of
  // whatever holds them and StyleX has no descendant selector to reach one
  // with. It is the menu row's leading box at a badge's scale.
  glyphSize: '12px',
  /**
   * The neutral word, and the ink every tone's word is pulled toward.
   *
   * `label`, not `secondaryLabel`. Metadata is *about* the thing it sits beside,
   * which is the reading that first gave this `secondaryLabel` — but a badge's
   * word sits on the badge's own film rather than on the page, and measured
   * there `secondaryLabel` was 3.9:1 on a danger chip and 3.4:1 on one inside a
   * popup, under the 4.5:1 that 11px text needs. It was under it before the
   * films were strengthened; the tint only made a failing number worse.
   *
   * A badge stays quieter than the thing it is attached to by taking the
   * caption step, which is a size — not by taking a colour that cannot carry
   * its own words.
   */
  label: colors.label,
  labelSize: text.captionSize,
  labelLeading: text.captionLeading,
  /**
   * The word carries the tone, and that is the part of this chip a person
   * actually reads.
   *
   * The rules say not to colour a badge's words with its tone, and the
   * measurement behind that rule stands: the **raw** `warning` is 2.8:1 on a
   * near-white surface, a colour tuned for a 16px mark where the bar is 3:1,
   * used as 11px text where it is 4.5:1. What the rule left out is that the raw
   * tone is not the only way to carry a hue. Pulled **halfway to `label`**, a
   * tone keeps its hue and gains the ink's contrast: measured on its own chip,
   * on every rung and in both palettes, the worst of the four is 5.2:1.
   *
   * This is what the film alone could not do. A 20px chip's tint is a wash a
   * few percent off its surface; its word is the mark a person looks at. In the
   * light palette the four words land 0.097 apart in oklab at the closest, and
   * in the dark palette 0.048 — against 0.030 and 0.035 for the films they sit
   * on. The dark palette is where this earns its place: there `accent` is a
   * pale peach and `warning` an amber, twenty-six degrees apart, so their films
   * are two brown washes and no percentage separates them. Their words are a
   * peach and a gold, at four times the chroma.
   *
   * Half is not a round number chosen for tidiness. At 60% of the tone the
   * worst word is 4.2:1 — under the bar on the floating rung, where the chip is
   * already a step darker — and at 40% the hues start washing out. Half clears
   * the bar with room on every rung and keeps the chroma that makes the point.
   *
   * `label` itself is the fifth: a neutral badge has no tone to carry.
   */
  runningLabel: `color-mix(in oklab, ${colors.accent} 50%, ${colors.label})`,
  successLabel: `color-mix(in oklab, ${colors.success} 50%, ${colors.label})`,
  warningLabel: `color-mix(in oklab, ${colors.warning} 50%, ${colors.label})`,
  dangerLabel: `color-mix(in oklab, ${colors.destructive} 50%, ${colors.label})`,
  /**
   * The films. `label` is far stronger against either palette's background than
   * any of the tones, so the neutral one stays thinner than the rest.
   *
   * 12 and 22 rather than the 8 and 14 these started at. At the first strength
   * the five tones were not far enough apart to be told apart: measured off the
   * rendered board, the closest pair was 0.019 in oklab in the light palette
   * (neutral against success) and 0.026 in the dark one (running against
   * warning). At 12/22 those are 0.030 and 0.035. It is still a film — the word
   * is what says which tone this is, and the tint only has to make that
   * believable at a glance — but a film nobody can separate is a film doing
   * nothing.
   */
  neutralFill: `color-mix(in oklab, ${colors.label} 12%, transparent)`,
  // The one tone the message family does not have, and `Progress` does: a badge
  // marking something that is happening now takes the colour the rules give
  // live state by name. It is the film, not the words — the accent is never a
  // fill a person presses, and a badge is nothing a person presses.
  runningFill: `color-mix(in oklab, ${colors.accent} 22%, transparent)`,
  successFill: `color-mix(in oklab, ${colors.success} 22%, transparent)`,
  warningFill: `color-mix(in oklab, ${colors.warning} 22%, transparent)`,
  dangerFill: `color-mix(in oklab, ${colors.destructive} 22%, transparent)`,
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced
 * palette; see `button.tokens.stylex.ts` for why a group declared only at the
 * document root keeps the root palette inside a themed subtree.
 */
export const badgePaletteTheme = stylex.createTheme(badge, {
  label: colors.label,
  runningLabel: `color-mix(in oklab, ${colors.accent} 50%, ${colors.label})`,
  successLabel: `color-mix(in oklab, ${colors.success} 50%, ${colors.label})`,
  warningLabel: `color-mix(in oklab, ${colors.warning} 50%, ${colors.label})`,
  dangerLabel: `color-mix(in oklab, ${colors.destructive} 50%, ${colors.label})`,
  neutralFill: `color-mix(in oklab, ${colors.label} 12%, transparent)`,
  runningFill: `color-mix(in oklab, ${colors.accent} 22%, transparent)`,
  successFill: `color-mix(in oklab, ${colors.success} 22%, transparent)`,
  warningFill: `color-mix(in oklab, ${colors.warning} 22%, transparent)`,
  dangerFill: `color-mix(in oklab, ${colors.destructive} 22%, transparent)`,
});
