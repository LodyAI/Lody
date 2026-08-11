import type { Meta, StoryObj } from '@storybook/react';
import {
  CODEX_SPARK_LIMIT_ID,
  getRateLimitEntryKey,
  getServerNow,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';
import { ProviderRow } from '@/components/settings/provider-row';

const machineId = 'machine-1' as MachineId;

const makeMachine = (overrides: Partial<MachineViewMeta> = {}): MachineViewMeta => ({
  id: machineId,
  name: 'Workstation',
  cliVersion: '0.44.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
  ...overrides,
});

const makeConfig = (
  overrides: Partial<AgentConfigMeta> & Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'name'>
): AgentConfigMeta => ({
  id: `cfg-${overrides.agentType}` as AgentConfigId,
  machineId,
  description: undefined,
  env: {},
  ...overrides,
});

type StoryProps = {
  config: AgentConfigMeta;
  machine: MachineViewMeta;
  showActions?: boolean;
};

function StoryWrapper({ config, machine, showActions }: StoryProps) {
  return (
    <div className="w-[520px] rounded-lg border border-border/60 bg-card/50">
      <ProviderRow
        config={config}
        machine={machine}
        onEdit={() => {}}
        onRefresh={showActions ? async () => {} : undefined}
        onDelete={showActions ? async () => {} : undefined}
      />
    </div>
  );
}

const meta = {
  title: 'Settings/ProviderRow',
  component: StoryWrapper,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeWithRateLimit: Story = {
  args: {
    config: makeConfig({ name: 'Claude Code', cliType: 'builtin', agentType: 'claude' }),
    machine: makeMachine({
      raceLimits: {
        [getRateLimitEntryKey('claude', 'claude')]: {
          planName: 'Claude Pro',
          fiveHour: 55,
          sevenDay: 32,
          fiveHourResetAt: getServerNow() + 1_800_000,
          sevenDayResetAt: getServerNow() + 24 * 3_600_000,
        },
      },
    }),
  },
};

export const ClaudeEnvOverrideHidesRateLimit: Story = {
  args: {
    config: makeConfig({
      name: 'DeepSeek over Claude Code',
      cliType: 'builtin',
      agentType: 'claude',
      brandId: 'deepseek',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-test',
      },
    }),
    machine: makeMachine({
      raceLimits: {
        [getRateLimitEntryKey('claude', 'claude')]: {
          planName: 'Claude Pro',
          fiveHour: 55,
          sevenDay: 32,
          fiveHourResetAt: getServerNow() + 1_800_000,
          sevenDayResetAt: getServerNow() + 24 * 3_600_000,
        },
      },
    }),
  },
};

export const CodexSpark: Story = {
  args: {
    config: makeConfig({ name: 'Codex Spark', cliType: 'builtin', agentType: 'codex' }),
    machine: makeMachine({
      raceLimits: {
        [getRateLimitEntryKey('codex', CODEX_SPARK_LIMIT_ID)]: {
          planName: 'Codex Spark',
          fiveHour: 12,
          sevenDay: 88,
          fiveHourResetAt: getServerNow() + 300_000,
          sevenDayResetAt: getServerNow() + 48 * 3_600_000,
        },
      },
    }),
  },
};

export const CodexWeeklyOnly: Story = {
  args: {
    config: makeConfig({ name: 'Codex', cliType: 'builtin', agentType: 'codex' }),
    machine: makeMachine({
      raceLimits: {
        [getRateLimitEntryKey('codex', 'codex')]: {
          schemaVersion: 2,
          planName: 'ChatGPT Plus',
          limitId: 'codex',
          windows: [
            {
              usedPercent: 29,
              windowDurationMins: 7 * 24 * 60,
              resetsAt: getServerNow() + 5 * 24 * 3_600_000,
            },
          ],
          fiveHour: null,
          sevenDay: 29,
          fiveHourResetAt: null,
          sevenDayResetAt: getServerNow() + 5 * 24 * 3_600_000,
        },
      },
    }),
  },
};

export const ClaudeNoLimits: Story = {
  args: {
    config: makeConfig({ name: 'Claude Code', cliType: 'builtin', agentType: 'claude' }),
    machine: makeMachine(),
    showActions: true,
  },
};

export const RegistryProvider: Story = {
  args: {
    config: makeConfig({
      name: 'Auggie',
      cliType: 'registry',
      agentType: 'auggie',
      env: { AUGGIE_API_KEY: 'sk-test' },
    }),
    machine: makeMachine(),
  },
};

export const RegistryProviderWithActions: Story = {
  args: {
    config: makeConfig({
      name: 'Auggie',
      cliType: 'registry',
      agentType: 'auggie',
      env: { AUGGIE_API_KEY: 'sk-test' },
    }),
    machine: makeMachine(),
    showActions: true,
  },
};
