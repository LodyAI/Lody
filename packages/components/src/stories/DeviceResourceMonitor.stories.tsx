import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent, within } from 'storybook/test';
import type {
  AgentConfigId,
  AgentConfigMeta,
  MachineId,
  MachineMonitorSnapshot,
  SessionId,
  SessionMeta,
} from '@lody/shared';
import { DeviceResourceMonitor } from '@/components/settings/device-resource-monitor';
const storyLayout = stylex.create({
  frame: {
    'margin-inline': 'auto',
    'min-height': '100vh',
    'max-width': '64rem',
    'background-color': 'hsl(var(--background) / 1)',
    'padding-block': 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--foreground) / 1)',
  },
});

const resource = {
  memoryBytes: 768 * 1024 * 1024,
  cpuCores: 0.72,
  cpuPercentOfMachine: 9,
  processCount: 6,
  memoryKind: 'cgroup-current' as const,
  quality: 'exact-cgroup' as const,
};

const snapshot: MachineMonitorSnapshot = {
  kind: 'snapshot',
  protocolVersion: 1,
  machineId: 'machine-story' as MachineId,
  instanceId: 'cli-story',
  updatedAtMs: Date.now(),
  sampleWindowMs: 2_000,
  platform: 'linux',
  cpuLogicalCores: 8,
  deviceCpuCores: 3.2,
  effectiveMemoryBytes: 16 * 1024 * 1024 * 1024,
  availableMemoryBytes: 9.5 * 1024 * 1024 * 1024,
  sessionAccounting: 'cgroup-v2',
  cliControlPlane: {
    ...resource,
    memoryBytes: 180 * 1024 * 1024,
    cpuCores: 0.08,
    processCount: 1,
    memoryKind: 'rss',
    quality: 'exact-process',
  },
  sessionsAggregate: resource,
  sessions: [
    {
      sessionId: 'session-running-with-a-long-identifier' as SessionId,
      parentSessionId: null,
      agentCliType: 'builtin',
      agentType: 'codex',
      status: 'running',
      lastActivityAtMs: Date.now(),
      startedAtMs: Date.now() - 90_000,
      resource,
    },
    {
      sessionId: 'session-permission' as SessionId,
      parentSessionId: null,
      agentCliType: 'builtin',
      agentType: 'claude',
      status: 'waiting_permission',
      lastActivityAtMs: Date.now() - 5_000,
      startedAtMs: Date.now() - 300_000,
      resource: {
        ...resource,
        memoryBytes: 230 * 1024 * 1024,
        cpuCores: 0.02,
        processCount: 3,
      },
    },
    {
      sessionId: 'session-idle' as SessionId,
      parentSessionId: null,
      agentCliType: 'builtin',
      agentType: 'codex',
      status: 'idle',
      lastActivityAtMs: Date.now() - 120_000,
      startedAtMs: Date.now() - 600_000,
      resource: {
        ...resource,
        memoryBytes: 110 * 1024 * 1024,
        cpuCores: 0,
        processCount: 1,
      },
    },
  ],
  sessionsTruncated: false,
  warnings: [],
};

