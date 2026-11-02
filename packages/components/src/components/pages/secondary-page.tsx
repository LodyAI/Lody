import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import lodyLogo from '@/assets/lody-icon.png';

/**
 * Where a secondary page stands. Every page a person lands on from outside the
 * app (an invitation, a device code, an email link, a checkout or GitHub
 * return) is in one of these, and the connector between the two tiles shows it.
 *
 * - `arrive`: Lody is still checking what arrived; no action yet.
 * - `ask`: the next move is the person's.
 * - `done`: the connection is made.
 * - `blocked`: it could not be made.
 */
export type SecondaryPageState = 'arrive' | 'ask' | 'done' | 'blocked';

export interface SecondaryPageProps {
  state: SecondaryPageState;
  /** The outside party: GitHub, a terminal, an inbox, a card, the invitee. */
  from: ReactNode;
  /** Defaults to the Lody mark. */
  to?: ReactNode;
  /** Accessible name of the two tiles, e.g. "GitHub and Lody". */
  markLabel: string;
  /** The fact, in ink. */
  title: ReactNode;
  /** The explanation, in grey at the title's size. */
  description: ReactNode;
  /** A value the person reads or copies, in the one recessed well. */
  well?: ReactNode;
  /** Free content between the title and the actions, e.g. a form's fields. */
  children?: ReactNode;
  /** Id on the heading, so a form on the page can name itself by it. */
  headingId?: string;
  /** Up to two `@lody/ui` buttons: the way back first, the way forward last. */
  actions?: ReactNode;
  /** One quiet line under the actions: an expiry, a fallback. */
  note?: ReactNode;
  footer?: ReactNode;
}

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

const rise = stylex.keyframes({
  from: { opacity: 0, transform: 'translateY(4px)' },
  to: { opacity: 1, transform: 'none' },
});

const flow = stylex.keyframes({
  from: { strokeDashoffset: 0 },
  to: { strokeDashoffset: -10 },
});

const blink = stylex.keyframes({
  '0%, 100%': { opacity: 0.25 },
  '30%': { opacity: 1 },
});

const styles = stylex.create({
  page: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100dvh',
    width: '100%',
    paddingTop: `max(${space[8]}, env(safe-area-inset-top))`,
    paddingBottom: `max(${space[6]}, env(safe-area-inset-bottom))`,
    paddingInline: space[6],
    backgroundColor: colors.background,
    color: colors.label,
  },
  main: {
    flexGrow: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[8],
    width: '100%',
    maxWidth: 360,
    // Optically centred: a little above the middle of the window.
    paddingBottom: '8vh',
  },
  mark: {
    display: 'flex',
    alignItems: 'center',
    height: 48,
  },
  tile: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 48,
    height: 48,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.raisedBackground,
    boxShadow: shadow.raised,
    color: colors.label,
    transitionProperty: 'opacity',
    transitionDuration: duration.slow,
    transitionTimingFunction: ease.standard,
  },
  tileFaded: {
    opacity: 0.4,
  },
  logo: {
    width: 34,
    height: 34,
    objectFit: 'contain',
    userSelect: 'none',
  },
  connector: {
    display: 'block',
    flexShrink: 0,
    overflow: 'visible',
  },
  line: {
    fill: 'none',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    transitionProperty: 'stroke',
    transitionDuration: duration.slow,
  },
  pending: {
    stroke: colors.gray3,
    strokeDasharray: '1 4',
  },
  flowing: {
    animationName: { default: flow, [REDUCED_MOTION]: 'none' },
    animationDuration: '600ms',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  solid: {
    stroke: colors.label,
  },
  node: {
    strokeWidth: 1.5,
    transitionProperty: 'fill, stroke',
    transitionDuration: duration.slow,
  },
  nodeOpen: {
    fill: colors.background,
    stroke: colors.gray3,
  },
  nodeDone: {
    fill: colors.label,
    stroke: colors.label,
  },
  nodeBlocked: {
    fill: colors.background,
    stroke: colors.destructive,
  },
  dot: {
    fill: colors.label,
    opacity: 0.25,
    animationName: { default: blink, [REDUCED_MOTION]: 'none' },
    animationDuration: '1200ms',
    animationIterationCount: 'infinite',
  },
  glyph: {
    fill: 'none',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
  glyphMuted: { stroke: colors.secondaryLabel },
  glyphOnInk: { stroke: colors.background },
  glyphDestructive: { stroke: colors.destructive },
  copy: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
    animationName: { default: rise, [REDUCED_MOTION]: 'none' },
    animationDuration: duration.slow,
    animationTimingFunction: ease.standard,
  },
  heading: {
    margin: 0,
    fontSize: 21,
    lineHeight: '29px',
    fontWeight: 560,
    letterSpacing: '-0.014em',
    textWrap: 'balance',
  },
  title: {
    display: 'block',
    color: colors.label,
  },
  description: {
    display: 'block',
    color: colors.secondaryLabel,
    fontWeight: 500,
  },
  well: {
    boxSizing: 'border-box',
    paddingBlock: space[1.5],
    paddingInline: space[3],
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
    wordBreak: 'break-word',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
  },
  actions: {
    display: 'grid',
    gridAutoColumns: 'minmax(0, 1fr)',
    gridAutoFlow: 'column',
    gap: space[2],
  },
  note: {
    margin: 0,
    marginTop: `calc(${space[3]} - ${space[6]})`,
    minHeight: text.footnoteLeading,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
  footer: {
    display: 'flex',
    justifyContent: 'center',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
});

/**
 * The layout every secondary page shares: two tiles joined by a connector that
 * carries the state, a two-tone title, one optional well for a value, and at
 * most two equal-width actions. No card, border or illustration; the connector
 * is the only moving part.
 */
export function SecondaryPage({
  state,
  from,
  to,
  markLabel,
  title,
  description,
  well,
  headingId,
  actions,
  note,
  footer,
  children,
}: SecondaryPageProps) {
  return (
    <div {...stylex.props(styles.page)} data-state={state}>
      <main {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.column)}>
          <div role="img" aria-label={markLabel} {...stylex.props(styles.mark)}>
            <span {...stylex.props(styles.tile)}>{from}</span>
            <Connector state={state} />
            <span {...stylex.props(styles.tile, state === 'blocked' && styles.tileFaded)}>
              {to ?? <LodyMark />}
            </span>
          </div>
          {/* Keyed by state so the copy rises in again whenever it changes. */}
          <div key={state} {...stylex.props(styles.copy)}>
            <h1 {...stylex.props(styles.heading)} id={headingId} aria-live="polite">
              <span {...stylex.props(styles.title)}>{title}</span>
              <span {...stylex.props(styles.description)}>{description}</span>
            </h1>
            {well ? <div {...stylex.props(styles.well)}>{well}</div> : null}
            {children ? <div {...stylex.props(styles.content)}>{children}</div> : null}
            {actions ? <div {...stylex.props(styles.actions)}>{actions}</div> : null}
            {note ? <p {...stylex.props(styles.note)}>{note}</p> : null}
          </div>
        </div>
      </main>
      {footer ? <footer {...stylex.props(styles.footer)}>{footer}</footer> : null}
    </div>
  );
}

