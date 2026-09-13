import { useEffect, useMemo, useRef, useState } from 'react';
import { Provider } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { AgentBrandId, AgentConfigCliType, SessionId, SessionMeta } from '@lody/shared';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import { LoroSidebar } from '@/components/loro-sidebar';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import { PermissionRequestCard } from '@/components/sessions/floating-permission-request';
import {
  SessionConversationPage,
  SessionConversationPageBody,
} from '@/components/sessions/session-conversation-page';
import { SessionChangesSidebar } from '@/components/sessions/session-changes-sidebar';
import { SessionChatInputArea } from '@/components/sessions/session-chat-input-area';
import type { SessionChatInputAreaHandle } from '@/components/sessions/session-chat-input-area';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import {
  SessionSidePanelTabBar,
  type SessionSidePanelOption,
  type SessionSidePanelTabItem,
} from '@/components/sessions/session-side-panel-tab-bar';
import { SessionTabBar } from '@/components/sessions/session-tab-bar';
import { PrTabView } from '@/components/sessions/pr-tab-view';
import { TerminalDock } from '@/components/terminal/terminal-dock';
import { buildAcpSelectorOptions } from '@/components/shared/acp-selector-options';
import { StableSessionContext } from '@/hooks/useStableSession';
import { cn } from '@/lib/utils';
import {
  DEFAULT_TOUR_IDENTITY,
  TOUR_ANNOTATION_ANCHOR,
  TOUR_CHANGES,
  TOUR_PR_CHECKS,
  TOUR_PR_DETAILS,
  TOUR_PR_MERGED,
  TOUR_PR_NUMBER,
  TOUR_PR_REPO,
  TOUR_PULL_REQUEST,
  TOUR_SESSION_ID,
  TOUR_TASKS,
  buildTourHistory,
  buildTourSession,
  buildTourStableSession,
  createTourStore,
  createTourTerminalChannel,
  type TourIdentity,
} from './tour-fixtures';
import { TourBrowserPreview } from './tour-browser-preview';
import { TourCloudBoundary } from './tour-cloud-boundary';

// The app the tour is a tour OF.
//
// Not a drawing of it, not a "preview", not a fixed-size still life scaled into
// a card. This is `LoroSidebar` beside `DesktopSessionDetailLayout`, holding
// `SessionTabBar`, `SessionChatStreamView`, `PermissionRequestCard`,
// `SessionInfoBar`, `SessionChatInputArea`, `SessionSidePanelTabBar`,
// `SessionChangesSidebar` and `TerminalDock` — every one of them the component
// production mounts, in the position production mounts it.
//
// THREE THINGS THE OLD PREVIEW GOT WRONG, all of them the same mistake — it
// hand-composed a plausible screen instead of using the real one, so it slowly
// stopped matching the product:
//
//   changes  It drew a fixed 280px right rail. The real thing is a RESIZABLE
//            panel that opens when a viewer is opened, with a tab bar carrying
//            Files / All Changes / PR / Browser and the file tabs beside them.
//   the PR   It pinned a `PullRequestBadge` above the composer. The product
//            deleted that badge; branch, ±diff, PR, CI and merge all live in
//            `SessionInfoBar`'s context stage.
//   the run  Its composer footer was the dead text "Claude Code · This machine".
//            The real footer is two working controls — `DesktopRunConfigMenu`
//            and the permission-mode button — and the machine name moved to the
//            header menu entirely.
//
// Every one of those was invisible from inside the tour and obvious the moment
// a user reached the product. Mounting the real components is the only fix that
// stays fixed.

/** The panels this session has, in production's order. */
const TOUR_SIDE_PANEL_OPTIONS: SessionSidePanelOption[] = [
  { id: 'files', label: 'Files', kind: 'files' },
  { id: 'changes', label: 'All Changes', kind: 'changes' },
  { id: 'browser', label: 'Browser', kind: 'browser' },
  { id: 'pr', label: 'Pull Request', kind: 'pr' },
];

export type TourAppTracks = {
  reveal: number;
  tasks: number;
  archived: number;
  childTabs: number;
  subagents: number;
  /** 0 closed → 1 open. Drives the REAL resizable side panel. */
  panel: number;
  changes: number;
  terminal: number;
  annotation: number;
  pr: number;
  /** 0 → empty composer, 1 → the whole prompt typed. */
  typing: number;
};

