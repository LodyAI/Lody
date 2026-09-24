'use client';

/**
 * LandingMobilePreview — the MOBILE-ACCESS feature-tab demo shell.
 *
 * Renders inside the real-device PNG (public/landing/iphone-17-pro-silver.png,
 * screen cutout measured from its alpha channel) at the same stage height as
 * desktop demos (760). The screen content is REAL packages/components mobile UI:
 * `MobileHomeScreen` (all-conversations Chat tab + tab-bar new-chat button) and
 * `MobileNewChatSheetContent` (the new-chat bottom sheet's content, hosted in a
 * local slide-up so it stays inside the phone instead of Vaul's body portal).
 * The session screen slides over as a push-nav layer (`sessionNode`, provided
 * by landing-app-preview: the ai-gui conversation streaming the jellyfish
 * image).
 */

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { ArrowUp, MessageCircle, Monitor } from 'lucide-react';
import { ChatComposer } from '@/components/chat/chat-composer';
import {
  MobileHomeScreen,
  type MobileConversationItem,
  type MobileHomeGitHubRepository,
  type MobileHomeLocalProject,
  type MobileHomeMachine,
  type MobileHomeScreenLabels,
} from '@/components/mobile/mobile-home-screen';
import {
  MobileInlinePicker,
  MobileInlinePickerCoordinator,
} from '@/components/mobile/mobile-inline-picker';
import { MobileNewChatSheetContent } from '@/components/mobile/mobile-new-chat-sheet';
import { ForceMobileLayoutProvider } from '@/hooks/use-mobile';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
import type { LandingLocale } from './landing';

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

const SHEET_LABELS: Record<LandingLocale, Record<string, string>> = {
  en: { title: 'New chat', machineLabel: 'Machine', contextTypeLabel: 'Type' },
  zh: { title: '新对话', machineLabel: '机器', contextTypeLabel: '类型' },
};

