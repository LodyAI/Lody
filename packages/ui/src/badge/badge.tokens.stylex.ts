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
  // Metadata is *about* the thing it sits beside rather than the thing itself,
  // which is what the rules give `secondaryLabel`, and it takes the caption
  // step the rules give a row's trailing metadata.
  label: colors.secondaryLabel,
  labelSize: text.captionSize,
  labelLeading: text.captionLeading,
  // The films. `label` is far stronger against either palette's background than
  // any of the tones, so the neutral one is thinner; the tones sit at the
  // strength a destructive menu row's highlight uses, which is the mix this
  // system already trusts to read on a surface without becoming a fill.
  neutralFill: `color-mix(in oklab, ${colors.label} 8%, transparent)`,
  // The one tone the message family does not have, and `Progress` does: a badge
  // marking something that is happening now takes the colour the rules give
  // live state by name. It is the film, not the words — the accent is never a
  // fill a person presses, and a badge is nothing a person presses.
  runningFill: `color-mix(in oklab, ${colors.accent} 14%, transparent)`,
  successFill: `color-mix(in oklab, ${colors.success} 14%, transparent)`,
  warningFill: `color-mix(in oklab, ${colors.warning} 14%, transparent)`,
  dangerFill: `color-mix(in oklab, ${colors.destructive} 14%, transparent)`,
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced
 * palette; see `button.tokens.stylex.ts` for why a group declared only at the
 * document root keeps the root palette inside a themed subtree.
 */
export const badgePaletteTheme = stylex.createTheme(badge, {
  label: colors.secondaryLabel,
  neutralFill: `color-mix(in oklab, ${colors.label} 8%, transparent)`,
  runningFill: `color-mix(in oklab, ${colors.accent} 14%, transparent)`,
  successFill: `color-mix(in oklab, ${colors.success} 14%, transparent)`,
  warningFill: `color-mix(in oklab, ${colors.warning} 14%, transparent)`,
  dangerFill: `color-mix(in oklab, ${colors.destructive} 14%, transparent)`,
});
