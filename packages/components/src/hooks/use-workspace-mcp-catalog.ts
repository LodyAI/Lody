import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import type { McpServerId, WorkspaceMcpServerMeta } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { deleteWorkspaceMcpServer, putWorkspaceMcpServer } from '@/lib/workspace-catalog-write';

export type WorkspaceMcpCatalogSnapshot = {
  servers: WorkspaceMcpServerMeta[];
  synced: boolean;
  /** Local projection is materialized; editing never waits for remote upload. */
  loaded: boolean;
};

/**
 * The MCP half of the shared workspace catalog room.
 *
 * Derived rather than separately subscribed: MCP servers and Agent Roles are
 * two families of one document, so both read the same room. The room's snapshot
 * is returned as-is — re-wrapping it would trade its cross-mount identity for a
 * per-hook one, which is exactly what the selection and composer-menu memos
 * downstream rely on.
 */
export function useWorkspaceMcpCatalog(): WorkspaceMcpCatalogSnapshot {
  return useWorkspaceCatalog();
}

export function useWorkspaceMcpCatalogActions(): {
  /** Resolves on durability; the upload runs on its own and is not reported. */
  upsert: (entry: WorkspaceMcpServerMeta) => Promise<void>;
  remove: (id: McpServerId) => Promise<void>;
} {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const upsert = useCallback(
    async (entry: WorkspaceMcpServerMeta) => {
      if (!runtime) throw new Error('Workspace runtime is unavailable');
      return putWorkspaceMcpServer(runtime, entry);
    },
    [runtime]
  );
  const remove = useCallback(
    async (id: McpServerId) => {
      if (!runtime) throw new Error('Workspace runtime is unavailable');
      return deleteWorkspaceMcpServer(runtime, id);
    },
    [runtime]
  );
  return { upsert, remove };
}
