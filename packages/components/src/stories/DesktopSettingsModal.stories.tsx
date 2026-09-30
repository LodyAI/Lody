import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { Provider } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { settingsActiveTabAtom, settingsDialogOpenAtom } from '@/atoms';
import type { SettingsTabId } from '@/components/settings/settings-tabs';
import { DesktopSettingsModal } from '@/components/settings/desktop-settings-modal';
import { RoutedStory, SettingsStoryProviders } from './settings-story-shell';

/**
 * Desktop settings modal — the overlay that replaces the full-page settings route on
 * non-mobile viewports. These stories open it at low-dependency tabs (General / About);
 * runtime-heavy tabs (Account, Stats, Agent config, GitHub) need a live workspace
 * runtime and are exercised in the app rather than here.
 */
function OpenModalAt({ tab, children }: { tab: SettingsTabId; children: ReactNode }) {
  useHydrateAtoms([
    [settingsDialogOpenAtom, true],
    [settingsActiveTabAtom, tab],
  ]);
  return <>{children}</>;
}

function SettingsModalStory({ tab }: { tab: SettingsTabId }) {
  return (
    <SettingsStoryProviders capabilities={['cloudAccount']}>
      <RoutedStory>
        <Provider>
          <OpenModalAt tab={tab}>
            <DesktopSettingsModal />
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

export const DarkModePreferencesTab: Story = {
  render: () => (
    <div className="dark">
      <SettingsModalStory tab="preferences" />
    </div>
  ),
};
