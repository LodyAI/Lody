import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { fn } from 'storybook/test';

import type { FilterPill } from '@/components/mobile/mobile-filter-pill-bar';
import { StuckConnectionBanner } from '@/components/stuck-connection-banner';
import {
  MobileHomeScreen,
  type MobileConversationItem,
  type MobileHomeGitHubRepository,
  type MobileHomeLocalProject,
  type MobileHomeMachine,
  type MobileHomeTab,
  type MobileInboxItem,
  type MobileProjectsSubTab,
} from '@/components/mobile/mobile-home-screen';

const meta = {
  title: 'Mobile/MobileHomeScreen',
  component: MobileHomeScreen,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof MobileHomeScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const hour = 60 * 60 * 1000;
const now = Date.now();

const machines: MobileHomeMachine[] = [
  { id: 'zx-macbook', name: 'zx-macbook', isOnline: true },
  { id: 'lab-m2', name: 'lab-m2', isOnline: true },
  { id: 'mini-offline', name: 'mini-offline', isOnline: false },
];

const localProjects: MobileHomeLocalProject[] = [
  {
    id: 'zx-macbook:lody',
    machineId: 'zx-macbook',
    name: 'lody',
    path: '~/code/lody',
    conversationCount: 18,
    latestMessageAt: now - 0.5 * hour,
    unreadCount: 3,
  },
  {
    id: 'zx-macbook:loro',
    machineId: 'zx-macbook',
    name: 'loro',
    path: '~/code/loro',
    conversationCount: 2,
    latestMessageAt: now - 26 * hour,
  },
  {
    id: 'lab-m2:lody-mobile',
    machineId: 'lab-m2',
    name: 'lody-mobile',
    path: '~/work/lody-mobile',
    conversationCount: 7,
    latestMessageAt: now - 3 * hour,
    unreadCount: 1,
  },
];

const githubRepositories: MobileHomeGitHubRepository[] = [
  {
    id: 'loro-dev/lody',
    name: 'lody',
    fullName: 'loro-dev/lody',
    ownerHandle: 'loro-dev',
    ownerAvatarUrl: 'https://avatars.githubusercontent.com/loro-dev?size=80',
    description: 'AI-native local-first coding companion for terminals and editors',
    latestMessageAt: now - 1 * hour,
    unreadCount: 2,
  },
  {
    id: 'loro-dev/loro',
    name: 'loro',
    fullName: 'loro-dev/loro',
    ownerHandle: 'loro-dev',
    ownerAvatarUrl: 'https://avatars.githubusercontent.com/loro-dev?size=80',
    description: 'High-performance CRDT framework for local-first apps',
    latestMessageAt: now - 5 * hour,
  },
  {
    id: 'Leeeon233/mobile-shell-notes',
    name: 'mobile-shell-notes',
    fullName: 'Leeeon233/mobile-shell-notes',
    ownerHandle: 'Leeeon233',
    ownerAvatarUrl: 'https://avatars.githubusercontent.com/Leeeon233?size=80',
    latestMessageAt: now - 24 * hour,
  },
];

const chats: MobileConversationItem[] = [
  {
    id: 'session-1',
    title: '移动端主页 Konsta 重构',
    latestMessageAt: now - 0.2 * hour,
    ageLabel: '12m',
    branchName: 'feat/mobile-home',
    prNumber: 2061,
    prStatus: 'open',
    prUrl: 'https://github.com/loro-dev/lody/pull/2061',
    prCiState: 'f',
    addedLines: 234,
    deletedLines: 56,
    isWorking: true,
    machineId: 'zx-macbook',
  },
  {
    id: 'session-2',
    title: 'GitHub 授权仓库列表',
    latestMessageAt: now - 4 * hour,
    ageLabel: '4h',
    branchName: 'feat/github-list',
    addedLines: 47,
    deletedLines: 12,
    hasUnreadMessages: true,
    machineId: 'zx-macbook',
  },
  {
    id: 'session-3',
    title: 'Chat list accessibility',
    latestMessageAt: now - 18 * hour,
    ageLabel: '18h',
    machineId: 'zx-macbook',
  },
  {
    id: 'session-l1',
    title: 'iOS keyboard safe-area 验证',
    latestMessageAt: now - 50 * hour,
    ageLabel: '2d',
    branchName: 'fix/keyboard-safe-area',
    machineId: 'lab-m2',
  },
];

const inboxItems: MobileInboxItem[] = [
  {
    id: 'sharing-review',
    kind: 'sharing_review',
    title: 'Review what your team can see',
    description: '2 private machine or project resources are only visible to you.',
    updatedAt: now,
    unread: true,
    actionLabel: 'Review projects',
  },
  {
    id: 'permission-request',
    kind: 'permission_requested',
    title: '移动端主页 Konsta 重构',
    description: 'Approval needed: Run tests',
    updatedAt: now - hour,
    unread: true,
    actionLabel: 'Open conversation',
  },
  {
    id: 'session-complete',
    kind: 'session_completed',
    title: 'GitHub 授权仓库列表',
    description: 'Session completed.',
    updatedAt: now - 4 * hour,
    actionLabel: 'Open conversation',
  },
];

/* Filter pills + archive toggle so CrowdedHeaderStatus / filter-after-search
   can render the densest chrome (filter is after search; header trailing is
   archive + settings). */
const chatFilterPills: FilterPill[] = [
  {
    kind: 'single',
    id: 'status',
    fallbackLabel: '状态',
    options: [
      { id: 'all', label: '全部' },
      { id: 'running', label: '运行中' },
    ],
    selectedId: 'all',
    onSelect: fn(),
  },
];

function MobileHomeScreenStory({
  theme,
  connectionUiState = 'online',
  workspaceName = 'Lody',
  connectionBannerLabels,
  crowdedHeader = false,
  machines: machinesProp = machines,
  chats: chatsProp = chats,
  localProjects: localProjectsProp = localProjects,
  githubRepositories: githubRepositoriesProp = githubRepositories,
  initialTab = 'chat',
  showInboxTab = false,
  inboxItems: inboxItemsProp = [],
}: {
  theme: 'ios' | 'material';
  connectionUiState?: 'online' | 'loading' | 'offline' | 'reconnecting';
  workspaceName?: string;
  /** Override the status-pill copy — longer labels stress the header's
     true-center overlay against the trailing glass discs. */
  connectionBannerLabels?: {
    loading?: string;
    reconnecting?: string;
    offline?: string;
    recovered?: string;
  };
  /** Mount archive toggle + filter-after-search + settings. */
  crowdedHeader?: boolean;
  machines?: MobileHomeMachine[];
  chats?: MobileConversationItem[];
  localProjects?: MobileHomeLocalProject[];
  githubRepositories?: MobileHomeGitHubRepository[];
  initialTab?: MobileHomeTab;
  showInboxTab?: boolean;
  inboxItems?: MobileInboxItem[];
}) {
  const [selectedTab, setSelectedTab] = useState<MobileHomeTab>(initialTab);
  const [selectedProjectsSubTab, setSelectedProjectsSubTab] =
    useState<MobileProjectsSubTab>('local');

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <MobileHomeScreen
          theme={theme}
          workspace={{ id: 'lody', name: workspaceName }}
          workspaceOptions={[
            { id: 'lody', name: workspaceName, isActive: true },
            { id: 'loro-dev', name: 'loro-dev' },
            { id: 'personal', name: 'Personal' },
          ]}
          machines={machinesProp}
          showInboxTab={showInboxTab}
          inboxItems={inboxItemsProp}
          onInboxItemSelect={fn()}
          onInboxItemDismiss={fn()}
          connectionUiState={connectionUiState}
          selectedTab={selectedTab}
          selectedProjectsSubTab={selectedProjectsSubTab}
          onProjectsSubTabSelect={setSelectedProjectsSubTab}
          localProjects={localProjectsProp}
          githubRepositories={githubRepositoriesProp}
          chats={chatsProp}
          chatFilterPills={crowdedHeader ? chatFilterPills : undefined}
          onShowArchivedToggle={crowdedHeader ? fn() : undefined}
          labels={{
            switchWorkspace: '切换 workspace',
            connectionBanner: {
              loading: '连接中…',
              reconnecting: '正在重连…',
              offline: '离线',
              recovered: '已连接',
              ...connectionBannerLabels,
            },
            inboxTab: 'Inbox',
            inboxPlaceholder: '没有新通知',
            privateLabel: '私密',
            privateHelpAriaLabel: '了解私密资源',
            privateHelpTitle: '私密资源仅你可见',
            privateHelpDescription:
              '私密机器、本地项目及其中的对话不会向队友显示。你可以在设备设置中共享机器，或在项目设置中共享项目。',
            privateHelpClose: '知道了',
            projectsTab: '项目',
            localTab: '本地',
            githubTab: 'GitHub',
            chatTab: 'Chat',
            settingsTab: '设置',
            newChatAriaLabel: '新建对话',
            recentProjectsHeading: '最近常用',
            allLocalProjectsHeading: '全部项目',
            allGitHubReposHeading: '全部仓库',
            allChatsHeading: '全部对话',
            emptyLocalProjects: '当前 workspace 没有已加入的本地项目',
            emptyGitHubProjects: '当前 workspace 没有已授权的 GitHub 仓库',
            emptyChats: '当前 workspace 还没有对话',
            emptySearch: '没有匹配的结果',
            onboarding: {
              title: 'Lody runs on your computer',
              description: 'Download the desktop app to get started.',
              downloadButton: 'Download Lody',
            },
          }}
          onWorkspaceSelect={fn()}
          onTabSelect={setSelectedTab}
          onLocalProjectSelect={fn()}
          onGitHubRepositorySelect={fn()}
          onChatSelect={fn()}
          onSettingsOpen={fn()}
          onNewChat={fn()}
          onDownloadClient={fn()}
        />
      </div>
    </div>
  );
}

