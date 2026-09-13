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
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';
import type { WorkspaceMcpAuthService } from '@/mcp/workspace-mcp-auth-service';

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
  authService?: Pick<
    WorkspaceMcpAuthService,
    'resolveConnection' | 'removeOrphanedBindings' | 'hasStoredBindings'
  >;
  selectedIds: readonly McpServerId[];
  logger: { debug(message: string): void };
  env?: Readonly<Record<string, string | undefined>>;
};

const CATALOG_SYNC_TIMEOUT_MS = 5_000;

const EMPTY_SELECTION: SessionMcpCatalogSelector = () => ({ servers: [], problems: [] });

const cleanupOrphanedBindingsInBackground = (input: LoadSessionMcpCatalogInput): void => {
  const { authService, logger, sessionId } = input;
  if (!authService) return;
  void (async () => {
    if (!(await authService.hasStoredBindings())) return;
    const docId = getWorkspaceFlockDocId(input.workspaceId);
    if (input.syncFlockDoc) {
      try {
        await input.syncFlockDoc(docId, { timeoutMs: CATALOG_SYNC_TIMEOUT_MS });
      } catch (error) {
        logger.debug(
          `[${sessionId}] Workspace MCP orphan cleanup refresh failed; using local rows: ${formatErrorMessage(error)}`
        );
      }
    }
    const handle = await input.repo.openFlockDoc(docId);
    const catalog = getWorkspaceMcpCatalog(readWorkspaceFlockRowsFromFlock(handle.flock));
    const validBuiltinIds = new Set(
      Object.values(catalog)
        .filter((entry) => entry.source?.kind === 'builtin')
        .map((entry) => entry.id)
    );
    await authService.removeOrphanedBindings(validBuiltinIds);
  })().catch((error) => {
    logger.debug(
      `[${sessionId}] Workspace MCP orphan cleanup failed: ${formatErrorMessage(error)}`
    );
  });
};

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
    cleanupOrphanedBindingsInBackground(input);
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
    const resolvedCatalog = { ...catalog };
    if (input.authService) {
      const validBuiltinIds = new Set(
        Object.values(catalog)
          .filter((entry) => entry.source?.kind === 'builtin')
          .map((entry) => entry.id)
      );
      await input.authService.removeOrphanedBindings(validBuiltinIds);
      await Promise.all(
        selectedIds.map(async (mcpServerId) => {
          const entry = catalog[mcpServerId];
          if (entry?.source?.kind !== 'builtin') return;
          try {
            const connection = await input.authService!.resolveConnection(entry);
            if (connection) {
              resolvedCatalog[mcpServerId] = { ...entry, connection, source: undefined };
            }
          } catch (error) {
            logger.debug(
              `[${sessionId}] Built-in MCP credential refresh failed for ${entry.name}: ${formatErrorMessage(error)}`
            );
          }
        })
      );
    }
    return (agentCapabilities) => {
      return resolveSessionMcpServers({
        catalog: resolvedCatalog,
        selectedIds,
        agentCapabilities,
        env,
      });
    };
  } catch (error) {
    const reason = formatErrorMessage(error);
    logger.debug(`[${sessionId}] Workspace MCP catalog read failed: ${reason}`);
    return () => ({ servers: [], problems: [{ kind: 'catalog_unavailable', reason }] });
  }
};
