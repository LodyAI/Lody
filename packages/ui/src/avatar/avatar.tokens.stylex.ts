import * as stylex from '@stylexjs/stylex';
import { colors } from '../tokens/colors.stylex';
import { radius, text } from '../tokens/scales.stylex';

/**
 * Who this is: a picture of a person, or the letters standing in for one.
 *
 * An avatar is the second part of this system on **no rung**, and for the same
 * reason a Badge is: it sits in a sidebar row, on a card, in a menu, on a modal
 * panel. Unlike a badge it is not a film, though, because what it stands in for
 * is opaque — a photograph — and a translucent stand-in would show the row's
 * hover through a face that never moves. So the fallback takes a **gray**,
 * which is exactly what the rules reserve the gray ramp for: a thing with no
 * role. `Skeleton` already took `gray5` for the same reason, and an avatar
 * waiting on an image and a block waiting on content are the same waiting.
 *
 * Five rungs, and each one carries its own step. The step is the point: the
 * deleted implementation had one size, `size-8`, and every one of its twenty
 * call sites re-stated both the box and the letters inside it — `h-5 w-5
 * text-[9px]`, `h-7 w-7 text-[11px]`, `h-9 w-9 text-[0.82rem]`, `h-16 w-16
 * text-xl` — which is two facts a surface had to keep in step and eight
 * different answers about what "two letters in a circle" means. Here the box
 * picks the letters, and a caller names the rung.
 */
export const avatar = stylex.defineVars({
  // 16 is the glyph box every other holder in this package draws, so a mini
  // avatar is a face where an icon would otherwise be: in a line of text, in a
  // menu row, beside a filename.
  sizeMini: '16px',
  sizeSmall: '20px',
  sizeMedium: '24px',
  sizeLarge: '32px',
  // Nothing sits between 32 and 64. An avatar is either a mark in a row or the
  // subject of the screen, and the sizes the product had reached for in between
  // — 28, 36 — were a row avatar that had drifted rather than a third kind.
  sizeXlarge: '64px',
  // The letters. Below 24 there is no step on the type scale that fits two
  // characters inside a circle this small, so those two are literals; from 24
  // up the scale carries it. A portrait is the one place this package sets type
  // larger than `title`, because at 64px the scale has run out and the letters
  // are the picture.
  //
  // 7 rather than 8 at `mini`, and the board is why: `WW` at 8px measures 16px
  // against a 16px circle, so the widest pair of capitals was flush with the
  // crop and lost its outer strokes. Two letters barely belong in a circle this
  // small — it is a face where an icon would otherwise be, and a picture or a
  // mark is the better answer there — but small is better than cut.
  initialsMini: '7px',
  initialsSmall: '10px',
  initialsMedium: text.captionSize,
  initialsLarge: text.subheadlineSize,
  initialsXlarge: '24px',
  // What a caller's glyph is given. A fallback holds either letters or a mark,
  // and this package's glyphs state 100% of whatever holds them, so the box is
  // drawn here rather than left to the icon library's default.
  glyphMini: '10px',
  glyphSmall: '12px',
  glyphMedium: '14px',
  glyphLarge: '16px',
  glyphXlarge: '28px',
  // A tile's corner, by the rules' own radius-by-size table. A circle does not
  // read these: it is `radius.full` at `corner.round`, which the rules name for
  // a pill or a circle because a squircle at that radius is a superellipse.
  tileRadiusMini: radius.mini,
  tileRadiusSmall: radius.mini,
  tileRadiusMedium: radius.small,
  tileRadiusLarge: radius.medium,
  tileRadiusXlarge: radius.large,
  fallbackBackground: colors.gray5,
  /**
   * The letters take `label`, not `secondaryLabel`, and the board is what
   * settled it. A badge's word is `secondaryLabel` because a badge is *about*
   * the thing beside it; initials are not about a person, they **are** the
   * person — the whole of what is left when the photograph is missing. And
   * measured on this gray the secondary label is 3.5:1 in the light palette,
   * which is under the 4.5:1 these letters need at 8 to 11 pixels. `label`
   * clears it in both palettes.
   */
  fallbackLabel: colors.label,
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced
 * palette; see `button.tokens.stylex.ts` for why a group declared only at the
 * document root keeps the root palette inside a themed subtree.
 */
export const avatarPaletteTheme = stylex.createTheme(avatar, {
  fallbackBackground: colors.gray5,
  fallbackLabel: colors.label,
});
