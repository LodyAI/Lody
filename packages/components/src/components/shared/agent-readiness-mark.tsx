import type { AgentBrandId, AgentConfigCliType } from '@lody/shared';

import { AgentIcon } from '@/components/icons/agent-icon';
import { cn } from '@/lib/utils';

/**
 * How far along an agent is toward being usable, expressed on the agent's own
 * mark rather than as a separate status word beside it.
 *
 * - `cold` — nothing has been prepared yet: monochrome and dim.
 * - `arriving` — being prepared: still monochrome, and the mark carries a ring.
 * - `ready` — full brand contrast, no ring. A ready agent says nothing at all,
 *   because a badge confirming success only advertises that failure exists.
 */
export type AgentReadiness = 'cold' | 'arriving' | 'ready';

const RING_RADIUS = 45;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Visible sweep of the indeterminate arc, as a fraction of the ring. */
const ORBIT_ARC_FRACTION = 0.22;

const SIZES = {
  sm: { box: 'h-7 w-7', icon: 'h-3 w-3', stroke: 8 },
  md: { box: 'h-10 w-10', icon: 'h-4.5 w-4.5', stroke: 7 },
  lg: { box: 'h-14 w-14', icon: 'h-6 w-6', stroke: 6 },
} as const;

export type AgentReadinessMarkProps = {
  cliType: AgentConfigCliType;
  agentType: string;
  brandId?: AgentBrandId;
  env?: Record<string, string>;
  readiness: AgentReadiness;
  /**
   * Determinate progress, 0-100. Supplied only while `arriving`, and only when
   * the work actually has a denominator — a download does, an ACP handshake
   * does not. `null` keeps the ring on its indeterminate orbit instead of
   * inventing a number.
   */
  percent?: number | null;
  size?: keyof typeof SIZES;
  className?: string;
  /** Describes the mark for assistive tech; the visual carries no text. */
  ariaLabel?: string;
};

export function AgentReadinessMark({
  cliType,
  agentType,
  brandId,
  env,
  readiness,
  percent = null,
  size = 'md',
  className,
  ariaLabel,
}: AgentReadinessMarkProps) {
  const { box, icon, stroke } = SIZES[size];
  const determinatePercent =
    typeof percent === 'number' && Number.isFinite(percent)
      ? Math.min(100, Math.max(0, percent))
      : null;

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-lg bg-muted/40',
        box,
        className
      )}
      {...(ariaLabel ? { role: 'img', 'aria-label': ariaLabel } : {})}
    >
      {readiness === 'arriving' ? (
        // -rotate-90 puts 0% at twelve o'clock; the orbit rotation composes on
        // the inner group so both transforms stay independent.
        <svg
          viewBox="0 0 100 100"
          className="absolute inset-0 h-full w-full -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="50"
            cy="50"
            r={RING_RADIUS}
            fill="none"
            strokeWidth={stroke}
            className="stroke-border/70"
          />
          {determinatePercent !== null ? (
            <circle
              cx="50"
              cy="50"
              r={RING_RADIUS}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - determinatePercent / 100)}
              className="stroke-primary"
              style={{ transition: 'stroke-dashoffset 400ms ease-out' }}
            />
          ) : (
            <g className="agent-readiness-orbit">
              <circle
                cx="50"
                cy="50"
                r={RING_RADIUS}
                fill="none"
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={`${RING_CIRCUMFERENCE * ORBIT_ARC_FRACTION} ${RING_CIRCUMFERENCE}`}
                className="stroke-primary"
              />
            </g>
          )}
        </svg>
      ) : null}
      <AgentIcon
        cliType={cliType}
        agentType={agentType}
        brandId={brandId}
        env={env}
        className={cn(
          'relative transition-opacity duration-500',
          // Saturation is the state. `saturate-0` catches the brand-coloured
          // glyphs; the registry marks already inherit `currentColor`.
          readiness === 'ready'
            ? 'text-foreground opacity-100'
            : readiness === 'arriving'
              ? 'text-muted-foreground opacity-70 saturate-0'
              : 'text-muted-foreground opacity-40 saturate-0',
          icon
        )}
      />
    </span>
  );
}
