import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentConfigMeta,
  AgentRoleId,
  LocalProjectId,
  MachineId,
  MachineViewMeta,
} from '@lody/shared';
import type { AgentSelection } from '@/components/shared';
import {
  readChatLandingDefaults,
  resolvePreferredChatLandingAgentSelection,
  writeChatLandingDefaults,
} from '@/lib/chat-landing-defaults';
type LocalProjectSelection = { machineId: MachineId; localProjectId: LocalProjectId };

type UseChatLandingDefaultsArgs = {
  workspaceId: string | null;
  shouldRestoreContextType: boolean;
  contextType: 'local' | 'github' | 'chat';
  setContextType: (contextType: 'local' | 'github' | 'chat') => void;
  executorConfigs: AgentConfigMeta[];
  machines: Map<string, MachineViewMeta>;
  /** Pre-filtered map of machines that are reachable AND own at least one agent config. */
  selectableMachines: Map<MachineId, MachineViewMeta>;
  visibleMachinesLoading: boolean;
  docMetaCacheReady: boolean;
  repositories?: Array<{ fullName: string }>;
  selectedAgent: AgentSelection | null;
  setSelectedAgent: (selection: AgentSelection | null) => void;
  selectedMachineId: MachineId | null;
  selectedRepo?: string;
  setSelectedRepo: (repo?: string) => void;
  selectedBranch: string | null;
  setSelectedBranch: (branch: string | null) => void;
  selectedLocalProject: LocalProjectSelection | null;
  setSelectedLocalProject: (selection: LocalProjectSelection | null) => void;
  selectedLocalBranch: string | null;
  setSelectedLocalBranch: (branch: string | null) => void;
  /**
   * The Agent Role the composer currently IS, or `undefined` while the Role
   * catalog cannot yet answer. `undefined` keeps whatever is stored: a Role
   * that has not loaded is not a Role the user deselected, and writing null for
   * it would drop the remembered Role before it could ever be restored.
   */
  selectedAgentRoleId?: AgentRoleId | null;
};

function pickPreferredMachineId(
  selectable: Map<MachineId, MachineViewMeta>,
  candidates: Array<MachineId | null | undefined>
): MachineId | null {
  for (const candidate of candidates) {
    if (candidate && selectable.has(candidate)) return candidate;
  }
  return null;
}

