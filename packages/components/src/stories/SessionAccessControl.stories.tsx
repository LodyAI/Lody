import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent, within } from 'storybook/test';
import type { LocalProjectId, MachineId } from '@lody/shared';

import { SessionAccessControl } from '@/components/session-sharing';
import { TooltipProvider } from '@/ui/tooltip';

const machineId = 'machine-access-story' as MachineId;
const localProjectId = 'project-access-story' as LocalProjectId;

const meta = {
  title: 'Sessions/SessionAccessControl',
  component: SessionAccessControl,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="flex min-h-dvh items-start justify-end bg-background p-10 text-foreground">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
  args: {
    state: {
      visibility: 'private',
      privateReason: 'project',
      canManage: true,
      machineId,
      localProjectId,
      machineName: 'Studio Mac',
      projectName: 'lody',
    },
    onShareWithTeam: fn(),
  },
} satisfies Meta<typeof SessionAccessControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PrivateProject: Story = {};

export const PrivateProjectMenuOpen: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Private to you/ }));
  },
};

export const PrivateProjectMenuOpenDark: Story = {
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Private to you/ }));
  },
};

export const TeamHidden: Story = {
  args: {
    state: {
      visibility: 'team',
      canManage: true,
      machineId,
      localProjectId,
      machineName: 'Studio Mac',
      projectName: 'lody',
    },
  },
};

const teamState = {
  visibility: 'team',
  canManage: true,
  machineId,
  localProjectId,
  machineName: 'Studio Mac',
  projectName: 'lody',
} as const;

/** A conversation the team can already open publishes from a plain button. */
export const TeamShareButton: Story = {
  args: { state: teamState, publicShare: { status: 'none', onOpen: fn() } },
};

/** The same button reports the published link once the status resolves. */
export const TeamShared: Story = {
  args: { state: teamState, publicShare: { status: 'shared', onOpen: fn() } },
};

export const TeamSharedDark: Story = {
  globals: { theme: 'dark' },
  args: { state: teamState, publicShare: { status: 'shared', onOpen: fn() } },
};

/** A private conversation keeps one menu for both sharing actions. */
export const PrivateWithPublishing: Story = {
  args: { publicShare: { status: 'none', onOpen: fn() } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Private to you/ }));
  },
};

/** A published link outranks "Private" on the pill; the scope stays in the menu. */
export const PrivateAndShared: Story = {
  args: { publicShare: { status: 'shared', onOpen: fn() } },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: /Anyone with the link/ })
    );
  },
};

export const CheckingHidden: Story = {
  args: {
    state: {
      visibility: 'unknown',
      canManage: false,
      machineId,
      localProjectId,
      machineName: 'Studio Mac',
      projectName: 'lody',
    },
  },
};

export const OwnerOnly: Story = {
  args: {
    state: {
      visibility: 'private',
      privateReason: 'machine',
      canManage: false,
      machineId,
      localProjectId,
      machineName: 'Teammate Mac',
      projectName: 'lody',
    },
  },
};
