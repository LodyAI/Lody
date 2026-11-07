import type { AgentQuota, AgentUsage } from '../models/agent-usage.ts';
import type { Session } from '../models/catalog.ts';
/** Display-only session usage; no timer or additional network subscription. */
export type SessionUsage = {
  context: { used: number; size: number } | null;
  isContextCompacting: boolean;
  quotaEligible: boolean;
  quota: AgentQuota | null;
  modelId?: string;
  modelLabel?: string;
};
export function projectSessionUsage(
  session: any,
  history: readonly any[],
): SessionUsage {
  const raw = session?.contextWindowUsage;
  const contextWindow =
    raw && Number.isFinite(raw.size) && raw.size > 0
      ? {
          size: raw.size,
          used: Number.isFinite(raw.used) ? Math.max(0, raw.used) : 0,
        }
      : null;
  for (let entry = history.length - 1; entry >= 0; entry--) {
    const items = history[entry]?.items ?? [];
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (
        item?.type !== 'tool_call' ||
        item.activityKind !== 'context_compaction'
      )
        continue;
      return {
        context: contextWindow,
        quotaEligible: false,
        quota: null,
        isContextCompacting:
          item.status === 'pending' || item.status === 'in_progress',
      };
    }
  }
  return {
    context: contextWindow,
    quotaEligible: false,
    quota: null,
    isContextCompacting: false,
  };
}

const normalizeModel = (name: string | null | undefined) =>
  name?.toLowerCase().replace(/[^a-z0-9]+/g, '') ?? '';
/** Same precedence as web session-usage: named tier, exact id, Spark, generic. */
export function selectSessionQuota(
  quotas: readonly AgentQuota[],
  provider: string,
  configId: string | null,
  modelId?: string | null,
): AgentQuota | null {
  const entries = quotas.filter(
    (q) => q.provider === provider && (q.agentConfigId ?? null) === configId,
  );
  const model = normalizeModel(modelId);
  if (model) {
    const named = entries
      .map((entry) => ({ entry, name: normalizeModel(entry.name) }))
      .filter(
        ({ name }) =>
          name &&
          (name === model ||
            (name.length >= 4 && model.includes(name)) ||
            (model.length >= 4 && name.includes(model))),
      )
      .sort((a, b) => b.name.length - a.name.length)[0]?.entry;
    if (named) return named;
    const exact = entries.find((q) => normalizeModel(q.id) === model);
    if (exact) return exact;
    if (provider === 'codex' && model.includes('spark'))
      return (
        entries.find(
          (q) =>
            q.id === 'codex_bengalfox' ||
            normalizeModel(q.name).includes('spark'),
        ) ?? null
      );
  }
  const generic = entries.find((q) => q.id === provider || !q.id);
  if (generic) return generic;
  return model ? null : (entries[0] ?? null);
}
export function sessionQuotaProjection(
  session: Session | undefined,
  usage: AgentUsage | undefined,
  selectedModel?: string,
): Pick<SessionUsage, 'quota' | 'quotaEligible' | 'modelId' | 'modelLabel'> {
  const config = usage?.configs.find(
    (c) => c.id === session?.agentConfigId && c.provider === session?.agentType,
  );
  const quotaEligible =
    config?.eligible === true && config.rateLimitsAvailable === true;
  const modelId = selectedModel ?? session?.lastModel?.modelId;
  const quota =
    quotaEligible && session?.agentType
      ? selectSessionQuota(
          usage?.quotas ?? [],
          session.agentType,
          session.agentConfigId ?? null,
          modelId,
        )
      : null;
  return {
    quotaEligible,
    quota,
    modelId,
    modelLabel:
      session?.lastModel?.modelId === modelId
        ? session?.lastModel?.name
        : modelId,
  };
}
