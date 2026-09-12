import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import type { FeedbackTone } from '../feedback/tone';
import { appendClassName } from '../internal/class-name';
import { corner } from '../tokens/scales.stylex';
import { badge } from './badge.tokens.stylex';

/**
 * What a badge states: the four a message reports, and the one a bar does.
 *
 * The four outcomes are a message's own, because a badge is the standing form
 * of what an Alert says once, and one vocabulary cannot drift into two. The
 * fifth is `running`, which `Progress` adds for the same reason: a badge on a
 * machine that is being reached, or a screen that is being opened, is live
 * state, and the rules give that colour to live state by name.
 */
export type BadgeTone = 'running' | FeedbackTone;

export interface BadgeProps extends Omit<ComponentProps<'span'>, 'className'> {
  /** What the badge states. Defaults to neutral. */
  tone?: BadgeTone;
  /**
   * The glyph that identifies the thing — a lock beside "Private", a laptop
   * beside an OS. The badge draws the box, so a glyph placed here states its
   * own size as 100% rather than arriving at its icon library's default.
   *
   * It is not the tone's mark. An Alert draws its own because a tone is the
   * whole point of a message and a caller's glyph can put a tick on a failure;
   * a badge always carries its word, so the tone needs no glyph and the box is
   * free to hold what the caller came with — the same box a menu row's leading
   * slot is.
   */
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}

const styles = stylex.create({
  /**
   * A chip of metadata. It neither grows nor shrinks, for the reason a menu
   * row's shortcut does not: what is beside it is the thing, and the badge is
   * the note about it. A long one ends in an ellipsis rather than wrapping to a
   * second line, because a two-line badge is no longer a badge; how much room
   * it may take is the surface's, stated as a max width on the caller's side.
   */
  root: {
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    gap: badge.gap,
    height: badge.height,
    paddingInline: badge.paddingX,
    borderRadius: badge.radius,
    cornerShape: corner.shape,
    color: badge.label,
    fontSize: badge.labelSize,
    lineHeight: badge.labelLeading,
    fontWeight: 500,
    // A badge is where a version, a count or a quota lands, and those line up
    // between rows only if the figures are one width.
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    // A badge is a fact, not a control: nothing here answers a pointer, takes
    // focus or reports a state. A caller who needs one of those needs a Button.
    userSelect: 'none',
  },
  neutral: { backgroundColor: badge.neutralFill },
  running: { backgroundColor: badge.runningFill },
  success: { backgroundColor: badge.successFill },
  warning: { backgroundColor: badge.warningFill },
  danger: { backgroundColor: badge.dangerFill },
  /** The box the caller's glyph is given, and fills. */
  glyph: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: badge.glyphSize,
    height: badge.glyphSize,
  },
});

const TONES = {
  neutral: styles.neutral,
  running: styles.running,
  success: styles.success,
  warning: styles.warning,
  danger: styles.danger,
} as const;

/**
 * A standing fact about the thing beside it.
 *
 * It is on no rung of the elevation ladder, because it sits on whatever holds
 * it: a page, a card, a menu row, a dialog panel. So its tone is a **film of
 * the tone over what is underneath** rather than a background of its own — one
 * declaration that reads on every rung and in both palettes — and its words
 * stay ink, because a badge always carries its word and the palette's `warning`
 * is a colour for a 16px mark rather than for 11px text.
 *
 * The old implementation's `default` variant filled the chip with the primary
 * colour, which this system's rules give to a stored value: a badge that looked
 * like a primary Button invited a press it does not answer. There is no such
 * variant here, and no hover, focus ring or transition either.
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', icon, className, children, ...rest },
  ref
) {
  const sx = stylex.props(styles.root, TONES[tone]);
  const glyph = stylex.props(styles.glyph);
  return (
    <span ref={ref} {...rest} className={appendClassName(sx.className, className)} style={sx.style}>
      {icon ? (
        <span aria-hidden="true" className={glyph.className} style={glyph.style}>
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
});
