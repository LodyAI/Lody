import type { AgentConfigMeta } from './schema';

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

/** Run inside flockRowUpdate against the live row; retries must not recreate a deleted provider. */
export function migratePiProvider(value: unknown): AgentConfigMeta | undefined {
  return isLegacyPiProvider(value) ? { ...value, cliType: 'builtin', agentType: 'pi' } : undefined;
}
