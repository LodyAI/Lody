import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  buildPendingUserHistoryEntry,
  buildSessionPreparationRunConfig,
  buildSessionTurnInputConfig,
  evaluateSessionCreateQuota,
  extractPromptPreviewFromInputBlocks,
  findFreshSessionPresenceState,
  FREE_SESSION_LIMIT_PER_WORKSPACE,
  getServerNow,
  hashAnalyticsId,
  type SessionStartFailureReason,
  InFlightDedupe,
  normalizeSessionInputBlocks,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  githubFetchBranches,
  type LocalProjectGitState,
  type LocalProjectId,
  type MachineId,
  type MachineViewMeta,
  type ProjectRef,
  type SessionId,
  type SessionStatus,
  type WorktreeSetupScriptConfig,
  type WorktreeCleanupScriptConfig,
  type WorkspaceId,
} from '@lody/shared';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import { usePostHog } from '@posthog/react';
import {
  ArrowUp,
  FolderOpen,
  Github as GithubIcon,
  Loader2,
  LockKeyhole,
  Monitor,
  PanelLeft,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button } from '@/ui/button';

import {
  type AgentSelection,
  type AcpSessionSelectOption,
  WorktreeCheckboxPill,
  type WorkdirMode,
} from '@/components/shared';
import { cn } from '@/lib/utils';
import { getIpcServices, onIpcEvent, sendIpc } from '@/lib/electron-ipc-client';
import {
  bugReportDialogOpenAtom,
  chatLandingSessionStateAtomFamily,
  getAllAgentConfigAtom,
  inboxFeatureEnabledAtom,
  mobileKeyboardActionAtom,
  runtimeInitializingAtom,
  setMobileDrawerOpenAtom,
  navigationSidebarHiddenAtom,
  showNavigationSidebarAtom,
  tasksFeatureEnabledAtom,
  userAtom,
  workspaceReposCacheAtomFamily,
} from '@/atoms';
import { docMetaCacheReadyAtom, sessionMetaCountAtom } from '@/atoms/doc-meta';
import { localProbeAttemptedAtom, localProbeResultAtom } from '@/atoms/local-probe';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import { buildAgentPrompt } from '@/lib';
import { getAppCurrentPathWithSearch } from '@/lib/app-location';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { useNavigate } from '@tanstack/react-router';
import { activeWorkspaceRuntimeAtom, authTokenAtom, runtimeAtom } from '@/atoms/runtime';

import { toast } from 'sonner';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOpenSettings } from '@/hooks/use-open-settings';
import {
  focusFirstChatLandingOption,
  useChatLandingKeyboardNav,
} from '@/hooks/use-chat-landing-keyboard-nav';
import { useFireOnKeyChange, useFireOncePerKey } from '@/hooks/use-fire-once';
import {
  isArchivedLocalProjectRestoreUnavailableError,
  SessionCreateBillingError,
  useSessionActions,
} from '@/hooks/use-session-actions';
import { useChatLandingDefaults } from '@/hooks/use-chat-landing-defaults';
import {
  useAcpSessionConfigSelectionState,
  useResolvedAcpSessionConfigSelection,
} from '@/hooks/use-acp-session-config-selection';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import {
  getChatLandingAgentSelectionsForMachine,
  readChatLandingDefaults,
  resolvePreferredChatLandingAgentSelection,
} from '@/lib/chat-landing-defaults';
import {
  agentDefaultsCache,
  githubBranchesCache,
  persistAgentSessionDefaults,
} from '@/lib/local-storage-cache';
import { filterAcpSessionConfigOptionValues } from '@/lib/acp-session-config-selection';
import {
  buildRecentRunConfigItems,
  describeRunConfigSelection,
  getRecentRunConfigKey,
  readRecentRunConfigs,
  recordRecentRunConfig,
  resolveApplicableConfigOptionValues,
  sanitizeConfigOptionValues,
  type RecentRunConfigRecord,
} from '@/lib/recent-run-configs';
import {
  buildComposerAgentRoleItems,
  doesAgentRolePinPermissionMode,
  isComposerAgentRoleApplied,
  resolvePendingAgentRoleSelection,
} from '@/lib/composer-agent-roles';
import { buildAgentRoleFormValueFromRunConfig } from '@/lib/agent-role-form';
import {
  AgentRoleEditorDialog,
  openAgentRoleEditorForCreate,
  openAgentRoleEditorForEdit,
  type AgentRoleEditorState,
} from '@/components/settings/agent-role-editor-dialog';
import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import {
  useAgentRoleAvailability,
  useWorkspaceAgentRoles,
} from '@/hooks/use-workspace-agent-roles';
import { useAvailableCommands } from '@/hooks/use-available-commands';
import { useOrganization } from '@/hooks/useOrganization';
import { useResolvedTheme } from '../../theme-provider';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  areChatLandingBranchListsEqual,
  createChatLandingBranchSnapshot,
  getGitHubBranchesCacheId,
  normalizeChatLandingBranches,
  resolveChatLandingBranchSelection,
  type ChatLandingBranchSnapshot,
} from '@/lib/chat-landing-branches';
import {
  getLocalProjectBranchLabel,
  getLocalProjectGitStateLoadKey,
  getLocalProjectWorktreeAvailability,
  isLocalProjectMachineOffline,
  resolveLocalProjectBranchSelection,
} from '@/lib/chat-landing-git-state';
import { getGitHubOwnerAvatarUrl } from '@/lib/github-avatar';
import {
  capturePostHogEvent,
  detectAppLaunchMode,
  getDurationSinceMs,
  getPerformanceNowMs,
} from '@/lib/posthog-analytics';
import {
  SESSION_ACP_CONFIG_USED_EVENT,
  buildSessionCreateAcpAnalyticsProperties,
} from '@/lib/session-create-analytics';
import { toIntlLocale } from '@/lib/intl-locale';
import {
  arePastedTextDraftsEqual,
  getPastedTextCharacterCount,
  getPastedTextDraftsAfterInsertion,
  insertPastedTextDraft,
  normalizePastedTextDraft,
  sanitizePastedTextDrafts,
  shouldCapturePastedTextDraft,
  type PastedTextDraft,
} from '@/lib/pasted-text-draft';
import { wrapPastedTextChipLabel } from '@/components/mentions/mention-chips';

import { ErrorBoundary } from '@/components/error-boundary';
import { ChatLandingView, type ChatLandingHintType } from './chat-landing-view';
import { getSessionCreationNavigation } from './submission/use-composer-navigation-focus';
import { BranchSelector, getSelectorTagClassName } from './chat-landing-selectors';
import {
  extractIssuePRMentionsFromText,
  useKnownIssuePrItems,
} from '@/components/mentions/issue-pr-hash-mention';
import { useMentionPromptExpansion } from '@/components/mentions/mention-expansion';
import type { Mention as MentionRange } from '@/ui/mention/index';
import {
  arePersistedMentionRangesEqual,
  toPersistedMentionRanges,
} from '@/components/mentions/mention-persistence';
import {
  buildChatLandingDraftKey,
  chatLandingAppliedResetKeyAtomFamily,
} from '@/atoms/chat-landing-draft';
import { useChatLandingImageDraft } from '@/hooks/use-chat-landing-image-draft';
import { useChatLandingFileDraft } from '@/hooks/use-chat-landing-file-draft';
import { useChatLandingDraftSession } from '@/hooks/use-chat-landing-draft-session';
import { useSessionPreparation } from '@/hooks/use-session-preparation';
import { getCommandKeybindings, useCommand } from '@/lib/commands';
import { isElectronRenderer } from '@/lib/electron';
import { withGitHubTokenRetry } from '@/lib/github-token';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useVisibleLocalProjectsFromMachineIndex } from '@/hooks/use-visible-local-projects';
import {
  useLocalProjectRemovalResultNotifications,
  usePendingLocalProjectRemovals,
} from '@/hooks/use-remove-local-project';
import { useConvexErrorMessage } from '@/hooks/use-convex-error-message';
import {
  useVisibleArchivedSessionMetas,
  useVisibleSessionMetas,
} from '@/hooks/use-visible-session-metas';
import { useReportVisibleSessionsForEagerSync } from '@/hooks/use-report-visible-sessions-for-eager-sync';
import { getLocalProjectVisibilityKey } from '@/lib/visible-local-project-index';
import { shouldShowSessionSharing } from '@/lib/session-sharing';
import { isNativeAppShell } from '@/lib/native-platform';
import { openExternalUrl } from '@/lib/native-browser';
import { getDownloadPageUrl } from '@/lib/lody-urls';
import { useAppCapability } from '@/lib/app-platform';
import { resolveWorkspaceIdentityLogo } from '@/lib/workspace-identity';
import {
  readWorkdirModePreference,
  writeWorkdirModePreference,
} from '@/lib/workdir-mode-preferences';
import {
  resolveMobileKeyboardEnterKeyHint,
  shouldSubmitOnEnterForMobileKeyboardAction,
} from '@/lib/mobile-keyboard-action';
import { getChatComposerPromptPlaceholderKey } from '@/lib/chat-composer-placeholder';
import { splitImageAndFileAttachments } from '@/lib/file-drop';
import { canShowSubscriptionRateLimits } from '@/lib/session-usage';
import { canShowCodexResetForecast } from '@/lib/codex-reset-forecast';
import { createMachinePairing } from '@/lib/cli-api-key';
import { ContextSwitch, type SessionContextType } from './context-switch';
import {
  UNIFIED_PROJECT_OPTION_RENDER_LIMIT,
  UnifiedProjectSelectorView,
  buildUnifiedLocalProjectOptions,
  type LocalProjectSelection,
  type UnifiedProjectSelection,
} from './unified-project-selector';
import {
  DesktopMachineMenu,
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import { resolvePermissionModeFace } from '@/lib/permission-mode-face';
import { SessionUsagePopover } from '@/components/sessions/session-usage-popover';
import { MachinePairingDialog } from './machine-pairing-dialog';
import {
  DATE_BUCKET_THIS_MONTH,
  DATE_BUCKET_THIS_WEEK,
  DATE_BUCKET_TODAY,
  DATE_BUCKET_UNKNOWN,
  DATE_BUCKET_YESTERDAY,
  NO_PROJECT_BUCKET_ID,
  PINNED_BUCKET_ID,
} from '@/components/mobile/mobile-chat-list';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import {
  MobileHomeScreen,
  type MobileChatGroupBy,
  type MobileHomeGitHubRepository,
  type MobileInboxItem,
  type MobileHomeLocalProject,
  type MobileHomeMachine,
  type MobileHomeRecentLocalProject,
  type MobileHomeRecentRepo,
  type MobileHomeTab,
  type MobileProjectsSubTab,
} from '@/components/mobile/mobile-home-screen';
import type { FilterPill, MultiSelectPill } from '@/components/mobile/mobile-filter-pill-bar';
import type { MobileConversationKind } from '@/components/mobile/mobile-project-screen';
import {
  MobileProjectScreen,
  type MobileConversationItem,
  type MobileProjectContext,
} from '@/components/mobile/mobile-project-screen';
import { MobileLocalProjectSettings } from '@/components/mobile/mobile-local-project-settings';
import { MobileGithubProjectSettings } from '@/components/mobile/mobile-github-project-settings';
import {
  MobileNewChatSheet,
  type MobileNewChatSheetContentProps,
} from '@/components/mobile/mobile-new-chat-sheet';
import { MobileWorkspaceSwitcherSheet } from '@/components/mobile/mobile-workspace-switcher-sheet';
import { MobileCreateWorkspaceSheet } from '@/components/mobile/mobile-create-workspace-sheet';
import { MobileSessionRunConfig } from '@/components/mobile/mobile-session-run-config';
import { ChatComposer } from '@/components/chat/chat-composer';
import { useSessionMcpSelection } from '@/hooks/use-session-mcp-selection';
import {
  MobileProjectFileBrowser,
  type MobileProjectFileBrowserHandle,
} from '@/components/files/mobile-project-file-browser';
import {
  createLocalProjectIpcFileTransport,
  createLocalProjectRpcFileTransport,
  LocalProjectRpcFileProvider,
} from '@/lib/local-project-rpc-file-provider';
import { GitHubRepoFileProvider } from '@/lib/github-repo-file-provider';
import type { FileWorkspaceProvider } from '@/lib/file-workspace-provider';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { Folder as FolderIcon, GitBranch as GitBranchIcon } from 'lucide-react';
import { AddLocalProjectDialogContainer } from '@/components/local-projects/add-local-project-dialog-container';
import {
  MobileInlinePicker,
  MobileInlinePickerCoordinator,
  MobileInlinePickerRowSlot,
  type MobileInlinePickerOption,
} from '@/components/mobile/mobile-inline-picker';
import {
  buildChildSessionsByParent,
  buildSidebarOpenerRowResolver,
  getEffectiveSessionActivitySummary,
  getLatestPullRequestInfo,
} from '@/components/sessions/session-list-rows';
import { useOnlineMachines } from '@/hooks/use-online-machines';
import { getLocalProjectVisibilityKey as buildLocalProjectKey } from '@/lib/visible-local-project-index';
import {
  isThoughtLevelSelector,
  type AcpSelectConfigOptionSelector,
} from '@/components/shared/acp-selector-options';
import { useComposerCycleCommands } from '@/hooks/use-composer-cycle-commands';
import { chatScopeAtom } from '@/atoms/sidebar-state';
import {
  lodyConnectionUiStateAtom,
  lodyControlConnectionStateAtom,
} from '@/atoms/control-connection';
import {
  mobileHomeChatExcludedMachinesAtom,
  mobileHomeChatExcludedPrAtom,
  mobileHomeChatExcludedProjectsAtom,
  mobileHomeChatExcludedReposAtom,
  mobileHomeChatExcludedRunningAtom,
  mobileHomeChatViewModeAtom,
  mobileHomeProjectsSubTabAtom,
  useMobileHomeExcludedSetAtom,
} from '@/atoms/mobile-home-state';
import {
  buildChatLandingPreSelectionKey,
  compareChatLandingLocalProjectByRecency,
  getChatLandingSelectionSearch,
  getChatLandingSelectionSyncDecision,
  type ChatLandingSearch,
  compareChatLandingRepositoryByRecency,
  getChatLandingBranchSelectorState,
  getChatLandingHasAnyOnlineMachine,
  getChatLandingHintType,
  getChatLandingInitialDataLoading,
  getChatLandingLocalProjectAvailability,
  getChatLandingProjectRecency,
  getChatLandingSelectedMachineProjectStatus,
  getEmptyLocalProjectsMessageKey,
  getSharingReviewActionTarget,
  getSharingReviewSourceRevision,
  getSharingReviewSourcesReady,
  getSharingReviewTeamHasNoVisibleLocalResources,
  getSharingReviewTeamLooksEmpty,
  shouldRetrySharingReviewConflict,
  getChatLandingSubmitDisabled,
  getChatLandingVisibleComposerStatus,
  isChatLandingMachineReachable,
} from './chat-landing-derived';

interface ChatLandingProps {
  workspaceSlug: string;
  preSelectedContext?: 'local' | 'github' | 'chat';
  preSelectedMachine?: string;
  preSelectedProject?: string;
  preSelectedRepo?: string;
  /**
   * Mirrors the composer's effective selection back into the chat-route URL
   * (with `replace`) once the URL names a selection. Passed by the desktop
   * chat route only; mobile keeps its base-context model.
   */
  onSelectionUrlSync?: (search: ChatLandingSearch) => void;
  resetDraftKey?: string;
  resetDraftOnKeyChange?: boolean;
}

const getGitHubOwnerHandle = (fullName: string): string => {
  const [owner] = fullName.split('/');
  return owner?.trim() || 'GitHub';
};

const getGitHubRepoName = (fullName: string, fallback?: string): string => {
  const [, repoName] = fullName.split('/');
  return fallback?.trim() || repoName?.trim() || fullName;
};

/* Compact relative-time label used by the mobile project screen rows
   (e.g. "5m", "2h", "3d"). Mirrors the shape rendered by archive-view's
   local helper but stays inline so we don't add a dep on that file. */
function formatMobileAgeLabel(dateValue: number | string | undefined | null): string {
  if (dateValue == null) return '';
  const ts = typeof dateValue === 'number' ? dateValue : Date.parse(String(dateValue));
  if (!Number.isFinite(ts)) return '';
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function createSharingReviewWriterId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/* Bucket-id helpers shared by the mobile home Chat-tab filter predicates
   and (implicitly) by `MobileHomeScreen`'s grouping logic — both must
   classify items the same way for "filter out the open-PR bucket" to
   line up with "the bucket labelled Open". Keep these in sync with
   `bucketIdFor` in mobile-home-screen.tsx. */
function runningBucketIdFor(item: MobileConversationItem): string {
  if (item.isWorking) return 'working';
  if (item.isWaitingPermission) return 'waiting';
  if (item.isOffline) return 'offline';
  return 'idle';
}
function prBucketIdFor(item: MobileConversationItem): string {
  if (typeof item.prNumber !== 'number' || item.prNumber <= 0) return 'no-pr';
  return item.prStatus ?? 'open';
}

const getSessionGitHubRepoFullName = (session: { project?: ProjectRef; repoFullName?: string }) => {
  if (session.project?.kind === 'github') {
    return session.project.repoFullName;
  }
  return session.repoFullName?.trim() || null;
};

const getSessionLocalProjectKey = (session: {
  machineId: MachineId;
  project?: ProjectRef;
}): string | null => {
  if (session.project?.kind !== 'local') {
    return null;
  }
  return getLocalProjectVisibilityKey(session.machineId, session.project.localProjectId);
};

const isWorkspaceRuntimeUnavailableMessage = (message: string): boolean => {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes('workspace_runtime_unavailable') ||
    normalized.includes('workspace runtime is unavailable') ||
    normalized.includes('local workspace runtime is unavailable')
  );
};

/** Detect transient errors caused by CLI daemon not being ready yet (e.g. during Electron startup). */
const isDaemonUnavailableMessage = (message: string): boolean => {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes('fetch failed') ||
    normalized.includes('econnrefused') ||
    normalized.includes('daemon is unavailable') ||
    normalized.includes('cli daemon is unavailable')
  );
};

const warnWorkspaceRuntimeUnavailable = (message: string, context: string): void => {
  console.warn(`[chat-landing] ${context}: ${message}`);
};

const resolveLocalProjectGithubRepoFullName = (
  gitState: LocalProjectGitState | null | undefined,
  workspaceRepositories: { fullName: string }[] | null | undefined
): string | null => {
  if (!gitState?.git) return null;
  const repoFullName = gitState.githubRepoFullName?.trim();
  if (!repoFullName) return null;
  return workspaceRepositories?.some((repo) => repo.fullName === repoFullName)
    ? repoFullName
    : null;
};

type LocalProjectGitStateEntry = {
  machineId: MachineId;
  localProjectId: LocalProjectId;
  state: LocalProjectGitState;
};

type LocalProjectBranchSelection = {
  localProjectId: LocalProjectId;
  branch: string | null;
};

type LocalProjectWorkdirModeSelection = {
  localProjectId: LocalProjectId;
  mode: WorkdirMode;
};

type LocalProjectGitStateCacheEntry = {
  state: LocalProjectGitState;
  expiresAtMs: number;
};

const LOCAL_PROJECT_GIT_STATE_CACHE_TTL_MS = 20_000;
const LOCAL_PROJECT_GIT_STATE_CACHE_MAX_ENTRIES = 64;
const LOCAL_PROJECT_GIT_STATE_RPC_TIMEOUT_MS = 30_000;
const CHAT_LANDING_MACHINE_FLOCK_FAMILIES = [
  'localProject',
  'deleteLocalProjectCommand',
  'acpCapability',
  'rateLimit',
  'agentConfig',
  'providerSetup',
] as const;
// FIFO eviction relies on Map iteration order matching insertion order so the oldest
// entry can be dropped without an additional bookkeeping structure.
const localProjectGitStateCache = new Map<string, LocalProjectGitStateCacheEntry>();
const localProjectGitStateDedupe = new InFlightDedupe<string, LocalProjectGitState>();

const getLocalProjectGitStateCacheKey = (
  workspaceId: WorkspaceId,
  machineId: MachineId,
  localProjectId: LocalProjectId
): string => `${workspaceId}:${machineId}:${localProjectId}`;

const setLocalProjectGitStateCacheEntry = (
  cacheKey: string,
  entry: LocalProjectGitStateCacheEntry
): void => {
  localProjectGitStateCache.delete(cacheKey);
  localProjectGitStateCache.set(cacheKey, entry);
  while (localProjectGitStateCache.size > LOCAL_PROJECT_GIT_STATE_CACHE_MAX_ENTRIES) {
    const oldestKey = localProjectGitStateCache.keys().next().value;
    if (oldestKey === undefined) break;
    localProjectGitStateCache.delete(oldestKey);
  }
};

export function ChatLanding(props: ChatLandingProps) {
  return <WorkspaceChatLanding key={props.workspaceSlug} {...props} />;
}

