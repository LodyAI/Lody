import type { Meta, StoryObj } from '@storybook/react';
import type { AgentConfigMeta, MachineId } from '@lody/shared';
import {
  AccountMachinesOverviewView,
  type AccountMachineOverviewItem,
} from '@/components/settings/account-machines-overview';

const macId = 'machine-macbook' as MachineId;
const serverId = 'machine-server' as MachineId;

function makeAgent(
  id: string,
  machineId: MachineId,
  name: string,
  agentType: 'claude' | 'codex'
): AgentConfigMeta {
  return {
    id,
    machineId,
    name,
    description: undefined,
    cliType: 'builtin',
    agentType,
    env: {},
  } as AgentConfigMeta;
}

const items: AccountMachineOverviewItem[] = [
  {
    id: macId,
    name: 'Zixuan’s MacBook Pro',
    os: 'macOS 15',
    isOnline: true,
    sharedWithTeam: true,
    agents: [
      makeAgent('agent-claude', macId, 'Claude Code', 'claude'),
      makeAgent('agent-codex', macId, 'Codex', 'codex'),
      makeAgent('agent-claude-review', macId, 'Claude Review', 'claude'),
      makeAgent('agent-codex-fast', macId, 'Codex Fast', 'codex'),
      makeAgent('agent-codex-plan', macId, 'Codex Plan', 'codex'),
    ],
    directories: [
      {
        key: `${macId}:lody`,
        name: 'lody',
        rootPath: '/Users/zixuan/Code/lody',
        sharedWithTeam: true,
      },
      {
        key: `${macId}:notes`,
        name: 'private-notes',
        rootPath: '/Users/zixuan/Documents/private-notes',
        sharedWithTeam: false,
      },
    ],
  },
  {
    id: serverId,
    name: 'Home server',
    os: 'Linux',
    isOnline: false,
    sharedWithTeam: false,
    agents: [],
    directories: [],
  },
];

const noOp = () => undefined;

const meta = {
  title: 'Settings/AccountMachinesOverview',
  component: AccountMachinesOverviewView,
  parameters: { layout: 'centered' },
  args: {
    items,
    currentMachineId: macId,
    onConfigureAgents: noOp,
    onManageMachine: noOp,
    onOpenDirectory: noOp,
    onOpenDirectories: noOp,
  },
  decorators: [
    (Story) => (
      <div className="w-[min(900px,95vw)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AccountMachinesOverviewView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { items: [] },
};

export const Loading: Story = {
  args: { items: [], loading: true },
};
