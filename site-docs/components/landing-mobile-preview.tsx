import * as stylex from '@stylexjs/stylex';
/**
 * LandingMobilePreview — the MOBILE-ACCESS feature-tab demo shell.
 *
 * Renders inside the real-device PNG (public/landing/iphone-17-pro-silver.png,
 * screen cutout measured from its alpha channel) at the same stage height as
 * desktop demos (760). The screen content is the display-only mobile replica
 * (`landing-replica/mobile*.tsx`): the all-conversations home with the tab-bar
 * new-chat button, and the new-chat sheet's content in a local slide-up so it
 * stays inside the phone. The session screen slides over as a push-nav layer
 * (`sessionNode`, built by landing-app-preview).
 */

import type { CSSProperties, ReactNode } from 'react';
import {
  ReplicaMobileNewChatSheetContent,
  type ReplicaMobileChat,
  type ReplicaMobileSheetBelowComposer,
} from './landing-replica/mobile';
import { ReplicaMobileHomeScreen } from './landing-replica/mobile-home';
import type { ReplicaLocale } from './landing-replica/types';
const landingMobilePreviewStyles = stylex.create({
  surface: {
    'margin-inline': 'auto',
    overflow: 'hidden',
    'background-color': 'transparent',
  },
  surface2: {
    position: 'relative',
    'background-color': 'transparent',
  },
  overlay: {
    position: 'absolute',
    isolation: 'isolate',
    overflow: 'hidden',
    'background-color': 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  stack: {
    display: 'flex',
    height: '100%',
    'flex-direction': 'column',
  },
  frame: {
    'min-height': '0px',
    flex: '1',
  },
  overlay2: {
    'pointer-events': 'none',
    position: 'absolute',
    inset: '0px',
    height: '100%',
    width: '100%',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  dim: {
    position: 'absolute',
    inset: '0px',
    'z-index': '30',
    'background-color': 'color-mix(in oklab, var(--color-black) 40%, transparent)',
    'transition-property': 'opacity',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': '300ms',
  },
  visible: {
    opacity: '100%',
  },
  hidden: {
    'pointer-events': 'none',
    opacity: '0%',
  },
  sheet: {
    position: 'absolute',
    'inset-inline': '0px',
    bottom: '0px',
    'z-index': '40',
    'border-top-left-radius': 'var(--radius-2xl)',
    'border-top-right-radius': 'var(--radius-2xl)',
    'border-top-style': 'solid',
    'border-top-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    'transition-property': 'transform, translate, scale, rotate',
    'transition-timing-function': 'var(--ease-out)',
    'transition-duration': '300ms',
  },
  sheetOpen: {
    translate: '0 0px',
  },
  sheetClosed: {
    translate: '0 100%',
  },
  session: {
    position: 'absolute',
    inset: '0px',
    'z-index': '40',
    display: 'flex',
    'flex-direction': 'column',
    'background-color': 'hsl(var(--background))',
    'transition-property': 'transform, translate, scale, rotate',
    'transition-timing-function': 'var(--ease-out)',
    'transition-duration': '300ms',
  },
  sessionOpen: {
    translate: '0px 0',
  },
  sessionClosed: {
    translate: '100% 0',
  },
});

export type MobileDemoScreen = 'home' | 'compose' | 'session';

// Screen cutout of the 1350×2760 device PNG, measured from its alpha channel
// (transparent interior): left 72, top 81, 1206×2610. The Dynamic Island is
// opaque in the PNG, so the UI gets an iOS-like safe-area top pad beneath it.
// Height matches the desktop demo stage (1120×760) so switching to this tab
// does not jump the reveal taller than worktree/diff/design.
const PHONE_IMG = '/landing/iphone-17-pro-silver.webp';
const PHONE_AR = 1350 / 2760;
const PHONE_H = 760;
const PHONE_W = Math.round(PHONE_H * PHONE_AR); // ≈ 372
const SCREEN = {
  left: (72 / 1350) * PHONE_W,
  top: (81 / 2760) * PHONE_H,
  width: (1206 / 1350) * PHONE_W,
  height: (2610 / 2760) * PHONE_H,
};
// Scale safe insets with the shorter design canvas (were tuned at 840px tall).
const SAFE_AREA_TOP = Math.round(42 * (PHONE_H / 840));
// Simulated home-indicator inset inside the device PNG (desktop has no env()).
const SAFE_AREA_BOTTOM = Math.round(34 * (PHONE_H / 840));

export function LandingMobilePreview({
  locale,
  narrowed = true,
  screen,
  chats,
  machineName,
  sheetComposer,
  sheetBelowComposer,
  sessionNode,
  workspaceName = 'Lody',
  workspaceAvatarUrl = '/landing/icon-transparent.png',
}: {
  locale: ReplicaLocale;
  /** Kept for call-site compatibility; the stage is always the design phone size. */
  narrowed?: boolean;
  screen: MobileDemoScreen;
  /** Home "all chats" rows, newest first. */
  chats: ReplicaMobileChat[];
  machineName: string;
  /** The new-chat sheet's composer (footer = `ReplicaMobileSheetFooterPickers`). */
  sheetComposer: ReactNode;
  /** Agent + permission chips rendered below the sheet composer. */
  sheetBelowComposer: ReplicaMobileSheetBelowComposer;
  sessionNode: ReactNode;
  workspaceName?: string;
  workspaceAvatarUrl?: string;
}) {
  return (
    // Phone design size matches the desktop stage height (760). Compact
    // viewports fit the stage into the reveal slot via container units
    // (see `.landing-phone-stage` in global.css / underwater.css).
    <div
      className={[
        stylex.props(landingMobilePreviewStyles.surface).className,
        'landing-phone-stage landing-phone-stage--narrowed',
      ]
        .filter(Boolean)
        .join(' ')}
      data-narrowed={narrowed ? 'true' : 'false'}
      style={
        {
          ['--lp-phone-w' as string]: `${PHONE_W}px`,
          ['--lp-phone-h' as string]: `${PHONE_H}px`,
          ['--lp-phone-ar' as string]: String(PHONE_AR),
        } as CSSProperties
      }
    >
      <div
        className={[
          stylex.props(landingMobilePreviewStyles.surface2).className,
          'landing-phone-stage__device',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ width: PHONE_W, height: PHONE_H }}
      >
        {/* Screen content sits UNDER the device PNG; the opaque bezel masks its
            edges/corners, exactly like a real screenshot inside the frame.
            `isolate` + translateZ(0) create a containing block so the home
            dock's `position: fixed` resolves to the screen — not the full-width
            scaled reveal frame (which left the FAB hanging outside the phone). */}
        <div
          {...stylex.props(landingMobilePreviewStyles.overlay)}
          data-landing-phone-frame
          style={{
            left: SCREEN.left,
            top: SCREEN.top,
            width: SCREEN.width,
            height: SCREEN.height,
            transform: 'translateZ(0)',
            // Island inset is applied as real padding below; home-indicator
            // inset flows into the dock via --k-safe-area-bottom.
            ['--landing-phone-safe-bottom' as string]: `${SAFE_AREA_BOTTOM}px`,
            ['--safe-area-bottom' as string]: `${SAFE_AREA_BOTTOM}px`,
            ['--safe-area-top' as string]: '0px',
            ['--k-safe-area-bottom' as string]: `${SAFE_AREA_BOTTOM}px`,
            ['--k-safe-area-top' as string]: '0px',
            ['--k-safe-area-left' as string]: '0px',
            ['--k-safe-area-right' as string]: '0px',
          }}
        >
          {/* Home: the all-conversations Chat tab. Stays mounted under the
              other screens like the real always-mounted mobile home. */}
          <div
            data-power-demo-layout="fill"
            {...stylex.props(landingMobilePreviewStyles.stack)}
            style={{ paddingTop: SAFE_AREA_TOP }}
          >
            <ReplicaMobileHomeScreen
              locale={locale}
              chats={chats}
              workspaceName={workspaceName}
              workspaceAvatarUrl={workspaceAvatarUrl}
            />
          </div>

          {/* Dim behind the new-chat sheet. */}
          <div
            aria-hidden="true"
            {...stylex.props(
              landingMobilePreviewStyles.dim,
              screen === 'compose'
                ? landingMobilePreviewStyles.visible
                : landingMobilePreviewStyles.hidden
            )}
          />

          {/* New-chat bottom sheet in a local slide-up (the app's Vaul drawer
              portals to <body>, which would escape the phone). */}
          <div
            {...stylex.props(
              landingMobilePreviewStyles.sheet,
              screen === 'compose'
                ? landingMobilePreviewStyles.sheetOpen
                : landingMobilePreviewStyles.sheetClosed
            )}
          >
            <ReplicaMobileNewChatSheetContent
              locale={locale}
              machineName={machineName}
              composer={sheetComposer}
              belowComposer={sheetBelowComposer}
            />
          </div>

          {/* Session: slides over the home like the real push navigation. */}
          <div
            {...stylex.props(
              landingMobilePreviewStyles.session,
              screen === 'session'
                ? landingMobilePreviewStyles.sessionOpen
                : landingMobilePreviewStyles.sessionClosed
            )}
            style={{ paddingTop: SAFE_AREA_TOP }}
          >
            <div {...stylex.props(landingMobilePreviewStyles.frame)}>{sessionNode}</div>
          </div>
        </div>

        <img
          src={PHONE_IMG}
          alt=""
          aria-hidden="true"
          draggable={false}
          {...stylex.props(landingMobilePreviewStyles.overlay2)}
        />
      </div>
    </div>
  );
}
