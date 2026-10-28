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

/**
 * Applies the agent's advertised capabilities to an already-loaded catalog.
 * Pure, so it can run at the exact point ACP startup needs the server list.
 */
export type SessionMcpCatalogSelector = (
  agentCapabilities: ResolveSessionMcpServersInput['agentCapabilities']
) => ResolveSessionMcpServersResult;

export type LoadSessionMcpCatalogInput = {
  repo: {
    openFlockDoc(docId: string): Promise<{ flock: WorkspaceFlockReadableFlock }>;
  };
  syncFlockDoc?: (docId: string, options: { timeoutMs: number }) => Promise<void>;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  selectedIds: readonly McpServerId[];
  logger: { debug(message: string): void };
  env?: Readonly<Record<string, string | undefined>>;
  prepare?: (
    entry: WorkspaceMcpServerMeta,
    resolved: ResolvedMcpServer
  ) => Promise<ResolvedMcpServer>;
};

const CATALOG_SYNC_TIMEOUT_MS = 5_000;

const EMPTY_SELECTION: SessionMcpCatalogSelector = () => ({ servers: [], problems: [] });

/**
 * Loads the workspace MCP catalog for an ACP session start.
 *
 * Deliberately split from selection: the only thing selection needs from the
 * agent is its advertised `http` capability, so this — a remote catalog sync
 * plus a document read — can overlap process spawn and the ACP handshake
 * instead of adding a round trip between `initialize` and `newSession`.
 *
 * Best effort. Configuration failures come back as problems on the selector so
 * the agent still starts with its built-in MCP.
 */
export const loadSessionMcpCatalog = async (
  input: LoadSessionMcpCatalogInput
): Promise<SessionMcpCatalogSelector> => {
  const { logger, selectedIds, sessionId } = input;
  if (selectedIds.length === 0) {
    return EMPTY_SELECTION;
  }

  const docId = getWorkspaceFlockDocId(input.workspaceId);
  if (input.syncFlockDoc) {
    try {
      await input.syncFlockDoc(docId, { timeoutMs: CATALOG_SYNC_TIMEOUT_MS });
    } catch (error) {
      logger.debug(
        `[${sessionId}] Workspace MCP catalog refresh failed; using local rows: ${formatErrorMessage(error)}`
      );
    }
  }

  try {
    const handle = await input.repo.openFlockDoc(docId);
    const catalog = getWorkspaceMcpCatalog(readWorkspaceFlockRowsFromFlock(handle.flock));
    const env = input.env ?? process.env;
    if (!input.prepare)
      return (agentCapabilities) =>
        resolveSessionMcpServers({ catalog, selectedIds, agentCapabilities, env });
    const prepared = new Map<string, ResolvedMcpServer>();
    const failed = new Set<string>();
    const ids = normalizeMcpServerIdSelection(selectedIds) ?? [];
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
      return result;
    };
  } catch (error) {
    const reason = formatErrorMessage(error);
    logger.debug(`[${sessionId}] Workspace MCP catalog read failed: ${reason}`);
    return () => ({ servers: [], problems: [{ kind: 'catalog_unavailable', reason }] });
  }
};
