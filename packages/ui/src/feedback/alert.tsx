import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { feedbackSurface as surface } from './surface';
import { NOTICE_TONES, TONE_GLYPHS, TONE_MARKS, roleForTone, type FeedbackTone } from './tone';

export interface AlertProps extends Omit<ComponentProps<'div'>, 'className' | 'title'> {
  /** What the message reports. Defaults to neutral. */
  tone?: FeedbackTone;
  children?: ReactNode;
  className?: string;
}

export interface AlertTitleProps extends Omit<ComponentProps<'p'>, 'className'> {
  className?: string;
}
export interface AlertDescriptionProps extends Omit<ComponentProps<'p'>, 'className'> {
  className?: string;
}
export interface AlertActionsProps extends Omit<ComponentProps<'div'>, 'className'> {
  className?: string;
}

/**
 * A message kept on the page it is about: the card rung, tinted by its tone,
 * with the tone's mark beside it.
 *
 * The mark is drawn here rather than taken from the caller, the way an
 * accordion's chevron is: the point of a tone is that a person knows what kind
 * of message this is before reading it, and a glyph a caller chose can put a
 * tick on a failure. How urgently it is announced follows from the tone as
 * well — a failure interrupts, a confirmation waits.
 */
export const AlertRoot = forwardRef<HTMLDivElement, AlertProps>(function AlertRoot(
  { tone = 'neutral', className, children, ...rest },
  ref
) {
  const Mark = TONE_GLYPHS[tone];
  const sx = stylex.props(surface.message, surface.notice, NOTICE_TONES[tone]);
  const body = stylex.props(surface.body);
  const mark = stylex.props(surface.mark, TONE_MARKS[tone]);
  return (
    <div
      ref={ref}
      role={roleForTone(tone)}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    >
      <span className={mark.className} style={mark.style}>
        <Mark />
      </span>
      <div className={body.className} style={body.style}>
        {children}
      </div>
    </div>
  );
});

/** What the message is. It is a line, not a heading: an alert owns no section. */
export const AlertTitle = forwardRef<HTMLParagraphElement, AlertTitleProps>(function AlertTitle(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(surface.title);
  return (
    <p ref={ref} {...rest} className={appendClassName(sx.className, className)} style={sx.style} />
  );
});

/** The sentence under it. */
export const AlertDescription = forwardRef<HTMLParagraphElement, AlertDescriptionProps>(
  function AlertDescription({ className, ...rest }, ref) {
    const sx = stylex.props(surface.description);
    return (
      <p
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

/** What answers it. The buttons are the surface's choice, as everywhere else. */
export const AlertActions = forwardRef<HTMLDivElement, AlertActionsProps>(function AlertActions(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(surface.actions);
  return (
    <div
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

export const Alert = {
  Root: AlertRoot,
  Title: AlertTitle,
  Description: AlertDescription,
  Actions: AlertActions,
};
