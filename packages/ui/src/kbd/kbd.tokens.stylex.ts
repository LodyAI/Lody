import * as stylex from '@stylexjs/stylex';
import { colors } from '../tokens/colors.stylex';
import { radius, space, text } from '../tokens/scales.stylex';

/**
 * A key on the keyboard, drawn where the interface has to name one.
 *
 * The rules name it by name: `gray…gray6` is for things with no role, "a
 * scrollbar, a kbd, a skeleton". A key cap is the clearest case of that — it
 * stands for a physical object rather than for anything this interface holds,
 * so none of the semantic colours is about it. `accent` would claim it is live,
 * ink would claim it is stored, and a tone would claim it reported something.
 *
 * It is not a control and never becomes one: no hover, no focus ring, no
 * pressed state. A caption that says which keys to press is metadata about the
 * command beside it, which is why the words take `secondaryLabel` and the
 * caption step — the same reading a Badge takes, one rung of meaning below the
 * thing it is attached to.
 *
 * A menu row's shortcut is deliberately **not** this. The rules give that slot
 * plain trailing metadata in `popup.hint`, because a menu is already a list of
 * rows with a leading box and a label and a chevron, and a row of chips down
 * its right edge turns a quiet list into a keyboard diagram. A key cap is for
 * where the keys are the subject: a command palette, a shortcuts sheet, a
 * tooltip that teaches one.
 */
export const kbd = stylex.defineVars({
  // A badge's height, because the two are the same kind of thing — a small
  // standing fact beside a line of text — and a row carrying one of each would
  // otherwise have two baselines.
  height: '20px',
  // A single key is square-ish rather than a sliver: `Shift` is wide, `K` is
  // one character, and a chord whose caps jump between 8 and 40 pixels wide
  // reads as noise. The floor is the height.
  minWidth: '20px',
  paddingX: space[1],
  // Between the caps of one chord. They are one gesture, so they sit closer
  // than two separate chords would.
  gap: space[1],
  radius: radius.mini,
  background: colors.gray5,
  label: colors.secondaryLabel,
  labelSize: text.captionSize,
  labelLeading: text.captionLeading,
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced
 * palette; see `button.tokens.stylex.ts` for why a group declared only at the
 * document root keeps the root palette inside a themed subtree.
 */
export const kbdPaletteTheme = stylex.createTheme(kbd, {
  background: colors.gray5,
  label: colors.secondaryLabel,
});