export function useChatLandingDefaults({
  workspaceId,
  shouldRestoreContextType,
  contextType,
  setContextType,
  executorConfigs,
  machines,
  selectableMachines,
  visibleMachinesLoading,
  docMetaCacheReady,
  repositories,
  selectedAgent,
  setSelectedAgent,
  selectedMachineId,
  selectedRepo,
  setSelectedRepo,
  selectedBranch,
  setSelectedBranch,
  selectedLocalProject,
  setSelectedLocalProject,
  selectedLocalBranch,
  setSelectedLocalBranch,
  selectedAgentRoleId,
}: UseChatLandingDefaultsArgs) {
  const initializedRef = useRef(false);
  const initializedWorkspaceIdRef = useRef<string | null>(null);
  /* The contextType restore is a RENDER-PHASE state adjustment ("adjusting
     state when a prop changes" — react.dev/learn/you-might-not-need-an-effect),
     ONE-SHOT per workspace entry and deliberately not an effect write. As an
     effect it re-ran (without latching) on the load effect's wait-for-data
     early returns, while chat-landing's auto-switch effect moves `contextType`
     away from a context whose backing collection is empty under a DIFFERENT
     readiness guard — re-writing the stored context every pre-init run turned
     that disagreement into an unbounded write ping-pong (#185 shape). Adjusted
     during render there is no effect to re-arm, the restored value lands in
     the SAME commit (no pre-restore flash), and afterwards the auto-switch
     rules own the field. State (not a ref) guards the one-shot so an aborted
     concurrent render retries instead of consuming the restore. */
  const [restoredContextTypeWorkspaceId, setRestoredContextTypeWorkspaceId] = useState<
    string | null
  >(null);
  if (workspaceId && restoredContextTypeWorkspaceId !== workspaceId) {
    setRestoredContextTypeWorkspaceId(workspaceId);
    if (shouldRestoreContextType) {
      const storedContextType = readChatLandingDefaults(workspaceId)?.contextType;
      if (storedContextType && storedContextType !== contextType) {
        setContextType(storedContextType);
      }
    }
  }
  const [canPersist, setCanPersist] = useState(false);
  const [repoDefaultsReady, setRepoDefaultsReady] = useState(false);

  useLayoutEffect(() => {
    if (initializedWorkspaceIdRef.current === workspaceId) return;
    initializedWorkspaceIdRef.current = workspaceId;
    initializedRef.current = false;
    setCanPersist(false);
    setRepoDefaultsReady(false);
  }, [workspaceId]);

  // Load initial defaults (agent/machine/repo/local-project)
  useLayoutEffect(() => {
    if (initializedRef.current) return;
    if (!workspaceId) return;

    const stored = readChatLandingDefaults(workspaceId);
    // The render-phase adjustment above has already landed any stored
    // contextType by the time this effect runs, so the live value is the
    // effective one.
    const storedLocalMachineId = stored?.localMachineId as MachineId | null | undefined;
    const storedLocalProjectId = stored?.localProjectId as LocalProjectId | null | undefined;
    const requiredMachineId =
      contextType === 'local'
        ? (selectedLocalProject?.machineId ?? selectedMachineId ?? storedLocalMachineId ?? null)
        : null;
    const hasStoredRepo = Boolean(stored?.repoFullName);
    const isRepoReady = !hasStoredRepo || repositories !== undefined;
    setRepoDefaultsReady(isRepoReady);

    // Apply local project selection
    if (!selectedLocalProject && storedLocalMachineId && storedLocalProjectId) {
      const machineId = storedLocalMachineId;
      const localProjectId = storedLocalProjectId;
      const machine = machines.get(machineId);
      if (machine?.localProjects?.[localProjectId]) {
        setSelectedLocalProject({
          machineId,
          localProjectId,
        });
      }
    }

    // Apply local branch selection
    if (stored?.localBranch && !selectedLocalBranch) {
      setSelectedLocalBranch(stored.localBranch);
    }

    // Apply agent selection
    let agentRestored = false;
    if (!selectedAgent && (stored?.agentId || stored?.machineId)) {
      const resolvedSelection = resolvePreferredChatLandingAgentSelection({
        preferredAgentId: stored.agentId ?? null,
        preferredMachineId: stored.machineId ?? null,
        requiredMachineId,
        executorConfigs,
        machines,
      });
      if (resolvedSelection) {
        setSelectedAgent(resolvedSelection);
        agentRestored = true;
      }
    }

    // Apply repo selection
    if (!selectedRepo && stored?.repoFullName && repositories) {
      if (repositories.some((r) => r.fullName === stored.repoFullName)) {
        setSelectedRepo(stored.repoFullName);
      }
    }

    if (!selectedBranch && stored?.branch) {
      setSelectedBranch(stored.branch);
    }

    // Wait for repositories to be loaded if needed
    if (!isRepoReady) {
      return;
    }

    // Wait for machine metadata before finalizing initialization when we need to
    // restore a stored local project selection.
    if (
      storedLocalMachineId &&
      storedLocalProjectId &&
      !selectedLocalProject &&
      machines.size === 0
    ) {
      return;
    }

    // Wait for the doc-meta cache to be fully loaded before finalizing initialization
    // when we need to restore a stored agent selection. Without this guard,
    // initialization may complete before async CRDT/visibility data arrives,
    // causing the persist effect to overwrite the stored selection with null.
    if (
      (stored?.agentId || stored?.machineId) &&
      !selectedAgent &&
      !agentRestored &&
      (!docMetaCacheReady || visibleMachinesLoading)
    ) {
      return;
    }

    initializedRef.current = true;
    setCanPersist(true);
  }, [
    workspaceId,
    shouldRestoreContextType,
    contextType,
    setContextType,
    executorConfigs,
    machines,
    visibleMachinesLoading,
    docMetaCacheReady,
    repositories,
    selectedAgent,
    selectedMachineId,
    selectedRepo,
    selectedBranch,
    selectedLocalProject,
    selectedLocalBranch,
    setSelectedAgent,
    setSelectedRepo,
    setSelectedBranch,
    setSelectedLocalProject,
    setSelectedLocalBranch,
  ]);

  // Persist context + target selection defaults for all chat contexts.
  useLayoutEffect(() => {
    if (!workspaceId || !canPersist || !initializedRef.current) return;
    // Never downgrade a remembered agent/machine to null. The selection can be
    // transiently empty even after initialization finalizes — e.g. agent configs
    // live in per-machine flock docs that load *after* `docMetaCacheReady` flips
    // true, so the init pass can complete before `executorConfigs` is populated.
    // Writing null here would wipe the last-used selection before the re-resolve
    // effect below can restore it, and the user would land on the first machine's
    // first agent instead. Keep the previously stored values so that effect can
    // restore the exact agent once the flock configs arrive (or the machine comes
    // back online).
    const previous = readChatLandingDefaults(workspaceId);
    writeChatLandingDefaults(workspaceId, {
      contextType,
      agentId: selectedAgent?.agentId ?? previous?.agentId ?? null,
      machineId: selectedAgent?.machineId ?? previous?.machineId ?? null,
      repoFullName: selectedRepo ?? null,
      branch: selectedBranch ?? null,
      localMachineId: selectedLocalProject?.machineId ?? null,
      localProjectId: selectedLocalProject?.localProjectId ?? null,
      localBranch: selectedLocalBranch ?? null,
      agentRoleId:
        selectedAgentRoleId === undefined ? (previous?.agentRoleId ?? null) : selectedAgentRoleId,
    });
  }, [
    workspaceId,
    canPersist,
    contextType,
    selectedAgent,
    selectedRepo,
    selectedBranch,
    selectedLocalProject,
    selectedLocalBranch,
    selectedAgentRoleId,
  ]);

  // After the initial defaults pass completes, the current `selectedAgent` may
  // still refer to a machine that just went offline, lost its config, or hadn't
  // appeared yet when defaults loaded (e.g. machines stream in asynchronously
  // after relogin). Re-resolve a valid selection from the currently selectable
  // machines so the user sees a reachable default instead of a stale or empty
  // selector. Runs after `defaultsReady` so we never overwrite the restore.
  const requiredMachineId = useMemo(
    () =>
      contextType === 'local'
        ? (selectedLocalProject?.machineId ?? selectedMachineId ?? null)
        : null,
    [contextType, selectedLocalProject, selectedMachineId]
  );
  const hasSelectableAgent = useMemo(() => {
    if (!selectedAgent) return false;
    if (requiredMachineId && selectedAgent.machineId !== requiredMachineId) return false;
    if (!selectableMachines.has(selectedAgent.machineId)) return false;
    return executorConfigs.some(
      (config) =>
        config.id === selectedAgent.agentId && config.machineId === selectedAgent.machineId
    );
  }, [executorConfigs, requiredMachineId, selectableMachines, selectedAgent]);

  useEffect(() => {
    if (!canPersist || visibleMachinesLoading) return;
    if (hasSelectableAgent) return;
    if (selectableMachines.size === 0) return;

    const stored = readChatLandingDefaults(workspaceId);
    const storedMachineId = (stored?.machineId as MachineId | null | undefined) ?? null;
    const preferredMachineId = pickPreferredMachineId(selectableMachines, [
      selectedMachineId,
      selectedAgent?.machineId,
      storedMachineId,
    ]);
    const nextSelection = resolvePreferredChatLandingAgentSelection({
      preferredAgentId: selectedAgent?.agentId ?? stored?.agentId ?? null,
      preferredMachineId,
      requiredMachineId,
      executorConfigs,
      machines: selectableMachines,
    });
    if (
      nextSelection &&
      (nextSelection.agentId !== selectedAgent?.agentId ||
        nextSelection.machineId !== selectedAgent?.machineId)
    ) {
      setSelectedAgent(nextSelection);
    }
  }, [
    canPersist,
    executorConfigs,
    hasSelectableAgent,
    requiredMachineId,
    selectableMachines,
    selectedAgent,
    selectedMachineId,
    setSelectedAgent,
    visibleMachinesLoading,
    workspaceId,
  ]);

  return { defaultsReady: canPersist, repoDefaultsReady };
}
