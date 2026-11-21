import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
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
import { settingsRecordsCard } from '@/components/settings/compact-layout';
import { settingsSurface as surface } from '@/components/settings/surface';

const providerStory = stylex.create({
  panel: {
    borderRadius: 'var(--radius-lg)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--card) / 1) 50%, transparent)',
  },
  narrow: { width: 340 },
  wide: { width: 520 },
});

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
  usage?: { conversations: number; lastUsedAt: number | null };
};

function StoryWrapper({ config, machine, showActions, narrow, usage }: StoryProps) {
  return (
    <div {...stylex.props(providerStory.panel, narrow ? providerStory.narrow : providerStory.wide)}>
      <ProviderRow
        config={config}
        machine={machine}
        onEdit={() => {}}
        onRefresh={showActions ? async () => {} : undefined}
        onDelete={showActions ? async () => {} : undefined}
        usage={usage}
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
        [getRateLimitEntryKey('claude', 'claude', 'cfg-claude' as AgentConfigId)]: {
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

export const ClaudeWithRateLimitNarrow: Story = {
  args: { ...ClaudeWithRateLimit.args, narrow: true, showActions: true },
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
        [getRateLimitEntryKey('claude', 'claude', 'cfg-claude' as AgentConfigId)]: {
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
        [getRateLimitEntryKey('codex', CODEX_SPARK_LIMIT_ID, 'cfg-codex' as AgentConfigId)]: {
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
        [getRateLimitEntryKey('codex', 'codex', 'cfg-codex' as AgentConfigId)]: {
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

/**
 * A custom command, used recently: the kind is the first fact of the meta line,
 * in the reader's language ("自定义 · 1 个对话 · 2 分钟前用过"), not a pill.
 */
export const CustomProviderWithUsage: Story = {
  args: {
    config: makeConfig({
      name: 'Deterministic E2E Agent',
      cliType: 'custom',
      agentType: 'custom',
    }),
    machine: makeMachine(),
    usage: { conversations: 1, lastUsedAt: getServerNow() - 2 * 60_000 },
  },
};

const quotaCapability = {
  rateLimits: { version: 1 as const, query: true as const },
};

const crowdedMachine = makeMachine({
  acpCapabilities: {
    'cfg-antigravity': {
      cliType: 'builtin',
      agentType: 'antigravity',
      modes: [],
      models: [],
      fetchedAt: getServerNow(),
      ...quotaCapability,
    },
    'cfg-codex': {
      cliType: 'builtin',
      agentType: 'codex',
      modes: [],
      models: [],
      fetchedAt: getServerNow(),
      ...quotaCapability,
    },
    'cfg-grok': {
      cliType: 'builtin',
      agentType: 'grok',
      modes: [],
      models: [],
      fetchedAt: getServerNow(),
      ...quotaCapability,
    },
  },
  raceLimits: {
    [getRateLimitEntryKey('antigravity', 'antigravity', 'cfg-antigravity' as AgentConfigId)]: {
      limitId: 'antigravity',
      scope: { providerId: 'antigravity' },
      planName: 'Antigravity Pro',
      windows: [
        {
          label: 'Gemini',
          usedPercent: 3,
          windowDurationSeconds: 604_800,
          resetsAtEpochSeconds: resetIn(86_400),
        },
        {
          label: 'Gemini',
          usedPercent: 13,
          windowDurationSeconds: 18_000,
          resetsAtEpochSeconds: resetIn(7_200),
        },
        {
          label: 'Claude',
          usedPercent: 0,
          windowDurationSeconds: 604_800,
          resetsAtEpochSeconds: resetIn(345_600),
        },
        {
          label: 'Claude',
          usedPercent: 0,
          windowDurationSeconds: 18_000,
          resetsAtEpochSeconds: resetIn(3_600),
        },
      ],
    },
    [getRateLimitEntryKey('codex', 'codex', 'cfg-codex' as AgentConfigId)]: {
      limitId: 'codex',
      scope: { providerId: 'codex' },
      planName: 'ChatGPT Plus',
      windows: [
        {
          usedPercent: 95,
          windowDurationSeconds: 604_800,
          resetsAtEpochSeconds: resetIn(5 * 24 * 60 * 60),
        },
        {
          usedPercent: 0,
          windowDurationSeconds: 18_000,
          resetsAtEpochSeconds: resetIn(600),
        },
      ],
    },
    [getRateLimitEntryKey('grok', 'grok', 'cfg-grok' as AgentConfigId)]: {
      limitId: 'grok',
      scope: { providerId: 'grok' },
      planName: 'SuperGrok',
      windows: [
        {
          usedPercent: 23,
          windowDurationSeconds: 604_800,
          resetsAtEpochSeconds: resetIn(4 * 24 * 60 * 60),
        },
      ],
    },
  },
});

const crowdedRows: Array<{
  config: AgentConfigMeta;
  usage?: { conversations: number; lastUsedAt: number | null };
}> = [
  {
    config: makeConfig({ name: 'AGY', cliType: 'custom', agentType: 'custom' }),
    usage: { conversations: 9, lastUsedAt: getServerNow() - 6 * 60_000 },
  },
  {
    config: makeConfig({
      name: 'Antigravity Google',
      cliType: 'builtin',
      agentType: 'antigravity',
    }),
    usage: { conversations: 14, lastUsedAt: getServerNow() - 40 * 60_000 },
  },
  {
    config: makeConfig({ name: 'Codex', cliType: 'builtin', agentType: 'codex' }),
    usage: { conversations: 52, lastUsedAt: getServerNow() - 2 * 60_000 },
  },
  {
    config: makeConfig({
      name: 'Codex-magpie',
      cliType: 'custom',
      agentType: 'custom',
      env: { OPENAI_BASE_URL: 'https://magpie.local', OPENAI_API_KEY: 'sk-test' },
    }),
    usage: { conversations: 4, lastUsedAt: getServerNow() - 13 * 60_000 },
  },
  {
    config: makeConfig({ name: 'Cursor', cliType: 'registry', agentType: 'cursor' }),
    usage: { conversations: 0, lastUsedAt: getServerNow() - 31 * 24 * 3_600_000 },
  },
  {
    config: makeConfig({
      name: 'DeepSeek Harness',
      cliType: 'custom',
      agentType: 'deepseek-harness',
      env: { DEEPSEEK_API_KEY: 'sk-test', DEEPSEEK_BASE_URL: 'https://api.deepseek.com' },
    }),
    usage: { conversations: 6, lastUsedAt: getServerNow() - 7 * 24 * 3_600_000 },
  },
  {
    config: makeConfig({ name: 'Grok', cliType: 'builtin', agentType: 'grok' }),
    usage: { conversations: 6, lastUsedAt: getServerNow() - 14 * 60_000 },
  },
  {
    config: makeConfig({ name: 'OpenCode', cliType: 'registry', agentType: 'opencode' }),
    usage: { conversations: 0, lastUsedAt: getServerNow() - 7 * 24 * 3_600_000 },
  },
  {
    config: makeConfig({
      name: 'Pi',
      cliType: 'custom',
      agentType: 'custom',
      env: { OLLAMA_API_BASE: 'http://127.0.0.1:11434' },
    }),
    usage: { conversations: 0, lastUsedAt: getServerNow() - 30 * 24 * 3_600_000 },
  },
];

function CrowdedListWrapper({ width = 760 }: { width?: number }) {
  return (
    <div style={{ width }}>
      <div {...stylex.props(settingsRecordsCard)}>
        {crowdedRows.map(({ config, usage }, index) => (
          <div key={config.id} {...stylex.props(surface.line, index > 0 && surface.lineRuled)}>
            <ProviderRow
              config={config}
              machine={crowdedMachine}
              onEdit={() => {}}
              onRefresh={async () => {}}
              onDelete={async () => {}}
              usage={usage}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The desktop Agents settings card at its real density: several providers,
 * several quota windows each — the state that decides whether identity and
 * quota can share a row.
 */
export const CrowdedProviderList: StoryObj<typeof CrowdedListWrapper> = {
  render: (args) => <CrowdedListWrapper {...args} />,
};

export const CrowdedProviderListNarrow: StoryObj<typeof CrowdedListWrapper> = {
  args: { width: 400 },
  render: (args) => <CrowdedListWrapper {...args} />,
};
