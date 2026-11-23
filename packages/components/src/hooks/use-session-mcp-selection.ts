import { createStore, createStaticStore, type MutableStore } from '@lody/platform';
import { useStoreValue } from '@lody/platform/react';
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
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { useWorkspaceCatalog } from './use-workspace-catalog';
import { retryWorkspaceCatalog } from '@/lib/workspace-catalog-room';

export type SessionMcpSelection = {
  servers: WorkspaceMcpServerMeta[];
  selectedIds: McpServerId[];
  setSelectedIds: (ids: readonly McpServerId[]) => void;
  /** Ready to hand to `AttachmentAddMenu`; undefined when the catalog is empty. */
  menu: AttachmentAddMenuMcp | undefined;
  /**
   * Whether `selectedIds` can be sent. False only while its
   * selection still comes from a local catalog that has not been read: sending
   * then would silently author a turn with no MCP servers.
   */
  ready: boolean;
  /** The defaults this selection depends on could not be read at all. */
  defaultsFailed: boolean;
  retryDefaults: () => void;
  /** Renderer-local recovery, recorded only after a send is accepted. */
  acceptSend: (sessionId: string, skipMcpOnce?: boolean) => void;
  recoveryGeneration: { readonly current: number };
  send: (
    sessionId: string,
    options: { mcpServerIds?: readonly McpServerId[]; skipMcpOnce?: boolean } | undefined,
    dispatch: (ids: readonly McpServerId[]) => Promise<boolean>,
    onBlocked: (failed: boolean) => void
  ) => Promise<boolean>;
};

/** The project a NEW conversation is created in; its defaults preselect servers. */
export type SessionMcpDefaultsTarget = {
  project: ProjectRef | null | undefined;
  /** The project's machine; identifies a local project only. */
  machineId?: string | null;
};

const NO_IDS: McpServerId[] = [];
// Recovery belongs to this renderer/runtime, never the durable turn or daemon.
// A successful ordinary send consumes the entry; retiring the runtime releases it.
const recoveryStores = new WeakMap<WorkspaceRuntime, MutableStore<ReadonlySet<string>>>();
const NO_RECOVERY = createStaticStore<ReadonlySet<string>>(new Set());
function recoveryStore(runtime: WorkspaceRuntime) {
  let store = recoveryStores.get(runtime);
  if (!store) {
    store = createStore<ReadonlySet<string>>(new Set());
    recoveryStores.set(runtime, store);
  }
  return store;
}

/**
 * The MCP selection a composer sends with.
 *
 * - An existing conversation keeps what it recorded — including `[]`, which
 *   nothing here may overwrite — and one that never recorded any stays empty:
 *   defaults are for creating a conversation, not for enrolling an old one.
 *   A successful one-send opt-out explicitly resumes defaults in this renderer
 *   until the next ordinary accepted send records the normal selection.
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
  const recoveryGeneration = useRef(0);
  useEffect(
    () => () => {
      recoveryGeneration.current += 1;
    },
    [runtime, scopeKey]
  );
  const recovery = useStoreValue(runtime ? recoveryStore(runtime) : NO_RECOVERY);
  const resumeDefaults = !!scopeKey && recovery.has(scopeKey);
  const inheritDefaults = !existingSession || resumeDefaults;
  const { servers, synced, loaded, failed, projectMcpDefaults } = useWorkspaceCatalog();
  const projectKey = inheritDefaults
    ? getProjectMcpKey(defaultsTarget?.project, defaultsTarget?.machineId)
    : undefined;
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
    () => (inheritDefaults ? getEffectiveDefaultMcpIds(servers, preference) : NO_IDS),
    [inheritDefaults, preference, servers]
  );
  const baseline = resumeDefaults ? undefined : persistedIds;
  const baseSelection = scopedOverride ?? baseline ?? defaultSelectedIds;
  const selectedIds = useMemo(() => {
    // An empty catalog is authoritative only after the first remote sync. Until
    // then, preserve persisted ids so a fast send cannot erase a session's MCP
    // selection while the local catalog handle is still opening.
    if (servers.length === 0 && !synced) return [...new Set(baseSelection)];
    const availableIds = new Set(servers.map(({ id }) => id));
    return [...new Set(baseSelection)].filter((id) => availableIds.has(id));
  }, [baseSelection, servers, synced]);

  const dependsOnDefaults =
    inheritDefaults && scopedOverride === undefined && baseline === undefined;
  // Defaults come from the locally read snapshot. Remote catch-up never gates a
  // send: a slow or offline room would otherwise block every new conversation,
  // and the selection stays visible and editable in the composer meanwhile.
  const ready = !dependsOnDefaults || (runtime != null && loaded);

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

  const retryDefaults = useCallback(() => {
    if (runtime) retryWorkspaceCatalog(runtime);
  }, [runtime]);

  const acceptSend = useCallback(
    (sessionId: string, skipMcpOnce = false) => {
      recoveryGeneration.current += 1;
      if (!runtime) return;
      const store = recoveryStore(runtime);
      if (store.get().has(sessionId) === skipMcpOnce) return;
      const next = new Set(store.get());
      if (skipMcpOnce) next.add(sessionId);
      else next.delete(sessionId);
      store.set(next);
    },
    [runtime]
  );

  const send: SessionMcpSelection['send'] = useCallback(
    async (sessionId, sendOptions, dispatch, onBlocked) => {
      if (sendOptions?.mcpServerIds === undefined && !ready) {
        onBlocked(dependsOnDefaults && failed);
        return false;
      }
      const accepted = await dispatch(sendOptions?.mcpServerIds ?? selectedIds);
      if (accepted) acceptSend(sessionId, sendOptions?.skipMcpOnce);
      return accepted;
    },
    [acceptSend, dependsOnDefaults, failed, ready, selectedIds]
  );

  return {
    servers,
    selectedIds,
    setSelectedIds,
    menu,
    ready,
    defaultsFailed: dependsOnDefaults && failed,
    retryDefaults,
    acceptSend,
    recoveryGeneration,
    send,
  };
}