export type TourConfigurationState = {
  step:
    | 'login'
    | 'workspace'
    | 'providers'
    | 'projects'
    | 'firstTask'
    | 'summary'
    | 'appearance'
    | 'invite';
  workspaceStatus: 'missing' | 'draft' | 'ready';
  agentStatus: 'missing' | 'preparing' | 'awaiting-auth' | 'verifying' | 'failed' | 'ready';
  projectStatus: 'missing' | 'importing' | 'ready';
  promptValue: string;
  conversationStatus: 'empty' | 'draft' | 'starting' | 'running';
  /** Agent faces available during provider configuration. The real composer
   * cycles these in its run-config trigger while keeping the menu functional. */
  runConfigAgents?: Array<{
    cliType: AgentConfigCliType;
    agentType: string;
    brandId?: AgentBrandId;
    env?: Record<string, string>;
  }>;
};

export type TourAppProps = {
  identity?: TourIdentity;
  tracks: TourAppTracks;
  /** Real product state projected from the active onboarding form. */
  configurationState?: TourConfigurationState;
  /** null while the permission is up. Set by a real press on the real card. */
  permissionAnswer: string | null;
  onPermissionAnswer: (optionId: string) => void;
  /** Which side-panel tab the film has selected, by real click. */
  activeSidePanelTab: string;
  onSidePanelTabSelect: (tabId: string) => void;
  /** Which sidebar row is selected. Changing it changes the conversation. */
  selectedTaskId: string;
  /** Which of the session's own tabs is active. */
  activeTabIndex: number;
  onSelectTabIndex: (index: number) => void;
  /** Pressed on the real merge control in the PR tab. */
  onMergePr?: () => void;
  className?: string;
};

const TOUR_PROMPT = 'Have a look at the auth module and clean it up.';
/** What the film types into the composer to start the second task. */
const TOUR_SECOND_PROMPT = 'Add tests for the token expiry path.';

/** The comment the film leaves on the preview, as one value so staging and
 *  un-staging it on a rewind cannot drift apart. */
const TOUR_ANNOTATION_REFERENCE = {
  source: 'visual_annotation',
  commentId: 'onboarding-tour-comment',
  body: 'This empty state should say what to do next.',
  status: 'completed',
  anchor: TOUR_ANNOTATION_ANCHOR,
} as const;

export function TourApp({
  identity = DEFAULT_TOUR_IDENTITY,
  tracks,
  configurationState,
  permissionAnswer,
  onPermissionAnswer,
  activeSidePanelTab,
  onSidePanelTabSelect,
  selectedTaskId,
  activeTabIndex,
  onSelectTabIndex,
  onMergePr,
  className,
}: TourAppProps): React.JSX.Element {
  const store = useMemo(() => createTourStore(identity), [identity]);
  const stableSession = useMemo(() => buildTourStableSession(identity), [identity]);
  const session = useMemo(() => buildTourSession(identity), [identity]);

  return (
    <TourCloudBoundary identity={identity}>
      <Provider store={store}>
        <StableSessionContext.Provider value={stableSession as never}>
          <TourWindow
            identity={identity}
            session={session}
            tracks={tracks}
            configurationState={configurationState}
            permissionAnswer={permissionAnswer}
            onPermissionAnswer={onPermissionAnswer}
            activeSidePanelTab={activeSidePanelTab}
            onSidePanelTabSelect={onSidePanelTabSelect}
            selectedTaskId={selectedTaskId}
            activeTabIndex={activeTabIndex}
            onSelectTabIndex={onSelectTabIndex}
            onMergePr={onMergePr}
            className={className}
          />
        </StableSessionContext.Provider>
      </Provider>
    </TourCloudBoundary>
  );
}

