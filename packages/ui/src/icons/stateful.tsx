import * as stylex from '@stylexjs/stylex';
import { forwardRef, type CSSProperties, type ReactNode, type SVGProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { duration, ease } from '../tokens/scales.stylex';
import { ICON_STROKE } from './icon';
import { ICONS, type IconName } from './registry';

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

/** The one path an icon of the static set is drawn with, for a state that moves all of it. */
function onePath(name: IconName): string {
  const mark = ICONS[name].marks[0];
  if (!('path' in mark)) throw new Error(`${name} is not drawn as a single path`);
  return mark.path;
}

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
  /*
   * sidebar: the divider slides from 10 to 8.5 and the rows retract into the
   * rail as marks, so the collapsed state is still a sidebar — a narrow one
   * showing only marks — rather than a frame with a symbol pasted on it.
   *
   * The rail those marks live in is 5 units wide and its two strokes take 1.5
   * of them, which leaves 3.5: one mark of 2, with 0.75 of air on either side.
   * A third mark does not fit that rhythm, so the middle row fades and the
   * outer two become the marks.
   *
   * A row retracts by its dash and not by `scaleX`. A horizontal scale leaves
   * a stroke's thickness alone but squashes its round caps, so a row scaled to
   * nothing is a 0.8-wide sliver rather than the 2-wide mark
   * `sidebar-collapsed` draws — the two states would be two different
   * drawings. A dash retracted to zero length is a round cap and nothing else,
   * which is a dot; the uniform scale that carries it from 1.5 to 2 grows the
   * stroke without touching its shape.
   */
  sidebarDivider: { transformBox: 'view-box', transform: `translateX(calc(${t} * -1.5px))` },
  // The gap is longer than the path, so the repeat lands past the end and the
  // retracted row is one dot at its start rather than one at either end.
  sidebarRow: { strokeDasharray: `calc(1 - ${t}) 2` },
  sidebarRowTop: {
    transformBox: 'view-box',
    transformOrigin: '5.5px 8px',
    transform: `translate(calc(${t} * 0.5px), calc(${t} * 1.5px)) scale(calc(1 + ${t} / 3))`,
  },
  sidebarRowMiddle: {
    transformBox: 'view-box',
    transformOrigin: '5.5px 10.5px',
    transform: `translate(calc(${t} * 0.5px), calc(${t} * 1.5px)) scale(calc(1 + ${t} / 3))`,
    opacity: `calc(1 - ${t})`,
  },
  sidebarRowBottom: {
    transformBox: 'view-box',
    transformOrigin: '5.5px 13px',
    transform: `translate(calc(${t} * 0.5px), calc(${t} * 1.5px)) scale(calc(1 + ${t} / 3))`,
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
  // The bell swings about its nub, so the mouth is 16 units from the pivot and
  // the corner furthest from it decides the angle: at 14 degrees the stroke's
  // edge lands 0.03 from the canvas, which is inside but is not a margin. 12
  // leaves 0.42 and reads the same.
  bell: {
    transformBox: 'view-box',
    transformOrigin: '12px 4px',
    transform: `rotate(calc(sin(${t} * 6.2832) * 12deg))`,
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

/**
 * The bell swings as one piece, so it is the static drawing and not a copy of
 * it: a stateful icon that restates a path drifts from the set the first time
 * the set is redrawn, which is how the collapsed sidebar came to be two
 * different pictures. `test/icons.test.tsx` holds this to the registry.
 */
const BELL = onePath('bell');

/**
 * The sidebar, and whether it is open: the same frame, its divider moved and
 * its rows retracted to the marks of a rail. Nothing is added in either state,
 * and t = 1 is `sidebar-collapsed` exactly — the marks land on (6, 9.5) and
 * (6, 14.5) at a weight of 2, which is what the registry draws there.
 */
export const SidebarToggleIcon = forwardRef<
  SVGSVGElement,
  StatefulIconProps & { collapsed: boolean }
>(function SidebarToggleIcon({ collapsed, ...rest }, ref) {
  return (
    <Frame ref={ref} t={collapsed ? 1 : 0} {...rest}>
      <path d={PANEL} />
      <path d="M10 4.5v15" {...stylex.props(styles.sidebarDivider)} />
      <path
        d="M5.5 8h2.5"
        pathLength={1}
        {...stylex.props(styles.sidebarRow, styles.sidebarRowTop)}
      />
      <path
        d="M5.5 10.5h2.5"
        pathLength={1}
        {...stylex.props(styles.sidebarRow, styles.sidebarRowMiddle)}
      />
      <path
        d="M5.5 13h2.5"
        pathLength={1}
        {...stylex.props(styles.sidebarRow, styles.sidebarRowBottom)}
      />
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
          <path d={BELL} />
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
