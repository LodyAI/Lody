import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import {
  resolveAgentBrandId,
  type AgentBrandId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';
import { getAgentDisplayName } from '@/components/icons/agent-icon';
import { buildQuotaRows, type AiUsageQuotaRow } from './ai-usage-model';
import { CompactSection, SettingsEmptyList } from './compact-layout';
import { ProviderRow, type ProviderRowProps } from './provider-row';
import { space } from '@lody/ui/tokens/scales.stylex';

const BRAND_NAMES: Record<AgentBrandId, string> = {
  deepseek: 'DeepSeek',
  mimo: 'MiMo',
  minimax: 'MiniMax',
  glm: 'GLM',
};
const styles = stylex.create({
  groups: { display: 'flex', flexDirection: 'column', gap: space[4] },
});

type QuotaSource = { config: AgentConfigMeta; machine: MachineViewMeta; quota: AiUsageQuotaRow };

export function AgentsProviderQuotaView({
  machines,
  configs,
  onlineMachineIds,
  onEdit,
  onDelete,
  onRefresh,
}: {
  machines: ReadonlyMap<MachineId, MachineViewMeta>;
  configs: readonly AgentConfigMeta[];
  onlineMachineIds: ReadonlySet<MachineId>;
  onEdit: (machine: MachineViewMeta, config: AgentConfigMeta) => void;
  onDelete?: ProviderRowProps['onDelete'];
  onRefresh?: ProviderRowProps['onRefresh'];
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => {
    const quotaByConfig = new Map(
      buildQuotaRows({ machines, configs, onlineMachineIds }).map((row) => [row.configId, row])
    );
    const byProvider = new Map<string, { name: string; sources: QuotaSource[] }>();
    for (const config of configs) {
      const machine = machines.get(config.machineId);
      const quota = quotaByConfig.get(config.id);
      if (!machine || !quota) continue;
      const brand = config.cliType === 'builtin' ? resolveAgentBrandId(config) : undefined;
      const key = brand ?? `${config.cliType}:${config.agentType}`;
      const name = brand
        ? BRAND_NAMES[brand]
        : config.cliType === 'custom'
          ? config.name
          : (getAgentDisplayName(config.cliType, config.agentType) ?? config.agentType);
      const group = byProvider.get(key) ?? { name, sources: [] };
      group.sources.push({ config, machine, quota });
      byProvider.set(key, group);
    }
    return [...byProvider]
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([key, group]) => ({
        key,
        ...group,
        sources: group.sources.sort(
          (a, b) =>
            a.quota.machineName.localeCompare(b.quota.machineName) ||
            a.config.name.localeCompare(b.config.name)
        ),
      }));
  }, [machines, configs, onlineMachineIds]);

  if (groups.length === 0) {
    return (
      <SettingsEmptyList>
        {t('settings.aiUsage.quota.empty', 'No quota sources yet.')}
      </SettingsEmptyList>
    );
  }
  return (
    <div {...stylex.props(styles.groups)}>
      {groups.map((group) => (
        <CompactSection key={group.key} title={group.name} boxed>
          {group.sources.map(({ config, machine, quota }) => (
            <ProviderRow
              key={quota.id}
              config={config}
              machine={machine}
              quota={quota}
              view="quota"
              showMachine
              onEdit={() => onEdit(machine, config)}
              onDelete={onDelete}
              onRefresh={onRefresh}
            />
          ))}
        </CompactSection>
      ))}
    </div>
  );
}
