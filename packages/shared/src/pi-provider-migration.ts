import type { AgentConfigMeta } from './schema';
import type { AgentConfigId, MachineId } from './ids';

/** Only the known registry identity is eligible, never a similarly named custom command. */
export function isLegacyPiProvider(value: unknown): value is AgentConfigMeta {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<AgentConfigMeta>;
  return (
    config.cliType === 'registry' &&
    config.agentType === 'pi-acp' &&
    typeof config.id === 'string' &&
    typeof config.machineId === 'string'
  );
}

/** Stable identity makes retries add the same managed provider instead of duplicates. */
export function getManagedPiProviderId(machineId: MachineId): AgentConfigId {
  return `builtin-pi:${machineId}` as AgentConfigId;
}

/** Build a managed Pi provider beside the legacy provider without copying its launch environment. */
export function createManagedPiProvider(value: unknown): AgentConfigMeta | undefined {
  if (!isLegacyPiProvider(value)) return undefined;
  return {
    id: getManagedPiProviderId(value.machineId),
    machineId: value.machineId,
    name: 'Pi',
    description: undefined,
    cliType: 'builtin',
    agentType: 'pi',
    env: {},
  };
}
