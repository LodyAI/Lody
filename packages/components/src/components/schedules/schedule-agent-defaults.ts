import {
  isSensitiveAcpConfigOptionId,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineViewMeta,
} from '@lody/shared';
import { buildAcpSelectorOptions } from '@/components/shared/acp-selector-options';
import type { AgentRunRef } from '@/components/shared/agent-run-ref';
import { agentDefaultsCache } from '@/lib/local-storage-cache';
import { resolvePreferredChatLandingAgentSelection } from '@/lib/chat-landing-defaults';

/**
 * The run configuration the chat landing would show for this Agent: its
 * remembered model, options and permission (`agentDefaultsCache`), falling back
 * to the Agent's own defaults. A schedule starts from what the person already
 * uses to chat instead of an empty menu.
 *
 * The permission is always filled — the mode the landing would display, or the
 * current value of an advertised `_permission` option — so the editor opens
 * showing a choice the person can see and change, not an unset control.
 */
export function seedScheduleAgentRunRef(
  config: AgentConfigMeta,
  machine: Pick<MachineViewMeta, 'acpCapabilities'> | null | undefined
): AgentRunRef {
  const cached = agentDefaultsCache.get(config.id);
  const options = buildAcpSelectorOptions({
    configId: config.id,
    cliType: config.cliType,
    agentType: config.agentType,
    selectedModeId: cached?.modeId,
    selectedModelId: cached?.modelId,
    configOptionValues: cached?.configOptionValues,
    runtimeOverrides: config.runtimeOverrides,
    machine: machine ?? null,
  });
  const values: Record<string, string> = {};
  for (const [id, value] of Object.entries(cached?.configOptionValues ?? {}))
    values[id] = String(value);
  // Fill the permission the same way `hasExplicitSchedulePermission` reads it:
  // an advertised `_permission` option wins; otherwise the mode list; otherwise
  // a `mode`-category option (how probed custom/registry agents publish it).
  const fillFrom = (category: string) => {
    for (const selector of options.configOptionSelectors)
      if (
        selector.category === category &&
        selector.configId !== 'interaction_mode' &&
        values[selector.configId] === undefined
      )
        values[selector.configId] = String(selector.currentValue);
  };
  const permissionOptions = options.configOptionSelectors.some(
    (selector) => selector.category === '_permission'
  );
  if (permissionOptions) fillFrom('_permission');
  else if (options.modeOptions.length === 0) fillFrom('mode');
  // Credentials never belong in a schedule definition (its schema rejects them).
  for (const id of Object.keys(values)) if (isSensitiveAcpConfigOptionId(id)) delete values[id];

  const modeId =
    cached?.modeId && options.modeOptions.some((mode) => mode.value === cached.modeId)
      ? cached.modeId
      : options.modeOptions.length > 0
        ? (options.defaultModeId ?? undefined)
        : undefined;
  const modelId = cached?.modelId ?? undefined;
  return {
    agentConfigId: config.id as AgentConfigId,
    ...(modeId ? { modeId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(Object.keys(values).length ? { configOptionValues: values } : {}),
  };
}

/**
 * The Agent a new schedule starts with: the chat landing's last choice when it
 * runs on one of `machines`, else the landing's own fallback for them (same
 * agent type on the preferred machine, then any agent).
 */
export function pickScheduleAgent({
  landing,
  agents,
  machines,
}: {
  landing: { agentId?: string | null; machineId?: string | null } | null;
  agents: AgentConfigMeta[];
  /** Machines the schedule may run on (the person's own). */
  machines: Map<string, MachineViewMeta>;
}): AgentConfigMeta | undefined {
  const selection = resolvePreferredChatLandingAgentSelection({
    preferredAgentId: landing?.agentId,
    preferredMachineId: landing?.machineId,
    executorConfigs: agents.filter((config) => machines.has(config.machineId)),
    machines,
  });
  return selection ? agents.find((config) => config.id === selection.agentId) : undefined;
}
