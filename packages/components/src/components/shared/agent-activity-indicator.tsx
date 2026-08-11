import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

export type AgentActivityTone = 'primary' | 'warning' | 'success' | 'destructive' | 'neutral';

type AgentActivityIndicatorProps = {
  color?: string;
  tone?: AgentActivityTone;
  displaySize?: number;
  /** @deprecated Retained for call-site compatibility; the CSS indicator has no canvas. */
  canvasSize?: number;
  label?: string;
  className?: string;
  labelClassName?: string;
  labelHighlightCount?: number;
  labelHighlightIntervalMs?: number;
  labelHighlightPauseMs?: number;
};

const DEFAULT_DISPLAY_SIZE = 24;

const ACTIVITY_TONE_VARIABLE_MAP: Record<AgentActivityTone, string> = {
  primary: '--primary',
  warning: '--status-warning',
  success: '--status-success',
  destructive: '--destructive',
  neutral: '--muted-foreground',
};

const ACTIVITY_TONE_LABEL_STYLES: Record<
  AgentActivityTone,
  { baseColor: string; highlightColor: string; highlightGlow: string }
> = {
  primary: {
    baseColor: 'hsl(var(--primary) / 0.68)',
    highlightColor: 'hsl(var(--primary) / 0.96)',
    highlightGlow: '0 0 0.7rem hsl(var(--primary) / 0.2)',
  },
  warning: {
    baseColor: 'hsl(var(--status-warning) / 0.72)',
    highlightColor: 'hsl(var(--status-warning) / 0.96)',
    highlightGlow: '0 0 0.7rem hsl(var(--status-warning) / 0.18)',
  },
  success: {
    baseColor: 'hsl(var(--status-success) / 0.72)',
    highlightColor: 'hsl(var(--status-success) / 0.96)',
    highlightGlow: '0 0 0.7rem hsl(var(--status-success) / 0.18)',
  },
  destructive: {
    baseColor: 'hsl(var(--destructive) / 0.72)',
    highlightColor: 'hsl(var(--destructive) / 0.96)',
    highlightGlow: '0 0 0.7rem hsl(var(--destructive) / 0.18)',
  },
  neutral: {
    baseColor: 'hsl(var(--muted-foreground) / 0.7)',
    highlightColor: 'hsl(var(--foreground) / 0.9)',
    highlightGlow: '0 0 0.65rem hsl(var(--foreground) / 0.08)',
  },
};

type ActivityDotStyle = CSSProperties & {
  '--agent-activity-color': string;
};

type ActivityLabelStyle = CSSProperties & {
  '--agent-activity-label-base': string;
  '--agent-activity-label-highlight': string;
  '--agent-activity-label-glow': string;
  '--agent-activity-label-duration': string;
};

export function AgentActivityIndicator({
  color,
  tone = 'primary',
  displaySize = DEFAULT_DISPLAY_SIZE,
  label,
  className,
  labelClassName,
  labelHighlightCount = 5,
  labelHighlightIntervalMs = 50,
  labelHighlightPauseMs = 2000,
}: AgentActivityIndicatorProps) {
  const labelToneStyle = ACTIVITY_TONE_LABEL_STYLES[tone];
  const toneColor = `hsl(var(${ACTIVITY_TONE_VARIABLE_MAP[tone]}, 199 89% 72%))`;
  const dotStyle: ActivityDotStyle = {
    width: displaySize,
    height: displaySize,
    '--agent-activity-color': color ?? toneColor,
  };
  const highlightStepMs = Math.max(60, labelHighlightIntervalMs);
  const highlightPauseMs = Math.max(200, labelHighlightPauseMs);
  const highlightSteps = (label ? Array.from(label).length : 0) + labelHighlightCount;
  const labelStyle: ActivityLabelStyle = {
    '--agent-activity-label-base': labelToneStyle.baseColor,
    '--agent-activity-label-highlight': labelToneStyle.highlightColor,
    '--agent-activity-label-glow': labelToneStyle.highlightGlow,
    '--agent-activity-label-duration': `${highlightSteps * highlightStepMs + highlightPauseMs}ms`,
  };

  return (
    <div className={cn('inline-flex items-center gap-1.5', className)}>
      <span
        aria-hidden="true"
        className="agent-activity-dot relative inline-grid shrink-0 place-items-center"
        style={dotStyle}
      >
        <span className="agent-activity-dot-pulse block size-[34%] rounded-full bg-[var(--agent-activity-color)]" />
      </span>
      {label ? (
        <span
          className={cn('agent-activity-label relative inline-block text-sm', labelClassName)}
          data-highlight-label={label}
          style={labelStyle}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}
