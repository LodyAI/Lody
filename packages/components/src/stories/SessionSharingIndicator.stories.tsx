import type { Meta, StoryObj } from '@storybook/react';
import type { LocalProjectId, MachineId } from '@lody/shared';
import { SessionSharingIndicator } from '@/components/session-sharing';
import { Tooltip } from '@lody/ui/tooltip';

const meta = {
  title: 'Sessions/SessionSharingIndicator',
  component: SessionSharingIndicator,
  decorators: [
    (Story) => (
      <Tooltip.Provider>
        <div className="w-64 rounded-lg bg-sidebar p-4 text-sidebar-foreground">
          <div className="flex items-center gap-2 rounded-md px-2 py-1 text-sm">
            <span className="min-w-0 flex-1 truncate">Fix team sharing</span>
            <Story />
          </div>
        </div>
      </Tooltip.Provider>
    ),
  ],
  args: {
    state: {
      visibility: 'private',
      privateReason: 'machine-and-project',
      canManage: true,
      machineId: 'machine-story' as MachineId,
      localProjectId: 'project-story' as LocalProjectId,
      machineName: 'Studio Mac',
      projectName: 'lody',
    },
  },
} satisfies Meta<typeof SessionSharingIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Private: Story = {};

export const TeamHidden: Story = {
  args: {
    state: {
      visibility: 'team',
      canManage: true,
      machineId: 'machine-story' as MachineId,
      localProjectId: null,
      machineName: 'Studio Mac',
      projectName: null,
    },
  },
};