export function LandingMobilePreview({
  locale,
  narrowed,
  screen,
  promptValue,
  promptPlaceholder,
  machineName,
  chats,
  machines,
  localProjects,
  githubRepositories,
  labels,
  chatFilterPills,
  sheetFooterSelector,
  sheetBelowComposerNode,
  sessionNode,
}: {
  locale: LandingLocale;
  /** Width-morph state: false = full desktop width, true = iPhone width. */
  narrowed: boolean;
  screen: MobileDemoScreen;
  promptValue: string;
  promptPlaceholder: string;
  machineName: string;
  chats: MobileConversationItem[];
  machines: MobileHomeMachine[];
  localProjects: MobileHomeLocalProject[];
  githubRepositories: MobileHomeGitHubRepository[];
  labels: MobileHomeScreenLabels;
  chatFilterPills?: ReadonlyArray<Record<string, unknown>>;
  /** Sheet composer footer: the model + thinking pickers. */
  sheetFooterSelector?: ReactNode;
  /** Sheet cluster below the composer: agent + permission. */
  sheetBelowComposerNode?: ReactNode;
  sessionNode: ReactNode;
}) {
  const isZh = locale === 'zh';

  const composer = useMemo(
    () => (
      <ChatComposer
        tone="dark"
        variant="session"
        promptId="landing-mobile-new-chat"
        promptValue={promptValue}
        onPromptChange={() => undefined}
        promptPlaceholder={promptPlaceholder}
        // Sheet starts single-line on mobile (ChatComposer forces rows=1 via
        // useIsMobile under ForceMobileLayoutProvider).
        promptRows={1}
        footerSelector={sheetFooterSelector}
        primaryAction={
          /* Sheet-sized send chip (h-8), matching the larger image-add button
             beside it — see chat-landing.tsx's sheet `primaryAction`. */
          <Button
            type="button"
            variant="ghost"
            icon
            className={cn(
              'border-primary/[0.25] bg-primary/[0.15] hover:bg-primary/[0.25] active:translate-y-[1px]'
            )}
            disabled={promptValue.trim().length === 0}
            aria-label="Send"
          >
            <ArrowUp className="h-5 w-5" />
          </Button>
        }
        onImageAddClick={() => undefined}
        autoResize
        maxRows={6}
        focusOnContainerClick
      />
    ),
    [promptPlaceholder, promptValue, sheetFooterSelector]
  );

  return (
    // Force mobile layout hooks (composer rows, message chrome, no ⌘L) even
    // though the outer browser viewport is still desktop-wide.
    <ForceMobileLayoutProvider force>
      {/* Phone design size matches the desktop stage height (760). Compact
        viewports fit the stage into the reveal slot via container units
        (see `.landing-phone-stage` in global.css / underwater.css). */}
      <div
        className="landing-phone-stage landing-phone-stage--narrowed mx-auto overflow-hidden bg-transparent"
        // `narrowed` is kept for call-site compatibility; the stage is always the
        // design phone size so enter/exit never paints a full-width dark plate.
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
          className="landing-phone-stage__device relative bg-transparent"
          style={{ width: PHONE_W, height: PHONE_H }}
        >
          {/* Screen content sits UNDER the device PNG; the opaque bezel masks its
            edges/corners, exactly like a real screenshot inside the frame.
            `isolate` + translateZ(0) create a containing block so the home
            dock's `position: fixed` resolves to the screen — not the full-width
            scaled reveal frame (which left the FAB hanging outside the phone). */}
          <div
            className="absolute isolate overflow-hidden bg-background text-foreground"
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
            <div className="flex h-full flex-col" style={{ paddingTop: SAFE_AREA_TOP }}>
              <MobileHomeScreen
                theme="ios"
                workspace={{
                  id: 'workspace-lody',
                  name: 'Lody',
                  avatarUrl: '/landing/icon-transparent.png',
                }}
                machines={machines}
                connectionUiState="online"
                selectedTab="chat"
                localProjects={localProjects}
                githubRepositories={githubRepositories}
                chats={chats}
                chatFilterPills={chatFilterPills}
                chatGroupBy="none"
                labels={labels}
                onTabSelect={() => undefined}
                onChatSelect={() => undefined}
                onNewChat={() => undefined}
              />
            </div>

            {/* Dim behind the new-chat sheet. */}
            <div
              aria-hidden="true"
              className={cn(
                'absolute inset-0 z-30 bg-black/40 transition-opacity duration-300',
                screen === 'compose' ? 'opacity-100' : 'pointer-events-none opacity-0'
              )}
            />

            {/* New-chat bottom sheet: the REAL sheet content in a local slide-up
              (Vaul's Drawer portals to <body>, which would escape the phone). */}
            <div
              className={cn(
                'absolute inset-x-0 bottom-0 z-40 rounded-t-2xl border-t border-border bg-background shadow-2xl transition-transform duration-300 ease-out',
                screen === 'compose' ? 'translate-y-0' : 'translate-y-full'
              )}
            >
              <MobileNewChatSheetContent
                labels={SHEET_LABELS[locale]}
                coordinator={MobileInlinePickerCoordinator}
                machineNode={
                  <MobileInlinePicker
                    id="landing-mobile-machine"
                    value="mac-studio"
                    onChange={() => undefined}
                    options={[{ value: 'mac-studio', label: machineName }]}
                    ariaLabel={isZh ? '机器' : 'Machine'}
                    triggerContent={
                      <span className="flex items-center gap-1.5">
                        <Monitor className="h-3.5 w-3.5" />
                        {machineName}
                      </span>
                    }
                  />
                }
                contextTypeNode={
                  <MobileInlinePicker
                    id="landing-mobile-context"
                    value="chat"
                    onChange={() => undefined}
                    options={[{ value: 'chat', label: isZh ? '对话' : 'Chat' }]}
                    ariaLabel={isZh ? '类型' : 'Type'}
                    triggerContent={
                      <span className="flex items-center gap-1.5">
                        <MessageCircle className="h-3.5 w-3.5" />
                        {isZh ? '对话' : 'Chat'}
                      </span>
                    }
                  />
                }
                perTypeNode={null}
                branchNode={null}
                secondaryPerTypeNode={null}
                composer={composer}
                belowComposerNode={sheetBelowComposerNode}
                showCloseButton={false}
              />
            </div>

            {/* Session: slides over the home like the real push navigation. */}
            <div
              className={cn(
                'absolute inset-0 z-40 flex flex-col bg-background transition-transform duration-300 ease-out',
                screen === 'session' ? 'translate-x-0' : 'translate-x-full'
              )}
              style={{ paddingTop: SAFE_AREA_TOP }}
            >
              <div className="min-h-0 flex-1">{sessionNode}</div>
            </div>
          </div>

          <img
            src={PHONE_IMG}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full select-none"
          />
        </div>
      </div>
    </ForceMobileLayoutProvider>
  );
}