function TourWindow({
  identity,
  session,
  tracks,
  configurationState,
  permissionAnswer,
  onPermissionAnswer,
  activeSidePanelTab,
  onSidePanelTabSelect,
  selectedTaskId,
  activeTabIndex,
  onSelectTabIndex,
  onMergePr,
  className,
}: {
  identity: TourIdentity;
  session: SessionMeta;
  tracks: TourAppTracks;
  configurationState?: TourConfigurationState;
  permissionAnswer: string | null;
  onPermissionAnswer: (optionId: string) => void;
  activeSidePanelTab: string;
  onSidePanelTabSelect: (tabId: string) => void;
  selectedTaskId: string;
  activeTabIndex: number;
  onSelectTabIndex: (index: number) => void;
  onMergePr?: () => void;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const composerRef = useRef<SessionChatInputAreaHandle>(null);
  const terminalChannel = useMemo(() => createTourTerminalChannel(), []);
  useEffect(() => () => terminalChannel.dispose(), [terminalChannel]);
  // 3 is merged. The scripted cursor presses the real merge control a beat
  // before the track gets here, so the press leads its own result.
  const merged = tracks.pr >= 3;

  const visibleTasks = useMemo(() => {
    const archived = Math.floor(tracks.archived);
    const visible = Math.max(archived, Math.min(TOUR_TASKS.length, Math.floor(tracks.tasks)));
    return TOUR_TASKS.slice(archived, visible).map((task, index) => ({
      ...task,
      // Rows keep whatever project they belong to; only the ones with no repo of
      // their own fall back to the connected project. Overwriting every row with
      // one name is what made the sidebar look single-project.
      repoFullName: task.repoFullName ?? identity.projectName,
      // Once the pull request is out the leading row is not busy any more, and
      // the row is where the product would say so.
      isWorking: index === 0 && tracks.pr >= 1 ? false : task.isWorking,
      ...(index === 0 && tracks.pr >= 1
        ? {
            prUrl: TOUR_PULL_REQUEST.url,
            prNumber: 128,
            prStatus: (merged ? 'merged' : 'open') as 'merged' | 'open',
          }
        : {}),
    }));
  }, [identity.projectName, merged, tracks.archived, tracks.pr, tracks.tasks]);

  /**
   * The project groups the sidebar renders.
   *
   * Derived from the visible rows, so the second project APPEARS with the tasks
   * that belong to it rather than sitting there empty from the first frame.
   */
  const repoSections = useMemo(() => {
    const names = new Set<string>([identity.projectName]);
    for (const task of visibleTasks) if (task.repoFullName) names.add(task.repoFullName);
    return [...names].map((repoFullName) => ({
      id: repoFullName,
      repoFullName,
      items: visibleTasks
        .filter((task) => task.repoFullName === repoFullName)
        .map((task) => ({
          id: task.taskId,
          title: task.title,
          isSelected: task.taskId === selectedTaskId,
        })),
    }));
  }, [identity.projectName, selectedTaskId, visibleTasks]);

  const history = useMemo(
    () =>
      buildTourHistory({
        prompt: TOUR_PROMPT,
        revealed: tracks.reveal,
        permissionAnswer,
        subagents: tracks.subagents >= 0.5,
        taskId: selectedTaskId,
      }),
    [permissionAnswer, selectedTaskId, tracks.reveal, tracks.subagents]
  );

  const items = useMemo(
    () =>
      history.map(
        (message, turnIndex) =>
          ({ type: 'message', sessionId: TOUR_SESSION_ID, message, turnIndex }) as const
      ),
    [history]
  );

  /**
   * The permission is up exactly when the run has reached it and nobody has
   * answered. It is NOT a separate flag: deriving it from the same history the
   * stream renders means the card cannot be showing while the conversation
   * says it was already answered.
   */
  const permissionPending = permissionAnswer === null && Math.floor(tracks.reveal) >= 5;

  // The visual-annotation chip is staged through the composer's OWN handle —
  // the same call the Browser panel makes when you comment on a running page.
  // Nothing here draws a chip; the composer produces its own.
  /**
   * The composer types itself.
   *
   * `SessionChatInputAreaHandle.setInputText` is the product's own handle, so
   * this is genuinely text arriving in the real composer — which is what the
   * "asking for something makes a task" beat needed and did not have. Before,
   * that beat pointed the camera at the sidebar and a row simply appeared, with
   * nothing on screen to say where it came from.
   */
  const typedRef = useRef<string>('');
  useEffect(() => {
    const target = configurationState?.promptValue ?? (tracks.typing > 0 ? TOUR_SECOND_PROMPT : '');
    const shown = configurationState
      ? target
      : target.slice(0, Math.round(target.length * Math.min(1, tracks.typing)));
    if (shown === typedRef.current) return;
    typedRef.current = shown;
    composerRef.current?.setInputText(shown);
  }, [configurationState, tracks.typing]);

  const stagedAnnotation = useRef(false);
  useEffect(() => {
    // Rewound past the comment: take the chip back out, so scrubbing to the
    // start shows the composer as it was rather than carrying a reference to
    // something that has not been said yet.
    if (tracks.annotation <= 0.05 && stagedAnnotation.current) {
      stagedAnnotation.current = false;
      composerRef.current?.toggleVisualAnnotationReference(TOUR_ANNOTATION_REFERENCE);
      return undefined;
    }
    if (tracks.annotation < 0.6 || stagedAnnotation.current) return undefined;
    stagedAnnotation.current = true;
    // Deferred a task. The composer's handle commits synchronously, and calling
    // it from inside this effect lands a `flushSync` in React's commit phase —
    // the chip still appears, but React warns and the write is not batched with
    // anything else happening on that frame.
    const staged = window.setTimeout(() => {
      composerRef.current?.addVisualAnnotationReference(TOUR_ANNOTATION_REFERENCE);
    }, 0);
    return () => window.clearTimeout(staged);
  }, [tracks.annotation]);

  const childSessions = useMemo(() => {
    const count = Math.floor(tracks.childTabs);
    return [
      { title: 'Check the migration path', id: `${session.id}-child-1` },
      { title: 'Write the changelog entry', id: `${session.id}-child-2` },
    ]
      .slice(0, count)
      .map(
        (child) =>
          ({
            ...session,
            id: child.id as SessionId,
            title: child.title,
            parentSessionId: session.id,
            status: { type: 'idle' as const },
          }) as SessionMeta
      );
  }, [session, tracks.childTabs]);

  const revealedChanges = useMemo(
    () => TOUR_CHANGES.slice(0, Math.floor(tracks.changes)),
    [tracks.changes]
  );

  const sidePanelTabs: SessionSidePanelTabItem[] = useMemo(() => {
    const tabs: SessionSidePanelTabItem[] = [
      { id: 'files', label: 'Files', kind: 'files' },
      { id: 'changes', label: 'All Changes', kind: 'changes' },
    ];
    // The running-app tab is always OPEN in the film — the script presses it —
    // even though production only offers it once a browser session exists. Its
    // kind is the product's `'browser'`, and the tour anchor follows the kind,
    // so renaming one without the other silently unaims the camera.
    tabs.push({ id: 'browser', label: 'Browser', kind: 'browser' });
    if (tracks.pr >= 1) tabs.push({ id: 'pr', label: 'Pull Request', kind: 'pr' });
    if (tracks.changes >= 3) {
      tabs.push({
        id: 'diff:src/auth/token.ts',
        label: 'token.ts',
        kind: 'diff',
        filePath: 'src/auth/token.ts',
        closeable: true,
      });
    }
    return tabs;
  }, [tracks.changes, tracks.pr]);

  // What the tab bar's "+" menu offers: every panel the session has that is
  // not already open. In the film the script opens them all, so this is
  // usually empty — but it is a REQUIRED prop of a production control, and
  // leaving it off is what crashed the overlay on boot after the side panels
  // became opt-in upstream.
  const availableSidePanels: SessionSidePanelOption[] = useMemo(() => {
    const open = new Set(sidePanelTabs.map((tab) => tab.id));
    return TOUR_SIDE_PANEL_OPTIONS.filter((panel) => !open.has(panel.id));
  }, [sidePanelTabs]);

  const selectorOptions = useMemo(
    () =>
      buildAcpSelectorOptions({
        configId: session.agentConfigId!,
        cliType: session.cliType,
        agentType: session.agentType,
      }),
    [session.agentConfigId, session.agentType, session.cliType]
  );
  const [modeId, setModeId] = useState<string | null>(
    () => selectorOptions.modeOptions[0]?.value ?? null
  );
  const [modelId, setModelId] = useState<string | null>(
    () => selectorOptions.modelOptions[0]?.value ?? null
  );

  const panelOpen = tracks.panel >= 0.5;
  const configurationActivity = (() => {
    if (!configurationState) return null;
    switch (configurationState.agentStatus) {
      case 'preparing':
        return {
          label: t('onboarding.preview.agentPreparing', 'Preparing {{agent}}…', {
            agent: identity.agentName,
          }),
          tone: 'primary' as const,
        };
      case 'awaiting-auth':
        return {
          label: t('onboarding.preview.agentAuth', 'Waiting for agent sign-in'),
          tone: 'warning' as const,
        };
      case 'verifying':
        return {
          label: t('onboarding.preview.agentVerifying', 'Verifying the agent runtime…'),
          tone: 'primary' as const,
        };
      case 'failed':
        return {
          label: t('onboarding.preview.agentFailed', 'Agent setup needs attention'),
          tone: 'warning' as const,
        };
      default:
        if (configurationState.projectStatus === 'importing') {
          return {
            label: t('onboarding.preview.projectImporting', 'Adding project…'),
            tone: 'primary' as const,
          };
        }
        if (configurationState.conversationStatus === 'starting') {
          return {
            label: t('onboarding.preview.conversationStarting', 'Starting your first task…'),
            tone: 'primary' as const,
          };
        }
        return null;
    }
  })();
  // Latched: once the dock has been open it stays mounted, so re-opening it
  // later costs a height change rather than another xterm.
  const terminalEverOpened = useRef(false);
  if (tracks.terminal > 0) terminalEverOpened.current = true;

  return (
    <div
      data-tour-anchor="window"
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden rounded-xl border border-border/70 bg-background text-foreground',
        className
      )}
    >
      {/* Window chrome. The tour is a WINDOW on a desk, not a fullscreen slab:
          nobody runs their editor fullscreen, and a frameless rectangle reads
          as a screenshot of a product rather than a product. */}
      <div className="flex h-9 shrink-0 items-center gap-2  px-4">
        <span className="flex items-center gap-1.5">
          <span className="size-[11px] rounded-full bg-[#ff5f57]" />
          <span className="size-[11px] rounded-full bg-[#febc2e]" />
          <span className="size-[11px] rounded-full bg-[#28c840]" />
        </span>
        {/* <span className="flex-1 text-center text-[11.5px] text-muted-foreground">
          {identity.projectName}
        </span> */}
        <span className="w-14" />
      </div>

      <div className="flex min-h-0 flex-1 m-2">
        <div data-tour-anchor="sidebar" className="h-full w-[280px] shrink-0 overflow-hidden">
          <LoroSidebar
            className="border border-border h-full w-[280px]"
            defaultWidth={280}
            minWidth={280}
            maxWidth={280}
            workspaceName={identity.workspaceName}
            userEmail={identity.userEmail}
            currentWorkspaceId={'onboarding-tour-workspace' as never}
            workspaces={
              [{ id: 'onboarding-tour-workspace', name: identity.workspaceName }] as never
            }
            activeNav="home"
            repoSections={repoSections}
          />
        </div>

        <div className="min-w-0 flex-1">
          <DesktopSessionDetailLayout
            // Its OWN key. The film is a fixed composition in a window of a
            // fixed size; inheriting the user's saved split makes it open at
            // an arbitrary one, and the camera — which frames real nodes —
            // faithfully follows the arbitrary layout.
            defaultSizes={{ main: 68, sidebar: 32 }}
            sidebarOpen={panelOpen}
            onSidebarCollapse={() => undefined}
            deleteConfirmDialog={null}
            topBar={
              <div data-tour-anchor="tab-bar">
                <SessionTabBar
                  variant="session"
                  parentSession={session}
                  childSessions={childSessions}
                  draftTabs={[]}
                  archivedChildSessions={[]}
                  activeTabSessionId={
                    activeTabIndex === 0
                      ? session.id
                      : (childSessions[activeTabIndex - 1]?.id ?? session.id)
                  }
                  onTabSelect={(id) => {
                    const index = childSessions.findIndex((child) => child.id === id);
                    onSelectTabIndex(index < 0 ? 0 : index + 1);
                  }}
                  onNewTab={() => undefined}
                  onTabRename={() => undefined}
                  onTabClose={() => undefined}
                  tabOrder={childSessions.map((child) => child.id)}
                />
              </div>
            }
            chatSurfaces={
              <SessionConversationPage
                className="h-full"
                bodySlot={
                  <SessionConversationPageBody
                    streamSlot={
                      <div data-tour-anchor="stream" className="h-full">
                        <SessionChatStreamView
                          sessionId={TOUR_SESSION_ID}
                          items={items}
                          renderMessageRow={({ message, sessionId }) => (
                            <MessageRowView message={message} sessionId={sessionId} />
                          )}
                          className="h-full"
                          agentActivityLabel={
                            configurationActivity?.label ??
                            (permissionPending
                              ? t('sessions.statusIndicator.requestPermission')
                              : Math.floor(tracks.reveal) >= 13
                                ? null
                                : t('sessions.statusIndicator.running'))
                          }
                          agentActivityTone={
                            configurationActivity?.tone ??
                            (permissionPending ? 'warning' : 'primary')
                          }
                        />
                      </div>
                    }
                    permissionSlot={
                      permissionPending ? (
                        // The product's own card, in the product's own slot. The
                        // scripted cursor presses the real button inside it; the
                        // resolution is this component resolving, not a flag.
                        <div data-tour-anchor="permission" className="px-3 pb-2">
                          <PermissionRequestCard
                            title="Bash(pnpm typecheck)"
                            options={[
                              { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
                              { optionId: 'deny', name: 'Not this time', kind: 'reject_once' },
                            ]}
                            onSelect={onPermissionAnswer}
                          />
                        </div>
                      ) : null
                    }
                    composerSlot={
                      <div data-tour-anchor="composer">
                        <div data-tour-anchor="info-bar">
                          <SessionInfoBar
                            status={null}
                            projectName={identity.projectName}
                            branch={session.branchName}
                            pr={tracks.pr >= 1 ? TOUR_PULL_REQUEST : null}
                            prCiRuns={
                              tracks.pr >= 2
                                ? [
                                    { name: 'typecheck', status: 'success' as const },
                                    { name: 'test', status: 'success' as const },
                                  ]
                                : undefined
                            }
                            diffStat={
                              revealedChanges.length > 0
                                ? {
                                    add: revealedChanges.reduce((sum, e) => sum + (e.add ?? 0), 0),
                                    del: revealedChanges.reduce((sum, e) => sum + (e.del ?? 0), 0),
                                  }
                                : null
                            }
                            contextActions={
                              tracks.pr >= 1
                                ? undefined
                                : revealedChanges.length > 0
                                  ? [
                                      {
                                        kind: 'standard',
                                        id: 'create-pr',
                                        label: 'Create PR',
                                        onClick: () => undefined,
                                      } as never,
                                    ]
                                  : undefined
                            }
                            onOpenPr={() => onSidePanelTabSelect('pr')}
                            onOpenAllChanges={() => onSidePanelTabSelect('changes')}
                            syncing={
                              configurationState?.agentStatus === 'preparing' ||
                              configurationState?.agentStatus === 'verifying' ||
                              configurationState?.projectStatus === 'importing' ||
                              configurationState?.conversationStatus === 'starting'
                            }
                          />
                        </div>
                        <SessionChatInputArea
                          ref={composerRef}
                          session={session}
                          sessionLocalProjectRootPath={`/Users/you/Code/${identity.projectName}`}
                          isMachineRemoved={false}
                          isAgentBusy={configurationState?.conversationStatus === 'starting'}
                          isDark
                          isEmptyConversation={false}
                          selectedModeId={modeId}
                          selectedModelId={modelId}
                          modeOptions={selectorOptions.modeOptions}
                          modelOptions={selectorOptions.modelOptions}
                          configOptionSelectors={selectorOptions.configOptionSelectors}
                          availableCommands={[]}
                          onModeChange={setModeId}
                          onModelChange={setModelId}
                          onSendMessage={async () => false}
                          onStop={() => undefined}
                          onRemoveQueueItem={async () => undefined}
                          disableImageUpload
                        />
                      </div>
                    }
                  />
                }
              />
            }
            terminalDock={
              terminalEverOpened.current ? (
                <div
                  data-tour-anchor="terminal"
                  style={{
                    // Height, not mount/unmount. The dock carries a real xterm;
                    // building one while the camera is moving toward it is a
                    // long commit on exactly the wrong frames. It mounts once,
                    // at zero height, and thereafter only grows and shrinks.
                    height: `${Math.round(tracks.terminal * 260)}px`,
                    opacity: Math.min(1, tracks.terminal * 2),
                    overflow: 'hidden',
                    transition: 'height 420ms ease, opacity 420ms ease',
                  }}
                >
                  <TerminalDock
                    channel={terminalChannel}
                    sessionId={TOUR_SESSION_ID}
                    defaultView="terminal"
                    autoOpenFirstTerminal
                  />
                </div>
              ) : null
            }
            secondaryPanel={
              <div
                data-tour-anchor="side-panel"
                className="mx-2 mb-2 mt-2 flex h-[calc(100%_-_1rem)] min-w-0 flex-col overflow-hidden rounded-xl border border-sidebar-border/80 bg-sidebar shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]"
              >
                <SessionSidePanelTabBar
                  tabs={sidePanelTabs}
                  activeTabId={activeSidePanelTab}
                  availablePanels={availableSidePanels}
                  onTabSelect={onSidePanelTabSelect}
                  onTabClose={() => undefined}
                  onPanelOpen={onSidePanelTabSelect}
                  addPanelLabel={String(t('sessions.sidebar.addPanel', 'Add panel'))}
                  closeTabLabel={(label) =>
                    String(
                      t('sessions.fileViewer.closeTab', 'Close {{fileName}}', {
                        fileName: label,
                      })
                    )
                  }
                  className="h-11 border-b border-border/60"
                />
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {/*
                    ALL of these stay mounted; only visibility switches.

                    This is what the stutter was. Mounting `PrTabView` or the
                    preview page for the first time — while the camera is
                    mid-move toward the panel they live in — puts a large React
                    commit on the exact frames the move needs. Production keeps
                    its side-panel surfaces mounted for the same class of reason
                    (`session-detail.tsx` hides the Browser panel rather than
                    unmounting it, so its DOM and history survive a tab switch).
                  */}
                  <TourPanelSurface active={activeSidePanelTab === 'changes'}>
                    <SessionChangesSidebar
                      ready
                      synced
                      changeEntries={revealedChanges}
                      changeFilePaths={revealedChanges.map((entry) => entry.filePath)}
                      onOpenChangesDiff={() => onSidePanelTabSelect('diff:src/auth/token.ts')}
                    />
                  </TourPanelSurface>
                  <TourPanelSurface active={activeSidePanelTab === 'browser'}>
                    <TourBrowserPreview
                      annotation={tracks.annotation}
                      commentBody={TOUR_ANNOTATION_REFERENCE.body}
                    />
                  </TourPanelSurface>
                  <TourPanelSurface active={activeSidePanelTab === 'pr'}>
                    <PrTabView
                      repoFullName={TOUR_PR_REPO}
                      prNumber={TOUR_PR_NUMBER}
                      state="ready"
                      onMerge={onMergePr}
                      data={{
                        pullRequest: merged ? TOUR_PR_MERGED : TOUR_PR_DETAILS,
                        reviewThreads: [],
                        reviews: [],
                        issueComments: [],
                        checkRuns: TOUR_PR_CHECKS,
                      }}
                    />
                  </TourPanelSurface>
                  <TourPanelSurface
                    active={
                      activeSidePanelTab !== 'changes' &&
                      activeSidePanelTab !== 'browser' &&
                      activeSidePanelTab !== 'pr'
                    }
                  >
                    <TourDiffPlaceholder />
                  </TourPanelSurface>
                </div>
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * One side-panel surface, hidden rather than unmounted.
 *
 * `display: none` and not `visibility`, so a hidden surface costs no layout —
 * but the subtree, its state and its DOM survive, which is the whole point.
 */
function TourPanelSurface({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="h-full" style={{ display: active ? 'block' : 'none' }} aria-hidden={!active}>
      {children}
    </div>
  );
}

/**
 * The diff surface, while the real one cannot run.
 *
 * The production viewer is Monaco reading a CLI-local evidence store over
 * Machine RPC; there is no honest way to mount it against fixtures. So this is
 * deliberately a PLAIN diff rather than a lookalike of the real viewer's
 * chrome: it shows the content the beat is about without claiming to be a
 * component it is not. Everything else on screen is the real thing, and this is
 * the one place that is stated rather than implied.
 */
function TourDiffPlaceholder(): React.JSX.Element {
  const lines: Array<[string, string]> = [
    ['ctx', 'export function createSession(user: User) {'],
    ['del', '  const token = signToken(user.id, DEFAULT_TTL)'],
    ['del', '  cache.set(token, user.id)'],
    ['add', '  const token = issueToken(user)'],
    ['ctx', '  return { user, token }'],
    ['ctx', '}'],
  ];
  return (
    <div className="h-full overflow-hidden bg-background/40 px-3 py-2 font-mono text-[11.5px] leading-[1.65]">
      {lines.map(([kind, text], index) => (
        <div
          key={index}
          className={cn(
            'whitespace-pre rounded px-2',
            kind === 'add' && 'bg-code-added/15 text-code-added',
            kind === 'del' && 'bg-code-removed/15 text-code-removed',
            kind === 'ctx' && 'text-muted-foreground'
          )}
        >
          {kind === 'add' ? '+' : kind === 'del' ? '-' : ' '} {text}
        </div>
      ))}
    </div>
  );
}
