import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import { useLocation } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/ui';
import { consumeMobileBackNavigation } from '@/lib/mobile-back-navigation';
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
        <header
          className={cn(
            'mobile-home-glass sticky top-0 z-30',
            /* Three-column grid centers the title between the back chip
               and an empty right slot — mirrors MobileProjectScreen's
               ProjectTopBar. */
            'grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center gap-2',
            'pt-safe-2 pb-2 ps-safe-3 pe-safe-3'
          )}
        >
          <SettingsHeaderBackButton fallback={onBack} />
          {isMachineDetail ? (
            <div ref={setDetailHeaderTarget} className="col-span-2 min-w-0" />
          ) : (
            <>
              <h1 className="truncate text-center text-[0.98rem] font-normal tracking-tight">
                {title}
              </h1>
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
    <main className="min-h-0 min-w-0 flex-1">
      {isAgentConfigTab ? (
        <div className="h-full min-h-0">{body}</div>
      ) : (
        <ScrollArea className="h-full">{body}</ScrollArea>
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

  return (
    <div
      className={cn(
        'relative flex h-full min-h-0 flex-col',
        /* Bottom safe-area padding so the last setting row clears the
           home-indicator (iOS) / navigation bar (Android) on native.
           Konsta's `pb-safe-*` resolves to `--k-safe-area-bottom + N`,
           giving us a small breathing buffer beyond the system inset.
           Pages with their own scroll regions (agent-config) opt out
           by overriding inside their own component. */
        'pb-safe-4',
        !skipDrill && 'mobile-drill-in'
      )}
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
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
        'bg-card text-foreground',
        'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)]',
        'transition-transform active:scale-[0.97]'
      )}
    >
      <ChevronLeft className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