const codexConfigId = 'config-codex' as AgentConfigId;
const claudeConfigId = 'config-claude' as AgentConfigId;
const agentConfigs: AgentConfigMeta[] = [
  {
    id: codexConfigId,
    machineId: snapshot.machineId,
    name: 'Codex',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
  {
    id: claudeConfigId,
    machineId: snapshot.machineId,
    name: 'Claude Code',
    description: undefined,
    cliType: 'builtin',
    agentType: 'claude',
    env: {},
  },
];
const sessionMetas: SessionMeta[] = snapshot.sessions.map((session, index) => ({
  id: session.sessionId,
  machineId: snapshot.machineId,
  createdAt: new Date().toISOString(),
  title: ['Implement device monitor actions', 'Review permission flow', 'Refactor monitor tests'][
    index
  ],
  userId: 'user-story',
  cliType: 'builtin',
  agentType: session.agentType === 'claude' ? 'claude' : 'codex',
  agentConfigId: session.agentType === 'claude' ? claudeConfigId : codexConfigId,
}));

const meta = {
  title: 'Settings/DeviceResourceMonitor',
  component: DeviceResourceMonitor,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DeviceResourceMonitor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = {
  args: {
    snapshot,
    state: 'active',
    sessionMetas,
    agentConfigs,
    onOpenSession: fn(),
    onTerminateSession: fn(async () => {}),
  },
};

export const MacOS: Story = {
  args: {
    snapshot: {
      ...snapshot,
      platform: 'darwin',
      sampleWindowMs: 5_000,
      sessionAccounting: 'process-tree',
      cliControlPlane: {
        ...snapshot.cliControlPlane,
        memoryKind: 'physical-footprint',
      },
      sessionsAggregate: {
        ...snapshot.sessionsAggregate,
        memoryKind: 'physical-footprint-sum',
        quality: 'estimated-tree',
      },
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        resource: {
          ...session.resource,
          memoryKind: 'physical-footprint-sum',
          quality: 'estimated-tree',
        },
      })),
    },
    state: 'active',
    sessionMetas,
    agentConfigs,
    onOpenSession: fn(),
    onTerminateSession: fn(async () => {}),
  },
};

export const MultiCoreCpu: Story = {
  args: {
    ...Live.args,
    snapshot: {
      ...snapshot,
      cpuLogicalCores: 4,
      deviceCpuCores: 3.84,
      sessionsAggregate: {
        ...snapshot.sessionsAggregate,
        cpuCores: 3.84,
        cpuPercentOfMachine: 96,
      },
      sessions: snapshot.sessions.map((session, index) =>
        index === 0
          ? {
              ...session,
              resource: {
                ...session.resource,
                cpuCores: 3.84,
                cpuPercentOfMachine: 96,
              },
            }
          : session
      ),
    },
  },
};

export const Mobile: Story = {
  args: {
    ...Live.args,
    snapshot: {
      ...snapshot,
      sessions: snapshot.sessions.map((session, index) =>
        index === 0
          ? {
              ...session,
              resource: {
                ...session.resource,
                cpuCores: 0.18,
                memoryBytes: 256 * 1024 * 1024,
                processCount: 3,
              },
            }
          : session
      ),
    },
    sessionMetas: sessionMetas.map((sessionMeta, index) =>
      index === 0
        ? {
            ...sessionMeta,
            title: 'Implement device resource monitoring for every connected machine',
          }
        : sessionMeta
    ),
  },
};

export const TerminateLoading: Story = {
  args: {
    ...Live.args,
    onTerminateSession: fn(
      async () => await new Promise<void>((resolve) => setTimeout(resolve, 2_000))
    ),
  },
};

export const WarmingUp: Story = {
  args: {
    snapshot: {
      ...snapshot,
      cliControlPlane: { ...snapshot.cliControlPlane, cpuCores: null },
    },
    state: 'active',
    sessionMetas,
    agentConfigs,
    onOpenSession: fn(),
    onTerminateSession: fn(async () => {}),
  },
};

export const Empty: Story = {
  args: {
    snapshot: {
      ...snapshot,
      sessions: [],
      sessionsAggregate: { ...resource, memoryBytes: 0, cpuCores: 0, processCount: 0 },
    },
    state: 'active',
  },
};

export const Observing: Story = { args: { snapshot: null, state: 'active' } };

export const Offline: Story = { args: { snapshot: null, state: 'disabled' } };

export const TerminateConfirmation: Story = {
  args: Live.args,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const terminateButton = canvas
      .getAllByRole('button', {
        name: 'Terminate ACP process',
      })
      .at(0);
    if (!terminateButton) throw new Error('Expected a terminate button');
    await userEvent.click(terminateButton);
  },
};
