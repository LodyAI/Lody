import * as stylex from '@stylexjs/stylex';
import { Bug, ExternalLink } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';

export type NoMachineHintVariant = 'download-client' | 'daemon-starting';

export interface NoMachineHintProps {
  /** `download-client` for web/mobile, `daemon-starting` for Electron's bundled daemon. */
  variant: NoMachineHintVariant;
  title: string;
  message: string;
  downloadLabel: string;
  reportBugLabel: string;
  discordMessage: string;
  discordLabel: string;
  onDownloadClient?: () => void;
  onReportBug?: () => void;
}

/**
 * The plug waits, slides home into the socket, the lamp lights, and it pulls out
 * again: a machine that is not there yet. Only `transform` and `opacity` move, on
 * a CSS loop with no script, and the loop is off under `prefers-reduced-motion`
 * (the plug then rests unplugged).
 */
const reach = stylex.keyframes({
  '0%': { transform: 'translateX(0)' },
  '40%': { transform: 'translateX(0)' },
  '58%': { transform: 'translateX(28px)' },
  '78%': { transform: 'translateX(28px)' },
  '94%': { transform: 'translateX(0)' },
  '100%': { transform: 'translateX(0)' },
});

/** The lamp comes on while the plug is home and goes out when it is pulled. */
const lampOn = stylex.keyframes({
  '0%': { opacity: 0 },
  '57%': { opacity: 0 },
  '60%': { opacity: 1 },
  '78%': { opacity: 1 },
  '82%': { opacity: 0 },
  '100%': { opacity: 0 },
});

/** The socket's lamp while the daemon comes up. */
const breathe = stylex.keyframes({
  '0%': { opacity: 0.35 },
  '50%': { opacity: 1 },
  '100%': { opacity: 0.35 },
});

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

