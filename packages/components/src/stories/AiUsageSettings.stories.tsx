import type { Meta, StoryObj } from '@storybook/react';
import { settingContainerClass } from '@/components/settings';
import {
  AiUsageSettingsView,
  type AiUsageHistoryPanel,
  type AiUsageWaitingRow,
} from '@/components/settings/ai-usage-setting-view';
import type { AiUsageProviderRow, AiUsageQuotaRow } from '@/components/settings/ai-usage-model';
import type { StackedAreaBucket } from '@/components/settings/usage-stacked-area-chart';
import { StatsSettingsFixture } from './StatsSettings.stories';

const now = 1_800_000_000;

const quotaRows: AiUsageQuotaRow[] = [
  {
    id: 'm1:claude',
    configId: 'claude-work' as AiUsageQuotaRow['configId'],
    machineId: 'm1' as AiUsageQuotaRow['machineId'],
    providerKey: 'claude',
    providerName: 'Claude Code',
    machineName: 'MacBook Pro, Mac mini',
    machineOnline: true,
    windows: [
      {
        usedPercent: 38,
        remainingPercent: 62,
        windowDurationSeconds: 5 * 60 * 60,
        resetsAtEpochSeconds: now + 2 * 60 * 60,
      },
      {
        usedPercent: 56,
        remainingPercent: 44,
        windowDurationSeconds: 7 * 24 * 60 * 60,
        resetsAtEpochSeconds: now + 30 * 60 * 60,
      },
    ],
    wallet: null,
    supportsQuery: true,
  },
  {
    id: 'm1:codex',
    configId: 'codex-personal' as AiUsageQuotaRow['configId'],
    machineId: 'm1' as AiUsageQuotaRow['machineId'],
    providerKey: 'codex',
    providerName: 'Codex',
    machineName: 'MacBook Pro',
    machineOnline: true,
    windows: [
      {
        usedPercent: 92,
        remainingPercent: 8,
        windowDurationSeconds: 5 * 60 * 60,
        resetsAtEpochSeconds: now + 18 * 60,
      },
      {
        usedPercent: 29,
        remainingPercent: 71,
        windowDurationSeconds: 7 * 24 * 60 * 60,
        resetsAtEpochSeconds: now + 64 * 60 * 60,
      },
    ],
    wallet: null,
    supportsQuery: true,
  },
  {
    id: 'm2:deepseek',
    configId: 'deepseek-api' as AiUsageQuotaRow['configId'],
    machineId: 'm2' as AiUsageQuotaRow['machineId'],
    providerKey: 'deepseek',
    providerName: 'DeepSeek',
    machineName: 'Mac Studio',
    machineOnline: false,
    windows: [],
    wallet: {
      balanceCents: 842,
      monthlyUsedCents: 4120,
      monthlyChargeLimitCents: 10000,
      currency: 'USD',
    },
    supportsQuery: false,
  },
  {
    id: 'm2:kimi',
    configId: 'kimi-code' as AiUsageQuotaRow['configId'],
    machineId: 'm2' as AiUsageQuotaRow['machineId'],
    providerKey: 'kimi',
    providerName: 'Kimi Code',
    machineName: 'Mac mini',
    machineOnline: true,
    windows: [],
    wallet: null,
    supportsQuery: false,
  },
];

const usageBuckets: StackedAreaBucket[] = [
  ['Mon', 4.2, 2.6, 0.7, 0.4],
  ['Tue', 4.8, 3.0, 0.8, 0.4],
  ['Wed', 5.6, 3.4, 0.9, 0.5],
  ['Thu', 6.4, 3.9, 1.0, 0.6],
  ['Fri', 5.9, 3.6, 0.9, 0.5],
  ['Sat', 4.4, 2.7, 0.7, 0.4],
  ['Sun', 3.4, 2.1, 0.5, 0.3],
].map(([label, claude, codex, deepseek, kimi]) => ({
  label: String(label),
  values: [
    { id: 'claude', label: 'Claude', value: Number(claude) * 1_000_000 },
    { id: 'codex', label: 'Codex', value: Number(codex) * 1_000_000 },
    { id: 'deepseek', label: 'DeepSeek', value: Number(deepseek) * 1_000_000 },
    { id: 'kimi', label: 'Kimi', value: Number(kimi) * 1_000_000 },
  ],
}));

const byModelBuckets: StackedAreaBucket[] = usageBuckets.map((bucket) => ({
  label: bucket.label,
  values: [
    { id: 'claude-opus', label: 'claude-opus', value: (bucket.values[0]?.value ?? 0) * 0.6 },
    { id: 'claude-sonnet', label: 'claude-sonnet', value: (bucket.values[0]?.value ?? 0) * 0.4 },
    { id: 'gpt-5-codex', label: 'gpt-5-codex', value: bucket.values[1]?.value ?? 0 },
  ],
}));

