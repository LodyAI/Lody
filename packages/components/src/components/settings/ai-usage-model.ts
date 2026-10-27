import type { AgentConfigMeta, MachineId, MachineViewMeta } from '@lody/shared';
import {
  canShowSubscriptionRateLimits,
  getAgentRateLimitEntries,
  getAgentRateLimitWindows,
  type AgentRateLimitWindow,
} from '@/lib/session-usage';

export type AiUsageProviderKey = 'claude' | 'codex' | 'deepseek' | 'kimi' | 'gemini' | 'other';

export type AiUsageQuotaRow = {
  id: string;
  configId: AgentConfigMeta['id'];
  machineId: MachineId;
  providerKey: AiUsageProviderKey;
  providerName: string;
  /** Provider-reported plan/tier label, when the account reports one. */
  planName?: string | null;
  machineName: string;
  machineOnline: boolean;
  windows: AgentRateLimitWindow[];
  wallet: NonNullable<ReturnType<typeof getWallet>> | null;
  supportsQuery: boolean;
};

export type AiUsageProviderUsage = {
  key: AiUsageProviderKey;
  label: string;
  tokens: number;
  costUSD: number;
};

export type AiUsageProviderRow = {
  key: AiUsageProviderKey;
  label: string;
  machines: string[];
  tokens: number | null;
  costUSD: number | null;
  share: number | null;
  quotaPercent: number | null;
};

export type AiUsageProviderBucket = {
  label: string;
  values: Array<{ id: string; label: string; value: number }>;
};

const PROVIDER_LABELS: Record<AiUsageProviderKey, string> = {
  claude: 'Claude',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  gemini: 'Gemini',
  other: 'Other',
};

const PROVIDER_ORDER: AiUsageProviderKey[] = [
  'claude',
  'codex',
  'deepseek',
  'kimi',
  'gemini',
  'other',
];

function normalizeModelName(value: string | null | undefined): string {
  return value?.toLowerCase().split(/[:/]/).pop()?.trim() ?? '';
}

export function providerKeyForModelId(modelId: string | null | undefined): AiUsageProviderKey {
  const normalized = normalizeModelName(modelId);
  if (/^(claude|anthropic)/.test(normalized)) return 'claude';
  if (/^(gpt|codex|chatgpt|openai|o[1-9])/.test(normalized)) return 'codex';
  if (/^deepseek/.test(normalized)) return 'deepseek';
  if (/^(kimi|moonshot)/.test(normalized)) return 'kimi';
  if (/^gemini/.test(normalized)) return 'gemini';
  return 'other';
}

export function providerKeyForConfig(
  config: Pick<AgentConfigMeta, 'brandId' | 'cliType' | 'agentType'>
): AiUsageProviderKey {
  if (config.brandId === 'deepseek') return 'deepseek';
  if (config.brandId === 'glm' || config.brandId === 'minimax' || config.brandId === 'mimo') {
    return 'other';
  }
  return providerKeyForModelId(`${config.agentType} ${config.cliType}`);
}

export function providerLabel(key: AiUsageProviderKey): string {
  return PROVIDER_LABELS[key];
}

function getWallet(limits?: { wallet?: unknown } | null) {
  const wallet = limits?.wallet;
  if (!wallet || typeof wallet !== 'object') return null;
  const value = wallet as Record<string, unknown>;
  if (
    typeof value.balanceCents !== 'number' ||
    typeof value.monthlyUsedCents !== 'number' ||
    typeof value.monthlyChargeLimitCents !== 'number' ||
    typeof value.currency !== 'string'
  ) {
    return null;
  }
  return {
    balanceCents: value.balanceCents,
    monthlyUsedCents: value.monthlyUsedCents,
    monthlyChargeLimitCents: value.monthlyChargeLimitCents,
    currency: value.currency,
  };
}

export function buildQuotaRows({
  machines,
  configs,
  onlineMachineIds,
}: {
  machines: ReadonlyMap<MachineId, MachineViewMeta>;
  configs: readonly AgentConfigMeta[];
  onlineMachineIds: ReadonlySet<MachineId>;
}): AiUsageQuotaRow[] {
  const rows: AiUsageQuotaRow[] = [];

  for (const config of configs) {
    const machine = machines.get(config.machineId);
    if (!machine) continue;
    const capability = machine.acpCapabilities?.[config.id]?.rateLimits;
    const supportsQuery =
      capability?.query === true &&
      canShowSubscriptionRateLimits({
        cliType: config.cliType,
        agentType: config.agentType,
        config,
        capability,
      });

    const entries = getAgentRateLimitEntries(machine.raceLimits, config.agentType, config.id);
    const entry =
      entries.find((candidate) => getAgentRateLimitWindows(candidate.limits).length > 0) ??
      entries[0];

    rows.push({
      id: `${config.machineId}:${config.id}`,
      configId: config.id,
      machineId: config.machineId,
      providerKey: providerKeyForConfig(config),
      providerName: config.name.trim() || config.agentType,
      planName:
        typeof entry?.limits.planName === 'string' && entry.limits.planName.trim()
          ? entry.limits.planName.trim()
          : null,
      machineName: machine.name?.trim() || config.machineId,
      machineOnline: onlineMachineIds.has(config.machineId),
      windows: entry ? getAgentRateLimitWindows(entry.limits) : [],
      wallet: entry ? getWallet(entry.limits) : null,
      supportsQuery,
    });
  }

  return rows.sort((left, right) => {
    if (left.machineOnline !== right.machineOnline) return left.machineOnline ? -1 : 1;
    return left.providerName.localeCompare(right.providerName);
  });
}

