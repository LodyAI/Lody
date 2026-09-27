import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import {
  control,
  corner,
  duration,
  ease,
  radius,
  space,
  text,
} from '@lody/ui/tokens/scales.stylex';

/**
 * The rise every `@lody/ui` popup makes: one step further from what opened it,
 * into place. The desktop content states the direction in `--mention-rise` from
 * the side it actually landed on, since a composer near the window's bottom
 * opens the menu above the caret; the docked mobile panel sits above the
 * composer and rises from below.
 */
const rise = stylex.keyframes({
  from: { opacity: 0, transform: 'translateY(var(--mention-rise, 4px))' },
  to: { opacity: 1, transform: 'none' },
});

/** The popup row highlight: the floating rung mixed 6% toward the ink. */
const HIGHLIGHT = `color-mix(in oklab, ${colors.raisedBackground}, ${colors.label} 6%)`;

/**
 * The mention menu's surface and rows, restating `@lody/ui`'s popup surface
 * from the semantic tokens it resolves to (the package keeps its `popup` group
 * internal), as `components/shared/composer-surface.ts` does for the composer's
 * other lists. Desktop and mobile share it; only the container's placement
 * differs. StyleX cannot read `data-highlighted`, so a row's highlight is read
 * from the mention context and applied as a class.
 */
export const mentionSurface = stylex.create({
  /** The floating rung: raised fill, the popover shadow, 4px in to the rows. */
  surface: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    padding: space[1],
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.raisedBackground,
    boxShadow: shadow.popover,
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    outlineStyle: 'none',
    animationName: rise,
    animationDuration: duration.regular,
    animationTimingFunction: ease.standard,
  },
  /** A row: a 28px minimum control that keeps wrapped content in its box. */
  item: {
    boxSizing: 'border-box',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minHeight: control.small,
    // The list is a capped vertical flexbox. Keep a wrapped subtitle from
    // shrinking the row back to the minimum and painting over its neighbour.
    flexShrink: 0,
    paddingInline: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: 'transparent',
    color: colors.label,
    cursor: 'default',
    userSelect: 'none',
    outlineStyle: 'none',
    // The fill says where the keyboard is; a row never takes the shell's ring.
    boxShadow: 'none',
    scrollMarginBlock: space[1],
    // No transition: the highlight follows the pointer and the arrow keys.
  },
  itemHighlighted: { backgroundColor: HIGHLIGHT },
  /**
   * A disabled row stays legible, because it explains why it cannot be picked:
   * it takes no pointer, and the menu mutes its words, not the whole row.
   */
  itemDisabled: { pointerEvents: 'none' },
});
