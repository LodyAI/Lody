import { openSettings } from './settings';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

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
    const servers = [];
    for (const row of flock.scan()) {
      if (row.key.length !== 2 || row.key[0] !== 'mcpServer') continue;
      const id = text(row.key[1]),
        value = object(row.value);
      if (value.id !== id || !['stdio', 'http'].includes(text(value.transport)))
        continue;
      const connection = object(value.connection);
      servers.push({
        id,
        name: text(value.name),
        enabledByDefault: value.enabledByDefault === true,
        configured:
          connection.transport === value.transport &&
          (value.transport === 'http'
            ? !!text(connection.url).trim()
            : !!text(connection.command).trim()),
      });
    }
    servers.sort((a, b) => a.name.localeCompare(b.name));
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
