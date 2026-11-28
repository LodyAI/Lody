import { createHash } from 'node:crypto';
import {
  getWorkspaceFlockDocId,
  getWorkspaceMcpCatalog,
  readWorkspaceFlockRowsFromFlock,
  resolveSessionMcpServers,
  type McpServerId,
  type ResolveSessionMcpServersResult,
  type ResolveSessionMcpServersInput,
  type SessionId,
  type WorkspaceFlockReadableFlock,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
  type ResolvedMcpServer,
  normalizeMcpServerIdSelection,
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';
import { WorkspaceSyncUnavailableError } from '@/lib/command-runtime';

/**
 * Applies the agent's advertised capabilities to an already-loaded catalog.
 * Pure, so it can run at the exact point ACP startup needs the server list.
 */
export type SessionMcpCatalogSelector = (
  agentCapabilities: ResolveSessionMcpServersInput['agentCapabilities']
) => ResolveSessionMcpServersResult & { warnings?: string[]; mount?: SessionMcpMount };

/** In-memory identity of a mounted load (hashes resolved secrets; never persist, sync or log). */
export type SessionMcpMount = {
  /** `undefined` means no catalog was read, so the next readable catalog differs. */
  readonly fingerprint: string | undefined;
  readonly authRevisions: Readonly<Record<string, number>>;
};

export const readSessionMcpAuthRevisions = (
  selectedIds: readonly McpServerId[],
  getAuthRevision: ((serverId: string) => number) | undefined
): Record<string, number> =>
  Object.fromEntries(selectedIds.map((id) => [id, getAuthRevision?.(id) ?? 0]));

/** Local credentials are compared before the catalog, so an unreadable catalog cannot keep a signed-out mount. */
export const sessionMcpAuthRevisionsChanged = (
  mounted: SessionMcpMount | undefined,
  current: Readonly<Record<string, number>>
): boolean =>
  Object.entries(current).some(([id, revision]) => (mounted?.authRevisions[id] ?? 0) !== revision);

export type LoadSessionMcpCatalogInput = {
  repo: {
    openFlockDoc(docId: string): Promise<{ flock: WorkspaceFlockReadableFlock }>;
  };
  waitForCatalogBaseline?: () => Promise<void>;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  selectedIds: readonly McpServerId[];
  logger: { debug(message: string): void };
  env?: Readonly<Record<string, string | undefined>>;
  prepare?: (
    entry: WorkspaceMcpServerMeta,
    resolved: ResolvedMcpServer
  ) => Promise<ResolvedMcpServer>;
  getAuthRevision?: (serverId: string) => number;
};

export const EMPTY_MCP_CONFIG_FINGERPRINT = 'mcp-config:empty';

const EMPTY_SELECTION: SessionMcpCatalogSelector = () => ({
  servers: [],
  problems: [],
  mount: { fingerprint: EMPTY_MCP_CONFIG_FINGERPRINT, authRevisions: {} },
});

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, child]) => child !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => [key, canonical(child)])
        )
      : value;

const byName = (entries: readonly { name: string; value: string }[]) =>
  Object.fromEntries(entries.map(({ name, value }) => [name, value]));

/** In-memory fingerprint of what `selectedIds` would mount (hashes secrets; never persist, sync or log). */
export const computeSessionMcpConfigFingerprint = (input: {
  catalog: Readonly<Record<string, WorkspaceMcpServerMeta>>;
  selectedIds: readonly McpServerId[];
  env: Readonly<Record<string, string | undefined>>;
}): string => {
  const ids = [...(normalizeMcpServerIdSelection(input.selectedIds) ?? [])].sort();
  if (ids.length === 0) return EMPTY_MCP_CONFIG_FINGERPRINT;
  const servers = ids.map((id) => {
    const entry = input.catalog[id];
    const resolved = resolveSessionMcpServers({
      catalog: input.catalog,
      selectedIds: [id],
      agentCapabilities: { http: true },
      env: input.env,
    }).servers[0];
    return {
      id,
      entry: entry
        ? { name: entry.name, transport: entry.transport, connection: entry.connection ?? null }
        : null,
      resolved: !resolved
        ? null
        : 'type' in resolved
          ? { ...resolved, headers: byName(resolved.headers) }
          : { ...resolved, env: byName(resolved.env) },
    };
  });
  return createHash('sha256')
    .update(JSON.stringify(canonical(servers)))
    .digest('hex');
};

