import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { ease } from '@lody/ui/tokens/scales.stylex';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

const travel = stylex.keyframes({
  '0%': { transform: 'translateX(-22px)', opacity: 0 },
  '14%': { transform: 'translateX(-18px)', opacity: 1 },
  '66%': { transform: 'translateX(14px)', opacity: 1 },
  '80%': { transform: 'translateX(18px)', opacity: 0 },
  '100%': { transform: 'translateX(18px)', opacity: 0 },
});

const arrive = stylex.keyframes({
  '0%': { opacity: 0.25 },
  '62%': { opacity: 0.25 },
  '74%': { opacity: 1 },
  '92%': { opacity: 0.25 },
  '100%': { opacity: 0.25 },
});

const breathe = stylex.keyframes({
  '0%': { opacity: 0.35 },
  '50%': { opacity: 1 },
  '100%': { opacity: 0.35 },
});

const sweep = stylex.keyframes({
  from: { transform: 'rotate(0deg)' },
  to: { transform: 'rotate(360deg)' },
});

const styles = stylex.create({
  art: { display: 'block', flexShrink: 0, overflow: 'visible' },
  tile: { fill: colors.gray6 },
  housing: { fill: colors.gray5 },
  face: { fill: colors.gray6 },
  rim: { fill: colors.gray4 },
  line: { fill: colors.gray3 },
  ink: { fill: colors.label },
  inkStroke: { fill: 'none', stroke: colors.label, strokeLinecap: 'round' },
  softInk: { fill: colors.secondaryLabel },
  bridge: {
    fill: 'none',
    stroke: colors.gray2,
    strokeWidth: 2.2,
    strokeLinecap: 'round',
    strokeDasharray: '0.5 4.5',
  },
  lampOff: { fill: colors.tertiaryLabel },
  lamp: { fill: colors.accent },
  glow: { fillOpacity: 0.28 },
  lampBreathe: {
    animationName: { default: breathe, [REDUCED_MOTION]: 'none' },
    animationDuration: '1.8s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
  lampArrive: {
    opacity: { default: 0.25, [REDUCED_MOTION]: 1 },
    animationName: { default: arrive, [REDUCED_MOTION]: 'none' },
    animationDuration: '2.8s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  keyTravel: {
    animationName: { default: travel, [REDUCED_MOTION]: 'none' },
    animationDuration: '2.8s',
    animationTimingFunction: ease.standard,
    animationIterationCount: 'infinite',
  },
  hand: {
    transformOrigin: '44px 42px',
    animationName: { default: sweep, [REDUCED_MOTION]: 'none' },
    animationDuration: '6s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
});

function KeyGlyph({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(0.82)`}>
      <circle cx="0" cy="0" r="4.5" strokeWidth="3" {...stylex.props(styles.inkStroke)} />
      <rect x="4" y="-1.5" width="15" height="3" rx="1.5" {...stylex.props(styles.ink)} />
      <rect x="11" y="0.5" width="2.6" height="4" rx="1" {...stylex.props(styles.ink)} />
      <rect x="15.6" y="0.5" width="2.6" height="5.5" rx="1" {...stylex.props(styles.ink)} />
    </g>
  );
}

/** A keyhole shield on a soft tile; `attention` lights a lamp: no backup holds the key yet. */
export function E2eeShieldKeyArt({
  size = 44,
  attention = false,
}: {
  size?: number;
  attention?: boolean;
}) {
  return (
    <svg
      {...stylex.props(styles.art)}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      data-e2ee-art="shield-key"
    >
      <rect x="0" y="0" width="48" height="48" rx="13" {...stylex.props(styles.tile)} />
      <path
        d="M24 8.5 36 13v10c0 7.6-5.1 13.1-12 16-6.9-2.9-12-8.4-12-16V13z"
        {...stylex.props(styles.rim)}
      />
      <path
        d="M24 11.4 33.4 15v8c0 6-3.9 10.4-9.4 12.9-5.5-2.5-9.4-6.9-9.4-12.9v-8z"
        {...stylex.props(styles.housing)}
      />
      <circle cx="24" cy="21.5" r="3.2" {...stylex.props(styles.ink)} />
      <rect x="22.6" y="22.5" width="2.8" height="7.5" rx="1.4" {...stylex.props(styles.ink)} />
      {attention && (
        <>
          <circle cx="37.5" cy="10.5" r="4.6" {...stylex.props(styles.lamp, styles.glow)} />
          <circle cx="37.5" cy="10.5" r="2" {...stylex.props(styles.lamp)} />
        </>
      )}
    </svg>
  );
}

/** Laptop, dotted bridge, phone and a key; `transferring` loops the key across and lights the phone. */
export function E2eeDevicePairArt({
  width = 168,
  transferring = false,
}: {
  width?: number;
  transferring?: boolean;
}) {
  return (
    <svg
      {...stylex.props(styles.art)}
      width={width}
      height={(width * 56) / 132}
      viewBox="0 0 132 56"
      aria-hidden="true"
      focusable="false"
      data-e2ee-art={transferring ? 'device-pair-transfer' : 'device-pair'}
    >
      <rect x="4" y="9" width="44" height="31" rx="5" {...stylex.props(styles.housing)} />
      <rect x="8" y="13" width="36" height="23" rx="2.5" {...stylex.props(styles.face)} />
      <path d="M23 23v-2.5a3 3 0 0 1 6 0V23" strokeWidth="2" {...stylex.props(styles.inkStroke)} />
      <rect x="21" y="22.5" width="10" height="8" rx="2" {...stylex.props(styles.ink)} />
      <rect x="0" y="40" width="52" height="5" rx="2.5" {...stylex.props(styles.rim)} />
      <rect x="20" y="40" width="12" height="1.6" rx="0.8" {...stylex.props(styles.line)} />

      <path d="M57 28H99" {...stylex.props(styles.bridge)} />

      <rect x="104" y="5" width="25" height="46" rx="6.5" {...stylex.props(styles.housing)} />
      <rect x="107" y="10" width="19" height="36" rx="3" {...stylex.props(styles.face)} />
      <rect x="113" y="7" width="7" height="1.6" rx="0.8" {...stylex.props(styles.rim)} />
      {transferring ? (
        <>
          <circle
            cx="116.5"
            cy="28"
            r="5"
            {...stylex.props(styles.lamp, styles.glow, styles.lampArrive)}
          />
          <circle cx="116.5" cy="28" r="2.2" {...stylex.props(styles.lamp, styles.lampArrive)} />
        </>
      ) : (
        <circle cx="116.5" cy="28" r="2.2" {...stylex.props(styles.lampOff)} />
      )}

      <g {...stylex.props(transferring && styles.keyTravel)}>
        <KeyGlyph x={71} y={28} />
      </g>
    </svg>
  );
}

/** A member badge with a clock: accepted, waiting for an admin to let this account in. */
export function E2eeMemberWaitingArt({ size = 56 }: { size?: number }) {
  return (
    <svg
      {...stylex.props(styles.art)}
      width={size}
      height={size}
      viewBox="0 0 56 56"
      aria-hidden="true"
      focusable="false"
      data-e2ee-art="member-waiting"
    >
      <rect x="2" y="8" width="42" height="34" rx="8" {...stylex.props(styles.housing)} />
      <rect x="18" y="5" width="10" height="5" rx="2" {...stylex.props(styles.rim)} />
      <circle cx="15" cy="22" r="4.5" {...stylex.props(styles.ink)} />
      <path d="M7.5 35a7.5 6.5 0 0 1 15 0z" {...stylex.props(styles.ink)} />
      <rect x="27" y="19" width="11" height="3" rx="1.5" {...stylex.props(styles.line)} />
      <rect x="27" y="25.5" width="7" height="3" rx="1.5" {...stylex.props(styles.line)} />
      <circle cx="44" cy="42" r="11" {...stylex.props(styles.face)} />
      <circle cx="44" cy="42" r="9" {...stylex.props(styles.rim)} />
      <circle cx="44" cy="42" r="7.2" {...stylex.props(styles.face)} />
      <path d="M44 42v-4" strokeWidth="2" {...stylex.props(styles.inkStroke)} />
      <g {...stylex.props(styles.hand)}>
        <path d="M44 42h3.6" strokeWidth="2" {...stylex.props(styles.inkStroke)} />
      </g>
      <circle cx="44" cy="42" r="1.4" {...stylex.props(styles.lamp, styles.lampBreathe)} />
    </svg>
  );
}
