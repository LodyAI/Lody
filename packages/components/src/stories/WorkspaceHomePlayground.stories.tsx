import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { Provider, createStore } from 'jotai';
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
  type WorkspaceId,
} from '@lody/shared';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

import { agentConfigMetaCacheAtom } from '@/atoms/doc-meta';
import type { AgentSelection } from '@/components/shared/agent-selector';
import { ChatLandingView } from '@/components/chat/chat-landing-view';
import { BranchSelector } from '@/components/chat/chat-landing-selectors';
import {
  UnifiedProjectSelectorView,
  type UnifiedLocalProjectOption,
  type UnifiedProjectSelection,
} from '@/components/chat/unified-project-selector';
import {
  DesktopMachineMenu,
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import { WorktreeCheckboxPill } from '@/components/shared/workdir-mode-selector';
import { composerSurface } from '@/components/shared/composer-surface';
import { HomeDashboard } from '@/components/chat/home/home-dashboard';
import type { HomeBoard } from '@/lib/home-board';
import {
  HOME_WEEK_NOW,
  HOME_WEEK_USAGE_SOURCES,
  homeNowFixture,
  homeWeekAgentIcon,
  homeWeekAgentLabel,
  homeWeekFixture,
  homeWeekUsageFixture,
  type HomeWeekFixtureKind,
} from './fixtures/home-week';
import { Default as SidebarDefault, WorkspaceSidebarHarness } from './LoroSidebar.stories';

const STORY_WORKSPACE_ID = 'workspace-storybook-home' as WorkspaceId;
const STORY_USER_ID = 'local:storybook-home-user';
const STORY_MACHINE_ID = 'machine-demo' as MachineId;
const STORY_REMOTE_MACHINE_ID = 'machine-remote' as MachineId;
const STORY_AGENT_CODEX_ID = 'agent-storybook-codex' as AgentConfigId;
const STORY_AGENT_CLAUDE_ID = 'agent-storybook-claude' as AgentConfigId;
const PERSONAL_TOOLS_PROJECT_ID = 'project-personal-tools' as LocalProjectId;
const LOCAL_GIT_PROJECT_ID = 'project-local-git' as LocalProjectId;
const REMOTE_NOTES_PROJECT_ID = 'project-remote-notes' as LocalProjectId;

const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: STORY_USER_ID, name: 'Storybook user' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [{ id: STORY_WORKSPACE_ID, name: 'Loro', slug: 'loro', role: 'owner' }],
    activeWorkspaceId: STORY_WORKSPACE_ID,
  }),
});

const machineOptions = [
  { value: STORY_MACHINE_ID, label: 'Mac Studio' },
  { value: STORY_REMOTE_MACHINE_ID, label: 'MacBook Pro' },
] as const;

const localProjectOptions: UnifiedLocalProjectOption[] = [
  {
    key: `${STORY_MACHINE_ID}:${PERSONAL_TOOLS_PROJECT_ID}`,
    machineId: STORY_MACHINE_ID,
    localProjectId: PERSONAL_TOOLS_PROJECT_ID,
    name: 'personal-tools',
    rootPath: '/Users/developer/Projects/personal-tools',
  },
  {
    key: `${STORY_MACHINE_ID}:${LOCAL_GIT_PROJECT_ID}`,
    machineId: STORY_MACHINE_ID,
    localProjectId: LOCAL_GIT_PROJECT_ID,
    name: 'design-system-lab',
    rootPath: '/Users/developer/Projects/design-system-lab',
  },
  {
    key: `${STORY_REMOTE_MACHINE_ID}:${REMOTE_NOTES_PROJECT_ID}`,
    machineId: STORY_REMOTE_MACHINE_ID,
    localProjectId: REMOTE_NOTES_PROJECT_ID,
    name: 'research-notes',
    rootPath: '/Users/developer/Notes/research-notes',
  },
];

