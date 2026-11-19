import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { Provider } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { settingsActiveTabAtom, settingsDialogOpenAtom, userAtom } from '@/atoms';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { AGENT_ROLE_VERSION, workspaceFlockKeys, type AgentRole } from '@lody/shared';
import { developerModeEnabledAtom, lodyAgentBetaEnabledAtom } from '@/atoms/settings';
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
const rolesStoryRuntime = {
  workspaceId: 'settings-story-workspace',
  workspaceSlug: 'lody',
  repo: {
    openFlockDoc: async () => ({
      flock: {
        scan: (options?: { prefix?: readonly unknown[] }) =>
          options?.prefix?.[0] === 'agentRole'
            ? [{ key: workspaceFlockKeys.agentRole(storyRole.id), value: storyRole }]
            : [],
        subscribe: () => () => {},
      },
      joinRoom: async () => ({ unsubscribe: () => {}, firstSyncedWithRemote: Promise.resolve() }),
    }),
  },
} as unknown as WorkspaceRuntime;

function RolesCatalogFixture({ children }: { children: ReactNode }) {
  useHydrateAtoms([
    [runtimeAtom, rolesStoryRuntime],
    [userAtom, { id: storyRole.ownerUserId, name: 'Example user', email: 'user@example.com' }],
  ]);
  return <>{children}</>;
}

/** The Lody Agent page only exists while the Lody Agent feature is on. */
function LodyAgentEnabled({ children }: { children: ReactNode }) {
  useHydrateAtoms([
    [developerModeEnabledAtom, true],
    [lodyAgentBetaEnabledAtom, true],
  ]);
  return <>{children}</>;
}

function SettingsModalStory({ tab }: { tab: SettingsTabId }) {
  return (
    <SettingsStoryProviders capabilities={['cloudAccount']}>
      <RoutedStory>
        <Provider>
          <OpenModalAt tab={tab}>
            {tab === 'agent-roles' ? (
              <RolesCatalogFixture>
                <DesktopSettingsModal />
              </RolesCatalogFixture>
            ) : tab === 'lody-agent' ? (
              <LodyAgentEnabled>
                <DesktopSettingsModal />
              </LodyAgentEnabled>
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

/** An empty catalog: the list's own card with one quiet line. */
export const McpEmptyTab: Story = {
  render: () => <SettingsModalStory tab="mcp" />,
};

export const AgentRolesTab: Story = {
  render: () => <SettingsModalStory tab="agent-roles" />,
};

/** Settings → Lody Agent, drawn with the sheet's own hand-made controls. */
export const LodyAgentTab: Story = {
  render: () => <SettingsModalStory tab="lody-agent" />,
};

export const DarkModePreferencesTab: Story = {
  render: () => (
    <div className="dark">
      <SettingsModalStory tab="preferences" />
    </div>
  ),
};