const byMemberBuckets: StackedAreaBucket[] = usageBuckets.map((bucket) => ({
  label: bucket.label,
  values: [
    { id: 'alice', label: 'Alice Chen', value: (bucket.values[0]?.value ?? 0) * 0.7 },
    { id: 'bob', label: 'Bob Martinez', value: (bucket.values[0]?.value ?? 0) * 0.3 },
  ],
}));

const providerRows: AiUsageProviderRow[] = [
  {
    key: 'claude',
    label: 'Claude',
    machines: ['MacBook Pro', 'Mac mini'],
    tokens: 34_700_000,
    costUSD: 128.4,
    share: 54,
    quotaPercent: 62,
  },
  {
    key: 'codex',
    label: 'Codex',
    machines: ['MacBook Pro'],
    tokens: 21_300_000,
    costUSD: 42.6,
    share: 33,
    quotaPercent: 8,
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    machines: ['Mac Studio'],
    tokens: 5_500_000,
    costUSD: 9.8,
    share: 8.5,
    quotaPercent: null,
  },
  {
    key: 'kimi',
    label: 'Kimi',
    machines: ['Mac mini'],
    tokens: 3_100_000,
    costUSD: 5.6,
    share: 4.8,
    quotaPercent: null,
  },
];

function sawtooth(count: number, start: number, end: number, period: number) {
  return Array.from({ length: count }, (_, index) => {
    const position = index % period;
    const base = start - ((start - end) / (period - 1)) * position;
    return { x: index / (count - 1), y: index === count - 1 ? end : base };
  });
}

const historyPanels: AiUsageHistoryPanel[] = [
  {
    id: '5h',
    title: '5-hour window',
    rangeLabel: 'Last 24 hours',
    labels: ['00:00', '06:00', '12:00', '18:00', '24:00'],
    series: [
      { id: 'claude', label: 'Claude', color: '#2563eb', points: sawtooth(25, 88, 62, 5) },
      { id: 'codex', label: 'Codex', color: '#0ea5e9', points: sawtooth(25, 62, 8, 5) },
    ],
  },
  {
    id: '7d',
    title: '7-day window',
    rangeLabel: 'Last 7 days',
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    series: [
      {
        id: 'claude',
        label: 'Claude',
        color: '#2563eb',
        points: [
          { x: 0, y: 82 },
          { x: 0.3, y: 62 },
          { x: 0.6, y: 35 },
          { x: 0.61, y: 90 },
          { x: 1, y: 44 },
        ],
      },
      {
        id: 'codex',
        label: 'Codex',
        color: '#0ea5e9',
        points: [
          { x: 0, y: 90 },
          { x: 0.3, y: 74 },
          { x: 0.6, y: 45 },
          { x: 0.61, y: 95 },
          { x: 1, y: 71 },
        ],
      },
    ],
  },
];

const waitingRows: AiUsageWaitingRow[] = [
  {
    id: 'session-1',
    title: '修复 auth token 刷新',
    providerLabel: 'Claude Opus 4.5',
    machineName: 'MacBook Pro',
    state: 'scheduled',
    nextActionLabel: '18',
    elapsedLabel: '已等待 6 分钟',
  },
  {
    id: 'session-2',
    title: '重构 usage 聚合缓存',
    providerLabel: 'Codex GPT-5.6',
    machineName: 'Mac mini',
    state: 'waiting_for_machine',
    nextActionLabel: '等待机器上线',
    elapsedLabel: '已等待 34 分钟',
  },
  {
    id: 'session-3',
    title: '生成 v0.9 release notes',
    providerLabel: 'Claude Sonnet 4.5',
    machineName: 'MacBook Pro',
    state: 'needs_attention',
    nextActionLabel: '需要处理',
    elapsedLabel: '已等待 2 小时',
    note: '投递结果不确定，未自动重试',
  },
];

function NewSections() {
  return (
    <AiUsageSettingsView
      quotaRows={quotaRows}
      quotaLoading={false}
      onRefreshQuota={() => undefined}
      byModelBuckets={byModelBuckets}
      byMemberBuckets={byMemberBuckets}
      usageLoading={false}
      providerRows={providerRows}
      historyPanels={historyPanels}
      waitingRows={waitingRows}
    />
  );
}

function StoryFrame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100vh', overflowY: 'auto' }}>
      <div className={settingContainerClass}>{children}</div>
    </div>
  );
}

function Harness() {
  return (
    <StoryFrame>
      <NewSections />
    </StoryFrame>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Settings/AiUsageSettings',
  component: Harness,
  parameters: { layout: 'padded' },
};

export default meta;

type Story = StoryObj<typeof Harness>;

export const Default: Story = {};

/** The composed Settings page: the existing usage page on top, new sections below. */
export const Composed: Story = {
  render: () => (
    <StoryFrame>
      <StatsSettingsFixture inline shareCard showBreakdown={false} initialRange="week" />
      <NewSections />
    </StoryFrame>
  ),
};
