import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import { clsx } from 'clsx';
import { useLocation } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { ScrollArea } from '@lody/ui/scroll-area';
import { consumeMobileBackNavigation } from '@/lib/mobile-back-navigation';
import { withClassName } from '@/lib/stylex';
// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../style/theme-scale.stylex';
import type { MobileWorkspaceTab, MobileWorkspaceTabBarLabels } from './mobile-workspace-tabbar';
import { MobileDrillPageLayout, useMobileDrillAnimatedBack } from './mobile-drill-page-layout';

export type MobileSettingsLayoutProps = {
  title: string;
  isNativeApp: boolean;
  isMachineDetail: boolean;
  isAgentConfigTab: boolean;
  onBack: () => void;
  /** Kept for API compat with callers that still pass it — the
     settings page no longer renders the bottom workspace tabbar. */
  onWorkspaceTabSelect?: (tab: MobileWorkspaceTab) => void;
  workspaceTabLabels?: MobileWorkspaceTabBarLabels;
  children: ReactNode;
};

/**
 * The settings chrome: the drill header, the scroll region, and the safe-area
 * padding the last row needs.
 *
 * The safe-area insets are Konsta's `--k-safe-area-*` variables, added to the
 * theme's own spacing step — the same expressions Konsta's `pt-safe-*` and
 * `pb-safe-*` utilities resolve to.
 */
const styles = stylex.create({
  /**
   * The drill header: a sticky bar over the scrolling body, laid out as
   * three columns so the title sits between the back chip and an empty slot.
   */
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 30,
    display: 'grid',
    gridTemplateColumns: '2.25rem minmax(0,1fr) 2.25rem',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingTop: 'calc(var(--k-safe-area-top) + var(--spacing) * 2)',
    paddingBottom: themeSpace[2],
    paddingInlineStart: 'calc(var(--k-safe-area-left) + var(--spacing) * 3)',
    paddingInlineEnd: 'calc(var(--k-safe-area-right) + var(--spacing) * 3)',
  },
  /** The slot a machine detail's own header portals into. */
  headerSlot: { gridColumn: 'span 2 / span 2', minWidth: 0 },
  headerTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'center',
    fontSize: '0.98rem',
    fontWeight: themeFontWeight.normal,
    letterSpacing: '-0.025em',
  },
  /** The scroll region's own box. */
  main: { minHeight: 0, minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  fill: { height: '100%' },
  fillMinHeight: { height: '100%', minHeight: 0 },
  /**
   * The inner body: a column that fills the region, with the bottom safe-area
   * padding so the last setting row clears the home indicator.
   */
  body: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    paddingBottom: 'calc(var(--k-safe-area-bottom) + var(--spacing) * 4)',
  },
  /** The header's back chip: the same shape as the home screen's chip. */
  backButton: {
    display: 'inline-flex',
    height: themeSpace[9],
    width: themeSpace[9],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.card,
    color: themeColors.foreground,
    boxShadow: '0 1px 2px rgba(0,0,0,0.04),0 8px 24px -12px rgba(0,0,0,0.18)',
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    scale: { default: null, ':active': '0.97' },
  },
  backIcon: { height: themeSpace[5], width: themeSpace[5] },
});

const MobileSettingsDetailHeaderContext = createContext<HTMLElement | null | undefined>(undefined);

