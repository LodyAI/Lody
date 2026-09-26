import type { AgentBrandId, AgentConfigCliType } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius } from '@lody/ui/tokens/scales.stylex';

import { AgentIcon } from '@/components/icons/agent-icon';
import { withClassName } from '@/lib/stylex';

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
const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

const orbit = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });

const styles = stylex.create({
  mark: {
    position: 'relative',
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.small,
    // The product's --muted surface has no @lody/ui token yet. Keep its 40%
    // wash until that palette gains one, so this migration changes no pixels.
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
  },
  avatar: {
    borderRadius: radius.full,
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 50%, transparent)',
  },
  small: { width: '28px', height: '28px' },
  medium: { width: '40px', height: '40px' },
  large: { width: '56px', height: '56px' },
  ring: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    transform: 'rotate(-90deg)',
  },
  ringTrack: { stroke: `color-mix(in oklab, ${colors.separator} 70%, transparent)` },
  ringAccent: { stroke: colors.accent },
  ringFill: {
    transitionProperty: 'stroke-dashoffset',
    transitionDuration: '400ms',
    transitionTimingFunction: 'ease-out',
  },
  orbit: {
    position: 'absolute',
    inset: 0,
    animationName: { default: orbit, [REDUCED_MOTION]: 'none' },
    animationDuration: '1400ms',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    transformOrigin: '50% 50%',
    willChange: 'transform',
  },
  orbitRing: { width: '100%', height: '100%' },
  icon: {
    position: 'relative',
    transitionProperty: 'opacity',
    transitionDuration: '500ms',
  },
  iconSmall: { width: '12px', height: '12px' },
  iconMedium: { width: '18px', height: '18px' },
  iconLarge: { width: '24px', height: '24px' },
  ready: { color: colors.label, opacity: 1 },
  arriving: { color: colors.secondaryLabel, opacity: 0.7, filter: 'saturate(0)' },
  cold: { color: colors.secondaryLabel, opacity: 0.4, filter: 'saturate(0)' },
});

const SIZES = {
  sm: { box: styles.small, icon: styles.iconSmall, stroke: 8 },
  md: { box: styles.medium, icon: styles.iconMedium, stroke: 7 },
  lg: { box: styles.large, icon: styles.iconLarge, stroke: 6 },
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
  /** The onboarding avatar is round and has a stronger muted wash. */
  surface?: 'tile' | 'avatar';
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
  surface = 'tile',
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
      {...withClassName(
        stylex.props(styles.mark, surface === 'avatar' && styles.avatar, box),
        className
      )}
      {...(ariaLabel ? { role: 'img', 'aria-label': ariaLabel } : {})}
    >
      {readiness === 'arriving' ? (
        <>
          {/* -rotate-90 puts 0% at twelve o'clock for the determinate fill. */}
          <svg viewBox="0 0 100 100" {...stylex.props(styles.ring)} aria-hidden="true">
            <circle
              cx="50"
              cy="50"
              r={RING_RADIUS}
              fill="none"
              strokeWidth={stroke}
              {...stylex.props(styles.ringTrack)}
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
                {...stylex.props(styles.ringAccent, styles.ringFill)}
              />
            ) : null}
          </svg>
          {determinatePercent === null ? (
            // The indeterminate arc orbits on an HTML wrapper, not on an SVG
            // `<g>`. Chromium will not composite a transform animation whose
            // target is an SVG element with an effective zoom other than 1
            // (crbug.com/1186312), and that is every SVG on a Retina display,
            // so a `<g>` orbit re-runs style, pre-paint and layerize on the
            // main thread every vsync. A block-level span composites. Same
            // rule as `ui/spinner.tsx`.
            <span {...stylex.props(styles.orbit)} aria-hidden="true">
              <svg viewBox="0 0 100 100" {...stylex.props(styles.orbitRing)}>
                <circle
                  cx="50"
                  cy="50"
                  r={RING_RADIUS}
                  fill="none"
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={`${RING_CIRCUMFERENCE * ORBIT_ARC_FRACTION} ${RING_CIRCUMFERENCE}`}
                  {...stylex.props(styles.ringAccent)}
                />
              </svg>
            </span>
          ) : null}
        </>
      ) : null}
      <AgentIcon
        cliType={cliType}
        agentType={agentType}
        brandId={brandId}
        env={env}
        className={
          stylex.props(
            styles.icon,
            // Saturation catches brand-coloured glyphs; registry marks already
            // inherit currentColor.
            readiness === 'ready'
              ? styles.ready
              : readiness === 'arriving'
                ? styles.arriving
                : styles.cold,
            icon
          ).className
        }
      />
    </span>
  );
}