const sidebarLocalProjects: LocalProjectMeta[] = [
  {
    id: PERSONAL_TOOLS_PROJECT_ID,
    name: 'personal-tools',
    rootPath: '/Users/developer/Projects/personal-tools',
    createdAtMs: Date.parse('2026-08-01T12:00:00.000Z'),
  },
  {
    id: LOCAL_GIT_PROJECT_ID,
    name: 'design-system-lab',
    rootPath: '/Users/developer/Projects/design-system-lab',
    createdAtMs: Date.parse('2026-09-12T12:00:00.000Z'),
  },
];

const remoteProjectMeta: LocalProjectMeta = {
  id: REMOTE_NOTES_PROJECT_ID,
  name: 'research-notes',
  rootPath: '/Users/developer/Notes/research-notes',
  createdAtMs: Date.parse('2026-09-26T12:00:00.000Z'),
};

const sidebarLocalProjectGroups = [
  {
    machineId: STORY_MACHINE_ID,
    machineName: 'Mac Studio',
    label: 'Mac Studio',
    projects: sidebarLocalProjects,
  },
  {
    machineId: STORY_REMOTE_MACHINE_ID,
    machineName: 'MacBook Pro',
    label: 'MacBook Pro',
    projects: [remoteProjectMeta],
  },
];

// This is a machine-owned folder with no GitHub repository and no worktree. The
// second fixture shows a local Git worktree separately; neither invents a GitHub link.
const localPlainTitles = [
  'Review the local script runner',
  'Tidy up the settings copy',
  'Add the usage tile',
  'Follow-up on the script runner',
  'Refactor presence sync',
  'Fix the desktop bootstrap race',
  'Repair session sync on wake',
  'Resolve type errors in chat landing',
  'Week tiles on the new-chat page',
  'Paste precedence for images',
  'Add the provider import flow',
  'Update onboarding copy',
  'Clean up dead code',
  'Improve the error boundary',
  'Index the local project files',
  'Sync workspace metadata',
  'Rebuild the home dashboard',
  'Write the changelog for 0.107',
  'Investigate flaky e2e',
  'Docs site landing shader',
];

const localPlainSessions: SessionMeta[] = localPlainTitles.map((title, index) => ({
  id: `session-personal-tools-${index}` as SessionId,
  machineId: STORY_MACHINE_ID,
  createdAt: new Date(Date.parse('2026-10-18T07:00:00.000Z') + index * 600_000).toISOString(),
  userId: STORY_USER_ID,
  cliType: 'builtin',
  agentType: index % 2 === 0 ? 'codex' : 'claude',
  title,
  isWorktree: false,
  ...(index % 3 === 0
    ? {
        pullRequests: [
          { url: `https://github.com/LodyAI/lody/pull/${800 + index}`, status: 'open' },
        ],
      }
    : {}),
  ...(index % 5 === 0 && index > 0
    ? {
        openedBySessionId: `session-personal-tools-${index - 1}` as SessionId,
        openedByRowSessionId: `session-personal-tools-${index - 1}` as SessionId,
      }
    : {}),
  lastMessageAt: Date.parse('2026-10-18T09:00:00.000Z') + index * 300_000,
}));

const localRepoNoWorktreeSession: SessionMeta = {
  id: 'session-personal-tools-linked-repo' as SessionId,
  machineId: STORY_MACHINE_ID,
  createdAt: '2026-10-18T08:30:00.000Z',
  userId: STORY_USER_ID,
  cliType: 'builtin',
  agentType: 'codex',
  title: 'Review linked repository changes',
  project: {
    kind: 'local',
    localProjectId: PERSONAL_TOOLS_PROJECT_ID,
    githubRepoFullName: 'example-org/personal-tools',
    branch: 'main',
  },
  repoFullName: 'example-org/personal-tools',
  branchName: 'main',
  pullRequests: [{ url: 'https://github.com/example-org/personal-tools/pull/42', status: 'open' }],
  isWorktree: false,
  lastMessageAt: Date.parse('2026-10-18T09:30:00.000Z'),
};

const localWorktreeSession: SessionMeta = {
  id: 'session-design-system-worktree' as SessionId,
  machineId: STORY_MACHINE_ID,
  createdAt: '2026-10-18T08:00:00.000Z',
  userId: STORY_USER_ID,
  cliType: 'builtin',
  agentType: 'codex',
  title: 'Try a token contrast update',
  branchName: 'visual/token-contrast',
  isWorktree: true,
  lastMessageAt: Date.parse('2026-10-18T09:10:00.000Z'),
};

