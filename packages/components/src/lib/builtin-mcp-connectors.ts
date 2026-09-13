import {
  areWorkspaceMcpNamesEqual,
  getBuiltinMcpProvider,
  type BuiltinMcpProviderId,
  type McpServerId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';

export const findBuiltinMcpEntry = (
  servers: readonly WorkspaceMcpServerMeta[],
  providerId: BuiltinMcpProviderId
): WorkspaceMcpServerMeta | undefined =>
  servers.find(
    (server) => server.source?.kind === 'builtin' && server.source.providerId === providerId
  );

export const createUniqueBuiltinMcpName = (
  displayName: string,
  servers: readonly WorkspaceMcpServerMeta[]
): string => {
  if (!servers.some((server) => areWorkspaceMcpNamesEqual(server.name, displayName))) {
    return displayName;
  }
  const builtInName = `${displayName} (Lody)`;
  if (!servers.some((server) => areWorkspaceMcpNamesEqual(server.name, builtInName))) {
    return builtInName;
  }
  for (let suffix = 2; suffix <= servers.length + 2; suffix += 1) {
    const candidate = `${builtInName} ${suffix}`;
    if (!servers.some((server) => areWorkspaceMcpNamesEqual(server.name, candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unable to choose a unique name for ${displayName}`);
};

export const createBuiltinMcpEntry = (options: {
  providerId: BuiltinMcpProviderId;
  displayName?: string;
  id: McpServerId;
  now: number;
  servers: readonly WorkspaceMcpServerMeta[];
  description?: string;
  createdBy?: string;
}): WorkspaceMcpServerMeta => {
  const provider = getBuiltinMcpProvider(options.providerId);
  return {
    id: options.id,
    name: createUniqueBuiltinMcpName(options.displayName ?? provider.displayName, options.servers),
    transport: 'http',
    ...(options.description ? { description: options.description } : {}),
    source: {
      kind: 'builtin',
      providerId: provider.id,
      presetVersion: provider.presetVersion,
      accessProfile: provider.defaultAccessProfile,
    },
    enabledByDefault: false,
    createdAt: options.now,
    updatedAt: options.now,
    ...(options.createdBy ? { createdBy: options.createdBy } : {}),
  };
};
