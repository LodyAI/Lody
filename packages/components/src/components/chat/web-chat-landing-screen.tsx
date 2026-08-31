import type { ReactNode, Ref } from 'react';
import type { DropZone } from '@/hooks/use-drop-zone';
import { cn } from '@/lib/utils';
import {
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE,
} from '@/lib/chat-workspace-geometry';
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

export type WebChatLandingScreenProps = {
  title: string;
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
  const isElectron = isElectronRenderer();
  const isElectronFullscreen = useElectronFullscreen();

  return (
    <div
      data-geometry-anchor={CHAT_WORKSPACE_GEOMETRY_ANCHORS.chatLanding}
      {...{ [CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE]: 'main.chat-landing' }}
      className={cn(
        'relative flex h-full w-full flex-1 flex-col overflow-hidden',
        'bg-background text-foreground',
        isElectron &&
          'select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text'
      )}
      {...dropHandlers}
    >
      <WindowDragStrip />
      <ConversationDropOverlay active={dropActive} kind={dropKind} />
      {leftSidebarExpandSlot != null ? (
        <div
          className={cn(
            'absolute top-3 z-20',
            WINDOW_DRAG_EXEMPT_CLASS,
            // macOS Electron: `top-[9px]` centers the h-7 button at 23px, on the
            // traffic-light centerline (`trafficLightPosition.y` 16 + 7px radius
            // in apps/electron/src/main/window.ts); `left-[96px]` leaves a 24px
            // buffer after the light cluster (which ends at x=72).
            isMacOSElectronRenderer() && !isElectronFullscreen ? 'top-[9px] left-[96px]' : 'left-3'
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
        {/* Greeting fills the space above the docked composer and stays vertically
            centered. overflow-auto lets it yield when the iPad soft keyboard shrinks the
            area (the composer band lifts itself — see the note below). */}
        <div
          data-geometry-anchor={CHAT_WORKSPACE_GEOMETRY_ANCHORS.greetingRegion}
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-auto px-4"
        >
          <h1 className="text-4xl font-semibold tracking-tight text-foreground">{title}</h1>
          {contextSwitch}
        </div>

        {/* Docked composer. Reuse the session composer's shell class verbatim so the
            landing inherits its exact bottom docking + iPad `--native-keyboard-height`
            lift and can never drift from the session composer. Hints sit above the
            composer so its bottom edge stays pinned to the shell when a hint toggles. */}
        <div
          data-geometry-anchor={CHAT_WORKSPACE_GEOMETRY_ANCHORS.composerBand}
          className={getSessionChatInputAreaShellClassName()}
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
