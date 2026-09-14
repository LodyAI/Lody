import * as stylex from '@stylexjs/stylex';
import { forwardRef, type CSSProperties, type ReactNode, type SVGProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { duration, ease } from '../tokens/scales.stylex';
import { ICON_STROKE } from './icon';

/**
 * The icons that have two states, and the way between them.
 *
 * Each one is a single `<svg>` whose parts are functions of one number, `--t`,
 * from 0 to 1. The component sets `--t` from its prop and lets CSS transition
 * it, so the parts — a divider's position, a chevron's angle, a check's drawn
 * length — interpolate without a script driving them. Only transform, opacity
 * and dash offset move; no path morphs. So at rest the drawing is the same path
 * the static set uses, and where the custom-property transition is not
 * supported the icon still snaps to the right state.
 */
const T = '--lody-icon-t';

let registered = false;
function registerT() {
  if (registered || typeof CSS === 'undefined' || !('registerProperty' in CSS)) return;
  registered = true;
  try {
    CSS.registerProperty({ name: T, syntax: '<number>', inherits: true, initialValue: '0' });
  } catch {
    // Registered already by another copy of this module: the property is there.
  }
}

const t = `var(${T})`;
const NO_MOTION = '@media (prefers-reduced-motion: reduce)';

const styles = stylex.create({
  icon: {
    display: 'block',
    width: '100%',
    height: '100%',
    flexShrink: 0,
    transitionProperty: T,
    transitionDuration: { default: duration.slow, [NO_MOTION]: '0ms' },
    transitionTimingFunction: ease.standard,
  },
  centred: { transformBox: 'view-box', transformOrigin: '12px 12px' },
  // sidebar: the divider slides from 9.5 to 6.5, the dashes scale out, the chevron slides in.
  sidebarDivider: { transformBox: 'view-box', transform: `translateX(calc(${t} * -3px))` },
  sidebarDashes: {
    transformBox: 'view-box',
    transformOrigin: '5.5px 0',
    opacity: `calc(1 - ${t})`,
    transform: `scaleX(calc(1 - ${t}))`,
  },
  sidebarChevron: {
    transformBox: 'view-box',
    opacity: t,
    transform: `translateX(calc((1 - ${t}) * -2px))`,
  },
  chevron: {
    transformBox: 'view-box',
    transformOrigin: '12px 12px',
    transform: `rotate(calc(${t} * 180deg))`,
  },
  drawn: { strokeDasharray: 1, strokeDashoffset: `calc(1 - ${t})` },
  pupil: {
    transformBox: 'view-box',
    transformOrigin: '12px 12px',
    transform: `scale(calc(1 - ${t} * 0.6))`,
  },
  playOut: {
    transformBox: 'view-box',
    transformOrigin: '12px 12px',
    opacity: `calc(1 - ${t})`,
    transform: `scale(calc(1 - ${t} * 0.4))`,
  },
  pauseIn: {
    transformBox: 'view-box',
    transformOrigin: '12px 12px',
    opacity: t,
    transform: `scale(calc(0.6 + ${t} * 0.4))`,
  },
  star: {
    transformBox: 'view-box',
    transformOrigin: '12px 12px',
    fill: 'currentColor',
    fillOpacity: t,
    transform: `scale(calc(1 + sin(${t} * 3.1416) * 0.15))`,
  },
  bell: {
    transformBox: 'view-box',
    transformOrigin: '12px 4px',
    transform: `rotate(calc(sin(${t} * 6.2832) * 14deg))`,
  },
  spin: {
    transformBox: 'view-box',
    transformOrigin: '12px 12px',
    transform: `rotate(calc(${t} * 360deg))`,
  },
  fadeOut: { opacity: `calc(1 - ${t})` },
  fadeIn: { opacity: t },
});

export interface StatefulIconProps extends Omit<SVGProps<SVGSVGElement>, 'className' | 'children'> {
  /** What the icon says, for a screen reader; without one it is decoration. */
  title?: string;
  className?: string;
}

interface FrameProps extends StatefulIconProps {
  /** Where between the two states the icon is: 0 or 1 from a prop, anything between from a test. */
  t: number;
  children: ReactNode;
}

const Frame = forwardRef<SVGSVGElement, FrameProps>(function Frame(
  { t: value, title, className, children, ...rest },
  ref
) {
  registerT();
  const sx = stylex.props(styles.icon);
  const labelled = title != null && title !== '';
  return (
    <svg
      ref={ref}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      data-t={value}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={{ ...sx.style, [T]: value } as CSSProperties}
    >
      {labelled ? <title>{title}</title> : null}
      {children}
    </svg>
  );
});

const PANEL = 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z';

/** The sidebar, and whether it is there: the same frame, its divider moved and its rows gone. */
export const SidebarToggleIcon = forwardRef<
  SVGSVGElement,
  StatefulIconProps & { collapsed: boolean }
>(function SidebarToggleIcon({ collapsed, ...rest }, ref) {
  return (
    <Frame ref={ref} t={collapsed ? 1 : 0} {...rest}>
      <path d={PANEL} />
      <path d="M9.5 4.5v15" {...stylex.props(styles.sidebarDivider)} />
      <g {...stylex.props(styles.sidebarDashes)}>
        <path d="M6 8h1.5M6 10.5h1.5M6 13h1.5" />
      </g>
      <path d="M12.5 9.5l2.5 2.5-2.5 2.5" {...stylex.props(styles.sidebarChevron)} />
    </Frame>
  );
});

/** A disclosure's chevron: down when closed, turned to up when open. */
export const ChevronToggleIcon = forwardRef<SVGSVGElement, StatefulIconProps & { open: boolean }>(
  function ChevronToggleIcon({ open, ...rest }, ref) {
    return (
      <Frame ref={ref} t={open ? 1 : 0} {...rest}>
        <path d="M7 10l5 5 5-5" {...stylex.props(styles.chevron)} />
      </Frame>
    );
  }
);

/** A check that draws itself: nothing, then the tick, stroke by stroke. */
export const CheckDrawIcon = forwardRef<SVGSVGElement, StatefulIconProps & { checked: boolean }>(
  function CheckDrawIcon({ checked, ...rest }, ref) {
    return (
      <Frame ref={ref} t={checked ? 1 : 0} {...rest}>
        <path d="M5 12.5l4.5 4.5 9.5-10" pathLength={1} {...stylex.props(styles.drawn)} />
      </Frame>
    );
  }
);

/** An eye, and the slash across it: the pupil shrinks as the line is drawn. */
export const EyeToggleIcon = forwardRef<SVGSVGElement, StatefulIconProps & { hidden: boolean }>(
  function EyeToggleIcon({ hidden, ...rest }, ref) {
    return (
      <Frame ref={ref} t={hidden ? 1 : 0} {...rest}>
        <path d="M3.5 12c2-4.5 5-6.5 8.5-6.5s6.5 2 8.5 6.5c-2 4.5-5 6.5-8.5 6.5S5.5 16.5 3.5 12z" />
        <circle cx="12" cy="12" r="2.75" {...stylex.props(styles.pupil)} />
        <path d="M4.5 4.5l15 15" pathLength={1} {...stylex.props(styles.drawn)} />
      </Frame>
    );
  }
);

/** Play and pause, one handing over to the other through the centre. */
export const PlayPauseIcon = forwardRef<SVGSVGElement, StatefulIconProps & { playing: boolean }>(
  function PlayPauseIcon({ playing, ...rest }, ref) {
    return (
      <Frame ref={ref} t={playing ? 1 : 0} {...rest}>
        <path
          d="M8 6.4c0-.8.9-1.3 1.6-.9l8.9 5.6c.7.4.7 1.4 0 1.8l-8.9 5.6c-.7.4-1.6-.1-1.6-.9z"
          {...stylex.props(styles.playOut)}
        />
        <g {...stylex.props(styles.pauseIn)}>
          <rect x="7" y="5.5" width="3.5" height="13" rx="1" />
          <rect x="13.5" y="5.5" width="3.5" height="13" rx="1" />
        </g>
      </Frame>
    );
  }
);

/** A star that fills when it is chosen, with a pop that settles back to size. */
export const StarToggleIcon = forwardRef<SVGSVGElement, StatefulIconProps & { starred: boolean }>(
  function StarToggleIcon({ starred, ...rest }, ref) {
    return (
      <Frame ref={ref} t={starred ? 1 : 0} {...rest}>
        <path
          d="M12 4l2.5 5.2 5.7.8-4.1 4 1 5.7L12 17l-5.1 2.7 1-5.7-4.1-4 5.7-.8z"
          {...stylex.props(styles.star)}
        />
      </Frame>
    );
  }
);

/**
 * A bell that rings once each time `ringing` changes: it swings about its nub
 * and comes back to rest, so both ends of the transition are the same drawing.
 */
export const BellRingIcon = forwardRef<SVGSVGElement, StatefulIconProps & { ringing: boolean }>(
  function BellRingIcon({ ringing, ...rest }, ref) {
    return (
      <Frame ref={ref} t={ringing ? 1 : 0} {...rest}>
        <g {...stylex.props(styles.bell)}>
          <path d="M12 3.5V5M6.5 17v-6a5.5 5.5 0 0 1 11 0v6l1.5 1.5H5zM10 20.5a2 2 0 0 0 4 0" />
        </g>
      </Frame>
    );
  }
);

/** A refresh that turns once each time `turned` changes. A spinner that keeps going is `Spinner`. */
export const RefreshTurnIcon = forwardRef<SVGSVGElement, StatefulIconProps & { turned: boolean }>(
  function RefreshTurnIcon({ turned, ...rest }, ref) {
    return (
      <Frame ref={ref} t={turned ? 1 : 0} {...rest}>
        <path
          d="M19.5 12a7.5 7.5 0 0 1-13 5.1L4.5 15M4.5 12a7.5 7.5 0 0 1 13-5.1L19.5 9M19.5 4.5V9H15M4.5 19.5V15H9"
          {...stylex.props(styles.spin)}
        />
      </Frame>
    );
  }
);

/** A folder and its open state: the back panel stays, the front flap is exchanged. */
export const FolderToggleIcon = forwardRef<SVGSVGElement, StatefulIconProps & { open: boolean }>(
  function FolderToggleIcon({ open, ...rest }, ref) {
    return (
      <Frame ref={ref} t={open ? 1 : 0} {...rest}>
        <path d="M3.5 17.5v-10a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1.6" />
        <path
          d="M20.5 10.6v5.9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2M3.5 10.5h17"
          {...stylex.props(styles.fadeOut)}
        />
        <path
          d="M3.5 17.5l2.6-6a1.5 1.5 0 0 1 1.4-.9h12.6a1 1 0 0 1 .9 1.4l-2.4 5.6a1.5 1.5 0 0 1-1.4.9H5.5a2 2 0 0 1-2-2z"
          {...stylex.props(styles.fadeIn)}
        />
      </Frame>
    );
  }
);

/** The frame itself, for a board or a test that wants to pin `--t` between the states. */
export const IconFrame = Frame;
