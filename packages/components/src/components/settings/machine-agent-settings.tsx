import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
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
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { toast } from '@/lib/toast';
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
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space } from '@lody/ui/tokens/scales.stylex';
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
import { settingsSurface as surface } from './surface';

const TRUNCATE = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/** The bottom sheet keeps the home indicator's room below its last row. */
const SHEET_BOTTOM = 'calc(12px + max(0px, var(--safe-area-bottom, 0px)))';

const styles = stylex.create({
  icon14: { width: '14px', height: '14px', flexShrink: 0 },
  icon16: { width: '16px', height: '16px', flexShrink: 0 },
  hint: { color: colors.tertiaryLabel },
  truncate: TRUNCATE,
  /** A note in the page: the region rung, a fill with no edge. */
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  bannerSlot: { paddingInline: space[3], paddingTop: space[3] },
  centered: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    height: '100%',
    padding: space[4],
    fontSize: '0.875em',
    color: colors.secondaryLabel,
  },
  column: { display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 },
  fill: { height: '100%', minHeight: 0 },
  scroll: { overflowY: 'auto' },
  clip: { flexGrow: 1, minHeight: 0, overflow: 'hidden' },
  mobileBody: { display: 'flex', flexDirection: 'column', paddingBottom: space[4] },
  mobileList: { gap: space[3], padding: space[3] },
  mobileListBody: {
    display: 'flex',
    flexGrow: 1,
    flexDirection: 'column',
    gap: space[3],
    minHeight: 0,
    overflow: 'hidden',
    padding: space[2],
  },
  grow: { flexGrow: 1, minHeight: 0 },
  machineLabel: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
  machineName: { ...TRUNCATE, fontSize: '0.95em', lineHeight: 1.25, fontWeight: 400 },
  dot: {
    flexShrink: 0,
    width: '8px',
    height: '8px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.tertiaryLabel,
  },
  dotOnline: { backgroundColor: colors.success },
  sheetTitle: {
    paddingInline: space[4],
    paddingTop: space[3],
    paddingBottom: space[1],
    textAlign: 'center',
    fontSize: '0.95em',
  },
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  sheetBody: {
    minHeight: 0,
    overflowY: 'auto',
    paddingInline: space[3],
    paddingTop: space[2],
    paddingBottom: SHEET_BOTTOM,
  },
  sheetPolicy: { flexGrow: 1, minHeight: 0, overflowY: 'auto', paddingBottom: SHEET_BOTTOM },
  /** A row of the machine picker: the whole line is the choice. */
  pickerRow: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    margin: 0,
    paddingInline: space[4],
    paddingBlock: space[3],
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':active': colors.hoverFill },
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '1em',
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  ruled: { boxShadow: `inset 0 1px 0 ${colors.separator}` },
  pickerText: { flexGrow: 1, minWidth: 0 },
  pickerName: { ...TRUNCATE, display: 'block', fontSize: '0.95em' },
  pickerMeta: {
    ...TRUNCATE,
    display: 'block',
    marginTop: '2px',
    fontSize: '0.78em',
    color: colors.secondaryLabel,
  },
  pickerCheck: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    color: colors.accent,
  },
  page: { display: 'flex', flexDirection: 'column', gap: space[4], width: '100%', minWidth: 0 },
  heading: { minWidth: 0 },
  headingLine: { display: 'flex', alignItems: 'center', gap: space[1.5] },
  headingTitle: { margin: 0, fontSize: '1em', fontWeight: 400, color: colors.label },
  headingSubtitle: {
    margin: 0,
    marginTop: '2px',
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  stack: { display: 'flex', flexDirection: 'column', gap: space[3] },
  emptyNote: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[8],
    textAlign: 'center',
    fontSize: '0.875em',
    color: colors.secondaryLabel,
  },
  privateSection: { display: 'flex', flexDirection: 'column', gap: space[3], paddingTop: space[3] },
  privateHeading: { paddingInline: space[1] },
  privateTitleLine: { display: 'flex', alignItems: 'center', gap: space[2] },
  privateTitle: { margin: 0, fontSize: '0.875em', fontWeight: 400, color: colors.label },
  count: { fontSize: '0.75em', fontVariantNumeric: 'tabular-nums', color: colors.secondaryLabel },
  privateHint: { margin: 0, marginTop: '2px', fontSize: '0.75em', color: colors.secondaryLabel },
  selectPrompt: {
    paddingInline: space[1],
    paddingBlock: space[8],
    textAlign: 'center',
    fontSize: '0.875em',
    color: colors.secondaryLabel,
  },
  /** The disclosure is the card's first line; the pointer fills the whole of it. */
  disclosure: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    margin: 0,
    paddingInline: space[4],
    paddingTop: '10px',
    paddingBottom: space[1],
    borderWidth: 0,
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '0.875em',
    fontWeight: 400,
    textAlign: 'start',
    cursor: 'pointer',
  },
  disclosureLabel: { flexGrow: 1, minWidth: 0 },
  privateCardHint: {
    margin: 0,
    paddingInline: space[4],
    paddingBottom: '10px',
    fontSize: '0.75em',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  /** A private machine: a line of the card that opens it. */
  privateRow: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    width: '100%',
    margin: 0,
    paddingInline: space[4],
    paddingBlock: '10px',
    borderWidth: 0,
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '0.875em',
    textAlign: 'start',
    cursor: 'pointer',
  },
  manage: { flexShrink: 0, fontSize: '0.75em', color: colors.secondaryLabel },
});

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
  const [dialogMachineId, setDialogMachineId] = useState<MachineId | null>(null);
  const dialogMachine = dialogMachineId ? machines.get(dialogMachineId) : undefined;
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
    setDialogMachineId(machine.id);
    setDialogMode({ kind: 'create' });
  }, []);

  const openEditDialog = useCallback((machine: MachineViewMeta, config: AgentConfigMeta) => {
    setDialogMachineId(machine.id);
    setDialogMode({ kind: 'edit', config });
  }, []);

  const handleDialogSubmit = useCallback(
    async (payload: AgentConfigSubmitPayload) => {
      if (!dialogMachineId || !dialogMode) return;
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
            machineId: dialogMachineId,
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
    [dialogMachineId, dialogMode, createConfig, createSetup, updateConfig, t]
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
    <div {...stylex.props(surface.formBlock, styles.banner)}>
      <Spinner size="small" />
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
        onScanPiExtensions={
          runtime
            ? ({ machineId, configId }) =>
                runtime.requestMachinePiExtensions(machineId, { configId })
            : undefined
        }
        onCheckBinaryStatus={checkBinaryStatus}
        onInstallBinary={installBinary}
      />
    ) : null;

  if (isLoading && !hasMachines) {
    return (
      <div {...stylex.props(styles.centered)}>
        <Spinner size="small" />
        {t('workspace.machines.loadingVisibility', 'Loading machines')}
      </div>
    );
  }

  if (!hasMachines) {
    return (
      <div {...stylex.props(styles.centered)}>
        {t('workspace.machines.empty', 'No machines connected')}
      </div>
    );
  }

  // Mobile Agents keeps machine selection and providers on one page. Machines
  // retains its list → detail navigation because the detail owns device controls.
  if (isMobile) {
    if (mode === 'agents') {
      return (
        <div {...stylex.props(styles.column, styles.fill, styles.scroll)}>
          {banner ? <div {...stylex.props(styles.bannerSlot)}>{banner}</div> : null}
          <div {...stylex.props(styles.mobileBody)}>
            {remoteMachinesAvailable && resolvedSelectedMachine ? (
              <MobileSettingsSection title={t('settings.tabs.machines', 'Machines')}>
                <MobileSettingsRow
                  label={
                    <div {...stylex.props(styles.machineLabel)}>
                      <span
                        aria-hidden
                        {...stylex.props(styles.dot, selectedIsOnline && styles.dotOnline)}
                      />
                      <span {...stylex.props(styles.machineName)}>
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
                  trailing={<ChevronRight {...stylex.props(styles.icon16)} />}
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
                  trailing={<ChevronRight {...stylex.props(styles.icon16)} />}
                />
              </MobileSettingsSection>
            ) : null}
          </div>
          {remoteMachinesAvailable ? (
            <Drawer open={mobileMachinePickerOpen} onOpenChange={setMobileMachinePickerOpen}>
              <DrawerContent className="max-h-[80dvh]!">
                <DrawerTitle {...stylex.props(styles.sheetTitle)}>
                  {t('settings.tabs.machines', 'Machines')}
                </DrawerTitle>
                <DrawerDescription {...stylex.props(styles.srOnly)}>
                  {t('settings.agent.machineTabs.selectPromptAgent', 'Select a machine.')}
                </DrawerDescription>
                <div {...stylex.props(styles.sheetBody)}>
                  <div {...stylex.props(surface.card)}>
                    {allItems.map((item, index) => {
                      const selected = item.machine.id === resolvedSelectedMachine?.id;
                      const itemIsLocal = item.machine.id === localMachineId;
                      return (
                        <button
                          key={item.machine.id}
                          type="button"
                          {...stylex.props(styles.pickerRow, index > 0 && styles.ruled)}
                          onClick={() => {
                            onSelectedMachineChange(item.machine.id);
                            setMobileMachinePickerOpen(false);
                          }}
                        >
                          <span
                            aria-hidden
                            {...stylex.props(styles.dot, item.isOnline && styles.dotOnline)}
                          />
                          <span {...stylex.props(styles.pickerText)}>
                            <span {...stylex.props(styles.pickerName)}>
                              {item.machine.name || item.machine.id}
                            </span>
                            <span {...stylex.props(styles.pickerMeta)}>
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
                          <span {...stylex.props(styles.pickerCheck)}>
                            {selected ? <Check {...stylex.props(styles.icon16)} /> : null}
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
              <DrawerContent className="h-[88dvh]! max-h-[88dvh]!">
                <DrawerTitle {...stylex.props(styles.sheetTitle)}>
                  {t('settings.review.title', 'Review agent')}
                </DrawerTitle>
                <DrawerDescription {...stylex.props(styles.srOnly)}>
                  {t(
                    'settings.review.machineConfigHelper',
                    'Choose the reviewer used by sessions on each machine.'
                  )}
                </DrawerDescription>
                <div {...stylex.props(styles.sheetPolicy)}>
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
        <div {...stylex.props(styles.column, styles.fill)}>
          {banner ? <div {...stylex.props(styles.bannerSlot)}>{banner}</div> : null}
          <div {...stylex.props(styles.column, styles.clip)}>
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
      <div {...stylex.props(styles.column, styles.fill, styles.mobileList)}>
        {banner}
        <div {...stylex.props(styles.mobileListBody)}>
          <div {...stylex.props(styles.grow)}>
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
    <div {...stylex.props(styles.heading)}>
      <div {...stylex.props(styles.headingLine)}>
        <h2 {...stylex.props(styles.headingTitle)}>{title}</h2>
        {mode === 'machines' && remoteMachinesAvailable ? (
          <MachineListFilterButton filter={effectiveFilter} onFilterChange={setFilter} />
        ) : null}
      </div>
      <p {...stylex.props(styles.headingSubtitle)}>{subtitle}</p>
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
        <div {...stylex.props(styles.page)}>
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
      <div {...stylex.props(styles.page)}>
        {banner}
        {header}

        <div {...stylex.props(styles.stack)}>
          {sharedAccordionItems.length > 0 ? (
            sharedAccordionItems.map(renderDesktopMachineSection)
          ) : (
            <div {...stylex.props(surface.card, styles.emptyNote)}>
              {modeTotalBeforeFilter === 0
                ? t('workspace.machines.empty', 'No machines connected')
                : t(
                    'settings.agent.machineTabs.filter.noMatch',
                    'No machines match these filters.'
                  )}
              {modeTotalBeforeFilter > 0 ? (
                <Button
                  variant="link"
                  size="small"
                  onClick={() => setFilter({ onlineOnly: false, mineOnly: false })}
                >
                  {t('settings.agent.machineTabs.filter.reset', 'Clear filter')}
                </Button>
              ) : null}
            </div>
          )}
        </div>

        {ownPrivateItems.length > 0 ? (
          <section {...stylex.props(styles.privateSection)}>
            <div {...stylex.props(styles.privateHeading)}>
              <div {...stylex.props(styles.privateTitleLine)}>
                <h3 {...stylex.props(styles.privateTitle)}>
                  {t('settings.machines.yourPrivateMachines', 'Your private machines')}
                </h3>
                <span {...stylex.props(styles.count)}>{ownPrivateItems.length}</span>
              </div>
              <p {...stylex.props(styles.privateHint)}>
                {t(
                  'settings.machines.privateMachinesHint',
                  'These machines are not available to other workspace members. Select one here to manage sharing.'
                )}
              </p>
            </div>
            <div {...stylex.props(styles.stack)}>
              {ownPrivateItems.map(renderDesktopMachineSection)}
            </div>
          </section>
        ) : null}
        {dialog}
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.page)}>
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
        <div {...stylex.props(styles.selectPrompt)}>
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
    <div {...stylex.props(surface.card)}>
      <button
        type="button"
        {...stylex.props(styles.disclosure, surface.pressableLine)}
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        {expanded ? (
          <ChevronDown {...stylex.props(styles.icon14, styles.hint)} />
        ) : (
          <ChevronRight {...stylex.props(styles.icon14, styles.hint)} />
        )}
        <span {...stylex.props(styles.disclosureLabel)}>
          {t('settings.machines.yourPrivateMachines', 'Your private machines')}
        </span>
        <span {...stylex.props(styles.count)}>{items.length}</span>
      </button>
      <p {...stylex.props(styles.privateCardHint)}>
        {t(
          'settings.machines.privateMachinesHint',
          'These machines are not available to other workspace members. Select one here to manage sharing.'
        )}
      </p>
      {expanded
        ? items.map((item) => (
            <button
              key={item.machine.id}
              type="button"
              {...stylex.props(styles.privateRow, surface.pressableLine, styles.ruled)}
              onClick={() => onOpen(item.machine.id)}
            >
              <span {...stylex.props(styles.truncate)}>{item.machine.name || item.machine.id}</span>
              <span {...stylex.props(styles.manage)}>
                {t('settings.machines.manage', 'Manage')}
              </span>
            </button>
          ))
        : null}
    </div>
  );
}
