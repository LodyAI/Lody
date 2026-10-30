import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { E2eeMachineSharingView } from '@lody/platform';
import { MachineDetailPane } from '@/components/settings/machine-detail-pane';
import type { MachineId } from '@lody/shared';
import { MachineSharingPanel } from '@/components/settings/e2ee/machine-sharing-panel';

const state: E2eeMachineSharingView = {
  machineId: 'studio',
  ownerMembershipId: '11'.repeat(16),
  generation: '22'.repeat(32),
  head: { revision: 4, digest: '33'.repeat(32) },
  sharedWithTeam: true,
  projects: ['work'],
  signer: 'a1'.repeat(32),
  canManage: true,
  needsResign: false,
};
const projects = [
  { id: 'work', name: 'Lody', rootPath: '~/Projects/Lody' },
  { id: 'personal', name: 'Personal notes', rootPath: '~/Documents/Notes' },
];
const meta = {
  title: 'Settings/Encrypted machine sharing',
  component: MachineSharingPanel,
  args: {
    view: state,
    projects,
    onChange: () => {},
    onResign: () => {},
    onRefresh: () => {},
    onRetry: () => {},
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof MachineSharingPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Shared: Story = {};
export const Private: Story = { args: { view: { ...state, sharedWithTeam: false } } };
export const NewMachine: Story = {
  args: { view: { ...state, sharedWithTeam: false, projects: [], signer: null, head: null } },
};
export const SignerRevoked: Story = { args: { view: { ...state, needsResign: true } } };
export const ReadOnly: Story = { args: { view: { ...state, canManage: false } } };
export const AccessDenied: Story = {
  args: {
    view: {
      ...state,
      sharedWithTeam: false,
      canManage: false,
      deniedReason: 'e2ee_machine_not_shared',
    },
  },
};
export const Pending: Story = {
  args: {
    view: {
      ...state,
      pendingRequest: {
        requestId: '44'.repeat(16),
        change: { kind: 'machine', sharedWithTeam: false },
      },
    },
    issue: 'pending',
    retryable: true,
  },
};
export const Conflict: Story = { args: { issue: 'conflict', retryable: true } };
export const Unavailable: Story = { args: { issue: 'unavailable' } };
export const Loading: Story = { args: { view: undefined, loading: true } };
export const Interactive: Story = {
  render: function InteractiveStory(args) {
    const [view, setView] = useState(state);
    return (
      <MachineSharingPanel
        {...args}
        view={view}
        onChange={(change) =>
          setView((current) => ({
            ...current,
            head: { revision: (current.head?.revision ?? 0) + 1, digest: '55'.repeat(32) },
            sharedWithTeam:
              change.kind === 'machine'
                ? change.sharedWithTeam
                : change.sharedWithTeam || current.sharedWithTeam,
            projects:
              change.kind === 'project'
                ? change.sharedWithTeam
                  ? [...new Set([...current.projects, change.localProjectId])]
                  : current.projects.filter((id) => id !== change.localProjectId)
                : current.projects,
          }))
        }
        onResign={() => setView((current) => ({ ...current, needsResign: false }))}
      />
    );
  },
};

export const InMachineSettings: Story = {
  render: (args) => (
    <MachineDetailPane
      mode="devices"
      machine={{
        id: 'studio' as MachineId,
        name: 'Studio',
        os: 'macOS',
        cliVersion: '0.104.0',
        ownerUserId: 'synthetic-owner',
        sessions: [],
        raceLimits: {},
      }}
      configs={[]}
      isOwn
      isLocal
      ownerName={null}
      sharedWithTeam={false}
      canDelete={false}
      onRename={async () => {}}
      onDelete={async () => {}}
      onAddConfig={() => {}}
      onEditConfig={() => {}}
      footer={<MachineSharingPanel {...args} />}
    />
  ),
};
