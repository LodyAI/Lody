import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { LoroSidebar, type LoroSidebarNavKey } from '../components/loro-sidebar';
import { SettingsStoryProviders } from './settings-story-shell';

const meta = {
  title: 'Components/OwnedWorkspaceShellMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const variables = {
  '--spacing': '0.3125rem',
  '--font-weight-medium': '650',
  '--sidebar-foreground': '272 35% 40%',
} as CSSProperties;
const workspaces = [
  {
    id: 'synthetic-one',
    name: 'Synthetic Workspace With A Long Name 中文边界',
    planTier: 'plus' as const,
  },
  { id: 'synthetic-two', name: 'Second Synthetic Workspace', planTier: 'enterprise' as const },
];

function RootVariables({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = Object.keys(variables).map((name) => [
      name,
      root.style.getPropertyValue(name),
    ]);
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
    return () => {
      for (const [name, value] of previous) {
        if (value) root.style.setProperty(name, value);
        else root.style.removeProperty(name);
      }
    };
  }, []);
  return children;
}

function Fixture({
  empty = false,
  staticIdentity = false,
  scoped = false,
}: {
  empty?: boolean;
  staticIdentity?: boolean;
  scoped?: boolean;
}) {
  const [store] = useState(createStore);
  const [activeNav, setActiveNav] = useState<LoroSidebarNavKey>('home');
  const [workspace, setWorkspace] = useState('synthetic-one');
  const [event, setEvent] = useState('Ready');
  const [collapsed, setCollapsed] = useState(false);
  const [scope, setScope] = useState<'my' | 'team'>('my');
  const [width, setWidth] = useState(300);
  const record = (value: string) => setEvent(value);
  return (
    <Provider store={store}>
      <SettingsStoryProviders>
        <div data-workspace-shell-fixture style={{ height: '100vh' }}>
          <div
            data-workspace-shell-surface
            style={{ height: 'calc(100vh - 74px)', ...(scoped ? variables : {}) }}
          >
            <LoroSidebar
              className="outline-offset-4"
              workspaceName={workspaces.find((item) => item.id === workspace)!.name}
              userEmail="synthetic.long.account.address@example.invalid"
              workspaces={workspaces}
              currentWorkspaceId={workspace}
              workspaceSwitcherEnabled={!staticIdentity}
              connectionUiState={staticIdentity ? 'offline' : 'online'}
              defaultWidth={300}
              activeNav={activeNav}
              repoSections={[]}
              sessionListProps={empty ? { sessions: [], repos: [] } : undefined}
              chats={[]}
              chatScope={scope}
              topContent={
                empty ? undefined : <p style={{ padding: 12 }}>Synthetic sidebar content</p>
              }
              collapsed={collapsed}
              onWidthChange={(next) => {
                setWidth(next);
                record(`Width ${next}`);
              }}
              onRequestCollapse={() => {
                setCollapsed(true);
                record('Collapsed');
              }}
              onChatScopeChange={(next) => {
                setScope(next);
                record(`Scope ${next}`);
              }}
              onWorkspaceSelected={(next) => {
                setWorkspace(next);
                record(`Workspace ${next}`);
              }}
              onHomeClicked={() => {
                setActiveNav('home');
                record('Home');
              }}
              onArchiveClicked={() => {
                setActiveNav('archive');
                record('Archive');
              }}
              onSchedulesClicked={() => {
                setActiveNav('schedules');
                record('Schedules');
              }}
              onSettingsClicked={() => record('Settings')}
              onDocsClicked={() => record('Docs')}
              onGithubClicked={() => record('GitHub')}
              onJoinCommunityClicked={() => record('Community')}
              onFeedbackClicked={() => record('Feedback')}
              onBugReportClicked={() => record('Bug')}
              onCreateWorkspaceClicked={() => record('Create workspace')}
              onInviteClicked={() => record('Invite members')}
              onLinkRepoClicked={() => record('Connect repository')}
            />
          </div>
          <div data-workspace-shell-controls style={{ padding: 8, fontSize: 12 }}>
            <button
              type="button"
              onClick={() => {
                setCollapsed(false);
                record('Restored');
              }}
            >
              Restore sidebar
            </button>
            <output
              data-workspace-shell-result
              data-collapsed={collapsed}
              data-width={width}
              data-workspace={workspace}
              data-nav={activeNav}
              data-scope={scope}
            >
              {event}
            </output>
          </div>
        </div>
      </SettingsStoryProviders>
    </Provider>
  );
}

export const Default: Story = { render: () => <Fixture /> };
export const Empty: Story = { render: () => <Fixture empty /> };
export const StaticIdentity: Story = { render: () => <Fixture staticIdentity /> };
export const RootVariableScope: Story = {
  render: () => (
    <RootVariables>
      <Fixture />
    </RootVariables>
  ),
};
export const SubtreeVariableScope: Story = { render: () => <Fixture scoped /> };
