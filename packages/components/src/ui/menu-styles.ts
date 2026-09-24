import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { control, corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';

/**
 * The parts the product menu adds to `@lody/ui`'s `Menu`, in its tokens: a loose
 * section heading, a line between sections outside a `Menu.Group`, and the search
 * field some menus carry. The surface and the rows are the package's own.
 */
export const menuStyles = stylex.create({
  /**
   * A heading over the rows under it: the popup's group label, in sentence case
   * rather than the package's caps — a shouted "RECENTLY USED" reads as chrome
   * from a different decade, and positive tracking only loosens lowercase.
   */
  groupLabel: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    minHeight: control.small,
    paddingInline: space[2],
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    fontWeight: 500,
    userSelect: 'none',
  },
  /** The one place a line is allowed: between rows. */
  separator: {
    height: '1px',
    flexShrink: 0,
    marginBlock: space[1],
    backgroundColor: colors.separator,
  },
  /**
   * The search field: typed into, so the recessed well every value holder is,
   * one row tall at a row's radius. The ring follows focus inside it, since the
   * element that takes focus is the input.
   */
  searchShell: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    flexShrink: 0,
    height: control.small,
    marginBottom: space[1],
    paddingInline: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.round,
    backgroundColor: colors.wellBackground,
    boxShadow: {
      default: shadow.inset,
      ':focus-within': `${shadow.inset}, 0 0 0 2px ${colors.accent}`,
    },
    color: colors.tertiaryLabel,
    cursor: 'text',
  },
  searchGlyph: { display: 'block', flexShrink: 0, width: '14px', height: '14px' },
  /** Bare: the shell around it is the well. */
  searchInput: {
    flexGrow: 1,
    minWidth: 0,
    height: '100%',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    boxShadow: 'none',
    outlineStyle: 'none',
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: text.subheadlineSize,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    '::placeholder': { color: colors.tertiaryLabel, opacity: 1 },
  },
});

/** `menuStyles.groupLabel` as a class, for a heading outside the product `Menu`. */
export const menuGroupLabelClassName = stylex.props(menuStyles.groupLabel).className ?? '';

/** `menuStyles.separator` as a class, for a line outside the product `Menu`. */
export const menuSeparatorClassName = stylex.props(menuStyles.separator).className ?? '';
