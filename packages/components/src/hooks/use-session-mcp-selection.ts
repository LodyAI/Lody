import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getDefaultSelectedMcpServerIds,
  type McpServerId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import type { AttachmentAddMenuMcp } from '@/components/chat/attachment-add-menu';
import { useWorkspaceMcpCatalog } from './use-workspace-mcp-catalog';

export type SessionMcpSelection = {
  servers: WorkspaceMcpServerMeta[];
  selectedIds: McpServerId[];
  setSelectedIds: (ids: readonly McpServerId[]) => void;
  /** Ready to hand to `AttachmentAddMenu`; undefined when the catalog is empty. */
  menu: AttachmentAddMenuMcp | undefined;
};

export function useSessionMcpSelection(
  persistedIds: readonly McpServerId[] | undefined,
  menuOptions: { existingSession?: boolean; disabled?: boolean } = {}
): SessionMcpSelection {
  const { existingSession, disabled } = menuOptions;
  const { servers, synced } = useWorkspaceMcpCatalog();
  const persistedKey = persistedIds?.join('\0');
  const [override, setOverride] = useState<McpServerId[] | undefined>();

  useEffect(() => {
    setOverride(undefined);
  }, [persistedKey]);

  // Memoized so a caller with no persisted ids (a fresh draft/landing composer)
  // gets an identity-stable selection; a fresh array here would invalidate
  // every send-payload/menu memo built on `selectedIds` each render.
  const defaultSelectedIds = useMemo(() => getDefaultSelectedMcpServerIds(servers), [servers]);
  const baseSelection = override ?? persistedIds ?? defaultSelectedIds;
  const selectedIds = useMemo(() => {
    // An empty catalog is authoritative only after the first remote sync. Until
    // then, preserve persisted ids so a fast send cannot erase a session's MCP
    // selection while the local catalog handle is still opening.
    if (servers.length === 0 && !synced) return [...new Set(baseSelection)];
    const availableIds = new Set(servers.map(({ id }) => id));
    return [...new Set(baseSelection)].filter((id) => availableIds.has(id));
  }, [baseSelection, servers, synced]);

  // Stable so menu props built from this selection do not churn every render.
  const setSelectedIds = useCallback((ids: readonly McpServerId[]) => setOverride([...ids]), []);

  /* MCP lives in the composer's "+" menu (second level), not the footer row: it
     is a per-turn attachment-shaped choice, not a run knob. */
  const menu = useMemo<AttachmentAddMenuMcp | undefined>(
    () =>
      servers.length > 0
        ? {
            servers,
            selectedIds,
            onSelectedIdsChange: setSelectedIds,
            existingSession: existingSession ?? false,
            disabled: disabled ?? false,
          }
        : undefined,
    [disabled, existingSession, selectedIds, servers, setSelectedIds]
  );

  return { servers, selectedIds, setSelectedIds, menu };
}
