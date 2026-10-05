import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'framer-motion';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { PencilLine } from 'lucide-react';
import { isIOSRuntimeEnvironment } from '@/lib/native-platform';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';

export type MobileBottomTabBarTabSpec<TabKey extends string = string> = {
  key: TabKey;
  ios: ReactNode;
  material: ReactNode;
  /** Already-translated label rendered under the icon. */
  label: string;
};

/* Re-exported under both names for back-compat. */
export type MobileWorkspaceTab = 'local' | 'github' | 'chat';

export type MobileWorkspaceTabBarLabels = {
  localTab?: string;
  githubTab?: string;
  chatTab?: string;
  newChatAriaLabel?: string;
};

export type MobileWorkspaceTabBarScrollSignal = {
  readonly scrollTop: number;
  readonly seq: number;
};

export type MobileWorkspaceTabBarProps<TabKey extends string = string> = {
  tabs: ReadonlyArray<MobileBottomTabBarTabSpec<TabKey>>;
  /** Active tab. `null` shows no highlight (e.g. on the settings
     page, which is reachable from this bar but isn't itself one of
     the tabs). */
  selectedTab: TabKey | null;
  onTabSelect: (tab: TabKey) => void;
  /** When provided, renders the separate new-chat chip to the right
     of the tabbar pill. Omit when the surface doesn't make sense as
     a new-conversation entry point. */
  onNewChat?: () => void;
  newChatAriaLabel?: string;
  ariaLabel?: string;
  /** Retained for caller compatibility. Motion is instance-local and no longer
     uses shared layout identities. */
  layoutId?: string;
  theme?: 'ios' | 'material';
  /** When provided, the dock observes scroll on this element and
     collapses on downward scroll and expands on upward scroll. Omit to keep the dock
     always expanded. */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  /** Imperative scroll signal for surfaces whose real scroll state is not a
     native DOM scroll event on a stable element, e.g. Monaco. */
  scrollSignal?: MobileWorkspaceTabBarScrollSignal | null;
  /** Aria label for the "tap to expand" affordance on the collapsed
     state's single visible chip. Defaults to a Chinese fallback. */
  expandAriaLabel?: string;
};

// One persistent spring owns all geometry. Retargeting preserves its velocity.
const DOCK_SPRING = {
  stiffness: 420,
  damping: 40,
  mass: 1,
  restDelta: 0.001,
  restSpeed: 0.001,
};
const SCROLL_THRESHOLD = 14;
const AT_TOP_SLACK = 4;

// The global reduced-motion rule gives * a nonzero transition duration.
// Explicitly opt out so CSS cannot interpolate MotionValue updates a second time.
const styles = stylex.create({
  dock: {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    display: 'flex',
    alignItems: 'end',
    gap: space[3],
    paddingInline: space[4],
    paddingTop: space[2],
    paddingBottom: `calc(${space[2]} + var(--k-safe-area-bottom, 0px))`,
    pointerEvents: 'none',
  },
  slot: { position: 'relative', flex: 1, minWidth: 0, height: 56 },
  shell: {
    transitionProperty: 'none',
    position: 'absolute',
    bottom: 0,
    left: 0,
    overflow: 'hidden',
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.medium,
    color: colors.label,
    pointerEvents: 'auto',
  },
  activeContent: { color: colors.accent },
  tabHover: {
    '::before': {
      content: '""',
      position: 'absolute',
      inset: '6px 2px',
      borderRadius: radius.full,
      pointerEvents: 'none',
      backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    },
  },
  highlight: {
    transitionProperty: 'none',
    position: 'absolute',
    inset: '6px 2px',
    borderRadius: radius.full,
    backgroundColor: `color-mix(in srgb, ${colors.accent} 20%, transparent)`,
  },
  icon: {
    transitionProperty: 'none',
    position: 'absolute',
    top: 0,
    left: '50%',
    marginLeft: -12,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
  },
  label: {
    transitionProperty: 'none',
    position: 'absolute',
    bottom: 7,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: '0.72rem',
    lineHeight: 1,
    whiteSpace: 'nowrap',
  },
  fabSlot: {
    width: 56,
    height: 56,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'end',
    justifyContent: 'end',
    pointerEvents: 'auto',
  },
});

