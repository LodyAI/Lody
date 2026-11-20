import type { Meta, StoryObj } from '@storybook/react';
import type { MemoryAgent } from '@lody/shared';
import { MemoryAgentConnectList } from '@/components/settings/memory-agent-connect';
import { MemoryProviderLogo } from '@/components/settings/memory-setting';
import { memoryProviderStoryState, memoryReply } from './memory-provider-story-state';

const configs = [
  { agentType: 'claude', name: 'Claude Code' },
  { agentType: 'codex', name: 'Codex' },
  { agentType: 'kimi', name: 'Kimi Code' },
  { agentType: 'opencode', name: 'OpenCode' },
  { agentType: 'gemini', name: 'Gemini CLI' },
];
const agent = (
  id: string,
  displayName: string,
  integration: MemoryAgent['integration'],
  overrides: Partial<MemoryAgent> = {}
): MemoryAgent => ({
  id,
  displayName,
  integration,
  supported: true,
  connectable: true,
  connected: false,
  ...overrides,
});
const agents = [
  agent('claude', 'Claude Code', 'hook'),
  agent('codex', 'Codex', 'hook'),
  agent('kimi', 'Kimi Code', 'mcp'),
  agent('opencode', 'OpenCode', 'mcp'),
];
const connected = agents.map((entry) => ({ ...entry, connected: true }));
const listed = (reported: MemoryAgent[]) =>
  memoryProviderStoryState(memoryReply({ agents: reported, account: 'person@example.com' }));

const meta = {
  title: 'Settings/MemoryAgentConnectList',
  component: MemoryAgentConnectList,
  args: {
    logo: <MemoryProviderLogo providerId="everme" brandColor decorative />,
    name: 'EverMe',
    providerKey: 'everme',
    configs,
    agents,
    state: listed(agents),
    disabled: false,
  },
} satisfies Meta<typeof MemoryAgentConnectList>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing connected yet: connecting asks before conversations are uploaded. */
export const NoneConnected: Story = {};
export const AllConnected: Story = { args: { agents: connected, state: listed(connected) } };
/** Every notice a row can carry, beside an agent EverMe has not adapted. */
export const Notices: Story = {
  args: (() => {
    const reported = [
      agent('claude', 'Claude Code', 'hook', { connected: true, notice: 'cloud_disconnected' }),
      agent('codex', 'Codex', 'hook', { notice: 'connect_failed' }),
      agent('kimi', 'Kimi Code', 'mcp', { connected: true, notice: 'disconnect_failed' }),
    ];
    return { agents: reported, state: listed(reported) };
  })(),
};
export const AgentAbsentFromMachine: Story = {
  args: (() => {
    const reported = [
      agent('claude', 'Claude Code', 'hook', { connected: true }),
      agent('codex', 'Codex', 'hook', { connectable: false, notice: 'absent_on_machine' }),
    ];
    return { agents: reported, state: listed(reported) };
  })(),
};
/** Before the provider's first reply no row is judged. */
export const Checking: Story = {
  args: {
    agents: [],
    disabled: true,
    state: { ...listed([]), result: undefined },
  },
};
export const NoAgentsConfigured: Story = { args: { configs: [], state: listed(agents) } };
