import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  getEffectiveDefaultMcpIds,
  getProjectMcpKey,
  type McpServerId,
  type ProjectRef,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import type { AttachmentAddMenuMcp } from '@/components/chat/attachment-add-menu';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import {
  acquireWorkspaceCatalog,
  type WorkspaceCatalogSnapshot,
} from '@/lib/workspace-catalog-room';
import { useWorkspaceCatalog } from './use-workspace-catalog';

export type SessionMcpSelection = {
  servers: WorkspaceMcpServerMeta[];
  selectedIds: McpServerId[];
  setSelectedIds: (ids: readonly McpServerId[]) => void;
  /** Ready to hand to `AttachmentAddMenu`; undefined when the catalog is empty. */
  menu: AttachmentAddMenuMcp | undefined;
  /**
   * Whether `selectedIds` can be sent. False only while a new conversation's
   * selection still comes from a local catalog that has not been read: sending
   * then would silently author a turn with no MCP servers.
   */
  ready: boolean;
  /** Capture the send selection, waiting at most two seconds for defaults. */
  resolveForSend: () => Promise<McpServerId[]>;
};

/** The project a NEW conversation is created in; its defaults preselect servers. */
export type SessionMcpDefaultsTarget = {
  project: ProjectRef | null | undefined;
  /** The project's machine; identifies a local project only. */
  machineId?: string | null;
};

const NO_IDS: McpServerId[] = [];

/**
 * The MCP selection a composer sends with.
 *
 * - An existing conversation keeps what it recorded — including `[]`, which
 *   nothing here may overwrite — and one that never recorded any stays empty:
 *   defaults are for creating a conversation, not for enrolling an old one.
 * - A new conversation starts from its target project's defaults (or the
 *   workspace's, when it has no project or the project has no list).
 *
 * The user's edits are scoped to workspace, `scopeKey`, target project and the
 * recorded selection, and are dropped in the same render any of them changes —
 * an effect would leave one frame (and one possible send) carrying the previous
 * project's choice.
 */
export function useSessionMcpSelection(
  persistedIds: readonly McpServerId[] | undefined,
  options: {
    existingSession?: boolean;
    disabled?: boolean;
    /** The draft/session the composer edits; a different one starts clean. */
    scopeKey?: string;
    defaultsTarget?: SessionMcpDefaultsTarget;
  } = {}
): SessionMcpSelection {
  const { existingSession, disabled, scopeKey, defaultsTarget } = options;
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { servers, synced, loaded, projectMcpDefaults } = useWorkspaceCatalog();
  const projectKey = existingSession
    ? undefined
    : getProjectMcpKey(defaultsTarget?.project, defaultsTarget?.machineId);
  const preference = projectKey ? projectMcpDefaults[projectKey] : undefined;
  const persistedKey = persistedIds ? `ids:${persistedIds.join('\0')}` : 'none';
  const scope = [runtime?.workspaceId ?? '', scopeKey ?? '', projectKey ?? '', persistedKey].join(
    '\u0001'
  );
  const [override, setOverride] = useState<{ scope: string; ids: McpServerId[] }>();
  const scopedOverride = override?.scope === scope ? override.ids : undefined;
  // Forget an edit once its scope is left, so returning to that project later
  // starts from its defaults again. Render-phase, like the read above.
  if (override && scopedOverride === undefined) setOverride(undefined);

  // Memoized so a caller with no persisted ids (a fresh draft/landing composer)
  // gets an identity-stable selection; a fresh array here would invalidate
  // every send-payload/menu memo built on `selectedIds` each render.
  const defaultSelectedIds = useMemo(
    () => (existingSession ? NO_IDS : getEffectiveDefaultMcpIds(servers, preference)),
    [existingSession, preference, servers]
  );
  const baseSelection = scopedOverride ?? persistedIds ?? defaultSelectedIds;
  const selectedIds = useMemo(() => {
    // An empty catalog is authoritative only after the first remote sync. Until
    // then, preserve persisted ids so a fast send cannot erase a session's MCP
    // selection while the local catalog handle is still opening.
    if (servers.length === 0 && !synced) return [...new Set(baseSelection)];
    const availableIds = new Set(servers.map(({ id }) => id));
    return [...new Set(baseSelection)].filter((id) => availableIds.has(id));
  }, [baseSelection, servers, synced]);

  const dependsOnDefaults =
    !existingSession && scopedOverride === undefined && persistedIds === undefined;
  // Use the latest locally available snapshot. The shared room applies remote
  // updates in the background; opening a composer never requires fresh catch-up.
  const ready = !dependsOnDefaults || (runtime != null && loaded);
  const pendingSends = useRef(new Set<() => void>());
  useEffect(() => {
    const pending = pendingSends.current;
    return () => {
      for (const cancel of pending) cancel();
    };
  }, [runtime, scope]);

  const resolveForSend = async (): Promise<McpServerId[]> => {
    if (ready) return [...selectedIds];
    if (!runtime) throw new Error('MCP defaults unavailable');
    // Borrow the already-opening room. The deadline releases only this waiter;
    // background synchronization and other catalog consumers retain their owner.
    return new Promise((resolve, reject) => {
      function check(snapshot: WorkspaceCatalogSnapshot) {
        if (snapshot.loaded) {
          finish(
            getEffectiveDefaultMcpIds(
              snapshot.servers,
              projectKey ? snapshot.projectMcpDefaults[projectKey] : undefined
            )
          );
        } else if (snapshot.failed) finish();
      }
      const lease = acquireWorkspaceCatalog(runtime, check);
      const timer = setTimeout(() => finish(), 2_000);
      function finish(ids?: McpServerId[]) {
        clearTimeout(timer);
        lease.release();
        pendingSends.current.delete(finish);
        if (ids) resolve(ids);
        else reject(new Error('MCP defaults unavailable'));
      }
      pendingSends.current.add(finish);
      check(lease.snapshot);
    });
  };

  // Stable per scope so menu props built from this selection do not churn every render.
  const setSelectedIds = useCallback(
    (ids: readonly McpServerId[]) => setOverride({ scope, ids: [...ids] }),
    [scope]
  );

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

  return {
    servers,
    selectedIds,
    setSelectedIds,
    menu,
    ready,
    resolveForSend,
  };
}
