import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { ease } from '@lody/ui/tokens/scales.stylex';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

/** The ring and the tick are drawn once, in that order. */
const drawRing = stylex.keyframes({
  from: { strokeDashoffset: '70' },
  to: { strokeDashoffset: '0' },
});
const drawTick = stylex.keyframes({
  from: { strokeDashoffset: '18' },
  to: { strokeDashoffset: '0' },
});
/** One soft ring leaving the mark as it lands. */
const ripple = stylex.keyframes({
  from: { opacity: 0.35, transform: 'scale(0.8)' },
  to: { opacity: 0, transform: 'scale(1.35)' },
});

const styles = stylex.create({
  svg: { display: 'block', flexShrink: 0, overflow: 'visible' },
  ring: {
    fill: 'none',
    stroke: colors.success,
    strokeWidth: 1.75,
    strokeLinecap: 'round',
    strokeDasharray: '70',
    transform: 'rotate(-90deg)',
    transformOrigin: 'center',
    transformBox: 'fill-box',
    animationName: { default: drawRing, [REDUCED_MOTION]: 'none' },
    animationDuration: '450ms',
    animationTimingFunction: ease.standard,
    animationFillMode: 'both',
  },
  tick: {
    fill: 'none',
    stroke: colors.success,
    strokeWidth: 1.75,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    strokeDasharray: '18',
    animationName: { default: drawTick, [REDUCED_MOTION]: 'none' },
    animationDuration: '300ms',
    animationDelay: '350ms',
    animationTimingFunction: ease.standard,
    animationFillMode: 'both',
  },
  ripple: {
    fill: 'none',
    stroke: colors.success,
    strokeWidth: 1,
    transformOrigin: 'center',
    transformBox: 'fill-box',
    animationName: { default: ripple, [REDUCED_MOTION]: 'none' },
    animationDuration: '700ms',
    animationDelay: '300ms',
    animationTimingFunction: ease.standard,
    animationFillMode: 'both',
  },
});

/** Published: the ring closes, the tick follows, and one ripple leaves. Drawn once. */
export function PublishedGlyph({ size = 32 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      {...stylex.props(styles.svg)}
    >
      <circle cx="16" cy="16" r="12" {...stylex.props(styles.ripple)} />
      <circle cx="16" cy="16" r="11" {...stylex.props(styles.ring)} />
      <path d="M10.8 16.4l3.7 3.7 6.9-7.6" {...stylex.props(styles.tick)} />
    </svg>
  );
}