const styles = stylex.create({
  /** The card rung: it rests on the page with an edge and a contact shadow, no outline. */
  card: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[4],
    padding: space[4],
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    color: colors.label,
  },
  art: {
    flexShrink: 0,
    width: '135px',
    height: '60px',
    overflow: 'hidden',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[1],
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 550,
    color: colors.label,
  },
  message: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[3],
    rowGap: space[1.5],
    marginTop: space[1.5],
  },
  discord: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
  discordLink: {
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    transitionProperty: 'color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },

  /* ── The illustration ──────────────────────────────────────────────── */
  wall: { fill: colors.gray6 },
  wallEdge: { fill: colors.gray4 },
  socketHousing: { fill: colors.gray5 },
  socketFace: { fill: colors.gray4 },
  socketSlot: { fill: colors.gray2 },
  lamp: { fill: colors.tertiaryLabel },
  /** A soft halo behind a lit lamp: the same circle, wider and faint. */
  glow: { fillOpacity: 0.28 },
  /** Lit while the plug is home, on the plug's own loop. */
  lampLoop: {
    fill: colors.accent,
    opacity: 0,
    animationName: { default: lampOn, [REDUCED_MOTION]: 'none' },
    animationDuration: '3.6s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  /** The daemon is starting: the lamp breathes. */
  lampLive: {
    fill: colors.accent,
    animationName: { default: breathe, [REDUCED_MOTION]: 'none' },
    animationDuration: '1.8s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
  cable: { fill: 'none', stroke: colors.secondaryLabel, strokeWidth: 3, strokeLinecap: 'round' },
  plugBoot: { fill: colors.secondaryLabel },
  plugBody: { fill: colors.label },
  plugGrip: { fill: colors.secondaryLabel },
  plugProng: { fill: colors.gray },
  /** Reaching: loops between held back and fully home in the socket. */
  plugReaching: {
    animationName: { default: reach, [REDUCED_MOTION]: 'none' },
    animationDuration: '3.6s',
    animationTimingFunction: ease.standard,
    animationIterationCount: 'infinite',
  },
  /** Seated: the daemon is starting, so the plug is in. */
  plugSeated: { transform: 'translateX(28px)' },
});

/**
 * A plug and a wall socket seen side-on, in the page's own tokens so it follows the
 * theme. Decorative: the text beside it says everything it does. The plug is
 * painted first and the socket over it, so seated prongs disappear into the slots
 * and the plug's face sits flush against the socket's; the wall is painted last so
 * the socket's back is cut flat where it is mounted.
 */
function PlugArt({ seated }: { seated: boolean }) {
  const lamp = seated ? styles.lampLive : styles.lampLoop;
  return (
    <svg {...stylex.props(styles.art)} viewBox="0 0 108 48" aria-hidden="true" focusable="false">
      <g {...stylex.props(seated ? styles.plugSeated : styles.plugReaching)}>
        <path d="M22 24 C14 24 14 34 6 34 S-2 24 -30 24" {...stylex.props(styles.cable)} />
        <rect x="22" y="19" width="10" height="10" rx="3" {...stylex.props(styles.plugBoot)} />
        <rect x="52" y="15" width="10" height="4" rx="1.5" {...stylex.props(styles.plugProng)} />
        <rect x="52" y="29" width="10" height="4" rx="1.5" {...stylex.props(styles.plugProng)} />
        <rect x="30" y="10" width="22" height="28" rx="8" {...stylex.props(styles.plugBody)} />
        <rect x="35" y="17" width="1.5" height="14" rx="0.75" {...stylex.props(styles.plugGrip)} />
        <rect x="39" y="17" width="1.5" height="14" rx="0.75" {...stylex.props(styles.plugGrip)} />
        <rect x="43" y="17" width="1.5" height="14" rx="0.75" {...stylex.props(styles.plugGrip)} />
      </g>
      <rect x="80" y="5" width="26" height="38" rx="7" {...stylex.props(styles.socketHousing)} />
      <rect x="80" y="10" width="3" height="28" rx="1.5" {...stylex.props(styles.socketFace)} />
      <rect x="80" y="14.5" width="6" height="5" rx="1.5" {...stylex.props(styles.socketSlot)} />
      <rect x="80" y="28.5" width="6" height="5" rx="1.5" {...stylex.props(styles.socketSlot)} />
      <circle cx="92" cy="11" r="1.8" {...stylex.props(styles.lamp)} />
      <circle cx="92" cy="11" r="4.5" {...stylex.props(styles.glow, lamp)} />
      <circle cx="92" cy="11" r="1.8" {...stylex.props(lamp)} />
      <rect x="100" y="0" width="8" height="48" {...stylex.props(styles.wall)} />
      <rect x="100" y="0" width="1" height="48" {...stylex.props(styles.wallEdge)} />
    </svg>
  );
}

export function NoMachineHint({
  variant,
  title,
  message,
  downloadLabel,
  reportBugLabel,
  discordMessage,
  discordLabel,
  onDownloadClient,
  onReportBug,
}: NoMachineHintProps) {
  const starting = variant === 'daemon-starting';
  return (
    <div role="status" {...stylex.props(styles.card)}>
      <PlugArt seated={starting} />
      <div {...stylex.props(styles.body)}>
        <p {...stylex.props(styles.title)}>{title}</p>
        <p {...stylex.props(styles.message)}>{message}</p>
        <div {...stylex.props(styles.actions)}>
          {starting ? (
            <Button type="button" variant="secondary" size="small" onClick={onReportBug}>
              <Bug size={14} aria-hidden="true" />
              {reportBugLabel}
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="small" onClick={onDownloadClient}>
              {downloadLabel}
              <ExternalLink size={14} aria-hidden="true" />
            </Button>
          )}
          <p {...stylex.props(styles.discord)}>
            {discordMessage}{' '}
            <a
              href="https://discord.gg/E8mZtMu38s"
              target="_blank"
              rel="noopener noreferrer"
              {...stylex.props(styles.discordLink)}
            >
              {discordLabel}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