/** Current fingerprint from the local catalog replica, or `undefined` when it is unreadable. */
export const readSessionMcpConfigFingerprint = async (input: {
  repo: LoadSessionMcpCatalogInput['repo'];
  workspaceId: WorkspaceId;
  selectedIds: readonly McpServerId[];
  env: Readonly<Record<string, string | undefined>>;
}): Promise<string | undefined> => {
  if (input.selectedIds.length === 0) return EMPTY_MCP_CONFIG_FINGERPRINT;
  try {
    const handle = await input.repo.openFlockDoc(getWorkspaceFlockDocId(input.workspaceId));
    return computeSessionMcpConfigFingerprint({
      ...input,
      catalog: getWorkspaceMcpCatalog(readWorkspaceFlockRowsFromFlock(handle.flock)),
    });
  } catch {
    return undefined;
  }
};

/**
 * Loads the workspace MCP catalog for an ACP session start.
 *
 * Deliberately split from selection: the only thing selection needs from the
 * agent is its advertised `http` capability, so the initial baseline wait and
 * document read can overlap process spawn and the ACP handshake
 * instead of adding a round trip between `initialize` and `newSession`.
 *
 * A cold baseline can use complete local selections with a warning. Missing
 * selected rows retain readiness uncertainty so startup can recheck them.
 */
export const loadSessionMcpCatalog = async (
  input: LoadSessionMcpCatalogInput
): Promise<SessionMcpCatalogSelector> => {
  const { logger, selectedIds, sessionId } = input;
  if (selectedIds.length === 0) {
    return EMPTY_SELECTION;
  }

  const docId = getWorkspaceFlockDocId(input.workspaceId);
  let baselineError: WorkspaceSyncUnavailableError | undefined;
  const authRevisions = readSessionMcpAuthRevisions(selectedIds, input.getAuthRevision);
  try {
    await input.waitForCatalogBaseline?.();
  } catch (error) {
    if (!(error instanceof WorkspaceSyncUnavailableError)) throw error;
    baselineError = error;
  }
  try {
    const handle = await input.repo.openFlockDoc(docId);
    const catalog = getWorkspaceMcpCatalog(readWorkspaceFlockRowsFromFlock(handle.flock));
    const ids = normalizeMcpServerIdSelection(selectedIds) ?? [];
    // Check every selected row before authentication preparation: a cold retry
    // must neither silently omit tools nor prepare credentials twice.
    if (baselineError && ids.some((id) => !catalog[id])) throw baselineError;
    const warnings = baselineError
      ? [
          'Workspace MCP catalog has not been confirmed with the remote. Using the locally stored configuration for the selected MCP servers.',
        ]
      : undefined;
    const env = input.env ?? process.env;
    const mount: SessionMcpMount = {
      fingerprint: computeSessionMcpConfigFingerprint({ catalog, selectedIds, env }),
      authRevisions,
    };
    const withWarnings: SessionMcpCatalogSelector = (agentCapabilities) => ({
      ...resolveSessionMcpServers({ catalog, selectedIds, agentCapabilities, env }),
      ...(warnings ? { warnings } : {}),
      mount,
    });
    if (!input.prepare) return withWarnings;
    const prepared = new Map<string, ResolvedMcpServer>();
    const failed = new Set<string>();
    for (const id of ids) {
      const entry = catalog[id];
      const resolved = resolveSessionMcpServers({
        catalog,
        selectedIds: [id],
        agentCapabilities: { http: true },
        env,
      }).servers[0];
      if (!entry || !resolved) continue;
      try {
        prepared.set(id, await input.prepare(entry, resolved));
      } catch {
        failed.add(id);
      }
    }
    return (agentCapabilities) => {
      const result: ResolveSessionMcpServersResult = { servers: [], problems: [] };
      for (const id of ids) {
        const selected = resolveSessionMcpServers({
          catalog,
          selectedIds: [id],
          agentCapabilities,
          env,
        });
        result.problems.push(...selected.problems);
        const connection = prepared.get(id);
        if (selected.servers.length && connection) result.servers.push(connection);
        else if (selected.servers.length && failed.has(id))
          result.problems.push({
            kind: 'invalid_connection',
            mcpServerId: id,
            name: catalog[id]?.name ?? id,
            reason:
              'Local MCP authentication is unavailable. Configure it on this machine in Settings → MCP.',
          });
      }
      return { ...result, ...(warnings ? { warnings } : {}), mount };
    };
  } catch (error) {
    if (baselineError && error === baselineError) throw error;
    const reason = formatErrorMessage(error);
    logger.debug(`[${sessionId}] Workspace MCP catalog read failed: ${reason}`);
    return () => ({
      servers: [],
      problems: [{ kind: 'catalog_unavailable', reason }],
      mount: { fingerprint: undefined, authRevisions },
    });
  }
};
