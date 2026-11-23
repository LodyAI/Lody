import { Progress as BaseProgress } from '@base-ui/react/progress';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { feedbackSurface as surface } from './surface';
import type { FeedbackTone } from './tone';

type RootBaseProps = ComponentProps<typeof BaseProgress.Root>;

/**
 * What the bar is about. `running` is the default and the only live one; the
 * four others are the family's tones, for a bar that reports an outcome — a
 * quota nearly spent — or that measures something rather than progressing
 * through it, which is not live state and gives the accent back.
 */
export type ProgressTone = 'running' | FeedbackTone;

const TONES = {
  running: undefined,
  neutral: surface.indicatorNeutral,
  success: surface.indicatorSuccess,
  warning: surface.indicatorWarning,
  danger: surface.indicatorDanger,
} as const;

export interface ProgressProps extends Omit<RootBaseProps, 'className' | 'children'> {
  /** The name of what is happening, shown over the bar. */
  label?: ReactNode;
  /** Whether the share done is shown beside the label. Defaults to false. */
  showValue?: boolean;
  /** What the bar is about. Defaults to `running`, the one live state. */
  tone?: ProgressTone;
  className?: string;
}

/**
 * How far something has got: a well-rung track with the one live thing in this
 * system running in it.
 *
 * The bar is `accent` because the rules give that colour to live state and name
 * the running indicator by name; ink would say "this value is stored", which is
 * the opposite of what a bar in motion means. A progress with no value is not a
 * bar at zero — it is the same track with a band crossing it, because "I do not
 * know how far" and "nothing has happened" are different things to report.
 *
 * Base UI owns the accessible half: the root carries the role and the value,
 * and the label and the value text are wired to it, so a caller writes what the
 * task is called rather than a set of ARIA attributes.
 */
export const Progress = forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  { className, label, showValue = false, tone = 'running', ...rest },
  ref
) {
  const sx = stylex.props(surface.progress);
  const header = stylex.props(surface.progressHeader);
  const labelSx = stylex.props(surface.progressLabel);
  const valueSx = stylex.props(surface.progressValue);
  const track = stylex.props(surface.track);
  return (
    <BaseProgress.Root
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    >
      {label != null || showValue ? (
        <div className={header.className} style={header.style}>
          {label != null ? (
            <BaseProgress.Label className={labelSx.className} style={labelSx.style}>
              {label}
            </BaseProgress.Label>
          ) : null}
          {showValue ? (
            <BaseProgress.Value className={valueSx.className} style={valueSx.style} />
          ) : null}
        </div>
      ) : null}
      <BaseProgress.Track className={track.className} style={track.style}>
        <BaseProgress.Indicator
          className={(state) =>
            stylex.props(
              surface.indicator,
              TONES[tone],
              state.status === 'indeterminate' && surface.indicatorIndeterminate
            ).className
          }
        />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
});
