import type { PluginManifest } from './manifest-schema';

export function pluginCapabilities(m: PluginManifest) {
  return [
    m.client && 'client',
    ...(m.permissions ?? []),
    m.machine && 'machine',
    ...(['skills', 'agentRoles', 'mcpServers', 'acpProviders', 'themes', 'styles'] as const).filter((kind) => m[kind]?.length),
    Object.values(m.config ?? {}).some((f) => f.type === 'secret') && 'secrets',
  ].filter((s): s is string => typeof s === 'string');
}
