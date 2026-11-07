import type {
  AgentQuota,
  AgentUsage,
  UsageWindow,
} from '../models/agent-usage.ts';

type Row = { key: unknown[]; value?: unknown };
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const positive = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

function quota(provider: string, id: string, raw: unknown): AgentQuota {
  const value = object(raw);
  const current =
    typeof value.limitId === 'string' && !!text(object(value.scope).providerId);
  let input: unknown[];
  if (Array.isArray(value.windows)) input = value.windows;
  else
    input = [
      {
        usedPercent: value.fiveHour,
        windowDurationMins:
          provider === 'codex' && value.sevenDay == null ? 10080 : 300,
        resetsAt: value.fiveHourResetAt,
      },
      {
        usedPercent: value.sevenDay,
        windowDurationMins: 10080,
        resetsAt: value.sevenDayResetAt,
      },
    ];
  const windows: UsageWindow[] = input.flatMap((rawWindow) => {
    const w = object(rawWindow);
    let percent = w.usedPercent;
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return [];
    if (!current && provider === 'claude' && percent >= 0 && percent <= 1)
      percent *= 100;
    let reset = positive(current ? w.resetsAtEpochSeconds : w.resetsAt);
    if (!current && reset && reset >= 1e12) reset /= 1000;
    const duration = positive(
      current ? w.windowDurationSeconds : w.windowDurationMins,
    );
    return [
      {
        label: text(w.label) || undefined,
        usedPercent: Math.min(100, Math.max(0, percent)),
        duration:
          duration === null ? null : positive(duration * (current ? 1 : 60)),
        resetsAt: reset,
      },
    ];
  });
  return {
    id,
    provider,
    name:
      text(value.limitName) ||
      (id === 'codex_bengalfox' ? 'Codex Spark' : undefined),
    windows,
  };
}

export function projectAgentUsage(rows: Row[], machineId: string): AgentUsage {
  const configs: AgentUsage['configs'] = [];
  const quotas: AgentQuota[] = [];
  for (const row of rows) {
    if (row.value === undefined || row.value === null) continue;
    const value = object(row.value);
    if (
      row.key[0] === 'rateLimit' &&
      row.key.length === 3 &&
      text(row.key[1]) &&
      text(row.key[2])
    ) {
      quotas.push(quota(text(row.key[1]), text(row.key[2]), row.value));
    }
    if (
      row.key[0] !== 'agentConfig' ||
      row.key.length !== 2 ||
      !text(value.id) ||
      value.id !== row.key[1] ||
      value.machineId !== machineId
    )
      continue;
    const provider = text(value.agentType);
    configs.push({
      id: text(value.id),
      name: text(value.name),
      provider,
      eligible:
        value.cliType === 'builtin' &&
        ['codex', 'claude', 'grok', 'kimi'].includes(provider) &&
        !text(value.brandId) &&
        Object.keys(object(value.env)).length === 0,
    });
  }
  return { configs, quotas };
}

export function legacyAgentQuotas(raw: unknown): AgentQuota[] {
  return Object.entries(object(raw)).map(([key, value]) => {
    const separator = key.indexOf('::');
    if (separator === -1) return quota(key, key, value);
    const provider = key.slice(0, separator);
    return quota(provider, key.slice(separator + 2) || provider, value);
  });
}

export function mergeAgentQuotas(
  legacy: AgentQuota[],
  current: AgentQuota[],
): AgentQuota[] {
  const providers = new Set(current.map((q) => q.provider));
  const merged = new Map(
    legacy
      .filter(
        (q) =>
          !providers.has(q.provider) ||
          (q.id !== q.provider && q.id.startsWith(q.provider)),
      )
      .map((q) => [`${q.provider}::${q.id}`, q]),
  );
  for (const q of current) merged.set(`${q.provider}::${q.id}`, q);
  return [...merged.values()].sort((a, b) =>
    `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`),
  );
}
