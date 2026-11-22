export type ProviderQuotaWindow = {
  label: string;
  remainingPercent: number;
  resetsAt: number | null;
};

export type ProviderQuotaSource = {
  id: string;
  agentType: string;
  name: string;
  machineName: string;
  machineOwnerId: string | undefined;
  online: boolean;
  windows: readonly ProviderQuotaWindow[];
};

export type ProviderQuotaWidgetSummary = {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  locale: string;
  providers: {
    id: string;
    name: string;
    machineName: string;
    logoKind: string;
    logoText: string;
    online: boolean;
    windows: ProviderQuotaWindow[];
    additionalWindows: number;
  }[];
};

const brands = ['codex', 'claude', 'kimi', 'deepseek', 'minimax', 'mimo', 'glm'];
const rank = (agentType: string) => {
  const index = brands.indexOf(agentType);
  return index < 0 ? brands.length : index;
};

export function selectQuotaProviders<T extends { id: string; agentType: string; online: boolean }>(
  sources: readonly T[]
): T[] {
  const candidates = [...sources].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      rank(a.agentType) - rank(b.agentType) ||
      a.id.localeCompare(b.id)
  );
  const selected: T[] = [];
  const agentTypes = new Set<string>();
  for (const candidate of candidates) {
    if (selected.length === 3) break;
    if (agentTypes.has(candidate.agentType)) continue;
    selected.push(candidate);
    agentTypes.add(candidate.agentType);
  }
  for (const candidate of candidates) {
    if (selected.length === 3) break;
    if (!selected.some((item) => item.id === candidate.id)) selected.push(candidate);
  }
  return selected;
}

const displayText = (value: string, limit: number) =>
  Array.from(value.replace(/\p{Cc}/gu, ' ').trim())
    .slice(0, limit)
    .join('');

/** Project display fields only. Keep each provider/profile separate, including equal-duration windows. */
export function buildProviderQuotaWidgetSummary({
  scope,
  sources,
  locale,
}: {
  scope: { userId: string; workspaceId: string; workspaceName: string } | null;
  sources: readonly ProviderQuotaSource[];
  locale: string;
}): ProviderQuotaWidgetSummary | null {
  if (scope === null) return null;
  const candidates = sources
    .filter((source) => source.machineOwnerId === scope.userId)
    .flatMap((source) => {
      const windows = source.windows
        .map((window) => ({
          ...window,
          label: displayText(window.label, 64),
        }))
        .filter(
          (window) =>
            window.label.trim().length > 0 &&
            Number.isFinite(window.remainingPercent) &&
            window.remainingPercent >= 0 &&
            window.remainingPercent <= 100 &&
            (window.resetsAt === null || (Number.isFinite(window.resetsAt) && window.resetsAt > 0))
        );
      if (windows.length === 0) return [];
      return [{ ...source, windows }];
    });
  const selected = selectQuotaProviders(candidates);
  return {
    ...scope,
    workspaceName: displayText(scope.workspaceName, 80) || 'Lody',
    locale: locale.slice(0, 32),
    providers: selected.map((source) => ({
      id: source.id.slice(0, 256),
      name: displayText(source.name, 48) || displayText(source.agentType, 48) || 'Agent',
      machineName: displayText(source.machineName, 48) || 'Computer',
      logoKind: brands.includes(source.agentType) ? source.agentType : 'agent',
      logoText: source.agentType.slice(0, 2).toUpperCase(),
      online: source.online,
      windows: source.windows.slice(0, 2).map((window) => ({
        label: window.label,
        remainingPercent: window.remainingPercent,
        resetsAt: window.resetsAt,
      })),
      additionalWindows: Math.min(999, Math.max(0, source.windows.length - 2)),
    })),
  };
}