function DockTab<TabKey extends string>({
  tab,
  index,
  count,
  width,
  progress,
  active,
  collapsed,
  theme,
  expandAriaLabel,
  buttonRef,
  onClick,
}: {
  tab: MobileBottomTabBarTabSpec<TabKey>;
  index: number;
  count: number;
  width: MotionValue<number>;
  progress: MotionValue<number>;
  active: boolean;
  collapsed: boolean;
  theme: 'ios' | 'material';
  expandAriaLabel: string;
  buttonRef?: RefObject<HTMLElement | null>;
  onClick: () => void;
}) {
  const x = useTransform(() => (8 + (index * (width.get() - 16)) / count) * (1 - progress.get()));
  const cellWidth = useTransform(() => {
    const cell = (width.get() - 16) / count;
    return cell + (48 - cell) * progress.get();
  });
  const height = useTransform(progress, [0, 1], [56, 48]);
  const iconY = useTransform(progress, [0, 1], [8, 12]);
  const opacity = useTransform(progress, [0, 0.45], [1, 0]);
  const labelOpacity = useTransform(progress, [0, 0.4], [1, 0]);
  const labelY = useTransform(progress, [0, 1], [0, -5]);
  // Only crossing the visibility boundary changes the React snapshot.
  const subscribe = useCallback((notify: () => void) => progress.on('change', notify), [progress]);
  const visible = useSyncExternalStore(
    subscribe,
    () => progress.get() < 0.4,
    () => true
  );
  const hidden = !active && (collapsed || !visible);
  const localButtonRef = useRef<HTMLElement>(null);
  useImperativeHandle(buttonRef, () => localButtonRef.current, []);

  return (
    <Button
      ref={localButtonRef}
      variant="ghost"
      shape="pill"
      className={stylex.props(!active && styles.tabHover).className}
      render={
        <motion.button
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            padding: 0,
            x,
            width: cellWidth,
            height,
            opacity: active ? 1 : opacity,
            zIndex: active ? 2 : 1,
            transition: 'none',
            backgroundColor: collapsed ? undefined : 'transparent',
          }}
        />
      }
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={collapsed && active ? expandAriaLabel : tab.label}
      aria-hidden={hidden || undefined}
      inert={hidden}
      tabIndex={hidden ? -1 : 0}
      onClick={onClick}
    >
      {active && (
        <motion.span
          aria-hidden="true"
          {...stylex.props(styles.highlight)}
          style={{ opacity: labelOpacity }}
        />
      )}
      <motion.span
        {...stylex.props(styles.icon, active && styles.activeContent)}
        // Preserve the existing consumer-SVG sizing contract, including react-icons.
        className={`${stylex.props(styles.icon, active && styles.activeContent).className} [&>svg]:h-6 [&>svg]:w-6`}
        style={{ y: iconY }}
      >
        {theme === 'ios' ? tab.ios : tab.material}
      </motion.span>
      <motion.span
        {...stylex.props(styles.label, active && styles.activeContent)}
        style={{
          opacity: labelOpacity,
          y: labelY,
        }}
      >
        {tab.label}
      </motion.span>
    </Button>
  );
}