type InitialLocalProject = 'personal-tools' | 'design-system-lab';
type SidebarLocalSessionMode = 'plain' | 'repo-no-worktree' | 'worktree';

const localSidebarSessionModes: Record<SidebarLocalSessionMode, SessionMeta[]> = {
  plain: localPlainSessions,
  'repo-no-worktree': [localRepoNoWorktreeSession],
  worktree: [localWorktreeSession],
};

const agentConfigs: AgentConfigMeta[] = [
  {
    id: STORY_AGENT_CODEX_ID,
    machineId: STORY_MACHINE_ID,
    name: 'Codex · Mac Studio',
    description: 'Local Codex agent',
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
  {
    id: STORY_AGENT_CLAUDE_ID,
    machineId: STORY_MACHINE_ID,
    name: 'Claude · Mac Studio',
    description: 'Local Claude agent',
    cliType: 'builtin',
    agentType: 'claude',
    env: {},
  },
  {
    id: 'agent-storybook-remote' as AgentConfigId,
    machineId: STORY_REMOTE_MACHINE_ID,
    name: 'Codex · MacBook Pro',
    description: 'Remote machine agent',
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
];

const codexModels: AcpSessionSelectOption[] = [
  { value: 'gpt-5.5', label: 'GPT-5.5', description: 'Frontier coding model.' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Smaller, faster coding model.' },
];

const claudeModels: AcpSessionSelectOption[] = [
  { value: 'sonnet-4.6', label: 'Claude Sonnet 4.6', description: 'Balanced for everyday coding.' },
  { value: 'opus-4.6', label: 'Claude Opus 4.6', description: 'For complex engineering work.' },
];

const permissionModes: AcpSessionSelectOption[] = [
  {
    value: 'read-only',
    label: 'Read-only',
    description: 'Ask before editing or running commands.',
  },
  { value: 'agent', label: 'Agent', description: 'Read and edit files in the project.' },
  {
    value: 'agent-full-access',
    label: 'Full access',
    description: 'Allow edits outside the project and network access.',
  },
];

const runConfigSelectors: AcpConfigOptionSelector[] = [
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
      { value: 'xhigh', label: 'XHigh' },
    ],
  },
  {
    type: 'boolean',
    configId: 'plan_mode',
    label: 'Plan',
    currentValue: false,
    options: [],
  },
  {
    type: 'select',
    configId: 'fast-mode',
    category: 'fast-mode',
    label: 'Fast mode',
    currentValue: 'off',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
  },
];

const localBranches: AcpSessionSelectOption[] = [
  { value: 'main', label: 'main' },
  { value: 'visual/token-contrast', label: 'visual/token-contrast' },
];

const action = fn();

type WorkspaceHomePlaygroundProps = {
  initialLocalProject: InitialLocalProject;
  sidebarLocalSessionMode: SidebarLocalSessionMode;
  composerTone: 'light' | 'dark';
  pageTitle: string;
  promptDraft: string;
  weekScenario: HomeWeekFixtureKind;
  agentsRunning: boolean;
  showActivityOverview: boolean;
  showPlanUsage: boolean;
  showCodexForecast: boolean;
};

function createStoryStore() {
  const store = createStore();
  store.set(
    agentConfigMetaCacheAtom,
    Object.fromEntries(agentConfigs.map((agent) => [getAgentConfigRoomId(agent.id), agent]))
  );
  return store;
}

function WorkspaceLandingHarness({
  initialLocalProject,
  composerTone,
  pageTitle,
  promptDraft,
  weekScenario,
  agentsRunning,
  showActivityOverview,
  showPlanUsage,
  showCodexForecast,
}: WorkspaceHomePlaygroundProps) {
  const [homeBoard, setHomeBoard] = useState<HomeBoard | null>(null);
  const [machineId, setMachineId] = useState<MachineId>(STORY_MACHINE_ID);
  const [hasSelectedProject, setHasSelectedProject] = useState(true);
  const [selectedLocalProjectId, setSelectedLocalProjectId] = useState<LocalProjectId>(
    initialLocalProject === 'personal-tools' ? PERSONAL_TOOLS_PROJECT_ID : LOCAL_GIT_PROJECT_ID
  );
  const [localBranch, setLocalBranch] = useState<string | null>('main');
  const [localWorkdirMode, setLocalWorkdirMode] = useState<'local' | 'worktree'>('local');
  const [pageTitleValue, setPageTitleValue] = useState(pageTitle);
  const [prompt, setPrompt] = useState(promptDraft);
  const [agentSelection, setAgentSelection] = useState<AgentSelection>({
    machineId: STORY_MACHINE_ID,
    agentId: STORY_AGENT_CODEX_ID,
  });
  const [selectedModelId, setSelectedModelId] = useState<string | null>(
    codexModels[0]?.value ?? null
  );
  const [selectedModeId, setSelectedModeId] = useState<string | null>('agent');
  const [configOptionValues, setConfigOptionValues] = useState<
    Record<string, AcpConfigOptionValue>
  >({
    reasoning_effort: 'medium',
    plan_mode: false,
    'fast-mode': 'off',
  });

  useEffect(() => {
    setSelectedLocalProjectId(
      initialLocalProject === 'personal-tools' ? PERSONAL_TOOLS_PROJECT_ID : LOCAL_GIT_PROJECT_ID
    );
    setHasSelectedProject(true);
    setLocalWorkdirMode('local');
  }, [initialLocalProject]);
  useEffect(() => setPageTitleValue(pageTitle), [pageTitle]);
  useEffect(() => setPrompt(promptDraft), [promptDraft]);

  const currentLocalProjects = localProjectOptions.filter(
    (project) => project.machineId === machineId
  );
  const selectedLocalProject = currentLocalProjects.find(
    (project) => project.localProjectId === selectedLocalProjectId
  );
  const selectedLocalProjectHasGit = selectedLocalProject?.localProjectId === LOCAL_GIT_PROJECT_ID;
  const visibleLocalWorkdirMode = selectedLocalProjectHasGit ? localWorkdirMode : 'local';
  const selectedAgentConfig = agentConfigs.find((agent) => agent.id === agentSelection.agentId);
  const modelOptions = selectedAgentConfig?.agentType === 'claude' ? claudeModels : codexModels;
  const projectSelection = useMemo<UnifiedProjectSelection>(() => {
    if (hasSelectedProject && selectedLocalProject) {
      return {
        kind: 'local',
        machineId: selectedLocalProject.machineId,
        localProjectId: selectedLocalProject.localProjectId,
      };
    }
    return { kind: 'none' };
  }, [hasSelectedProject, selectedLocalProject]);
  const showBranchSelector = Boolean(
    hasSelectedProject && selectedLocalProjectHasGit && visibleLocalWorkdirMode === 'worktree'
  );

  useEffect(() => {
    if (!modelOptions.some((option) => option.value === selectedModelId)) {
      setSelectedModelId(modelOptions[0]?.value ?? null);
    }
  }, [modelOptions, selectedModelId]);
  useEffect(() => {
    if (!selectedLocalProjectHasGit) setLocalWorkdirMode('local');
  }, [selectedLocalProjectHasGit]);

  const handleMachineChange = (nextMachineId: MachineId) => {
    setHasSelectedProject(true);
    setMachineId(nextMachineId);
    const nextLocalProject = localProjectOptions.find(
      (project) => project.machineId === nextMachineId
    );
    if (nextLocalProject) setSelectedLocalProjectId(nextLocalProject.localProjectId);
    const nextAgent = agentConfigs.find((agent) => agent.machineId === nextMachineId);
    if (nextAgent) setAgentSelection({ machineId: nextMachineId, agentId: nextAgent.id });
    setLocalWorkdirMode('local');
  };

  const handleProjectChange = (selection: UnifiedProjectSelection) => {
    if (selection.kind === 'none') {
      setHasSelectedProject(false);
      setLocalWorkdirMode('local');
      return;
    }
    if (selection.kind !== 'local') return;
    setHasSelectedProject(true);
    setMachineId(selection.machineId);
    setSelectedLocalProjectId(selection.localProjectId);
    setLocalWorkdirMode('local');
  };

  const topSelector = (
    <div className="flex w-full min-w-0 items-center gap-2">
      <DesktopMachineMenu
        value={machineId}
        visibleLocalMachineId={STORY_MACHINE_ID}
        selectedLabel={machineOptions.find((option) => option.value === machineId)?.label}
        options={machineOptions}
        onChange={handleMachineChange}
        onAddMachine={action}
      />
      <UnifiedProjectSelectorView
        value={projectSelection}
        onChange={handleProjectChange}
        localProjects={currentLocalProjects}
        repositories={[]}
        onAddLocalProject={action}
        onConnectGitRepo={action}
        renderLimit={20}
      />
      {showBranchSelector || (hasSelectedProject && selectedLocalProject) ? (
        <div {...stylex.props(composerSurface.contextPill)}>
          {showBranchSelector ? (
            <BranchSelector
              value={localBranch}
              onChange={setLocalBranch}
              options={localBranches}
              tone={composerTone}
              placeholder="Branch"
              searchPlaceholder="Search branches"
              emptyText="No branches found"
            />
          ) : null}
          {showBranchSelector ? (
            <span aria-hidden="true" {...stylex.props(composerSurface.contextPillDivider)} />
          ) : null}
          <WorktreeCheckboxPill
            checked={visibleLocalWorkdirMode === 'worktree'}
            onCheckedChange={(checked) => setLocalWorkdirMode(checked ? 'worktree' : 'local')}
            disabled={!selectedLocalProjectHasGit}
            disabledReason={
              selectedLocalProjectHasGit ? undefined : 'This local project is not a git repository.'
            }
            surface="context"
          />
        </div>
      ) : null}
    </div>
  );

  const footerSelector = (
    <div className="contents">
      <DesktopRunConfigMenu
        agentSelection={agentSelection}
        allowedMachineIds={[machineId]}
        availableAgentConfigs={agentConfigs}
        onAgentConfigChange={setAgentSelection}
        modelOptions={modelOptions}
        selectedModelId={selectedModelId}
        onModelChange={setSelectedModelId}
        modeOptions={permissionModes}
        selectedModeId={selectedModeId}
        configOptionSelectors={runConfigSelectors}
        configOptionValues={configOptionValues}
        onConfigOptionChange={(configId, value) =>
          setConfigOptionValues((previous) => ({ ...previous, [configId]: value }))
        }
      />
      <DesktopPermissionModeButton
        modeOptions={permissionModes}
        selectedModeId={selectedModeId}
        onModeChange={setSelectedModeId}
        configOptionSelectors={runConfigSelectors}
        configOptionValues={configOptionValues}
        onConfigOptionChange={(configId, value) =>
          setConfigOptionValues((previous) => ({ ...previous, [configId]: value }))
        }
      />
    </div>
  );

  const ambient: ReactNode = !showActivityOverview ? undefined : (
    <HomeDashboard
      board={homeBoard}
      onBoardChange={setHomeBoard}
      now={homeNowFixture(weekScenario === 'busy' ? (agentsRunning ? 'busy' : 'idle') : 'quiet')}
      week={homeWeekFixture(weekScenario)}
      agentLabel={homeWeekAgentLabel}
      agentIcon={homeWeekAgentIcon}
      usage={
        showPlanUsage ? homeWeekUsageFixture(showCodexForecast ? 'nearReset' : 'steady') : null
      }
      usageSources={showPlanUsage ? HOME_WEEK_USAGE_SOURCES : []}
      usageSourceId={showPlanUsage ? HOME_WEEK_USAGE_SOURCES[0]!.id : null}
      forecast={
        showPlanUsage && showCodexForecast
          ? { title: 'Codex reset forecast', chancePercent: 65, when: 'Today 2:00 PM' }
          : undefined
      }
      nowMs={HOME_WEEK_NOW.getTime()}
      animate={false}
    />
  );

  return (
    <ChatLandingView
      tone={composerTone}
      title={pageTitleValue}
      ambient={ambient}
      promptValue={prompt}
      onPromptChange={setPrompt}
      promptPlaceholder="Describe what you want to build or change."
      topSelector={topSelector}
      footerSelector={footerSelector}
      onSubmit={action}
    />
  );
}

function WorkspaceHomePlayground(props: WorkspaceHomePlaygroundProps) {
  const store = useMemo(createStoryStore, []);
  const localProjectSessionsByKey = useMemo(
    () => ({
      [`${STORY_MACHINE_ID}:${PERSONAL_TOOLS_PROJECT_ID}`]:
        props.sidebarLocalSessionMode === 'plain'
          ? [...localSidebarSessionModes.plain]
          : props.sidebarLocalSessionMode === 'repo-no-worktree'
            ? [...localSidebarSessionModes['repo-no-worktree']]
            : [],
      [`${STORY_MACHINE_ID}:${LOCAL_GIT_PROJECT_ID}`]:
        props.sidebarLocalSessionMode === 'worktree' ? [...localSidebarSessionModes.worktree] : [],
    }),
    [props.sidebarLocalSessionMode]
  );

  return (
    <PlatformContext.Provider value={storyPlatform}>
      <Provider store={store}>
        <WorkspaceSidebarHarness
          {...SidebarDefault.args!}
          activeNav="home"
          sessionListProps={{
            ...SidebarDefault.args!.sessionListProps!,
            // The landing has no selected conversation, but keeps the workspace's GitHub
            // worktree and ordinary chat fixtures in the sidebar.
            selectedSessionId: null,
          }}
          storyContent={<WorkspaceLandingHarness {...props} />}
          fullApp
          localProjectGroups={sidebarLocalProjectGroups}
          localProjectSessionsByKey={localProjectSessionsByKey}
          expandLocalProjects
        />
      </Provider>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Product/Workspace',
  component: WorkspaceHomePlayground,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'A desktop workspace assembled from production sidebar rows, the workspace card, new-chat landing and composer controls. Local folders belong to machine groups; the sidebar also includes GitHub worktree fixtures, and its session-row control covers plain, repo-linked direct, and worktree sessions.',
      },
    },
  },
  tags: ['autodocs'],
  argTypes: {
    initialLocalProject: {
      name: 'Initial local machine project',
      control: 'select',
      options: ['personal-tools', 'design-system-lab'],
    },
    sidebarLocalSessionMode: {
      name: 'Local project session row',
      control: 'inline-radio',
      options: ['plain', 'repo-no-worktree', 'worktree'],
    },
    composerTone: {
      name: 'Composer tone',
      control: 'inline-radio',
      options: ['light', 'dark'],
    },
    pageTitle: { name: 'Landing title', control: 'text' },
    promptDraft: { name: 'Initial prompt', control: 'text' },
    weekScenario: {
      name: 'Weekly activity data',
      control: 'select',
      options: ['busy', 'quiet', 'new'],
    },
    showActivityOverview: { name: 'Show weekly overview', control: 'boolean' },
    agentsRunning: { name: 'Agents running', control: 'boolean' },
    showPlanUsage: { name: 'Show subscription usage', control: 'boolean' },
    showCodexForecast: { name: 'Show Codex reset tile', control: 'boolean' },
  },
  args: {
    initialLocalProject: 'personal-tools',
    sidebarLocalSessionMode: 'plain',
    composerTone: 'light',
    pageTitle: "Let's ship something",
    promptDraft: 'Review the local script runner on this machine.',
    weekScenario: 'busy',
    agentsRunning: true,
    showActivityOverview: true,
    showPlanUsage: true,
    showCodexForecast: true,
  },
} satisfies Meta<typeof WorkspaceHomePlayground>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Full desktop workspace for UI tuning: the real machine/project/workdir selectors,
 * a plain local folder with no Git association or worktree, the production run-config
 * controls, and machine-grouped project rows. The sidebar session control also shows a
 * repo-linked direct session and a worktree session to compare their row heights.
 */
export const FullWorkspaceWorkbench: Story = {};
