import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import type { LocalProjectId, MachineId } from '@lody/shared';
import { SessionArchivedBadge, SessionSharingIndicator } from '@/components/session-sharing';
import { Tooltip } from '@lody/ui/tooltip';
const storyLayout = stylex.create({
  frame: {
    width: 'calc(var(--spacing) * 64)',
    'border-radius': 'var(--radius-lg)',
    'background-color': 'hsl(var(--sidebar-background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
    color: 'hsl(var(--sidebar-foreground) / 1)',
  },
  label: {
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
});

const meta = {
  title: 'Sessions/SessionSharingIndicator',
  component: SessionSharingIndicator,
  decorators: [
    (Story) => (
      <Tooltip.Provider>
        <div {...stylex.props(storyLayout.frame)}>
          <div className="flex items-center gap-2 rounded-md px-2 py-1 text-sm">
            <span {...stylex.props(storyLayout.label)}>Fix team sharing</span>
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

export const Archived: Story = {
  render: () => <SessionArchivedBadge />,
};

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
