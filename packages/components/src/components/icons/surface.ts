import * as stylex from '@stylexjs/stylex';
import { themeSpace } from '../../style/theme-scale.stylex';

/**
 * The box a glyph sits in, shared by the agent marks and the file marks.
 *
 * Both families render a 16px glyph the caller may resize, so the box is a
 * size the caller's own class can override, and the ink the glyph draws in is
 * the surrounding `currentColor`.
 */
export const iconSurface = stylex.create({
  /** The default glyph box: 16px square, the size every mark is authored at. */
  glyphBox: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
  /**
   * A masked mark: the glyph is the alpha channel of a flat fill, so the box
   * paints in the surrounding ink.
   */
  maskedFileGlyph: {
    display: 'inline-block',
    backgroundColor: 'currentcolor',
  },
  /** The same mask, on a span that stays in the text flow. */
  maskedFolderGlyph: { backgroundColor: 'currentcolor' },
  /**
   * A mark whose own glyph fills the box: the wrapper centres the glyph, and
   * the glyph takes the wrapper's height and width.
   */
  glyphFill: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /**
   * An app-icon launcher (a squircle PNG with built-in transparent margins):
   * the image is scaled up a touch so it reads at the same size as the
   * edge-to-edge brand SVGs, and it keeps its own box.
   */
  appIconImage: {
    scale: '1.25',
    objectFit: 'contain',
  },
  /** The small mark a model brand shows in a chip: 14px square. */
  glyphBoxSmall: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
});

/**
 * The default glyph box, as a class name.
 *
 * A mark takes the caller's own class instead of this one when the caller
 * states a size, so this is a fallback rather than a style the component owns.
 */
export const ICON_GLYPH_BOX_CLASS = stylex.props(iconSurface.glyphBox).className;