function LodyMark() {
  return <img src={lodyLogo} alt="" draggable={false} {...stylex.props(styles.logo)} />;
}

function Connector({ state }: { state: SecondaryPageState }) {
  const leftSolid = state === 'done' || state === 'blocked';
  const rightSolid = state === 'done';
  return (
    <svg
      width="76"
      height="48"
      viewBox="0 0 76 48"
      aria-hidden="true"
      {...stylex.props(styles.connector)}
    >
      <line
        x1="7"
        y1="24"
        x2="27"
        y2="24"
        {...stylex.props(
          styles.line,
          leftSolid ? styles.solid : styles.pending,
          state === 'arrive' && styles.flowing
        )}
      />
      <line
        x1="49"
        y1="24"
        x2="69"
        y2="24"
        {...stylex.props(
          styles.line,
          rightSolid ? styles.solid : styles.pending,
          state === 'arrive' && styles.flowing
        )}
      />
      <circle
        cx="38"
        cy="24"
        r="9.5"
        {...stylex.props(
          styles.node,
          state === 'done'
            ? styles.nodeDone
            : state === 'blocked'
              ? styles.nodeBlocked
              : styles.nodeOpen
        )}
      />
      {state === 'arrive'
        ? [34, 38, 42].map((cx, index) => (
            <circle
              key={cx}
              cx={cx}
              cy="24"
              r="1.4"
              {...stylex.props(styles.dot)}
              style={{ animationDelay: `${index * 200}ms` }}
            />
          ))
        : null}
      {state === 'ask' ? (
        <path d="M34.5 24h7M39 21l3 3-3 3" {...stylex.props(styles.glyph, styles.glyphMuted)} />
      ) : null}
      {state === 'done' ? (
        <path d="M34 24.2l2.7 2.6 5.3-5.6" {...stylex.props(styles.glyph, styles.glyphOnInk)} />
      ) : null}
      {state === 'blocked' ? (
        <path d="M35 21l6 6M41 21l-6 6" {...stylex.props(styles.glyph, styles.glyphDestructive)} />
      ) : null}
    </svg>
  );
}
