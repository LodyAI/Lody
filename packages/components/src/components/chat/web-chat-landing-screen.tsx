import { useMemo, useState, type ReactNode, type Ref } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { DropZone } from '@/hooks/use-drop-zone';
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
import { themeColors } from '../../style/theme-colors.stylex';
import { themeSpace } from '../../style/theme-scale.stylex';
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
  /* The page the landing sits on. */
  screen: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  /* The chrome that opens the sidebar, in the window's top-left corner. */
  sidebarToggle: { position: 'absolute', top: themeSpace[3], zIndex: 20 },
  /* The shell card's 4px rim plus 5px top inset centers the h-7 toggle at
     23px, matching the macOS traffic lights. A 92px left inset leaves 20px
     after the light cluster, which ends at x=76. */
  sidebarToggleMac: { top: '5px', left: '92px' },
  sidebarTogglePlain: { left: themeSpace[3] },
  /* The Electron screen is not selectable; its text fields say so again. */
  selectNone: { userSelect: 'none' },
  /* The scope the greeting and the composer share. */
  scope: {
    position: 'relative',
    display: 'flex',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
  },
  /* The composer's column is a container, so the composer can size itself to it. */
  composerColumn: { containerType: 'inline-size' },
  hint: { paddingBottom: themeSpace[2] },
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
  const isElectron = isElectronRenderer();
  const isElectronFullscreen = useElectronFullscreen();
  // The stage and its group, for what in the group fits itself to the window (`landing-stage.ts`).
  const [stageElement, setStageElement] = useState<HTMLElement | null>(null);
  const [groupElement, setGroupElement] = useState<HTMLElement | null>(null);
  const landingStage = useMemo<LandingStage | null>(
    () => (stageElement && groupElement ? { stage: stageElement, group: groupElement } : null),
    [stageElement, groupElement]
  );

  // The text fields stay selectable inside the unselectable Electron screen:
  // StyleX has no descendant selector, so those three rules stay Tailwind and
  // ride the element beside the compiled style.
  const screenStyle = stylex.props(stage.screen, isElectron && stage.selectNone);
  const screenClassName = [
    screenStyle.className,
    isElectron
      ? '[&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text'
      : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const sidebarToggleProps = stylex.props(
    stage.sidebarToggle,
    isMacOSElectronRenderer() && !isElectronFullscreen
      ? stage.sidebarToggleMac
      : stage.sidebarTogglePlain
  );

  return (
    <div className={screenClassName} style={screenStyle.style} {...dropHandlers}>
      <WindowDragStrip />
      <ConversationDropOverlay active={dropActive} kind={dropKind} />
      {leftSidebarExpandSlot != null ? (
        <div
          {...sidebarToggleProps}
          className={[sidebarToggleProps.className, WINDOW_DRAG_EXEMPT_CLASS]
            .filter(Boolean)
            .join(' ')}
        >
          {leftSidebarExpandSlot}
        </div>
      ) : null}
      {/* Greeting + composer share one keyboard-nav scope (navRootRef); the
          absolutely-positioned sidebar-expand chrome above stays outside it. */}
      <FocusScope
        id={WORKSPACE_FOCUS_SCOPES.chatLanding}
        ref={navRootRef}
        {...stylex.props(stage.scope)}
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

        {/* Docked composer. Reuse the session composer's shell class verbatim so the
            landing inherits its exact bottom docking + iPad `--native-keyboard-height`
            lift and can never drift from the session composer. Hints sit above the
            composer so its bottom edge stays pinned to the shell when a hint toggles. */}
        <div className={getSessionChatInputAreaShellClassName()}>
          <ConversationColumn className={stylex.props(stage.composerColumn).className}>
            {noMachineHint != null ? (
              <div {...stylex.props(stage.hint)}>{noMachineHint}</div>
            ) : null}
            {agentConfigHint != null ? (
              <div {...stylex.props(stage.hint)}>{agentConfigHint}</div>
            ) : null}
            {composer}
          </ConversationColumn>
        </div>
      </FocusScope>
    </div>
  );
}