export const IOS: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'chat',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => <MobileHomeScreenStory theme="ios" />,
};

export const Material: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'chat',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => <MobileHomeScreenStory theme="material" />,
};

export const TeamInboxAndPrivateResources: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'inbox',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => (
    <MobileHomeScreenStory
      theme="ios"
      initialTab="inbox"
      showInboxTab
      inboxItems={inboxItems}
      machines={machines.map((machine, index) => ({
        ...machine,
        isPrivate: index === 0,
      }))}
      localProjects={localProjects.map((project, index) => ({
        ...project,
        isPrivate: index === 0,
      }))}
    />
  ),
};

export const TeamPrivateProjects: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'projects',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => (
    <MobileHomeScreenStory
      theme="ios"
      initialTab="projects"
      showInboxTab
      machines={machines.map((machine, index) => ({
        ...machine,
        isPrivate: index === 0,
      }))}
      localProjects={localProjects.map((project, index) => ({
        ...project,
        isPrivate: index < 2,
      }))}
    />
  ),
};

export const TeamPrivateConversationGroups: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'chat',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => (
    <MobileHomeScreenStory
      theme="ios"
      chats={chats.map((chat, index) => ({
        ...chat,
        kind: 'local',
        projectKey: index < 3 ? 'zx-macbook:lody' : 'lab-m2:lody-mobile',
        projectLabel: index < 3 ? 'lody' : 'lody-mobile',
        isPrivateProject: index < 3,
      }))}
    />
  ),
};

