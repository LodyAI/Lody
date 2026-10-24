import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { Provider } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { settingsActiveTabAtom, settingsDialogOpenAtom, userAtom } from '@/atoms';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { AGENT_ROLE_VERSION, workspaceFlockKeys, type AgentRole } from '@lody/shared';
import type { SettingsTabId } from '@/components/settings/settings-tabs';
import { DesktopSettingsModal } from '@/components/settings/desktop-settings-modal';
import { RoutedStory, SettingsStoryProviders } from './settings-story-shell';

/**
 * Desktop settings modal — the overlay that replaces the full-page settings route on
 * non-mobile viewports. These stories open it at low-dependency tabs (General / About);
 * Agent Roles uses a read-only catalog fixture; runtime-heavy tabs (Account, Stats,
 * Agent config, GitHub) need a live workspace and are exercised in the app.
 */
function OpenModalAt({ tab, children }: { tab: SettingsTabId; children: ReactNode }) {
  useHydrateAtoms([
    [settingsDialogOpenAtom, true],
    [settingsActiveTabAtom, tab],
  ]);
  return <>{children}</>;
}

const storyRole: AgentRole = {
  v: AGENT_ROLE_VERSION,
  id: 'settings-story-role' as AgentRole['id'],
  ownerUserId: 'settings-story-user',
  visibility: 'private',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId: 'settings-story-machine' as AgentRole['machineId'],
  agentConfigId: 'settings-story-config' as AgentRole['agentConfigId'],
  runConfig: {},
  promptPrefix: 'Check correctness before style.',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

// A read-only catalog fixture: no transport or real workspace writes.
function createCatalogStoryRuntime(roles: readonly AgentRole[]) {
  return {
    workspaceId: 'settings-story-workspace',
    workspaceSlug: 'lody',
    repo: {
      openFlockDoc: async () => ({
        flock: {
          scan: (options?: { prefix?: readonly unknown[] }) =>
            options?.prefix?.[0] === 'agentRole'
              ? roles.map((role) => ({ key: workspaceFlockKeys.agentRole(role.id), value: role }))
              : [],
          subscribe: () => () => {},
        },
        joinRoom: async () => ({ unsubscribe: () => {}, firstSyncedWithRemote: Promise.resolve() }),
      }),
    },
  } as unknown as WorkspaceRuntime;
}

const rolesStoryRuntime = createCatalogStoryRuntime([storyRole]);
const emptyCatalogStoryRuntime = createCatalogStoryRuntime([]);

function RolesCatalogFixture({
  children,
  empty = false,
}: {
  children: ReactNode;
  empty?: boolean;
}) {
  useHydrateAtoms([
    [runtimeAtom, empty ? emptyCatalogStoryRuntime : rolesStoryRuntime],
    [userAtom, { id: storyRole.ownerUserId, name: 'Example user', email: 'user@example.com' }],
  ]);
  return <>{children}</>;
}

function SettingsModalStory({
  tab,
  emptyCatalog = false,
}: {
  tab: SettingsTabId;
  emptyCatalog?: boolean;
}) {
  return (
    <SettingsStoryProviders capabilities={['cloudAccount']}>
      <RoutedStory>
        <Provider>
          <OpenModalAt tab={tab}>
            {tab === 'agent-roles' || emptyCatalog ? (
              <RolesCatalogFixture empty={emptyCatalog}>
                <DesktopSettingsModal />
              </RolesCatalogFixture>
            ) : (
              <DesktopSettingsModal />
            )}
          </OpenModalAt>
        </Provider>
      </RoutedStory>
    </SettingsStoryProviders>
  );
}

const meta = {
  title: 'Settings/DesktopSettingsModal',
  component: DesktopSettingsModal,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof DesktopSettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PreferencesTab: Story = {
  render: () => <SettingsModalStory tab="preferences" />,
};

export const AboutTab: Story = {
  render: () => <SettingsModalStory tab="about" />,
};

/** Unbinding waits for the row: hover or focus a row to see it. Caps read at 12px. */
export const KeyboardShortcutsTab: Story = {
  render: () => <SettingsModalStory tab="keyboard-shortcuts" />,
};

/** An empty, hydrated catalog without a live workspace or personal data. */
export const McpEmptyTab: Story = {
  render: () => <SettingsModalStory tab="mcp" emptyCatalog />,
};

export const AgentRolesTab: Story = {
  render: () => <SettingsModalStory tab="agent-roles" />,
};

export const AgentRolesEmptyTab: Story = {
  render: () => <SettingsModalStory tab="agent-roles" emptyCatalog />,
};

export const DarkModePreferencesTab: Story = {
  render: () => (
    <div className="dark">
      <SettingsModalStory tab="preferences" />
    </div>
  ),
};
