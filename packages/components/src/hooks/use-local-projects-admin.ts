import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { useCloudMutation } from '@lody/platform/react';
import { toast } from '@/lib/toast';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  getLocalProjectHistoryProviderKey,
  resolveWorktreeSetupShellForPlatform,
  type AgentConfigMeta,
  type LocalProjectHistoryCatalogItem,
  type LocalProjectHistoryCatalogResult,
  type LocalProjectHistoryProvider,
  type LocalProjectHistoryProviderKey,
  type LocalProjectHistorySyncSummary,
  type MachineId,
  type SessionId,
  type WorktreeCleanupScriptConfig,
  type WorktreeSetupScriptConfig,
} from '@lody/shared';
import { getAllAgentConfigAtom, runtimeAtom, userAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { useAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { getLocalProjectVisibilityKey } from '@/lib/visible-local-project-index';
import { useConvexErrorMessage } from '@/hooks/use-convex-error-message';
import {
  canUseProjectHistoryProjectControl,
  importProjectHistoryForLocalProject,
  resolveProjectHistoryConflictForLocalProject,
  syncProjectHistoryForLocalProject,
} from '@/lib/project-history-control-client';
import { reconcileLocalProjectHistoryCatalog } from '@/lib/local-project-history-catalog';
import { worktreeCleanupConfigCache, worktreeSetupConfigCache } from '@/lib/local-storage-cache';
import { projectSharingReducer } from '@/lib/project-sharing-state';
import { useAppCapability } from '@/lib/app-platform';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import type {
  ProjectHistoryImportState,
  ProjectSettingsRow,
  ProjectSettingsSection,
} from '@/components/settings/project-settings';
import {
  catalogFromProject,
  historyStateKey,
  sortProjectRows,
} from '@/components/settings/project-settings';

/* Shared backing store for both the desktop `/settings/projects` page
   and the per-project mobile detail surface (`MobileLocalProjectSettings`).
   Owns the sections + handler set so both consumers stay in lockstep
   on field shapes; the only difference between them is whether they
   render every row or filter to a single project. */
export type LocalProjectsAdminHandlers = {
  onSharedWithTeamChange: (row: ProjectSettingsRow, sharedWithTeam: boolean) => Promise<void>;
  onSyncHistory: (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider) => Promise<void>;
  onImportHistory: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider
  ) => Promise<void>;
  onResolveHistoryConflict: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    session: LocalProjectHistoryCatalogItem
  ) => Promise<void>;
  onHistorySelectionChange: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    selectedIds: string[]
  ) => void;
  onWorktreeSetupChange: (
    row: ProjectSettingsRow,
    config: WorktreeSetupScriptConfig
  ) => Promise<void>;
  onWorktreeCleanupChange: (
    row: ProjectSettingsRow,
    config: WorktreeCleanupScriptConfig
  ) => Promise<void>;
};

export type LocalProjectsAdminData = {
  sections: ProjectSettingsSection[];
  isLoading: boolean;
} & LocalProjectsAdminHandlers;

