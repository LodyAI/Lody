import { openSettings, settingsRows } from './settings';

// Selection is absent for a fresh draft, but [] explicitly disables all servers.
export async function sessionMcpSelection(
  workspaceId: string,
  grant: Parameters<typeof openSettings>[1],
  persisted: unknown,
  signal: AbortSignal,
): Promise<string[]> {
  if (Array.isArray(persisted) && persisted.length === 0) return [];
  try {
    const { flock } = await openSettings(
      `${workspaceId}:wf:workspace`,
      grant,
      signal,
    );
    const servers = settingsRows('mcp', flock);
    const selected = Array.isArray(persisted)
      ? persisted
      : servers
          .filter((server) => server.enabledByDefault)
          .map((server) => server.id);
    const available = new Map(servers.map((server) => [server.id, server]));
    const ids = [
      ...new Set(
        selected.filter(
          (id): id is string => typeof id === 'string' && available.has(id),
        ),
      ),
    ];
    if (ids.some((id) => !available.get(id)?.configured))
      throw new Error('mcp_connection_missing');
    return ids;
  } catch (error) {
    if (error instanceof Error && error.message === 'not_found') return [];
    if (error instanceof Error && error.message === 'mcp_connection_missing')
      throw error;
    throw new Error('mcp_catalog_unavailable');
  }
}