export function MobileWorkspaceTabBar<TabKey extends string = string>({
  tabs,
  selectedTab,
  onTabSelect,
  onNewChat,
  newChatAriaLabel,
  ariaLabel,
  theme,
  scrollContainerRef,
  scrollSignal,
  expandAriaLabel,
}: MobileWorkspaceTabBarProps<TabKey>) {
  const resolvedTheme = theme ?? (isIOSRuntimeEnvironment() ? 'ios' : 'material');
  const [minimized, setMinimized] = useState(false);
  // A page outside this tab set must never collapse into an empty, unreachable pill.
  const hasSelection = tabs.some((tab) => tab.key === selectedTab);
  const collapsed = minimized && hasSelection;
  const slot = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const selectedTabRef = useRef<HTMLElement>(null);
  const width = useMotionValue(48);
  const reduce = useReducedMotion();
  const progress = useSpring(0, DOCK_SPRING);
  const shellWidth = useTransform(() => width.get() + (48 - width.get()) * progress.get());
  const height = useTransform(progress, [0, 1], [56, 48]);
  const cornerRadius = useTransform(progress, [0, 1], [28, 24]);

  useLayoutEffect(() => {
    const element = slot.current;
    if (!element) return undefined;
    width.set(element.getBoundingClientRect().width);
    return observeResizeOnAnimationFrame(element, ([entry]) => width.set(entry.contentRect.width));
  }, [width]);

  useLayoutEffect(() => {
    if (reduce) progress.jump(collapsed ? 1 : 0);
    else progress.set(collapsed ? 1 : 0);
  }, [collapsed, progress, reduce]);

  const cumulativeScrollRef = useRef(0);
  const directionRef = useRef(0);
  const lastScrollTopRef = useRef<number | null>(null);
  const applyScrollTop = useCallback((scrollTop: number) => {
    const top = Math.max(0, scrollTop);
    const delta = top - (lastScrollTopRef.current ?? top);
    lastScrollTopRef.current = top;
    if (top <= AT_TOP_SLACK) {
      cumulativeScrollRef.current = 0;
      directionRef.current = 0;
      setMinimized(false);
    } else if (delta !== 0) {
      const direction = Math.sign(delta);
      if (direction !== directionRef.current) cumulativeScrollRef.current = 0;
      directionRef.current = direction;
      cumulativeScrollRef.current += Math.abs(delta);
      if (cumulativeScrollRef.current >= SCROLL_THRESHOLD) {
        // Move focus before React applies inert: browsers may blur an inert
        // control before a layout effect can discover the previous focus.
        const selectedButton = selectedTabRef.current;
        const focusedElement = document.activeElement;
        if (
          direction > 0 &&
          selectedButton &&
          focusedElement !== selectedButton &&
          shell.current?.contains(focusedElement)
        ) {
          selectedButton.focus({ preventScroll: true });
        }
        setMinimized(direction > 0);
      }
    }
  }, []);

  const hasScrollSignal = scrollSignal != null;
  useEffect(() => {
    // Monaco's signal and a mounted list can coexist. Only the active source
    // owns the baseline; switching sources must not manufacture a scroll delta.
    cumulativeScrollRef.current = 0;
    directionRef.current = 0;
    lastScrollTopRef.current = null;
    if (hasScrollSignal) return undefined;
    const element = scrollContainerRef?.current;
    if (!element) return undefined;
    applyScrollTop(element.scrollTop);
    const handleScroll = () => applyScrollTop(element.scrollTop);
    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [applyScrollTop, scrollContainerRef, hasScrollSignal]);

  useEffect(() => {
    if (scrollSignal) applyScrollTop(scrollSignal.scrollTop);
  }, [applyScrollTop, scrollSignal]);

  const expand = () => {
    cumulativeScrollRef.current = 0;
    directionRef.current = 0;
    setMinimized(false);
  };

  return (
    <div {...stylex.props(styles.dock)}>
      <div ref={slot} {...stylex.props(styles.slot)}>
        <motion.div
          ref={shell}
          role="tablist"
          aria-label={ariaLabel ?? '导航'}
          {...stylex.props(styles.shell)}
          style={{ width: shellWidth, height, borderRadius: cornerRadius }}
        >
          {tabs.map((tab, index) => (
            <DockTab
              key={tab.key}
              tab={tab}
              index={index}
              count={tabs.length}
              width={width}
              progress={progress}
              active={tab.key === selectedTab}
              buttonRef={tab.key === selectedTab ? selectedTabRef : undefined}
              collapsed={collapsed}
              theme={resolvedTheme}
              expandAriaLabel={expandAriaLabel ?? '展开导航'}
              onClick={() => (collapsed ? expand() : onTabSelect(tab.key))}
            />
          ))}
        </motion.div>
      </div>
      {onNewChat && (
        <div {...stylex.props(styles.fabSlot)}>
          <Button
            shape="pill"
            type="button"
            aria-label={newChatAriaLabel ?? '新建对话'}
            onClick={onNewChat}
            render={
              <motion.button
                style={{
                  width: height,
                  height,
                  transition: 'none',
                }}
              />
            }
          >
            <PencilLine size={24} strokeWidth={1.85} aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}
