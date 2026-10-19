import { useCallback, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  getEffectiveDefaultMcpIds,
  getProjectMcpKey,
  type McpServerId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import {
  putProjectMcpDefault,
  resolveProjectMcpDefaultManagement,
  type ProjectMcpDefaultAccess,
  type ProjectMcpDefaultManagement,
  type ProjectMcpDefaultTarget,
} from '@/lib/workspace-catalog-write';

export type ProjectMcpDefaultStatus = 'loading' | 'failed' | 'ready';

export type ProjectMcpDefaultModel = {
  status: ProjectMcpDefaultStatus;
  servers: readonly WorkspaceMcpServerMeta[];
  /** What a new conversation in this project starts with. */
  selectedIds: readonly McpServerId[];
  /** The project has its own list rather than following the workspace defaults. */
  customized: boolean;
  management: ProjectMcpDefaultManagement;
  saving: boolean;
  saveFailed: boolean;
  /** Resolves on local durability; rejects when the write was refused or failed. */
  setServerEnabled: (id: McpServerId, enabled: boolean) => Promise<void>;
};

/**
 * One project's default MCP selection, read from the workspace catalog room
 * and written through the authorized catalog writer.
 *
 * Callers key the owning component by project, so save state never carries
 * from one project to the next.
 */
export function useProjectMcpDefault(
  target: ProjectMcpDefaultTarget,
  access: ProjectMcpDefaultAccess
): ProjectMcpDefaultModel {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const catalog = useWorkspaceCatalog();
  const projectKey = getProjectMcpKey(target.project, target.machineId);
  const preference = projectKey ? catalog.projectMcpDefaults[projectKey] : undefined;
  const selectedIds = useMemo(
    () => getEffectiveDefaultMcpIds(catalog.servers, preference),
    [catalog.servers, preference]
  );
  const management = resolveProjectMcpDefaultManagement(target, access);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const setServerEnabled = useCallback(
    async (id: McpServerId, enabled: boolean) => {
      if (!runtime) throw new Error('Workspace runtime is unavailable');
      // The first edit writes the whole effective list with this change, so a
      // project that customizes one switch keeps every other default it had.
      const next = enabled
        ? [...selectedIds.filter((selected) => selected !== id), id]
        : selectedIds.filter((selected) => selected !== id);
      setSaving(true);
      setSaveFailed(false);
      try {
        await putProjectMcpDefault(runtime, target, access, next);
      } catch (error) {
        setSaveFailed(true);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [access, runtime, selectedIds, target]
  );

  const status: ProjectMcpDefaultStatus = catalog.loaded
    ? 'ready'
    : catalog.failed
      ? 'failed'
      : 'loading';

  return {
    status,
    servers: catalog.servers,
    selectedIds,
    customized: preference !== undefined,
    management,
    saving,
    saveFailed,
    setServerEnabled,
  };
}
