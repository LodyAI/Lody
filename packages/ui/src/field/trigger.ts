import * as stylex from '@stylexjs/stylex';
import { field } from './field.tokens.stylex';

/**
 * What a trigger in the field family looks like: a Select's, and a Combobox's
 * `Button` for a list searched inside its popup. It is a field like any other —
 * `well.base` carries the fill, edge, ring and disabled opacity — and this adds
 * only the layout of a value beside a chevron, so the two cannot drift.
 */
export const trigger = stylex.create({
  base: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: field.triggerGap,
    textAlign: 'start',
    whiteSpace: 'nowrap',
    lineHeight: 1,
    userSelect: 'none',
    // A trigger opens a list; it is not a button that acts, so it keeps the
    // arrow the way a native select does rather than taking the hand.
    cursor: { default: 'default', ':disabled': 'default' },
  },
  small: {
    height: field.heightSmall,
    paddingInline: field.paddingXSmall,
    borderRadius: field.radiusSmall,
    fontSize: field.text,
  },
  medium: {
    height: field.heightMedium,
    paddingInline: field.paddingXMedium,
    borderRadius: field.radiusMedium,
    fontSize: field.text,
  },
  large: {
    height: field.heightLarge,
    paddingInline: field.paddingXLarge,
    borderRadius: field.radiusMedium,
    fontSize: field.text,
  },
  /** The value takes the width the chevron leaves, so a long one truncates. */
  value: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** An empty trigger reads as a prompt, in the same hint colour as a placeholder. */
  placeholder: { color: field.placeholder },
  icon: {
    display: 'flex',
    flexShrink: 0,
    width: field.iconSize,
    height: field.iconSize,
    color: field.icon,
  },
});

export const triggerSizes = {
  small: trigger.small,
  medium: trigger.medium,
  large: trigger.large,
};
