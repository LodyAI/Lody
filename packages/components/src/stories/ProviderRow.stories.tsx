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
import { cn } from '@/lib/utils';

const machineId = 'machine-1' as MachineId;
const resetIn = (seconds: number) => Math.floor(getServerNow() / 1000) + seconds;

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
  narrow?: boolean;
};

function StoryWrapper({ config, machine, showActions, narrow }: StoryProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-card/50',
        narrow ? 'w-[340px]' : 'w-[520px]'
      )}
    >
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
          limitId: 'claude',
          scope: { providerId: 'claude' },
          planName: 'Claude Pro',
          windows: [
            {
              usedPercent: 55,
              windowDurationSeconds: 18_000,
              resetsAtEpochSeconds: resetIn(1_800),
            },
            {
              usedPercent: 32,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: resetIn(86_400),
            },
            {
              label: 'Fable',
              usedPercent: 67,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: resetIn(86_400),
            },
          ],
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
          limitId: 'claude',
          scope: { providerId: 'claude' },
          planName: 'Claude Pro',
          windows: [
            {
              usedPercent: 55,
              windowDurationSeconds: 18_000,
              resetsAtEpochSeconds: resetIn(1_800),
            },
            {
              usedPercent: 32,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: resetIn(86_400),
            },
          ],
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
          limitId: CODEX_SPARK_LIMIT_ID,
          scope: { providerId: 'codex' },
          planName: 'Codex Spark',
          windows: [
            { usedPercent: 12, windowDurationSeconds: 18_000, resetsAtEpochSeconds: resetIn(300) },
            {
              usedPercent: 88,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: resetIn(172_800),
            },
          ],
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
          planName: 'ChatGPT Plus',
          limitId: 'codex',
          scope: { providerId: 'codex' },
          windows: [
            {
              usedPercent: 29,
              windowDurationSeconds: 7 * 24 * 60 * 60,
              resetsAtEpochSeconds: resetIn(5 * 24 * 60 * 60),
            },
          ],
        },
      },
    }),
  },
};

export const CodexWeeklyOnlyNarrow: Story = {
  args: {
    ...CodexWeeklyOnly.args,
    narrow: true,
    showActions: true,
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