export function MobileSettingsDetailHeader({
  active = true,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  const target = useContext(MobileSettingsDetailHeaderContext);
  if (!active) return children;
  if (target === undefined) return children;
  return target ? createPortal(children, target) : null;
}

/**
 * Settings is a "drill" surface like session-detail: enters from the
 * right, exits via clone-overlay slide-off. Within the surface, each
 * settings sub-page re-keys the inner body so a tap on a row plays
 * the `.mobile-drill-in` keyframe on the destination, giving the
 * forward-push feel without re-mounting the layout chrome.
 *
 * Header treatment mirrors the home + project screens (the
 * `.mobile-home-glass` translucent material, three-column grid, back
 * chip at left, centered title) so all mobile detail surfaces read
 * as the same family.
 */
export function MobileSettingsLayout({
  title,
  isMachineDetail,
  isAgentConfigTab,
  onBack,
  children,
}: MobileSettingsLayoutProps) {
  const [detailHeaderTarget, setDetailHeaderTarget] = useState<HTMLDivElement | null>(null);

  return (
    <MobileSettingsDetailHeaderContext.Provider value={detailHeaderTarget}>
      <MobileDrillPageLayout onBack={onBack}>
        <header {...withClassName(stylex.props(styles.header), 'mobile-home-glass')}>
          <SettingsHeaderBackButton fallback={onBack} />
          {isMachineDetail ? (
            <div ref={setDetailHeaderTarget} {...stylex.props(styles.headerSlot)} />
          ) : (
            <>
              <h1 {...stylex.props(styles.headerTitle)}>{title}</h1>
              <div aria-hidden="true" />
            </>
          )}
        </header>

        <SettingsInnerContent isAgentConfigTab={isAgentConfigTab}>{children}</SettingsInnerContent>
      </MobileDrillPageLayout>
    </MobileSettingsDetailHeaderContext.Provider>
  );
}

/**
 * Owns the per-path drill animation for settings sub-pages. The
 * inner body is keyed by pathname so React re-mounts it on every
 * route change; the body's own `useState` initializer decides
 * whether to apply the `.mobile-drill-in` class on that mount.
 */
function SettingsInnerContent({
  children,
  isAgentConfigTab,
}: {
  children: ReactNode;
  isAgentConfigTab: boolean;
}) {
  const location = useLocation();
  const pathname = location.pathname;

  /* Suppress the inner drill on the very first commit: the outer
     `MobileDrillPageLayout` already animates the whole settings
     surface in, and double-animating (outer + inner) would stack the
     translateX(100%) → 0 keyframes and look like the inner is
     lagging behind. After the first commit flips the ref to true,
     subsequent path changes mount a fresh `SettingsInnerBody` and
     animate normally. */
  const hasMountedRef = useRef(false);
  useEffect(() => {
    hasMountedRef.current = true;
  }, []);

  const body = (
    <SettingsInnerBody key={pathname} hasMounted={hasMountedRef.current}>
      {children}
    </SettingsInnerBody>
  );

  return (
    <main {...stylex.props(styles.main)}>
      {isAgentConfigTab ? (
        <div {...stylex.props(styles.fillMinHeight)}>{body}</div>
      ) : (
        <ScrollArea className={stylex.props(styles.fill).className}>{body}</ScrollArea>
      )}
    </main>
  );
}

/**
 * One per pathname (key={pathname} on the parent). The useState
 * initializer runs once per instance — i.e. once per route change —
 * and decides whether the drill-in class should apply:
 *
 *   - `hasMounted === false` → initial render of the whole layout,
 *     outer drill is already animating; skip the inner one.
 *   - `hasMounted === true` and `consumeMobileBackNavigation()`
 *     returns true → this mount is the destination of a back-nav
 *     (the back chip / edge swipe set the flag), so skip the
 *     forward-direction slide-in.
 *   - Otherwise → forward navigation, run the drill.
 */
function SettingsInnerBody({ children, hasMounted }: { children: ReactNode; hasMounted: boolean }) {
  const [skipDrill] = useState(() => {
    if (!hasMounted) return true;
    return consumeMobileBackNavigation();
  });

  const bodyProps = stylex.props(styles.body);
  return (
    <div
      {...bodyProps}
      className={clsx(bodyProps.className, skipDrill ? undefined : 'mobile-drill-in')}
    >
      {children}
    </div>
  );
}

/* Header back chip — same shape and shadow as the home / project
   screens' FloatingPill / HeaderChip so the entire mobile surface
   family shares a single chip vocabulary. Pulls the animated back
   from `MobileDrillPageLayout`'s context so the chip and the edge
   swipe both run the clone-overlay slide-off. */
function SettingsHeaderBackButton({ fallback }: { fallback: () => void }) {
  const { t } = useTranslation();
  const animatedBack = useMobileDrillAnimatedBack();
  return (
    <button
      type="button"
      onClick={animatedBack ?? fallback}
      aria-label={t('common.back', 'Back')}
      {...stylex.props(styles.backButton)}
    >
      <ChevronLeft {...stylex.props(styles.backIcon)} aria-hidden="true" />
    </button>
  );
}