export function buildProviderUsage(
  buckets: Array<{
    bucketLabel: string;
    byModel: Array<{ modelId: string; tokens: number; costUSD: number }>;
  }>
): {
  series: AiUsageProviderBucket[];
  totals: AiUsageProviderUsage[];
  totalTokens: number;
  totalCostUSD: number;
} {
  const totals = new Map<AiUsageProviderKey, AiUsageProviderUsage>();
  const series: AiUsageProviderBucket[] = buckets.map((bucket) => {
    const byProvider = new Map<AiUsageProviderKey, number>();
    for (const model of bucket.byModel) {
      const key = providerKeyForModelId(model.modelId);
      byProvider.set(key, (byProvider.get(key) ?? 0) + model.tokens);
      const current = totals.get(key) ?? {
        key,
        label: PROVIDER_LABELS[key],
        tokens: 0,
        costUSD: 0,
      };
      current.tokens += model.tokens;
      current.costUSD += model.costUSD;
      totals.set(key, current);
    }
    return {
      label: bucket.bucketLabel,
      values: PROVIDER_ORDER.flatMap((key) => {
        const value = byProvider.get(key);
        return value === undefined ? [] : [{ id: key, label: PROVIDER_LABELS[key], value }];
      }),
    };
  });

  const totalTokens = [...totals.values()].reduce((sum, item) => sum + item.tokens, 0);
  const totalCostUSD = [...totals.values()].reduce((sum, item) => sum + item.costUSD, 0);
  return {
    series,
    totals: PROVIDER_ORDER.flatMap((key) => {
      const item = totals.get(key);
      return item ? [item] : [];
    }),
    totalTokens,
    totalCostUSD,
  };
}

export function buildProviderRows({
  usage,
  quotaRows,
  totalTokens,
}: {
  usage: readonly AiUsageProviderUsage[];
  quotaRows: readonly AiUsageQuotaRow[];
  totalTokens: number;
}): AiUsageProviderRow[] {
  const usageByKey = new Map(usage.map((item) => [item.key, item]));
  const keys = new Set<AiUsageProviderKey>([
    ...usage.map((item) => item.key),
    ...quotaRows.map((row) => row.providerKey),
  ]);

  return [...keys]
    .map((key) => {
      const providerRows = quotaRows.filter((row) => row.providerKey === key);
      const machines = [...new Set(providerRows.map((row) => row.machineName))];
      const windows = providerRows.flatMap((row) => row.windows);
      const shortest = windows
        .filter((window) => window.windowDurationSeconds !== null)
        .sort(
          (left, right) => (left.windowDurationSeconds ?? 0) - (right.windowDurationSeconds ?? 0)
        )[0];
      const usageItem = usageByKey.get(key);
      return {
        key,
        label: PROVIDER_LABELS[key],
        machines,
        tokens: usageItem?.tokens ?? null,
        costUSD: usageItem?.costUSD ?? null,
        share:
          usageItem && totalTokens > 0
            ? Math.round((usageItem.tokens / totalTokens) * 1000) / 10
            : null,
        quotaPercent: shortest?.remainingPercent ?? null,
      };
    })
    .sort((left, right) => {
      if (left.tokens !== null && right.tokens !== null && left.tokens !== right.tokens) {
        return right.tokens - left.tokens;
      }
      if (left.tokens === null && right.tokens !== null) return 1;
      if (left.tokens !== null && right.tokens === null) return -1;
      return left.label.localeCompare(right.label);
    });
}

export function formatQuotaPercent(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value)}%`;
}

export function formatWalletBalance(
  wallet: AiUsageQuotaRow['wallet'],
  locale?: string | null
): string | null {
  if (!wallet) return null;
  return new Intl.NumberFormat(locale ?? 'en', {
    style: 'currency',
    currency: wallet.currency,
    maximumFractionDigits: 2,
  }).format(wallet.balanceCents / 100);
}
