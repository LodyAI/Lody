import { useMemo, useState, type ReactNode, type Ref } from 'react';
import { useAtomValue } from 'jotai';
import { wallpaperAtom } from '@/atoms/wallpaper';
import { WallpaperBackdrop } from '../wallpaper-backdrop';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { DropZone } from '@/hooks/use-drop-zone';
import { cn } from '@/lib/utils';
import { isElectronRenderer, isMacOSElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { getSessionChatInputAreaShellClassName } from '@/components/sessions/session-chat-input-area';
import { ConversationColumn } from '@/components/shared/conversation-column';
import {
  ConversationDropOverlay,
  type ConversationDropKind,
} from '@/components/shared/conversation-drop-overlay';
import { focusFirstChatLandingOption } from '@/hooks/use-chat-landing-keyboard-nav';
import { FocusScope } from '@/ui/focus-scope';
import { WINDOW_DRAG_EXEMPT_CLASS, WindowDragStrip } from '@/ui/window-drag-region';

import { WORKSPACE_FOCUS_SCOPES } from '@/atoms';
import { LandingStageContext, type LandingStage } from './landing-stage';

/*
 * The stage above the docked composer: the heading, the ambient boards and the context switch
 * sit centred in THIS band, not on the whole page, so the group reads a touch above the page's
 * middle (the docked composer keeps its own height at the bottom). Both spacers shrink to
 * nothing before the content does, and the stage scrolls when the iPad soft keyboard shrinks
 * the area (the composer band lifts itself).
 */
const stage = stylex.create({
  root: {
    display: 'flex',
    flex: '1 1 0%',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'auto',
    paddingInline: space[4],
  },
  above: { flex: '1 1 0%', minHeight: 0 },
  below: { flex: '1 1 0%', minHeight: 0 },
  group: {
    display: 'flex',
    flexShrink: 0,
    flexDirection: 'column',
    alignItems: 'center',
    gap: '20px',
  },
  /* A plain heading in the interface font; named so it glides when the boards below change
     height (`tailwind/index.css`). */
  heading: {
    margin: 0,
    fontSize: 'calc(var(--ui-font-size, 14px) * 36 / 14)',
    lineHeight: 'calc(var(--ui-font-size, 14px) * 40 / 14)',
    fontWeight: 600,
    letterSpacing: '-0.025em',
    color: colors.label,
  },
});

export type WebChatLandingScreenProps = {
  title: string;
  /** What sits under the greeting, in the composer's column (the last seven days). */
  ambient?: ReactNode;
  contextSwitch?: ReactNode;
  composer: ReactNode;
  noMachineHint?: ReactNode;
  agentConfigHint?: ReactNode;
  leftSidebarExpandSlot?: ReactNode;
  /** Page-level drop target (a sidebar session dragged onto the new chat). */
  dropActive?: boolean;
  dropKind?: ConversationDropKind;
  dropHandlers?: DropZone['handlers'];
  /** Scope root for keyboard navigation — wraps the title, context switch and composer
   *  so arrow/Esc nav covers the config controls but not the surrounding page chrome. */
  navRootRef?: Ref<HTMLDivElement>;
};

export function WebChatLandingScreen({
  title,
  ambient,
  contextSwitch,
  composer,
  noMachineHint,
  agentConfigHint,
  leftSidebarExpandSlot,
  navRootRef,
  dropActive = false,
  dropKind = 'session-mention',
  dropHandlers,
}: WebChatLandingScreenProps) {
  const wallpaper = useAtomValue(wallpaperAtom);
  const isElectron = isElectronRenderer();
  const isElectronFullscreen = useElectronFullscreen();
  // The stage and its group, for what in the group fits itself to the window (`landing-stage.ts`).
  const [stageElement, setStageElement] = useState<HTMLElement | null>(null);
  const [groupElement, setGroupElement] = useState<HTMLElement | null>(null);
  const landingStage = useMemo<LandingStage | null>(
    () => (stageElement && groupElement ? { stage: stageElement, group: groupElement } : null),
    [stageElement, groupElement]
  );

  return (
    <div
      className={cn(
        'relative flex h-full w-full flex-1 flex-col overflow-hidden',
        'bg-background text-foreground',
        isElectron &&
          'select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text'
      )}
      {...dropHandlers}
    >
      <WallpaperBackdrop settings={wallpaper} />
      <WindowDragStrip />
      <ConversationDropOverlay active={dropActive} kind={dropKind} />
      {leftSidebarExpandSlot != null ? (
        <div
          className={cn(
            'absolute top-3 z-20',
            WINDOW_DRAG_EXEMPT_CLASS,
            // macOS Electron: `top-[5px]` plus the shell card's 4px rim centers the
            // h-7 button at 23px, on the traffic-light centerline
            // (`trafficLightPosition.y` 16 + 7px radius in apps/electron/src/main/window.ts).
            // `left-[92px]` plus the card's 4px rim leaves a 20px buffer after the
            // light cluster (which ends at x=76).
            isMacOSElectronRenderer() && !isElectronFullscreen ? 'top-[5px] left-[92px]' : 'left-3'
          )}
        >
          {leftSidebarExpandSlot}
        </div>
      ) : null}
      {/* Greeting + composer share one keyboard-nav scope (navRootRef); the
          absolutely-positioned sidebar-expand chrome above stays outside it. */}
      <FocusScope
        id={WORKSPACE_FOCUS_SCOPES.chatLanding}
        ref={navRootRef}
        className="relative flex min-h-0 flex-1 flex-col"
        onFocus={(event) => {
          if (event.target === event.currentTarget) {
            focusFirstChatLandingOption(event.currentTarget);
          }
        }}
      >
        <div ref={setStageElement} {...stylex.props(stage.root)}>
          <div aria-hidden="true" {...stylex.props(stage.above)} />
          <div ref={setGroupElement} {...stylex.props(stage.group)}>
            <h1 {...stylex.props(stage.heading)} style={{ viewTransitionName: 'home-heading' }}>
              {title}
            </h1>
            {/* The same column as the composer, so the card and the input share edges. */}
            {ambient != null ? (
              <LandingStageContext.Provider value={landingStage}>
                <ConversationColumn>{ambient}</ConversationColumn>
              </LandingStageContext.Provider>
            ) : null}
            {contextSwitch}
          </div>
          <div aria-hidden="true" {...stylex.props(stage.below)} />
        </div>

        {/* Docked composer. Reuse the session composer's shell geometry so the
            landing inherits its exact bottom docking + iPad `--native-keyboard-height`
            lift and can never drift from the session composer. Hints sit above the
            composer so its bottom edge stays pinned to the shell when a hint toggles. */}
        <div
          className={getSessionChatInputAreaShellClassName({
            transparentBackground: Boolean(wallpaper.image),
          })}
        >
          <ConversationColumn className="@container">
            {noMachineHint != null ? <div className="pb-2">{noMachineHint}</div> : null}
            {agentConfigHint != null ? <div className="pb-2">{agentConfigHint}</div> : null}
            {composer}
          </ConversationColumn>
        </div>
      </FocusScope>
    </div>
  );
}
