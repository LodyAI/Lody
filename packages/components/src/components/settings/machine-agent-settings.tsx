import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue, useSetAtom } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { useCloudMutation } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  type AcpSessionMonitorSnapshot,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
  type ProviderSetupTask,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { Check, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { activeWorkspaceRuntimeAtom, authTokenAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { developerModeEnabledAtom, reviewAgentFeatureEnabledAtom } from '@/atoms/settings';
import { settingsDialogOpenAtom } from '@/atoms/settings';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { localMachineIdAtom } from '@/atoms/local-probe';
import {
  cmdCreateAgentConfigAtom,
  cmdCreateProviderSetupAtom,
  cmdRetryProviderSetupAtom,
  cmdUpdateAgentConfigAtom,
  deleteAgentConfigAtom,
  deleteProviderSetupAtom,
  getAllAgentConfigAtom,
  getAllProviderSetupsAtom,
} from '@/atoms/agents';
import { machineSettingsFilterAtom } from '@/atoms/settings-machine-tab';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useVisibleLocalProjectsFromMachineIndex } from '@/hooks/use-visible-local-projects';
import { useMachineActions } from '@/hooks/use-machine-actions';
import { useAgentConfigMigration } from '@/hooks/use-agent-config-migration';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { resyncMachineFlockRows } from '@/hooks/use-machine-flock-rows';
import { useMachineAcpBinaryActions } from '@/hooks/use-machine-acp-binary-actions';
import { useProviderSetupRuntimeProgress } from '@/hooks/use-provider-setup-runtime-progress';
import { useIsMobile } from '@/hooks/use-mobile';
import { canDeleteOfflineMachine, canManageAllMachines } from '@/lib/machine-deletion';
import { useAppCapability } from '@/lib/app-platform';
import {
  fetchLatestCliVersion,
  isCliVersionOutdated,
  mintMachineLifecycleRequestToken,
  type MachineLifecycleAction,
} from '@/lib/machine-lifecycle-api';
import { useOrganization } from '@/hooks/useOrganization';
import { useStableSession } from '@/hooks/useStableSession';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useCloudQuery } from '@lody/platform/react';
import { useConvexErrorMessage } from '@/hooks/use-convex-error-message';
import { formatSessionTabSearch } from '@/lib/session-tab-url';
import { useMachineMonitor } from '@/hooks/use-machine-monitor';
import { useMachineLifecycleCapability } from '@/hooks/use-machine-lifecycle-capability';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import {
  MachineListFilterButton,
  MachineTabList,
  buildMachineTabItems,
  type MachineTabItem,
  type MachineTabOwner,
} from './machine-tab-list';
import { MachineDetailPane, MachineProvidersSection } from './machine-detail-pane';
import {
  buildWorkspaceMachineSelectionPool,
  resolveDesktopMachineSelection,
} from './machine-selection';
import { MachinePills } from './machine-pills';
import {
  MachineConnectedResources,
  type MachineConnectedProject,
} from './my-machine-connected-resources';
import { ReviewPolicySection } from './review-policy-setting';
import {
  AgentConfigDialog,
  type AgentConfigDialogMode,
  type AgentConfigSubmitPayload,
} from './agent-config-dialog';
import {
  WorkspaceMachineCollapsedRow,
  WorkspaceMachineExpandedSection,
  type WorkspaceMachineAccordionMeta,
} from './workspace-machine-accordion';

export type MachineAgentSettingsProps = {
  selectedMachineId: MachineId | null;
  onSelectedMachineChange: (next: MachineId | null) => void;
  mode?: 'agents' | 'machines';
};

const createMachineRequestId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const waitForMonitorSessionRemoval = async (args: {
  runtime: WorkspaceRuntime;
  machineId: MachineId;
  sessionId: SessionId;
  timeoutMs: number;
  timeoutMessage: string;
}): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };

    timeout = setTimeout(() => finish(new Error(args.timeoutMessage)), args.timeoutMs);
    const nextUnsubscribe = args.runtime.subscribeMachineMonitor(args.machineId, (snapshot) => {
      if (snapshot && !snapshot.sessions.some((session) => session.sessionId === args.sessionId)) {
        finish();
      }
    });
    unsubscribe = nextUnsubscribe;
    if (settled) nextUnsubscribe();
    else args.runtime.forceMachineMonitorSample(args.machineId);
  });