function WorkspaceChatLanding({
  workspaceSlug,
  preSelectedContext,
  preSelectedMachine,
  preSelectedProject,
  preSelectedRepo,
  onSelectionUrlSync,
  resetDraftKey,
  resetDraftOnKeyChange = true,
}: ChatLandingProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { openSettings } = useOpenSettings();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceRuntime = useAtomValue(runtimeAtom);
  const postHog = usePostHog();
  const multiWorkspaceAvailable = useAppCapability('multiWorkspace');
  const currentUser = useAtomValue(userAtom);
  const userId = currentUser?.id;
  const tasksFeatureEnabled = useAtomValue(tasksFeatureEnabledAtom);
  const { activeOrganization, organizations, switchOrganization } = useOrganization({
    targetSlug: workspaceSlug,
  });
  const isMobile = useIsMobile();
  const mobileKeyboardAction = useAtomValue(mobileKeyboardActionAtom);
  const usesMobileKeyboardAction = isMobile || isNativeAppShell();
  const hidesBillingUi = usesMobileKeyboardAction;
  const promptEnterKeyHint = resolveMobileKeyboardEnterKeyHint(
    mobileKeyboardAction,
    usesMobileKeyboardAction
  );
  const resolvedTheme = useResolvedTheme();
  const isDark = resolvedTheme === 'dark';
  const tone = isDark ? 'dark' : 'light';
  const intlLocale = useMemo(
    () => toIntlLocale(i18n.resolvedLanguage ?? i18n.language),
    [i18n.language, i18n.resolvedLanguage]
  );
  const numberFormatter = useMemo(() => new Intl.NumberFormat(intlLocale), [intlLocale]);
  const authToken = useAtomValue(authTokenAtom);
  const [machinePairingDialogOpen, setMachinePairingDialogOpen] = useState(false);
  const [machinePairingCreating, setMachinePairingCreating] = useState(false);
  const [machinePairingCreateError, setMachinePairingCreateError] = useState<string | null>(null);
  const [machinePairing, setMachinePairing] = useState<{
    requestId: string;
    command: string;
    expiresAt: number;
  } | null>(null);
  const machinePairingSuccessNotifiedRef = useRef<string | null>(null);
  const machinePairingSelectedRef = useRef<string | null>(null);
  const observedMachinePairing = useCloudQuery(
    cloudOperations.machinePairing.getRequest,
    machinePairing ? { requestId: machinePairing.requestId } : 'skip'
  );
  const cancelMachinePairingRequest = useCloudMutation(
    cloudOperations.machinePairing.cancelRequest
  );
  const machinePairingStatus =
    observedMachinePairing === null
      ? 'expired'
      : (observedMachinePairing?.status ?? (machinePairing ? 'pending' : null));
  const pairedMachineId = observedMachinePairing?.machineId as MachineId | undefined;
  const runtimeInitializing = useAtomValue(runtimeInitializingAtom);
  const controlConnectionState = useAtomValue(lodyControlConnectionStateAtom);
  // The durable meta-room first remote sync (which carries machine docs and
  // their `localProjects`) has not completed until the control state reaches
  // 'online'. 'idle'/'connecting'/'syncing' are the pre-first-sync states;
  // post-'online' reconnects keep the already-synced machine docs in cache, so
  // they don't need this gate.
  const isMetaRoomFirstSyncPending =
    controlConnectionState === 'idle' ||
    controlConnectionState === 'connecting' ||
    controlConnectionState === 'syncing';
  const executorConfigs = useAtomValue(getAllAgentConfigAtom);
  const { workspaceId } = useResolvedWorkspaceScope();
  const setLocalProjectSharedWithTeam = useCloudMutation(
    cloudOperations.localProjects.setLocalProjectSharedWithTeam
  );
  const cachedRepositories = useAtomValue(workspaceReposCacheAtomFamily(workspaceId));
  const visibleMachineIndex = useVisibleMachineMetas({
    machineFlockFamilies: CHAT_LANDING_MACHINE_FLOCK_FAMILIES,
  });
  const {
    machines,
    accessByMachineId,
    machineFlockRemoteSyncedMachineIds,
    isLoading: visibleMachinesLoading,
  } = visibleMachineIndex;
  const visibleMachineIds = useMemo(() => Array.from(machines.keys()), [machines]);
  const pendingLocalProjectRemovals = usePendingLocalProjectRemovals(visibleMachineIds);
  useLocalProjectRemovalResultNotifications(visibleMachineIds);
  const visibleLocalProjects = useVisibleLocalProjectsFromMachineIndex(visibleMachineIndex);
  const {
    projects: visibleLocalProjectMap,
    accessByProjectKey: visibleLocalProjectAccess,
    isLoading: visibleLocalProjectsLoading,
  } = visibleLocalProjects;
  const getProjectShareErrorMessage = useConvexErrorMessage();
  const { sessions: visibleActiveSessions, allActiveSessions: visibleAllActiveSessions } =
    useVisibleSessionMetas();
  useReportVisibleSessionsForEagerSync(
    'chat-landing',
    visibleActiveSessions,
    visibleAllActiveSessions
  );
  const { archivedSessions: visibleArchivedSessions } = useVisibleArchivedSessionMetas();
  const showProjectSharing = shouldShowSessionSharing({
    workspaceId,
    activeWorkspaceId: activeOrganization?.id ?? null,
    memberCount: activeOrganization?.members.length ?? null,
  });
  const inboxRows = useCloudQuery(
    cloudOperations.inbox.listMine,
    showProjectSharing && workspaceId ? { workspaceId } : 'skip'
  );
  const sharingReviewServerState = useCloudQuery(
    cloudOperations.inbox.getSharingReviewState,
    workspaceId ? { workspaceId } : 'skip'
  );
  const sharingReviewInboxRevisionRef = useRef<string | null>(null);
  const sharingReviewReconcileRef = useRef({
    workspaceId: null as string | null,
    writerId: createSharingReviewWriterId(),
    attempt: 0,
  });
  const sharingReviewInboxReady = sharingReviewServerState !== undefined;
  if (sharingReviewInboxReady) {
    sharingReviewInboxRevisionRef.current = sharingReviewServerState?.sourceRevision ?? null;
  }
  const reconcileSharingReview = useCloudMutation(cloudOperations.inbox.reconcileSharingReview);
  const markInboxItemRead = useCloudMutation(cloudOperations.inbox.markRead);
  const dismissInboxItem = useCloudMutation(cloudOperations.inbox.dismiss);
  const suppressSharingReview = useCloudMutation(cloudOperations.inbox.suppressSharingReview);
  const handleShareLocalProjectWithTeam = useCallback(
    async (selection: LocalProjectSelection) => {
      if (!workspaceId) throw new Error('Workspace is not ready');
      await setLocalProjectSharedWithTeam({
        workspaceId,
        machineId: selection.machineId,
        localProjectId: selection.localProjectId,
        sharedWithTeam: true,
      });
    },
    [setLocalProjectSharedWithTeam, workspaceId]
  );
  const presenceStates = useAtomValue(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue(lodyPresenceNowMsAtom);
  /* Default cross-feature `visibleSessions` reference stays mapped to
     the *active* list — that's what every existing consumer (desktop
     sidebar, project pickers, analytics, etc.) wants. The mobile
     archive toggle picks the archived list explicitly when needed
     (see `mobileHomeChats` / `mobileProjectConversations`). */
  const visibleSessions = visibleActiveSessions;
  const liveSessionStatuses = useMemo(() => {
    const next = new Map<string, SessionStatus>();
    for (const session of visibleAllActiveSessions) {
      const status = findFreshSessionPresenceState(
        presenceStates,
        session.id,
        presenceNowMs
      )?.status;
      if (status) {
        next.set(session.id, status);
      }
    }
    return next;
  }, [presenceNowMs, presenceStates, visibleAllActiveSessions]);
  // Best-effort count of sessions this user has already created (active +
  // archived), used to derive `session_number`/`is_first_session_ever` for the
  // activation anchor (spec §3.1). Client-side CRDT visibility is not an
  // authoritative cross-client/CLI count — the server-side union anchor (§3.4)
  // remains the source of truth; this only lets the Web funnel define "first".
  const ownPriorSessionCount = useMemo(() => {
    if (!userId) return 0;
    let count = 0;
    for (const session of visibleActiveSessions) {
      if (session.userId === userId) count += 1;
    }
    for (const session of visibleArchivedSessions) {
      if (session.userId === userId) count += 1;
    }
    return count;
  }, [userId, visibleActiveSessions, visibleArchivedSessions]);
  const ownPriorSessionCountRef = useRef(ownPriorSessionCount);
  ownPriorSessionCountRef.current = ownPriorSessionCount;
  const docMetaCacheReady = useAtomValue(docMetaCacheReadyAtom);
  const localSessionCount = useAtomValue(sessionMetaCountAtom);
  const localProbeResult = useAtomValue(localProbeResultAtom);
  const localProbeAttempted = useAtomValue(localProbeAttemptedAtom);
  const onlineMachineIds = useOnlineMachineIds();
  const onlineMachineIdsRef = useRef(onlineMachineIds);
  onlineMachineIdsRef.current = onlineMachineIds;
  const isPresenceMachineOnline = useCallback(
    (machineId: string) => onlineMachineIds.has(machineId as MachineId),
    [onlineMachineIds]
  );
  const freshRepositories = useCloudQuery(
    cloudOperations.github.getWorkspaceRepositories,
    workspaceId ? { workspaceId } : 'skip'
  );
  const billingEntitlement = useCloudQuery(
    cloudOperations.billing.getWorkspaceBillingEntitlement,
    workspaceId ? { workspaceId } : 'skip'
  );
  const workspaceReposWithStatus = useCloudQuery(
    cloudOperations.github.listWorkspaceReposWithStatus,
    workspaceId ? { workspaceId } : 'skip'
  ) as
    | {
        repoFullName: string;
        worktreeSetup?: WorktreeSetupScriptConfig;
        worktreeCleanup?: WorktreeCleanupScriptConfig;
      }[]
    | null
    | undefined;
  const repositories = freshRepositories ?? cachedRepositories ?? undefined;
  const isElectron = isElectronRenderer();
  const launchMode = useMemo(() => detectAppLaunchMode(isElectron), [isElectron]);
  const hasGitHubRepos = (repositories?.length ?? 0) > 0;
  const repositoriesReady = freshRepositories !== undefined;
  const sharingReviewState = useMemo(() => {
    const privateMachineIds = Array.from(accessByMachineId.values())
      .filter((access) => access.ownerUserId === userId && !access.sharedWithTeam)
      .map((access) => access.machineId)
      .sort();
    const privateProjectKeys = Array.from(visibleLocalProjectAccess.entries())
      .filter(([, access]) => {
        if (access.ownerUserId !== userId) return false;
        const machineAccess = accessByMachineId.get(access.machineId as MachineId);
        return !access.sharedWithTeam || machineAccess?.sharedWithTeam !== true;
      })
      .map(([key]) => key)
      .sort();
    const sourcesReady = getSharingReviewSourcesReady({
      docMetaCacheReady,
      visibleMachinesLoading,
      visibleLocalProjectsLoading,
      repositoriesReady,
      isMetaRoomFirstSyncPending,
    });
    const teamLooksEmpty = getSharingReviewTeamLooksEmpty({
      sourcesReady,
      machineCount: machines.size,
      localProjectCount: visibleLocalProjectMap.size,
      activeSessionCount: visibleActiveSessions.length,
      archivedSessionCount: visibleArchivedSessions.length,
      githubRepositoryCount: repositories?.length ?? 0,
    });
    const teamHasNoVisibleLocalResources = getSharingReviewTeamHasNoVisibleLocalResources({
      sourcesReady,
      machineCount: machines.size,
      localProjectCount: visibleLocalProjectMap.size,
    });
    const memberRevision = (activeOrganization?.members ?? [])
      .map((member) => member.userId)
      .sort()
      .join(',');
    const privateMachineCount = privateMachineIds.length;
    const privateProjectCount = privateProjectKeys.length;
    return {
      active:
        showProjectSharing &&
        sourcesReady &&
        (privateMachineCount > 0 || privateProjectCount > 0 || teamHasNoVisibleLocalResources),
      ready: sourcesReady,
      privateMachineCount,
      privateProjectCount,
      actionTarget: getSharingReviewActionTarget({ privateMachineCount, privateProjectCount }),
      teamHasNoVisibleLocalResources,
      teamLooksEmpty,
      revision: getSharingReviewSourceRevision([
        `members:${memberRevision}`,
        `machines:${privateMachineIds.join(',')}`,
        `projects:${privateProjectKeys.join(',')}`,
        `no-local:${teamHasNoVisibleLocalResources ? 1 : 0}`,
        `empty:${teamLooksEmpty ? 1 : 0}`,
      ]),
    };
  }, [
    accessByMachineId,
    activeOrganization?.members,
    docMetaCacheReady,
    isMetaRoomFirstSyncPending,
    machines.size,
    repositories,
    repositoriesReady,
    showProjectSharing,
    userId,
    visibleActiveSessions.length,
    visibleArchivedSessions.length,
    visibleLocalProjectAccess,
    visibleLocalProjectMap.size,
    visibleLocalProjectsLoading,
    visibleMachinesLoading,
  ]);
  useEffect(() => {
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    if (!workspaceId || activeOrganization?.id !== workspaceId) return cancel;
    if (!sharingReviewInboxReady) return cancel;
    const isTeamWorkspace = (activeOrganization?.members.length ?? 0) > 1;
    if (isTeamWorkspace && !sharingReviewState.ready) return cancel;
    const tracker = sharingReviewReconcileRef.current;
    if (tracker.workspaceId !== workspaceId) {
      tracker.workspaceId = workspaceId;
      tracker.writerId = createSharingReviewWriterId();
      tracker.attempt = 0;
    }
    const attempt = ++tracker.attempt;
    const writerId = tracker.writerId;
    const desiredRevision = sharingReviewState.revision;
    const desiredActive = isTeamWorkspace && sharingReviewState.active;
    const expectedSourceRevision = sharingReviewInboxRevisionRef.current;
    void (async () => {
      const result = await reconcileSharingReview({
        workspaceId,
        active: desiredActive,
        sourceRevision: desiredRevision,
        expectedSourceRevision,
        reconcileWriterId: writerId,
        reconcileAttempt: attempt,
      });
      if (
        !result.conflict ||
        !shouldRetrySharingReviewConflict({
          writerId,
          attempt,
          serverWriterId: result.reconcileWriterId,
          serverAttempt: result.reconcileAttempt,
          isLatestAttempt:
            !cancelled &&
            tracker.workspaceId === workspaceId &&
            tracker.writerId === writerId &&
            tracker.attempt === attempt,
        })
      ) {
        return;
      }
      await reconcileSharingReview({
        workspaceId,
        active: desiredActive,
        sourceRevision: desiredRevision,
        expectedSourceRevision: result.sourceRevision,
        reconcileWriterId: writerId,
        reconcileAttempt: attempt,
      });
    })();
    return cancel;
  }, [
    activeOrganization?.id,
    activeOrganization?.members.length,
    reconcileSharingReview,
    sharingReviewInboxReady,
    sharingReviewState.active,
    sharingReviewState.ready,
    sharingReviewState.revision,
    workspaceId,
  ]);
  const {
    startSession,
    requestSessionDispatch,
    setSessionPinned,
    archiveSession,
    restoreSession,
    deleteArchivedSession,
  } = useSessionActions();
  const openMobileDrawer = useSetAtom(setMobileDrawerOpenAtom);
  const setBugReportDialogOpen = useSetAtom(bugReportDialogOpenAtom);
  const isLeftSidebarHidden = useAtomValue(navigationSidebarHiddenAtom);
  const showNavigationSidebar = useSetAtom(showNavigationSidebarAtom);
  const visibleLocalMachineId = useMemo(() => {
    const machineId = localProbeResult?.machineId as MachineId | undefined;
    return machineId && machines.has(machineId) ? machineId : null;
  }, [localProbeResult?.machineId, machines]);

  const isOwnVisibleMachine = useCallback(
    (machineId: MachineId) => {
      if (visibleLocalMachineId === machineId) return true;
      const access = accessByMachineId.get(machineId);
      return Boolean(userId && access?.ownerUserId === userId);
    },
    [accessByMachineId, userId, visibleLocalMachineId]
  );

  const hasLocalProjects = visibleLocalProjectMap.size > 0;
  const localProjectCount = visibleLocalProjectMap.size;

  // ── Context type (Local Projects vs GitHub Worktrees) ──
  const [contextType, setContextType] = useState<SessionContextType>(
    () =>
      preSelectedContext ??
      readChatLandingDefaults(workspaceId)?.contextType ??
      (isMobile ? 'github' : 'chat')
  );
  const analyticsProjectKind = contextType === 'chat' ? null : contextType;

  // ── Prompt state (shared across contexts) ──
  const chatLandingStateKey = userId ?? null;
  const [sessionState, setSessionState] = useAtom(
    chatLandingSessionStateAtomFamily(chatLandingStateKey)
  );
  /**
   * Scope for the attachment draft and the reserved session id. Unlike the
   * prompt text this is workspace-scoped, because an uploaded image/file is
   * addressable only inside the workspace it was uploaded to.
   */
  const chatLandingDraftKey = buildChatLandingDraftKey(chatLandingStateKey, workspaceSlug);
  const prompt = sessionState.prompt;
  const [draftActivityRevision, setDraftActivityRevision] = useState(0);
  const pastedTextDrafts = useMemo(
    () => sanitizePastedTextDrafts(sessionState.pastedTextDrafts),
    [sessionState.pastedTextDrafts]
  );
  /**
   * Committed mention ranges, kept for the before-send rewrite. `@path` and
   * `#123` survive into the sent text unchanged, so the range is the only
   * record that the region was ever a mention.
   *
   * The persisted copy is the only copy. It is narrower than the live range —
   * no `pasted_text`, no kindless range — and neither rewrite builder wants
   * either of those: pasted text is rebuilt from `pastedTextDrafts`, and a
   * range with no kind has nothing to dispatch on. Holding a second live list
   * beside it would be two states updated from one callback that must not
   * drift, which is the bug `session-chat-input-area.tsx` documents.
   */
  const persistedMentionRanges = sessionState.mentionRanges;
  const handleMentionRangesChange = useCallback(
    (ranges: MentionRange[]) => {
      // Stored with the prompt so a returning draft does not have to have its
      // mentions recognised again from the text — which only works once each
      // source has loaded, and not at all for one that never does.
      const persisted = toPersistedMentionRanges(ranges);
      setSessionState((prev) =>
        arePersistedMentionRangesEqual(prev.mentionRanges ?? [], persisted)
          ? prev
          : { ...prev, mentionRanges: persisted }
      );
    },
    [setSessionState]
  );
  const [composerStatus, setComposerStatus] = useState<{
    message: ReactNode;
    tone: 'error' | 'warning' | 'info';
  } | null>(null);
  const setPrompt = useCallback(
    (value: string) => {
      setSessionState((prev) => ({ ...prev, prompt: value }));
      setDraftActivityRevision((revision) => revision + 1);
      setComposerStatus(null);
    },
    [setSessionState]
  );
  const setComposerError = useCallback((message: string) => {
    setComposerStatus({ message, tone: 'error' });
  }, []);
  const setPastedTextDrafts = useCallback(
    (drafts: PastedTextDraft[]) => {
      setSessionState((prev) => {
        const sanitizedDrafts = sanitizePastedTextDrafts(drafts);
        if (
          arePastedTextDraftsEqual(sanitizePastedTextDrafts(prev.pastedTextDrafts), sanitizedDrafts)
        ) {
          return prev;
        }
        return { ...prev, pastedTextDrafts: sanitizedDrafts };
      });
      setComposerStatus(null);
    },
    [setSessionState]
  );
  const clearPastedTextDrafts = useCallback(() => {
    setSessionState((prev) => {
      if (sanitizePastedTextDrafts(prev.pastedTextDrafts).length === 0) {
        return prev;
      }
      return { ...prev, pastedTextDrafts: [] };
    });
  }, [setSessionState]);

  // ── Machine & Agent selection ──
  const [selectedMachineId, setSelectedMachineId] = useState<MachineId | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const mcpSelection = useSessionMcpSelection(undefined, { disabled: submitting });
  // The project selector always uses the machine-aware picker so multi-machine
  // workspaces can choose the target explicitly. Standalone Electron entry
  // points such as the sidebar and onboarding may still use the native dialog.
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [addProjectInitialMachineId, setAddProjectInitialMachineId] = useState<MachineId | null>(
    null
  );
  const openAddProjectDialog = useCallback((initialMachineId?: MachineId | null) => {
    setAddProjectInitialMachineId(initialMachineId ?? null);
    setAddProjectOpen(true);
  }, []);
  const handleAddProjectOpenChange = useCallback((open: boolean) => {
    setAddProjectOpen(open);
    if (!open) {
      setAddProjectInitialMachineId(null);
    }
  }, []);
  /* Mobile-only: controls the bottom-sheet composer launched from the
     home screen's new-chat chip. The sheet hosts the same composer +
     selectors as the desktop landing — opening it doesn't navigate,
     so the home tab list stays visible underneath. */
  const [mobileNewChatOpen, setMobileNewChatOpen] = useState(false);

  /* Mobile-only: controls the bottom-sheet workspace switcher launched
     from the home screen's workspace pill. Replaces the inline dropdown
     so the switcher can host create / invite actions in a layout that
     matches the rest of the mobile chrome. */
  const [mobileWorkspaceSheetOpen, setMobileWorkspaceSheetOpen] = useState(false);
  /* Standalone "create workspace" bottom-sheet. We open this from the
     workspace switcher's create-row instead of routing to
     /settings/account — that destination was a relic from before the
     mobile create flow existed and was an actively confusing UX
     (settings ≠ where you go to create something new). */
  const [mobileCreateWorkspaceOpen, setMobileCreateWorkspaceOpen] = useState(false);
  // ── GitHub context state ──
  const [selectedRepo, setSelectedRepo] = useState<string | undefined>(undefined);
  const selectedRepoWorktreeSetup = useMemo(() => {
    if (!selectedRepo) return undefined;
    return workspaceReposWithStatus?.find((repo) => repo.repoFullName === selectedRepo)
      ?.worktreeSetup;
  }, [selectedRepo, workspaceReposWithStatus]);
  const selectedRepoWorktreeCleanup = useMemo(() => {
    if (!selectedRepo) return undefined;
    return workspaceReposWithStatus?.find((repo) => repo.repoFullName === selectedRepo)
      ?.worktreeCleanup;
  }, [selectedRepo, workspaceReposWithStatus]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [repoBranches, setRepoBranches] = useState<string[]>([]);
  const [repoDefaultBranch, setRepoDefaultBranch] = useState<string | null>(null);
  const applyGitHubBranchSnapshot = useCallback((snapshot: ChatLandingBranchSnapshot) => {
    setRepoDefaultBranch((prev) =>
      prev === snapshot.defaultBranch ? prev : snapshot.defaultBranch
    );
    setRepoBranches((prev) =>
      areChatLandingBranchListsEqual(prev, snapshot.branches) ? prev : snapshot.branches
    );
    setSelectedBranch((prev) => {
      const next = resolveChatLandingBranchSelection(snapshot, prev);
      return next === prev ? prev : next;
    });
  }, []);

  // ── Local project context state ──
  const [selectedLocalProject, setSelectedLocalProject] = useState<LocalProjectSelection | null>(
    null
  );
  const [localGitState, setLocalGitState] = useState<LocalProjectGitStateEntry | null>(null);
  const [localGitStateError, setLocalGitStateError] = useState<string | null>(null);
  const [localGitStateRetryNonce, setLocalGitStateRetryNonce] = useState(0);
  const [selectedLocalBranchState, setSelectedLocalBranchState] =
    useState<LocalProjectBranchSelection | null>(null);
  const [selectedWorkdirModeState, setSelectedWorkdirModeState] =
    useState<LocalProjectWorkdirModeSelection | null>(null);
  const [loadingLocalGitState, setLoadingLocalGitState] = useState(false);

  // ── Common refs ──
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Scope root for the keyboard-nav controller (arrow roving over the desktop landing's
  // config + composer column). Mobile/touch keeps native focus behavior.
  const keyboardNavRef = useRef<HTMLDivElement>(null);
  const keyboardNavEnabled = !isMobile;
  useChatLandingKeyboardNav(keyboardNavRef, {
    enabled: keyboardNavEnabled,
  });

  // Focus the new-chat composer with ⌘L on the landing. Shares the `session.focusInput`
  // command id (and binding) with the in-session composer; the two surfaces don't both
  // "win" the shortcut — on desktop only one mounts at a time, and on mobile the registry
  // stack lets the most-recently-mounted (the open session) take the binding.
  useCommand({
    id: 'session.focusInput',
    title: t('commands.session.focusInput', 'Focus Current Input'),
    category: 'Editor',
    keybindings: getCommandKeybindings('session.focusInput'),
    when: () => Boolean(promptTextareaRef.current),
    run: () => {
      const el = promptTextareaRef.current;
      if (!el) return;
      // Where keyboard nav is on, ⌘L is a toggle: focus the composer, or — when it's
      // already focused — leave its focus mode and hand control to the option ring (Esc
      // does the same from the keyboard-nav controller).
      if (keyboardNavEnabled && document.activeElement === el) {
        focusFirstChatLandingOption(keyboardNavRef.current, el);
        return;
      }
      el.focus();
    },
  });
  const landingLoadStartMsRef = useRef(getPerformanceNowMs());
  const fireLandingViewedOnce = useFireOncePerKey();
  const fireProjectSourceReadyOnce = useFireOncePerKey();
  const previousContextTypeRef = useRef(contextType);
  const fireProjectSelectedOnChange = useFireOnKeyChange();
  const fireAgentConfigOnChange = useFireOnKeyChange();
  const preSelectionAppliedRef = useRef<string | null>(null);
  // False while a just-applied URL intent has not rendered yet; the selection
  // mirror must not compare against that pre-application state.
  const selectionSyncArmedRef = useRef(false);
  const selectedLocalProjectRef = useRef<LocalProjectSelection | null>(null);
  selectedLocalProjectRef.current = selectedLocalProject;
  // `machines` is read inside fetchLocalGitState only for an offline pre-check.
  // Read it through a ref so the heartbeat-driven identity churn of `machines`
  // (lastSeen is rewritten every ~20s per online machine) does not re-create
  // fetchLocalGitState and needlessly re-run the git-state loading effect every
  // few seconds. Online↔offline transitions that *should* re-trigger a load are
  // tracked separately via `selectedLocalProjectMachineOnline`.
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const selectedLocalProjectMachineId = selectedLocalProject?.machineId ?? null;
  const activeLocalProjectId = selectedLocalProject?.localProjectId ?? null;
  const hasWorkspaceRuntime = Boolean(runtime);
  const canUseSelectedLocalProjectDesktopControl = useMemo(
    () =>
      isElectron &&
      selectedLocalProjectMachineId !== null &&
      visibleLocalMachineId === selectedLocalProjectMachineId,
    [isElectron, selectedLocalProjectMachineId, visibleLocalMachineId]
  );
  const activeLocalGitState = useMemo(() => {
    if (
      !selectedLocalProject ||
      localGitState?.machineId !== selectedLocalProject.machineId ||
      localGitState?.localProjectId !== selectedLocalProject.localProjectId
    ) {
      return null;
    }
    return localGitState.state;
  }, [localGitState, selectedLocalProject]);
  const selectedLocalBranch = useMemo(() => {
    if (
      !activeLocalProjectId ||
      selectedLocalBranchState?.localProjectId !== activeLocalProjectId
    ) {
      return null;
    }
    return selectedLocalBranchState.branch;
  }, [activeLocalProjectId, selectedLocalBranchState]);
  const selectedWorkdirMode = useMemo<WorkdirMode>(() => {
    if (
      !activeLocalProjectId ||
      selectedWorkdirModeState?.localProjectId !== activeLocalProjectId
    ) {
      return 'local';
    }
    return selectedWorkdirModeState.mode;
  }, [activeLocalProjectId, selectedWorkdirModeState]);
  const worktreeAvailable = getLocalProjectWorktreeAvailability(activeLocalGitState);
  const effectiveWorkdirMode: WorkdirMode =
    selectedWorkdirMode === 'worktree' && worktreeAvailable ? 'worktree' : 'local';
  const handleWorkdirModeChange = useCallback(
    (mode: WorkdirMode) => {
      if (!activeLocalProjectId) return;
      setSelectedWorkdirModeState({ localProjectId: activeLocalProjectId, mode });
    },
    [activeLocalProjectId]
  );
  useEffect(() => {
    setComposerStatus(null);
  }, [
    activeLocalProjectId,
    contextType,
    selectedAgent?.agentId,
    selectedBranch,
    selectedLocalBranch,
    effectiveWorkdirMode,
    selectedMachineId,
    selectedRepo,
  ]);
  useEffect(() => {
    if (contextType !== 'local' || !activeLocalProjectId) {
      setSelectedWorkdirModeState(null);
      return;
    }
    setSelectedWorkdirModeState({
      localProjectId: activeLocalProjectId,
      mode: readWorkdirModePreference(activeLocalProjectId),
    });
  }, [activeLocalProjectId, contextType]);
  const handleSelectedLocalProjectChange = useCallback(
    (nextProject: LocalProjectSelection | null) => {
      selectedLocalProjectRef.current = nextProject;
      setSelectedLocalProject(nextProject);
      if (nextProject) {
        setSelectedMachineId((current) =>
          current === nextProject.machineId ? current : nextProject.machineId
        );
      }
      setLoadingLocalGitState(Boolean(nextProject));
    },
    []
  );
  const getFirstVisibleLocalProjectForMachine = useCallback(
    (machineId: MachineId): LocalProjectSelection | null => {
      for (const entry of visibleLocalProjectMap.values()) {
        if (entry.machineId === machineId) {
          return {
            machineId,
            localProjectId: entry.project.id,
          };
        }
      }
      return null;
    },
    [visibleLocalProjectMap]
  );
  const handleSelectedLocalBranchChange = useCallback((nextBranch: string | null) => {
    const currentProject = selectedLocalProjectRef.current;
    if (!currentProject) {
      setSelectedLocalBranchState(null);
      return;
    }
    setSelectedLocalBranchState({
      localProjectId: currentProject.localProjectId,
      branch: nextBranch?.trim() || null,
    });
  }, []);
  const handleLocalGitStateRetry = useCallback(() => {
    setLocalGitStateError(null);
    setLocalGitStateRetryNonce((value) => value + 1);
  }, []);

  const shouldRestoreContextType =
    !preSelectedContext && !preSelectedMachine && !preSelectedProject && !preSelectedRepo;
  const {
    sessionId: draftSessionId,
    ensureSessionId: ensureDraftSessionId,
    resetSessionId: resetDraftSessionId,
  } = useChatLandingDraftSession(chatLandingDraftKey);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const {
    imageItems,
    hasBlockingImages,
    hasUploadedImages,
    canAddMoreImages,
    addFiles,
    handlePromptPaste: handleImagePromptPaste,
    handleRemoveImage,
    handleRetryImage,
    clearPendingImages,
    buildInputBlocks,
  } = useChatLandingImageDraft({
    draftKey: chatLandingDraftKey,
    workspaceId: (workspaceId as WorkspaceId | null) ?? null,
    authToken,
    isMobile,
    projectKind: contextType === 'chat' ? null : contextType,
    sessionId: draftSessionId,
    ensureSessionId: ensureDraftSessionId,
  });
  const {
    fileItems,
    hasBlockingFiles,
    hasUploadedFiles,
    canAddMoreFiles,
    addFiles: addFileAttachments,
    handleRemoveFile,
    handleRetryFile,
    clearPendingFiles,
    buildFileInputBlocks,
  } = useChatLandingFileDraft({
    draftKey: chatLandingDraftKey,
    workspaceId: (workspaceId as WorkspaceId | null) ?? null,
    authToken,
    machineId: selectedMachineId,
    sessionId: draftSessionId,
    ensureSessionId: ensureDraftSessionId,
  });
  const draftStore = useStore();
  const appliedResetKeyAtom = chatLandingAppliedResetKeyAtomFamily(chatLandingDraftKey);

  useEffect(() => {
    if (!resetDraftKey) {
      return;
    }

    const scopedResetKey = `${chatLandingStateKey ?? 'anonymous'}:${resetDraftKey}`;
    if (draftStore.get(appliedResetKeyAtom) === scopedResetKey) {
      return;
    }
    draftStore.set(appliedResetKeyAtom, scopedResetKey);
    if (resetDraftOnKeyChange) {
      setSessionState({ prompt: '', pastedTextDrafts: [] });
    }
    setComposerStatus(null);
    clearPendingImages();
    clearPendingFiles();
    resetDraftSessionId();
  }, [
    appliedResetKeyAtom,
    chatLandingStateKey,
    clearPendingFiles,
    clearPendingImages,
    draftStore,
    resetDraftSessionId,
    resetDraftKey,
    resetDraftOnKeyChange,
    setSessionState,
  ]);

  const insertLargePastedTextAtSelection = useCallback(
    (text: string) => {
      const normalizedText = normalizePastedTextDraft(text).trim();
      if (!normalizedText) {
        return false;
      }

      const currentValue = promptTextareaRef.current?.value ?? prompt;
      const selectionStart = promptTextareaRef.current?.selectionStart ?? null;
      const selectionEnd = promptTextareaRef.current?.selectionEnd ?? null;
      const result = insertPastedTextDraft({
        currentValue,
        pastedText: normalizedText,
        displayText: wrapPastedTextChipLabel(
          t('composer.pastedTextInlineLabel', '[Pasted {{charCount}} chars]', {
            charCount: numberFormatter.format(getPastedTextCharacterCount(normalizedText)),
          })
        ),
        selectionStart,
        selectionEnd,
      });

      if (!result) {
        return false;
      }

      const editEnd = Math.max(
        result.draft.start,
        Math.min(selectionEnd ?? result.draft.start, currentValue.length)
      );

      setSessionState((prev) => ({
        ...prev,
        prompt: result.nextValue,
        pastedTextDrafts: getPastedTextDraftsAfterInsertion({
          drafts: prev.pastedTextDrafts ?? [],
          draft: result.draft,
          editStart: result.draft.start,
          editEnd,
        }),
      }));
      setComposerStatus(null);

      requestAnimationFrame(() => {
        promptTextareaRef.current?.focus();
        promptTextareaRef.current?.setSelectionRange(result.draft.end, result.draft.end);
      });

      return true;
    },
    [numberFormatter, prompt, setSessionState, t]
  );

  // Auto-focus textarea on mount (desktop only)
  const mobileKeyboardRef = useRef(usesMobileKeyboardAction);
  mobileKeyboardRef.current = usesMobileKeyboardAction;
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (!mobileKeyboardRef.current) {
        promptTextareaRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // ── Apply pre-selection from search params ──
  const preSelectionKey = buildChatLandingPreSelectionKey({
    context: preSelectedContext,
    machine: preSelectedMachine,
    project: preSelectedProject,
    repo: preSelectedRepo,
  });
  useEffect(() => {
    if (preSelectionAppliedRef.current === preSelectionKey) return;
    preSelectionAppliedRef.current = preSelectionKey;
    // The applied selection reaches state next render; disarm the mirror so it
    // cannot race this intent with the still-stale selection (see the mirror
    // effect below, which must run after this one).
    selectionSyncArmedRef.current = false;

    if (preSelectedContext === 'chat') {
      setContextType('chat');
    } else if (preSelectedContext === 'local' && preSelectedMachine && preSelectedProject) {
      setContextType('local');
      const currentProject = selectedLocalProjectRef.current;
      if (
        currentProject?.machineId !== preSelectedMachine ||
        currentProject?.localProjectId !== preSelectedProject
      ) {
        handleSelectedLocalProjectChange({
          machineId: preSelectedMachine as MachineId,
          localProjectId: preSelectedProject as LocalProjectId,
        });
      }
    } else if (preSelectedRepo) {
      setContextType('github');
      setSelectedRepo(preSelectedRepo);
    }
  }, [
    preSelectionKey,
    preSelectedContext,
    preSelectedMachine,
    preSelectedProject,
    preSelectedRepo,
    handleSelectedLocalProjectChange,
  ]);

  // ── Mirror the effective selection back into the URL ──
  // The composer owns the selection once pre-selection is applied. When the
  // URL names a selection, it must keep telling the truth: steering or
  // clearing the composer would otherwise leave a stale project in the URL,
  // and re-activating that project's sidebar row would be an identical-URL
  // no-op. A plain /chat URL names nothing and stays plain, so restored
  // defaults and auto-selection never rewrite the home landing's address.
  const selectionSearch = useMemo(
    () =>
      getChatLandingSelectionSearch({
        contextType,
        machineId: selectedLocalProject?.machineId ?? null,
        localProjectId: selectedLocalProject?.localProjectId ?? null,
        repoFullName: selectedRepo ?? null,
      }),
    [contextType, selectedLocalProject, selectedRepo]
  );
  const urlNamesSelection =
    preSelectedContext !== undefined ||
    preSelectedMachine !== undefined ||
    preSelectedProject !== undefined ||
    preSelectedRepo !== undefined;
  useEffect(() => {
    if (!onSelectionUrlSync) return;
    const selectionKey = buildChatLandingPreSelectionKey({
      context: selectionSearch.context,
      machine: selectionSearch.machine,
      project: selectionSearch.project,
      repo: selectionSearch.repo,
    });
    const decision = getChatLandingSelectionSyncDecision({
      urlNamesSelection,
      intentApplied: preSelectionAppliedRef.current === preSelectionKey,
      armed: selectionSyncArmedRef.current,
      urlKey: preSelectionKey,
      selectionKey,
    });
    if (decision === 'arm') {
      selectionSyncArmedRef.current = true;
      return;
    }
    if (decision !== 'sync') return;
    // The URL will soon name this state-originated selection; stamp it as
    // already applied so the pre-selection effect does not re-apply it.
    preSelectionAppliedRef.current = selectionKey;
    onSelectionUrlSync(selectionSearch);
  }, [onSelectionUrlSync, urlNamesSelection, preSelectionKey, selectionSearch]);

  // ── Machine-owner authorization check for local projects ──
  useEffect(() => {
    if (contextType !== 'local' || !selectedLocalProject) return;
    const machineMeta = machines.get(selectedLocalProject.machineId);
    const machineAccess = accessByMachineId.get(selectedLocalProject.machineId);
    const machineOwnerUserId = machineAccess?.ownerUserId ?? machineMeta?.ownerUserId;
    const projectAccess = visibleLocalProjectAccess.get(
      getLocalProjectVisibilityKey(
        selectedLocalProject.machineId,
        selectedLocalProject.localProjectId
      )
    );
    const localProjectAvailability = getChatLandingLocalProjectAvailability({
      currentUserId: userId ?? null,
      selectedLocalProjectId: selectedLocalProject.localProjectId,
      machine: machineMeta,
      machineOwnerUserId,
      isMachineSharedWithTeam: machineAccess?.sharedWithTeam ?? false,
      isProjectShared: projectAccess?.sharedWithTeam ?? false,
      isVisibleMachinesLoading: visibleMachinesLoading,
      isMachineFlockRemoteSynced: machineFlockRemoteSyncedMachineIds.has(
        selectedLocalProject.machineId
      ),
      isVisibleLocalProjectsLoading: visibleLocalProjectsLoading,
      isDocMetaCacheReady: docMetaCacheReady,
      isMetaRoomFirstSyncPending,
    });
    if (localProjectAvailability !== 'unavailable') return;
    toast.error(t('sidebar.localProjects.forbidden', 'Local project is not available'));
    handleSelectedLocalProjectChange(null);
    setContextType(hasGitHubRepos ? 'github' : 'chat');
  }, [
    contextType,
    accessByMachineId,
    docMetaCacheReady,
    machines,
    machineFlockRemoteSyncedMachineIds,
    selectedLocalProject,
    userId,
    visibleMachinesLoading,
    visibleLocalProjectAccess,
    visibleLocalProjectsLoading,
    isMetaRoomFirstSyncPending,
    hasGitHubRepos,
    t,
    handleSelectedLocalProjectChange,
  ]);

  // ── Auto-switch to available tab if current is disabled ──
  useEffect(() => {
    if (repositories === undefined) return; // Wait for repos to load
    if (machines.size === 0) return; // Wait for machine data to load
    // `hasLocalProjects` derives from `useVisibleLocalProjects`; switching
    // before its query resolves would kick teammates whose only local access
    // is through shared projects.
    if (visibleLocalProjectsLoading) return;
    // Don't auto-switch away from a URL-pre-selected context
    if (preSelectedContext === 'local' && contextType === 'local') return;
    if (contextType === 'local' && !hasLocalProjects) {
      setContextType(hasGitHubRepos ? 'github' : 'chat');
    } else if (contextType === 'github' && !hasGitHubRepos) {
      setContextType(hasLocalProjects ? 'local' : 'chat');
    }
  }, [
    contextType,
    hasLocalProjects,
    hasGitHubRepos,
    repositories,
    machines.size,
    preSelectedContext,
    visibleLocalProjectsLoading,
  ]);

  // ── Agent/Mode/Model config ──
  const selectorTagClassName = getSelectorTagClassName(tone);

  const selectedConfig = useMemo<AgentConfigMeta | undefined>(
    () =>
      selectedAgent ? executorConfigs.find((cfg) => cfg.id === selectedAgent.agentId) : undefined,
    [executorConfigs, selectedAgent]
  );
  const selectedMachine = useMemo(
    () => (selectedAgent ? machines.get(selectedAgent.machineId) : undefined),
    [machines, selectedAgent]
  );
  /* ── Agent Role selection ──
     A Role is one packaged run configuration, so picking one flows through the
     SAME preference channel as this agent's remembered defaults rather than a
     second apply path: the derivation seeds mode/model/options from the Role,
     and an option the agent no longer supports falls back to the agent's own
     value there — visibly — instead of being forced in.

     `token` makes re-picking the same Role after hand-editing a knob a new
     preference, and the preference deliberately OUTLIVES `activeAgentRole`
     below: clearing it on a hand edit would re-seed the very value the user
     just changed. */
  const { roles: workspaceAgentRoles, synced: agentRolesSynced } = useWorkspaceAgentRoles();
  /* Whether the stored Role has been resolved yet. Until it has, the composer
     has no opinion to persist — see `selectedAgentRoleId` on the defaults hook. */
  const [agentRoleRestored, setAgentRoleRestored] = useState(false);
  /* The Role editor is a Dialog, so it is hosted OUT here rather than inside the
     run-config dropdown: a Dialog rendered in menu content unmounts with the
     menu the moment it opens. */
  const [agentRoleEditor, setAgentRoleEditor] = useState<AgentRoleEditorState | null>(null);
  const { resolve: resolveAgentRoleAvailability } = useAgentRoleAvailability(workspaceAgentRoles);
  useEffect(() => {
    setAgentRoleRestored(false);
  }, [workspaceId]);
  const agentRolePreferenceTokenRef = useRef(0);
  /* The preference NAMES a Role; it does not hold a copy of one. Editing a Role
     bumps its `revision`, which rides in `preferenceRevision` below, so the
     composer re-seeds from what the Role says NOW — a captured copy would keep
     running the old values under the edited Role's name. A deleted Role simply
     stops resolving. */
  const [agentRolePreference, setAgentRolePreference] = useState<{
    roleId: AgentRoleId;
    token: number;
  } | null>(null);
  /* A Role binds `machineId + agentConfigId` exactly, so its preference applies
     only while the composer is on that agent. Derived rather than cleared: a
     Role never re-points at whichever agent happens to be selected. */
  const activeAgentRolePreference = useMemo(() => {
    if (!agentRolePreference || !selectedAgent) return null;
    const role = workspaceAgentRoles.find((entry) => entry.id === agentRolePreference.roleId);
    if (!role) return null;
    const bound =
      role.agentConfigId === selectedAgent.agentId && role.machineId === selectedAgent.machineId;
    return bound ? { role, token: agentRolePreference.token } : null;
  }, [agentRolePreference, selectedAgent, workspaceAgentRoles]);
  const selectedAgentDefaults = useMemo(() => {
    const roleRunConfig = activeAgentRolePreference?.role.runConfig;
    if (roleRunConfig) {
      return {
        modeId: roleRunConfig.modeId ?? null,
        modelId: roleRunConfig.modelId ?? null,
        configOptionValues: roleRunConfig.configOptionValues,
      };
    }
    return selectedAgent ? (agentDefaultsCache.get(selectedAgent.agentId) ?? {}) : {};
  }, [activeAgentRolePreference, selectedAgent]);
  /* No effects: user edits are the only stored selection state; the effective
     values derive per render. Candidates feed the capability lookup so the
     catalog can depend on the selection without feeding back into it. */
  const {
    selection: sessionConfigSelection,
    candidates: sessionConfigCandidates,
    appliedTargetKey: appliedSessionConfigTargetKey,
    selectMode: setSelectedModeId,
    selectModel: setSelectedModelName,
    selectConfigOption: handleConfigOptionChange,
  } = useAcpSessionConfigSelectionState({
    targetKey: selectedAgent ? `${selectedAgent.machineId}:${selectedAgent.agentId}` : null,
    preferenceRevision: activeAgentRolePreference
      ? `role:${activeAgentRolePreference.role.id}:${activeAgentRolePreference.role.revision}:${activeAgentRolePreference.token}`
      : (selectedAgent?.agentId ?? 'none'),
    preferences: selectedAgentDefaults,
  });
  const selectorOptions = useAcpSelectorOptions({
    configId: selectedConfig?.id,
    cliType: selectedConfig?.cliType,
    agentType: selectedConfig?.agentType,
    selectedModeId: sessionConfigCandidates.modeId,
    selectedModelId: sessionConfigCandidates.modelId,
    configOptionValues: sessionConfigCandidates.configOptionValues,
    runtimeOverrides: selectedConfig?.runtimeOverrides,
    machine: selectedMachine,
  });
  const { modeOptions, modelOptions, configOptionSelectors } = selectorOptions;
  const { selectedModeId, selectedModelId, configOptionValues } =
    useResolvedAcpSessionConfigSelection(sessionConfigSelection, selectorOptions, {
      cliType: selectedConfig?.cliType,
      agentType: selectedConfig?.agentType,
    });
  const dispatchConfigOptionValues = useMemo(
    () => filterAcpSessionConfigOptionValues(configOptionValues, configOptionSelectors),
    [configOptionSelectors, configOptionValues]
  );
  const selectedRateLimits =
    selectedConfig &&
    canShowSubscriptionRateLimits({
      cliType: selectedConfig.cliType,
      agentType: selectedConfig.agentType,
      config: selectedConfig,
    })
      ? selectedMachine?.raceLimits
      : undefined;
  // The landing knows the picked provider's full config, so eligibility is
  // decided here rather than from `cliType`/`agentType` further down.
  const showCodexResetForecast =
    !!selectedConfig &&
    canShowCodexResetForecast({
      cliType: selectedConfig.cliType,
      agentType: selectedConfig.agentType,
      config: selectedConfig,
    });
  const selectedModelLabel = modelOptions.find((option) => option.value === selectedModelId)?.label;
  /* The Role the composer IS, not the one last clicked. The footer names a Role
     only while every value that Role pins is still what will run, so moving a
     knob — or an unsupported pin falling back — takes the name away instead of
     leaving it claiming a configuration that is no longer the Role's. */
  const activeAgentRole = useMemo(() => {
    const role = activeAgentRolePreference?.role;
    if (!role) return null;
    return isComposerAgentRoleApplied(role, {
      agentSelection: selectedAgent,
      modeId: selectedModeId,
      modelId: selectedModelId,
      configOptionValues,
    })
      ? role
      : null;
  }, [
    activeAgentRolePreference,
    configOptionValues,
    selectedAgent,
    selectedModeId,
    selectedModelId,
  ]);

  /* ── Recently used run configurations ──
     Device-local history of whole combinations (agent + model + every config
     option) the user has actually started a chat with, surfaced at the top of
     the desktop run-config menu. */
  const [recentRunConfigRecords, setRecentRunConfigRecords] = useState<RecentRunConfigRecord[]>([]);
  useEffect(() => {
    setRecentRunConfigRecords(readRecentRunConfigs(workspaceId));
  }, [workspaceId]);
  const currentRunConfigFace = useMemo(
    () =>
      describeRunConfigSelection({
        modelOptions,
        selectedModelId,
        configOptionSelectors,
        configOptionValues,
      }),
    [configOptionSelectors, configOptionValues, modelOptions, selectedModelId]
  );
  const currentRunConfigKey = useMemo(
    () =>
      selectedAgent
        ? getRecentRunConfigKey({
            agentId: selectedAgent.agentId,
            machineId: selectedAgent.machineId,
            modelId: currentRunConfigFace.modelId,
            configOptionValues: sanitizeConfigOptionValues(dispatchConfigOptionValues),
            agentRoleId: activeAgentRole?.id ?? null,
          })
        : null,
    [activeAgentRole, currentRunConfigFace.modelId, dispatchConfigOptionValues, selectedAgent]
  );
  /* Picking an entry switches the agent first; its model and options can only
     be applied after that agent's own reconcile pass has seeded the selection
     state, or the seeded defaults would overwrite them. */
  const [pendingRecentRunConfig, setPendingRecentRunConfig] =
    useState<RecentRunConfigRecord | null>(null);
  useEffect(() => {
    if (!pendingRecentRunConfig || !selectedAgent) return;
    if (
      selectedAgent.agentId !== pendingRecentRunConfig.agentId ||
      selectedAgent.machineId !== pendingRecentRunConfig.machineId
    ) {
      setPendingRecentRunConfig(null);
      return;
    }
    if (appliedSessionConfigTargetKey !== `${selectedAgent.machineId}:${selectedAgent.agentId}`) {
      return;
    }
    // A cold agent reports no models until its capabilities resolve; applying
    // then would silently drop the recorded model. Wait — unless the user has
    // meanwhile picked a model themselves, which outranks the entry.
    if (pendingRecentRunConfig.modelId && modelOptions.length === 0) {
      if (sessionConfigSelection.edits.model !== undefined) {
        setPendingRecentRunConfig(null);
      }
      return;
    }
    setPendingRecentRunConfig(null);
    if (
      pendingRecentRunConfig.modelId &&
      modelOptions.some((option) => option.value === pendingRecentRunConfig.modelId)
    ) {
      setSelectedModelName(pendingRecentRunConfig.modelId);
    }
    for (const { configId, value } of resolveApplicableConfigOptionValues(
      pendingRecentRunConfig,
      configOptionSelectors
    )) {
      handleConfigOptionChange(configId, value);
    }
  }, [
    appliedSessionConfigTargetKey,
    configOptionSelectors,
    handleConfigOptionChange,
    modelOptions,
    pendingRecentRunConfig,
    selectedAgent,
    sessionConfigSelection.edits.model,
    setSelectedModelName,
  ]);
  const availableCommands = useAvailableCommands({
    configId: selectedConfig?.id,
    cliType: selectedConfig?.cliType,
    agentType: selectedConfig?.agentType,
    runtimeOverrides: selectedConfig?.runtimeOverrides,
    machine: selectedMachine,
  });
  // Filters the `$` skill mention to the selected provider's skill directories.
  const skillAgent = useMemo(
    () =>
      selectedConfig?.cliType && selectedConfig.agentType
        ? {
            cliType: selectedConfig.cliType,
            agentType: selectedConfig.agentType,
            // The selected agent's machine — lets the `$` menu surface that
            // machine's global skills even for GitHub / plain (chat) contexts.
            ...(selectedAgent?.machineId ? { machineId: selectedAgent.machineId } : {}),
          }
        : undefined,
    [selectedConfig?.cliType, selectedConfig?.agentType, selectedAgent?.machineId]
  );

  // Keyboard cyclers shared with the in-session composer. The chat landing is also where
  // the agent provider can be cycled (it's fixed once a session exists).
  const cycleThinkEffortSelector = useMemo(
    () =>
      configOptionSelectors.find(
        (selector): selector is AcpSelectConfigOptionSelector =>
          selector.type === 'select' && isThoughtLevelSelector(selector)
      ),
    [configOptionSelectors]
  );
  const cycleThinkEffortCurrent = cycleThinkEffortSelector
    ? configOptionValues[cycleThinkEffortSelector.configId]
    : undefined;
  const cycleProviderSelections = useMemo(
    () =>
      getChatLandingAgentSelectionsForMachine(executorConfigs, selectedAgent?.machineId ?? null),
    [executorConfigs, selectedAgent?.machineId]
  );
  useComposerCycleCommands({
    mode: {
      values: modeOptions.map((option) => option.value),
      current: selectedModeId,
      onSelect: (value) => setSelectedModeId(value),
    },
    model: {
      values: modelOptions.map((option) => option.value),
      current: selectedModelId,
      onSelect: (value) => setSelectedModelName(value),
    },
    thinkEffort: cycleThinkEffortSelector
      ? {
          values: cycleThinkEffortSelector.options.map((option) => option.value),
          current:
            typeof cycleThinkEffortCurrent === 'string'
              ? cycleThinkEffortCurrent
              : cycleThinkEffortSelector.currentValue,
          onSelect: (value) => handleConfigOptionChange(cycleThinkEffortSelector.configId, value),
        }
      : null,
    provider: selectedAgent
      ? {
          values: cycleProviderSelections.map((selection) => selection.agentId),
          current: selectedAgent.agentId,
          onSelect: (agentId) => {
            const nextSelection = cycleProviderSelections.find(
              (selection) => selection.agentId === agentId
            );
            if (nextSelection) setSelectedAgent(nextSelection);
          },
        }
      : null,
  });

  // ── Machine online check (context-dependent) ──
  const hasAnyOnlineMachine = useMemo(() => {
    return getChatLandingHasAnyOnlineMachine({
      localMachineId: visibleLocalMachineId,
      machines,
      isMachineOnline: isPresenceMachineOnline,
    });
  }, [visibleLocalMachineId, machines, isPresenceMachineOnline]);
  const onlineMachineCount = useMemo(() => {
    let count = 0;
    for (const machineId of machines.keys()) {
      if (onlineMachineIds.has(machineId)) {
        count += 1;
      }
    }
    return count;
  }, [machines, onlineMachineIds]);
  const hasNoMachine = !hasAnyOnlineMachine;

  // ── Sync selectedMachineId from selectedAgent (e.g. when restored from defaults) ──
  // Skip sync when the machine was explicitly changed by the user via handleMachineChange.
  const machineChangedByUserRef = useRef(false);
  useEffect(() => {
    if (machineChangedByUserRef.current) {
      machineChangedByUserRef.current = false;
      return;
    }
    if (contextType === 'local' && selectedLocalProjectMachineId) {
      if (selectedLocalProjectMachineId !== selectedMachineId) {
        setSelectedMachineId(selectedLocalProjectMachineId);
      }
      return;
    }
    if (selectedAgent?.machineId && selectedAgent.machineId !== selectedMachineId) {
      setSelectedMachineId(selectedAgent.machineId);
    }
  }, [contextType, selectedAgent?.machineId, selectedLocalProjectMachineId, selectedMachineId]);

  // ── Handle explicit machine change: auto-select an agent owned by the new machine ──
  const handleMachineChange = useCallback(
    (machineId: MachineId) => {
      machineChangedByUserRef.current = true;
      setSelectedMachineId(machineId);
      if (contextType === 'local') {
        const currentProject = selectedLocalProjectRef.current;
        if (currentProject?.machineId !== machineId) {
          handleSelectedLocalProjectChange(null);
          setContextType('chat');
        }
      }
      if (selectedAgent?.machineId === machineId) return;

      // Agent configs are per-machine: only configs owned by the new machine
      // are valid choices here.
      const configsOnMachine = executorConfigs.filter((cfg) => cfg.machineId === machineId);

      // Prefer a config with the same agentType as the previously selected one.
      const previousConfig = selectedAgent
        ? executorConfigs.find((cfg) => cfg.id === selectedAgent.agentId)
        : undefined;
      const matchByType = previousConfig
        ? configsOnMachine.find((cfg) => cfg.agentType === previousConfig.agentType)
        : undefined;

      const nextConfig = matchByType ?? configsOnMachine[0];
      if (nextConfig) {
        setSelectedAgent({ agentId: nextConfig.id, machineId });
      } else {
        setSelectedAgent(null);
      }
    },
    [contextType, executorConfigs, handleSelectedLocalProjectChange, selectedAgent]
  );

  const createNewMachinePairing = useCallback(async () => {
    setMachinePairingDialogOpen(true);
    setMachinePairingCreating(true);
    setMachinePairingCreateError(null);
    setMachinePairing(null);
    machinePairingSuccessNotifiedRef.current = null;
    machinePairingSelectedRef.current = null;
    if (!authToken || !workspaceId) {
      setMachinePairingCreating(false);
      setMachinePairingCreateError('missing_context');
      return;
    }
    const result = await createMachinePairing({ sessionToken: authToken, workspaceId });
    setMachinePairingCreating(false);
    if (!result.ok) {
      setMachinePairingCreateError(result.error);
      return;
    }
    setMachinePairing({
      requestId: result.value.request.id,
      command: `npx lody@latest daemon start --auth ${result.value.token}`,
      expiresAt: result.value.request.expiresAt,
    });
  }, [authToken, workspaceId]);

  const handleAddMachine = useCallback(() => {
    if (
      machinePairing &&
      (machinePairingStatus === 'pending' ||
        machinePairingStatus === 'claimed' ||
        machinePairingStatus === 'registered')
    ) {
      setMachinePairingDialogOpen(true);
      return;
    }
    void createNewMachinePairing();
  }, [createNewMachinePairing, machinePairing, machinePairingStatus]);

  useEffect(() => {
    if (
      observedMachinePairing?.status !== 'registered' ||
      machinePairingDialogOpen ||
      machinePairingSuccessNotifiedRef.current === observedMachinePairing.id
    ) {
      return;
    }
    machinePairingSuccessNotifiedRef.current = observedMachinePairing.id;
    toast.success(
      t('machinePairing.connectedToast', '{{machine}} connected successfully.', {
        machine:
          observedMachinePairing.machineName ?? t('chat.machineSelector.placeholder', 'Machine'),
      }),
      {
        description: showProjectSharing
          ? t(
              'machinePairing.privateByDefault',
              'This machine is private by default. Share it from device settings when teammates should be able to use it.'
            )
          : undefined,
        action: showProjectSharing
          ? {
              label: t('machinePairing.openDeviceSettings', 'Open device settings'),
              onClick: () => openSettings('machines'),
            }
          : undefined,
      }
    );
  }, [machinePairingDialogOpen, observedMachinePairing, openSettings, showProjectSharing, t]);

  useEffect(() => {
    if (
      !machinePairing ||
      !pairedMachineId ||
      machinePairingStatus !== 'registered' ||
      !machines.has(pairedMachineId) ||
      machinePairingSelectedRef.current === machinePairing.requestId
    ) {
      return;
    }
    machinePairingSelectedRef.current = machinePairing.requestId;
    handleMachineChange(pairedMachineId);
  }, [handleMachineChange, machinePairing, machinePairingStatus, machines, pairedMachineId]);

  const handleMachinePairingOpenChange = useCallback(
    (open: boolean) => {
      setMachinePairingDialogOpen(open);
      if (
        !open &&
        machinePairing &&
        (machinePairingStatus === 'registered' ||
          machinePairingStatus === 'cancelled' ||
          machinePairingStatus === 'expired')
      ) {
        setMachinePairing(null);
      }
    },
    [machinePairing, machinePairingStatus]
  );

  // ── Selectable machines: reachable AND own at least one configured agent. ──
  // The hook uses this to ensure the current selection still resolves; falling
  // back to a valid default when machines stream in late (e.g. relogin) or go
  // offline.
  const selectableMachines = useMemo(() => {
    const machineIdsWithConfigs = new Set<MachineId>();
    for (const config of executorConfigs) {
      machineIdsWithConfigs.add(config.machineId);
    }
    const next = new Map<MachineId, MachineViewMeta>();
    for (const [machineId, machine] of machines) {
      if (!machineIdsWithConfigs.has(machineId)) continue;
      if (
        !isChatLandingMachineReachable({
          machineId,
          localMachineId: visibleLocalMachineId,
          machines,
          isMachineOnline: isPresenceMachineOnline,
        })
      ) {
        continue;
      }
      next.set(machineId, machine);
    }
    return next;
  }, [executorConfigs, isPresenceMachineOnline, machines, visibleLocalMachineId]);

  // Suppress empty-state flashes during cold start, but do not let a stalled
  // Convex visibility query mask machine/agent data already available from the
  // local CRDT cache. This is the idle-resume path: local repo is usable while
  // remote visibility/auth may still be reconnecting.
  const isInitialDataLoading = getChatLandingInitialDataLoading({
    isRuntimeInitializing: runtimeInitializing,
    isVisibleMachinesLoading: visibleMachinesLoading,
    isDocMetaCacheReady: docMetaCacheReady,
    localMachineStateAttempted: localProbeAttempted,
    hasSelectableMachine: selectableMachines.size > 0,
  });

  // ── Defaults loading (all contexts) ──
  const { defaultsReady, repoDefaultsReady } = useChatLandingDefaults({
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
    setSelectedLocalProject: handleSelectedLocalProjectChange,
    selectedLocalBranch,
    setSelectedLocalBranch: handleSelectedLocalBranchChange,
    selectedAgentRoleId: agentRoleRestored ? (activeAgentRole?.id ?? null) : undefined,
  });

  // ── Auto-select first repo when none selected ──
  useEffect(() => {
    if (!repoDefaultsReady) return;
    if (contextType !== 'github' || selectedRepo) return;
    const firstRepo = repositories?.[0];
    if (firstRepo) setSelectedRepo(firstRepo.fullName);
  }, [contextType, repoDefaultsReady, repositories, selectedRepo]);

  // ── Auto-select first local project when none selected ──
  useEffect(() => {
    if (!defaultsReady) return;
    if (contextType !== 'local' || selectedLocalProject) return;
    if (selectedMachineId) {
      const machineProject = getFirstVisibleLocalProjectForMachine(selectedMachineId);
      if (machineProject) {
        handleSelectedLocalProjectChange(machineProject);
      }
      return;
    }
    // Bias the default to an own-machine project when one exists, falling
    // back to the first shared project so teammates still get a selection.
    let fallback: { machineId: MachineId; localProjectId: LocalProjectId } | null = null;
    for (const entry of visibleLocalProjectMap.values()) {
      const candidate = {
        machineId: entry.machineId,
        localProjectId: entry.project.id,
      };
      if (isOwnVisibleMachine(entry.machineId)) {
        handleSelectedLocalProjectChange(candidate);
        return;
      }
      if (!fallback) fallback = candidate;
    }
    if (fallback) {
      handleSelectedLocalProjectChange(fallback);
    }
  }, [
    contextType,
    defaultsReady,
    getFirstVisibleLocalProjectForMachine,
    isOwnVisibleMachine,
    selectedMachineId,
    visibleLocalProjectMap,
    selectedLocalProject,
    handleSelectedLocalProjectChange,
  ]);

  // Keep local project selection as the source of truth for its machine.
  // Explicit machine changes update/clear the project in `handleMachineChange`;
  // async agent/default fallback must not clear an offline project's selection.
  useEffect(() => {
    if (!defaultsReady || visibleLocalProjectsLoading) return;
    if (contextType !== 'local' || !selectedMachineId || !selectedLocalProject) return;
    if (selectedLocalProject.machineId === selectedMachineId) return;
    setSelectedMachineId(selectedLocalProject.machineId);
  }, [
    contextType,
    defaultsReady,
    selectedLocalProject,
    selectedMachineId,
    visibleLocalProjectsLoading,
  ]);

  // ── Local project: auto-select agent when machine changes ──
  useEffect(() => {
    if (contextType !== 'local' || !selectedLocalProject) return;

    const currentConfig = selectedAgent
      ? executorConfigs.find((cfg) => cfg.id === selectedAgent.agentId)
      : undefined;
    if (selectedAgent?.machineId === selectedLocalProject.machineId && currentConfig) {
      return;
    }

    const storedDefaults = readChatLandingDefaults(workspaceId);
    const nextSelection = resolvePreferredChatLandingAgentSelection({
      preferredAgentId: selectedAgent?.agentId ?? storedDefaults?.agentId ?? null,
      preferredMachineId: selectedAgent?.machineId ?? storedDefaults?.machineId ?? null,
      requiredMachineId: selectedLocalProject.machineId,
      executorConfigs,
      machines,
    });
    if (
      nextSelection &&
      (nextSelection.agentId !== selectedAgent?.agentId ||
        nextSelection.machineId !== selectedAgent?.machineId)
    ) {
      setSelectedAgent(nextSelection);
    }
  }, [contextType, executorConfigs, machines, selectedAgent, selectedLocalProject, workspaceId]);

  // ── PostHog tracking ──
  useEffect(() => {
    if (!postHog || !userId || !workspaceId) return;
    if (!fireLandingViewedOnce(`${userId}:${workspaceId}`)) return;
    capturePostHogEvent(postHog, 'chat_landing/viewed', {
      user_id: userId,
      workspace_id: workspaceId,
      context_type: contextType,
      launch_mode: launchMode,
      is_mobile: isMobile,
      has_preselected_context: Boolean(preSelectedContext),
      has_preselected_project: Boolean(preSelectedProject || preSelectedRepo),
      github_repo_count: repositories?.length ?? null,
      local_project_count: localProjectCount,
      online_machine_count: onlineMachineCount,
      ready_ms: getDurationSinceMs(landingLoadStartMsRef.current),
    });
  }, [
    contextType,
    fireLandingViewedOnce,
    isMobile,
    launchMode,
    localProjectCount,
    onlineMachineCount,
    postHog,
    preSelectedContext,
    preSelectedProject,
    preSelectedRepo,
    repositories?.length,
    userId,
    workspaceId,
  ]);

  useEffect(() => {
    const previousContextType = previousContextTypeRef.current;
    if (previousContextType === contextType) return;
    previousContextTypeRef.current = contextType;
    capturePostHogEvent(postHog, 'chat_landing/context_changed', {
      user_id: userId ?? null,
      workspace_id: workspaceId ?? null,
      previous_context_type: previousContextType,
      context_type: contextType,
      github_repo_count: repositories?.length ?? null,
      local_project_count: localProjectCount,
      online_machine_count: onlineMachineCount,
    });
  }, [
    contextType,
    localProjectCount,
    onlineMachineCount,
    postHog,
    repositories?.length,
    userId,
    workspaceId,
  ]);

  useEffect(() => {
    if (!postHog || !userId || !workspaceId) return;
    // Wait until the GitHub repo query has settled (undefined = still loading)
    if (repositories === undefined) return;
    if (visibleLocalProjectsLoading) return;
    const githubRepoCount = repositories.length;
    if (githubRepoCount === 0 && localProjectCount === 0) return;
    if (!fireProjectSourceReadyOnce(`${userId}:${workspaceId}`)) return;
    const sourceKind =
      githubRepoCount > 0 && localProjectCount > 0
        ? 'mixed'
        : githubRepoCount > 0
          ? 'github'
          : 'local';
    capturePostHogEvent(postHog, 'onboarding/project_source_ready', {
      user_id: userId,
      workspace_id: workspaceId,
      source_kind: sourceKind,
      github_repo_count: githubRepoCount,
      local_project_count: localProjectCount,
    });
  }, [
    fireProjectSourceReadyOnce,
    localProjectCount,
    postHog,
    repositories,
    userId,
    visibleLocalProjectsLoading,
    workspaceId,
  ]);

  useEffect(() => {
    if (!postHog || !userId || !workspaceId) return;
    if (contextType === 'chat') return;
    if (contextType === 'github' && !selectedRepo) return;
    if (contextType === 'local' && !selectedLocalProject) return;
    if (
      contextType === 'local' &&
      selectedLocalProject &&
      activeLocalGitState === null &&
      !localGitStateError
    ) {
      return;
    }

    const selectionKey =
      contextType === 'github'
        ? `github:${selectedRepo}`
        : `local:${selectedLocalProject?.machineId}:${selectedLocalProject?.localProjectId}`;
    const analyticsKey = `${userId}:${workspaceId}:${selectionKey}`;
    if (!fireProjectSelectedOnChange(analyticsKey)) return;
    capturePostHogEvent(postHog, 'onboarding/project_selected', {
      user_id: userId,
      workspace_id: workspaceId,
      project_kind: contextType,
      repo_id_hash: contextType === 'github' ? hashAnalyticsId(selectedRepo) : null,
      local_project_id:
        contextType === 'local' ? (selectedLocalProject?.localProjectId ?? null) : null,
      machine_id: contextType === 'local' ? (selectedLocalProject?.machineId ?? null) : null,
      has_git_branch:
        contextType === 'local'
          ? localGitStateError
            ? null
            : (activeLocalGitState?.git ?? null)
          : true,
    });
  }, [
    activeLocalGitState,
    contextType,
    fireProjectSelectedOnChange,
    localGitStateError,
    postHog,
    selectedLocalProject,
    selectedRepo,
    userId,
    workspaceId,
  ]);

  useEffect(() => {
    if (!postHog || !userId || !workspaceId || !selectedAgent || !selectedConfig) return;
    const analyticsKey = [
      userId,
      workspaceId,
      selectedAgent.machineId,
      selectedAgent.agentId,
      selectedConfig.cliType,
      selectedConfig.agentType,
    ].join(':');
    if (!fireAgentConfigOnChange(analyticsKey)) return;
    capturePostHogEvent(postHog, 'onboarding/agent_config_selected', {
      user_id: userId,
      workspace_id: workspaceId,
      machine_id: selectedAgent.machineId,
      agent_config_id: selectedAgent.agentId,
      cli_type: selectedConfig.cliType,
      agent_type: selectedConfig.agentType,
    });
  }, [fireAgentConfigOnChange, postHog, selectedAgent, selectedConfig, userId, workspaceId]);

  // ── GitHub branch loading ──
  useLayoutEffect(() => {
    if (contextType !== 'github') return undefined;
    if (!workspaceId || !selectedRepo) {
      setRepoBranches([]);
      setRepoDefaultBranch(null);
      setSelectedBranch(null);

      return undefined;
    }

    const cached = githubBranchesCache.get(getGitHubBranchesCacheId(workspaceId, selectedRepo));
    if (cached) {
      applyGitHubBranchSnapshot(cached);
      return undefined;
    }

    setRepoDefaultBranch(null);
    setRepoBranches((prev) => (prev.length === 0 ? prev : []));
    return undefined;
  }, [applyGitHubBranchSnapshot, contextType, selectedRepo, workspaceId]);

  useEffect(() => {
    if (contextType !== 'github') return undefined;
    if (!workspaceId || !selectedRepo) return undefined;

    let cancelled = false;
    void (async () => {
      try {
        const result = await withGitHubTokenRetry(workspaceId, selectedRepo, (token) =>
          githubFetchBranches(token, selectedRepo)
        );
        const snapshot = createChatLandingBranchSnapshot(result.branches, result.defaultBranch);
        githubBranchesCache.set(getGitHubBranchesCacheId(workspaceId, selectedRepo), {
          ...snapshot,
          updatedAt: Date.now(),
        });
        if (cancelled) return;
        applyGitHubBranchSnapshot(snapshot);
      } catch (error) {
        if (cancelled) return;
        console.warn('Failed to load repository branches', error);
        setSelectedBranch((prev) => {
          const trimmed = prev?.trim() || null;
          return trimmed === prev ? prev : trimmed;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyGitHubBranchSnapshot, contextType, selectedRepo, workspaceId]);

  const applyLocalGitState = useCallback(
    (machineId: MachineId, localProjectId: LocalProjectId, result: LocalProjectGitState) => {
      setLocalGitState({
        machineId,
        localProjectId,
        state: result,
      });
      setLocalGitStateError(null);
      if (!result.git) {
        setSelectedLocalBranchState({
          localProjectId,
          branch: null,
        });
        return;
      }

      setSelectedLocalBranchState((prev) => {
        const previousBranch = prev?.localProjectId === localProjectId ? prev.branch : null;
        return {
          localProjectId,
          branch: resolveLocalProjectBranchSelection(result, previousBranch),
        };
      });
    },
    []
  );

  const fetchLocalGitState = useCallback(
    async (
      targetWorkspaceId: WorkspaceId,
      project: LocalProjectSelection
    ): Promise<LocalProjectGitState> => {
      const cacheKey = getLocalProjectGitStateCacheKey(
        targetWorkspaceId,
        project.machineId,
        project.localProjectId
      );
      const cached = localProjectGitStateCache.get(cacheKey);
      if (cached && cached.expiresAtMs > Date.now()) {
        return cached.state;
      }

      if (
        isLocalProjectMachineOffline({
          projectMachineId: project.machineId,
          visibleLocalMachineId,
          targetMachine: machinesRef.current.get(project.machineId),
          isMachineOnline: (machineId) => onlineMachineIdsRef.current.has(machineId),
        })
      ) {
        throw new Error(
          t('chat.localGitStateMachineOffline', {
            defaultValue:
              'Target machine is offline. Start the CLI on that machine to load branches.',
          })
        );
      }

      const fallbackMessage = t('chat.localGitStateFailed', {
        defaultValue: 'Failed to load local project Git state',
      });

      return await localProjectGitStateDedupe.run(cacheKey, async () => {
        let fastPathError: string | null = null;
        const canUseElectronFastPath = isElectron && visibleLocalMachineId === project.machineId;

        if (canUseElectronFastPath && window.__LODY_ELECTRON__ && getIpcServices()) {
          const result = await getIpcServices()!.localProjects.getGitState(
            targetWorkspaceId,
            project.localProjectId
          );
          if (result && !('error' in result)) {
            setLocalProjectGitStateCacheEntry(cacheKey, {
              state: result,
              expiresAtMs: Date.now() + LOCAL_PROJECT_GIT_STATE_CACHE_TTL_MS,
            });
            return result;
          }
          fastPathError = result?.error?.trim() || fallbackMessage;
        }

        if (!runtime || !userId) {
          throw new Error(fastPathError ?? fallbackMessage);
        }

        const response = await runtime.requestLocalProjectGitState(
          project.machineId,
          project.localProjectId,
          userId,
          { timeoutMs: LOCAL_PROJECT_GIT_STATE_RPC_TIMEOUT_MS }
        );
        if (!response) {
          throw new Error(
            fastPathError ?? t('chat.localGitStateTimeout', 'Timed out loading branches.')
          );
        }
        if (!response.success) {
          throw new Error(
            response.message?.trim() || response.error || fastPathError || fallbackMessage
          );
        }

        setLocalProjectGitStateCacheEntry(cacheKey, {
          state: response.state,
          expiresAtMs: Date.now() + LOCAL_PROJECT_GIT_STATE_CACHE_TTL_MS,
        });
        return response.state;
      });
    },
    [isElectron, runtime, t, userId, visibleLocalMachineId]
  );

  // Collapse the machine map down to a single boolean: is the selected
  // project's machine currently reachable? The git-state effect depends on
  // this instead of `machines`, so it reloads branches when the target machine
  // flips online↔offline (e.g. CLI reconnects) but not on unrelated meta churn.
  const selectedLocalProjectMachineOnline = useMemo(() => {
    if (!selectedLocalProjectMachineId) return false;
    return !isLocalProjectMachineOffline({
      projectMachineId: selectedLocalProjectMachineId,
      visibleLocalMachineId,
      targetMachine: machines.get(selectedLocalProjectMachineId),
      isMachineOnline: isPresenceMachineOnline,
    });
  }, [isPresenceMachineOnline, machines, selectedLocalProjectMachineId, visibleLocalMachineId]);
  const localGitStateLoadKey = useMemo(
    () =>
      getLocalProjectGitStateLoadKey({
        workspaceId,
        machineId: selectedLocalProjectMachineId,
        localProjectId: activeLocalProjectId,
        userId: userId ?? null,
        machineOnline: selectedLocalProjectMachineOnline,
        retryNonce: localGitStateRetryNonce,
        hasRuntime: hasWorkspaceRuntime,
        hasDesktopControl: canUseSelectedLocalProjectDesktopControl,
      }),
    [
      activeLocalProjectId,
      canUseSelectedLocalProjectDesktopControl,
      hasWorkspaceRuntime,
      localGitStateRetryNonce,
      selectedLocalProjectMachineId,
      selectedLocalProjectMachineOnline,
      userId,
      workspaceId,
    ]
  );

  // `localGitStateLoadKey` fully identifies a load (workspace/machine/project/user/
  // reachability/loader/runtime-refresh/retry). Snapshot every other input through a
  // ref so the effect depends ONLY on that key + contextType: callback identity churn
  // (`fetchLocalGitState` rebuilds whenever `runtime`/`t` change) can no longer re-run
  // the effect against an unchanged key, which is what previously looped failed loads.
  const gitStateLoadInputs = {
    workspaceId,
    machineId: selectedLocalProjectMachineId,
    localProjectId: activeLocalProjectId,
    canLoad: hasWorkspaceRuntime || canUseSelectedLocalProjectDesktopControl,
    machineOnline: selectedLocalProjectMachineOnline,
    fetchLocalGitState,
    applyLocalGitState,
    t,
  };
  const gitStateLoadInputsRef = useRef(gitStateLoadInputs);
  gitStateLoadInputsRef.current = gitStateLoadInputs;

  // ── Local project git capability loading ──
  useEffect(() => {
    if (contextType !== 'local') return undefined;
    const load = gitStateLoadInputsRef.current;
    if (
      !localGitStateLoadKey ||
      !load.canLoad ||
      !load.workspaceId ||
      !load.machineId ||
      !load.localProjectId
    ) {
      setLocalGitState(null);
      setLocalGitStateError(null);
      setLoadingLocalGitState(false);
      return undefined;
    }
    if (!load.machineOnline) {
      setLocalGitState(null);
      setLocalGitStateError(
        load.t('chat.localGitStateMachineOffline', {
          defaultValue:
            'Target machine is offline. Start the CLI on that machine to load branches.',
        })
      );
      setLoadingLocalGitState(false);
      return undefined;
    }

    let cancelled = false;
    let unsubscribeCliState: (() => void) | null = null;
    let retryCount = 0;
    const MAX_DAEMON_RETRIES = 5;
    const targetWorkspaceId = load.workspaceId;
    const localProject: LocalProjectSelection = {
      machineId: load.machineId,
      localProjectId: load.localProjectId,
    };

    const attemptLoad = async () => {
      let pendingRetry = false;
      setLoadingLocalGitState(true);
      setLocalGitStateError(null);
      try {
        const result = await load.fetchLocalGitState(targetWorkspaceId, localProject);
        if (cancelled) return;
        load.applyLocalGitState(localProject.machineId, localProject.localProjectId, result);
      } catch (error) {
        if (cancelled) return;
        const errorMessage =
          (error instanceof Error ? error.message : String(error)).trim() ||
          load.t('chat.localGitStateFailed', {
            defaultValue: 'Failed to load local project Git state',
          });
        if (isWorkspaceRuntimeUnavailableMessage(errorMessage)) {
          warnWorkspaceRuntimeUnavailable(errorMessage, 'local git state unavailable');
          setLocalGitState(null);
          setLocalGitStateError(null);
          return;
        }
        // Daemon not ready yet (CLI still starting) — wait for it silently
        if (isDaemonUnavailableMessage(errorMessage)) {
          retryCount += 1;
          if (retryCount > MAX_DAEMON_RETRIES) {
            console.warn('[chat-landing] CLI daemon retry limit reached', errorMessage);
            setLocalGitState(null);
            setLocalGitStateError(null);
            return;
          }
          console.debug(
            `[chat-landing] CLI daemon not ready (attempt ${retryCount}/${MAX_DAEMON_RETRIES}), waiting…`,
            errorMessage
          );
          setLocalGitState(null);
          setLocalGitStateError(null);
          pendingRetry = true;
          waitForCliReady();
          return;
        }
        console.warn('Failed to load local project git state', error, {
          loadKey: localGitStateLoadKey,
        });
        setLocalGitState(null);
        setLocalGitStateError(errorMessage);
      } finally {
        if (!cancelled && !pendingRetry) setLoadingLocalGitState(false);
      }
    };

    /** Subscribe to CLI state changes and retry once CLI reaches 'running' phase. */
    const waitForCliReady = () => {
      if (cancelled || unsubscribeCliState) return;
      const services = getIpcServices();
      if (!services) {
        setLoadingLocalGitState(false);
        return;
      }

      const scheduleRetry = () => {
        if (cancelled) return;
        const delay = Math.min(1000 * 2 ** (retryCount - 1), 5000);
        setTimeout(() => {
          if (!cancelled) void attemptLoad();
        }, delay);
      };

      const subscribeUntilRunning = () => {
        if (cancelled || unsubscribeCliState) return;
        sendIpc('cli.subscribe', null);
        unsubscribeCliState = onIpcEvent('cli.state', (s) => {
          if (cancelled) return;
          if (s.phase === 'running') {
            unsubscribeCliState?.();
            unsubscribeCliState = null;
            scheduleRetry();
          }
        });
      };

      void services.cli
        .getState()
        .then((state) => {
          if (cancelled) return;
          if (state.phase === 'running') {
            scheduleRetry();
            return;
          }
          subscribeUntilRunning();
        })
        .catch(() => {
          subscribeUntilRunning();
        });
    };

    void attemptLoad();
    return () => {
      cancelled = true;
      unsubscribeCliState?.();
    };
  }, [contextType, localGitStateLoadKey]);

  // ── GitHub repo resolution for local projects ──
  const resolveSelectedLocalProjectGitHubRepo = useCallback(
    (gitStateOverride?: LocalProjectGitState | null): string | null => {
      const effectiveLocalGitState = gitStateOverride ?? activeLocalGitState;
      if (!selectedLocalProject) return null;
      return resolveLocalProjectGithubRepoFullName(effectiveLocalGitState, repositories);
    },
    [activeLocalGitState, repositories, selectedLocalProject]
  );

  // ── Branch options (context-dependent) ──
  const branchOptions = useMemo<AcpSessionSelectOption[]>(() => {
    if (contextType === 'local') {
      if (!activeLocalGitState?.git) {
        return [];
      }
      return normalizeChatLandingBranches(
        activeLocalGitState.branches,
        activeLocalGitState.defaultBranch
      ).map((branch) => ({
        value: branch,
        label: getLocalProjectBranchLabel(branch, {
          local: t('chat.branchLocal'),
          remote: t('chat.branchRemote'),
        }),
      }));
    }
    // If no branches loaded (e.g. empty repo), show empty list instead of a fake "main"
    if (repoBranches.length === 0) return [];
    return repoBranches.map((b) => ({ value: b, label: b }));
  }, [activeLocalGitState, contextType, repoBranches, t]);

  const currentBranch = contextType === 'local' ? selectedLocalBranch : selectedBranch;
  const currentBranchLabel =
    branchOptions.find((option) => option.value === currentBranch)?.label ?? currentBranch;
  const setCurrentBranch =
    contextType === 'local' ? handleSelectedLocalBranchChange : setSelectedBranch;

  // ── Prompt keydown ──
  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || isImeComposingKeyboardEvent(event)) return;
    if (
      !shouldSubmitOnEnterForMobileKeyboardAction({
        action: mobileKeyboardAction,
        isMobile: usesMobileKeyboardAction,
        shiftKey: event.shiftKey,
      })
    ) {
      return;
    }
    event.preventDefault();
    void handleSubmit();
  };

  const handlePromptPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const text = event.clipboardData.getData('text/plain');

      if (text && shouldCapturePastedTextDraft(text)) {
        event.preventDefault();
        if (insertLargePastedTextAtSelection(text)) {
          return;
        }
      }

      const pastedFiles = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);

      if (pastedFiles.length > 0) {
        event.preventDefault();
        const { images, attachments } = splitImageAndFileAttachments(pastedFiles);
        if (images.length > 0) {
          addFiles(images);
        }
        if (attachments.length > 0) {
          addFileAttachments(attachments);
        }
        return;
      }

      handleImagePromptPaste(event);
    },
    [addFileAttachments, addFiles, handleImagePromptPaste, insertLargePastedTextAtSelection]
  );
  const handleImageDrop = useCallback(
    (files: File[]) => {
      const { images, attachments } = splitImageAndFileAttachments(files);
      if (images.length > 0) {
        addFiles(images);
      }
      if (attachments.length > 0) {
        addFileAttachments(attachments);
      }
    },
    [addFileAttachments, addFiles]
  );
  const handleAttachmentInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length > 0) {
        handleImageDrop(files);
      }
      event.target.value = '';
    },
    [handleImageDrop]
  );
  const handleOpenAttachmentPicker = useCallback(() => {
    attachmentInputRef.current?.click();
  }, []);

  const handleConnectGitRepo = useCallback(() => {
    openSettings('github');
  }, [openSettings]);

  const handleAddLocalProject = useCallback(() => {
    openAddProjectDialog();
  }, [openAddProjectDialog]);

  const handleLocalProjectAdded = useCallback(
    (info: { machineId: MachineId; localProjectId: LocalProjectId }) => {
      handleSelectedLocalProjectChange({
        machineId: info.machineId,
        localProjectId: info.localProjectId,
      });
      setContextType('local');
    },
    [handleSelectedLocalProjectChange]
  );

  const captureSessionInputBlocked = useCallback(
    (
      reason:
        | 'image_upload_in_progress'
        | 'empty_input'
        | 'missing_agent_config'
        | 'missing_machine'
        | 'missing_context'
        | 'local_project_git_state_failed'
        | 'missing_branch'
        | 'missing_project',
      extra?: Record<string, unknown>
    ) => {
      capturePostHogEvent(postHog, 'session/input_blocked', {
        reason,
        entrypoint: 'chat_landing',
        project_kind: analyticsProjectKind,
        has_pending_images: hasBlockingImages,
        workspace_id: workspaceId ?? null,
        machine_id:
          contextType === 'local'
            ? (selectedLocalProject?.machineId ?? selectedAgent?.machineId ?? null)
            : (selectedAgent?.machineId ?? null),
        agent_config_id: selectedAgent?.agentId ?? null,
        repo_id_hash: contextType === 'github' ? hashAnalyticsId(selectedRepo) : null,
        local_project_id:
          contextType === 'local' ? (selectedLocalProject?.localProjectId ?? null) : null,
        ...extra,
      });
    },
    [
      analyticsProjectKind,
      contextType,
      hasBlockingImages,
      postHog,
      selectedAgent,
      selectedLocalProject,
      selectedRepo,
      workspaceId,
    ]
  );

  // ── Submit ──
  const handleSubmit = async () => {
    if (submitting) return;
    const submitStartedAtMs = getPerformanceNowMs();
    if (hasBlockingImages || hasBlockingFiles) {
      captureSessionInputBlocked('image_upload_in_progress');
      return;
    }

    // One pass: pasted placeholders, `$skill`, `@session:`, and the mentions
    // that need no rewrite all resolve against the same original text, and the
    // spans record where each landed. `normalizeSessionInputBlocks` re-anchors
    // them across its trim.
    const expandedPrompt = expandSkillMentionsForPrompt({
      text: prompt,
      mentions: persistedMentionRanges ?? [],
      pastedTextDrafts,
    });
    const inputBlocks = normalizeSessionInputBlocks(
      buildInputBlocks(expandedPrompt.text, buildFileInputBlocks(), expandedPrompt.spans),
      ''
    );
    const promptText = extractPromptPreviewFromInputBlocks(inputBlocks);
    if (inputBlocks.length === 0) {
      captureSessionInputBlocked('empty_input');
      setComposerError(t('chat.validation.missingPrompt'));
      return;
    }
    if (!selectedAgent || !selectedConfig) {
      captureSessionInputBlocked('missing_agent_config');
      setComposerError(t('chat.validation.missingAgent'));
      return;
    }
    const scopedMachineId =
      contextType === 'local'
        ? selectedMachineId && isSelectedMachineValid
          ? selectedMachineId
          : (selectedLocalProject?.machineId ?? null)
        : selectedMachineId && isSelectedMachineValid
          ? selectedMachineId
          : null;
    if (!scopedMachineId || selectedAgent.machineId !== scopedMachineId) {
      captureSessionInputBlocked('missing_machine');
      setComposerError(t('chat.validation.missingMachine'));
      return;
    }
    const machine = machines.get(scopedMachineId);
    if (!machine) {
      captureSessionInputBlocked('missing_machine');
      setComposerError(t('chat.validation.missingMachine'));
      return;
    }
    if (!currentUser || !userId || !workspaceId) {
      captureSessionInputBlocked('missing_context');
      setComposerError(t('chat.validation.missingContext'));
      return;
    }
    if (!runtime) {
      captureSessionInputBlocked('missing_context');
      setComposerError(t('chat.validation.missingContext'));
      return;
    }
    const githubBranch = selectedBranch?.trim() || '';
    const localWorktreeBranch =
      effectiveWorkdirMode === 'worktree' ? selectedLocalBranch?.trim() || undefined : undefined;
    if (contextType === 'local' && localGitStateError && selectedWorkdirMode === 'worktree') {
      captureSessionInputBlocked('local_project_git_state_failed', {
        error_message: localGitStateError,
      });
      return;
    }
    // Only require branch selection when the repo actually has branches.
    // Empty repos have no branches, but sessions can still be created.
    if (contextType === 'github' && !githubBranch && repoBranches.length > 0) {
      captureSessionInputBlocked('missing_branch');
      setComposerError(t('chat.validation.missingBranch'));
      return;
    }

    // Tracks the dispatch phase so the catch block can emit a structured
    // failure_reason (spec §5.4) instead of a flat "unknown". Each phase sets
    // this immediately before the awaited call that owns it.
    let startFailureReason: SessionStartFailureReason = 'unknown';
    const acpAnalyticsProperties = buildSessionCreateAcpAnalyticsProperties({
      cliType: selectedConfig?.cliType,
      agentType: selectedConfig?.agentType,
      modeId: modeOptions.length > 0 ? selectedModeId : null,
      modelId: modelOptions.length > 0 ? selectedModelId : null,
      configOptionValues,
      configOptionSelectors,
    });
    const sessionIdForStart = draftSessionId ?? ensureDraftSessionId();
    try {
      setSubmitting(true);
      setComposerStatus(null);
      // Preserve React draft state until startSession is accepted, but clear the
      // controlled element immediately so click/Enter feedback cannot wait for
      // the first local writer await.
      if (promptTextareaRef.current) {
        promptTextareaRef.current.value = '';
      }

      let project: ProjectRef | undefined;
      let repoFullNameForMentions: string | undefined;

      if (contextType === 'local' && !selectedLocalProject) {
        captureSessionInputBlocked('missing_project');
        setComposerError(t('chat.validation.missingProject', 'Please select a project'));
        return;
      }
      if (contextType === 'local' && selectedLocalProject?.machineId !== scopedMachineId) {
        captureSessionInputBlocked('missing_project');
        setComposerError(t('chat.validation.missingProject', 'Please select a project'));
        return;
      }

      if (contextType === 'local' && selectedLocalProject) {
        const githubRepoFullName = resolveSelectedLocalProjectGitHubRepo(activeLocalGitState);
        project = {
          kind: 'local',
          localProjectId: selectedLocalProject.localProjectId,
          ...(localWorktreeBranch ? { branch: localWorktreeBranch } : {}),
          ...(githubRepoFullName ? { githubRepoFullName } : {}),
          ...(effectiveWorkdirMode === 'worktree' ? { useWorktree: true } : {}),
        };
        repoFullNameForMentions = githubRepoFullName ?? undefined;
      } else if (contextType === 'github' && selectedRepo) {
        project = { kind: 'github', repoFullName: selectedRepo, branch: githubBranch };
        repoFullNameForMentions = selectedRepo;
      }

      const draftTitle = promptText
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0)
        ?.slice(0, 50);
      /* Agent config prompt, then the Role's instruction, then the task — the
         Role speaks for how this agent is being used, so it sits between the
         two. A Role only reaches here while it is still what will run. */
      const promptPayload = buildAgentPrompt(
        promptText,
        buildAgentPrompt(activeAgentRole?.promptPrefix ?? '', selectedConfig.prompt ?? '')
      );
      const issuePRMentions = extractIssuePRMentionsFromText(
        promptText,
        knownIssuePrItems,
        repoFullNameForMentions
      );
      const inputConfig = buildSessionTurnInputConfig({
        inputBlocks,
        prompt: promptPayload,
        cliType: selectedConfig.cliType,
        agentType: selectedConfig.agentType,
        modeId: modeOptions.length > 0 ? (selectedModeId ?? undefined) : undefined,
        modelId: modelOptions.length > 0 ? (selectedModelId ?? undefined) : undefined,
        configOptionValues: dispatchConfigOptionValues,
        issuePRMentions,
        mcpServerIds: mcpSelection.selectedIds,
        taskToolsEnabled: tasksFeatureEnabled,
        agentRoleId: activeAgentRole?.id ?? null,
        agentRoleRevision: activeAgentRole?.revision,
      });
      const pendingHistoryEntry = buildPendingUserHistoryEntry({
        userId,
        inputBlocks,
        timestamp: new Date().toISOString(),
        inputConfig,
      });
      if (!pendingHistoryEntry) {
        throw new Error('Initial session history missing effective items');
      }
      startFailureReason = 'session_create_failed';
      const { sessionId, historyEntry } = await startSession(
        {
          sessionId: sessionIdForStart,
          userId,
          cliType: selectedConfig.cliType,
          agentType: selectedConfig.agentType,
          customAcp: selectedConfig.customAcp,
          runtimeOverrides: selectedConfig.runtimeOverrides,
          machineId: selectedAgent.machineId,
          agentConfigId: selectedAgent.agentId,
          env: selectedConfig.env,
          repoFullName: repoFullNameForMentions,
          project,
          worktreeSetup:
            contextType === 'github' && selectedRepoWorktreeSetup
              ? selectedRepoWorktreeSetup
              : undefined,
          worktreeCleanup:
            contextType === 'github' && selectedRepoWorktreeCleanup
              ? selectedRepoWorktreeCleanup
              : undefined,
          branchName: contextType === 'github' ? githubBranch : localWorktreeBranch,
          title: draftTitle,
          titleSource: draftTitle ? 'draft' : undefined,
          // Provenance only: the dispatch config above is already frozen, so a
          // Role edited or deleted later cannot change how this session runs.
          ...(activeAgentRole
            ? { agentRoleId: activeAgentRole.id, agentRoleRevision: activeAgentRole.revision }
            : {}),
        },
        pendingHistoryEntry
      );
      if (!historyEntry || typeof historyEntry !== 'object' || !('id' in historyEntry)) {
        throw new Error(`Initial session history missing entry id (sessionId=${sessionId})`);
      }
      persistAgentSessionDefaults(selectedAgent.agentId, {
        modeId: modeOptions.length > 0 ? selectedModeId : null,
        modelId: modelOptions.length > 0 ? selectedModelId : null,
        configOptionValues: dispatchConfigOptionValues,
      });
      // A recent entry is a configuration the user actually RAN, so it is
      // recorded here — after the session was accepted — not when a knob moves.
      setRecentRunConfigRecords(
        recordRecentRunConfig(
          workspaceId,
          {
            agentId: selectedAgent.agentId,
            machineId: selectedAgent.machineId,
            modelId: currentRunConfigFace.modelId,
            modelLabel: currentRunConfigFace.modelLabel,
            reasoningLabel: currentRunConfigFace.reasoningLabel,
            planOn: currentRunConfigFace.planOn,
            fastOn: currentRunConfigFace.fastOn,
            configOptionValues: sanitizeConfigOptionValues(dispatchConfigOptionValues),
            // A Role is one of these combinations, so it is recorded as one —
            // as the Role, not as the values it happened to set.
            agentRoleId: activeAgentRole?.id ?? null,
          },
          Date.now()
        )
      );
      handoffSessionPreparation(sessionId);

      capturePostHogEvent(postHog, 'session/start_requested', {
        user_id: userId,
        workspace_id: workspaceId,
        session_id: sessionId,
        machine_id: selectedAgent.machineId,
        agent_config_id: selectedAgent.agentId,
        cli_type: selectedConfig.cliType,
        agent_type: selectedConfig.agentType,
        ...acpAnalyticsProperties,
        repo_id_hash: hashAnalyticsId(repoFullNameForMentions),
        project_kind: analyticsProjectKind,
        local_project_id: selectedLocalProject?.localProjectId ?? null,
        workdir_mode: contextType === 'local' ? effectiveWorkdirMode : null,
        has_images: inputBlocks.some((block) => block.type === 'image'),
        image_count: inputBlocks.filter((block) => block.type === 'image').length,
        entrypoint: 'chat_landing',
        launch_mode: launchMode,
        submit_prepare_ms: getDurationSinceMs(submitStartedAtMs),
      });
      capturePostHogEvent(postHog, SESSION_ACP_CONFIG_USED_EVENT, {
        user_id: userId,
        workspace_id: workspaceId,
        session_id: sessionId,
        machine_id: selectedAgent.machineId,
        agent_config_id: selectedAgent.agentId,
        cli_type: selectedConfig.cliType,
        agent_type: selectedConfig.agentType,
        ...acpAnalyticsProperties,
        project_kind: analyticsProjectKind,
        entrypoint: 'chat_landing',
        launch_mode: launchMode,
      });

      const dispatchStartedAtMs = getPerformanceNowMs();
      void requestSessionDispatch(sessionId, historyEntry.id, {
        inputConfig,
        machineId: selectedAgent.machineId,
      }).catch((dispatchError: unknown) => {
        const errorMessage =
          dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
        capturePostHogEvent(postHog, 'session/start_dispatch_failed', {
          user_id: userId,
          workspace_id: workspaceId,
          session_id: sessionId,
          machine_id: selectedAgent.machineId,
          agent_config_id: selectedAgent.agentId,
          cli_type: selectedConfig.cliType,
          agent_type: selectedConfig.agentType,
          ...acpAnalyticsProperties,
          repo_id_hash: hashAnalyticsId(repoFullNameForMentions),
          project_kind: analyticsProjectKind,
          local_project_id: selectedLocalProject?.localProjectId ?? null,
          workdir_mode: contextType === 'local' ? effectiveWorkdirMode : null,
          entrypoint: 'chat_landing',
          launch_mode: launchMode,
          duration_ms: getDurationSinceMs(dispatchStartedAtMs),
          error_message: errorMessage,
        });
        console.error('Failed to request session dispatch', dispatchError);
        toast.error(t('chat.failed'), { description: errorMessage });
      });
      if (contextType === 'local' && selectedLocalProject) {
        writeWorkdirModePreference(selectedLocalProject.localProjectId, effectiveWorkdirMode);
      }

      // session_number is derived from the user's own prior sessions counted at
      // submit start (ref snapshot avoids races with the just-created session
      // streaming into the visible list). 1 = first-ever, which drives the
      // activation anchor below (spec §3.1).
      const sessionNumber = ownPriorSessionCountRef.current + 1;
      const isFirstSessionEver = sessionNumber === 1;

      capturePostHogEvent(postHog, 'session/start_success', {
        user_id: userId,
        workspace_id: workspaceId,
        session_id: sessionId,
        machine_id: selectedAgent.machineId,
        agent_config_id: selectedAgent.agentId,
        cli_type: selectedConfig.cliType,
        agent_type: selectedConfig.agentType,
        ...acpAnalyticsProperties,
        repo_id_hash: hashAnalyticsId(repoFullNameForMentions),
        project_kind: analyticsProjectKind,
        local_project_id: selectedLocalProject?.localProjectId ?? null,
        workdir_mode: contextType === 'local' ? effectiveWorkdirMode : null,
        session_number: sessionNumber,
        launch_mode: launchMode,
        dispatch_duration_ms: getDurationSinceMs(submitStartedAtMs),
      });

      // Unified activation anchor (spec §3.1/§3.4). Web fires it for the user's
      // first-ever successful start; the CLI fires the same anchor for CLI-first
      // users so the D1/D7/D30 cohort is the Web ∪ CLI union. signup_at /
      // days_since_signup are sent only when available (not surfaced client-side
      // today) so the property stays absent rather than wrong.
      if (isFirstSessionEver) {
        capturePostHogEvent(postHog, 'activation/first_session_succeeded', {
          user_id: userId,
          workspace_id: workspaceId,
          session_id: sessionId,
          machine_id: selectedAgent.machineId,
          agent_config_id: selectedAgent.agentId,
          cli_type: selectedConfig.cliType,
          agent_type: selectedConfig.agentType,
          project_kind: analyticsProjectKind,
          is_first_session_ever: true,
          created_via: 'web',
          launch_mode: launchMode,
        });
      }

      // Local session creation and history write succeeded; a later navigate()
      // throw is not a session-start failure, so reset the phase before it can
      // be misattributed.
      startFailureReason = 'unknown';

      setPrompt('');
      clearPastedTextDrafts();
      clearPendingImages();
      clearPendingFiles();
      resetDraftSessionId();
      if (mobileNewChatOpen) {
        // The mobile base ChatLanding stays mounted beneath the session drawer.
        // Close the sheet explicitly on successful start so keyboard-submit and
        // button-submit leave the same clean underlying state.
        promptTextareaRef.current?.blur();
        setMobileNewChatOpen(false);
      }
      await navigate(
        getSessionCreationNavigation(workspaceSlug, sessionId, usesMobileKeyboardAction)
      );
    } catch (error) {
      capturePostHogEvent(postHog, 'session/start_failed', {
        user_id: userId ?? null,
        workspace_id: workspaceId ?? null,
        machine_id: selectedAgent?.machineId ?? null,
        agent_config_id: selectedAgent?.agentId ?? null,
        cli_type: selectedConfig?.cliType ?? null,
        agent_type: selectedConfig?.agentType ?? null,
        ...acpAnalyticsProperties,
        repo_id_hash: contextType === 'github' ? hashAnalyticsId(selectedRepo) : null,
        project_kind: analyticsProjectKind,
        local_project_id: selectedLocalProject?.localProjectId ?? null,
        failure_reason: startFailureReason,
        entrypoint: 'chat_landing',
        launch_mode: launchMode,
        duration_ms: getDurationSinceMs(submitStartedAtMs),
        error_message: error instanceof Error ? error.message : String(error),
      });
      console.error('Failed to start session', error);
      if (error instanceof SessionCreateBillingError) {
        if (error.code === 'workspace_payment_required') {
          toast.error(
            t(
              hidesBillingUi
                ? 'sessions.workspaceUnavailableMobileTitle'
                : 'sessions.workspaceCheckoutPendingTitle'
            ),
            {
              description: t(
                hidesBillingUi
                  ? 'sessions.workspaceUnavailableMobileDescription'
                  : 'sessions.workspaceCheckoutPendingDescription'
              ),
            }
          );
        } else {
          toast.error(t('sessions.freeSessionLimitReachedTitle'), {
            description: t(
              hidesBillingUi
                ? 'sessions.freeSessionLimitReachedMobileDescription'
                : 'sessions.freeSessionLimitReachedDescription',
              {
                limit: error.limit,
                current: error.current,
              }
            ),
            ...(hidesBillingUi
              ? {}
              : {
                  action: {
                    label: t('sessions.freeTurnLimitUpgrade'),
                    onClick: () => openSettings('billing'),
                  },
                }),
          });
        }
      } else {
        const errMsg = error instanceof Error ? error.message : String(error);
        toast.error(t('chat.failed'), { description: errMsg });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ── Selector nodes ──
  // Only constrain to selectedMachineId if it still refers to a valid online machine.
  const isSelectedMachineValid = useMemo(() => {
    if (!selectedMachineId) return false;
    return isChatLandingMachineReachable({
      machineId: selectedMachineId,
      localMachineId: visibleLocalMachineId,
      machines,
      isMachineOnline: isPresenceMachineOnline,
    });
  }, [selectedMachineId, machines, visibleLocalMachineId, isPresenceMachineOnline]);

  // The agent selector must always be scoped to exactly one machine.
  const localProjectMachineId =
    contextType === 'local' && selectedLocalProject ? selectedLocalProject.machineId : null;
  const scopedMachineId = useMemo(
    () => (selectedMachineId && isSelectedMachineValid ? selectedMachineId : localProjectMachineId),
    [localProjectMachineId, selectedMachineId, isSelectedMachineValid]
  );
  const localProjectSelectorMachineId =
    contextType === 'local' ? (selectedMachineId ?? localProjectMachineId) : null;
  const localProjectSelectorEmptyText = t(
    getEmptyLocalProjectsMessageKey(Boolean(localProjectSelectorMachineId))
  );

  const { showBranchSelector, isBranchDisabled, branchSelectorKey } =
    getChatLandingBranchSelectorState({
      contextType,
      workdirMode: effectiveWorkdirMode,
      selectedRepo,
      repoBranchesCount: repoBranches.length,
      hasRepoDefaultBranch: Boolean(repoDefaultBranch),
      hasSelectedLocalProject: Boolean(selectedLocalProject),
      selectedLocalProjectId: selectedLocalProject?.localProjectId ?? null,
      isRuntimeInitializing: runtimeInitializing,
      isLoadingLocalGitState: loadingLocalGitState,
      hasLocalGit: activeLocalGitState?.git === true,
      branchOptionsCount: branchOptions.length,
    });

  const branchSelectorNode = showBranchSelector ? (
    <span className="inline-flex min-w-0 items-center gap-1">
      <BranchSelector
        key={branchSelectorKey}
        value={currentBranch}
        onChange={setCurrentBranch}
        options={branchOptions}
        tone={tone}
        placeholder={t('chat.branchPlaceholder')}
        searchPlaceholder={t('chat.branchSearchPlaceholder', { defaultValue: 'Search branches' })}
        emptyText={t('chat.branchEmpty', { defaultValue: 'No branches found' })}
        loading={contextType === 'local' ? loadingLocalGitState || runtimeInitializing : undefined}
        loadingText={t('chat.branchLoading', { defaultValue: 'Loading branches...' })}
        className="h-6 min-w-0 max-w-full gap-1.5 rounded-none border-none bg-transparent px-2 text-xs font-normal text-foreground/80 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-100 [&_span]:text-xs [&_span]:leading-tight [&_svg]:text-current [&_svg]:opacity-100"
        disabled={isBranchDisabled}
      />
    </span>
  ) : null;
  const localGitStateRetryNode =
    contextType === 'local' &&
    selectedLocalProject &&
    localGitStateError &&
    !loadingLocalGitState ? (
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 rounded-md px-0 text-status-error hover:text-status-error [&_svg]:size-3.5"
            onClick={handleLocalGitStateRetry}
            aria-label={t('chat.localGitStateRetry', 'Retry loading branches')}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('chat.localGitStateRetry', 'Retry loading branches')}
        </TooltipContent>
      </Tooltip>
    ) : null;

  const worktreeUnavailableReason = loadingLocalGitState
    ? t('chat.workdir.checkingGit', 'Checking whether this project is a git repository.')
    : activeLocalGitState?.git === false
      ? t('chat.workdir.notGitRepo', 'This local project is not a git repository.')
      : (localGitStateError ?? undefined);

  const topWorktreeNode =
    contextType === 'github' && selectedRepo ? (
      <WorktreeCheckboxPill
        checked
        disabled
        className="h-6 rounded-none bg-transparent px-2 text-foreground/80 hover:bg-foreground/[0.06]"
        disabledReason={t(
          'chat.workdir.githubRequired',
          'GitHub projects always run in an isolated worktree.'
        )}
      />
    ) : contextType === 'local' && selectedLocalProject ? (
      <WorktreeCheckboxPill
        checked={effectiveWorkdirMode === 'worktree'}
        onCheckedChange={(checked) => handleWorkdirModeChange(checked ? 'worktree' : 'local')}
        disabled={!worktreeAvailable}
        disabledReason={!worktreeAvailable ? worktreeUnavailableReason : undefined}
        className="h-6 rounded-none bg-transparent px-2 text-foreground/80 hover:bg-foreground/[0.06]"
      />
    ) : null;

  const branchWorktreePill =
    branchSelectorNode || topWorktreeNode ? (
      <div className="flex h-6 min-w-0 max-w-full items-center overflow-hidden rounded-md bg-input/60 dark:bg-foreground/[0.08]">
        {branchSelectorNode}
        {branchSelectorNode && topWorktreeNode ? (
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
        ) : null}
        {topWorktreeNode}
      </div>
    ) : null;

  const mobileSheetRecency = useMemo(
    () => getChatLandingProjectRecency(visibleSessions),
    [visibleSessions]
  );

  const desktopProjectSelection = useMemo<UnifiedProjectSelection>(() => {
    if (contextType === 'local' && selectedLocalProject) {
      return { kind: 'local', ...selectedLocalProject };
    }
    if (contextType === 'github' && selectedRepo) {
      return { kind: 'github', repoFullName: selectedRepo };
    }
    return { kind: 'none' };
  }, [contextType, selectedLocalProject, selectedRepo]);
  const handleDesktopProjectChange = useCallback(
    (selection: UnifiedProjectSelection) => {
      if (selection.kind === 'none') {
        setContextType('chat');
        return;
      }
      if (selection.kind === 'github') {
        setSelectedRepo(selection.repoFullName);
        setContextType('github');
        return;
      }
      handleSelectedLocalProjectChange({
        machineId: selection.machineId,
        localProjectId: selection.localProjectId,
      });
      setContextType('local');
    },
    [handleSelectedLocalProjectChange]
  );
  const desktopAgentMachineIds = useMemo(
    () => (scopedMachineId ? [scopedMachineId] : []),
    [scopedMachineId]
  );
  /* Roles offered for the machine this chat will start on. Scoped to that one
     machine because a Role binds its execution site exactly — a Role from
     another machine could only move the chat off the selected one. */
  const composerAgentRoleItems = useMemo(
    () =>
      buildComposerAgentRoleItems({
        roles: workspaceAgentRoles,
        machineId: scopedMachineId,
        agentConfigs: executorConfigs,
        resolveAvailability: resolveAgentRoleAvailability,
      }),
    [executorConfigs, resolveAgentRoleAvailability, scopedMachineId, workspaceAgentRoles]
  );
  const handleAgentRoleSelect = useCallback(
    (roleId: AgentRoleId | null) => {
      // Leaving a Role clears the NAME, not the configuration: the values it
      // seeded are now the user's own, and silently rolling them back would
      // undo choices they never asked to undo.
      if (roleId === null) {
        setAgentRolePreference(null);
        return;
      }
      const item = composerAgentRoleItems.find((entry) => entry.role.id === roleId);
      // An unavailable Role is listed so its owner can see why it cannot run;
      // it is never something the composer quietly starts a chat with.
      if (!item || item.availability.kind !== 'available') return;
      const { role } = item;
      agentRolePreferenceTokenRef.current += 1;
      setPendingRecentRunConfig(null);
      setSelectedAgent({ agentId: role.agentConfigId, machineId: role.machineId });
      setAgentRolePreference({ roleId: role.id, token: agentRolePreferenceTokenRef.current });
    },
    [composerAgentRoleItems]
  );

  /* Creating a Role from the composer opens on the configuration already in
     front of the user — "save what I am about to run" is the whole reason the
     entry point is here rather than only in Settings. */
  const handleAgentRoleCreate = useCallback(() => {
    setAgentRoleEditor(
      openAgentRoleEditorForCreate(
        buildAgentRoleFormValueFromRunConfig({
          machineId: selectedAgent?.machineId ?? scopedMachineId,
          agentConfigId: selectedAgent?.agentId ?? null,
          modeId: selectedModeId,
          modelId: modelOptions.length > 0 ? selectedModelId : null,
          configOptionValues: sanitizeConfigOptionValues(dispatchConfigOptionValues),
        })
      )
    );
  }, [
    dispatchConfigOptionValues,
    modelOptions.length,
    scopedMachineId,
    selectedAgent,
    selectedModeId,
    selectedModelId,
  ]);
  const handleAgentRoleEdit = useCallback(
    (roleId: AgentRoleId) => {
      const role = composerAgentRoleItems.find((entry) => entry.role.id === roleId)?.role;
      if (role) setAgentRoleEditor(openAgentRoleEditorForEdit(role));
    },
    [composerAgentRoleItems]
  );
  /* Creating a Role from the composer means "use this now", so the new Role is
     selected as soon as the composer can offer it. Deferred rather than
     immediate: the write resolves on durability while the catalog snapshot
     arrives on its own tick, so the Role is not in the list yet at that moment. */
  const [pendingAgentRoleSelection, setPendingAgentRoleSelection] = useState<AgentRoleId | null>(
    null
  );
  const handleAgentRoleSaved = useCallback((role: AgentRole, { created }: { created: boolean }) => {
    if (created) setPendingAgentRoleSelection(role.id);
  }, []);
  useEffect(() => {
    if (!pendingAgentRoleSelection) return;
    const outcome = resolvePendingAgentRoleSelection({
      roleId: pendingAgentRoleSelection,
      items: composerAgentRoleItems,
      isInCatalog: workspaceAgentRoles.some((role) => role.id === pendingAgentRoleSelection),
    });
    if (outcome === 'wait') return;
    setPendingAgentRoleSelection(null);
    if (outcome === 'select') handleAgentRoleSelect(pendingAgentRoleSelection);
  }, [
    composerAgentRoleItems,
    handleAgentRoleSelect,
    pendingAgentRoleSelection,
    workspaceAgentRoles,
  ]);

  /* Restore the last-used Role once, and only once the catalog can answer.
     Until the workspace document has synced, "not in the list" means "not
     loaded yet", so giving up then would silently drop the stored Role. */
  useEffect(() => {
    if (agentRoleRestored || !defaultsReady) return;
    const storedRoleId = readChatLandingDefaults(workspaceId)?.agentRoleId as
      | AgentRoleId
      | undefined;
    if (!storedRoleId) {
      setAgentRoleRestored(true);
      return;
    }
    const item = composerAgentRoleItems.find((entry) => entry.role.id === storedRoleId);
    if (!item) {
      if (agentRolesSynced) setAgentRoleRestored(true);
      return;
    }
    setAgentRoleRestored(true);
    handleAgentRoleSelect(storedRoleId);
  }, [
    agentRoleRestored,
    agentRolesSynced,
    composerAgentRoleItems,
    defaultsReady,
    handleAgentRoleSelect,
    workspaceId,
  ]);
  const agentRolePinsPermissionMode = useMemo(() => {
    if (!activeAgentRole) return false;
    const { source } = resolvePermissionModeFace({
      modeOptions,
      selectedModeId,
      configOptionSelectors,
      configOptionValues,
    });
    return doesAgentRolePinPermissionMode(activeAgentRole, source);
  }, [activeAgentRole, configOptionSelectors, configOptionValues, modeOptions, selectedModeId]);

  /* Recent entries are offered only for agents the menu itself can select: one
     recorded on another machine must not silently move the chat off the
     selected one. */
  const recentRunConfigAgentConfigs = useMemo(
    () =>
      scopedMachineId
        ? executorConfigs.filter((config) => config.machineId === scopedMachineId)
        : executorConfigs,
    [executorConfigs, scopedMachineId]
  );
  /* Only Roles the composer could pick right now: a recorded Role entry whose
     Role is gone or unavailable must drop out rather than re-running its values
     without it. */
  const selectableAgentRoles = useMemo(
    () =>
      composerAgentRoleItems
        .filter((item) => item.availability.kind === 'available')
        .map((item) => item.role),
    [composerAgentRoleItems]
  );
  const recentRunConfigItems = useMemo(
    () =>
      buildRecentRunConfigItems({
        records: recentRunConfigRecords,
        agentConfigs: recentRunConfigAgentConfigs,
        agentRoles: selectableAgentRoles,
        currentKey: currentRunConfigKey,
      }),
    [currentRunConfigKey, recentRunConfigAgentConfigs, recentRunConfigRecords, selectableAgentRoles]
  );
  const handleRecentRunConfigSelect = useCallback(
    (id: string) => {
      const record = recentRunConfigRecords.find((entry) => getRecentRunConfigKey(entry) === id);
      if (!record) return;
      // Recorded AS a Role: re-apply the Role, not the values it set. Those
      // values are only half of it — the instruction and the provenance ride
      // with the Role, and re-running "the same knobs" would drop both.
      if (record.agentRoleId) {
        handleAgentRoleSelect(record.agentRoleId as AgentRoleId);
        return;
      }
      const config = recentRunConfigAgentConfigs.find(
        (entry) => entry.id === record.agentId && entry.machineId === record.machineId
      );
      if (!config) return;
      // A recent entry and a Role are two whole configurations; the one just
      // picked owns the selection, so the other stops driving it.
      setAgentRolePreference(null);
      setSelectedAgent({ agentId: config.id, machineId: config.machineId });
      setPendingRecentRunConfig(record);
    },
    [handleAgentRoleSelect, recentRunConfigAgentConfigs, recentRunConfigRecords]
  );

  const desktopMachineOptions = useMemo(
    () =>
      Array.from(selectableMachines.values()).map((machine) => ({
        value: machine.id,
        label: machine.name,
        isPrivate:
          showProjectSharing && accessByMachineId.get(machine.id)?.sharedWithTeam === false,
      })),
    [accessByMachineId, selectableMachines, showProjectSharing]
  );
  const desktopSelectedMachineId = scopedMachineId;
  const desktopSelectedMachineLabel = desktopSelectedMachineId
    ? machines.get(desktopSelectedMachineId)?.name
    : null;
  const desktopLocalProjectOptions = useMemo(
    () =>
      buildUnifiedLocalProjectOptions({
        visibleLocalProjects,
        selectedMachineId: desktopSelectedMachineId,
        latestMessageAtByLocalProject: mobileSheetRecency.byProject,
        projectSharing: showProjectSharing
          ? {
              currentUserId: userId ?? null,
              machineAccessByMachineId: accessByMachineId,
            }
          : undefined,
      }),
    [
      accessByMachineId,
      desktopSelectedMachineId,
      mobileSheetRecency.byProject,
      showProjectSharing,
      userId,
      visibleLocalProjects,
    ]
  );

  const topSelectorNode = (
    <ErrorBoundary
      name="ChatLandingTopSelector"
      variant="inline"
      resetKeys={[workspaceId, selectedRepo, selectedLocalProject, selectedMachineId, contextType]}
      fallback={
        <div className={cn(selectorTagClassName, 'text-xs leading-tight')}>
          {t('common.unavailable', 'Unavailable')}
        </div>
      }
    >
      <div className="flex w-full min-w-0 items-center gap-2">
        <DesktopMachineMenu
          value={desktopSelectedMachineId}
          visibleLocalMachineId={visibleLocalMachineId}
          selectedLabel={desktopSelectedMachineLabel}
          options={desktopMachineOptions}
          onChange={handleMachineChange}
          disabled={isInitialDataLoading}
          onAddMachine={handleAddMachine}
        />
        <UnifiedProjectSelectorView
          value={desktopProjectSelection}
          onChange={handleDesktopProjectChange}
          localProjects={desktopLocalProjectOptions}
          repositories={repositories}
          latestMessageAtByRepo={mobileSheetRecency.byRepo}
          onConnectGitRepo={handleConnectGitRepo}
          onAddLocalProject={handleAddLocalProject}
          onShareLocalProjectWithTeam={
            showProjectSharing ? handleShareLocalProjectWithTeam : undefined
          }
          getShareErrorMessage={getProjectShareErrorMessage}
          renderLimit={UNIFIED_PROJECT_OPTION_RENDER_LIMIT}
        />
        {localGitStateRetryNode}
        {branchWorktreePill}
      </div>
    </ErrorBoundary>
  );

  const footerSelectorNode = (
    <ErrorBoundary
      name="ChatLandingFooterSelector"
      variant="inline"
      resetKeys={[workspaceId, selectedAgent?.agentId]}
      fallback={null}
    >
      <div className="contents">
        <DesktopRunConfigMenu
          agentSelection={selectedAgent}
          allowedMachineIds={desktopAgentMachineIds}
          disabledReason={
            scopedMachineId
              ? undefined
              : t('chat.machineSelector.selectFirst', 'Select a machine first')
          }
          fallbackAgent={{
            cliType: selectedConfig?.cliType,
            agentType: selectedConfig?.agentType,
          }}
          onAgentConfigChange={setSelectedAgent}
          modelOptions={modelOptions}
          selectedModelId={selectedModelId}
          onModelChange={setSelectedModelName}
          configOptionSelectors={configOptionSelectors}
          configOptionValues={configOptionValues}
          onConfigOptionChange={handleConfigOptionChange}
          recentRunConfigs={recentRunConfigItems}
          onRecentRunConfigSelect={handleRecentRunConfigSelect}
          modeOptions={modeOptions}
          selectedModeId={selectedModeId}
          agentRoles={{
            items: composerAgentRoleItems,
            selectedRoleId: activeAgentRole?.id ?? null,
            onSelect: handleAgentRoleSelect,
            onCreate: handleAgentRoleCreate,
            onEdit: handleAgentRoleEdit,
            machine: scopedMachineId ? (machines.get(scopedMachineId) ?? null) : null,
          }}
        />
        {/* Permission is part of what a Role pins, so behind one it stops being
            a separate control and is stated in the Role's own face instead. It
            stays a button when the Role pins nothing there — an agent with no
            permission control leaves a Role nothing to own, and hiding the knob
            then would take away one the Role never had. */}
        {agentRolePinsPermissionMode ? null : (
          <DesktopPermissionModeButton
            modeOptions={modeOptions}
            selectedModeId={selectedModeId}
            onModeChange={setSelectedModeId}
            configOptionSelectors={configOptionSelectors}
            configOptionValues={configOptionValues}
            onConfigOptionChange={handleConfigOptionChange}
          />
        )}
        <SessionUsagePopover
          rateLimits={selectedRateLimits}
          agentType={selectedConfig?.agentType ?? ''}
          modelId={selectedModelId}
          modelLabel={selectedModelLabel}
          showCodexResetForecast={showCodexResetForecast}
          showRateLimitWithoutContext
        />
      </div>
    </ErrorBoundary>
  );

  const bottomBarNode = null;

  /* ── Mobile-sheet (new-chat bottom sheet) selector nodes ──
     The sheet drives every selector through the unified
     `MobileInlinePicker` — a chip-style trigger that expands a drawer
     of options inline below it. We bypass the desktop selector
     desktop selector components
     and feed the picker raw option arrays here so the interaction +
     animation are identical across machine / project / branch / model /
     thinking / agent / permission. The pill switchers (类型, 模式) stay
     as Tabs since they're already inline. */

  /* ── Machine ── */
  const mobileSheetOnlineMachines = useOnlineMachines();
  const mobileSheetMachineOptions = useMemo<MobileInlinePickerOption<MachineId>[]>(() => {
    return mobileSheetOnlineMachines.map((m) => ({
      value: m.id as MachineId,
      label: m.name,
      searchText: m.name,
      icon: <Monitor className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />,
    }));
  }, [mobileSheetOnlineMachines]);
  const mobileSheetSelectedMachineLabel = useMemo(() => {
    if (!selectedMachineId) return null;
    return mobileSheetMachineOptions.find((opt) => opt.value === selectedMachineId)?.label ?? null;
  }, [mobileSheetMachineOptions, selectedMachineId]);
  const mobileSheetMachineNode = (
    <MobileInlinePicker<MachineId>
      id="mobile-sheet-machine"
      value={selectedMachineId}
      onChange={(id) => handleMachineChange(id)}
      options={mobileSheetMachineOptions}
      disabled={hasNoMachine}
      loading={isInitialDataLoading}
      ariaLabel={t('chat.machineSelector.placeholder', 'Machine')}
      emptyText={t('chat.machineSelector.emptyText', 'No machines online')}
      searchable={mobileSheetMachineOptions.length > 5}
      searchPlaceholder={t('chat.machineSelector.searchPlaceholder', 'Search machines')}
      triggerContent={
        <>
          <Monitor className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
          <span className="truncate">
            {isInitialDataLoading
              ? t('chat.machineSelector.loading', 'Loading machine...')
              : (mobileSheetSelectedMachineLabel ??
                t('chat.machineSelector.placeholder', 'Machine'))}
          </span>
        </>
      }
    />
  );

  /* ── Project (per context) ── */
  const mobileSheetGitHubRepoOptions = useMemo<MobileInlinePickerOption<string>[]>(() => {
    if (contextType !== 'github') return [];
    const repos = [...(repositories ?? [])].sort((a, b) =>
      compareChatLandingRepositoryByRecency(a, b, mobileSheetRecency.byRepo)
    );
    return repos.map((repo) => ({
      value: repo.fullName,
      label: repo.fullName,
      searchText: repo.fullName,
      description: repo.description ?? undefined,
      icon: <GithubIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />,
    }));
  }, [contextType, repositories, mobileSheetRecency]);
  const mobileSheetLocalProjectOptions = useMemo<MobileInlinePickerOption<string>[]>(() => {
    if (contextType !== 'local') return [];
    const entries = [...visibleLocalProjectMap.values()]
      .filter(
        (entry) =>
          !localProjectSelectorMachineId || entry.machineId === localProjectSelectorMachineId
      )
      .sort((left, right) =>
        compareChatLandingLocalProjectByRecency(left, right, mobileSheetRecency.byProject)
      );
    return entries.map((entry) => ({
      value: buildLocalProjectKey(entry.machineId, entry.project.id),
      label: entry.project.name,
      searchText: `${entry.project.name} ${entry.project.rootPath}`,
      description: entry.project.rootPath,
      icon: <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />,
    }));
  }, [contextType, localProjectSelectorMachineId, visibleLocalProjectMap, mobileSheetRecency]);
  const mobileSheetSelectedLocalProjectKey = selectedLocalProject
    ? buildLocalProjectKey(selectedLocalProject.machineId, selectedLocalProject.localProjectId)
    : null;
  const mobileSheetSelectedRepoLabel = selectedRepo ?? null;
  const mobileSheetSelectedLocalProjectLabel = useMemo(() => {
    if (!mobileSheetSelectedLocalProjectKey) return null;
    return (
      mobileSheetLocalProjectOptions.find((opt) => opt.value === mobileSheetSelectedLocalProjectKey)
        ?.label ?? null
    );
  }, [mobileSheetLocalProjectOptions, mobileSheetSelectedLocalProjectKey]);
  const mobileSheetProjectNode =
    contextType === 'github' ? (
      <MobileInlinePicker<string>
        id="mobile-sheet-repo"
        value={selectedRepo ?? null}
        onChange={(repo) => {
          setSelectedRepo(repo);
          setContextType('github');
        }}
        options={mobileSheetGitHubRepoOptions}
        ariaLabel={t('chat.repoPlaceholder', 'Repository')}
        emptyText={t(
          'chat.mobileHome.emptyGitHubProjects',
          '当前 workspace 没有已授权的 GitHub 仓库'
        )}
        searchable={mobileSheetGitHubRepoOptions.length > 5}
        searchPlaceholder={t('chat.mobileHome.repoSearchPlaceholder', 'Search repositories')}
        triggerContent={
          <>
            <GithubIcon className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
            <span className="truncate">
              {mobileSheetSelectedRepoLabel ?? t('chat.repoPlaceholder', 'Repository')}
            </span>
          </>
        }
      />
    ) : (
      <MobileInlinePicker<string>
        id="mobile-sheet-local-project"
        value={mobileSheetSelectedLocalProjectKey}
        onChange={(key) => {
          const opt = visibleLocalProjectMap.get(key);
          if (!opt) return;
          handleSelectedLocalProjectChange({
            machineId: opt.machineId,
            localProjectId: opt.project.id,
          });
          setContextType('local');
        }}
        options={mobileSheetLocalProjectOptions}
        ariaLabel={t('chat.validation.missingProject', 'Select a project')}
        emptyText={localProjectSelectorEmptyText}
        searchable={mobileSheetLocalProjectOptions.length > 5}
        searchPlaceholder={t('chat.mobileHome.localProjectSearchPlaceholder', 'Search projects')}
        triggerContent={
          <>
            <FolderOpen className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
            <span className="truncate">
              {mobileSheetSelectedLocalProjectLabel ??
                t('chat.validation.missingProject', 'Select a project')}
            </span>
          </>
        }
      />
    );

  /* ── Branch ── */
  const mobileSheetBranchOptions = useMemo<MobileInlinePickerOption<string>[]>(
    () =>
      branchOptions.map((opt) => ({
        value: opt.value,
        label: opt.label,
        searchText: opt.label,
        description: opt.description,
        icon: <GitBranchIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />,
      })),
    [branchOptions]
  );
  const mobileSheetBranchNode = showBranchSelector ? (
    <MobileInlinePicker<string>
      id="mobile-sheet-branch"
      key={branchSelectorKey}
      value={currentBranch}
      onChange={(value) => setCurrentBranch(value)}
      options={mobileSheetBranchOptions}
      disabled={isBranchDisabled}
      loading={contextType === 'local' ? loadingLocalGitState || runtimeInitializing : false}
      loadingText={t('chat.branchLoading', { defaultValue: 'Loading branches...' })}
      ariaLabel={t('chat.branchPlaceholder', 'Branch')}
      emptyText={t('chat.branchEmpty', { defaultValue: 'No branches found' })}
      searchable={mobileSheetBranchOptions.length > 5}
      searchPlaceholder={t('chat.branchSearchPlaceholder', { defaultValue: 'Search branches' })}
      triggerContent={
        <>
          <GitBranchIcon
            className="h-3.5 w-3.5 shrink-0 opacity-70"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="truncate">
            {currentBranchLabel ?? t('chat.branchPlaceholder', 'Branch')}
          </span>
        </>
      }
    />
  ) : null;

  /* Project and branch now live on their own rows in the new-chat
     sheet (see `MobileNewChatSheet` `perTypeNode` + `branchNode`
     slots), so the previous side-by-side wrapper is gone. The two
     nodes are passed individually to the sheet. */

  /* Local-only: workdir mode lives on its own row in the sheet as a
     pill switcher (本地文件 / 新工作树), matching the visual pattern of
     the type pill above. The desktop WorkdirModeSelector dropdown is too
     small to read at a glance on a phone and doesn't surface both
     options without an extra tap. */
  /* Workdir mode pills: icon+label as a tight group, centered in each
     equal-width segment (same affinity pattern as the Type ContextSwitch). */
  const mobileSheetWorkdirModePillTriggerClassName = cn(
    'flex-1 justify-center gap-1 rounded-md px-2 py-1 text-sm font-medium transition-all',
    'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs',
    'text-muted-foreground'
  );
  const mobileSheetWorkdirModeNode =
    contextType === 'local' && selectedLocalProject ? (
      <Tabs
        value={effectiveWorkdirMode}
        onValueChange={(value) => handleWorkdirModeChange(value as WorkdirMode)}
        className="w-full"
      >
        <TabsList className="flex h-10 w-full rounded-md bg-muted p-1">
          <TabsTrigger value="local" className={mobileSheetWorkdirModePillTriggerClassName}>
            <FolderIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('chat.mobileNewChat.workdirLocalLabel', '本地文件')}</span>
          </TabsTrigger>
          <TabsTrigger
            value="worktree"
            disabled={!worktreeAvailable}
            title={worktreeUnavailableReason}
            className={cn(
              mobileSheetWorkdirModePillTriggerClassName,
              !worktreeAvailable && 'cursor-not-allowed opacity-50'
            )}
          >
            <GitBranchIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('chat.mobileNewChat.workdirWorktreeLabel', '新工作树')}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
    ) : null;

  /* ── Composer footer: same MobileSessionRunConfig as the in-session
     composer (agent / model / reasoning / permission / Plan / Fast in one
     sheet). Usage stays in the footer; the old below-composer agent +
     permission + plan row is gone. */
  const mobileSheetFooterSelectorNode = (
    <ErrorBoundary
      name="MobileSheetFooterSelector"
      variant="inline"
      resetKeys={[workspaceId, selectedAgent?.agentId]}
      fallback={null}
    >
      <div className="flex w-full min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
        {/* flex-1 + overflow so the run-config button can shrink; only the
            model label inside it truncates. Usage stays full-width. */}
        <div className="min-w-0 flex-1 overflow-hidden">
          <MobileSessionRunConfig
            agentSelection={selectedAgent}
            allowedMachineIds={scopedMachineId ? [scopedMachineId] : []}
            agentLocked={false}
            onAgentConfigChange={setSelectedAgent}
            modelOptions={modelOptions}
            selectedModelId={selectedModelId}
            onModelChange={setSelectedModelName}
            modeOptions={modeOptions}
            selectedModeId={selectedModeId}
            onModeChange={setSelectedModeId}
            configOptionSelectors={configOptionSelectors}
            configOptionValues={configOptionValues}
            onConfigOptionChange={handleConfigOptionChange}
            fallbackAgent={{
              cliType: selectedConfig?.cliType,
              agentType: selectedConfig?.agentType,
            }}
            agentRoles={{
              items: composerAgentRoleItems,
              selectedRoleId: activeAgentRole?.id ?? null,
              onSelect: handleAgentRoleSelect,
              onCreate: handleAgentRoleCreate,
            }}
          />
        </div>
        <SessionUsagePopover
          rateLimits={selectedRateLimits}
          agentType={selectedConfig?.agentType ?? ''}
          modelId={selectedModelId}
          modelLabel={selectedModelLabel}
          showCodexResetForecast={showCodexResetForecast}
          showRateLimitWithoutContext
          className="h-8 shrink-0"
        />
      </div>
    </ErrorBoundary>
  );
  /* New-chat no longer needs a below-composer selector row — every run
     knob lives inside MobileSessionRunConfig. */
  const mobileSheetBelowComposerNode = null;

  /* Mobile-sheet Type row: same ContextSwitch as desktop. Icon+label are a
     tight centered pair inside each equal-width pill (not icon-left /
     label-centered, which broke icon–label affinity). */
  const mobileSheetContextSwitchNode = (
    <ContextSwitch
      value={contextType}
      onChange={setContextType}
      tone={tone}
      localLabel={t('chat.contextSwitch.localProjects', 'Local')}
      githubLabel={t('chat.contextSwitch.github', 'GitHub')}
      chatLabel={t('chat.contextSwitch.chat', 'Chat')}
      /* The mobile new-chat sheet is a compact launcher — empty Local/GitHub tabs must
         NOT carry the desktop's
         "Open project" / "Connect GitHub" affordance, whose onClick navigates
         away (and was firing on hover/click/Enter). Omit onClick so the tab
         stays plainly disabled with only an explanatory tooltip. */
      localDisabled={hasLocalProjects ? undefined : { label: localProjectSelectorEmptyText }}
      githubDisabled={
        !hasGitHubRepos
          ? {
              label: t(
                'chat.mobileHome.emptyGitHubProjects',
                '当前 workspace 没有已授权的 GitHub 仓库'
              ),
            }
          : undefined
      }
    />
  );

  // ── Hints ──
  const hasNoAgentConfig = executorConfigs.length === 0;
  const hintType: ChatLandingHintType = getChatLandingHintType({
    hasNoMachine,
    hasNoAgentConfig,
    isInitialDataLoading,
  });

  // Web/mobile users without any machine need the desktop client; send them to
  // the download page (localized) in their browser / external shell.
  const handleDownloadClient = () => {
    void openExternalUrl(getDownloadPageUrl(i18n.resolvedLanguage ?? i18n.language));
  };

  // Electron users already bundle the daemon; if it has not come up they can
  // report the problem to us straight from the hint.
  const handleReportBug = () => {
    setBugReportDialogOpen(true);
  };

  const handleGoToAgentSettings = () => {
    openSettings('agents');
  };

  // ── Mention source ──
  const isSelectedRepoPublic = useMemo(() => {
    if (!selectedRepo) return undefined;
    const repo = freshRepositories?.find((r) => r.fullName === selectedRepo);
    return repo ? !repo.private : undefined;
  }, [freshRepositories, selectedRepo]);
  const selectedLocalProjectGithubRepoFullName = useMemo(() => {
    if (contextType !== 'local') return undefined;
    return resolveLocalProjectGithubRepoFullName(activeLocalGitState, repositories) ?? undefined;
  }, [activeLocalGitState, contextType, repositories]);

  const preparationMachineId = useMemo(() => {
    if (!selectedAgent) return null;
    const candidateMachineId =
      selectedMachineId && isSelectedMachineValid
        ? selectedMachineId
        : contextType === 'local'
          ? (selectedLocalProject?.machineId ?? null)
          : null;
    return candidateMachineId === selectedAgent.machineId ? candidateMachineId : null;
  }, [
    contextType,
    isSelectedMachineValid,
    selectedAgent,
    selectedLocalProject?.machineId,
    selectedMachineId,
  ]);
  const preparationProject = useMemo<ProjectRef | undefined>(() => {
    if (contextType === 'chat') return undefined;
    if (contextType === 'github') {
      const branch = selectedBranch?.trim();
      if (!selectedRepo || !branch) return undefined;
      return { kind: 'github', repoFullName: selectedRepo, branch };
    }
    if (!selectedLocalProject || selectedLocalProject.machineId !== preparationMachineId) {
      return undefined;
    }
    const branch =
      effectiveWorkdirMode === 'worktree' ? selectedLocalBranch?.trim() || undefined : undefined;
    return {
      kind: 'local',
      localProjectId: selectedLocalProject.localProjectId,
      ...(branch ? { branch } : {}),
      ...(selectedLocalProjectGithubRepoFullName
        ? { githubRepoFullName: selectedLocalProjectGithubRepoFullName }
        : {}),
      ...(effectiveWorkdirMode === 'worktree' ? { useWorktree: true } : {}),
    };
  }, [
    contextType,
    effectiveWorkdirMode,
    preparationMachineId,
    selectedBranch,
    selectedLocalBranch,
    selectedLocalProject,
    selectedLocalProjectGithubRepoFullName,
    selectedRepo,
  ]);
  const preparationContextReady =
    contextType === 'chat' ||
    (contextType === 'github' && preparationProject?.kind === 'github') ||
    (contextType === 'local' && preparationProject?.kind === 'local');
  const preparationRunConfig = useMemo(
    () =>
      buildSessionPreparationRunConfig({
        modeId: modeOptions.length > 0 ? selectedModeId : null,
        modelId: modelOptions.length > 0 ? selectedModelId : null,
        configOptionValues: dispatchConfigOptionValues,
        mcpServerIds: mcpSelection.selectedIds,
        taskToolsEnabled: tasksFeatureEnabled,
      }),
    [
      dispatchConfigOptionValues,
      mcpSelection.selectedIds,
      modeOptions.length,
      modelOptions.length,
      selectedModeId,
      selectedModelId,
      tasksFeatureEnabled,
    ]
  );
  const { handoffToSession: handoffSessionPreparation } = useSessionPreparation({
    runtime,
    machineId: preparationMachineId,
    requestedByUserId: userId ?? null,
    agentConfigId: selectedConfig?.id ?? null,
    cliType: selectedConfig?.cliType ?? null,
    agentType: selectedConfig?.agentType ?? null,
    project: preparationProject,
    runConfig: preparationRunConfig,
    sessionId: draftSessionId,
    ensureSessionId: ensureDraftSessionId,
    enabled:
      preparationContextReady &&
      Boolean(
        runtime &&
        preparationMachineId &&
        userId &&
        selectedConfig &&
        (prompt.trim().length > 0 || imageItems.length > 0 || fileItems.length > 0)
      ),
    activityRevision: `${draftActivityRevision}:${imageItems.length}:${fileItems.length}`,
  });

  const mentionSource = useMemo(() => {
    if (contextType === 'chat') return undefined;
    if (contextType === 'local' && selectedLocalProject && workspaceId) {
      return {
        kind: 'local' as const,
        machineId: selectedLocalProject.machineId,
        workspaceId,
        localProjectId: selectedLocalProject.localProjectId,
        githubRepoFullName: selectedLocalProjectGithubRepoFullName,
      };
    }
    return { kind: 'github' as const, repoFullName: selectedRepo, isPublic: isSelectedRepoPublic };
  }, [
    contextType,
    isSelectedRepoPublic,
    selectedLocalProject,
    selectedLocalProjectGithubRepoFullName,
    selectedRepo,
    workspaceId,
  ]);
  const expandSkillMentionsForPrompt = useMentionPromptExpansion({
    source: mentionSource,
    skillAgent,
    promptValue: prompt,
  });
  const promptPlaceholder = t(
    getChatComposerPromptPlaceholderKey({ mentionSource, availableCommands, skillAgent })
  );
  const issuePrRepoFullName =
    contextType === 'local' ? selectedLocalProjectGithubRepoFullName : selectedRepo;
  const issuePrRepoIsPublic = contextType === 'github' ? isSelectedRepoPublic : undefined;

  const { knownItems: knownIssuePrItems } = useKnownIssuePrItems(
    issuePrRepoFullName,
    issuePrRepoIsPublic
  );

  const hasSendableContent = prompt.trim().length > 0 || hasUploadedImages || hasUploadedFiles;
  const submitDisabled = getChatLandingSubmitDisabled({
    submitting,
    hasBlockingImages,
    hasBlockingFiles,
    hasSendableContent,
    contextType,
    workdirMode: selectedWorkdirMode,
    hasSelectedLocalProject: Boolean(selectedLocalProject),
    isRuntimeInitializing: runtimeInitializing,
    isLoadingLocalGitState: loadingLocalGitState,
    hasLocalGitStateError: Boolean(localGitStateError),
  });
  const selectedMachineHasVisibleLocalProject = useMemo(
    () =>
      selectedMachineId ? getFirstVisibleLocalProjectForMachine(selectedMachineId) !== null : false,
    [selectedMachineId, getFirstVisibleLocalProjectForMachine]
  );
  const selectedMachineProjectStatus = getChatLandingSelectedMachineProjectStatus({
    contextType,
    selectedMachineId,
    hasSelectedLocalProject: Boolean(selectedLocalProject),
    hasAnyVisibleLocalProject: visibleLocalProjectMap.size > 0,
    selectedMachineHasVisibleLocalProject,
    isVisibleLocalProjectsLoading: visibleLocalProjectsLoading,
    isDocMetaCacheReady: docMetaCacheReady,
  });
  const selectedMachineProjectStatusMessage =
    selectedMachineProjectStatus === null
      ? null
      : t(
          getEmptyLocalProjectsMessageKey(
            selectedMachineProjectStatus === 'no-projects-on-selected-machine'
          )
        );
  const visibleComposerStatus = getChatLandingVisibleComposerStatus({
    contextType,
    composerStatus,
    localGitStateError,
    selectedMachineProjectStatus: selectedMachineProjectStatusMessage
      ? { message: selectedMachineProjectStatusMessage, tone: 'warning' }
      : null,
  });

  // ── Title ──
  // Rotate the landing heading once per (UTC) day: stable within a day, no
  // flicker across re-renders, no Math.random().
  const headings = [t('chat.heading'), t('chat.heading2')];
  const title = headings[Math.floor(getServerNow() / 86_400_000) % headings.length];
  const mobileHomeMachines = useMemo<MobileHomeMachine[]>(() => {
    return Array.from(machines.entries())
      .map(([machineId, machine]) => ({
        id: machineId,
        name: machine.name,
        isOnline: onlineMachineIds.has(machineId),
        isPrivate: showProjectSharing && accessByMachineId.get(machineId)?.sharedWithTeam === false,
      }))
      .sort((left, right) => {
        if (left.isOnline !== right.isOnline) {
          return left.isOnline ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
  }, [accessByMachineId, onlineMachineIds, machines, showProjectSharing]);
  /* The mobile-home machine pill bar was dropped — rows now group by
     machine via sticky section headings, so we just hand the full list
     of online / known machines straight through. No filter state, no
     `全部` chip. */
  const mobileHomeWorkspace = useMemo(
    () => ({
      id: activeOrganization?.id ?? workspaceId ?? workspaceSlug,
      name: activeOrganization?.name ?? workspaceSlug,
      avatarUrl: resolveWorkspaceIdentityLogo(activeOrganization?.logo, multiWorkspaceAvailable),
    }),
    [
      activeOrganization?.id,
      activeOrganization?.logo,
      activeOrganization?.name,
      multiWorkspaceAvailable,
      workspaceId,
      workspaceSlug,
    ]
  );
  const mobileHomeWorkspaceOptions = useMemo(
    () =>
      (organizations ?? []).map((organization) => ({
        id: organization.id,
        name: organization.name,
        avatarUrl: resolveWorkspaceIdentityLogo(organization.logo, multiWorkspaceAvailable),
        isActive: organization.id === activeOrganization?.id,
      })),
    [activeOrganization?.id, multiWorkspaceAvailable, organizations]
  );
  const localProjectSessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of visibleSessions) {
      const key = getSessionLocalProjectKey(session);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [visibleSessions]);
  /* Per-local-project aggregates that drive the trailing slot on the
     mobile home row: the freshest message timestamp across the project's
     sessions (semantic age label) and the count of sessions with
     unread messages (badge). */
  const localProjectActivity = useMemo(() => {
    const latest = new Map<string, number>();
    const unread = new Map<string, number>();
    for (const session of visibleSessions) {
      const key = getSessionLocalProjectKey(session);
      if (!key) continue;
      if (typeof session.lastMessageAt === 'number' && Number.isFinite(session.lastMessageAt)) {
        const prev = latest.get(key) ?? 0;
        if (session.lastMessageAt > prev) latest.set(key, session.lastMessageAt);
        const isUnread =
          typeof session.lastReadAt !== 'number' || session.lastMessageAt > session.lastReadAt;
        if (isUnread) unread.set(key, (unread.get(key) ?? 0) + 1);
      }
    }
    return { latest, unread };
  }, [visibleSessions]);
  const mobileHomeLocalProjects = useMemo<MobileHomeLocalProject[]>(() => {
    const availableProjects = Array.from(visibleLocalProjectMap.values()).map((entry) => {
      const latestMessageAt = localProjectActivity.latest.get(entry.key) ?? null;
      return { entry, latestMessageAt, removalState: null };
    });
    const pendingProjects = Array.from(pendingLocalProjectRemovals.values()).flatMap((pending) => {
      const machine = machines.get(pending.machineId);
      if (!machine) return [];
      return [
        {
          entry: {
            key: pending.key,
            machineId: pending.machineId,
            machine,
            project: pending.project,
            isMachineRegistered: true,
          },
          latestMessageAt: localProjectActivity.latest.get(pending.key) ?? null,
          removalState: onlineMachineIds.has(pending.machineId)
            ? ('removing' as const)
            : ('waiting_for_device' as const),
        },
      ];
    });
    const projectsByKey = new Map(
      [...availableProjects, ...pendingProjects].map((project) => [project.entry.key, project])
    );
    return Array.from(projectsByKey.values())
      .sort((left, right) =>
        compareChatLandingLocalProjectByRecency(
          left.entry,
          right.entry,
          localProjectActivity.latest
        )
      )
      .map(({ entry, latestMessageAt, removalState }) => ({
        id: entry.key,
        machineId: entry.machineId,
        name: entry.project.name,
        path: entry.project.rootPath,
        conversationCount: localProjectSessionCounts.get(entry.key) ?? 0,
        latestMessageAt,
        unreadCount: localProjectActivity.unread.get(entry.key) ?? 0,
        removalState,
        isPrivate:
          showProjectSharing &&
          (accessByMachineId.get(entry.machineId)?.sharedWithTeam !== true ||
            visibleLocalProjectAccess.get(entry.key)?.sharedWithTeam !== true),
      }));
  }, [
    accessByMachineId,
    localProjectActivity,
    localProjectSessionCounts,
    machines,
    onlineMachineIds,
    pendingLocalProjectRemovals,
    showProjectSharing,
    visibleLocalProjectAccess,
    visibleLocalProjectMap,
  ]);
  const githubRepositorySessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of visibleSessions) {
      const repoFullName = getSessionGitHubRepoFullName(session);
      if (!repoFullName) continue;
      counts.set(repoFullName, (counts.get(repoFullName) ?? 0) + 1);
    }
    return counts;
  }, [visibleSessions]);
  const githubRepositoryLatestMessageAt = mobileSheetRecency.byRepo;
  /* Unread-session count per repository — drives the row's trailing
     badge. Mirrors `localProjectActivity.unread` semantics: a session
     is unread when `lastMessageAt` is newer than `lastReadAt` (or
     `lastReadAt` is missing entirely). */
  const githubRepositoryUnreadCount = useMemo(() => {
    const unread = new Map<string, number>();
    for (const session of visibleSessions) {
      const repoFullName = getSessionGitHubRepoFullName(session);
      if (!repoFullName) continue;
      if (typeof session.lastMessageAt !== 'number') continue;
      const isUnread =
        typeof session.lastReadAt !== 'number' || session.lastMessageAt > session.lastReadAt;
      if (!isUnread) continue;
      unread.set(repoFullName, (unread.get(repoFullName) ?? 0) + 1);
    }
    return unread;
  }, [visibleSessions]);
  const mobileHomeGitHubRepositories = useMemo<MobileHomeGitHubRepository[]>(() => {
    /* Flat list sorted newest-first by latest message; repos with no
       chats fall to the end, alphabetical by `owner/name`. Owner
       avatars come from `getGitHubOwnerAvatarUrl` (CORS-fetchable so
       they can be blob-cached for offline). */
    const rows: MobileHomeGitHubRepository[] = [];
    for (const repository of repositories ?? []) {
      const ownerHandle = getGitHubOwnerHandle(repository.fullName);
      const repoDescription =
        'description' in repository && typeof repository.description === 'string'
          ? repository.description
          : null;
      rows.push({
        id: repository.fullName,
        name: getGitHubRepoName(
          repository.fullName,
          'name' in repository && typeof repository.name === 'string' ? repository.name : undefined
        ),
        fullName: repository.fullName,
        ownerHandle,
        ownerAvatarUrl: getGitHubOwnerAvatarUrl(ownerHandle),
        description: repoDescription,
        conversationCount: githubRepositorySessionCounts.get(repository.fullName) ?? 0,
        latestMessageAt: githubRepositoryLatestMessageAt.get(repository.fullName) ?? null,
        unreadCount: githubRepositoryUnreadCount.get(repository.fullName) ?? 0,
      });
    }
    rows.sort((left, right) =>
      compareChatLandingRepositoryByRecency(left, right, githubRepositoryLatestMessageAt)
    );
    return rows;
  }, [
    githubRepositoryLatestMessageAt,
    githubRepositorySessionCounts,
    githubRepositoryUnreadCount,
    repositories,
  ]);

  const mobileHomeRecentLocalProjects = useMemo<MobileHomeRecentLocalProject[]>(() => {
    return Array.from(visibleLocalProjectMap.values())
      .filter((entry) => mobileSheetRecency.byProject.has(entry.key))
      .sort((left, right) =>
        compareChatLandingLocalProjectByRecency(left, right, mobileSheetRecency.byProject)
      )
      .slice(0, 5)
      .map((entry) => ({
        id: entry.key,
        name: entry.project.name,
        path: entry.project.rootPath,
        machineName: machines.get(entry.machineId)?.name,
        latestActivityAt: mobileSheetRecency.byProject.get(entry.key) ?? null,
      }));
  }, [machines, mobileSheetRecency, visibleLocalProjectMap]);

  /* "最近常用" strip for the GitHub tab — up to 5 repos with the
     freshest chat activity. Sources from the same flat list the tab
     itself renders, so the recents stay consistent with the main
     list's sort. */
  const mobileHomeRecentGitHubRepos = useMemo<MobileHomeRecentRepo[]>(() => {
    return mobileHomeGitHubRepositories
      .filter((repo) => repo.latestMessageAt != null)
      .slice(0, 5)
      .map((repo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.fullName,
        ownerHandle: repo.ownerHandle,
        avatarUrl: repo.ownerAvatarUrl ?? null,
        latestActivityAt: repo.latestMessageAt ?? null,
      }));
  }, [mobileHomeGitHubRepositories]);

  /* Chats grouped per machine via sticky section headings on the home
     screen. The Chat tab surfaces ONLY chat-context sessions (no
     local-project, no github-repo association); project-bound chats
     live behind the project rows on the Local + GitHub tabs. Cap at a
     generous 200 — anything older isn't reasonably reachable from the
     home tab. */
  /* Mobile home Chat-tab filter state. Persisted to localStorage via
     atoms so the user's filter / view-mode choices survive navigation
     + refresh + app restart. Stored as EXCLUDED sets (vs the more
     obvious "selected" sets) so a newly-discovered machine or future
     kind/status enum value is included by default — the user has to
     explicitly opt-out. `chatScope` (my / team) is the existing
     cross-surface atom — we reuse it so a scope choice made on
     desktop carries to mobile and vice versa. */
  const [chatScope, setChatScope] = useAtom(chatScopeAtom);
  const [storedChatViewMode, setChatViewMode] = useAtom(mobileHomeChatViewModeAtom);
  /* Coerce stored value into Project | Date. Older builds stored
     'none' / 'type' / 'pr-status' / 'running-status'; anything other
     than 'date' becomes 'project' (No Group is no longer offered). */
  const chatViewMode: MobileChatGroupBy = storedChatViewMode === 'date' ? 'date' : 'project';
  /* Drives the mobile home's connection-status banner. Mirrors the
     desktop sidebar's `ConnectionPill` data source so users see the
     same reconnecting state regardless of platform. */
  const mobileHomeConnectionUiState = useAtomValue(lodyConnectionUiStateAtom);
  const [chatExcludedRepos, setChatExcludedRepos] = useMobileHomeExcludedSetAtom<string>(
    mobileHomeChatExcludedReposAtom
  );
  const [chatExcludedProjects, setChatExcludedProjects] = useMobileHomeExcludedSetAtom<string>(
    mobileHomeChatExcludedProjectsAtom
  );
  const [chatExcludedRunning, setChatExcludedRunning] = useMobileHomeExcludedSetAtom<string>(
    mobileHomeChatExcludedRunningAtom
  );
  const [chatExcludedPr, setChatExcludedPr] = useMobileHomeExcludedSetAtom<string>(
    mobileHomeChatExcludedPrAtom
  );
  const [chatExcludedMachines, setChatExcludedMachines] = useMobileHomeExcludedSetAtom<MachineId>(
    mobileHomeChatExcludedMachinesAtom
  );
  /* Whether any of the chat content filters (the aggregate-pill
     exclusion sets) are active. Scope/view are deliberate view choices,
     not "filters", so they're excluded here — mirrors what the filter
     drawer's "clear all" resets. Drives the empty-state "Clear filters"
     affordance below. */
  const hasActiveChatFilters =
    chatExcludedRepos.size > 0 ||
    chatExcludedProjects.size > 0 ||
    chatExcludedRunning.size > 0 ||
    chatExcludedPr.size > 0 ||
    chatExcludedMachines.size > 0;
  const handleClearChatFilters = useCallback(() => {
    setChatExcludedRepos(new Set());
    setChatExcludedProjects(new Set());
    setChatExcludedRunning(new Set());
    setChatExcludedPr(new Set());
    setChatExcludedMachines(new Set());
  }, [
    setChatExcludedRepos,
    setChatExcludedProjects,
    setChatExcludedRunning,
    setChatExcludedPr,
    setChatExcludedMachines,
  ]);
  /* Per-surface "show archived" toggle. Transient (not persisted): we
     want each fresh visit to default to active conversations, archived
     mode is an explicit user gesture for the current session only. The
     home and project surfaces have independent flags so toggling on
     one doesn't leak into the other. */
  const [mobileHomeShowArchived, setMobileHomeShowArchived] = useState(false);
  const [mobileProjectShowArchived, setMobileProjectShowArchived] = useState(false);

  /* Member lookup table for the conversation row's owner avatar. The
     row only renders the avatar when the chat scope is 'team' (i.e.
     the user is viewing everyone's sessions and needs the "who
     created this" cue); in 'my' scope we return `null` here to skip
     the work + the row's JSX entirely. Mirrors the desktop sidebar's
     pattern (see `session-list-rows.ts`). */
  const teamMembersByUserId = useMemo(() => {
    if (chatScope !== 'team') return null;
    const members = activeOrganization?.members ?? [];
    const map = new Map<string, { id: string; name?: string | null; image?: string | null }>();
    for (const member of members) {
      map.set(member.userId, {
        id: member.userId,
        name: member.user?.name ?? null,
        image: member.user?.image ?? null,
      });
    }
    return map;
  }, [activeOrganization?.members, chatScope]);
  const mobileChildSessionsByParent = useMemo(
    () => buildChildSessionsByParent(visibleAllActiveSessions),
    [visibleAllActiveSessions]
  );
  /* Precise opener id -> the LIST ROW to nest under. Needs the full active list
     (child Tabs included), because a Tab that called `lody_session_create` has
     no row of its own and the created Session must nest under the Tab's root.
     Same resolver the desktop sidebar lists use — see
     `sessions/session-list-rows.ts`. */
  const mobileOpenerRowResolver = useMemo(
    () => buildSidebarOpenerRowResolver(visibleAllActiveSessions),
    [visibleAllActiveSessions]
  );

  /* Mobile home Chat tab — every non-archived conversation across the
     workspace (local + GitHub + chat-only), sorted newest-first, in
     the same `MobileConversationItem` shape used by the in-project
     page. Filters are applied in two phases: scope + machine at the
     session level (before mapping), kind / running / PR at the item
     level (so the predicate reads from the same field accessors the
     grouping logic uses). Cap at 200. */
  const mobileHomeChats = useMemo<MobileConversationItem[]>(() => {
    const myUserId = userId ?? null;
    /* `sessionListAtom` and `archivedSessionListAtom` live in
       different jotai atoms (see `atoms/doc-meta.ts`) — the active
       list excludes archived items and vice versa. Pick the right
       source based on the toggle; the per-item predicates below stay
       the same so scope / machine / kind filters work in both views. */
    const sourceSessions = mobileHomeShowArchived ? visibleArchivedSessions : visibleSessions;
    const activityCache = new Map<
      SessionId,
      ReturnType<typeof getEffectiveSessionActivitySummary>
    >();
    const getSessionActivity = (session: (typeof sourceSessions)[number]) => {
      const cached = activityCache.get(session.id);
      if (cached) return cached;
      const activity = getEffectiveSessionActivitySummary(
        session,
        mobileChildSessionsByParent,
        liveSessionStatuses
      );
      activityCache.set(session.id, activity);
      return activity;
    };
    return sourceSessions
      .filter((session) => {
        if (chatScope === 'my' && myUserId && session.userId !== myUserId) return false;
        if (chatExcludedMachines.has(session.machineId)) return false;
        return true;
      })
      .sort((left, right) => {
        /* Pinned-first, then most-recent. Mirrors the desktop sidebar's
           sort (see `task-list.tsx` `sortTasks`) so a pinned chat stays
           anchored at the top regardless of when it was last touched. */
        const leftPinned = left.isPinned ? 1 : 0;
        const rightPinned = right.isPinned ? 1 : 0;
        if (leftPinned !== rightPinned) return rightPinned - leftPinned;
        const leftTime = getSessionActivity(left).latestMessageAt;
        const rightTime = getSessionActivity(right).latestMessageAt;
        return rightTime - leftTime;
      })
      .slice(0, 200)
      .map<MobileConversationItem>((session) => {
        const prInfo = getLatestPullRequestInfo(session);
        const activity = getSessionActivity(session);
        const latestMessageAt =
          Number.isFinite(activity.latestMessageAt) && activity.latestMessageAt > 0
            ? activity.latestMessageAt
            : null;
        const diffStats = session.diffStats ?? { allChange: { add: 0, del: 0 } };
        const isOnline = onlineMachineIds.has(session.machineId);
        const repoFullName = getSessionGitHubRepoFullName(session);
        const localProjectKey = getSessionLocalProjectKey(session);
        const kind: MobileConversationKind = repoFullName
          ? 'github'
          : localProjectKey
            ? 'local'
            : 'chat';
        /* Project key + label feed both the "filter by project" pill
           AND the "Group: Project" view mode. Use the same field for
           both so the filter selection and bucket key never drift
           apart. Local project label falls back to its row's project
           name from `visibleLocalProjectMap`; repo label is the
           fullName itself ("owner/repo"). */
        let projectKey: string | null = null;
        let projectLabel: string | null = null;
        let projectAvatarUrl: string | null = null;
        if (repoFullName) {
          projectKey = repoFullName;
          projectLabel = repoFullName;
          /* Owner avatar synthesized from the handle (see
             `getGitHubOwnerAvatarUrl`) — saves us from threading the
             workspace repos list through here just to look up a URL. */
          const ownerHandle = repoFullName.split('/')[0];
          if (ownerHandle) {
            projectAvatarUrl = getGitHubOwnerAvatarUrl(ownerHandle);
          }
        } else if (localProjectKey) {
          projectKey = localProjectKey;
          projectLabel =
            visibleLocalProjectMap.get(localProjectKey)?.project.name ?? localProjectKey;
        }
        return {
          id: session.id,
          title: session.title?.trim() || t('sessions.untitled', 'Untitled session'),
          kind,
          branchName: session.branchName?.trim() || null,
          prNumber: prInfo.number,
          prStatus: prInfo.status,
          /* PR url + CI rollup + readiness drive the row's PR status icon and
             its Mergeable pill, exactly as the desktop sidebar row does
             (`getLatestPullRequestInfo` is the shared source for both). */
          prUrl: prInfo.url,
          prCiState: prInfo.ciState,
          prReadiness: prInfo.readiness,
          addedLines: diffStats.allChange.add,
          deletedLines: diffStats.allChange.del,
          latestMessageAt,
          ageLabel: formatMobileAgeLabel(
            latestMessageAt ?? session.lastMessageAt ?? session.createdAt
          ),
          isWorking: activity.isWorking,
          isWaitingPermission: activity.isWaitingPermission,
          isOffline: !isOnline,
          hasUnreadMessages: activity.hasUnreadMessages,
          isPinned: Boolean(session.isPinned),
          machineId: session.machineId,
          /* Provenance for the list's opened-by tree. TWO fields, never
             merged: the precise opener drives navigation, the row id drives
             nesting. See `lib/session-opened-by-tree.ts`. */
          openedBySessionId: session.openedBySessionId ?? null,
          openedByRowSessionId:
            session.openedByRootSessionId ??
            mobileOpenerRowResolver(session.openedBySessionId) ??
            session.openedBySessionId ??
            null,
          projectKey,
          projectLabel,
          projectAvatarUrl,
          isPrivateProject:
            showProjectSharing && kind === 'local' && localProjectKey
              ? accessByMachineId.get(session.machineId)?.sharedWithTeam !== true ||
                visibleLocalProjectAccess.get(localProjectKey)?.sharedWithTeam !== true
              : false,
          /* Worktree glyph only meaningful for local-project sessions;
             GitHub rows already use the owner avatar as their leading icon. */
          isWorktree: kind === 'local' && session.isWorktree === true,
          /* Owner avatar is populated only in team scope (mirrors the
             desktop sidebar): in 'my' scope every row is the current
             user so the avatar is redundant noise; in 'team' scope
             the avatar tells you who started the session. Falls back
             to a minimal { id } stub when the member isn't in the
             org's members list (handles departed-member sessions
             without breaking the row). */
          owner:
            teamMembersByUserId != null && session.userId
              ? (teamMembersByUserId.get(session.userId) ?? { id: session.userId })
              : undefined,
        };
      })
      .filter((item) => {
        /* Filter by repo OR project depending on what the
           conversation has. Chat-only sessions (no project) always
           pass — neither pill applies to them. */
        if (item.kind === 'github' && item.projectKey && chatExcludedRepos.has(item.projectKey)) {
          return false;
        }
        if (item.kind === 'local' && item.projectKey && chatExcludedProjects.has(item.projectKey)) {
          return false;
        }
        if (chatExcludedRunning.has(runningBucketIdFor(item))) return false;
        if (chatExcludedPr.has(prBucketIdFor(item))) return false;
        return true;
      });
  }, [
    accessByMachineId,
    chatExcludedMachines,
    chatExcludedPr,
    chatExcludedProjects,
    chatExcludedRepos,
    chatExcludedRunning,
    chatScope,
    mobileChildSessionsByParent,
    mobileOpenerRowResolver,
    liveSessionStatuses,
    mobileHomeShowArchived,
    onlineMachineIds,
    showProjectSharing,
    t,
    teamMembersByUserId,
    userId,
    visibleArchivedSessions,
    visibleLocalProjectAccess,
    visibleLocalProjectMap,
    visibleSessions,
  ]);

  /* Pill bar config for the Chat tab. Multi-select pills model state
     as EXCLUDED sets: `selectedIds = (allOptionIds − excluded)` and
     `defaultIds = allOptionIds`, so the "filter applied" dot appears
     exactly when the user has opted any option out. */
  const chatFilterPills = useMemo<FilterPill[]>(() => {
    const allRunning = ['working', 'waiting', 'idle', 'offline'] as const;
    const allPr = ['open', 'draft', 'merged', 'closed', 'no-pr'] as const;
    const machineOptions = mobileHomeMachines.map((machine) => ({
      id: machine.id,
      label: machine.name,
    }));
    const allMachineIds = machineOptions.map((m) => m.id);

    /* Repo + project options: each available repo / local project
       becomes one row in the multi-select. Sort matches the new-chat
       picker recency (most-recent activity first via
       `mobileSheetRecency`) so the user finds the project they were
       just working in at the top. */
    const repoOptions = [...(repositories ?? [])]
      .sort((a, b) => compareChatLandingRepositoryByRecency(a, b, mobileSheetRecency.byRepo))
      .map((repo) => ({ id: repo.fullName, label: repo.fullName }));
    const allRepoIds = repoOptions.map((r) => r.id);
    /* Local-project filter: group by machine, recency-sort within
       each group, machines themselves ordered by their freshest
       project. Each option carries:
         - `description`: project root path (smaller subtitle)
         - `group`: machine name (renders as a section heading
           above the first project of that machine)
       The pill-bar renderer expects options pre-sorted by group;
       it just inserts the heading the moment `group` changes. */
    const projectEntries = [...visibleLocalProjectMap.values()];
    const projectRecencyOf = (entry: (typeof projectEntries)[number]) =>
      mobileSheetRecency.byProject.get(entry.key);
    const machineRecency = new Map<string, number>();
    for (const entry of projectEntries) {
      const ts = projectRecencyOf(entry);
      if (ts === undefined) continue;
      const prev = machineRecency.get(entry.machineId) ?? 0;
      if (ts > prev) machineRecency.set(entry.machineId, ts);
    }
    const sortedProjectEntries = projectEntries.sort((left, right) => {
      const leftMachineTs = machineRecency.get(left.machineId);
      const rightMachineTs = machineRecency.get(right.machineId);
      if (
        leftMachineTs !== undefined &&
        rightMachineTs !== undefined &&
        leftMachineTs !== rightMachineTs
      ) {
        return rightMachineTs - leftMachineTs;
      }
      if (leftMachineTs !== undefined && rightMachineTs === undefined) return -1;
      if (leftMachineTs === undefined && rightMachineTs !== undefined) return 1;
      if (left.machineId !== right.machineId) {
        return (left.machine.name || left.machineId).localeCompare(
          right.machine.name || right.machineId
        );
      }
      return compareChatLandingLocalProjectByRecency(left, right, mobileSheetRecency.byProject);
    });
    const projectOptions = sortedProjectEntries.map((entry) => ({
      id: entry.key,
      label: entry.project.name,
      description: entry.project.rootPath,
      group: entry.machine.name?.trim() || entry.machineId,
    }));
    const allProjectIds = projectOptions.map((p) => p.id);

    const invertSelection = <T extends string>(
      universe: ReadonlyArray<T>,
      next: ReadonlySet<string>
    ): Set<T> => {
      const excluded = new Set<T>();
      for (const id of universe) if (!next.has(id)) excluded.add(id);
      return excluded;
    };

    /* All multi-select dimensions live inside a single "Filters"
       aggregate pill (drawer) so the chip row stays scannable on
       narrow phones. The "type" filter dropped out in favor of
       narrower repo + project filters — users almost always want
       "show this repo's tasks" rather than "show all GitHub tasks". */
    const multiPills: MultiSelectPill[] = [
      ...(repoOptions.length > 0
        ? ([
            {
              kind: 'multi',
              id: 'repo',
              label: t('chat.mobileHome.filters.repo.label', 'Repository'),
              options: repoOptions,
              defaultIds: new Set<string>(allRepoIds),
              selectedIds: new Set<string>(allRepoIds.filter((id) => !chatExcludedRepos.has(id))),
              onChange: (next) => setChatExcludedRepos(invertSelection(allRepoIds, next)),
            },
          ] satisfies MultiSelectPill[])
        : []),
      ...(projectOptions.length > 0
        ? ([
            {
              kind: 'multi',
              id: 'project',
              label: t('chat.mobileHome.filters.project.label', 'Project'),
              options: projectOptions,
              defaultIds: new Set<string>(allProjectIds),
              selectedIds: new Set<string>(
                allProjectIds.filter((id) => !chatExcludedProjects.has(id))
              ),
              onChange: (next) => setChatExcludedProjects(invertSelection(allProjectIds, next)),
            },
          ] satisfies MultiSelectPill[])
        : []),
      {
        kind: 'multi',
        id: 'running',
        label: t('chat.mobileHome.filters.running.label', '状态'),
        options: [
          { id: 'working', label: t('chat.mobileHome.filters.running.working', '运行中') },
          { id: 'waiting', label: t('chat.mobileHome.filters.running.waiting', '等待权限') },
          { id: 'idle', label: t('chat.mobileHome.filters.running.idle', '空闲') },
          { id: 'offline', label: t('chat.mobileHome.filters.running.offline', '离线') },
        ],
        defaultIds: new Set<string>(allRunning),
        selectedIds: new Set<string>(allRunning.filter((s) => !chatExcludedRunning.has(s))),
        onChange: (next) => setChatExcludedRunning(invertSelection([...allRunning], next)),
      },
      {
        kind: 'multi',
        id: 'pr',
        label: t('chat.mobileHome.filters.pr.label', 'PR'),
        options: [
          { id: 'open', label: t('chat.mobileHome.filters.pr.open', 'Open') },
          { id: 'draft', label: t('chat.mobileHome.filters.pr.draft', 'Draft') },
          { id: 'merged', label: t('chat.mobileHome.filters.pr.merged', 'Merged') },
          { id: 'closed', label: t('chat.mobileHome.filters.pr.closed', 'Closed') },
          { id: 'no-pr', label: t('chat.mobileHome.filters.pr.noPr', '无 PR') },
        ],
        defaultIds: new Set<string>(allPr),
        selectedIds: new Set<string>(allPr.filter((s) => !chatExcludedPr.has(s))),
        onChange: (next) => setChatExcludedPr(invertSelection([...allPr], next)),
      },
      ...(machineOptions.length > 1
        ? ([
            {
              kind: 'multi',
              id: 'machine',
              label: t('chat.mobileHome.filters.machine.label', '机器'),
              options: machineOptions,
              defaultIds: new Set<string>(allMachineIds),
              selectedIds: new Set<string>(
                allMachineIds.filter((id) => !chatExcludedMachines.has(id as MachineId))
              ),
              onChange: (next) =>
                setChatExcludedMachines(
                  invertSelection(allMachineIds as MachineId[], next) as Set<MachineId>
                ),
            },
          ] satisfies MultiSelectPill[])
        : []),
    ];

    return [
      {
        /* `chatScope` is the existing 'my' | 'team' atom — desktop
           and mobile share semantics. Labels read as "Team Tasks" /
           "My Tasks" to make the scope split unambiguous; "All" was
           ambiguous between "all-tasks-visible-to-me" and "across
           the whole team". */
        kind: 'single',
        id: 'scope',
        fallbackLabel: t('chat.mobileHome.filters.scope.all', 'Team Tasks'),
        options: [
          { id: 'team', label: t('chat.mobileHome.filters.scope.all', 'Team Tasks') },
          { id: 'my', label: t('chat.mobileHome.filters.scope.my', 'My Tasks') },
        ],
        selectedId: chatScope === 'my' ? 'my' : 'team',
        onSelect: (id) => setChatScope(id === 'my' ? 'my' : 'team'),
      },
      {
        kind: 'single',
        id: 'view',
        fallbackLabel: t('chat.mobileHome.filters.view.byProject', 'Group: Project'),
        options: [
          { id: 'project', label: t('chat.mobileHome.filters.view.byProject', 'Group: Project') },
          { id: 'date', label: t('chat.mobileHome.filters.view.byDate', 'Group: Date') },
        ],
        selectedId: chatViewMode,
        onSelect: (id) => setChatViewMode(id === 'date' ? 'date' : 'project'),
      },
      {
        kind: 'aggregate',
        id: 'filters',
        label: t('chat.mobileHome.filters.aggregateLabel', 'Filters'),
        pills: multiPills,
      },
    ];
  }, [
    chatExcludedMachines,
    chatExcludedPr,
    chatExcludedProjects,
    chatExcludedRepos,
    chatExcludedRunning,
    chatScope,
    chatViewMode,
    mobileHomeMachines,
    mobileSheetRecency,
    repositories,
    setChatExcludedMachines,
    setChatExcludedPr,
    setChatExcludedProjects,
    setChatExcludedRepos,
    setChatExcludedRunning,
    setChatScope,
    setChatViewMode,
    t,
    visibleLocalProjectMap,
  ]);
  /* Mobile home tab + projects sub-tab.

     The dock now has THREE tabs: Inbox (leftmost, placeholder), Chat,
     and 项目 (which merges Local + GitHub via an inner sub-tab). The
     Local-vs-GitHub split lives in `mobileHomeProjectsSubTabAtom`
     (persisted to localStorage so a Chat/Inbox ↔ Projects round-trip
     remembers which side the user was on).

     `selectedMobileHomeTab` is decoupled from `contextType` for write
     purposes — the new-chat sheet mutates `contextType` for its own
     selectors and must not flip the home page underneath the user.
     Initial value derives once from URL preselection first; otherwise
     mobile opens on Chat:
       explicit chat context                         → home tab 'chat'
       explicit local/github context or project URL  → home tab 'projects'
       no explicit mobile preselection               → home tab 'chat'
       desktop resize fallback                       → current contextType
     Inbox is never URL-initialized (it's not a context type); the user
     can only land on it by tapping the dock chip. Explicit taps update
     via `handleMobileHomeTabSelect` /
     `handleMobileHomeProjectsSubTabSelect`. */
  const [persistedProjectsSubTab, setPersistedProjectsSubTab] = useAtom(
    mobileHomeProjectsSubTabAtom
  );
  const [selectedMobileHomeTab, setSelectedMobileHomeTab] = useState<MobileHomeTab>(() => {
    if (preSelectedContext === 'chat') return 'chat';
    const hasProjectPreselection = Boolean(
      preSelectedRepo || (preSelectedMachine && preSelectedProject)
    );
    if (
      preSelectedContext === 'local' ||
      preSelectedContext === 'github' ||
      hasProjectPreselection
    ) {
      return 'projects';
    }
    if (isMobile) return 'chat';
    return contextType === 'chat' ? 'chat' : 'projects';
  });
  /* Developer-only beta gates drive the extra dock tabs on mobile home.
     When a gate is off, a stale selection must render as Chat — as if
     the tab were never built. Inbox also retains its team-workspace gate. */
  const inboxFeatureEnabled = useAtomValue(inboxFeatureEnabledAtom);
  const showMobileInbox = showProjectSharing && inboxFeatureEnabled;
  const effectiveMobileHomeTab: MobileHomeTab =
    (selectedMobileHomeTab === 'tasks' && !tasksFeatureEnabled) ||
    (selectedMobileHomeTab === 'inbox' && !showMobileInbox)
      ? 'chat'
      : selectedMobileHomeTab;
  useEffect(() => {
    if (!showMobileInbox && selectedMobileHomeTab === 'inbox') {
      setSelectedMobileHomeTab('chat');
    }
  }, [selectedMobileHomeTab, showMobileInbox]);
  const mobileInboxItems = useMemo<MobileInboxItem[]>(
    () =>
      (inboxRows ?? [])
        .filter(
          (item) =>
            item.kind !== 'sharing_review' ||
            (sharingReviewState.ready && sharingReviewState.active)
        )
        .map((item) => {
          if (item.kind === 'sharing_review') {
            const privateCount =
              sharingReviewState.privateMachineCount + sharingReviewState.privateProjectCount;
            return {
              id: item._id,
              kind: item.kind,
              title: t('inbox.sharingReview.title', 'Review what your team can see'),
              description:
                privateCount > 0
                  ? t(
                      'inbox.sharingReview.privateResources',
                      '{{count}} private machine or project resources are only visible to you.',
                      { count: privateCount }
                    )
                  : sharingReviewState.teamLooksEmpty
                    ? t(
                        'inbox.sharingReview.emptyTeam',
                        'Nothing is visible in this team workspace yet. Ask a teammate to share a machine or project if you expected to see their conversations.'
                      )
                    : t(
                        'inbox.sharingReview.noLocalResources',
                        'No team machines or local projects are visible to you. A teammate may need to share them before their local conversations appear.'
                      ),
              updatedAt: item.updatedAt,
              unread: item.readAt === undefined,
              actionLabel:
                sharingReviewState.actionTarget === 'machines'
                  ? t('inbox.sharingReview.actionDevices', 'Review devices')
                  : sharingReviewState.actionTarget === 'projects'
                    ? t('inbox.sharingReview.action', 'Review projects')
                    : undefined,
            };
          }
          if (item.kind === 'permission_requested') {
            const isQuestion = item.requestKind === 'ask_user_question';
            return {
              id: item._id,
              kind: item.kind,
              title: item.title || t('sessions.untitled', 'Untitled session'),
              description: isQuestion
                ? t('inbox.permission.question', 'The agent has a question for you.')
                : item.toolLabel
                  ? t('inbox.permission.tool', 'Approval needed: {{tool}}', {
                      tool: item.toolLabel,
                    })
                  : t('inbox.permission.default', 'The agent is waiting for your approval.'),
              updatedAt: item.updatedAt,
              unread: item.readAt === undefined,
              actionLabel: t('inbox.openConversation', 'Open conversation'),
            };
          }
          return {
            id: item._id,
            kind: item.kind,
            title: item.title || t('sessions.untitled', 'Untitled session'),
            description: t('inbox.sessionCompleted', 'Session completed.'),
            updatedAt: item.updatedAt,
            unread: item.readAt === undefined,
            actionLabel: t('inbox.openConversation', 'Open conversation'),
          };
        }),
    [
      inboxRows,
      sharingReviewState.privateMachineCount,
      sharingReviewState.privateProjectCount,
      sharingReviewState.actionTarget,
      sharingReviewState.active,
      sharingReviewState.ready,
      sharingReviewState.teamLooksEmpty,
      t,
    ]
  );
  const handleMobileInboxItemSelect = useCallback(
    (itemId: string) => {
      const item = inboxRows?.find((candidate) => candidate._id === itemId);
      if (!item) return;
      void markInboxItemRead({ itemId: item._id });
      if (item.kind === 'sharing_review') {
        if (sharingReviewState.actionTarget === 'machines') {
          openSettings('machines');
        } else if (sharingReviewState.actionTarget === 'projects') {
          setSelectedMobileHomeTab('projects');
        }
        return;
      }
      const sessionId = item.route?.split('/sessions/')[1]?.split(/[/?#]/)[0];
      if (!sessionId) return;
      void navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId },
      });
    },
    [
      inboxRows,
      markInboxItemRead,
      navigate,
      openSettings,
      sharingReviewState.actionTarget,
      workspaceSlug,
    ]
  );
  const handleMobileInboxItemDismiss = useCallback(
    (itemId: string) => {
      const item = inboxRows?.find((candidate) => candidate._id === itemId);
      if (item) void dismissInboxItem({ itemId: item._id });
    },
    [dismissInboxItem, inboxRows]
  );
  /* Sub-tab display = the persisted atom value, full stop. The atom is
     only written by `handleMobileHomeProjectsSubTabSelect` (i.e. an
     explicit tap on the segmented selector).

     Rejected: writing the atom from `preSelectedContext` changes. The
     URL's `context` param flips to `'local'` / `'github'` every time
     the user navigates into a project of that kind — auto-syncing
     would silently overwrite a user who tapped 'github' as soon as
     they opened a local project, which is exactly the "the default
     value isn't sticky" behavior the user reported. Deep links with
     `?context=github` still land the user on the right home tab via
     the initial `selectedMobileHomeTab` derivation above; they just
     don't *permanently* mutate the persisted preference. */
  const selectedProjectsSubTab: MobileProjectsSubTab = persistedProjectsSubTab;
  const handleMobileHomeWorkspaceSelect = useCallback(
    (nextWorkspaceId: string) => {
      const targetOrganization = organizations?.find(
        (organization) => organization.id === nextWorkspaceId
      );
      if (!targetOrganization) return;
      void switchOrganization(targetOrganization.id);
      if (targetOrganization.slug) {
        void navigate({
          to: '/$workspaceName/chat',
          params: { workspaceName: targetOrganization.slug },
        });
      }
    },
    [navigate, organizations, switchOrganization]
  );
  const handleMobileHomeTabSelect = useCallback(
    (nextTab: MobileHomeTab) => {
      setSelectedMobileHomeTab(nextTab);
      /* Per-tab sync rules:
         - 'inbox': purely visual — Inbox isn't a session-context type
           and doesn't drive the composer's contextType. We also don't
           write the URL: refreshing into Inbox would be confusing
           since the feature isn't shipping yet and the user's actual
           "data context" is still whichever Chat / Projects state
           they were on.
         - 'tasks': same as Inbox — the Tasks surface reads its own
           atoms and has no session-context meaning, so the composer
           context + URL stay on whatever Chat / Projects state the
           user had before tapping across.
         - 'chat': mirror to `contextType` + URL so the composer's
           selectors line up with the visible list.
         - 'projects': delegate to whichever sub-tab is remembered
           (`persistedProjectsSubTab`), since 项目 isn't itself a
           contextType. */
      if (nextTab === 'inbox' || nextTab === 'tasks') return;
      const nextContext: SessionContextType = nextTab === 'chat' ? 'chat' : persistedProjectsSubTab;
      setContextType(nextContext);
      void navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
        search: { context: nextContext },
      });
    },
    [navigate, persistedProjectsSubTab, workspaceSlug]
  );
  const handleMobileHomeProjectsSubTabSelect = useCallback(
    (nextSub: MobileProjectsSubTab) => {
      /* Persist for later restoration AND update `contextType` so the
         composer's selectors track the visible sub-tab. */
      setPersistedProjectsSubTab(nextSub);
      setContextType(nextSub);
      void navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
        search: { context: nextSub },
      });
    },
    [navigate, setPersistedProjectsSubTab, workspaceSlug]
  );
  const handleMobileHomeLocalProjectSelect = useCallback(
    (projectKey: string) => {
      const entry = visibleLocalProjectMap.get(projectKey);
      if (!entry) return;
      handleMachineChange(entry.machineId);
      handleSelectedLocalProjectChange({
        machineId: entry.machineId,
        localProjectId: entry.project.id,
      });
      setContextType('local');
      void navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
        search: {
          context: 'local',
          machine: entry.machineId,
          project: entry.project.id,
        },
      });
    },
    [
      handleMachineChange,
      handleSelectedLocalProjectChange,
      navigate,
      visibleLocalProjectMap,
      workspaceSlug,
    ]
  );
  const handleMobileHomeGitHubRepositorySelect = useCallback(
    (repoFullName: string) => {
      setSelectedRepo(repoFullName);
      setContextType('github');
      void navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
        search: { context: 'github', repo: repoFullName },
      });
    },
    [navigate, workspaceSlug]
  );
  const handleMobileHomeChatSelect = useCallback(
    (chatId: string) => {
      void navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId: chatId },
      });
    },
    [navigate, workspaceSlug]
  );
  /* Pull-to-refresh on the mobile home list. Drives a manual catch-up
     via `runtime.repo.sync()` — the same path the SSE reconnect loop
     uses, just user-initiated. Swallow errors here so a flaky network
     doesn't surface a toast on a gesture users do casually; the
     connection banner will already paint the failure state via the
     ambient `lodyConnectionUiStateAtom` if the sync actually fails. */
  const handleMobileHomePullToRefresh = useCallback(async () => {
    if (!runtime) return;
    try {
      await runtime.repo.sync();
    } catch (error) {
      console.error('[chat-landing] pull-to-refresh sync failed', error);
    }
  }, [runtime]);
  /* Pin / archive callbacks for the mobile swipe-to-reveal drawer.
     Cast the id to `SessionId` — the row only knows it as `string`,
     but our session-action helpers want the branded type. */
  const handleMobileChatTogglePin = useCallback(
    (chatId: string, nextPinned: boolean) => {
      void setSessionPinned(chatId as SessionId, nextPinned);
    },
    [setSessionPinned]
  );
  const handleMobileChatArchive = useCallback(
    (chatId: string) => {
      void archiveSession(chatId as SessionId);
    },
    [archiveSession]
  );
  /* Restore (un-archive) from the mobile archived-list swipe drawer.
     Same `restoreSession` the desktop archive view uses; the row drops
     out of the archived list once `isArchived` flips back to false. */
  const handleMobileChatRestore = useCallback(
    (chatId: string) => {
      void restoreSession(chatId as SessionId).catch((error: unknown) => {
        if (isArchivedLocalProjectRestoreUnavailableError(error)) {
          toast.info(
            t(
              'archive.localProject.restoreUnavailable',
              'Re-add this local project to restore its conversations.'
            )
          );
          return;
        }
        console.error('Failed to restore archived conversation', error);
        toast.error(t('archive.restoreFailed', 'Failed to restore conversation.'));
      });
    },
    [restoreSession, t]
  );
  /* Permanent delete from the mobile archive view's multi-select
     mode. Caller hands us the full id batch; we delete them in
     parallel via the same `deleteArchivedSession` the desktop archive
     view uses. Returns a promise so the list UI can wait before
     clearing its selection / exiting multi-select. */
  const handleMobileChatPermanentDelete = useCallback(
    async (chatIds: string[]) => {
      try {
        await Promise.all(chatIds.map((id) => deleteArchivedSession(id as SessionId)));
      } catch (error) {
        console.error('Failed to permanently delete session', error);
        toast.error(t('archive.deleteFailed'));
      }
    },
    [deleteArchivedSession, t]
  );
  /* --- Mobile project detail screen ------------------------------------
     The page is just a focused single-purpose conversation list now —
     no per-project tab state, no per-project filter state. Filters
     are reused from the Chat-tab pill atoms (so a "exclude open PR"
     choice carries between home and project view), and the in-page
     pill bar surfaces the same set minus pills that are degenerate
     for the page (conversation type is single, machine is single for
     local). */

  /* The project view is entered whenever the URL itself names a concrete
     project (`context=local` + machine/project search params, or
     `context=github` + repo). We deliberately read from the URL props
     (preSelectedMachine/Project/Repo) rather than from
     `selectedLocalProject`/`selectedRepo` state because the latter get
     auto-populated by the default-pickers (lines ~1052 and ~1060) when
     state is cleared — so the back button would otherwise re-enter the
     project view immediately. The URL is the source of truth: when the
     back chip navigates without machine/project params, this returns
     null and the home screen renders again. */
  /* Page-level project context is derived from the URL params alone —
     NOT the `contextType` state. Without this, toggling the
     local/github/chat pill inside the new-chat sheet would swap the
     page behind the sheet (e.g. flipping from a GitHub repo page to
     a local project page) because the mobile project context used
     `contextType` as a tiebreaker. The URL is the source of truth
     for "which project is the user looking at"; the new-chat sheet's
     `contextType` toggling is purely a composer-side concern and
     shouldn't churn the page underneath the sheet.
     Machine + project win over repo when both somehow appear in the
     URL — navigation handlers only ever set one set at a time so
     this priority is effectively never exercised. */
  const projectUrlMachineId = preSelectedMachine ? (preSelectedMachine as MachineId) : null;
  const projectUrlProjectId = preSelectedProject ? (preSelectedProject as LocalProjectId) : null;
  const projectUrlRepoFullName =
    projectUrlMachineId && projectUrlProjectId ? null : (preSelectedRepo ?? null);
  const mobileProjectContext = useMemo<MobileProjectContext | null>(() => {
    if (!isMobile) return null;
    if (projectUrlMachineId && projectUrlProjectId) {
      const key = getLocalProjectVisibilityKey(projectUrlMachineId, projectUrlProjectId);
      const entry = visibleLocalProjectMap.get(key);
      return {
        kind: 'local',
        machineId: projectUrlMachineId,
        projectId: projectUrlProjectId,
        name: entry?.project.name ?? projectUrlProjectId,
        path: entry?.project.rootPath,
      };
    }
    if (projectUrlRepoFullName) {
      const ownerHandle = getGitHubOwnerHandle(projectUrlRepoFullName);
      const repoMeta = repositories?.find((r) => r.fullName === projectUrlRepoFullName);
      const repoName = getGitHubRepoName(
        projectUrlRepoFullName,
        repoMeta && 'name' in repoMeta && typeof repoMeta.name === 'string'
          ? repoMeta.name
          : undefined
      );
      return {
        kind: 'github',
        fullName: projectUrlRepoFullName,
        name: repoName,
        ownerHandle,
        avatarUrl: getGitHubOwnerAvatarUrl(ownerHandle),
      };
    }
    return null;
  }, [
    isMobile,
    projectUrlMachineId,
    projectUrlProjectId,
    projectUrlRepoFullName,
    repositories,
    visibleLocalProjectMap,
  ]);

  /* Prefer the in-process IPC file transport only when this is a local
     project served by the daemon we are co-located with; otherwise fall
     back to machine RPC. Derived once so the provider-key and the provider
     instance below agree on the transport without re-evaluating the check. */
  const mobileProjectUsesLocalIpc =
    mobileProjectContext?.kind === 'local' &&
    typeof window !== 'undefined' &&
    Boolean(getIpcServices()) &&
    visibleLocalMachineId === mobileProjectContext.machineId;

  /* A stable identity key for the file provider. The raw memo inputs
     (`mobileProjectContext` object, `workspaceRuntime`, machine-presence
     id) change identity on benign updates — repositories refresh, local
     project map sync, runtime re-derivation — even when the logical
     target is unchanged. Rebuilding the provider on each of those resets
     the file tree (visible "refresh" a few seconds in) and kicks the
     browser back to the root level. Key off the logical target only and
     reuse the instance across identity churn. */
  const mobileProjectFileProviderKey = useMemo<string | null>(() => {
    if (!mobileProjectContext || !workspaceId) return null;
    if (mobileProjectContext.kind === 'github') {
      return `github:${workspaceId}:${mobileProjectContext.fullName}`;
    }
    return [
      'local',
      workspaceId,
      mobileProjectContext.machineId,
      mobileProjectContext.projectId,
      mobileProjectUsesLocalIpc ? 'ipc' : 'rpc',
      userId ?? '',
    ].join(':');
  }, [mobileProjectContext, mobileProjectUsesLocalIpc, userId, workspaceId]);

  /* The mobile Files tab shares the project header for its breadcrumb +
     back affordance, so the browser's current path is lifted here and
     the browser exposes an imperative `goBack` via this ref. */
  const mobileFileBrowserRef = useRef<MobileProjectFileBrowserHandle>(null);
  const [mobileFileNavSegments, setMobileFileNavSegments] = useState<string[]>([]);

  const mobileProjectFileProviderRef = useRef<{
    key: string | null;
    provider: FileWorkspaceProvider | null;
  }>({ key: null, provider: null });
  const mobileProjectFileProvider = useMemo<FileWorkspaceProvider | null>(() => {
    if (
      mobileProjectFileProviderKey !== null &&
      mobileProjectFileProviderRef.current.key === mobileProjectFileProviderKey
    ) {
      return mobileProjectFileProviderRef.current.provider;
    }

    let provider: FileWorkspaceProvider | null = null;
    if (mobileProjectContext && workspaceId) {
      if (mobileProjectContext.kind === 'github') {
        provider = new GitHubRepoFileProvider({
          workspaceId,
          repoFullName: mobileProjectContext.fullName,
        });
      } else {
        const transport = mobileProjectUsesLocalIpc
          ? createLocalProjectIpcFileTransport({
              workspaceId,
              localProjectId: mobileProjectContext.projectId as LocalProjectId,
            })
          : workspaceRuntime && userId
            ? createLocalProjectRpcFileTransport({
                workspaceId,
                machineId: mobileProjectContext.machineId as MachineId,
                localProjectId: mobileProjectContext.projectId as LocalProjectId,
                requestedByUserId: userId,
                requestLocalProjectControl: workspaceRuntime.requestLocalProjectControl,
              })
            : null;
        provider = transport ? new LocalProjectRpcFileProvider({ transport }) : null;
      }
    }

    mobileProjectFileProviderRef.current = { key: mobileProjectFileProviderKey, provider };
    return provider;
  }, [
    mobileProjectFileProviderKey,
    mobileProjectContext,
    mobileProjectUsesLocalIpc,
    userId,
    workspaceId,
    workspaceRuntime,
  ]);

  /* Conversations for the project. Filtered by chat-scope (my vs team)
     and by the project context. We map each session to a
     MobileConversationItem inline so the screen stays a pure render of
     the list it's given. */
  const mobileProjectConversations = useMemo<MobileConversationItem[]>(() => {
    if (!mobileProjectContext) return [];
    const myUserId = userId ?? null;
    /* See mobileHomeChats: archived sessions live in a separate atom,
       not in `visibleSessions`. Pick the right source so the toggle
       actually surfaces items instead of always rendering empty. */
    const sourceSessions = mobileProjectShowArchived ? visibleArchivedSessions : visibleSessions;
    const activityCache = new Map<
      SessionId,
      ReturnType<typeof getEffectiveSessionActivitySummary>
    >();
    const getSessionActivity = (session: (typeof sourceSessions)[number]) => {
      const cached = activityCache.get(session.id);
      if (cached) return cached;
      const activity = getEffectiveSessionActivitySummary(
        session,
        mobileChildSessionsByParent,
        liveSessionStatuses
      );
      activityCache.set(session.id, activity);
      return activity;
    };
    const projectScopedSessions = sourceSessions.filter((session) => {
      if (chatScope === 'my' && myUserId && session.userId !== myUserId) return false;
      if (mobileProjectContext.kind === 'local') {
        if (session.machineId !== mobileProjectContext.machineId) return false;
        const key = getSessionLocalProjectKey(session);
        if (key == null) return false;
        return (
          key ===
          getLocalProjectVisibilityKey(
            mobileProjectContext.machineId as MachineId,
            mobileProjectContext.projectId as LocalProjectId
          )
        );
      }
      return getSessionGitHubRepoFullName(session) === mobileProjectContext.fullName;
    });
    return projectScopedSessions
      .sort((left, right) => {
        /* Pinned-first, then most-recent. See the home Chat-tab sort
           above for rationale (matches desktop sidebar's behavior). */
        const leftPinned = left.isPinned ? 1 : 0;
        const rightPinned = right.isPinned ? 1 : 0;
        if (leftPinned !== rightPinned) return rightPinned - leftPinned;
        const leftTime = getSessionActivity(left).latestMessageAt;
        const rightTime = getSessionActivity(right).latestMessageAt;
        return rightTime - leftTime;
      })
      .map((session) => {
        const prInfo = getLatestPullRequestInfo(session);
        const activity = getSessionActivity(session);
        const latestMessageAt =
          Number.isFinite(activity.latestMessageAt) && activity.latestMessageAt > 0
            ? activity.latestMessageAt
            : null;
        const diffStats = session.diffStats ?? { allChange: { add: 0, del: 0 } };
        const isOnline = onlineMachineIds.has(session.machineId);
        const kind: MobileConversationKind =
          mobileProjectContext.kind === 'github'
            ? 'github'
            : mobileProjectContext.kind === 'local'
              ? 'local'
              : 'chat';
        let projectAvatarUrl: string | null = null;
        if (mobileProjectContext.kind === 'github') {
          projectAvatarUrl =
            mobileProjectContext.avatarUrl ??
            (mobileProjectContext.ownerHandle
              ? getGitHubOwnerAvatarUrl(mobileProjectContext.ownerHandle)
              : null);
        }
        return {
          id: session.id,
          title: session.title?.trim() || t('sessions.untitled', 'Untitled session'),
          kind,
          branchName: session.branchName?.trim() || null,
          prNumber: prInfo.number,
          prStatus: prInfo.status,
          /* PR url + CI rollup + readiness drive the row's PR status icon and
             its Mergeable pill, exactly as the desktop sidebar row does
             (`getLatestPullRequestInfo` is the shared source for both). */
          prUrl: prInfo.url,
          prCiState: prInfo.ciState,
          prReadiness: prInfo.readiness,
          addedLines: diffStats.allChange.add,
          deletedLines: diffStats.allChange.del,
          latestMessageAt,
          ageLabel: formatMobileAgeLabel(
            latestMessageAt ?? session.lastMessageAt ?? session.createdAt
          ),
          isWorking: activity.isWorking,
          isWaitingPermission: activity.isWaitingPermission,
          isOffline: !isOnline,
          hasUnreadMessages: activity.hasUnreadMessages,
          isPinned: Boolean(session.isPinned),
          machineId: session.machineId,
          /* See the home Chat-tab builder: precise opener for navigation, row
             id for nesting. An opener outside this project simply leaves the
             created Session as a top-level row (the tree's orphan fallback). */
          openedBySessionId: session.openedBySessionId ?? null,
          openedByRowSessionId:
            session.openedByRootSessionId ??
            mobileOpenerRowResolver(session.openedBySessionId) ??
            session.openedBySessionId ??
            null,
          projectAvatarUrl,
          isWorktree: kind === 'local' && session.isWorktree === true,
          /* Owner avatar — see the home Chat-tab builder for rationale.
             Same team-scope-only behavior. */
          owner:
            teamMembersByUserId != null && session.userId
              ? (teamMembersByUserId.get(session.userId) ?? { id: session.userId })
              : undefined,
        };
      });
  }, [
    chatScope,
    mobileChildSessionsByParent,
    mobileOpenerRowResolver,
    liveSessionStatuses,
    mobileProjectContext,
    mobileProjectShowArchived,
    onlineMachineIds,
    t,
    teamMembersByUserId,
    userId,
    visibleArchivedSessions,
    visibleSessions,
  ]);

  const handleMobileProjectBack = useCallback(() => {
    if (mobileProjectContext?.kind === 'local') {
      handleSelectedLocalProjectChange(null);
      setContextType('local');
      void navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
        search: { context: 'local' },
      });
    } else {
      setSelectedRepo(undefined);
      setContextType('github');
      void navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
        search: { context: 'github' },
      });
    }
  }, [handleSelectedLocalProjectChange, mobileProjectContext?.kind, navigate, workspaceSlug]);

  /* In-project filter pills — same shape as the home Chat-tab bar but
     trimmed to the dimensions that matter on this surface:
       - drop "对话类型": every row on this page is one kind already.
       - drop "机器" for local: the page is scoped to one machine.
       - keep "机器" for github: a repo can have sessions on multiple
         machines (different team members), so the filter still helps.
     The pills back onto the same persisted atoms the home uses so
     filter state stays consistent as the user crosses surfaces. */
  const mobileProjectFilterPills = useMemo<FilterPill[]>(() => {
    if (!mobileProjectContext) return [];
    const allRunning = ['working', 'waiting', 'idle', 'offline'] as const;
    const allPr = ['open', 'draft', 'merged', 'closed', 'no-pr'] as const;
    const machineOptions = mobileHomeMachines.map((m) => ({ id: m.id, label: m.name }));
    const allMachineIds = machineOptions.map((m) => m.id);

    const invertSelection = <T extends string>(
      universe: ReadonlyArray<T>,
      next: ReadonlySet<string>
    ): Set<T> => {
      const excluded = new Set<T>();
      for (const id of universe) if (!next.has(id)) excluded.add(id);
      return excluded;
    };

    /* Same aggregation rationale as the home chat pills above:
       collapse multi-select dimensions into one "过滤" pill so the
       primary chip row stays scannable on narrow phones. */
    const multiPills: MultiSelectPill[] = [
      {
        kind: 'multi',
        id: 'running',
        label: t('chat.mobileHome.filters.running.label', '状态'),
        options: [
          { id: 'working', label: t('chat.mobileHome.filters.running.working', '运行中') },
          { id: 'waiting', label: t('chat.mobileHome.filters.running.waiting', '等待权限') },
          { id: 'idle', label: t('chat.mobileHome.filters.running.idle', '空闲') },
          { id: 'offline', label: t('chat.mobileHome.filters.running.offline', '离线') },
        ],
        defaultIds: new Set<string>(allRunning),
        selectedIds: new Set<string>(allRunning.filter((s) => !chatExcludedRunning.has(s))),
        onChange: (next) => setChatExcludedRunning(invertSelection([...allRunning], next)),
      },
      {
        kind: 'multi',
        id: 'pr',
        label: t('chat.mobileHome.filters.pr.label', 'PR'),
        options: [
          { id: 'open', label: t('chat.mobileHome.filters.pr.open', 'Open') },
          { id: 'draft', label: t('chat.mobileHome.filters.pr.draft', 'Draft') },
          { id: 'merged', label: t('chat.mobileHome.filters.pr.merged', 'Merged') },
          { id: 'closed', label: t('chat.mobileHome.filters.pr.closed', 'Closed') },
          { id: 'no-pr', label: t('chat.mobileHome.filters.pr.noPr', '无 PR') },
        ],
        defaultIds: new Set<string>(allPr),
        selectedIds: new Set<string>(allPr.filter((s) => !chatExcludedPr.has(s))),
        onChange: (next) => setChatExcludedPr(invertSelection([...allPr], next)),
      },
    ];

    if (mobileProjectContext.kind === 'github' && machineOptions.length > 1) {
      multiPills.push({
        kind: 'multi',
        id: 'machine',
        label: t('chat.mobileHome.filters.machine.label', '机器'),
        options: machineOptions,
        defaultIds: new Set<string>(allMachineIds),
        selectedIds: new Set<string>(
          allMachineIds.filter((id) => !chatExcludedMachines.has(id as MachineId))
        ),
        onChange: (next) =>
          setChatExcludedMachines(
            invertSelection(allMachineIds as MachineId[], next) as Set<MachineId>
          ),
      });
    }

    /* The project page has no Group pill: home uses Project | Date,
       and both are meaningless inside a single project (one project
       bucket / date still useful? — date could apply, but the
       in-project list stays flat for now). */
    const pills: FilterPill[] = [
      {
        kind: 'single',
        id: 'scope',
        fallbackLabel: t('chat.mobileHome.filters.scope.all', 'Team Tasks'),
        options: [
          { id: 'team', label: t('chat.mobileHome.filters.scope.all', 'Team Tasks') },
          { id: 'my', label: t('chat.mobileHome.filters.scope.my', 'My Tasks') },
        ],
        selectedId: chatScope === 'my' ? 'my' : 'team',
        onSelect: (id) => setChatScope(id === 'my' ? 'my' : 'team'),
      },
      {
        kind: 'aggregate',
        id: 'filters',
        label: t('chat.mobileHome.filters.aggregateLabel', 'Filters'),
        pills: multiPills,
      },
    ];

    return pills;
  }, [
    chatExcludedMachines,
    chatExcludedPr,
    chatExcludedRunning,
    chatScope,
    mobileHomeMachines,
    mobileProjectContext,
    setChatExcludedMachines,
    setChatExcludedPr,
    setChatExcludedRunning,
    setChatScope,
    t,
  ]);

  /* Apply the pill-bar filters on top of `mobileProjectConversations`
     (which is already scoped to the project + chatScope). Local pages
     skip the machine predicate because their conversations are all
     on one machine already; github pages honor it (multiple machines
     can host sessions for the same repo). The kind predicate is
     skipped on both — every row is the same kind here. */
  const visibleProjectConversations = useMemo(() => {
    if (!mobileProjectContext) return mobileProjectConversations;
    return mobileProjectConversations.filter((item) => {
      if (chatExcludedRunning.has(runningBucketIdFor(item))) return false;
      if (chatExcludedPr.has(prBucketIdFor(item))) return false;
      if (
        mobileProjectContext.kind === 'github' &&
        item.machineId &&
        chatExcludedMachines.has(item.machineId as MachineId)
      ) {
        return false;
      }
      return true;
    });
  }, [
    chatExcludedMachines,
    chatExcludedPr,
    chatExcludedRunning,
    mobileProjectContext,
    mobileProjectConversations,
  ]);

  const handleMobileProjectConversationSelect = useCallback(
    (sessionId: string) => {
      void navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId },
      });
    },
    [navigate, workspaceSlug]
  );

  /* The new-chat sheet is shared between the home and the in-project
     detail page — both branches open it via `setMobileNewChatOpen(true)`.
     Originally it was only mounted in the home branch, so tapping the
     new-chat chip on the project page silently set the open atom
     without anything rendering the sheet; the sheet only showed up
     when the user navigated back to the home (where the home re-
     mounted the sheet with `open=true`). Extracting the JSX here and
     rendering it in both branches makes the sheet available on the
     project page where the chip lives. */
  // Free-tier session cap: surface the paywall ABOVE the composer before the
  // user even tries to send, instead of a rejection toast after the fact.
  // Only the count-based cap gets this notice; a pending checkout is surfaced by
  // its own paywall path and would read wrong under this copy.
  const sessionLimitAdmission = evaluateSessionCreateQuota({
    effectivePlanTier: billingEntitlement?.effectivePlanTier,
    sessionCount: localSessionCount,
  });
  const sessionLimitReached =
    !sessionLimitAdmission.allowed && sessionLimitAdmission.reason === 'limit_reached';
  const sessionLimitNoticeNode = sessionLimitReached ? (
    <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-950 shadow-xs dark:text-amber-100">
      <span>
        {t(hidesBillingUi ? 'chat.sessionLimitNoticeMobile' : 'chat.sessionLimitNotice', {
          limit: FREE_SESSION_LIMIT_PER_WORKSPACE,
        })}
      </span>
      {!hidesBillingUi ? (
        <button
          type="button"
          className="font-semibold text-amber-700 underline underline-offset-2 hover:text-amber-800 dark:text-amber-200 dark:hover:text-amber-100"
          onClick={() => {
            capturePostHogEvent(postHog, 'session/free_session_limit_upgrade_clicked', {
              user_id: userId,
              workspace_id: workspaceId,
              entrypoint: 'chat_landing',
            });
            openSettings('billing');
          }}
        >
          {t('sessions.freeTurnLimitUpgrade')}
        </button>
      ) : null}
    </div>
  ) : null;
  const sharingReviewRow =
    sharingReviewState.ready && sharingReviewState.active
      ? inboxRows?.find((item) => item.kind === 'sharing_review')
      : undefined;
  const sharingReviewNoticeNode = sharingReviewRow ? (
    <div className="mb-2 flex items-start gap-2.5 rounded-lg border border-border/70 bg-muted/35 px-3 py-2.5 text-sm text-foreground shadow-xs">
      <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {t('inbox.sharingReview.title', 'Review what your team can see')}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {sharingReviewState.teamLooksEmpty
            ? t(
                'inbox.sharingReview.emptyTeam',
                'Nothing is visible in this team workspace yet. Ask a teammate to share a machine or project if you expected to see their conversations.'
              )
            : sharingReviewState.privateMachineCount + sharingReviewState.privateProjectCount === 0
              ? t(
                  'inbox.sharingReview.noLocalResources',
                  'No team machines or local projects are visible to you. A teammate may need to share them before their local conversations appear.'
                )
              : t(
                  'inbox.sharingReview.landing',
                  'Private machines and projects are only visible to you. Share the ones your teammates should be able to use.'
                )}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {sharingReviewState.actionTarget ? (
            <button
              type="button"
              className="text-xs font-semibold text-primary hover:underline"
              onClick={() => {
                void markInboxItemRead({ itemId: sharingReviewRow._id });
                openSettings(sharingReviewState.actionTarget ?? 'projects');
              }}
            >
              {sharingReviewState.actionTarget === 'machines'
                ? t('inbox.sharingReview.actionDevices', 'Review machines')
                : t('inbox.sharingReview.action', 'Review projects')}
            </button>
          ) : null}
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => void suppressSharingReview({ itemId: sharingReviewRow._id })}
          >
            {t('inbox.sharingReview.neverRemind', "Don't remind me again")}
          </button>
        </div>
      </div>
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => void dismissInboxItem({ itemId: sharingReviewRow._id })}
        aria-label={t('common.dismiss', 'Dismiss')}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  ) : null;
  const composerNoticeNode =
    sharingReviewNoticeNode || sessionLimitNoticeNode ? (
      <>
        {sharingReviewNoticeNode}
        {sessionLimitNoticeNode}
      </>
    ) : null;

  const mobileNewChatSheetContentProps: MobileNewChatSheetContentProps = {
    labels: {
      title: t('chat.mobileNewChat.title', '新建对话'),
      closeAriaLabel: t('common.close', 'Close'),
      machineLabel: t('chat.mobileNewChat.machineLabel', '机器'),
      contextTypeLabel: t('chat.mobileNewChat.contextTypeLabel', '类型'),
      perTypeLabel:
        contextType === 'github'
          ? t('chat.mobileNewChat.repoLabel', '仓库')
          : t('chat.mobileNewChat.projectLabel', '项目'),
      branchLabel: t('chat.mobileNewChat.branchLabel', '分支'),
      secondaryPerTypeLabel: t('chat.mobileNewChat.workdirModeLabel', '模式'),
    },
    coordinator: MobileInlinePickerCoordinator,
    machineNode: mobileSheetMachineNode,
    contextTypeNode: mobileSheetContextSwitchNode,
    /* Project / repo on its own row; branch on its own row below
         (split per the user's design ask — chips no longer share a row
         and so don't truncate on narrow phones). */
    perTypeNode: contextType === 'chat' ? null : mobileSheetProjectNode,
    branchNode: contextType === 'chat' ? null : mobileSheetBranchNode,
    secondaryPerTypeNode: mobileSheetWorkdirModeNode,
    composer: (
      <ErrorBoundary
        name="MobileNewChatSheetComposer"
        variant="section"
        resetKeys={[workspaceId, workspaceSlug, contextType, mobileNewChatOpen]}
      >
        <MobileInlinePickerRowSlot>
          {sessionLimitNoticeNode}
          <ChatComposer
            tone={tone}
            variant="session"
            mentionSource={mentionSource}
            availableCommands={availableCommands}
            skillAgent={skillAgent}
            promptId="chat-prompt-mobile-sheet"
            promptRef={promptTextareaRef}
            promptValue={submitting ? '' : prompt}
            onPromptChange={setPrompt}
            onPromptKeyDown={handlePromptKeyDown}
            onPromptPaste={handlePromptPaste}
            onImageDrop={submitting ? undefined : handleImageDrop}
            imageDropDisabled={submitting}
            promptPlaceholder={promptPlaceholder}
            promptDisabled={submitting}
            promptRows={4}
            promptEnterKeyHint={promptEnterKeyHint}
            pastedTextDrafts={submitting ? [] : pastedTextDrafts}
            onPastedTextDraftsChange={submitting ? undefined : setPastedTextDrafts}
            onMentionRangesChange={handleMentionRangesChange}
            persistedMentions={persistedMentionRanges}
            imageItems={submitting ? [] : imageItems}
            attachmentAddDisabled={submitting || (!canAddMoreImages && !canAddMoreFiles)}
            onAttachmentAddClick={handleOpenAttachmentPicker}
            onImageRemove={submitting ? undefined : handleRemoveImage}
            onImageRetry={submitting ? undefined : handleRetryImage}
            fileItems={submitting ? [] : fileItems}
            onFileRemove={submitting ? undefined : handleRemoveFile}
            onFileRetry={submitting ? undefined : handleRetryFile}
            mcp={mcpSelection.menu}
            footerSelector={mobileSheetFooterSelectorNode}
            statusMessage={visibleComposerStatus?.message}
            statusTone={visibleComposerStatus?.tone}
            primaryAction={
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => {
                  void handleSubmit();
                }}
                disabled={submitDisabled}
                aria-label={submitDisabled ? t('chat.submitting') : t('chat.send')}
                /* Match the in-session mobile composer send face: solid
                   foreground disc + ArrowUp (not the old primary-tint chip). */
                className={cn(
                  'h-8 w-8 rounded-full shadow-xs transition-all',
                  'bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px]'
                )}
              >
                {submitting ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <ArrowUp className="h-5 w-5" />
                )}
              </Button>
            }
            autoResize
            maxRows={6}
          />
        </MobileInlinePickerRowSlot>
      </ErrorBoundary>
    ),
    belowComposerNode: mobileSheetBelowComposerNode,
  };

  const mobileNewChatSheetNode = (
    <MobileNewChatSheet
      open={mobileNewChatOpen}
      onOpenChange={setMobileNewChatOpen}
      {...mobileNewChatSheetContentProps}
    />
  );

  if (isMobile && mobileProjectContext) {
    return (
      <>
        <input
          ref={attachmentInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleAttachmentInputChange}
        />
        {mobileNewChatSheetNode}
        <MobileProjectScreen
          project={mobileProjectContext}
          conversations={visibleProjectConversations}
          filterPills={mobileProjectFilterPills}
          /* The project page always renders chats from a single
             project, so grouping is force-pinned to `none` regardless
             of `chatViewMode` (which is the home tab's view-mode atom
             — leaving project grouping on inside a single project
             would render a one-bucket list with a redundant heading). */
          chatGroupBy="none"
          chatGroupLabels={{
            [PINNED_BUCKET_ID]: t('chat.mobileHome.groupLabels.pinned', 'Pinned'),
            [NO_PROJECT_BUCKET_ID]: t('chat.mobileHome.groupLabels.chat', '对话'),
          }}
          labels={{
            backAriaLabel: t('common.back', 'Back'),
            searchAriaLabel: t('common.search', '搜索'),
            archiveToggleLabel: t('chat.mobileHome.archiveToggleLabel', '归档'),
            searchPlaceholder: t('chat.mobileProject.searchPlaceholder', '搜索对话'),
            clearSearchAriaLabel: t('common.clear', '清空'),
            allConversationsHeading: t('chat.mobileHome.allChatsHeading', '全部对话'),
            archivedConversationsHeading: t('chat.mobileHome.archivedChatsHeading', '归档对话'),
            archiveSelection: {
              selectedCount: (count) =>
                t('chat.mobileHome.archiveSelection.selectedCount', '已选 {{count}}', {
                  count,
                }),
              cancel: t('common.cancel', '取消'),
              deleteAction: t('common.delete', '删除'),
              confirmTitle: t('chat.mobileHome.archiveSelection.confirmTitle', '彻底删除归档对话'),
              confirmDescription: t(
                'chat.mobileHome.archiveSelection.confirmDescription',
                '将永久删除选中的 {count} 个对话，此操作不可恢复。'
              ),
              confirmDelete: t('chat.mobileHome.archiveSelection.confirmDelete', '彻底删除'),
            },
            emptyConversations: t('chat.mobileProject.emptyConversations', '没有匹配的对话'),
            chatTab: t('chat.mobileProject.chatTab', '对话'),
            filesTab: t('chat.mobileProject.filesTab', '文件'),
            settingsTab: t('chat.mobileProject.settingsTab', '设置'),
            newChatAriaLabel: t('chat.mobileProject.newChatAriaLabel', '新建对话'),
            settingsTabPlaceholderTitle: t('chat.mobileProject.settingsTab', '设置'),
            settingsTabPlaceholderBody: t('chat.mobileProject.settingsComingSoon', '即将上线'),
          }}
          onBack={handleMobileProjectBack}
          onConversationSelect={handleMobileProjectConversationSelect}
          onConversationTogglePin={handleMobileChatTogglePin}
          onConversationArchive={handleMobileChatArchive}
          onConversationRestore={handleMobileChatRestore}
          onConversationPermanentDelete={handleMobileChatPermanentDelete}
          /* New-chat chip uses the same sheet the home page opens. The
             sheet reads the current project context from chat-landing
             state, so it lands preselected without needing extra
             props. */
          onNewChat={() => setMobileNewChatOpen(true)}
          showArchived={mobileProjectShowArchived}
          onShowArchivedToggle={() => setMobileProjectShowArchived((prev) => !prev)}
          /* The Files tab shares the project header: it renders the
             breadcrumb from the browser's current path and pops levels
             through the imperative handle. */
          fileNavSegments={mobileFileNavSegments}
          onFileNavBack={() => mobileFileBrowserRef.current?.goBack()}
          filesTabContent={({ onScrollActivity, bottomTabBarVisible }) => (
            <MobileProjectFileBrowser
              key={mobileProjectFileProviderKey ?? 'no-provider'}
              ref={mobileFileBrowserRef}
              provider={mobileProjectFileProvider}
              onPathChange={setMobileFileNavSegments}
              onScrollActivity={onScrollActivity}
              bottomTabBarVisible={bottomTabBarVisible}
              message={
                mobileProjectFileProvider
                  ? undefined
                  : t('workspace.projects.filesUnavailable', 'Files are unavailable.')
              }
            />
          )}
          /* Both project kinds get a real per-project Settings tab. Local
             projects expose team-share + ACP history sync + worktree
             scripts; GitHub repos expose the repo-level worktree setup +
             cleanup scripts. */
          settingsTabContent={
            mobileProjectContext.kind === 'local' ? (
              <MobileLocalProjectSettings
                machineId={mobileProjectContext.machineId}
                projectId={mobileProjectContext.projectId}
                onRemoved={handleMobileProjectBack}
              />
            ) : (
              <MobileGithubProjectSettings repoFullName={mobileProjectContext.fullName} />
            )
          }
        />
      </>
    );
  }

  if (isMobile) {
    return (
      <>
        <input
          ref={attachmentInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleAttachmentInputChange}
        />
        <MobileHomeScreen
          workspace={mobileHomeWorkspace}
          workspaceOptions={mobileHomeWorkspaceOptions}
          machines={mobileHomeMachines}
          inboxItems={mobileInboxItems}
          inboxLoading={showMobileInbox && inboxRows === undefined}
          onInboxItemSelect={handleMobileInboxItemSelect}
          onInboxItemDismiss={handleMobileInboxItemDismiss}
          connectionUiState={mobileHomeConnectionUiState}
          isInitialDataLoading={isInitialDataLoading}
          onPullToRefresh={handleMobileHomePullToRefresh}
          selectedTab={effectiveMobileHomeTab}
          showInboxTab={showMobileInbox}
          showTasksTab={tasksFeatureEnabled}
          selectedProjectsSubTab={selectedProjectsSubTab}
          onProjectsSubTabSelect={handleMobileHomeProjectsSubTabSelect}
          onAddLocalProject={() => openAddProjectDialog()}
          onAddGitHubRepository={handleConnectGitRepo}
          localProjects={mobileHomeLocalProjects}
          recentLocalProjects={mobileHomeRecentLocalProjects}
          githubRepositories={mobileHomeGitHubRepositories}
          recentGitHubRepos={mobileHomeRecentGitHubRepos}
          chats={mobileHomeChats}
          chatFilterPills={chatFilterPills}
          chatGroupBy={chatViewMode}
          hasActiveChatFilters={hasActiveChatFilters}
          onClearChatFilters={handleClearChatFilters}
          labels={{
            switchWorkspace: t('organization.switchWorkspace', 'Switch workspace'),
            connectionBanner: {
              loading: t('chat.mobileHome.connectionBanner.loading', '连接中…'),
              reconnecting: t('chat.mobileHome.connectionBanner.reconnecting', '正在重连…'),
              offline: t('chat.mobileHome.connectionBanner.offline', '离线'),
              recovered: t('chat.mobileHome.connectionBanner.recovered', '已连接'),
              refreshing: t('chat.mobileHome.connectionBanner.refreshing', '刷新中…'),
            },
            pullToRefresh: t('chat.mobileHome.pullToRefresh', '下拉刷新'),
            releaseToRefresh: t('chat.mobileHome.releaseToRefresh', '释放刷新'),
            inboxTab: t('chat.contextSwitch.inbox', 'Inbox'),
            inboxPlaceholder: t('chat.mobileHome.inboxPlaceholder', 'No new notifications'),
            inboxLoading: t('common.loading', 'Loading...'),
            inboxDismissAriaLabel: t('common.dismiss', 'Dismiss'),
            privateLabel: t('sharing.private', 'Private'),
            privateHelpAriaLabel: t(
              'sharing.privateHelpAriaLabel',
              'Learn about private resources'
            ),
            privateHelpTitle: t(
              'sharing.privateHelpTitle',
              'Private resources are only visible to you'
            ),
            privateHelpDescription: t(
              'sharing.privateHelpDescription',
              'Private machines, local projects, and their conversations are hidden from teammates. Share a machine in device settings or a project in project settings.'
            ),
            privateHelpClose: t('sharing.privateHelpClose', 'Got it'),
            projectsTab: t('chat.contextSwitch.projects', '项目'),
            localTab: t('chat.contextSwitch.localProjects', 'Local'),
            githubTab: t('chat.contextSwitch.github', 'GitHub'),
            addProjectMenu: t('chat.contextSwitch.addProjectMenu', 'Add project'),
            addLocalProject: t('chat.contextSwitch.addProject', 'Add a folder'),
            addLocalProjectHint: t(
              'chat.contextSwitch.addLocalProjectHint',
              'Browse the machine and pick a folder'
            ),
            addGitHubRepository: t('chat.contextSwitch.addGitHubRepo', 'Add a GitHub repository'),
            addGitHubRepositoryHint: t(
              'chat.contextSwitch.addGitHubRepoHint',
              'Connect a GitHub repository'
            ),
            chatTab: t('chat.contextSwitch.chat', 'Chat'),
            tasksTab: t('tasks.title', 'Tasks'),
            recentProjectsHeading: t('chat.mobileHome.recentProjectsHeading', '最近常用'),
            settingsTab: t('settings.title', 'Settings'),
            projectRemoving: t('sidebar.localProjects.remove.removing', 'Removing…'),
            projectRemovalWaiting: t(
              'sidebar.localProjects.remove.waitingForDevice',
              'Waiting for device…'
            ),
            archiveToggleLabel: t('chat.mobileHome.archiveToggleLabel', '归档'),
            filterBarToggleLabel: t('chat.mobileHome.filterBarToggleLabel', '过滤器'),
            newChatAriaLabel: t('chat.mobileHome.newChatAriaLabel', '新建对话'),
            searchAriaLabel: t('common.search', '搜索'),
            clearSearchAriaLabel: t('common.clear', '清空'),
            /* The home screen otherwise falls back to hard-coded
               Chinese inside `defaultSearchPlaceholder`. Pick the
               right localized placeholder per tab here so the search
               input copy participates in i18n like everything else. */
            searchPlaceholder:
              selectedMobileHomeTab === 'inbox'
                ? t('chat.mobileHome.searchPlaceholderInbox', 'Search')
                : selectedMobileHomeTab === 'chat'
                  ? t('chat.mobileHome.searchPlaceholderChat', 'Search conversations')
                  : selectedProjectsSubTab === 'github'
                    ? t('chat.mobileHome.searchPlaceholderGithub', 'Search repositories')
                    : t('chat.mobileHome.searchPlaceholderLocal', 'Search projects'),
            recentReposHeading: t('chat.mobileHome.recentReposHeading', '最近常用'),
            recentLocalProjectsHeading: t('chat.mobileHome.recentLocalProjectsHeading', '最近常用'),
            allLocalProjectsHeading: t('chat.mobileHome.allLocalProjectsHeading', '全部项目'),
            allGitHubReposHeading: t('chat.mobileHome.allGitHubReposHeading', '全部仓库'),
            allChatsHeading: t('chat.mobileHome.allChatsHeading', '全部对话'),
            archivedChatsHeading: t('chat.mobileHome.archivedChatsHeading', '归档对话'),
            archiveSelection: {
              selectedCount: (count) =>
                t('chat.mobileHome.archiveSelection.selectedCount', '已选 {{count}}', {
                  count,
                }),
              cancel: t('common.cancel', '取消'),
              deleteAction: t('common.delete', '删除'),
              confirmTitle: t('chat.mobileHome.archiveSelection.confirmTitle', '彻底删除归档对话'),
              confirmDescription: t(
                'chat.mobileHome.archiveSelection.confirmDescription',
                '将永久删除选中的 {count} 个对话，此操作不可恢复。'
              ),
              confirmDelete: t('chat.mobileHome.archiveSelection.confirmDelete', '彻底删除'),
            },
            /* Project mode: only the no-project catch-all needs a
               label (others use `projectLabel`). Date mode: named
               buckets; older months format via Intl in the list. */
            chatGroupLabels: {
              [PINNED_BUCKET_ID]: t('chat.mobileHome.groupLabels.pinned', 'Pinned'),
              [NO_PROJECT_BUCKET_ID]: t('chat.mobileHome.groupLabels.chat', '对话'),
              [DATE_BUCKET_TODAY]: t('chat.mobileHome.groupLabels.today', 'Today'),
              [DATE_BUCKET_YESTERDAY]: t('chat.mobileHome.groupLabels.yesterday', 'Yesterday'),
              [DATE_BUCKET_THIS_WEEK]: t('chat.mobileHome.groupLabels.thisWeek', 'This Week'),
              [DATE_BUCKET_THIS_MONTH]: t('chat.mobileHome.groupLabels.thisMonth', 'This Month'),
              [DATE_BUCKET_UNKNOWN]: t('chat.mobileHome.groupLabels.older', 'Older'),
            },
            emptyLocalProjects: t(
              'chat.mobileHome.emptyLocalProjectsAllMachines',
              '当前 workspace 还没有任何本地项目'
            ),
            emptyGitHubProjects: t(
              'chat.mobileHome.emptyGitHubProjects',
              '当前 workspace 没有已授权的 GitHub 仓库'
            ),
            emptySearch: t('chat.mobileHome.emptySearch', '没有匹配的结果'),
            emptyChats: t('chat.mobileHome.emptyChatsAllMachines', '当前 workspace 还没有任何对话'),
            emptyFilteredChats: t('chat.mobileHome.emptyFilteredChats', '当前过滤条件下没有对话'),
            clearChatFilters: t('chat.mobileHome.clearFilters', '清除所有过滤'),
            /* First-run hint (no machines + no chats): the user installed
               the mobile app before starting the desktop client, so nudge
               them to the download page. The mobile app can't run the agent
               itself. Kept short on purpose. */
            onboarding: {
              title: t('chat.mobileHome.onboarding.title', 'Lody runs on your computer'),
              description: t(
                'chat.mobileHome.onboarding.description',
                'Download the desktop app to get started.'
              ),
              downloadButton: t('chat.mobileHome.onboarding.downloadButton', 'Download Lody'),
            },
          }}
          onWorkspaceMenuOpen={
            multiWorkspaceAvailable ? () => setMobileWorkspaceSheetOpen(true) : undefined
          }
          onTabSelect={handleMobileHomeTabSelect}
          onLocalProjectSelect={handleMobileHomeLocalProjectSelect}
          onGitHubRepositorySelect={handleMobileHomeGitHubRepositorySelect}
          onChatSelect={handleMobileHomeChatSelect}
          onChatTogglePin={handleMobileChatTogglePin}
          onChatArchive={handleMobileChatArchive}
          onChatRestore={handleMobileChatRestore}
          onChatPermanentDelete={handleMobileChatPermanentDelete}
          onSettingsOpen={() => {
            void navigate({
              to: '/$workspaceName/settings',
              params: { workspaceName: workspaceSlug },
              search: { from: getAppCurrentPathWithSearch() },
            });
          }}
          /* New-chat chip opens the bottom-sheet composer. Stays on the
             home screen behind the overlay so the user can cancel and
             return to the project / chat list without navigation. */
          onNewChat={() => {
            if (selectedMobileHomeTab === 'chat') {
              setContextType('chat');
            }
            setMobileNewChatOpen(true);
          }}
          showArchived={mobileHomeShowArchived}
          onShowArchivedToggle={() => setMobileHomeShowArchived((prev) => !prev)}
          /* First-run onboarding CTA — opens the localized download page in
             the external browser (same handler the desktop no-machine hint
             uses). */
          onDownloadClient={handleDownloadClient}
        />
        {multiWorkspaceAvailable ? (
          <>
            <MobileWorkspaceSwitcherSheet
              open={mobileWorkspaceSheetOpen}
              onOpenChange={setMobileWorkspaceSheetOpen}
              userEmail={currentUser?.email ?? null}
              workspaces={mobileHomeWorkspaceOptions}
              onSelect={handleMobileHomeWorkspaceSelect}
              /* "Create Workspace" pops the dedicated mobile create sheet
                 below — it's a 2-field form (name + slug), so a focused
                 bottom-sheet beats a full-screen settings detour. The
                 switcher closes first (via its own onOpenChange) so the
                 create sheet appears in a clean stack. "Invite members"
                 still routes to settings since that surface owns the
                 actual invite-link / member-list UI. */
              onCreateWorkspace={() => {
                setMobileCreateWorkspaceOpen(true);
              }}
              onInviteMembers={() => {
                void navigate({
                  to: '/$workspaceName/settings/account',
                  params: { workspaceName: workspaceSlug },
                });
              }}
              labels={{
                title: t('organization.switchWorkspace', '切换工作空间'),
                workspacesHeading: t('organization.workspaces', 'Workspaces'),
                createWorkspace: t('organization.createNew', 'Create Workspace'),
                inviteMembers: t('organization.inviteMembers', 'Invite members'),
              }}
            />
            <MobileCreateWorkspaceSheet
              open={mobileCreateWorkspaceOpen}
              onOpenChange={setMobileCreateWorkspaceOpen}
              onCreated={(createdSlug) => {
                void navigate({
                  to: '/$workspaceName/chat',
                  params: { workspaceName: createdSlug },
                });
              }}
            />
          </>
        ) : null}
        {mobileNewChatSheetNode}
        <AddLocalProjectDialogContainer
          open={addProjectOpen}
          onOpenChange={handleAddProjectOpenChange}
          initialMachineId={addProjectInitialMachineId}
          onAdded={handleLocalProjectAdded}
          onLocated={handleLocalProjectAdded}
        />
      </>
    );
  }

  return (
    <>
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleAttachmentInputChange}
      />
      <ChatLandingView
        tone={tone}
        isMobile={isMobile}
        navRootRef={keyboardNavRef}
        mentionSource={mentionSource}
        availableCommands={availableCommands}
        skillAgent={skillAgent}
        title={title}
        promptValue={prompt}
        onPromptChange={setPrompt}
        onPromptKeyDown={handlePromptKeyDown}
        onPromptPaste={handlePromptPaste}
        onImageDrop={handleImageDrop}
        promptPlaceholder={promptPlaceholder}
        promptEnterKeyHint={promptEnterKeyHint}
        promptRef={promptTextareaRef}
        pastedTextDrafts={pastedTextDrafts}
        onPastedTextDraftsChange={setPastedTextDrafts}
        onMentionRangesChange={handleMentionRangesChange}
        persistedMentions={persistedMentionRanges}
        imageItems={imageItems}
        attachmentAddDisabled={submitting || (!canAddMoreImages && !canAddMoreFiles)}
        onAttachmentAddClick={handleOpenAttachmentPicker}
        onImageRemove={handleRemoveImage}
        onImageRetry={handleRetryImage}
        fileItems={fileItems}
        onFileRemove={handleRemoveFile}
        onFileRetry={handleRetryFile}
        mcp={mcpSelection.menu}
        topSelector={<div className="w-full min-w-0">{topSelectorNode}</div>}
        footerSelector={footerSelectorNode}
        bottomBar={bottomBarNode}
        composerNotice={composerNoticeNode}
        composerStatusMessage={visibleComposerStatus?.message}
        composerStatusTone={visibleComposerStatus?.tone}
        submitDisabled={submitDisabled}
        submissionPending={submitting}
        onSubmit={() => {
          void handleSubmit();
        }}
        submitLabel={t('chat.send')}
        submittingLabel={t('chat.submitting')}
        hintType={hintType}
        noMachineVariant={isElectron ? 'daemon-starting' : 'download-client'}
        hintDownloadClientMessage={t('chat.cliHint.downloadClient')}
        hintDownloadClientLabel={t('chat.cliHint.downloadClientButton')}
        hintDaemonStartingMessage={t('chat.cliHint.daemonStarting')}
        hintReportBugLabel={t('chat.cliHint.reportBug')}
        hintNoAgentConfigMessage={t('chat.cliHint.noAgentConfig')}
        hintGoToSettingsLabel={t('chat.cliHint.goToSettings')}
        hintDiscordMessage={t(
          'chat.cliHint.discordMessage',
          'Have questions? Join our Discord community for help.'
        )}
        hintDiscordLabel={t('chat.cliHint.discordLink', 'Discord')}
        onDownloadClient={handleDownloadClient}
        onReportBug={handleReportBug}
        onGoToAgentSettings={handleGoToAgentSettings}
        onOpenMobileDrawer={() => openMobileDrawer(true)}
        leftSidebarExpandSlot={
          !isMobile && isLeftSidebarHidden ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => showNavigationSidebar()}
              aria-label={t('chat.leftSidebar.show', 'Show navigation sidebar')}
              className="h-7 w-7 shrink-0 text-muted-foreground"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          ) : null
        }
        resetKeys={[workspaceId, workspaceSlug, contextType, isMobile]}
        errorLabels={{
          somethingWentWrong: t('common.somethingWentWrong', 'Something went wrong'),
          composerCrashed: t(
            'chat.composerCrashed',
            'The chat composer failed to render. Your draft is preserved below.'
          ),
          tryAgain: t('common.tryAgain', 'Try again'),
          unavailable: t('common.unavailable', 'Unavailable'),
        }}
      />
      <AddLocalProjectDialogContainer
        open={addProjectOpen}
        onOpenChange={handleAddProjectOpenChange}
        initialMachineId={addProjectInitialMachineId}
        onAdded={handleLocalProjectAdded}
        onLocated={handleLocalProjectAdded}
      />
      <MachinePairingDialog
        open={machinePairingDialogOpen}
        onOpenChange={handleMachinePairingOpenChange}
        requestId={machinePairing?.requestId ?? null}
        status={machinePairingStatus}
        machineId={pairedMachineId}
        machineName={observedMachinePairing?.machineName}
        command={machinePairingStatus === 'pending' ? (machinePairing?.command ?? null) : null}
        expiresAt={machinePairing?.expiresAt ?? null}
        creating={machinePairingCreating}
        createError={machinePairingCreateError}
        onRetry={() => void createNewMachinePairing()}
        onCancelRequest={async () => {
          if (!machinePairing) return;
          await cancelMachinePairingRequest({ requestId: machinePairing.requestId });
        }}
        onConfigureAgents={() => openSettings('agents')}
      />
      <AgentRoleEditorDialog
        editor={agentRoleEditor}
        accessibleRoles={workspaceAgentRoles}
        onChange={setAgentRoleEditor}
        onClose={() => setAgentRoleEditor(null)}
        onSaved={handleAgentRoleSaved}
        source="chat_landing"
      />
    </>
  );
}
