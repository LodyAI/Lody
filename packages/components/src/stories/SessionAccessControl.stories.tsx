import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent, within } from 'storybook/test';
import { Copy, Image } from 'lucide-react';
import type { LocalProjectId, MachineId } from '@lody/shared';

import { SessionAccessControl, type SessionShareEditorContext } from '@/components/session-sharing';
import { Tooltip } from '@lody/ui/tooltip';
import { ShareEditorStory } from './ShareEditorStory';

const machineId = 'machine-access-story' as MachineId;
const localProjectId = 'project-access-story' as LocalProjectId;

const renderShareEditor = (context: SessionShareEditorContext) => <ShareEditorStory {...context} />;

const meta = {
  title: 'Sessions/SessionAccessControl',
  component: SessionAccessControl,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <Tooltip.Provider>
        <div className="flex min-h-dvh items-start justify-end bg-background p-10 text-foreground">
          <Story />
        </div>
      </Tooltip.Provider>
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
    onCopyLink: fn(),
    exportActions: [
      { id: 'md', label: 'Copy as Markdown', icon: Copy, onSelect: fn() },
      { id: 'image', label: 'Share as image…', icon: Image, onSelect: fn() },
    ],
  },
} satisfies Meta<typeof SessionAccessControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PrivateProject: Story = {};

export const PrivateProjectPanelOpen: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Private to you/ }));
  },
};

export const PrivateProjectPanelOpenDark: Story = {
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

/** A conversation the team can already open still gets the panel, minus the team action. */
export const TeamShareButton: Story = {
  args: { state: teamState, publicShare: { status: 'none', renderEditor: renderShareEditor } },
};

/** The trigger reports the published link once the status resolves. */
export const TeamShared: Story = {
  args: { state: teamState, publicShare: { status: 'shared', renderEditor: renderShareEditor } },
};

export const TeamSharedDark: Story = {
  globals: { theme: 'dark' },
  args: { state: teamState, publicShare: { status: 'shared', renderEditor: renderShareEditor } },
};

/** A private conversation answers who can open it, then offers Copy link and copies. */
export const PrivateWithPublishing: Story = {
  args: { publicShare: { status: 'none', renderEditor: renderShareEditor } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Private to you/ }));
  },
};

/** Web opens the editor inside the same panel: publish end to end, then back. */
export const PublishInPanel: Story = {
  args: { publicShare: { status: 'none', renderEditor: renderShareEditor } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Private to you/ }));
    await userEvent.click(await within(document.body).findByRole('tab', { name: 'Web' }));
  },
};

/** A published link outranks the "Share" label on the pill; the scope stays in the popover. */
export const PrivateAndShared: Story = {
  args: { publicShare: { status: 'shared', renderEditor: renderShareEditor } },
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
