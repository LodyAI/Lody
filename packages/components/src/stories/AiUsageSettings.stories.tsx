import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fn } from 'storybook/test';
import { getRateLimitEntryKey, type AgentConfigMeta, type MachineViewMeta } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { MachineProvidersSection } from '@/components/settings/machine-detail-pane';
import { AgentsProviderQuotaView } from '@/components/settings/agents-provider-quota-view';
import { SettingsLineTabs } from '@/components/settings/settings-line-tabs';
import { settingContainerClass } from '@/components/settings';
import {
  AiUsageSettingsView,
  type AiUsageWaitingRow,
} from '@/components/settings/ai-usage-setting-view';
import type { AiUsageProviderRow, AiUsageQuotaRow } from '@/components/settings/ai-usage-model';
import type { StackedAreaBucket } from '@/components/settings/usage-stacked-area-chart';
import { StatsSettingsFixture } from './StatsSettings.stories';
import { AgentsViewToggle, type AgentsView } from '@/components/settings/agents-view-toggle';

const now = Math.floor(Date.now() / 1000);

const quotaRows: AiUsageQuotaRow[] = [
  {
    id: 'm1:claude',
    configId: 'claude-work' as AiUsageQuotaRow['configId'],
    machineId: 'm1' as AiUsageQuotaRow['machineId'],
    providerKey: 'claude',
    providerName: 'Claude Code',
    planName: 'Pro',
    machineName: 'MacBook Pro',
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
    id: 'm2:claude',
    configId: 'claude-work-m2' as AiUsageQuotaRow['configId'],
    machineId: 'm2' as AiUsageQuotaRow['machineId'],
    providerKey: 'claude',
    providerName: 'Claude Code',
    planName: 'Pro',
    machineName: 'Mac mini',
    machineOnline: true,
    windows: [
      {
        usedPercent: 40,
        remainingPercent: 60,
        windowDurationSeconds: 5 * 60 * 60,
        resetsAtEpochSeconds: now + 2 * 60 * 60,
      },
      {
        usedPercent: 58,
        remainingPercent: 42,
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
    planName: 'Plus',
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
    id: 'm3:deepseek',
    configId: 'deepseek-api' as AiUsageQuotaRow['configId'],
    machineId: 'm3' as AiUsageQuotaRow['machineId'],
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

function NewSections({ surface = 'all' }: { surface?: 'all' | 'usage' | 'quota' }) {
  return (
    <AiUsageSettingsView
      surface={surface}
      quotaRows={quotaRows}
      quotaLoading={false}
      onRefreshQuota={() => undefined}
      byModelBuckets={byModelBuckets}
      byMemberBuckets={byMemberBuckets}
      usageLoading={false}
      providerRows={providerRows}
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

function ConsumptionPreview() {
  return (
    <StoryFrame>
      <StatsSettingsFixture
        inline
        shareCard
        showBreakdown={false}
        initialRange="week"
        renderBreakdown={(buckets) => (
          <AiUsageSettingsView
            surface="usage"
            quotaRows={[]}
            quotaLoading={false}
            usageLoading={false}
            providerRows={[]}
            {...buckets}
          />
        )}
      />
    </StoryFrame>
  );
}

export const Composed: Story = { render: () => <AgentsPagePreview /> };
export const Consumption: Story = { render: () => <ConsumptionPreview /> };
export const LocalQuota: Story = { render: () => <AgentsPagePreview initialView="quota" /> };

const addProvider = fn();
const editProvider = fn();
const refreshProvider = fn(async () => undefined);
const deleteProvider = fn(async () => undefined);

function AgentsPagePreview({ initialView = 'configuration' }: { initialView?: AgentsView }) {
  const { t } = useTranslation();
  const [machineId, setMachineId] = useState('m1');
  const [view, setView] = useState<AgentsView>(initialView);
  const machines = [
    { id: 'm1', name: 'MacBook Pro', raceLimits: {}, acpCapabilities: {} },
    { id: 'm2', name: 'Mac mini', raceLimits: {}, acpCapabilities: {} },
    { id: 'm3', name: 'Mac Studio', raceLimits: {}, acpCapabilities: {} },
  ] as unknown as MachineViewMeta[];
  const machine = machines.find((item) => item.id === machineId)!;
  for (const sourceMachine of machines) {
    sourceMachine.acpCapabilities = Object.fromEntries(
      quotaRows
        .filter((row) => row.machineId === sourceMachine.id)
        .map((row) => [
          row.configId,
          {
            cliType: 'builtin',
            agentType: row.providerKey,
            modes: [],
            models: [],
            fetchedAt: now * 1000,
            rateLimits: { version: 1 },
          },
        ])
    );
    sourceMachine.raceLimits = Object.fromEntries(
      quotaRows
        .filter((row) => row.machineId === sourceMachine.id)
        .map((row) => [
          getRateLimitEntryKey(row.providerKey, row.providerKey, row.configId),
          {
            limitId: row.providerKey,
            scope: { providerId: row.providerKey },
            planName: row.planName,
            wallet: row.wallet
              ? {
                  ...row.wallet,
                  totalCents: row.wallet.balanceCents,
                  monthlyChargeLimitEnabled: true,
                }
              : null,
            windows: row.windows,
          },
        ])
    );
  }
  const configs = quotaRows.map(
    (row) =>
      ({
        id: row.configId,
        machineId: row.machineId,
        name: row.providerName,
        cliType: 'builtin',
        agentType: row.providerKey,
        env: {},
      }) as AgentConfigMeta
  );
  return (
    <StoryFrame>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <h1 style={{ fontSize: 18, margin: 0 }}>{t('settings.tabs.agents', 'Agents')}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <AgentsViewToggle view={view} onChange={setView} />
          <Button variant="secondary" size="small" onClick={addProvider}>
            {t('settings.agent.provider.addProvider', 'Add provider')}
          </Button>
        </div>
      </div>
      {view === 'configuration' ? (
        <SettingsLineTabs
          ruled
          label={t('settings.agent.machineTabs.machine', 'Machine')}
          current={machineId}
          onChange={setMachineId}
          tabs={machines.map((item) => ({ id: item.id as string, label: item.name || item.id }))}
        />
      ) : null}
      {view === 'quota' ? (
        <AgentsProviderQuotaView
          machines={new Map(machines.map((item) => [item.id, item]))}
          configs={configs}
          onlineMachineIds={
            new Set(quotaRows.filter((row) => row.machineOnline).map((row) => row.machineId))
          }
          onEdit={(_, config) => editProvider(config)}
          onRefresh={refreshProvider}
          onDelete={deleteProvider}
        />
      ) : (
        <MachineProvidersSection
          bare
          flush
          machine={machine}
          configs={configs.filter((config) => config.machineId === machineId)}
          onAddConfig={addProvider}
          onEditConfig={editProvider}
          onRefreshConfig={refreshProvider}
          onDeleteConfig={deleteProvider}
        />
      )}
    </StoryFrame>
  );
}

export const AgentsPage: Story = { render: () => <AgentsPagePreview /> };
export const AgentsQuota: Story = { render: () => <AgentsPagePreview initialView="quota" /> };