export const TeamTaskOwners: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'chat',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => (
    <MobileHomeScreenStory
      theme="ios"
      chats={chats.map((chat, index) => ({
        ...chat,
        owner: {
          id: `team-member-${index}`,
          name: ['Ada Lovelace', 'Grace Hopper', 'Margaret Hamilton'][index % 3],
        },
      }))}
    />
  ),
};

/* The stuck-connection recovery hint layered over the home screen, exactly as
   `MainLayout` mounts it after 45s of continuous `loading`. The banner is
   fixed-positioned to the viewport, so view this story at a phone-sized
   viewport for a faithful composition. */
export const StuckConnectionHint: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'chat',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => (
    <>
      <MobileHomeScreenStory theme="ios" connectionUiState="loading" />
      <StuckConnectionBanner
        labels={{
          title: '连接时间较长',
          description: '通常是本地缓存异常导致',
          clearCache: '清空缓存',
          dismissAriaLabel: '关闭',
        }}
        onClearCache={fn()}
        onDismiss={fn()}
      />
    </>
  ),
};

export const Reconnecting: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'chat',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => <MobileHomeScreenStory theme="ios" connectionUiState="reconnecting" />,
};

export const Offline: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'chat',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => <MobileHomeScreenStory theme="ios" connectionUiState="offline" />,
};

/* Regression guard for the densest home chrome: filter after search,
   archive + settings in the header, and a wide reconnecting label on
   the true-center status pill (pointer-events-none so it can't steal
   taps from the trailing discs). */
export const CrowdedHeaderStatus: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'chat',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => (
    <MobileHomeScreenStory
      theme="ios"
      crowdedHeader
      connectionUiState="reconnecting"
      connectionBannerLabels={{ reconnecting: 'Reconnecting…' }}
    />
  ),
};

/* A long workspace name no longer reaches the header (the switcher is
   icon-only), but it still flows into the switcher sheet and aria label —
   keep the case rendered. */
export const LongWorkspaceName: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'chat',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => (
    <MobileHomeScreenStory
      theme="ios"
      connectionUiState="reconnecting"
      workspaceName="loro-dev-internal-tools"
    />
  ),
};

/* End-to-end recovery flow, scripted for visual QA:
   reconnecting (1.2s) → online → header status shows the green ✓ for
   1.2s → fades back to empty. Lets the cross-fade between states play
   out in the header's inline status slot in a single story. */
function ReconnectingRecoveryDemo({ theme }: { theme: 'ios' | 'material' }) {
  const [state, setState] = useState<'reconnecting' | 'online'>('reconnecting');
  useEffect(() => {
    const id = window.setTimeout(() => setState('online'), 1800);
    return () => window.clearTimeout(id);
  }, []);
  return <MobileHomeScreenStory theme={theme} connectionUiState={state} />;
}

export const ReconnectingRecovery: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines,
    selectedTab: 'chat',
    localProjects,
    githubRepositories,
    chats,
  },
  render: () => <ReconnectingRecoveryDemo theme="ios" />,
};

/* First-run state: the user installed the mobile app before ever starting
   the desktop client, so the workspace has no machines and no
   conversations. The Chat tab then guides them to download + launch Lody
   on their computer instead of showing a bare "no conversations" line. */
export const FirstRunOnboarding: Story = {
  args: {
    workspace: { id: 'lody', name: 'Lody' },
    machines: [],
    selectedTab: 'chat',
    localProjects: [],
    githubRepositories: [],
    chats: [],
  },
  render: () => (
    <MobileHomeScreenStory
      theme="ios"
      machines={[]}
      chats={[]}
      localProjects={[]}
      githubRepositories={[]}
    />
  ),
};
