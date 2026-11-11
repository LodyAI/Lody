import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent, within } from 'storybook/test';
import { Copy, Image } from 'lucide-react';
import type { LocalProjectId, MachineId } from '@lody/shared';

import { SessionAccessControl } from '@/components/session-sharing';
import { Tooltip } from '@lody/ui/tooltip';
import { ShareEditorStory } from './ShareEditorStory';

const machineId = 'machine-access-story' as MachineId;
const localProjectId = 'project-access-story' as LocalProjectId;

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
    await userEvent.click(within(canvasElement).getAllByRole('button')[0]);
  },
};

export const PrivateProjectPanelOpenDark: Story = {
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getAllByRole('button')[0]);
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
  args: { state: teamState, publicShare: { status: 'none', renderEditor: ShareEditorStory } },
};

/** A published link keeps its independent management entry. */
export const TeamShared: Story = {
  args: { state: teamState, publicShare: { status: 'shared', renderEditor: ShareEditorStory } },
};

export const TeamSharedDark: Story = {
  globals: { theme: 'dark' },
  args: { state: teamState, publicShare: { status: 'shared', renderEditor: ShareEditorStory } },
};

/** A private conversation answers who can open it, then offers Copy link and copies. */
export const PrivateWithPublishing: Story = {
  args: { publicShare: { status: 'none', renderEditor: ShareEditorStory } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getAllByRole('button')[0]);
  },
};

/** Web opens the editor inside the same panel: publish end to end, then back. */
export const PublishInPanel: Story = {
  args: { publicShare: { status: 'none', renderEditor: ShareEditorStory } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getAllByRole('button')[0]);
    await userEvent.click(
      await within(document.body).findByRole('button', { name: 'Publish to the web' })
    );
  },
};

/** Public-link management remains separate from the team-access status. */
export const PrivateAndShared: Story = {
  args: { publicShare: { status: 'shared', renderEditor: ShareEditorStory } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getAllByRole('button')[0]);
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

export const TeamReadOnly: Story = {
  args: { state: { ...teamState, access: 'read', setReadAccess: fn() } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getAllByRole('button')[0]);
  },
};
export const ReadOnlyNonOwner: Story = {
  args: { state: { ...teamState, access: 'read', canManage: false } },
  play: TeamReadOnly.play,
};
export const MachineEditable: Story = {
  args: { state: { ...teamState, access: 'edit', openMachineSettings: fn() } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getAllByRole('button')[0]);
  },
};

export const TeamReadOnlyChinese: Story = {
  ...TeamReadOnly,
  globals: { locale: 'zh_CN' },
};
export const ReadOnlyNonOwnerDark: Story = {
  ...ReadOnlyNonOwner,
  globals: { theme: 'dark' },
};

/** A synthetic photo, so the panel shows a pictured member next to initials. */
const bobPhoto = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#7aa2d6"/><circle cx="20" cy="16" r="7" fill="#f3d9c4"/><path d="M6 40a14 12 0 0 1 28 0z" fill="#2f4b7c"/></svg>'
)}`;
const memberState = {
  ...teamState,
  visibility: 'private' as const,
  access: 'read' as const,
  ownerUserId: 'alice',
  memberUserIds: ['bob'],
  availableMembers: [
    { userId: 'alice', name: 'Alice Chen' },
    { userId: 'bob', name: 'Bob Li', image: bobPhoto },
    { userId: 'carol', name: 'Carol Wang' },
  ],
  setMemberReadAccess: fn(),
  setReadAccess: fn(),
};
export const PersonalReadOnly: Story = {
  args: { state: memberState },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getAllByRole('button')[0]);
  },
};
export const PersonalReadOnlyChinese: Story = {
  ...PersonalReadOnly,
  globals: { locale: 'zh_CN' },
};
export const PersonalReadOnlyNonowner: Story = {
  args: { state: { ...memberState, canManage: false } },
  play: PersonalReadOnly.play,
};
export const TeamAndPersonal: Story = {
  args: { state: { ...memberState, visibility: 'team', access: 'read' } },
  play: PersonalReadOnly.play,
};
export const PersonalReadOnlyMobile: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  args: { state: memberState, presentation: 'dialog' },
};

export const MembersLoading: Story = {
  args: { state: { ...memberState, availableMembers: [], membersLoading: true } },
  play: PersonalReadOnly.play,
};
export const UnknownMember: Story = {
  args: {
    state: {
      ...memberState,
      availableMembers: memberState.availableMembers.filter((member) => member.userId !== 'bob'),
    },
  },
  play: PersonalReadOnly.play,
};

export const MembersRefreshFailed: Story = {
  args: { state: { ...memberState, membersError: true, retryMembers: fn() } },
  play: PersonalReadOnly.play,
};