function buildHistoryProvidersForMachine(
  configs: AgentConfigMeta[],
  machineId: MachineId
): LocalProjectHistoryProvider[] {
  const byKey = new Map<LocalProjectHistoryProviderKey, LocalProjectHistoryProvider>();
  for (const config of configs) {
    if (config.machineId !== machineId) continue;
    const provider = { cliType: config.cliType, agentType: config.agentType };
    byKey.set(getLocalProjectHistoryProviderKey(provider), provider);
  }
  return [...byKey.values()];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const EMPTY_WORKTREE_SETUP: WorktreeSetupScriptConfig = {
  scripts: {},
};

/* Field-wise equality for a script config. Used to decide whether a freshly
   fetched CLI config matches what's already on screen (from the persisted
   cache). A plain JSON.stringify compare would be fooled by key ordering and
   by `undefined` vs `''` shells, so compare the rendered-equivalent values:
   an absent shell and an empty shell look identical in the editor. */
function worktreeConfigsEqual(a: WorktreeSetupScriptConfig, b: WorktreeSetupScriptConfig): boolean {
  return (
    (a.scripts.bash ?? '') === (b.scripts.bash ?? '') &&
    (a.scripts.powershell ?? '') === (b.scripts.powershell ?? '') &&
    (a.timeoutMs ?? null) === (b.timeoutMs ?? null)
  );
}

type WorktreeScriptConfigCache = typeof worktreeSetupConfigCache;

const WORKTREE_CONFIG_PHASES = {
  setup: {
    getRequestType: 'local-project/get-worktree-setup',
    setRequestType: 'local-project/set-worktree-setup',
    loadError: 'Failed to load worktree setup.',
    saveError: 'Failed to save worktree setup.',
  },
  cleanup: {
    getRequestType: 'local-project/get-worktree-cleanup',
    setRequestType: 'local-project/set-worktree-cleanup',
    loadError: 'Failed to load worktree cleanup.',
    saveError: 'Failed to save worktree cleanup.',
  },
} as const;

type WorktreeConfigPhase = keyof typeof WORKTREE_CONFIG_PHASES;

function useWorktreeScriptConfigState(cache: WorktreeScriptConfigCache) {
  /* Seed from the persisted cache so the editor renders the last-known script
     immediately instead of a spinner on first visit. The reconcile effect then
     refetches from the CLI and only swaps the value in if it changed. */
  const [byKey, setByKey] = useState<Record<string, WorktreeSetupScriptConfig>>(() =>
    cache.readAll()
  );
  const [loadingByKey, setLoadingByKey] = useState<Record<string, boolean>>({});
  const [savingByKey, setSavingByKey] = useState<Record<string, boolean>>({});
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
  /* Keys already requested from the CLI this mount. The cache pre-populates
     `byKey`, so "has a value" can no longer mean "already fetched" — track the
     fetch explicitly so the reconcile request still fires exactly once per key. */
  const requestedRef = useRef<Set<string>>(new Set());

  return {
    byKey,
    setByKey,
    loadingByKey,
    setLoadingByKey,
    savingByKey,
    setSavingByKey,
    errorByKey,
    setErrorByKey,
    requestedRef,
    cache,
  };
}

/**
 * Subscribes to the same atoms + Convex mutations as the original
 * `ProjectSettingsComponent` and exposes the sections + handlers it
 * needs. Both `ProjectSettingsComponent` and `MobileLocalProjectSettings`
 * call this hook so they share the same data model and produce
 * identical `ProjectSettingsRow` shapes.
 */
export function useLocalProjectsAdmin(): LocalProjectsAdminData {
  const { t } = useTranslation();
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const onlineMachineIds = useOnlineMachineIds();
  const { isAuthenticated, isLoading: isConvexAuthLoading } = useAuthenticatedConvex();
  /* Read the raw runtime, NOT `activeWorkspaceRuntimeAtom`.
     `activeWorkspaceRuntimeAtom` returns `null` whenever the route's
     workspace slug doesn't match the runtime's — that guard makes
     sense for chat / session ACTIONS (PR #2220), but reading
     read-only project metadata is fine even mid-route-switch.
     Going through the stricter atom caused the ACP-history "Sync"
     section to flicker / stay hidden on Capacitor mobile, where the
     slug atom takes a beat longer to settle after route changes.
     The desktop path doesn't hit this because Electron loads the
     route synchronously from the URL on cold start. */
  const runtime = useAtomValue(runtimeAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const sessionMetas = useAtomValue(sessionMetaCacheAtom);
  const { projects, accessByProjectKey, accessByMachineId, isLoading } = useVisibleLocalProjects();
  const getConvexErrorMessage = useConvexErrorMessage();
  // Team sharing is cloud-only; on the local platform the sharing controls are
  // hidden and canUpdateSharing stays false as a logic-gate.
  const teamSharingAvailable = useAppCapability('teamSharing');
  const sessionMetaList = useMemo(() => Object.values(sessionMetas), [sessionMetas]);
  const setLocalProjectSharedWithTeam = useCloudMutation(
    cloudOperations.localProjects.setLocalProjectSharedWithTeam
  );

  const [sharingByKey, dispatchSharing] = useReducer(projectSharingReducer, {});
  const sharingRequestIdRef = useRef(0);
  const [syncingByKey, setSyncingByKey] = useState<Record<string, boolean>>({});
  const [importingByKey, setImportingByKey] = useState<Record<string, boolean>>({});
  const [resolvingByKey, setResolvingByKey] = useState<Record<string, Record<string, boolean>>>({});
  const [resolvedConflictByKey, setResolvedConflictByKey] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [catalogByKey, setCatalogByKey] = useState<
    Record<string, LocalProjectHistoryCatalogResult>
  >({});
  const [selectedSessionIdsByKey, setSelectedSessionIdsByKey] = useState<Record<string, string[]>>(
    {}
  );
  const [syncSummariesByKey, setSyncSummariesByKey] = useState<
    Record<string, LocalProjectHistorySyncSummary>
  >({});
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
  const {
    byKey: worktreeSetupByKey,
    setByKey: setWorktreeSetupByKey,
    loadingByKey: worktreeSetupLoadingByKey,
    setLoadingByKey: setWorktreeSetupLoadingByKey,
    savingByKey: worktreeSetupSavingByKey,
    setSavingByKey: setWorktreeSetupSavingByKey,
    errorByKey: worktreeSetupErrorByKey,
    setErrorByKey: setWorktreeSetupErrorByKey,
    requestedRef: worktreeSetupRequestedRef,
  } = useWorktreeScriptConfigState(worktreeSetupConfigCache);
  const {
    byKey: worktreeCleanupByKey,
    setByKey: setWorktreeCleanupByKey,
    loadingByKey: worktreeCleanupLoadingByKey,
    setLoadingByKey: setWorktreeCleanupLoadingByKey,
    savingByKey: worktreeCleanupSavingByKey,
    setSavingByKey: setWorktreeCleanupSavingByKey,
    errorByKey: worktreeCleanupErrorByKey,
    setErrorByKey: setWorktreeCleanupErrorByKey,
    requestedRef: worktreeCleanupRequestedRef,
  } = useWorktreeScriptConfigState(worktreeCleanupConfigCache);

  useEffect(() => {
    const sharedWithTeamByKey = new Map<string, boolean>();
    for (const [key, access] of accessByProjectKey) {
      sharedWithTeamByKey.set(key, access.sharedWithTeam);
    }
    dispatchSharing({ type: 'reconcile', sharedWithTeamByKey });
  }, [accessByProjectKey, sharingByKey]);

  useEffect(() => {
    if (!runtime || !workspaceId || !currentUserId) return;
    if (typeof window !== 'undefined' && window.__LODY_ELECTRON__ && !localMachineId) return;
    const ownedEntries = Array.from(projects.values()).filter((entry) => {
      if (entry.machine.ownerUserId !== currentUserId) return false;
      // Offline remotes have no RPC stream. Probing them surfaces
      // `machine_rpc_unavailable` in the worktree editors. The local
      // machine still answers even if presence is stale.
      if (localMachineId && entry.machineId === localMachineId) return true;
      return onlineMachineIds.has(entry.machineId);
    });

    const loadPhase = (
      phase: WorktreeConfigPhase,
      state: {
        byKey: Record<string, WorktreeSetupScriptConfig>;
        setByKey: typeof setWorktreeSetupByKey;
        setLoadingByKey: typeof setWorktreeSetupLoadingByKey;
        setErrorByKey: typeof setWorktreeSetupErrorByKey;
        requestedRef: MutableRefObject<Set<string>>;
        cache: WorktreeScriptConfigCache;
      }
    ) => {
      /* Reconcile every owned project against the CLI exactly once per mount.
         The cache may already populate `byKey`, so dedup on the requested-set
         rather than on value presence — otherwise cached entries would never
         refetch. */
      const requested = state.requestedRef.current;
      const missing = ownedEntries.filter((entry) => !requested.has(entry.key));
      if (missing.length === 0) return;
      for (const entry of missing) {
        requested.add(entry.key);
      }

      const spec = WORKTREE_CONFIG_PHASES[phase];
      /* Only show the loading placeholder when there's nothing cached to show.
         When a cached config is already on screen we refetch silently and only
         swap it in if the CLI reports something different. */
      const needsSpinner = missing.filter((entry) => state.byKey[entry.key] === undefined);
      if (needsSpinner.length > 0) {
        state.setLoadingByKey((current) => {
          const next = { ...current };
          for (const entry of needsSpinner) {
            next[entry.key] = true;
          }
          return next;
        });
      }

      for (const entry of missing) {
        const hadCachedValue = state.byKey[entry.key] !== undefined;
        void runtime
          .requestLocalProjectControl(
            {
              type: spec.getRequestType,
              machineId: entry.machineId,
              workspaceId,
              localProjectId: entry.project.id,
              requestedByUserId: currentUserId,
            },
            { timeoutMs: 15_000 }
          )
          .then((response) => {
            if (!response?.ok) {
              throw new Error(response?.message ?? spec.loadError);
            }
            if (response.type !== spec.getRequestType) {
              throw new Error(`Unexpected response type: ${response.type}`);
            }
            const nextConfig = response.result ?? EMPTY_WORKTREE_SETUP;
            // Keep the durable cache current regardless of UI state so the next
            // cold load starts from the freshest known config.
            state.cache.set(entry.key, nextConfig);
            state.setByKey((current) => {
              const existing = current[entry.key];
              // Already consistent with what's on screen → leave UI state
              // untouched so we don't re-render or clobber in-progress edits.
              if (existing !== undefined && worktreeConfigsEqual(existing, nextConfig)) {
                return current;
              }
              return { ...current, [entry.key]: nextConfig };
            });
            state.setErrorByKey((current) => {
              const { [entry.key]: _, ...rest } = current;
              return rest;
            });
          })
          .catch((error) => {
            // We're already rendering cached content; a failed background
            // refresh shouldn't replace it with an error banner. Only surface
            // load errors when there was nothing cached to fall back to.
            if (hadCachedValue) return;
            state.setErrorByKey((current) => ({
              ...current,
              [entry.key]: toErrorMessage(error),
            }));
          })
          .finally(() => {
            state.setLoadingByKey((current) => {
              if (current[entry.key] === undefined) return current;
              const { [entry.key]: _, ...rest } = current;
              return rest;
            });
          });
      }
    };

    loadPhase('setup', {
      byKey: worktreeSetupByKey,
      setByKey: setWorktreeSetupByKey,
      setLoadingByKey: setWorktreeSetupLoadingByKey,
      setErrorByKey: setWorktreeSetupErrorByKey,
      requestedRef: worktreeSetupRequestedRef,
      cache: worktreeSetupConfigCache,
    });
    loadPhase('cleanup', {
      byKey: worktreeCleanupByKey,
      setByKey: setWorktreeCleanupByKey,
      setLoadingByKey: setWorktreeCleanupLoadingByKey,
      setErrorByKey: setWorktreeCleanupErrorByKey,
      requestedRef: worktreeCleanupRequestedRef,
      cache: worktreeCleanupConfigCache,
    });
  }, [
    currentUserId,
    localMachineId,
    onlineMachineIds,
    projects,
    runtime,
    setWorktreeCleanupByKey,
    setWorktreeCleanupErrorByKey,
    setWorktreeCleanupLoadingByKey,
    setWorktreeSetupByKey,
    setWorktreeSetupErrorByKey,
    setWorktreeSetupLoadingByKey,
    worktreeCleanupByKey,
    worktreeCleanupRequestedRef,
    worktreeSetupByKey,
    worktreeSetupRequestedRef,
    workspaceId,
  ]);

  const sections = useMemo(() => {
    const conversationCountByKey = new Map<string, number>();
    for (const session of sessionMetaList) {
      const project = session.project;
      if (project?.kind !== 'local') continue;
      const key = getLocalProjectVisibilityKey(session.machineId, project.localProjectId);
      conversationCountByKey.set(key, (conversationCountByKey.get(key) ?? 0) + 1);
    }

    const grouped = new Map<MachineId, ProjectSettingsSection>();

    for (const entry of projects.values()) {
      if (!currentUserId || entry.machine.ownerUserId !== currentUserId) continue;
      const access = accessByProjectKey.get(entry.key);
      const machineName = entry.machine.name.trim() || entry.machine.id;
      const sharingUpdate = sharingByKey[entry.key];
      const canUseHistoryProjectControl = Boolean(workspaceId);
      const historyProviders = buildHistoryProvidersForMachine(agentConfigs, entry.machineId);
      const historyImports: ProjectHistoryImportState[] = historyProviders.map((provider) => {
        const key = historyStateKey(entry.key, provider);
        const providerKey = getLocalProjectHistoryProviderKey(provider);
        const rawCatalog = catalogByKey[key] ?? catalogFromProject(entry.project, provider);
        const resolvingSessionIds = Object.entries(resolvingByKey[key] ?? {})
          .filter(([, resolving]) => resolving)
          .map(([acpSessionId]) => acpSessionId);
        const resolvedSessionIds = Object.entries(resolvedConflictByKey[key] ?? {})
          .filter(([, resolved]) => resolved)
          .map(([acpSessionId]) => acpSessionId);
        const resolvedSessionSet = new Set(resolvedSessionIds);
        const reconciledCatalog = reconcileLocalProjectHistoryCatalog({
          catalog: rawCatalog,
          machineId: entry.machineId,
          localProjectId: entry.project.id,
          provider,
          sessionMetas: sessionMetaList,
        });
        const catalog =
          reconciledCatalog && resolvedSessionSet.size > 0
            ? {
                ...reconciledCatalog,
                sessions: reconciledCatalog.sessions.map((session) =>
                  resolvedSessionSet.has(session.acpSessionId)
                    ? { ...session, status: 'imported' as const }
                    : session
                ),
              }
            : reconciledCatalog;
        return {
          provider,
          providerKey,
          canSync:
            canUseHistoryProjectControl &&
            canUseProjectHistoryProjectControl({
              runtime,
              localMachineId,
              machineId: entry.machineId,
              supportsLocalProjectHistoryRpc: entry.machine.supportsLocalProjectHistoryRpc,
            }),
          isSyncing: syncingByKey[key] === true,
          isImporting: importingByKey[key] === true,
          catalog,
          syncSummary: syncSummariesByKey[key] ?? null,
          selectedSessionIds: selectedSessionIdsByKey[key] ?? [],
          resolvingSessionIds,
          errorMessage: errorByKey[key] ?? null,
        };
      });
      const row: ProjectSettingsRow = {
        key: entry.key,
        machineId: entry.machineId,
        machineName,
        shell: resolveWorktreeSetupShellForPlatform(entry.machine.os),
        project: entry.project,
        sharedWithTeam: sharingUpdate?.desired ?? access?.sharedWithTeam ?? false,
        conversationCount: conversationCountByKey.get(entry.key) ?? 0,
        // Keep the control locked until the reactive query confirms the write.
        // This prevents a second toggle from racing a delayed first query result.
        isUpdating: sharingUpdate !== undefined,
        canUpdateSharing: Boolean(
          teamSharingAvailable &&
          workspaceId &&
          isAuthenticated &&
          !isConvexAuthLoading &&
          entry.isMachineRegistered
        ),
        worktreeSetup: worktreeSetupByKey[entry.key] ?? EMPTY_WORKTREE_SETUP,
        isWorktreeSetupLoading: worktreeSetupLoadingByKey[entry.key] === true,
        isWorktreeSetupSaving: worktreeSetupSavingByKey[entry.key] === true,
        worktreeSetupError: worktreeSetupErrorByKey[entry.key] ?? null,
        worktreeCleanup: worktreeCleanupByKey[entry.key] ?? EMPTY_WORKTREE_SETUP,
        isWorktreeCleanupLoading: worktreeCleanupLoadingByKey[entry.key] === true,
        isWorktreeCleanupSaving: worktreeCleanupSavingByKey[entry.key] === true,
        worktreeCleanupError: worktreeCleanupErrorByKey[entry.key] ?? null,
        historyImports,
      };

      const section = grouped.get(entry.machineId);
      if (section) {
        section.rows.push(row);
      } else {
        grouped.set(entry.machineId, {
          machineId: entry.machineId,
          machineName,
          sharedWithTeam: accessByMachineId.get(entry.machineId)?.sharedWithTeam ?? false,
          rows: [row],
        });
      }
    }

    return Array.from(grouped.values())
      .map((section) => ({
        ...section,
        rows: sortProjectRows(section.rows),
      }))
      .sort((left, right) => left.machineName.localeCompare(right.machineName));
  }, [
    accessByMachineId,
    accessByProjectKey,
    agentConfigs,
    catalogByKey,
    currentUserId,
    errorByKey,
    importingByKey,
    isAuthenticated,
    isConvexAuthLoading,
    localMachineId,
    projects,
    resolvedConflictByKey,
    resolvingByKey,
    runtime,
    selectedSessionIdsByKey,
    sessionMetaList,
    sharingByKey,
    syncSummariesByKey,
    syncingByKey,
    teamSharingAvailable,
    worktreeSetupByKey,
    worktreeSetupErrorByKey,
    worktreeSetupLoadingByKey,
    worktreeSetupSavingByKey,
    worktreeCleanupByKey,
    worktreeCleanupErrorByKey,
    worktreeCleanupLoadingByKey,
    worktreeCleanupSavingByKey,
    workspaceId,
  ]);

  const onSharedWithTeamChange = useCallback(
    async (row: ProjectSettingsRow, sharedWithTeam: boolean) => {
      if (row.isUpdating) return;
      if (!workspaceId || !row.canUpdateSharing) {
        toast.error(
          t(
            'workspace.projects.shareNotReady',
            'Project sharing is still getting ready. Try again in a moment.'
          )
        );
        return;
      }
      const requestId = ++sharingRequestIdRef.current;
      dispatchSharing({ type: 'begin', key: row.key, desired: sharedWithTeam, requestId });
      try {
        await setLocalProjectSharedWithTeam({
          workspaceId,
          machineId: row.machineId,
          localProjectId: row.project.id,
          sharedWithTeam,
        });
        dispatchSharing({
          type: 'succeeded',
          key: row.key,
          requestId,
          observedSharedWithTeam: accessByProjectKey.get(row.key)?.sharedWithTeam,
        });
      } catch (error) {
        dispatchSharing({ type: 'failed', key: row.key, requestId });
        const message = getConvexErrorMessage(error, 'Please try again.');
        console.error('[project-settings] failed to toggle share', message);
        toast.error(t('workspace.projects.shareFailed', 'Failed to update project sharing'), {
          description: message,
        });
      }
    },
    [accessByProjectKey, getConvexErrorMessage, setLocalProjectSharedWithTeam, t, workspaceId]
  );

  const onSyncHistory = useCallback(
    async (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider) => {
      const key = historyStateKey(row.key, provider);
      if (!workspaceId || !currentUserId) {
        setErrorByKey((current) => ({ ...current, [key]: 'Workspace is not ready.' }));
        return;
      }
      setSyncingByKey((current) => ({ ...current, [key]: true }));
      setResolvedConflictByKey((current) => {
        const { [key]: _, ...rest } = current;
        return rest;
      });
      setErrorByKey((current) => {
        const { [key]: _, ...rest } = current;
        return rest;
      });
      try {
        const result = await syncProjectHistoryForLocalProject({
          provider,
          runtime,
          localMachineId,
          machineId: row.machineId,
          workspaceId,
          localProjectId: row.project.id,
          requestedByUserId: currentUserId,
        });
        setCatalogByKey((current) => ({ ...current, [key]: result }));
        setSelectedSessionIdsByKey((current) => ({ ...current, [key]: [] }));
      } catch (error) {
        console.error('[project-settings] history sync failed', error);
        setErrorByKey((current) => ({ ...current, [key]: toErrorMessage(error) }));
      } finally {
        setSyncingByKey((current) => {
          const { [key]: _, ...rest } = current;
          return rest;
        });
      }
    },
    [currentUserId, localMachineId, runtime, workspaceId]
  );

  const onHistorySelectionChange = useCallback(
    (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider, selectedIds: string[]) => {
      setSelectedSessionIdsByKey((current) => ({
        ...current,
        [historyStateKey(row.key, provider)]: selectedIds,
      }));
    },
    []
  );

  const onImportHistory = useCallback(
    async (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider) => {
      const key = historyStateKey(row.key, provider);
      if (!workspaceId || !currentUserId) {
        setErrorByKey((current) => ({ ...current, [key]: 'Workspace is not ready.' }));
        return;
      }
      const providerKey = getLocalProjectHistoryProviderKey(provider);
      const state = row.historyImports.find((item) => item.providerKey === providerKey);
      if (!state || state.selectedSessionIds.length === 0) return;
      setImportingByKey((current) => ({ ...current, [key]: true }));
      setResolvedConflictByKey((current) => {
        const { [key]: _, ...rest } = current;
        return rest;
      });
      setErrorByKey((current) => {
        const { [key]: _, ...rest } = current;
        return rest;
      });
      try {
        const result = await importProjectHistoryForLocalProject({
          provider,
          runtime,
          localMachineId,
          machineId: row.machineId,
          workspaceId,
          localProjectId: row.project.id,
          acpSessionIds: state.selectedSessionIds,
          requestedByUserId: currentUserId,
          // Large imports run in bounded batches; surface each batch's cumulative
          // result so the UI reflects progress (and partial success) live instead
          // of blocking on the full selection.
          onBatchComplete: (cumulative) => {
            setCatalogByKey((current) => ({ ...current, [key]: cumulative.catalog }));
            setSyncSummariesByKey((current) => ({ ...current, [key]: cumulative.summary }));
          },
        });
        setCatalogByKey((current) => ({ ...current, [key]: result.catalog }));
        setSyncSummariesByKey((current) => ({ ...current, [key]: result.summary }));
        setSelectedSessionIdsByKey((current) => ({ ...current, [key]: [] }));
      } catch (error) {
        console.error('[project-settings] history import failed', error);
        setErrorByKey((current) => ({ ...current, [key]: toErrorMessage(error) }));
      } finally {
        setImportingByKey((current) => {
          const { [key]: _, ...rest } = current;
          return rest;
        });
      }
    },
    [currentUserId, localMachineId, runtime, workspaceId]
  );

  const onResolveHistoryConflict = useCallback(
    async (
      row: ProjectSettingsRow,
      provider: LocalProjectHistoryProvider,
      session: LocalProjectHistoryCatalogItem
    ) => {
      const key = historyStateKey(row.key, provider);
      if (!workspaceId || !currentUserId) {
        setErrorByKey((current) => ({ ...current, [key]: 'Workspace is not ready.' }));
        return;
      }
      if (!session.importedSessionId) {
        setErrorByKey((current) => ({
          ...current,
          [key]: 'Imported session metadata is missing.',
        }));
        return;
      }
      setResolvingByKey((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? {}),
          [session.acpSessionId]: true,
        },
      }));
      setErrorByKey((current) => {
        const { [key]: _, ...rest } = current;
        return rest;
      });
      try {
        const result = await resolveProjectHistoryConflictForLocalProject({
          provider,
          runtime,
          localMachineId,
          machineId: row.machineId,
          workspaceId,
          localProjectId: row.project.id,
          sessionId: session.importedSessionId as SessionId,
          acpSessionId: session.acpSessionId,
          requestedByUserId: currentUserId,
        });
        setCatalogByKey((current) => ({ ...current, [key]: result.catalog }));
        setResolvedConflictByKey((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? {}),
            [session.acpSessionId]: true,
          },
        }));
        setSelectedSessionIdsByKey((current) => ({ ...current, [key]: [] }));
      } catch (error) {
        console.error('[project-settings] history conflict resolve failed', error);
        setErrorByKey((current) => ({ ...current, [key]: toErrorMessage(error) }));
      } finally {
        setResolvingByKey((current) => {
          const providerState = { ...(current[key] ?? {}) };
          delete providerState[session.acpSessionId];
          if (Object.keys(providerState).length === 0) {
            const { [key]: _, ...rest } = current;
            return rest;
          }
          return { ...current, [key]: providerState };
        });
      }
    },
    [currentUserId, localMachineId, runtime, workspaceId]
  );

  const saveWorktreeConfig = useCallback(
    async (
      phase: WorktreeConfigPhase,
      row: ProjectSettingsRow,
      config: WorktreeSetupScriptConfig
    ) => {
      const spec = WORKTREE_CONFIG_PHASES[phase];
      const setScriptSavingByKey =
        phase === 'setup' ? setWorktreeSetupSavingByKey : setWorktreeCleanupSavingByKey;
      const setScriptErrorByKey =
        phase === 'setup' ? setWorktreeSetupErrorByKey : setWorktreeCleanupErrorByKey;
      const setByKey = phase === 'setup' ? setWorktreeSetupByKey : setWorktreeCleanupByKey;
      const cache = phase === 'setup' ? worktreeSetupConfigCache : worktreeCleanupConfigCache;

      if (!runtime || !workspaceId) {
        setScriptErrorByKey((current) => ({
          ...current,
          [row.key]: 'Workspace runtime is not ready.',
        }));
        return;
      }

      setScriptSavingByKey((current) => ({ ...current, [row.key]: true }));
      setScriptErrorByKey((current) => {
        const { [row.key]: _, ...rest } = current;
        return rest;
      });

      try {
        const response = await runtime.requestLocalProjectControl({
          type: spec.setRequestType,
          machineId: row.machineId,
          workspaceId,
          localProjectId: row.project.id,
          config,
          requestedByUserId: currentUserId ?? undefined,
        });
        if (!response?.ok) {
          throw new Error(response?.message ?? spec.saveError);
        }
        if (response.type !== spec.setRequestType) {
          throw new Error(`Unexpected response type: ${response.type}`);
        }
        // Persist the just-saved config so the next visit renders it instantly
        // and the reconcile fetch sees a matching value (no spinner, no swap).
        cache.set(row.key, response.result);
        setByKey((current) => ({ ...current, [row.key]: response.result }));
      } catch (error) {
        setScriptErrorByKey((current) => ({
          ...current,
          [row.key]: toErrorMessage(error),
        }));
      } finally {
        setScriptSavingByKey((current) => {
          const { [row.key]: _, ...rest } = current;
          return rest;
        });
      }
    },
    [
      currentUserId,
      runtime,
      setWorktreeCleanupByKey,
      setWorktreeCleanupErrorByKey,
      setWorktreeCleanupSavingByKey,
      setWorktreeSetupByKey,
      setWorktreeSetupErrorByKey,
      setWorktreeSetupSavingByKey,
      workspaceId,
    ]
  );

  const onWorktreeSetupChange = useCallback(
    (row: ProjectSettingsRow, config: WorktreeSetupScriptConfig) =>
      saveWorktreeConfig('setup', row, config),
    [saveWorktreeConfig]
  );

  const onWorktreeCleanupChange = useCallback(
    (row: ProjectSettingsRow, config: WorktreeCleanupScriptConfig) =>
      saveWorktreeConfig('cleanup', row, config),
    [saveWorktreeConfig]
  );

  return {
    sections,
    isLoading,
    onSharedWithTeamChange,
    onSyncHistory,
    onImportHistory,
    onResolveHistoryConflict,
    onHistorySelectionChange,
    onWorktreeSetupChange,
    onWorktreeCleanupChange,
  };
}
