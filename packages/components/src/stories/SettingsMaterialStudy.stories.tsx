import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { composeStories } from '@storybook/react';

import * as AccountSettingsStories from './AccountSettings.stories';
import * as AccountMachinesOverviewStories from './AccountMachinesOverview.stories';
import * as AgentRoleFormStories from './AgentRoleForm.stories';
import * as GeneralSettingsStories from './GeneralSettings.stories';
const storyLayout = stylex.create({
  grid: {
    display: 'grid',
    'grid-template-columns': 'minmax(0,1fr) minmax(0,1.25fr)',
    gap: 'calc(var(--spacing) * 8)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 8)',
  },
  stack: {
    display: 'flex',
    'min-width': 'calc(var(--spacing) * 0)',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 6)',
  },
});

const { OwnerView } = composeStories(AccountSettingsStories);
const { Default: MachinesOverview } = composeStories(AccountMachinesOverviewStories);
const { Configured: RoleForm } = composeStories(AgentRoleFormStories);
const { Desktop: General } = composeStories(GeneralSettingsStories);

/**
 * Real settings surfaces, side by side, inside the `data-settings-surface` scope the
 * desktop settings pane puts them in — which is what turns their cards white. A
 * standalone settings story renders outside that scope and shows gray cards the app
 * never draws, so the container language is judged here rather than there.
 */
function SettingsMaterialStudy() {
  return (
    <div data-settings-surface="" {...stylex.props(storyLayout.grid)}>
      <div {...stylex.props(storyLayout.stack)}>
        <General />
        <OwnerView />
      </div>
      <div {...stylex.props(storyLayout.stack)}>
        <MachinesOverview />
        <RoleForm />
      </div>
    </div>
  );
}

const meta = {
  title: 'Design System/Settings Material Study',
  component: SettingsMaterialStudy,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SettingsMaterialStudy>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};
