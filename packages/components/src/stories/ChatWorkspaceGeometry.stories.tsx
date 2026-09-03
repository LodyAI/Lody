import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { FolderPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import {
  getAgentConfigRoomId,
  type AgentConfigId,
  type AgentConfigMeta,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type SessionStatus,
} from '@lody/shared';

import { agentConfigMetaCacheAtom } from '@/atoms/doc-meta';
import { BranchSelector } from '@/components/chat/chat-landing-selectors';
import { ChatLandingView } from '@/components/chat/chat-landing-view';
import {
  UnifiedProjectSelectorView,
  type UnifiedProjectSelection,
} from '@/components/chat/unified-project-selector';
import WorkspaceGeometryDevtools from '@/components/devtools/workspace-geometry-devtools';
import { LocalProjectItem } from '@/components/loro-app-sidebar';
import { LoroSidebar } from '@/components/loro-sidebar';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import {
  DesktopMachineMenu,
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import {
  SessionSidePanelTabBar,
  type SessionSidePanelOption,
  type SessionSidePanelTabItem,
} from '@/components/sessions/session-side-panel-tab-bar';
import { SessionTabBar } from '@/components/sessions/session-tab-bar';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import type { SessionListProps, SessionListRow } from '@/components/session-list';
import { SidebarSectionHeader } from '@/components/sidebar-row-shared';
import { WebWorkspaceFrame } from '@/components/web-workspace-layout';
import {
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE,
} from '@/lib/chat-workspace-geometry';
import type { PastedTextDraft } from '@/lib/pasted-text-draft';

const GEOMETRY_MACHINE_ID = 'machine-geometry' as MachineId;
const GEOMETRY_PROJECT_ID = 'project-geometry' as LocalProjectId;
const GEOMETRY_AGENT_ID = 'agent-geometry' as AgentConfigId;
const STORY_NOW = Date.now();
const EMPTY_LIVE_SESSION_STATUSES = new Map<string, SessionStatus>();

const geometryStoryPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'user-geometry', name: 'Geometry Designer' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [
      {
        id: 'workspace-geometry',
        name: 'Geometry Lab',
        slug: 'geometry',
        role: 'owner',
      },
    ],
    activeWorkspaceId: 'workspace-geometry',
  }),
});