async function pingMachineWithRuntime(args: {
  runtime: WorkspaceRuntime;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  timeoutMessage: string;
  failedMessage: string;
}): Promise<number> {
  const requestId = createMachineRequestId();
  const startedAt = performance.now();
  const responsePromise = args.runtime.waitForMachinePingResponse(args.machineId, requestId, {
    timeoutMs: 30000,
  });
  args.runtime.sendControl({
    type: 'machine/ping',
    machineId: args.machineId,
    workspaceId: args.workspaceId,
    requestId,
  });
  const response = await responsePromise;
  if (!response) {
    throw new Error(args.timeoutMessage);
  }
  if (!response.success || response.message !== 'pong') {
    const errorMessage =
      typeof response.error === 'string' && response.error.length > 0
        ? response.error
        : args.failedMessage;
    throw new Error(errorMessage);
  }
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function MachineAgentSettings({
  selectedMachineId,
  onSelectedMachineChange,
  mode = 'agents',
}: MachineAgentSettingsProps) {
  const { t } = useTranslation();
  const { openSettings } = useOpenSettings();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const authToken = useAtomValue(authTokenAtom);
  const developerModeEnabled = useAtomValue(developerModeEnabledAtom);
  const reviewAgentEnabled = useAtomValue(reviewAgentFeatureEnabledAtom);
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const sessionMetaCache = useAtomValue(sessionMetaCacheAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const getConvexErrorMessage = useConvexErrorMessage();
  // Remote daemon restart/upgrade is brokered through the cloud control plane
  // (lifecycle token mint); machine sharing needs workspace members. Both are
  // cloud-only surfaces hidden on the local platform.
  const remoteMachinesAvailable = useAppCapability('remoteMachines');
  const teamSharingAvailable = useAppCapability('teamSharing');
  const { data: session } = useStableSession();
  const { activeOrganization } = useOrganization();
  const members = useMemo(() => activeOrganization?.members ?? [], [activeOrganization?.members]);
  const currentUserId = session?.user?.id ?? null;

  const { machines, accessByMachineId, isLoading } = useVisibleMachineMetas();
  const {
    projects: visibleLocalProjects,
    accessByProjectKey,
    isLoading: visibleLocalProjectsLoading,
  } = useVisibleLocalProjectsFromMachineIndex(
    { machines, accessByMachineId, isLoading },
    { enabled: mode === 'machines' }
  );
  const visibleMachineIdsForAgentConfigs = useMemo(() => [...machines.keys()], [machines]);
  useMachineFlockAgentConfigsForMachineIds(visibleMachineIdsForAgentConfigs);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const onlineMachineIds = useOnlineMachineIds();

  const allConfigs = useAtomValue(getAllAgentConfigAtom);
  const allSetups = useAtomValue(getAllProviderSetupsAtom);
  useProviderSetupRuntimeProgress(runtime, workspaceId, allSetups);
  const createConfig = useSetAtom(cmdCreateAgentConfigAtom);
  const createSetup = useSetAtom(cmdCreateProviderSetupAtom);
  const retrySetup = useSetAtom(cmdRetryProviderSetupAtom);
  const updateConfig = useSetAtom(cmdUpdateAgentConfigAtom);
  const deleteConfig = useSetAtom(deleteAgentConfigAtom);
  const deleteSetup = useSetAtom(deleteProviderSetupAtom);

  const [filter, setFilter] = [
    useAtomValue(machineSettingsFilterAtom),
    useSetAtom(machineSettingsFilterAtom),
  ];
  const [mobileMachinePickerOpen, setMobileMachinePickerOpen] = useState(false);
  const [mobileReviewPolicyOpen, setMobileReviewPolicyOpen] = useState(false);
  const effectiveFilter = filter;
  const [desktopExpandedMachineId, setDesktopExpandedMachineId] = useState<MachineId | null>(
    selectedMachineId
  );
  const selectionFramesRef = useRef<{ first: number; second: number | null } | null>(null);
  const usesDesktopMachineAccordion = !isMobile && mode === 'machines' && remoteMachinesAvailable;
  const visibleSelectedMachineId = usesDesktopMachineAccordion
    ? desktopExpandedMachineId
    : selectedMachineId;

  useEffect(() => {
    const frames = selectionFramesRef.current;
    if (frames && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frames.first);
      if (frames.second !== null) cancelAnimationFrame(frames.second);
      selectionFramesRef.current = null;
    }
    if (usesDesktopMachineAccordion) setDesktopExpandedMachineId(selectedMachineId);
  }, [selectedMachineId, usesDesktopMachineAccordion]);

  useEffect(
    () => () => {
      const frames = selectionFramesRef.current;
      if (!frames || typeof cancelAnimationFrame !== 'function') return;
      cancelAnimationFrame(frames.first);
      if (frames.second !== null) cancelAnimationFrame(frames.second);
    },
    []
  );

  const selectDesktopMachine = useCallback(
    (nextMachineId: MachineId | null) => {
      setDesktopExpandedMachineId(nextMachineId);

      if (typeof requestAnimationFrame !== 'function') {
        onSelectedMachineChange(nextMachineId);
        return;
      }

      const previousFrames = selectionFramesRef.current;
      if (previousFrames) {
        cancelAnimationFrame(previousFrames.first);
        if (previousFrames.second !== null) cancelAnimationFrame(previousFrames.second);
      }

      const frames = { first: 0, second: null as number | null };
      // Keep URL/global selection in sync, but only after the optimistic row has
      // had a chance to paint. The detail body follows the same two-frame gate.
      frames.first = requestAnimationFrame(() => {
        frames.second = requestAnimationFrame(() => {
          selectionFramesRef.current = null;
          onSelectedMachineChange(nextMachineId);
        });
      });
      selectionFramesRef.current = frames;
    },
    [onSelectedMachineChange]
  );

  const migration = useAgentConfigMigration();

  const canManageOthers = useMemo(
    () => canManageAllMachines(currentUserId, members),
    [currentUserId, members]
  );

  const machineOwnerMap = useMemo(() => {
    const map = new Map<string, MachineTabOwner>();
    for (const member of members) {
      map.set(member.userId, {
        id: member.userId,
        name: member.user?.name || member.user?.email || member.userId,
        image: member.user?.image,
        email: member.user?.email,
      });
    }
    return map;
  }, [members]);

  const { connectedProjectsByMachineId, directoryCountByMachineId } = useMemo(() => {
    const projectsByMachineId = new Map<MachineId, MachineConnectedProject[]>();
    const counts = new Map<MachineId, number>();
    for (const [key, entry] of visibleLocalProjects) {
      const projects = projectsByMachineId.get(entry.machineId) ?? [];
      projects.push({
        key,
        name: entry.project.name,
        rootPath: entry.project.rootPath,
        sharedWithTeam: accessByProjectKey.get(key)?.sharedWithTeam ?? false,
      });
      projectsByMachineId.set(entry.machineId, projects);
      counts.set(entry.machineId, projects.length);
    }
    for (const projects of projectsByMachineId.values()) {
      projects.sort((left, right) => left.name.localeCompare(right.name));
    }
    return {
      connectedProjectsByMachineId: projectsByMachineId,
      directoryCountByMachineId: counts,
    };
  }, [accessByProjectKey, visibleLocalProjects]);

  const agentCountByMachineId = useMemo(() => {
    const counts = new Map<MachineId, number>();
    for (const config of allConfigs) {
      counts.set(config.machineId, (counts.get(config.machineId) ?? 0) + 1);
    }
    return counts;
  }, [allConfigs]);

  const isOwnMachine = useCallback(
    (machine: MachineViewMeta) => {
      if (localMachineId && machine.id === localMachineId) return true;
      const access = accessByMachineId.get(machine.id);
      if (currentUserId && access?.ownerUserId === currentUserId) return true;
      return false;
    },
    [accessByMachineId, currentUserId, localMachineId]
  );

  const { items: tabItems } = useMemo(() => {
    return buildMachineTabItems({
      machines,
      accessByMachineId,
      onlineMachineIds,
      isOwnMachine,
      filter: effectiveFilter,
    });
  }, [machines, accessByMachineId, onlineMachineIds, isOwnMachine, effectiveFilter]);

  const allItems = useMemo(() => {
    return buildMachineTabItems({
      machines,
      accessByMachineId,
      onlineMachineIds,
      isOwnMachine,
      filter: { onlineOnly: false, mineOnly: false },
    }).items;
  }, [machines, accessByMachineId, onlineMachineIds, isOwnMachine]);
  const machinePills = allItems.map((item) => ({
    id: item.machine.id,
    label: item.machine.name || item.machine.id,
    online: item.isOnline,
    private: !item.sharedWithTeam,
  }));
  const localMachineItems = useMemo(
    () => (localMachineId ? allItems.filter((item) => item.machine.id === localMachineId) : []),
    [allItems, localMachineId]
  );
  const filteredModeItems = useMemo(() => {
    if (mode === 'machines') return tabItems.filter((item) => item.sharedWithTeam);
    return tabItems;
  }, [mode, tabItems]);
  const modeTotalBeforeFilter = useMemo(() => {
    if (mode === 'machines') return allItems.filter((item) => item.sharedWithTeam).length;
    return allItems.length;
  }, [allItems, mode]);
  const ownPrivateItems = useMemo(
    () => allItems.filter((item) => item.isOwn && !item.sharedWithTeam),
    [allItems]
  );
  const getAccordionMeta = useCallback(
    (item: MachineTabItem): WorkspaceMachineAccordionMeta => {
      const ownerUserId =
        accessByMachineId.get(item.machine.id)?.ownerUserId ?? item.machine.ownerUserId ?? null;
      return {
        machine: item.machine,
        isOnline: item.isOnline,
        isLocal: item.machine.id === localMachineId,
        isPrivate: !item.sharedWithTeam,
        owner: ownerUserId ? (machineOwnerMap.get(ownerUserId) ?? null) : null,
        directoryCount: directoryCountByMachineId.get(item.machine.id) ?? 0,
        agentCount: agentCountByMachineId.get(item.machine.id) ?? 0,
      };
    },
    [
      accessByMachineId,
      agentCountByMachineId,
      directoryCountByMachineId,
      localMachineId,
      machineOwnerMap,
    ]
  );
  const [ownPrivateExpanded, setOwnPrivateExpanded] = useState(false);
  const openPrivateMachine = useCallback(
    (machineId: MachineId) => {
      if (isMobile && workspaceSlug) {
        void navigate({
          to: '/$workspaceName/settings/machines',
          params: { workspaceName: workspaceSlug },
          search: { machine: machineId },
        });
        return;
      }
      selectDesktopMachine(machineId);
    },
    [isMobile, navigate, selectDesktopMachine, workspaceSlug]
  );
  const openAgentsForMachine = useCallback(
    (machineId: MachineId) => {
      if (isMobile && workspaceSlug) {
        void navigate({
          to: '/$workspaceName/settings/agents',
          params: { workspaceName: workspaceSlug },
          search: { machine: machineId },
        });
        return;
      }
      onSelectedMachineChange(machineId);
      openSettings('agents');
    },
    [isMobile, navigate, onSelectedMachineChange, openSettings, workspaceSlug]
  );

  // Remote-capable Machines stays inside the filtered visible pool. A local-only
  // platform has no machine selection surface, so it binds directly to the
  // local machine and cannot be blanked by a stale list filter. Agents still
  // renders every machine; remote-capable mobile keeps its list→detail flow.
  const workspaceMachineSelectionPool = useMemo(
    () =>
      buildWorkspaceMachineSelectionPool({
        filteredItems: filteredModeItems,
        allItems,
        selectedMachineId: visibleSelectedMachineId,
      }),
    [allItems, filteredModeItems, visibleSelectedMachineId]
  );
  const selectionPool =
    mode === 'agents'
      ? allItems
      : remoteMachinesAvailable
        ? workspaceMachineSelectionPool
        : localMachineItems;
  const { resolved: resolvedDesktopMachine, nextSelectedMachineId } = useMemo(
    () =>
      resolveDesktopMachineSelection({
        pool: selectionPool,
        selectedMachineId: visibleSelectedMachineId,
        localMachineId,
      }),
    [selectionPool, visibleSelectedMachineId, localMachineId]
  );

  useEffect(() => {
    if (isMobile) return;
    if (machines.size === 0) return;
    if (mode === 'machines' && remoteMachinesAvailable && visibleSelectedMachineId === null) return;
    if (nextSelectedMachineId !== visibleSelectedMachineId) {
      if (usesDesktopMachineAccordion) {
        selectDesktopMachine(nextSelectedMachineId);
      } else {
        onSelectedMachineChange(nextSelectedMachineId);
      }
    }
  }, [
    isMobile,
    machines,
    mode,
    nextSelectedMachineId,
    onSelectedMachineChange,
    remoteMachinesAvailable,
    selectDesktopMachine,
    usesDesktopMachineAccordion,
    visibleSelectedMachineId,
  ]);

  useEffect(() => {
    if (!isMobile || mode !== 'agents') return;
    const selectableItems = remoteMachinesAvailable ? allItems : localMachineItems;
    if (selectableItems.length === 0) return;
    if (
      selectedMachineId &&
      selectableItems.some((item) => item.machine.id === selectedMachineId)
    ) {
      return;
    }
    onSelectedMachineChange(selectableItems[0]!.machine.id);
  }, [
    allItems,
    isMobile,
    localMachineItems,
    mode,
    onSelectedMachineChange,
    remoteMachinesAvailable,
    selectedMachineId,
  ]);

  const resolvedSelectedMachine: MachineViewMeta | undefined = isMobile
    ? mode === 'agents'
      ? remoteMachinesAvailable
        ? ((selectedMachineId ? machines.get(selectedMachineId) : undefined) ??
          allItems[0]?.machine)
        : localMachineItems[0]?.machine
      : !remoteMachinesAvailable
        ? localMachineId
          ? machines.get(localMachineId)
          : undefined
        : selectedMachineId
          ? machines.get(selectedMachineId)
          : undefined
    : mode === 'machines' && remoteMachinesAvailable && visibleSelectedMachineId === null
      ? undefined
      : resolvedDesktopMachine;
  const credentialState = useCloudQuery(
    cloudOperations.machineCredentials.getMachineCredentialState,
    mode === 'machines' &&
      workspaceId &&
      resolvedSelectedMachine &&
      isOwnMachine(resolvedSelectedMachine)
      ? { workspaceId, machineId: resolvedSelectedMachine.id }
      : 'skip'
  );
  const revokeMachineCredentialsMutation = useCloudMutation(
    cloudOperations.machineCredentials.revokeMachineCredentials
  );

  const configsForMachine = useMemo(() => {
    if (!resolvedSelectedMachine) return [] as AgentConfigMeta[];
    return allConfigs
      .filter((c) => c.machineId === resolvedSelectedMachine.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allConfigs, resolvedSelectedMachine]);
  const setupsForMachine = useMemo(() => {
    if (!resolvedSelectedMachine) return [] as ProviderSetupTask[];
    return allSetups
      .filter((setup) => setup.machineId === resolvedSelectedMachine.id)
      .sort((left, right) => left.createdAt - right.createdAt);
  }, [allSetups, resolvedSelectedMachine]);

  const actions = useMachineActions({
    currentUserId,
    localMachineId,
    canManageAllMachines: canManageOthers,
  });
  const revokeMachineCredentials = useCallback(async () => {
    if (!workspaceId || !resolvedSelectedMachine) return;
    try {
      const result = await revokeMachineCredentialsMutation({
        workspaceId,
        machineId: resolvedSelectedMachine.id,
      });
      toast.success(
        t('settings.devices.credentials.revoked', '{{count}} machine credential revoked', {
          count: result.revokedCount,
        })
      );
    } catch (error) {
      toast.error(getConvexErrorMessage(error, 'Failed to revoke machine credentials.'));
      // Rethrow so callers (e.g. the revoke confirm dialog) can tell failure from
      // success — the error toast is surfaced here, exactly once.
      throw error;
    }
  }, [
    getConvexErrorMessage,
    resolvedSelectedMachine,
    revokeMachineCredentialsMutation,
    t,
    workspaceId,
  ]);

  const [dialogMode, setDialogMode] = useState<AgentConfigDialogMode | null>(null);
  // The provider dialog targets whichever machine's accordion row opened it,
  // decoupled from any single "selected machine" now that desktop lists them all.
  const [dialogMachine, setDialogMachine] = useState<MachineViewMeta | null>(null);
  const dialogOpen = dialogMode !== null;
  const [latestCliVersion, setLatestCliVersion] = useState<string | null>(null);

  const sharedWithTeam = resolvedSelectedMachine
    ? (accessByMachineId.get(resolvedSelectedMachine.id)?.sharedWithTeam ?? false)
    : false;
  const isLocal = !!resolvedSelectedMachine && resolvedSelectedMachine.id === localMachineId;
  const isOwn = resolvedSelectedMachine ? isOwnMachine(resolvedSelectedMachine) : false;
  const selectedIsOnline =
    !!resolvedSelectedMachine && onlineMachineIds.has(resolvedSelectedMachine.id);
  const ownerName = resolvedSelectedMachine
    ? (machineOwnerMap.get(
        accessByMachineId.get(resolvedSelectedMachine.id)?.ownerUserId ??
          resolvedSelectedMachine.ownerUserId ??
          ''
      )?.name ?? null)
    : null;
  const selectedCanDelete =
    !!resolvedSelectedMachine &&
    canDeleteOfflineMachine({
      machine: resolvedSelectedMachine,
      isOnline: selectedIsOnline,
      currentUserId,
      localMachineId,
      canManageAllMachines: canManageOthers,
    });
  const selectedOwnerUserId =
    resolvedSelectedMachine && accessByMachineId.get(resolvedSelectedMachine.id)?.ownerUserId
      ? accessByMachineId.get(resolvedSelectedMachine.id)?.ownerUserId
      : resolvedSelectedMachine?.ownerUserId;
  const selectedCanManageLifecycle =
    remoteMachinesAvailable &&
    !!resolvedSelectedMachine &&
    !!currentUserId &&
    selectedOwnerUserId === currentUserId;
  // Probed for the single selected machine (both mobile detail + desktop pills).
  const selectedLifecycleCapability = useMachineLifecycleCapability({
    machineId: resolvedSelectedMachine?.id ?? null,
    enabled: selectedCanManageLifecycle && selectedIsOnline,
  });
  const selectedCanRemoteRestart =
    selectedCanManageLifecycle &&
    selectedIsOnline &&
    selectedLifecycleCapability?.canRemoteRestart === true;
  const selectedCanRemoteUpgrade =
    selectedCanManageLifecycle &&
    selectedIsOnline &&
    selectedLifecycleCapability?.canRemoteUpgrade === true;
  const selectedUpdateAvailable =
    selectedCanRemoteUpgrade &&
    isCliVersionOutdated(resolvedSelectedMachine?.cliVersion, latestCliVersion ?? undefined);
  const selectedDaemonUpdate =
    selectedUpdateAvailable && resolvedSelectedMachine?.cliVersion && latestCliVersion
      ? {
          currentVersion: resolvedSelectedMachine.cliVersion,
          latestVersion: latestCliVersion,
        }
      : undefined;
  const machineMonitor = useMachineMonitor({
    machineId: resolvedSelectedMachine?.id ?? null,
    enabled: mode !== 'agents',
    online: selectedIsOnline,
  });
  const monitorSessionMetas = useMemo(() => Object.values(sessionMetaCache), [sessionMetaCache]);
  const openMonitorSession = useCallback(
    (monitoredSession: AcpSessionMonitorSnapshot) => {
      const meta = monitorSessionMetas.find((entry) => entry.id === monitoredSession.sessionId);
      const parentSessionId =
        meta?.parentSessionId ?? monitoredSession.parentSessionId ?? monitoredSession.sessionId;
      const activeWorkspaceSlug = activeOrganization?.slug;
      if (!activeWorkspaceSlug) return;
      setSettingsDialogOpen(false);
      void navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: activeWorkspaceSlug, sessionId: parentSessionId },
        search: {
          tab: formatSessionTabSearch(monitoredSession.sessionId, parentSessionId),
        },
      });
    },
    [activeOrganization?.slug, monitorSessionMetas, navigate, setSettingsDialogOpen]
  );
  const terminateMonitorSession = useCallback(
    async (machine: MachineViewMeta, monitoredSession: AcpSessionMonitorSnapshot) => {
      if (!runtime) {
        throw new Error(
          t('settings.devices.sessions.terminateUnavailable', 'Machine is unavailable')
        );
      }
      const response = await runtime.requestSessionTerminate(
        machine.id,
        monitoredSession.sessionId,
        { timeoutMs: 30_000 }
      );
      if (!response?.success) {
        throw new Error(
          response?.error ??
            t('settings.devices.sessions.terminateFailed', 'Failed to terminate ACP process')
        );
      }
      await waitForMonitorSessionRemoval({
        runtime,
        machineId: machine.id,
        sessionId: monitoredSession.sessionId,
        timeoutMs: 15_000,
        timeoutMessage: t(
          'settings.devices.sessions.terminateStillPresent',
          'The ACP process is still present in device monitoring'
        ),
      });
    },
    [runtime, t]
  );

  useEffect(() => {
    // The latest-version probe only feeds the remote upgrade affordance; skip
    // the network call entirely when remote lifecycle is unavailable.
    if (!remoteMachinesAvailable) return undefined;
    let cancelled = false;
    void fetchLatestCliVersion().then((result) => {
      if (cancelled) return;
      setLatestCliVersion(result.ok ? result.latestVersion : null);
    });
    return () => {
      cancelled = true;
    };
  }, [remoteMachinesAvailable]);

  const refreshCapabilities = useCallback(
    async (args: { machineId: MachineId; configId: AgentConfigId }) => {
      if (!runtime || !workspaceId) {
        throw new Error(t('chat.validation.missingContext', 'Missing workspace context'));
      }
      const response = await runtime.requestMachineAcpCapabilitiesRefresh({
        type: 'machine/acp-capabilities-refresh',
        machineId: args.machineId,
        workspaceId,
        configId: args.configId,
      });
      if (!response) {
        throw new Error(
          t('agents.acpCapabilities.refreshTimeout', 'Refresh timed out, please try again')
        );
      }
      if (!response.success) {
        if (response.authRequired) {
          return response;
        }
        const errorMessage =
          typeof response.error === 'string' && response.error.length > 0
            ? response.error
            : t('agents.acpCapabilities.refreshError', 'Refresh failed');
        throw new Error(errorMessage);
      }
      // The CLI wrote the fresh capabilities to the machine flock doc, which the
      // web only syncs once per session; force a re-sync so chat landing and the
      // settings dialog reflect the new modes/models without a reload.
      await resyncMachineFlockRows(runtime, args.machineId, {
        refreshedCapability: response.capability
          ? { configId: response.configId, value: response.capability }
          : undefined,
      });
      return response;
    },
    [runtime, t, workspaceId]
  );

  const pingMachine = useCallback(
    (machineId: MachineId): Promise<number> => {
      if (!runtime || !workspaceId) {
        return Promise.reject(
          new Error(t('chat.validation.missingContext', 'Missing workspace context'))
        );
      }

      return pingMachineWithRuntime({
        runtime,
        workspaceId,
        machineId,
        timeoutMessage: t('settings.agent.machinePing.timeout', 'Ping timed out'),
        failedMessage: t('settings.agent.machinePing.failed', 'Ping failed'),
      });
    },
    [runtime, t, workspaceId]
  );

  const requestMachineLifecycle = useCallback(
    async (args: {
      machineId: MachineId;
      action: MachineLifecycleAction;
      targetVersion?: string;
    }) => {
      if (!runtime || !workspaceId || !authToken) {
        throw new Error(t('chat.validation.missingContext', 'Missing workspace context'));
      }

      const requestId = createMachineRequestId();
      const minted = await mintMachineLifecycleRequestToken({
        workspaceId,
        machineId: args.machineId,
        action: args.action,
        requestId,
        targetVersion: args.targetVersion,
        sessionToken: authToken,
      });
      if (!minted.ok) {
        throw new Error(minted.error);
      }

      if (args.action === 'restart') {
        const responsePromise = runtime.waitForMachineRestartResponse(args.machineId, requestId, {
          timeoutMs: 30000,
        });
        runtime.sendControl({
          type: 'machine/restart',
          machineId: args.machineId,
          workspaceId,
          requesterUserId: minted.requesterUserId,
          requestToken: minted.requestToken,
          requestId,
        });
        const response = await responsePromise;
        if (!response) {
          throw new Error(
            t('settings.agent.machineLifecycle.restartTimeout', 'Restart request timed out')
          );
        }
        if (!response.success || !response.accepted) {
          throw new Error(
            response.error ||
              t('settings.agent.machineLifecycle.restartFailed', 'Restart request failed')
          );
        }
        return;
      }

      const responsePromise = runtime.waitForMachineUpgradeResponse(args.machineId, requestId, {
        timeoutMs: 120000,
      });
      runtime.sendControl({
        type: 'machine/upgrade',
        machineId: args.machineId,
        workspaceId,
        requesterUserId: minted.requesterUserId,
        requestToken: minted.requestToken,
        requestId,
        targetVersion: args.targetVersion,
      });
      const response = await responsePromise;
      if (!response) {
        throw new Error(
          t('settings.agent.machineLifecycle.upgradeTimeout', 'Update request timed out')
        );
      }
      if (!response.success || !response.accepted) {
        throw new Error(
          response.error ||
            t('settings.agent.machineLifecycle.upgradeFailed', 'Update request failed')
        );
      }
    },
    [authToken, runtime, t, workspaceId]
  );

  const restartMachine = useCallback(
    async (machineId: MachineId) => {
      await requestMachineLifecycle({ machineId, action: 'restart' });
    },
    [requestMachineLifecycle]
  );

  const upgradeMachine = useCallback(
    async (machineId: MachineId, targetVersion: string) => {
      await requestMachineLifecycle({ machineId, action: 'upgrade', targetVersion });
    },
    [requestMachineLifecycle]
  );

  const handleRefreshConfig = useCallback(
    async (config: AgentConfigMeta) => {
      await refreshCapabilities({
        machineId: config.machineId,
        configId: config.id,
      });
    },
    [refreshCapabilities]
  );

  const { checkBinaryStatus, installBinary } = useMachineAcpBinaryActions(runtime, workspaceId);

  const openCreateDialog = useCallback((machine: MachineViewMeta) => {
    setDialogMachine(machine);
    setDialogMode({ kind: 'create' });
  }, []);

  const openEditDialog = useCallback((machine: MachineViewMeta, config: AgentConfigMeta) => {
    setDialogMachine(machine);
    setDialogMode({ kind: 'edit', config });
  }, []);

  const handleDialogSubmit = useCallback(
    async (payload: AgentConfigSubmitPayload) => {
      if (!dialogMachine || !dialogMode) return;
      try {
        if (dialogMode.kind === 'create') {
          const config: AgentConfigMeta = {
            id: payload.id,
            name: payload.name,
            description: payload.description,
            cliType: payload.cliType,
            agentType: payload.agentType,
            customAcp: payload.customAcp,
            runtimeOverrides: payload.runtimeOverrides,
            env: payload.env,
            prompt: payload.prompt,
            titleGeneration: payload.titleGeneration,
            brandId: payload.brandId,
            machineId: dialogMachine.id,
          };
          if (payload.backgroundSetup) {
            await createSetup(config);
          } else {
            await createConfig(config);
          }
        } else {
          await updateConfig({
            id: dialogMode.config.id as AgentConfigId,
            machineId: dialogMode.config.machineId,
            name: payload.name,
            description: payload.description,
            cliType: payload.cliType,
            agentType: payload.agentType,
            customAcp: payload.customAcp,
            runtimeOverrides: payload.runtimeOverrides,
            env: payload.env,
            prompt: payload.prompt,
            titleGeneration: payload.titleGeneration,
            brandId: payload.brandId,
          });
        }
      } catch (error) {
        console.error('Failed to save agent config:', error);
        toast.error(
          dialogMode.kind === 'create'
            ? t('agents.createConfigError', 'Failed to create configuration')
            : t('agents.updateConfigError', 'Failed to update configuration')
        );
        throw error;
      }
    },
    [dialogMachine, dialogMode, createConfig, createSetup, updateConfig, t]
  );

  const handleRetrySetup = useCallback(
    async (setup: ProviderSetupTask) => {
      try {
        await retrySetup(setup.id);
      } catch (error) {
        toast.error(t('settings.agent.setup.retryFailed', 'Could not retry provider setup'));
        throw error;
      }
    },
    [retrySetup, t]
  );

  const handleDeleteSetup = useCallback(
    async (setup: ProviderSetupTask) => {
      try {
        await deleteSetup(setup.id);
      } catch (error) {
        toast.error(t('settings.agent.setup.deleteFailed', 'Could not cancel provider setup'));
        throw error;
      }
    },
    [deleteSetup, t]
  );

  const handleDeleteConfig = useCallback(
    async (config: AgentConfigMeta) => {
      try {
        await deleteConfig(config.id);
      } catch (error) {
        console.error('Failed to delete agent config:', error);
        toast.error(t('agents.deleteConfigError', 'Failed to delete configuration'));
        throw error;
      }
    },
    [deleteConfig, t]
  );

  const showBanner = mode === 'agents' && migration.status === 'running';
  const hasMachines = machines.size > 0;

  const banner = showBanner ? (
    <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {t('settings.agent.migration.banner', 'Upgrading agent configs to be per-machine…')}
    </div>
  ) : null;

  const dialog =
    dialogMode && dialogMachine ? (
      <AgentConfigDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) setDialogMode(null);
        }}
        nestedInDialog={!isMobile}
        mode={dialogMode}
        machine={dialogMachine}
        onSubmit={handleDialogSubmit}
        onRefreshCapabilities={refreshCapabilities}
        onCheckBinaryStatus={checkBinaryStatus}
        onInstallBinary={installBinary}
      />
    ) : null;

  if (isLoading && !hasMachines) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('workspace.machines.loadingVisibility', 'Loading machines')}
      </div>
    );
  }

  if (!hasMachines) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t('workspace.machines.empty', 'No machines connected')}
      </div>
    );
  }

  // Mobile Agents keeps machine selection and providers on one page. Machines
  // retains its list → detail navigation because the detail owns device controls.
  if (isMobile) {
    if (mode === 'agents') {
      return (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-y-auto">
          {banner ? <div className="px-3 pt-3">{banner}</div> : null}
          <div className="flex flex-col pb-4">
            {remoteMachinesAvailable && resolvedSelectedMachine ? (
              <MobileSettingsSection title={t('settings.tabs.machines', 'Machines')}>
                <MobileSettingsRow
                  label={
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        aria-hidden
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          selectedIsOnline ? 'bg-status-success' : 'bg-muted-foreground/35'
                        )}
                      />
                      <span className="truncate text-[0.95rem] font-medium leading-tight">
                        {resolvedSelectedMachine.name || resolvedSelectedMachine.id}
                      </span>
                    </div>
                  }
                  helper={
                    <span>
                      {selectedIsOnline
                        ? t('workspace.machines.online', 'Online')
                        : t('workspace.machines.offline', 'Offline')}
                      {isLocal ? ` · ${t('workspace.machines.thisDevice', 'This device')}` : ''}
                    </span>
                  }
                  onClick={() => setMobileMachinePickerOpen(true)}
                  trailing={<ChevronRight className="h-4 w-4" />}
                />
              </MobileSettingsSection>
            ) : null}
            {resolvedSelectedMachine ? (
              <MachineProvidersSection
                key={resolvedSelectedMachine.id}
                variant="mobile-list"
                machine={resolvedSelectedMachine}
                configs={configsForMachine}
                setups={setupsForMachine}
                onAddConfig={() => openCreateDialog(resolvedSelectedMachine)}
                onEditConfig={(config) => openEditDialog(resolvedSelectedMachine, config)}
                onDeleteConfig={handleDeleteConfig}
                onRefreshConfig={handleRefreshConfig}
                onRetrySetup={handleRetrySetup}
                onDeleteSetup={handleDeleteSetup}
              />
            ) : null}
            {reviewAgentEnabled ? (
              <MobileSettingsSection>
                <MobileSettingsRow
                  label={t('settings.review.title', 'Review agent')}
                  helper={t(
                    'settings.review.machineConfigHelper',
                    'Choose the reviewer used by sessions on each machine.'
                  )}
                  onClick={() => setMobileReviewPolicyOpen(true)}
                  trailing={<ChevronRight className="h-4 w-4" />}
                />
              </MobileSettingsSection>
            ) : null}
          </div>
          {remoteMachinesAvailable ? (
            <Drawer open={mobileMachinePickerOpen} onOpenChange={setMobileMachinePickerOpen}>
              <DrawerContent className="max-h-[80dvh]! rounded-t-2xl border-border/60">
                <DrawerTitle className="px-4 pb-1 pt-3 text-center text-[0.95rem]">
                  {t('settings.tabs.machines', 'Machines')}
                </DrawerTitle>
                <DrawerDescription className="sr-only">
                  {t('settings.agent.machineTabs.selectPromptAgent', 'Select a machine.')}
                </DrawerDescription>
                <div className="min-h-0 overflow-y-auto px-3 pb-[calc(12px+max(0px,var(--safe-area-bottom,0px)))] pt-2">
                  <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
                    {allItems.map((item, index) => {
                      const selected = item.machine.id === resolvedSelectedMachine?.id;
                      const itemIsLocal = item.machine.id === localMachineId;
                      return (
                        <button
                          key={item.machine.id}
                          type="button"
                          className={cn(
                            'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-muted/40',
                            index > 0 && 'border-t border-border'
                          )}
                          onClick={() => {
                            onSelectedMachineChange(item.machine.id);
                            setMobileMachinePickerOpen(false);
                          }}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              item.isOnline ? 'bg-status-success' : 'bg-muted-foreground/35'
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[0.95rem] font-medium">
                              {item.machine.name || item.machine.id}
                            </span>
                            <span className="mt-0.5 block truncate text-[0.78rem] text-muted-foreground">
                              {item.isOnline
                                ? t('workspace.machines.online', 'Online')
                                : t('workspace.machines.offline', 'Offline')}
                              {itemIsLocal
                                ? ` · ${t('workspace.machines.thisDevice', 'This device')}`
                                : ''}
                              {!item.sharedWithTeam
                                ? ` · ${t('workspace.machines.private', 'Private')}`
                                : ''}
                            </span>
                          </span>
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center text-primary">
                            {selected ? <Check className="h-4 w-4" /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </DrawerContent>
            </Drawer>
          ) : null}
          {reviewAgentEnabled ? (
            <Drawer open={mobileReviewPolicyOpen} onOpenChange={setMobileReviewPolicyOpen}>
              <DrawerContent className="h-[88dvh]! max-h-[88dvh]! rounded-t-2xl border-border/60">
                <DrawerTitle className="px-4 pb-1 pt-3 text-center text-[0.95rem]">
                  {t('settings.review.title', 'Review agent')}
                </DrawerTitle>
                <DrawerDescription className="sr-only">
                  {t(
                    'settings.review.machineConfigHelper',
                    'Choose the reviewer used by sessions on each machine.'
                  )}
                </DrawerDescription>
                <div className="min-h-0 flex-1 overflow-y-auto pb-[calc(12px+max(0px,var(--safe-area-bottom,0px)))]">
                  {mobileReviewPolicyOpen ? <ReviewPolicySection /> : null}
                </div>
              </DrawerContent>
            </Drawer>
          ) : null}
          {dialog}
        </div>
      );
    }

    if (resolvedSelectedMachine) {
      return (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
          {banner ? <div className="px-3 pt-3">{banner}</div> : null}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <MachineDetailPane
              key={resolvedSelectedMachine.id}
              mode="devices"
              readOnly={!isOwn}
              machine={resolvedSelectedMachine}
              configs={configsForMachine}
              setups={setupsForMachine}
              isOwn={isOwn}
              isLocal={isLocal}
              ownerName={ownerName}
              sharedWithTeam={sharedWithTeam}
              canDelete={isOwn && selectedCanDelete}
              onRename={actions.renameMachine}
              onDelete={actions.deleteMachine}
              onSharedWithTeamChange={
                isOwn && teamSharingAvailable ? actions.setSharedWithTeam : undefined
              }
              onAddConfig={() => openCreateDialog(resolvedSelectedMachine)}
              onEditConfig={(config) => openEditDialog(resolvedSelectedMachine, config)}
              onDeleteConfig={handleDeleteConfig}
              onRefreshConfig={handleRefreshConfig}
              onRetrySetup={handleRetrySetup}
              onDeleteSetup={handleDeleteSetup}
              onPing={isOwn && developerModeEnabled ? pingMachine : undefined}
              daemonUpdate={isOwn ? selectedDaemonUpdate : undefined}
              onRestartDaemon={isOwn && selectedCanRemoteRestart ? restartMachine : undefined}
              onUpgradeDaemon={isOwn && selectedDaemonUpdate ? upgradeMachine : undefined}
              monitorSnapshot={machineMonitor.snapshot}
              monitorState={machineMonitor.state}
              monitorSessionMetas={monitorSessionMetas}
              onOpenMonitorSession={openMonitorSession}
              onTerminateMonitorSession={
                isOwn
                  ? (monitoredSession) =>
                      terminateMonitorSession(resolvedSelectedMachine, monitoredSession)
                  : undefined
              }
              footer={
                <MachineConnectedResources
                  machineId={resolvedSelectedMachine.id}
                  configs={configsForMachine}
                  preloadedProjects={
                    connectedProjectsByMachineId.get(resolvedSelectedMachine.id) ?? []
                  }
                  projectsLoading={visibleLocalProjectsLoading}
                  readOnly={!isOwn}
                  onManageAgents={() => openAgentsForMachine(resolvedSelectedMachine.id)}
                />
              }
            />
          </div>
          {dialog}
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 p-3">
        {banner}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-2">
          <div className="min-h-0 flex-1">
            <MachineTabList
              variant="detailed"
              items={filteredModeItems}
              selectedMachineId={null}
              onSelect={(machineId) => onSelectedMachineChange(machineId)}
              filter={effectiveFilter}
              onFilterChange={setFilter}
              totalBeforeFilter={modeTotalBeforeFilter}
              showFilter
              showOwner
              ownerByUserId={machineOwnerMap}
            />
          </div>
          <OwnPrivateMachines
            items={ownPrivateItems}
            expanded={ownPrivateExpanded}
            onExpandedChange={setOwnPrivateExpanded}
            onOpen={openPrivateMachine}
          />
        </div>
      </div>
    );
  }

  // Desktop Agents keeps the compact pill selector. Desktop Machines uses one
  // full-width accordion list so the summary and detail share the same reading
  // order and only the expanded machine mounts monitoring UI.
  const title =
    mode === 'machines'
      ? t('settings.tabs.machines', 'Machines')
      : t('settings.tabs.agents', 'Agents');
  const subtitle =
    mode === 'machines'
      ? t(
          'settings.categories.machines.description',
          'View workspace machines and manage the machines you own.'
        )
      : t(
          'settings.categories.agents.description',
          'AI agent configurations available in this workspace.'
        );

  const header = (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {mode === 'machines' && remoteMachinesAvailable ? (
          <MachineListFilterButton filter={effectiveFilter} onFilterChange={setFilter} />
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
    </div>
  );

  const sharedAccordionItems = workspaceMachineSelectionPool.filter((item) => item.sharedWithTeam);

  const renderDesktopMachineSection = (item: MachineTabItem) => {
    const meta = getAccordionMeta(item);
    const expanded = item.machine.id === resolvedSelectedMachine?.id;
    if (!expanded) {
      return (
        <WorkspaceMachineCollapsedRow
          key={item.machine.id}
          meta={meta}
          onExpand={() => selectDesktopMachine(item.machine.id)}
        />
      );
    }

    return (
      <WorkspaceMachineExpandedSection
        key={item.machine.id}
        meta={meta}
        onCollapse={() => selectDesktopMachine(null)}
      >
        <MachineDetailPane
          key={item.machine.id}
          mode="devices"
          readOnly={!isOwn}
          machine={item.machine}
          configs={configsForMachine}
          setups={setupsForMachine}
          isOwn={isOwn}
          isLocal={isLocal}
          ownerName={ownerName}
          sharedWithTeam={sharedWithTeam}
          canDelete={isOwn && selectedCanDelete}
          onRename={actions.renameMachine}
          onDelete={actions.deleteMachine}
          onSharedWithTeamChange={
            isOwn && teamSharingAvailable ? actions.setSharedWithTeam : undefined
          }
          onAddConfig={() => openCreateDialog(item.machine)}
          onEditConfig={(config) => openEditDialog(item.machine, config)}
          onDeleteConfig={handleDeleteConfig}
          onRefreshConfig={handleRefreshConfig}
          onRetrySetup={handleRetrySetup}
          onDeleteSetup={handleDeleteSetup}
          onPing={isOwn && developerModeEnabled ? pingMachine : undefined}
          daemonUpdate={isOwn ? selectedDaemonUpdate : undefined}
          onRestartDaemon={isOwn && selectedCanRemoteRestart ? restartMachine : undefined}
          onUpgradeDaemon={isOwn && selectedDaemonUpdate ? upgradeMachine : undefined}
          canRevokeCredentials={isOwn && (credentialState?.revocableCount ?? 0) > 0}
          onRevokeCredentials={isOwn ? revokeMachineCredentials : undefined}
          monitorSnapshot={machineMonitor.snapshot}
          monitorState={machineMonitor.state}
          monitorSessionMetas={monitorSessionMetas}
          onOpenMonitorSession={openMonitorSession}
          onTerminateMonitorSession={
            isOwn
              ? (monitoredSession) => terminateMonitorSession(item.machine, monitoredSession)
              : undefined
          }
          footer={
            <MachineConnectedResources
              machineId={item.machine.id}
              configs={configsForMachine}
              preloadedProjects={connectedProjectsByMachineId.get(item.machine.id) ?? []}
              projectsLoading={visibleLocalProjectsLoading}
              readOnly={!isOwn}
              onManageAgents={() => openAgentsForMachine(item.machine.id)}
            />
          }
          accordion={{
            meta,
            onCollapse: () => selectDesktopMachine(null),
            headerRenderedExternally: true,
          }}
        />
      </WorkspaceMachineExpandedSection>
    );
  };

  if (mode !== 'agents') {
    if (!remoteMachinesAvailable) {
      return (
        <div className="flex w-full min-w-0 flex-col gap-4">
          {banner}
          {header}
          {resolvedSelectedMachine ? (
            <MachineDetailPane
              key={resolvedSelectedMachine.id}
              mode="devices"
              machine={resolvedSelectedMachine}
              configs={configsForMachine}
              setups={setupsForMachine}
              isOwn={isOwn}
              isLocal={isLocal}
              ownerName={ownerName}
              sharedWithTeam={sharedWithTeam}
              canDelete={isOwn && selectedCanDelete}
              onRename={actions.renameMachine}
              onDelete={actions.deleteMachine}
              onSharedWithTeamChange={
                isOwn && teamSharingAvailable ? actions.setSharedWithTeam : undefined
              }
              onAddConfig={() => openCreateDialog(resolvedSelectedMachine)}
              onEditConfig={(config) => openEditDialog(resolvedSelectedMachine, config)}
              onDeleteConfig={handleDeleteConfig}
              onRefreshConfig={handleRefreshConfig}
              onRetrySetup={handleRetrySetup}
              onDeleteSetup={handleDeleteSetup}
              onPing={isOwn && developerModeEnabled ? pingMachine : undefined}
              daemonUpdate={isOwn ? selectedDaemonUpdate : undefined}
              onRestartDaemon={isOwn && selectedCanRemoteRestart ? restartMachine : undefined}
              onUpgradeDaemon={isOwn && selectedDaemonUpdate ? upgradeMachine : undefined}
              canRevokeCredentials={isOwn && (credentialState?.revocableCount ?? 0) > 0}
              onRevokeCredentials={isOwn ? revokeMachineCredentials : undefined}
              monitorSnapshot={machineMonitor.snapshot}
              monitorState={machineMonitor.state}
              monitorSessionMetas={monitorSessionMetas}
              onOpenMonitorSession={openMonitorSession}
              onTerminateMonitorSession={(monitoredSession) =>
                terminateMonitorSession(resolvedSelectedMachine, monitoredSession)
              }
              footer={
                <MachineConnectedResources
                  machineId={resolvedSelectedMachine.id}
                  configs={configsForMachine}
                  preloadedProjects={
                    connectedProjectsByMachineId.get(resolvedSelectedMachine.id) ?? []
                  }
                  projectsLoading={visibleLocalProjectsLoading}
                  onManageAgents={() => openAgentsForMachine(resolvedSelectedMachine.id)}
                />
              }
            />
          ) : null}
          {dialog}
        </div>
      );
    }

    return (
      <div className="flex w-full min-w-0 flex-col gap-4">
        {banner}
        {header}

        <div className="space-y-3">
          {sharedAccordionItems.length > 0 ? (
            sharedAccordionItems.map(renderDesktopMachineSection)
          ) : (
            <div className="rounded-xl border border-border/50 bg-muted/10 px-4 py-8 text-center text-sm text-muted-foreground">
              {modeTotalBeforeFilter === 0
                ? t('workspace.machines.empty', 'No machines connected')
                : t(
                    'settings.agent.machineTabs.filter.noMatch',
                    'No machines match these filters.'
                  )}
              {modeTotalBeforeFilter > 0 ? (
                <div className="mt-2">
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto px-0 text-xs"
                    onClick={() => setFilter({ onlineOnly: false, mineOnly: false })}
                  >
                    {t('settings.agent.machineTabs.filter.reset', 'Clear filter')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {ownPrivateItems.length > 0 ? (
          <section className="space-y-3 pt-3">
            <div className="px-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {t('settings.machines.yourPrivateMachines', 'Your private machines')}
                </h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {ownPrivateItems.length}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(
                  'settings.machines.privateMachinesHint',
                  'These machines are not available to other workspace members. Select one here to manage sharing.'
                )}
              </p>
            </div>
            <div className="space-y-3">{ownPrivateItems.map(renderDesktopMachineSection)}</div>
          </section>
        ) : null}
        {dialog}
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      {banner}
      {header}

      <MachinePills
        pills={machinePills}
        selectedId={resolvedSelectedMachine?.id ?? null}
        onSelect={(id) => onSelectedMachineChange(id as MachineId)}
      />

      {resolvedSelectedMachine ? (
        <MachineProvidersSection
          key={resolvedSelectedMachine.id}
          flush
          machine={resolvedSelectedMachine}
          configs={configsForMachine}
          setups={setupsForMachine}
          onAddConfig={() => openCreateDialog(resolvedSelectedMachine)}
          onEditConfig={(config) => openEditDialog(resolvedSelectedMachine, config)}
          onDeleteConfig={handleDeleteConfig}
          onRefreshConfig={handleRefreshConfig}
          onRetrySetup={handleRetrySetup}
          onDeleteSetup={handleDeleteSetup}
        />
      ) : (
        <div className="px-1 py-8 text-center text-sm text-muted-foreground">
          {t('settings.agent.machineTabs.selectPromptAgent', 'Select a machine.')}
        </div>
      )}
      <ReviewPolicySection />
      {dialog}
    </div>
  );
}

function OwnPrivateMachines({
  items,
  expanded,
  onExpandedChange,
  onOpen,
}: {
  items: ReturnType<typeof buildMachineTabItems>['items'];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpen: (machineId: MachineId) => void;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-2">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 text-xs font-medium">
          {t('settings.machines.yourPrivateMachines', 'Your private machines')}
        </span>
        <span className="text-[11px] text-muted-foreground">{items.length}</span>
      </button>
      <p className="px-1 pb-1 text-[11px] leading-4 text-muted-foreground">
        {t(
          'settings.machines.privateMachinesHint',
          'These machines are not available to other workspace members. Select one here to manage sharing.'
        )}
      </p>
      {expanded ? (
        <div className="mt-1 space-y-1">
          {items.map((item) => (
            <Button
              key={item.machine.id}
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-between px-2 text-xs font-normal"
              onClick={() => onOpen(item.machine.id)}
            >
              <span className="truncate">{item.machine.name || item.machine.id}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t('settings.machines.manage', 'Manage')}
              </span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
