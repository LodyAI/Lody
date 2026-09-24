import type { Meta, StoryObj } from '@storybook/react';
import { composeStories } from '@storybook/react';

import * as AccountSettingsStories from './AccountSettings.stories';
import * as AccountMachinesOverviewStories from './AccountMachinesOverview.stories';
import * as AgentRoleFormStories from './AgentRoleForm.stories';
import * as GeneralSettingsStories from './GeneralSettings.stories';

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
    <div
      data-settings-surface=""
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-8 bg-background p-8"
    >
      <div className="flex min-w-0 flex-col gap-6">
        <General />
        <OwnerView />
      </div>
      <div className="flex min-w-0 flex-col gap-6">
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
