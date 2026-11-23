import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';

/**
 * What the share editor, the consent card and the public reader share, in
 * `@lody/ui`'s own tokens: a message is a tint and a mark, never a bordered
 * box, and a block inside a card or a dialog is the region rung — a fill with
 * no edge. One place, so the editor's error and the consent card's error cannot
 * grow two looks.
 */
export const shareSurface = stylex.create({
  /** Present to a screen reader, absent from the page. */
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },

  /** The tone mixed into whatever it sits on, at the strength `@lody/ui` gives a message. */
  message: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    margin: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  messageDestructive: {
    backgroundColor: `color-mix(in oklab, transparent, ${colors.destructive} 10%)`,
    color: colors.label,
  },
  messageWarning: {
    backgroundColor: `color-mix(in oklab, transparent, ${colors.warning} 10%)`,
    color: colors.label,
  },
  mark: { flexShrink: 0, width: '14px', height: '14px', marginTop: '1px' },
  markDestructive: { color: colors.destructive },
  markWarning: { color: colors.warning },
  messageBody: { minWidth: 0, overflowWrap: 'anywhere' },

  /** A block inside a card or a dialog: the region rung, a fill with no edge. */
  region: {
    boxSizing: 'border-box',
    paddingInline: space[3],
    paddingBlock: space[2],
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },

  /** A lucide glyph in a Button: the 16px box, or 14px beside a label. */
  glyph: { flexShrink: 0, width: '16px', height: '16px' },
  glyphSmall: { flexShrink: 0, width: '14px', height: '14px' },
  /** A Button's label that has to give way before the row breaks. */
  buttonLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