const geometryAgentConfigs: AgentConfigMeta[] = [
  {
    id: GEOMETRY_AGENT_ID,
    machineId: GEOMETRY_MACHINE_ID,
    name: 'Codex',
    description: 'Codex on Geometry Mac',
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
];

const modelOptions: AcpSessionSelectOption[] = [
  { value: 'gpt-5.5', label: 'gpt-5.5', description: 'Frontier agentic coding model.' },
  { value: 'gpt-5.4', label: 'gpt-5.4', description: 'General-purpose coding model.' },
];

const longModelOptions: AcpSessionSelectOption[] = [
  {
    value: 'claude-sonnet-4-6-20250514-thinking-extended',
    label: 'claude-sonnet-4-6-20250514-thinking-extended',
    description: 'A deliberately long production-shaped model label.',
  },
  ...modelOptions,
];

type LandingScenario =
  | 'default'
  | 'submission-pending'
  | 'no-machine-download'
  | 'no-machine-starting'
  | 'no-agent-config'
  | 'long-model'
  | 'pasted-text';

const pastedTextDisplay = '[Pasted 1,320 characters]';
const pastedTextPromptPrefix = 'Inspect ';
const pastedTextPrompt = `${pastedTextPromptPrefix}${pastedTextDisplay} and identify the layout regression.`;
const pastedTextDraft: PastedTextDraft = {
  id: 'geometry-pasted-text',
  text: 'Synthetic geometry audit log. '.repeat(48),
  displayText: pastedTextDisplay,
  start: pastedTextPromptPrefix.length,
  end: pastedTextPromptPrefix.length + pastedTextDisplay.length,
};

const permissionModeOptions: AcpSessionSelectOption[] = [
  { value: 'default', label: 'Default', description: 'Ask before sensitive operations.' },
  { value: 'plan', label: 'Plan', description: 'Read-only planning mode.' },
];

const configOptionSelectors: AcpConfigOptionSelector[] = [
  {
    type: 'select',
    configId: 'reasoning_effort',
    category: 'thought_level',
    label: 'Reasoning effort',
    currentValue: 'medium',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  },
];

const sidebarSessions: SessionListRow[] = [
  {
    sessionId: 'session-grid-contract',
    title: 'Define the workspace grid contract',
    repoFullName: null,
    branchName: '',
    latestMessageAt: STORY_NOW - 8 * 60 * 1000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: true,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
  },
  {
    sessionId: 'session-sidebar-baseline',
    title: 'Audit Sidebar semantic baselines',
    repoFullName: null,
    branchName: '',
    latestMessageAt: STORY_NOW - 38 * 60 * 1000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: true,
    isOffline: false,
    isWaitingPermission: false,
  },
  {
    sessionId: 'session-ci-validation',
    title: 'Validate deterministic geometry in CI',
    repoFullName: null,
    branchName: '',
    latestMessageAt: STORY_NOW - 75 * 60 * 1000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
  },
];

const sidebarSessionListProps: SessionListProps = {
  sessions: sidebarSessions,
  repos: [],
  chatsCollapsed: false,
  selectedSessionId: null,
  onSelect: () => {},
  onToggleRepoCollapsed: () => {},
  onToggleChatsCollapsed: () => {},
  onArchiveSession: () => {},
  onNew: () => {},
};

const geometryLocalProject: LocalProjectMeta = {
  id: GEOMETRY_PROJECT_ID,
  name: 'lody',
  rootPath: '/workspace/lody',
  createdAtMs: STORY_NOW - 30 * 24 * 60 * 60 * 1000,
};

const geometryLocalSessions: SessionMeta[] = [
  'Map semantic alignment rails',
  'Validate trailing action slots',
  'Audit row content centers',
  'Render deterministic design guides',
  'Document the geometry contract',
].map((title, index) => ({
  id: `local-geometry-${index + 1}` as SessionId,
  machineId: GEOMETRY_MACHINE_ID,
  createdAt: new Date(STORY_NOW - (index + 1) * 60 * 60 * 1000).toISOString(),
  userId: 'user-geometry',
  cliType: 'builtin',
  agentType: 'codex',
  title,
  isWorktree: index === 0,
  lastMessageAt: STORY_NOW - (index + 1) * 60 * 60 * 1000,
}));

function GeometrySidebarTopContent() {
  const [projectCollapsed, setProjectCollapsed] = useState(false);
  return (
    <div
      {...{ [CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE]: 'sidebar.local-projects:geometry' }}
      className="mb-3 space-y-0.5"
    >
      <SidebarSectionHeader
        label="Local Projects"
        collapsed={false}
        isMobile={false}
        toggleLabel="Toggle local projects"
        onToggleCollapsed={() => {}}
        action={
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground/80"
              aria-label="Import local project folder"
            >
              <FolderPlus className="h-4 w-4" />
            </button>
            <span aria-hidden="true" className="block h-5 w-5" />
          </div>
        }
      />
      <LocalProjectItem
        machineId={GEOMETRY_MACHINE_ID}
        machineName="Geometry Mac"
        project={geometryLocalProject}
        canRemoveProject
        canNavigateProject
        collapsed={projectCollapsed}
        isSelected={false}
        sessionsForProject={geometryLocalSessions}
        childSessionsByParent={new Map()}
        liveSessionStatuses={EMPTY_LIVE_SESSION_STATUSES}
        formattedPath={geometryLocalProject.rootPath}
        defaultSessionTitle="Untitled"
        selectedSessionId={null}
        removeProjectLabel="Remove project"
        archiveTooltipLabel="Archive"
        archiveActionLabel="Archive"
        archiveConfirmLabel="Confirm"
        isMobile={false}
        toggleLabel="Toggle project"
        onNavigateProject={() => {}}
        onNavigateSession={() => {}}
        onArchive={() => {}}
        collapsedOpenedBySessionIds={{}}
        onToggleOpenedBySessions={() => {}}
        onToggleCollapsed={() => setProjectCollapsed((value) => !value)}
        onRequestRemoval={() => {}}
      />
    </div>
  );
}

function DeterministicChatLanding({ scenario }: { scenario: LandingScenario }) {
  const initialPrompt =
    scenario === 'pasted-text'
      ? pastedTextPrompt
      : scenario === 'submission-pending'
        ? 'This draft remains stable while the session is being created.'
        : '';
  const selectedModel =
    scenario === 'long-model' ? 'claude-sonnet-4-6-20250514-thinking-extended' : 'gpt-5.5';
  const [prompt, setPrompt] = useState(initialPrompt);
  const [pastedTextDrafts, setPastedTextDrafts] = useState<PastedTextDraft[]>(
    scenario === 'pasted-text' ? [pastedTextDraft] : []
  );
  const [project, setProject] = useState<UnifiedProjectSelection>({
    kind: 'local',
    machineId: GEOMETRY_MACHINE_ID,
    localProjectId: GEOMETRY_PROJECT_ID,
  });
  const [branch, setBranch] = useState('feat/web-grid-system');
  const [model, setModel] = useState<string | null>(selectedModel);
  const [permissionMode, setPermissionMode] = useState<string | null>('default');
  const [configValues, setConfigValues] = useState<Record<string, AcpConfigOptionValue>>({
    reasoning_effort: 'medium',
  });

  const topSelector = (
    <div className="w-full min-w-0">
      <div className="flex w-full min-w-0 items-center gap-2">
        <DesktopMachineMenu
          value={GEOMETRY_MACHINE_ID}
          visibleLocalMachineId={GEOMETRY_MACHINE_ID}
          options={[{ value: GEOMETRY_MACHINE_ID, label: 'Geometry Mac' }]}
          onChange={() => {}}
        />
        <UnifiedProjectSelectorView
          value={project}
          onChange={setProject}
          localProjects={[
            {
              key: `${GEOMETRY_MACHINE_ID}:${GEOMETRY_PROJECT_ID}`,
              machineId: GEOMETRY_MACHINE_ID,
              localProjectId: GEOMETRY_PROJECT_ID,
              name: 'lody',
              rootPath: '/workspace/lody',
            },
          ]}
          repositories={[]}
          onAddLocalProject={() => {}}
          onConnectGitRepo={() => {}}
        />
        <BranchSelector
          value={branch}
          onChange={setBranch}
          options={[
            { value: 'feat/web-grid-system', label: 'feat/web-grid-system' },
            { value: 'main', label: 'main' },
          ]}
          tone="light"
        />
      </div>
    </div>
  );

  const footerSelector = (
    <div className="contents">
      <DesktopRunConfigMenu
        agentSelection={{ agentId: GEOMETRY_AGENT_ID, machineId: GEOMETRY_MACHINE_ID }}
        allowedMachineIds={[GEOMETRY_MACHINE_ID]}
        availableAgentConfigs={geometryAgentConfigs}
        fallbackAgent={{ cliType: 'builtin', agentType: 'codex' }}
        onAgentConfigChange={() => {}}
        modelOptions={scenario === 'long-model' ? longModelOptions : modelOptions}
        selectedModelId={model}
        onModelChange={setModel}
        modeOptions={permissionModeOptions}
        selectedModeId={permissionMode}
        configOptionSelectors={configOptionSelectors}
        configOptionValues={configValues}
        onConfigOptionChange={(configId, value) =>
          setConfigValues((previous) => ({ ...previous, [configId]: value }))
        }
      />
      <DesktopPermissionModeButton
        modeOptions={permissionModeOptions}
        selectedModeId={permissionMode}
        onModeChange={setPermissionMode}
      />
    </div>
  );

  return (
    <ChatLandingView
      tone="light"
      title="Let's ship something"
      promptValue={prompt}
      onPromptChange={setPrompt}
      promptPlaceholder="Press '/' for commands, '@' for mentions."
      pastedTextDrafts={pastedTextDrafts}
      onPastedTextDraftsChange={setPastedTextDrafts}
      topSelector={topSelector}
      footerSelector={footerSelector}
      submissionPending={scenario === 'submission-pending'}
      submitDisabled={scenario === 'submission-pending' || prompt.trim().length === 0}
      hintType={
        scenario === 'no-agent-config'
          ? 'no-agent-config'
          : scenario === 'no-machine-download' || scenario === 'no-machine-starting'
            ? 'no-machine'
            : null
      }
      noMachineVariant={scenario === 'no-machine-starting' ? 'daemon-starting' : 'download-client'}
      onDownloadClient={() => {}}
      onReportBug={() => {}}
      onGoToAgentSettings={() => {}}
      onSubmit={() => {}}
    />
  );
}

/**
 * Deterministic data adapter around the production desktop route view tree:
 * WebWorkspaceFrame → LoroSidebar/SessionList + ChatLandingView/ChatComposer.
 * Stateful route loaders are replaced, but no visual shell or composer is.
 */
function ChatWorkspaceGeometryFixture({
  sidebar = 'expanded',
  landingScenario = 'default',
}: {
  sidebar?: 'expanded' | 'collapsed';
  landingScenario?: LandingScenario;
}) {
  const store = useMemo(() => {
    const nextStore = createStore();
    nextStore.set(
      agentConfigMetaCacheAtom,
      Object.fromEntries(
        geometryAgentConfigs.map((config) => [getAgentConfigRoomId(config.id), config])
      )
    );
    return nextStore;
  }, []);
  const sidebarCard = (
    <LoroSidebar
      className="mb-2 ml-2 mr-1 mt-2 h-[calc(100%_-_1rem)] rounded-xl border border-sidebar-border/80 bg-sidebar shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]"
      workspaceName="Geometry Lab"
      userEmail="geometry@example.test"
      workspaces={[{ id: 'workspace-geometry', name: 'Geometry Lab' }]}
      currentWorkspaceId="workspace-geometry"
      workspaceSwitcherEnabled={false}
      defaultWidth={CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.defaultWidth}
      minWidth={CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.minWidth}
      maxWidth={CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.maxWidth}
      activeNav="home"
      repoSections={[]}
      chats={[]}
      topContent={<GeometrySidebarTopContent />}
      sessionListProps={sidebarSessionListProps}
    />
  );
  const sidebarSlideWidth =
    CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.defaultWidth +
    CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.cardInset.left +
    CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.cardInset.right;

  return (
    <PlatformContext.Provider value={geometryStoryPlatform}>
      <Provider store={store}>
        <div data-geometry-fixture-ready="true" data-geometry-fixture-view="production">
          <WebWorkspaceFrame
            pathname="/geometry/chat"
            sidebar={sidebarCard}
            sidebarCollapsed={sidebar === 'collapsed'}
            sidebarSlideWidth={sidebarSlideWidth}
            shouldReduceMotion
          >
            <DeterministicChatLanding scenario={landingScenario} />
          </WebWorkspaceFrame>
        </div>
      </Provider>
    </PlatformContext.Provider>
  );
}

/**
 * The three region headers — the workspace Sidebar's, the Session tab bar's and
 * the right panel's — render in three separate stories, so no capture has ever
 * held more than one of them. A geometric row is per capture, so discovery
 * could not compare them even in principle. This composition puts all three on
 * one page through the production shell that positions them:
 * `WebWorkspaceFrame` → `DesktopSessionDetailLayout` → `SessionTabBar` +
 * `SessionSidePanelTabBar`. No markers, and no attribute beyond the discovery
 * scope the side panel already declares in its own story.
 */
const GEOMETRY_SIDE_PANEL_TABS: SessionSidePanelTabItem[] = [
  { id: 'files', label: 'Files', kind: 'files', closeable: true },
  { id: 'changes', label: 'All Changes', kind: 'changes', closeable: true },
  {
    id: 'file:src/app.tsx',
    label: 'app.tsx',
    kind: 'file',
    filePath: 'src/app.tsx',
    closeable: true,
  },
];
const GEOMETRY_SIDE_PANEL_OPTIONS: SessionSidePanelOption[] = [
  { id: 'browser', label: 'Browser', kind: 'browser' },
  { id: 'pr', label: 'PR', kind: 'pr' },
];
const geometryTabSessions: SessionMeta[] = geometryLocalSessions.slice(0, 2);

/** `DesktopSessionDetailLayout` persists its split under this `autoSaveId`. */
const GEOMETRY_PANEL_STORAGE_KEY = 'react-resizable-panels:session-detail-panels';

function ChatWorkspaceSessionGeometryFixture() {
  const store = useMemo(() => {
    const nextStore = createStore();
    nextStore.set(
      agentConfigMetaCacheAtom,
      Object.fromEntries(
        geometryAgentConfigs.map((config) => [getAgentConfigRoomId(config.id), config])
      )
    );
    // Cleared during render, not in an effect: a persisted split from a
    // previous drag would silently change every measured x in this capture,
    // and an effect would race the first paint the capture may already have.
    globalThis.localStorage?.removeItem(GEOMETRY_PANEL_STORAGE_KEY);
    return nextStore;
  }, []);
  const [activeSidePanelTabId, setActiveSidePanelTabId] = useState<string | null>(
    'file:src/app.tsx'
  );
  const parentSession = geometryTabSessions[0];
  const childSession = geometryTabSessions[1];
  if (!parentSession || !childSession) throw new Error('Geometry tab fixture is missing a session');
  const sidebarCard = (
    <LoroSidebar
      className="mb-2 ml-2 mr-1 mt-2 h-[calc(100%_-_1rem)] rounded-xl border border-sidebar-border/80 bg-sidebar shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]"
      workspaceName="Geometry Lab"
      userEmail="geometry@example.test"
      workspaces={[{ id: 'workspace-geometry', name: 'Geometry Lab' }]}
      currentWorkspaceId="workspace-geometry"
      workspaceSwitcherEnabled={false}
      defaultWidth={CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.defaultWidth}
      minWidth={CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.minWidth}
      maxWidth={CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.maxWidth}
      activeNav="home"
      repoSections={[]}
      chats={[]}
      topContent={<GeometrySidebarTopContent />}
      sessionListProps={sidebarSessionListProps}
    />
  );
  return (
    <PlatformContext.Provider value={geometryStoryPlatform}>
      <Provider store={store}>
        <div data-geometry-fixture-ready="true" data-geometry-fixture-view="production">
          <WebWorkspaceFrame
            pathname="/geometry/session"
            sidebar={sidebarCard}
            sidebarCollapsed={false}
            sidebarSlideWidth={
              CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.defaultWidth +
              CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.cardInset.left +
              CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.cardInset.right
            }
            shouldReduceMotion
          >
            <DesktopSessionDetailLayout
              defaultSizes={{ main: 70, sidebar: 30 }}
              topBar={
                <SessionTabBar
                  variant="session"
                  parentSession={parentSession}
                  childSessions={[childSession]}
                  draftTabs={[]}
                  archivedChildSessions={[]}
                  activeTabSessionId={parentSession.id}
                  tabOrder={[childSession.id]}
                  onTabSelect={() => {}}
                  onNewTab={() => {}}
                />
              }
              chatSurfaces={<DeterministicChatLanding scenario="default" />}
              terminalDock={null}
              secondaryPanel={
                <div
                  {...{ [CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE]: 'session.side-panel' }}
                  className="flex h-full min-h-0 flex-col overflow-hidden"
                >
                  <SessionSidePanelTabBar
                    tabs={GEOMETRY_SIDE_PANEL_TABS}
                    activeTabId={activeSidePanelTabId}
                    availablePanels={GEOMETRY_SIDE_PANEL_OPTIONS}
                    onTabSelect={setActiveSidePanelTabId}
                    onPanelOpen={() => {}}
                    onTabClose={() => {}}
                    closeTabLabel={(tabLabel) => `Close ${tabLabel}`}
                  />
                </div>
              }
              sidebarOpen
              onSidebarCollapse={() => {}}
              deleteConfirmDialog={null}
            />
          </WebWorkspaceFrame>
        </div>
      </Provider>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Geometry/ChatWorkspace',
  component: ChatWorkspaceGeometryFixture,
  parameters: {
    layout: 'fullscreen',
    options: { showPanel: false },
  },
} satisfies Meta<typeof ChatWorkspaceGeometryFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ExpandedSidebar: Story = {};

export const CollapsedSidebar: Story = {
  args: { sidebar: 'collapsed' },
};

export const SubmissionPending: Story = {
  args: { landingScenario: 'submission-pending' },
};

export const NoMachineDownload: Story = {
  args: { landingScenario: 'no-machine-download' },
};

export const NoMachineStarting: Story = {
  args: { landingScenario: 'no-machine-starting' },
};

export const NoAgentConfig: Story = {
  args: { landingScenario: 'no-agent-config' },
};

export const LongModel: Story = {
  args: { landingScenario: 'long-model' },
};

export const PastedText: Story = {
  args: { landingScenario: 'pasted-text' },
};

export const WorkspaceSessionSidePanel: StoryObj<typeof ChatWorkspaceSessionGeometryFixture> = {
  render: () => <ChatWorkspaceSessionGeometryFixture />,
};

export const GeometryAudit: Story = {
  render: (args) => (
    <>
      <ChatWorkspaceGeometryFixture {...args} />
      <WorkspaceGeometryDevtools forceEnabled />
    </>
  ),
};
