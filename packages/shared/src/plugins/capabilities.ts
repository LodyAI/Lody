import type { PluginManifest } from './manifest-schema';

export function pluginCapabilities(m: PluginManifest) {
  return [
    m.client && 'client',
    ...(m.permissions ?? []),
    m.machine && 'machine',
    m.mcpServers?.length && 'mcpServers',
    m.acpProviders?.length && 'acpProviders',
    Object.values(m.config ?? {}).some((f) => f.type === 'secret') && 'secrets',
  ].filter((s): s is string => typeof s === 'string');
}
