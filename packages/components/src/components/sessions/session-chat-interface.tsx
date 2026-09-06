import {
  startTransition,
  forwardRef,
  memo,
  useDeferredValue,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useOpenSettings } from '../../hooks/use-open-settings';
import { v4 as uuidv4 } from 'uuid';
import {
  ArrowDown,
  ArrowUp,
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Copy,
  CornerLeftUp,
  Ellipsis,
  Folder,
  GitBranch,
  GitBranchPlus,
  GitFork,
  Github,
  History,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Monitor,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  UserRoundCog,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/ui/button';
import { isMacOSElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { isMac } from '@/lib/commands/platform';
import { matchesKeyboardEvent, parseBinding } from '@/lib/commands/key-matcher';
import { isSessionContextCompacting } from '@/lib/session-context-compaction';
import { hasFileTransfer, getFilesFromDataTransfer } from '@/lib/file-drop';
import { resolveProgrammaticTurnAgentRole } from '@/lib/composer-agent-roles';
import { mergeDropZoneHandlers, useDropZone } from '@/hooks/use-drop-zone';
import { useSessionMentionDropZone } from '@/hooks/use-session-mention-drag';
import {
  SessionChatInputArea,
  type SessionChatInputAreaHandle,
  type SessionTurnAgentRoleSelection,
} from './session-chat-input-area';
import { useSessionMcpSelection } from '@/hooks/use-session-mcp-selection';
import { MessageQueueDisplay, shouldRequestNativeQueueSteer } from './message-queue';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@tanstack/react-router';
import { toast } from 'sonner';
import type {
  LocalProjectId,
  MessageContent,
  MessageQueueItemInput,
  MessageQueueItem,
  ProjectRef,
  SessionHistory,
  SessionHistoryParsed,
  SessionFilePayload,
  SessionId,
  SessionInputBlock,
  SessionLegacyMetaFields,
  SessionMeta,
  SessionStatus,
  SessionTurnInputConfig,
  CommentReferencePayload,
  ConversationMarkdownStats,
  GitHubCheckRun,
  GitHubMergeMethod,
  VisualAnnotationReferencePayload,
} from '@lody/shared';
import {
  buildConversationMarkdown,
  buildPendingUserHistoryEntry,
  buildSessionTurnInputConfig,
  countBillableSessionTurns,
  deriveSessionPullRequestReadiness,
  evaluateBillingQuota,
  FREE_SESSION_TURN_LIMIT,
  FREE_SESSION_TURN_WARNING_REMAINING,
  getAcpCapabilityCacheEntryAuthority,
  getAcpCapabilityCacheKey,
  getMachineFlockLocalProjects,
  getProjectRefBranch,
  getSessionPullRequestLegacyFields,
  extractPromptPreviewFromInputBlocks,
  getServerNow,
  getSessionRoomId,
  historyItemsToInputBlocks,
  hasReportedPreviewTarget,
  isSessionGoalCleared,
  isSessionGoalActive,
  normalizeSessionInputBlocks,
  normalizeSessionTurnInputConfig,
  resolveSessionAcpRuntimeConfig,
  resolveSessionConversationConfig,
  resolveSessionConversationSourceFence,
  resolveVisibleSessionGoal,
  resolveActiveAssistantTurnId,
  resolveBaseBranchPreference,
  resolveProjectGitHubRepo,
} from '@lody/shared';
import { useIsMobile } from '../../hooks/use-mobile';
import { useStableCallback } from '@/hooks/use-stable-callback';
import {
  conversationFontSizeAtom,
  currentWorkspaceIdAtom,
  getAllAgentConfigAtom,
  queuedMessageBehaviorAtom,
  userAtom,
} from '@/atoms';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { taskIndexRowsAtom } from '@/atoms/tasks';
import { tasksFeatureEnabledAtom } from '@/atoms/settings';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { browserOnlineAtom } from '@/atoms/control-connection';
import {
  docMetaCacheReadyAtom,
  openedSessionsAtomFamily,
  sessionMetaAtomFamily,
} from '@/atoms/doc-meta';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { useDelayedFlag } from '@/hooks/use-delayed-flag';
import { resolveSessionStatusStripState } from './session-status-strip';
import { isSyncingRoomSyncState } from '@/lib/room-sync-state';
import {
  resolveSessionConversationPreparationState,
  type SessionConversationPreparationState,
} from '@/lib/session-conversation-preparation';
import { useAtomValue, useSetAtom } from 'jotai';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useCloudQuery } from '@lody/platform/react';
import { ReadyForReviewStillDraftError, useGitHubPrDetails } from '@/hooks/use-github-pr-details';
import { derivePrStatusFromDetails } from '@/lib/github-pr-details-state';
import type { AgentSelection } from '@/components/shared/agent-selector';
import SessionChatStream, {
  type AssistantMessageAction,
  type GoalCommand,
  type MessageFileDiffEntriesByTurn,
  type SessionChatStreamHandle,
} from '../ai-gui';
import { MessageSendStatusContext } from '../ai-gui/message-send-status-context';
import { format, formatDistanceToNow } from 'date-fns';
import type { Locale } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import { getAppShareUrl } from '@/lib/app-location';
import { resolveSessionOpenInIdePathTarget } from '@/lib/session-open-in-ide-path';
import {
  buildPathLauncherLaunchInput,
  buildPathLauncherProbes,
  getAvailablePathLauncherOptions,
  getPathLauncherId,
  PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT,
  PATH_LAUNCHER_PREFERENCE_STORAGE_KEY,
  readStoredPathLauncherPreference,
  resolveSelectedPathLauncher,
  writeStoredPathLauncherPreference,
  type PathLauncherOption,
} from '@/lib/session-path-launchers';
import { cn } from '@/lib/utils';
import type { SessionSharingState } from '@/lib/session-sharing';
import {
  SessionAccessControl,
  SessionArchivedBadge,
  getSessionSharingDescription,
  getSessionSharingLabel,
  type SessionSharingTranslator,
} from '@/components/session-sharing';

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/ui/sheet';
import { Badge } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Separator } from '@/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { useSessionActions } from '@/hooks/use-session-actions';
import { useWorkspaceMembers, type WorkspaceMember } from '@/hooks/use-workspace-members';
import { UserAvatar } from '@/components/user-avatar';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { RenameSessionDialog, type RenameSessionDialogTarget } from './rename-session-dialog';
import { useResolvedTheme } from '../../theme-provider';
import { PullRequestBadge } from './pull-request-badge';
import { SessionInfoBar } from './session-info-bar';
import type { ContextChipAction, PrCiRun } from './session-info-chips';
import {
  resolveSessionInfoBarGitHubActionIds,
  shouldDisableSessionInfoBarGitHubActionForHydration,
} from './session-info-action-state';
import {
  canPauseGoalThroughPromptBridge,
  getPromptBridgeGoalCommands,
  GOAL_PROMPT_DISPATCH_OPTIONS,
  isSessionPromptBusy,
} from './session-goal-control';
import { resolveSessionMessageSubmitRoute } from './session-message-submit-route';
import {
  CAPACITY_RETRY_CONTINUATION_PROMPT,
  useCapacityAutoRetry,
} from './use-capacity-auto-retry';
import { buildFixCiErrorsPrompt, buildResolvePrConflictsPrompt } from './session-pr-prompts';
import { resolveConflictsActionAtomFamily } from './session-pr-agent-action';
import { setPreferredPrMergeMethod, usePreferredPrMergeMethod } from './pr-merge-method';
import { PrLinkProvider } from '@/components/ai-gui/pr-link-context';
import {
  COMMIT_AND_PUSH_PROMPT,
  CREATE_DRAFT_PR_PROMPT,
  CREATE_PR_PROMPT,
} from './create-pr-prompt';
import { AutoReviewMenuItem } from './auto-review-menu-item';
import { WorktreeIcon } from '@/components/icons/worktree-icon';
import {
  getSessionForkDestinationOptions,
  type SessionForkDestination,
  type SessionForkWorktreeAvailability,
} from './session-fork-destination-menu';
import { ReviewAgentSetupDialog } from './auto-review-info';
import { AutoReviewStatus } from './auto-review-status';
import { useAutoReview } from '@/hooks/use-auto-review';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { SessionRelationCard } from '@/components/shared/session-relation-card';
import {
  resolveOpenedByNavigationTarget,
  type SessionNavigationTarget,
} from '@/lib/session-navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import {
  isThoughtLevelSelector,
  type AcpConfigOptionValue,
  type AcpSelectConfigOptionSelector,
} from '@/components/shared/acp-selector-options';
import { useComposerCycleCommands } from '@/hooks/use-composer-cycle-commands';
import { useSessionAcpSelectorContext } from '@/hooks/use-session-acp-selector-context';
import {
  useAcpSessionConfigSelectionState,
  useResolvedAcpSessionConfigSelection,
} from '@/hooks/use-acp-session-config-selection';
import { ErrorBoundary } from '@/components/error-boundary';
import { FamiconsCloudOfflineOutline } from '@/components/icons/famicons-cloud-offline-outline';
import { NotificationPermissionPrompt } from './notification-permission-prompt';
import { useAppStoreReviewPrompt } from '@/hooks/use-app-store-review-prompt';
import {
  FloatingPermissionRequest,
  hasPendingPermissionRequest,
} from './floating-permission-request';
import { SessionPin } from './session-pin';
import { SessionPinContext, type SessionPinContextValue } from './session-pin-context';
import { SessionSyncingIndicator } from './session-syncing-indicator';
import { ChildTabEmptyState } from './child-tab-empty-state';
import {
  SessionConversationPage,
  SessionConversationPageHeader,
} from './session-conversation-page';
import { localHomeDirAtom, localMachineIdAtom } from '@/atoms/local-probe';
import { sessionLivePresenceAtomFamily } from '@/atoms/presence';
import {
  resolveUnstartedTrailingDispatchAtMs,
  UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS,
} from '@/lib/session-dispatch-state';
import { shouldMarkSessionRead } from '@/lib/session-read-receipt';
import { recordSessionRenderTrace, shortTraceId } from '@/lib/session-render-trace';
import { getPathLauncherIcon } from '@/components/icons/path-launcher-icon';
import {
  extractIssuePRMentionsFromText,
  useKnownIssuePrItems,
} from '@/components/mentions/issue-pr-hash-mention';
import { SessionSearchProvider } from './session-search-context';
import {
  buildSessionSearchResults,
  normalizeSessionSearchQuery,
  type SessionSearchBlock,
  type SessionSearchResult,
} from '@/lib/session-chat-search';
import { useIncrementalSearchBlocks } from '@/hooks/use-incremental-search-blocks';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { resolveSessionHtmlAttachmentAction } from './session-html-attachment-action';

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Copy-as-Markdown never trims message text, so it can trim tool output, thinking,
 * or nothing at all — and it can still land over budget. Silent truncation reads as
 * "I copied everything", so the toast always names what happened.
 */
function describeCopiedConversation(
  stats: ConversationMarkdownStats,
  t: (key: string, fallback: string, options?: Record<string, unknown>) => string
): string {
  if (stats.overBudget) {
    return t(
      'sessions.copyConversationHistoryCopiedOverBudget',
      'Conversation copied as Markdown (~{{tokens}}k tokens — message text alone exceeds the target)',
      { tokens: Math.round(stats.estimatedTokens / 1000) }
    );
  }

  const trimmed: string[] = [];
  if (stats.toolCallsCollapsed) {
    trimmed.push(t('sessions.copyConversationHistoryTrimToolCalls', 'tool call details'));
  }
  if (stats.thinkingOmitted) {
    trimmed.push(t('sessions.copyConversationHistoryTrimThinking', 'thinking'));
  }
  if (stats.terminalOutputOmitted || stats.terminalOutputTruncated) {
    trimmed.push(t('sessions.copyConversationHistoryTrimTerminal', 'terminal output'));
  }
  if (stats.toolResultsTruncated > 0) {
    trimmed.push(
      // `value`, not `count`: `count` would send i18next down its plural-key
      // lookup (`..._one` / `..._other`), which these strings do not define.
      t('sessions.copyConversationHistoryTrimToolResults', '{{value}} tool results', {
        value: stats.toolResultsTruncated,
      })
    );
  }

  if (trimmed.length === 0) {
    return t('sessions.copyConversationHistoryCopied', 'Conversation copied as Markdown');
  }
  return t(
    'sessions.copyConversationHistoryCopiedTrimmed',
    'Conversation copied as Markdown (trimmed: {{omitted}})',
    { omitted: trimmed.join(', ') }
  );
}

function mapGitHubCheckRunToInfoBar(run: GitHubCheckRun): PrCiRun {
  const status: PrCiRun['status'] =
    run.status === 'queued'
      ? 'queued'
      : run.status === 'in_progress'
        ? 'running'
        : run.conclusion === 'success'
          ? 'success'
          : run.conclusion === 'neutral' || run.conclusion === 'skipped'
            ? 'skipped'
            : 'failure';
  const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const completedAtMs = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
  const durationMs =
    Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
      ? Math.max(0, completedAtMs - startedAtMs)
      : undefined;
  return {
    name: run.name,
    status,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(run.htmlUrl ? { url: run.htmlUrl } : {}),
  };
}
import { usePostHog } from '@posthog/react';
import {
  capturePostHogEvent,
  capturePostHogOutcome,
  getDurationSinceMs,
  getPerformanceNowMs,
} from '@/lib/posthog-analytics';
import { isAskUserQuestionPermissionMeta, type AnalyticsOutcome } from '@lody/shared';
import { collectPendingScheduledTasksFromHistory, type PendingScheduledTask } from '@lody/shared';
import { buildAuthorFixPrompt } from '@lody/shared';
import {
  getPullRequestNumber,
  getPullRequestRepoFullName,
  getSessionGitHubState,
} from '@/lib/session-github-state';
import {
  resolveMachineDotlodyPath,
  resolveSessionWorkspacePath,
} from '@/lib/session-workspace-path';
import { isNativeAppShell } from '@/lib/native-platform';
import {
  findLatestCompletedCodexProposedPlan,
  shouldShowCodexProposedPlanDecision,
} from '@/lib/codex-plan-decision';
import { buildExecutionTurnConfigOverrides } from '@/lib/execution-turn-config';
import { canShowSubscriptionRateLimits } from '@/lib/session-usage';
import { canShowCodexResetForecast } from '@/lib/codex-reset-forecast';

// ── Path launcher options for "Open in" split button ──

type ActionId = 'copy-path';

interface ActionOption {
  id: ActionId;
  label: string;
  Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}

const ACTION_OPTIONS: ActionOption[] = [{ id: 'copy-path', label: 'Copy Path', Icon: Copy }];

const EMPTY_ASSISTANT_QUICK_ACTIONS: AssistantMessageAction[] = [];
const DISPATCHING_TIMEOUT_MS = 15_000;
/** Grace before the header "Syncing" spinner appears (kills session-switch flicker). */
const TITLE_SYNCING_INDICATOR_DELAY_MS = 400;

/** Exact ⌘F / Ctrl+F — no Alt/Shift/secondary primary mod. See find keydown handler. */
const FIND_IN_CHAT_BINDING = parseBinding('$mod+f');

const summarizeInputBlocksForAnalytics = (inputBlocks: readonly SessionInputBlock[]) => {
  let textBlockCount = 0;
  let imageCount = 0;
  let commentReferenceCount = 0;
  let visualAnnotationReferenceCount = 0;
  let textLength = 0;

  for (const block of inputBlocks) {
    if (block.type === 'text') {
      textBlockCount += 1;
      textLength += block.text.length;
    } else if (block.type === 'image') {
      imageCount += 1;
    } else if (block.type === 'comment_reference') {
      commentReferenceCount += 1;
    } else if (block.type === 'visual_annotation_reference') {
      visualAnnotationReferenceCount += 1;
    }
  }

  return {
    text_block_count: textBlockCount,
    image_count: imageCount,
    comment_reference_count: commentReferenceCount,
    visual_annotation_reference_count: visualAnnotationReferenceCount,
    text_length: textLength,
    has_text: textBlockCount > 0,
    has_images: imageCount > 0,
    has_comment_references: commentReferenceCount > 0,
    has_visual_annotation_references: visualAnnotationReferenceCount > 0,
  };
};

const getSessionAnalyticsProject = (project: {
  kind: ProjectRef['kind'] | null;
  repoFullName: string | null;
  githubRepoFullName: string | null;
  localProjectId: LocalProjectId | null;
  sessionRepoFullName: string | undefined;
}) => {
  const trimRepoFullName = (repoFullName: string | null | undefined): string | undefined => {
    const trimmed = repoFullName?.trim();
    return trimmed ? trimmed : undefined;
  };
  const resolvedProjectRepo =
    project.kind === 'github'
      ? project.repoFullName
      : project.kind === 'local'
        ? project.githubRepoFullName
        : null;
  const repoFullName =
    trimRepoFullName(resolvedProjectRepo) ?? trimRepoFullName(project.sessionRepoFullName) ?? null;
  const projectKind =
    project.kind === 'local'
      ? 'local'
      : project.kind === 'github' || repoFullName
        ? 'github'
        : 'chat';

  return {
    project_kind: projectKind,
    repo_full_name: repoFullName,
    local_project_id: project.kind === 'local' ? project.localProjectId : null,
  };
};

// Session-end timing rolled up from history (spec §5.5 / §3.2). The schema
// already stores per-turn start (`timestamp`/`startedAt`), `endedAt`, and
// `permissionWaitMs` — these are aggregated here rather than tracked live so a
// late client (resume/refresh) still reports a meaningful duration. `turn_count`
// counts assistant turns; `duration_ms` spans the first turn start to the last
// turn end; `permission_wait_ms` sums the per-turn waits.
const summarizeSessionEndTiming = (
  history: readonly SessionHistory[] | undefined
): {
  turn_count: number;
  duration_ms: number | null;
  first_to_last_turn_ms: number | null;
  permission_wait_ms: number | null;
} => {
  if (!history?.length) {
    return {
      turn_count: 0,
      duration_ms: null,
      first_to_last_turn_ms: null,
      permission_wait_ms: null,
    };
  }

  let turnCount = 0;
  let firstTurnStart: number | null = null;
  let lastTurnStart: number | null = null;
  let lastTurnEnd: number | null = null;
  let permissionWaitTotal = 0;
  let sawPermissionWait = false;

  for (const entry of history) {
    if (entry.role !== 'assistant') {
      continue;
    }
    turnCount += 1;
    const start = parseTimestamp(entry.startedAt ?? entry.timestamp ?? null);
    const end = parseTimestamp(entry.endedAt ?? null);
    if (start != null) {
      if (firstTurnStart == null) {
        firstTurnStart = start;
      }
      lastTurnStart = start;
    }
    if (end != null) {
      lastTurnEnd = end;
    }
    if (typeof entry.permissionWaitMs === 'number' && Number.isFinite(entry.permissionWaitMs)) {
      permissionWaitTotal += entry.permissionWaitMs;
      sawPermissionWait = true;
    }
  }

  const positiveOrNull = (value: number | null): number | null =>
    value != null && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

  const durationMs =
    firstTurnStart != null && lastTurnEnd != null ? lastTurnEnd - firstTurnStart : null;
  const firstToLastTurnMs =
    firstTurnStart != null && lastTurnStart != null ? lastTurnStart - firstTurnStart : null;

  return {
    turn_count: turnCount,
    duration_ms: positiveOrNull(durationMs),
    first_to_last_turn_ms: positiveOrNull(firstToLastTurnMs),
    permission_wait_ms: sawPermissionWait ? Math.round(permissionWaitTotal) : null,
  };
};

type PermissionScanEntry = {
  requestId: string;
  requestKind: 'ask_user_question' | 'tool_permission';
  toolKind: ToolKind | null;
  hasOutcome: boolean;
  decision: 'allow' | 'deny' | 'cancelled' | 'other';
};

// Flatten every tool-call permission request currently in history so the
// permission funnel (shown -> responded) can be derived from CRDT state. Done
// by diffing snapshots (see the effect) rather than instrumenting the response
// handler in floating-permission-request.tsx: that component is owned elsewhere,
// and CRDT-derived state also covers permissions resolved on another client.
const scanPermissionRequests = (
  history: readonly SessionHistory[] | undefined
): PermissionScanEntry[] => {
  if (!history?.length) return [];
  const entries: PermissionScanEntry[] = [];
  for (const historyEntry of history) {
    if (historyEntry.role !== 'assistant') continue;
    const rawItems: unknown = historyEntry.items;
    if (!Array.isArray(rawItems)) continue;
    for (const rawItem of rawItems) {
      const item = rawItem as MessageContent;
      if (!item || item.type !== 'tool_call') continue;
      const permission = (item as ToolCallMessage).permissionRequest;
      if (!permission?.requestId) continue;
      const outcome = permission.outcome;
      let decision: PermissionScanEntry['decision'] = 'other';
      if (outcome) {
        if (outcome.outcome === 'cancelled') {
          decision = 'cancelled';
        } else if (outcome.outcome === 'selected') {
          const selected = permission.options.find((opt) => opt.optionId === outcome.optionId);
          const kind = selected?.kind ?? '';
          decision = kind.startsWith('allow')
            ? 'allow'
            : kind.startsWith('deny') || kind.startsWith('reject')
              ? 'deny'
              : 'other';
        }
      }
      entries.push({
        requestId: permission.requestId,
        requestKind: isAskUserQuestionPermissionMeta(permission._meta)
          ? 'ask_user_question'
          : 'tool_permission',
        toolKind: (item as ToolCallMessage).kind ?? null,
        hasOutcome: Boolean(outcome),
        decision,
      });
    }
  }
  return entries;
};

const countSearchBlockTypes = (blocks: readonly SessionSearchBlock[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const block of blocks) {
    counts[block.blockType] = (counts[block.blockType] ?? 0) + 1;
  }
  return counts;
};

const formatSessionDate = (value?: string, localeObj?: Locale) => {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return format(new Date(parsed), 'PPpp', { locale: localeObj });
};

const parseTimestamp = (value?: number | string | null): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
};

const isTrackableRunningStatusType = (statusType: SessionStatus['type'] | undefined): boolean => {
  return statusType === 'running' || statusType === 'requestPermission';
};

const STATUS_TONE_STYLES = {
  info: {
    text: 'text-primary',
    dot: 'bg-primary',
  },
  warn: {
    text: 'text-status-warning',
    dot: 'bg-status-warning',
  },
  success: {
    text: 'text-status-success',
    dot: 'bg-status-success',
  },
  error: {
    text: 'text-destructive',
    dot: 'bg-destructive',
  },
  neutral: {
    text: 'text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
} as const;

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;
type ToolKind = NonNullable<ToolCallMessage['kind']>;
type AgentActivity = 'thinking' | 'exploring' | 'writing' | 'imageGenerating';

const WRITING_TOOL_KINDS = new Set<ToolKind>(['edit', 'write', 'delete', 'move']);
const EXPLORING_TOOL_KINDS = new Set<ToolKind>([
  'read',
  'search',
  'fetch',
  'execute',
  'bash',
  'computer',
  'mcp',
]);
const THINKING_TOOL_KINDS = new Set<ToolKind>(['think', 'switch_mode', 'other']);

const isToolCallItem = (item: MessageContent): item is ToolCallMessage => item.type === 'tool_call';

const resolveActivityFromToolKind = (kind?: ToolKind | null): AgentActivity => {
  if (kind && WRITING_TOOL_KINDS.has(kind)) {
    return 'writing';
  }
  if (kind && EXPLORING_TOOL_KINDS.has(kind)) {
    return 'exploring';
  }
  if (kind && THINKING_TOOL_KINDS.has(kind)) {
    return 'thinking';
  }
  return 'thinking';
};

const resolveActivityFromItems = (items: MessageContent[]): AgentActivity => {
  let lastToolKind: ToolKind | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || !isToolCallItem(item)) {
      continue;
    }
    if (item.status === 'in_progress' || item.status === 'pending' || item.status === 'completed') {
      return resolveActivityFromToolKind(item.kind ?? null);
    }
    if (lastToolKind == null && item.kind) {
      lastToolKind = item.kind;
    }
  }
  return resolveActivityFromToolKind(lastToolKind);
};

const resolveActivityFromHistory = (history?: SessionHistory[]): AgentActivity => {
  if (!history?.length) {
    return 'thinking';
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.role !== 'assistant') {
      continue;
    }
    const items = Array.isArray(entry.items) ? (entry.items as unknown as MessageContent[]) : [];
    return resolveActivityFromItems(items);
  }
  return 'thinking';
};

const resolveActivityFromSessionStatus = (
  status: SessionStatus | undefined
): AgentActivity | null => {
  if (status?.type === 'running' && status.activity === 'image_generation') {
    return 'imageGenerating';
  }
  return null;
};

const resolveToneByStatus = (status: SessionStatus['type']) => {
  switch (status) {
    case 'running':
      return 'info';
    case 'initializing':
      return 'info';
    case 'requestPermission':
      return 'warn';
    case 'idle':
      return 'neutral';
  }
  return 'neutral';
};

interface SessionHistoryButtonProps {
  sessions: SessionMeta[];
  activeSessionId: SessionId;
  onSelectSession?: (sessionId: SessionId) => void;
  compact?: boolean;
}

export function SessionHistoryButton({
  sessions,
  activeSessionId,
  onSelectSession,
  compact = false,
}: SessionHistoryButtonProps) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const localeObj = i18n.language?.startsWith('zh') ? zhCN : enUS;
  const defaultSessionTitle = t('sessions.untitled', 'Untitled session');

  const historySessions = useMemo(() => {
    const map = new Map<SessionId, SessionMeta>();
    sessions.forEach((session) => {
      map.set(session.id, session);
    });
    return Array.from(map.values()).sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [sessions]);

  const handleSelect = useCallback(
    (sessionId: SessionId) => {
      if (sessionId === activeSessionId) {
        setOpen(false);
        return;
      }
      onSelectSession?.(sessionId);
      setOpen(false);
    },
    [activeSessionId, onSelectSession]
  );

  const trigger = (
    <Button
      variant={compact ? 'ghost' : 'outline'}
      size={compact ? 'icon' : 'sm'}
      className={cn('shrink-0', compact ? 'h-8 w-8' : '')}
      disabled={historySessions.length === 0}
    >
      <History className={cn('h-4 w-4', compact ? '' : 'mr-2')} />
      {!compact && <span>{t('sessions.history', 'History')}</span>}
    </Button>
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('sessions.history', 'History')}</SheetTitle>
          <p className="text-sm text-muted-foreground">{t('sessions.newSession.title')}</p>
        </SheetHeader>
        <div className="mt-6 space-y-2">
          {historySessions.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t('sessions.noSessions')}</div>
          ) : (
            historySessions.map((session) => {
              const sessionTitle = (session.title ?? '').trim() || defaultSessionTitle;
              const createdAtLabel = (() => {
                const parsed = Date.parse(session.createdAt);
                if (Number.isNaN(parsed)) return session.createdAt;
                return formatDistanceToNow(parsed, {
                  addSuffix: true,
                  locale: localeObj,
                });
              })();
              const tone = resolveToneByStatus(session.status?.type ?? 'running');
              const statusLabel = t(
                `sessions.status.${session.status?.type ?? 'running'}` as const
              );
              const isActive = session.id === activeSessionId;

              return (
                <button
                  key={session.id}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted',
                    isActive && 'border-border/70 bg-selection text-selection-foreground'
                  )}
                  onClick={() => handleSelect(session.id as SessionId)}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        'mt-1 h-2.5 w-2.5 rounded-full',
                        STATUS_TONE_STYLES[tone ?? 'info'].dot
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium">{sessionTitle}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{createdAtLabel}</span>
                        <span className="h-1 w-1 rounded-full bg-border" />
                        <span className="truncate">{statusLabel}</span>
                      </div>
                    </div>
                    {isActive && (
                      <Badge variant="secondary">{t('common.current', 'Current')}</Badge>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Compact project/repo + branch info for the session header */
export function SessionProjectInfo({
  session,
  isLoading,
  isSyncing,
  isMachineOffline,
  t,
  localProjectMeta,
}: {
  session: SessionMeta;
  isLoading?: boolean;
  isSyncing?: boolean;
  isMachineOffline?: boolean;
  t: (key: string, fallback: string) => string;
  localProjectMeta?: { name?: string; rootPath?: string } | null;
}) {
  const project = session.project as
    | { kind: 'github'; repoFullName?: string; branch?: string }
    | { kind: 'local'; localProjectId?: string; branch?: string; githubRepoFullName?: string }
    | undefined;
  const repoFullName = (resolveProjectGitHubRepo(project) ?? session.repoFullName)?.trim() ?? '';
  const branch =
    session.branchName?.trim() || getProjectRefBranch(project) || session.baseBranch?.trim() || '';
  const isGitHub = project?.kind === 'github' || !!repoFullName;
  const projectLabel = repoFullName || '';
  // Local projects: resolve name/path from machine metadata
  const localProjectName = localProjectMeta?.name ?? '';

  const hasProjectInfo = !!(projectLabel || localProjectName || branch);

  if (!hasProjectInfo) {
    return (
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5 text-sm leading-tight">
          <span className="inline-flex shrink-0 items-center text-muted-foreground">
            <MessageCircle className="h-3.5 w-3.5" />
          </span>
          <span className="truncate font-medium">{t('sessions.chat', 'Chat')}</span>
          {isLoading && (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              {t('common.loading', 'Loading')}
            </span>
          )}
          {isSyncing && <SessionSyncingIndicator />}
          {isMachineOffline && (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
              title={t('sessions.machineOffline', 'Machine is offline')}
            >
              <FamiconsCloudOfflineOutline className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-sm leading-tight">
        {(projectLabel || localProjectName) && (
          <span className="inline-flex shrink-0 items-center text-muted-foreground">
            {isGitHub ? <Github className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
          </span>
        )}
        <span className="truncate font-medium">{projectLabel || localProjectName || ''}</span>
        {isLoading && (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {t('common.loading', 'Loading')}
          </span>
        )}
        {isSyncing && <SessionSyncingIndicator />}
        {isMachineOffline && (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            title={t('sessions.machineOffline', 'Machine is offline')}
          >
            <FamiconsCloudOfflineOutline className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Owner-transfer state for the "···" menu. Only resolved on multi-member
 * workspaces — a solo workspace has nobody to hand the session to, so the
 * caller passes `undefined` and the submenu never renders.
 */
export type SessionOwnerMenuState = {
  members: WorkspaceMember[];
  /** Current `SessionMeta.userId`; may name someone who already left. */
  ownerUserId: string;
  onChangeOwner: (userId: string) => void | Promise<void>;
  /** Member whose write is still in flight — keeps the row from looking inert. */
  pendingUserId?: string | null;
};

/**
 * Navigation across the presentation-only "opened by" relationship (see
 * `lib/session-opened-by-tree.ts`). Both directions live here so an
 * MCP-opened independent Session can walk back to the Session that created it,
 * and an opener can reach every Session it opened, from inside the
 * conversation — not only from the sidebar tree.
 */
export type SessionOpenedByMenuState = {
  /** The Session that created this one, when it is still resolvable. */
  openedBy?: { sessionId: SessionId; title: string; target: SessionNavigationTarget } | null;
  /** Independent Sessions this Session opened, oldest first. */
  opened?: Array<{ sessionId: SessionId; title: string; target: SessionNavigationTarget }>;
  onOpenSession: (target: SessionNavigationTarget) => void;
};

/** Session header "···" menu — context, visibility, sharing, and session actions. */
export function SessionHeaderMenu({
  session,
  localProjectMeta,
  workspacePath,
  machineName,
  onCopyConversationHistory,
  onCopyUrl,
  sharing,
  onShareWithTeam,
  onOpenSearch,
  onFork,
  isForking = false,
  forkWorktreeAvailability = 'hidden',
  onForkMenuOpen,
  onRename,
  onOpenReviewSettings,
  owner,
  openedByRelations,
  onArchive,
  onRestore,
  onDelete,
  compact = false,
  t,
}: {
  session: SessionMeta;
  localProjectMeta?: { name?: string; rootPath?: string } | null;
  workspacePath?: string | null;
  /** Session machine display name — shown as an info row (moved here from the
   * old composer bottom bar so the composer stays a single footer row). */
  machineName?: string | null;
  onCopyConversationHistory?: () => void | Promise<void>;
  onCopyUrl: () => void | Promise<void>;
  sharing?: SessionSharingState;
  onShareWithTeam?: () => void | Promise<void>;
  onOpenSearch?: () => void | Promise<void>;
  onFork?: (destination?: SessionForkDestination) => void | Promise<void>;
  isForking?: boolean;
  forkWorktreeAvailability?: SessionForkWorktreeAvailability;
  onForkMenuOpen?: () => void;
  onRename?: () => void | Promise<void>;
  onOpenReviewSettings?: () => void;
  /** Multi-member workspaces only; omitted elsewhere. */
  owner?: SessionOwnerMenuState;
  /** Omitted when this Session neither opened nor was opened by another. */
  openedByRelations?: SessionOpenedByMenuState;
  onArchive?: () => void | Promise<void>;
  onRestore?: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  compact?: boolean;
  t: SessionSharingTranslator;
}) {
  const isArchived = !!session.isArchived;
  const project = session.project as
    | { kind: 'github'; repoFullName?: string; branch?: string }
    | { kind: 'local'; localProjectId?: string; branch?: string; githubRepoFullName?: string }
    | undefined;
  const repoFullName = (resolveProjectGitHubRepo(project) ?? session.repoFullName)?.trim() ?? '';
  const isGitHub = project?.kind === 'github' || !!repoFullName;
  const baseBranch = session.baseBranch?.trim() || getProjectRefBranch(project) || '';
  const currentBranch = session.branchName?.trim() || '';
  const showBranchInfo = Boolean(
    (isGitHub || project?.kind === 'local') && (baseBranch || currentBranch)
  );
  const localPath = localProjectMeta?.rootPath ?? '';
  const trimmedWorkspacePath = workspacePath?.trim() || '';
  const branchDisplayValue = currentBranch || baseBranch;
  const showBaseBranchContext = Boolean(
    currentBranch && baseBranch && currentBranch !== baseBranch
  );
  const showProjectPath = !showBranchInfo && Boolean(localPath);
  const showSessionContext = Boolean(
    (isGitHub && repoFullName) || showBranchInfo || showProjectPath || machineName || sharing
  );
  const shareActionDisabled =
    !onShareWithTeam ||
    sharing?.visibility === 'unknown' ||
    (sharing?.visibility === 'private' &&
      (sharing.privateReason === 'machine-not-registered' || !sharing.canManage));
  const [reviewSetupOpen, setReviewSetupOpen] = useState(false);

  const openedBySession = openedByRelations?.openedBy ?? null;
  const openedSessions = openedByRelations?.opened ?? [];
  const openedByRelationRows =
    openedByRelations && (openedBySession || openedSessions.length > 0) ? (
      <>
        {openedBySession ? (
          <DropdownMenuItem
            onClick={() => {
              openedByRelations.onOpenSession(openedBySession.target);
            }}
            title={openedBySession.title}
          >
            <CornerLeftUp className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {t('sessions.openedBy.openOpener', 'Opened by')}: {openedBySession.title}
            </span>
          </DropdownMenuItem>
        ) : null}
        {openedSessions.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <GitBranchPlus className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {t('sessions.openedBy.openedSessions', 'Opened sessions')} ({openedSessions.length})
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 min-w-[200px] max-w-[280px] overflow-y-auto">
              {openedSessions.map((opened) => (
                <DropdownMenuItem
                  key={opened.sessionId}
                  onClick={() => {
                    openedByRelations.onOpenSession(opened.target);
                  }}
                  title={opened.title}
                >
                  <span className="min-w-0 flex-1 truncate">{opened.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
      </>
    ) : null;

  const copyToClipboard = useCallback(
    // successMessage names what was copied in a full sentence (e.g. "Base
    // branch name copied to clipboard") — no raw value echo, which reads
    // noisy for long paths/URLs.
    (text: string, successMessage: string) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => toast.success(successMessage))
        .catch(() => toast.error(t('sessions.copyFailed', 'Unable to copy')));
    },
    [t]
  );

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) onForkMenuOpen?.();
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground"
            aria-label={t('sessions.moreActions', 'More actions')}
          >
            <Ellipsis className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[200px] max-w-[320px]">
          {/* One compact context group keeps useful identity visible. Separate labels make
              every value pay for two rows, while a submenu hides context behind another step. */}
          {!compact && showSessionContext ? (
            <>
              <DropdownMenuLabel className="pb-0.5 pt-1.5 text-[0.7rem] font-medium text-muted-foreground">
                {t('sessions.sessionContextLabel', 'Session')}
              </DropdownMenuLabel>

              {isGitHub && repoFullName ? (
                <DropdownMenuItem
                  className="py-1.5"
                  onClick={() =>
                    copyToClipboard(
                      repoFullName,
                      t('sessions.repoCopied', 'Repository name copied to clipboard')
                    )
                  }
                  title={repoFullName}
                  aria-label={`${t('sessions.copyRepository', 'Copy repository')}: ${repoFullName}`}
                >
                  <Github className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{repoFullName}</span>
                  <Copy className="ml-auto h-3 w-3 shrink-0 opacity-50" />
                </DropdownMenuItem>
              ) : null}

              {showBranchInfo ? (
                <DropdownMenuItem
                  className="items-start py-1.5"
                  onClick={() =>
                    copyToClipboard(
                      branchDisplayValue,
                      currentBranch
                        ? t(
                            'sessions.currentBranchCopied',
                            'Current branch name copied to clipboard'
                          )
                        : t('sessions.baseBranchCopied', 'Base branch name copied to clipboard')
                    )
                  }
                  title={
                    showBaseBranchContext
                      ? `${branchDisplayValue}\n${t(
                          'sessions.baseBranch',
                          'Base branch'
                        )}: ${baseBranch}`
                      : branchDisplayValue
                  }
                  aria-label={`${
                    currentBranch
                      ? t('sessions.copyCurrentBranch', 'Copy current branch')
                      : t('sessions.copyBaseBranch', 'Copy base branch')
                  }: ${branchDisplayValue}`}
                >
                  <GitBranch className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{branchDisplayValue}</span>
                    {showBaseBranchContext ? (
                      <span className="block truncate text-[0.68rem] leading-4 text-muted-foreground">
                        {t('sessions.baseBranch', 'Base branch')}: {baseBranch}
                      </span>
                    ) : null}
                  </span>
                  <Copy className="ml-auto mt-0.5 h-3 w-3 shrink-0 opacity-50" />
                </DropdownMenuItem>
              ) : showProjectPath ? (
                <DropdownMenuItem
                  className="py-1.5"
                  onClick={() =>
                    copyToClipboard(
                      localPath,
                      t('sessions.projectPathCopied', 'Project path copied to clipboard')
                    )
                  }
                  title={localPath}
                  aria-label={`${t('sessions.copyProjectPath', 'Copy project path')}: ${localPath}`}
                >
                  <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{localPath}</span>
                  <Copy className="ml-auto h-3 w-3 shrink-0 opacity-50" />
                </DropdownMenuItem>
              ) : null}

              {machineName ? (
                <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[0.8rem]">
                  <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="sr-only">{t('sessions.machineLabel', 'Machine')}: </span>
                  <span className="min-w-0 flex-1 truncate">{machineName}</span>
                  {project?.kind === 'local' ? (
                    <span className="ml-auto shrink-0 rounded border border-border/70 px-1 py-px text-[0.62rem] font-medium leading-none text-muted-foreground">
                      {session.isWorktree
                        ? t('chat.workdir.worktree', 'Worktree')
                        : t('chat.workdir.local', 'Local')}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {sharing ? (
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[0.8rem]">
                      {sharing.visibility === 'team' ? (
                        <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : sharing.visibility === 'private' ? (
                        <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {getSessionSharingLabel(t, sharing)}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-64 px-2.5 py-2 text-xs">
                    {getSessionSharingDescription(t, sharing)}
                  </TooltipContent>
                </Tooltip>
              ) : null}

              <DropdownMenuSeparator />
            </>
          ) : null}

          {openedByRelationRows}

          {onOpenSearch && (
            <DropdownMenuItem
              onClick={() => {
                void onOpenSearch();
              }}
            >
              <Search className="h-3.5 w-3.5 shrink-0" />
              {t('sessions.findInConversation', 'Find in session')}
            </DropdownMenuItem>
          )}

          {onFork && !isArchived && forkWorktreeAvailability !== 'hidden' ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={isForking}>
                {isForking ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : (
                  <GitFork className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {t('sessions.forkSession', 'Fork session')}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[16rem]">
                {getSessionForkDestinationOptions(t, forkWorktreeAvailability).map((option) => (
                  <DropdownMenuItem
                    key={option.id}
                    disabled={option.disabled || isForking}
                    className="items-start py-1.5"
                    onSelect={() => {
                      void onFork(option.id);
                    }}
                  >
                    {option.id === 'new-worktree' ? (
                      <WorktreeIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <Folder className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="leading-tight">{option.label}</span>
                      <span className="text-xs font-normal leading-snug text-muted-foreground">
                        {option.hint}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : onFork && !isArchived ? (
            <DropdownMenuItem
              disabled={isForking}
              onClick={() => {
                if (!isForking) {
                  void onFork('shared');
                }
              }}
            >
              {isForking ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <GitFork className="h-3.5 w-3.5 shrink-0" />
              )}
              {t('sessions.forkSession', 'Fork session')}
            </DropdownMenuItem>
          ) : null}

          {onRename && !isArchived && (
            <DropdownMenuItem
              onClick={() => {
                void onRename();
              }}
            >
              <Pencil className="h-3.5 w-3.5 shrink-0" />
              {t('sidebar.renameChat.title', 'Rename Chat')}
            </DropdownMenuItem>
          )}

          {owner && !isArchived ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <UserRoundCog className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {t('sessions.owner.change', 'Change owner')}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 min-w-[200px] max-w-[280px] overflow-y-auto">
                {owner.members.map((member) => {
                  const isOwner = member.userId === owner.ownerUserId;
                  const isPending = owner.pendingUserId === member.userId;
                  return (
                    <DropdownMenuItem
                      key={member.userId}
                      disabled={owner.pendingUserId != null}
                      onClick={() => {
                        // Guard in the handler, not just via `disabled`: the
                        // menu stays mounted while the write is in flight.
                        if (isOwner || owner.pendingUserId != null) return;
                        void owner.onChangeOwner(member.userId);
                      }}
                      title={member.email ?? member.name}
                    >
                      <UserAvatar
                        user={{ id: member.userId, name: member.name, image: member.image }}
                        className="h-4 w-4 shrink-0"
                        fallbackClassName="text-[0.55rem]"
                      />
                      <span className="min-w-0 flex-1 truncate">{member.name}</span>
                      {isPending ? (
                        <Loader2 className="ml-auto h-3.5 w-3.5 shrink-0 animate-spin" />
                      ) : isOwner ? (
                        <Check className="ml-auto h-3.5 w-3.5 shrink-0" />
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}

          {/* Copy URL stays in the Copy submenu even for private sessions (the
              link still works for the owner); sharing is a separate action that
              only appears while the conversation isn't team-visible. */}
          {sharing && sharing.visibility !== 'team' ? (
            <DropdownMenuItem
              disabled={shareActionDisabled}
              onClick={() => {
                void onShareWithTeam?.();
              }}
            >
              {sharing.visibility === 'unknown' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : sharing.privateReason === 'machine-not-registered' ? (
                <Monitor className="h-3.5 w-3.5 shrink-0" />
              ) : sharing.canManage ? (
                <Users className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
              )}
              {sharing.visibility === 'unknown'
                ? t('sessions.sharing.loadingAction', 'Checking sharing…')
                : sharing.privateReason === 'machine-not-registered'
                  ? t(
                      'sessions.sharing.registerDeviceToShare',
                      'Register this device before sharing'
                    )
                  : sharing.canManage
                    ? t('sessions.sharing.shareWithTeam', 'Share with team…')
                    : t('sessions.sharing.onlyOwnerCanShare', 'Only the device owner can share')}
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Copy className="h-3.5 w-3.5 shrink-0" />
              {t('sessions.copy', 'Copy')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[200px]">
              {showBaseBranchContext ? (
                <>
                  <DropdownMenuItem
                    onClick={() =>
                      copyToClipboard(
                        baseBranch,
                        t('sessions.baseBranchCopied', 'Base branch name copied to clipboard')
                      )
                    }
                    title={baseBranch}
                  >
                    <GitBranch className="h-3.5 w-3.5 shrink-0" />
                    {t('sessions.copyBaseBranch', 'Copy base branch')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuItem
                onClick={() =>
                  copyToClipboard(
                    trimmedWorkspacePath,
                    t('sessions.workspacePathCopied', 'Session workspace path copied to clipboard')
                  )
                }
                disabled={!trimmedWorkspacePath}
                title={
                  trimmedWorkspacePath ||
                  t('sessions.copyPathUnavailable', 'Workspace path unavailable')
                }
              >
                <Copy className="h-3.5 w-3.5 shrink-0" />
                {t('sessions.copyPath', 'Copy path')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  void onCopyConversationHistory?.();
                }}
                disabled={!onCopyConversationHistory}
                title={
                  onCopyConversationHistory
                    ? undefined
                    : t(
                        'sessions.copyConversationHistoryUnavailable',
                        'Conversation history is unavailable for this tab'
                      )
                }
              >
                <Copy className="h-3.5 w-3.5 shrink-0" />
                {t('sessions.copyAsMarkdown', 'Copy as Markdown')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  void onCopyUrl();
                }}
              >
                <Copy className="h-3.5 w-3.5 shrink-0" />
                {t('sessions.copyUrl', 'Copy URL')}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <AutoReviewMenuItem
            sessionId={session.id}
            meta={session}
            onConfigurationRequired={() => setReviewSetupOpen(true)}
          />

          {/* Archive / Restore + Delete */}
          {isArchived
            ? (onRestore || onDelete) && (
                <>
                  <DropdownMenuSeparator />
                  {onRestore && (
                    <DropdownMenuItem
                      onClick={() => {
                        void onRestore();
                      }}
                    >
                      <ArchiveRestore className="h-3.5 w-3.5 shrink-0" />
                      {t('archive.restore', 'Restore session')}
                    </DropdownMenuItem>
                  )}
                  {onDelete && (
                    <DropdownMenuItem
                      onClick={() => {
                        void onDelete();
                      }}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5 shrink-0" />
                      {t('archive.delete', 'Delete permanently')}
                    </DropdownMenuItem>
                  )}
                </>
              )
            : onArchive && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      void onArchive();
                    }}
                  >
                    <Archive className="h-3.5 w-3.5 shrink-0" />
                    {t('sessions.archive', 'Archive session')}
                  </DropdownMenuItem>
                </>
              )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ReviewAgentSetupDialog
        open={reviewSetupOpen}
        onOpenChange={setReviewSetupOpen}
        machineName={machineName ?? undefined}
        onOpenSettings={() => onOpenReviewSettings?.()}
      />
    </>
  );
}

export function SessionSearchBar({
  query,
  currentIndex,
  totalCount,
  inputRef,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
  t,
}: {
  query: string;
  currentIndex: number;
  totalCount: number;
  inputRef: { current: HTMLInputElement | null };
  onQueryChange: (value: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  t: (key: string, fallback: string, vars?: Record<string, unknown>) => string;
}) {
  const hasQuery = query.length > 0;
  const hasResults = totalCount > 0;
  const noResults = hasQuery && !hasResults;

  const countLabel = hasResults
    ? t('sessions.searchResultPosition', '{{current}} / {{total}}', {
        current: currentIndex + 1,
        total: totalCount,
      })
    : hasQuery
      ? t('sessions.searchNoResults', 'No results')
      : '';

  const renderNavButton = (
    Icon: typeof ArrowUp,
    label: string,
    shortcut: string,
    onClick: () => void
  ) => {
    const button = (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/40"
        disabled={!hasResults}
        onClick={onClick}
        aria-label={label}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
      </Button>
    );
    if (!hasResults) return button;
    return (
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="bottom" className="flex items-center gap-1.5 px-2 py-1 text-[11px]">
          <span>{label}</span>
          <span className="rounded-sm border border-border/70 bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground">
            {shortcut}
          </span>
        </TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-20 w-[min(440px,calc(100%-1.5rem))] sm:right-4 sm:top-4 sm:w-[min(440px,calc(100%-2rem))]">
      <div
        role="search"
        className={cn(
          'group/search flex h-11 items-center gap-1 rounded-full border bg-background/95 pl-3.5 pr-1.5 shadow-[0_14px_40px_-18px_rgba(15,23,42,0.45),0_2px_10px_-4px_rgba(15,23,42,0.16)] backdrop-blur-md transition-colors supports-[backdrop-filter]:bg-background/85',
          'border-border focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20',
          noResults &&
            'border-destructive/30 focus-within:border-destructive/60 focus-within:ring-destructive/15'
        )}
      >
        <Search
          className={cn(
            'h-4 w-4 shrink-0 transition-colors',
            hasQuery ? 'text-foreground' : 'text-muted-foreground/80',
            noResults && 'text-destructive/80'
          )}
          strokeWidth={2.25}
        />
        <Input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('sessions.findInConversation', 'Find in session')}
          aria-label={t('sessions.findInConversation', 'Find in session')}
          className="h-9 min-w-0 flex-1 border-0 bg-transparent px-2 py-0 text-[13.5px] tracking-tight shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 [&::-webkit-search-cancel-button]:hidden"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (event.shiftKey) {
                onPrevious();
              } else {
                onNext();
              }
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              if (query) {
                onQueryChange('');
                return;
              }
              onClose();
            }
          }}
        />

        {hasQuery && (
          <span
            className={cn(
              'shrink-0 select-none px-1 text-[11.5px] font-medium tabular-nums tracking-tight transition-colors',
              hasResults ? 'text-muted-foreground' : 'text-destructive/90'
            )}
            aria-live="polite"
          >
            {countLabel}
          </span>
        )}

        <Separator orientation="vertical" className="mx-0.5 h-5 bg-border/60" />

        <div className="flex items-center gap-px">
          {renderNavButton(
            ArrowUp,
            t('sessions.previousResult', 'Previous result'),
            '⇧↵',
            onPrevious
          )}
          {renderNavButton(ArrowDown, t('sessions.nextResult', 'Next result'), '↵', onNext)}
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                onClick={onClose}
                aria-label={t('common.close', 'Close')}
              >
                <X className="h-3.5 w-3.5" strokeWidth={2.25} />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              className="flex items-center gap-1.5 px-2 py-1 text-[11px]"
            >
              <span>{t('common.close', 'Close')}</span>
              <span className="rounded-sm border border-border/70 bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground">
                Esc
              </span>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

interface SessionChatInterfaceProps {
  claimNavigationFocus?: () => boolean;
  session: SessionMeta;
  workspaceSession?: SessionMeta | null;
  className?: string;
  hideHeader?: boolean;
  onFileDiffClick?: (turnId: string, filePath: string) => void;
  onFilePathClick?: (filePath: string) => void;
  /** Opens an agent-uploaded HTML source path directly in rendered file preview. */
  onOpenHtmlFile?: (filePath: string) => void;
  messageFileDiffEntriesByTurn?: MessageFileDiffEntriesByTurn;
  /** Optional replacement for the GitHub badge area in the header. */
  headerActionsSlot?: React.ReactNode;
  /** Optional action rendered after the session menu at the far right of the header. */
  headerEndSlot?: React.ReactNode;
  /** Optional action rendered before the session title at the far left of the header. */
  headerStartSlot?: React.ReactNode;
  /** Optional override for split header/message layouts where another surface owns doc sync. */
  titleSyncing?: boolean;
  /** Content rendered between the header and message area (e.g. tab bar) */
  subHeader?: React.ReactNode;
  /** When true, hide the message area and input but keep the header and subHeader visible */
  hideMessageArea?: boolean;
  /** When false, keep the local doc mounted without holding the remote room subscription. */
  syncEnabled?: boolean;
  /**
   * Whether this mounted surface is actually on screen. Session tabs and side
   * chats stay mounted while hidden, so the read receipt must be gated on real
   * visibility: otherwise opening a parent session marks every one of its
   * sub-sessions read without the user ever seeing them.
   */
  isVisible?: boolean;
  /** External imported history is refreshing; input remains editable but sending is blocked. */
  isExternalHistoryRefreshing?: boolean;
  /** Display label for the external history provider currently refreshing. */
  externalHistoryProviderLabel?: string;
  /** Called when a comment reference chip is clicked to navigate to the comment in diff */
  onNavigateToComment?: (reference: CommentReferencePayload) => void;
  /** Called whenever comment references attached to the input change. */
  onCommentReferencesChange?: (references: CommentReferencePayload[]) => void;
  /** Called whenever visual annotation references attached to the input change. */
  onVisualAnnotationReferencesChange?: (references: VisualAnnotationReferencePayload[]) => void;
  /** Called after a send containing visual annotation references is accepted. */
  onVisualAnnotationReferencesSubmitted?: (
    references: VisualAnnotationReferencePayload[]
  ) => void | Promise<void>;
  /** Explicitly marks this as a child tab session (shows guided landing instead of empty state) */
  isChildTab?: boolean;
  /** Title of the parent session, used in child tab empty state */
  parentSessionTitle?: string;
  /** Called to archive the current session */
  onArchiveSession?: () => void | Promise<void>;
  /** Called to restore the current session when it is archived */
  onRestoreSession?: () => void | Promise<void>;
  /** Called to permanently delete the current session when it is archived */
  onDeleteSession?: () => void | Promise<void>;
  /** External callback for opening search (used when header and message area are split) */
  onOpenSearch?: () => void | Promise<void>;
  /** External callback for copying conversation history (used when header and message area are split) */
  onCopyConversationHistory?: () => void | Promise<void>;
  /** External rename request for split header/message layouts. */
  onRequestRename?: () => void | Promise<void>;
  /** External latest-assistant fork callback for split header/message layouts. */
  onForkSession?: (destination?: SessionForkDestination) => void | Promise<void>;
  /** Effective team/private visibility for the session shown in the header menu. */
  sharing?: SessionSharingState;
  /** Request the parent-owned confirmation flow for a private session. */
  onShareWithTeam?: () => void | Promise<void>;
  /** Called when the user clicks the PR badge and wants to open the in-app PR tab. */
  onOpenPrTab?: (args: { prNumber: number; repoFullName: string; headCommitSha?: string }) => void;
  /** Session associated with the header Browser button. Defaults to `session`. */
  browserActionSession?: SessionMeta | null;
  /** Called when the user wants to open the Browser panel. */
  onOpenBrowser?: () => void;
  /** Opens Browser without forcing a newly reported candidate navigation. */
  onOpenExistingBrowser?: () => void;
  /**
   * 'page' renders the classic full header row. 'toolbar' (desktop
   * `hideMessageArea` instance) renders ONLY the compact right-side controls
   * (IDE launcher / browser / "…" menu / end slot) so session-detail can embed
   * them in the tab row — no title, no PR badge (the context strip owns PR).
   */
  headerVariant?: 'page' | 'toolbar';
  /**
   * When false, this surface still accepts a session-mention drop but does not
   * paint the page mask. Used under `SessionMentionDropLayer`, which owns one
   * overlay for the whole keep-alive tab stack.
   */
  paintSessionMentionOverlay?: boolean;
  /** All-Changes totals for the context strip; null/undefined hides the diffstat. */
  changesDiffStat?: { add: number; del: number } | null;
  /** Called when the context strip's diffstat is clicked. */
  onOpenAllChanges?: () => void;
  /** Native ACP fork action for the latest completed assistant turn. */
  onForkLastAssistant?: (turnId: string, destination?: SessionForkDestination) => void;
  forkWorktreeAvailability?: SessionForkWorktreeAvailability;
  onForkWorktreeMenuOpen?: () => void;
  forkingAssistantMessageId?: string | null;
  /** Opens another session from an in-conversation link (e.g. a fork's origin). */
  onNavigateSession?: (target: SessionNavigationTarget) => void;
  /** Signals when this mounted conversation surface has loaded durable history. */
  onConversationPrepared?: () => void;
  /** Signals a terminal failure while preparing this conversation surface. */
  onConversationPrepareError?: () => void;
}

function SpinningLoaderIcon({ className }: { className?: string }) {
  return <Loader2 className={cn(className, 'animate-spin')} />;
}

const EMPTY_CHAT_STREAM_EMPTY_STATE = <></>;

export type SessionChatInterfaceHandle = {
  focusInput: () => void;
  addCommentReference: (reference: CommentReferencePayload) => boolean;
  toggleCommentReference: (reference: CommentReferencePayload) => boolean;
  addVisualAnnotationReference: (reference: VisualAnnotationReferencePayload) => boolean;
  toggleVisualAnnotationReference: (reference: VisualAnnotationReferencePayload) => boolean;
  copyConversationHistory: () => Promise<void>;
  openSearch: () => void;
  getLastAssistantTurnId: () => string | null;
  insertSessionMention: (sessionId: string) => boolean;
};

export type DispatchInputBlocksOptions = {
  forceQueue?: boolean;
  forceDirect?: boolean;
  modeIdOverride?: string | null;
  modelIdOverride?: string | null;
  configOptionValuesOverride?: Record<string, AcpConfigOptionValue>;
  /** Role identity frozen beside this Turn's run config; null is explicit None. */
  agentRole?: SessionTurnAgentRoleSelection;
};

function buildEditedMessageQueueItem(
  item: MessageQueueItem,
  task: string,
  imageOnlyLabel: string
): MessageQueueItem {
  const nextTask = task.trim();
  const inputBlocks = normalizeSessionInputBlocks(
    item.acpSessionConfig?.inputBlocks,
    item.acpSessionConfig?.prompt ?? item.task
  );
  const nonTextInputBlocks: SessionInputBlock[] = inputBlocks.filter(
    (block) => block.type !== 'text'
  );
  const nextInputBlocks: SessionInputBlock[] = nextTask
    ? [{ type: 'text', text: nextTask }, ...nonTextInputBlocks]
    : nonTextInputBlocks;

  if (!item.acpSessionConfig) {
    return {
      ...item,
      task: nextTask || imageOnlyLabel,
      isEditing: false,
      editingStartedAt: undefined,
    };
  }

  return {
    ...item,
    task: nextTask || imageOnlyLabel,
    isEditing: false,
    editingStartedAt: undefined,
    acpSessionConfig: {
      ...item.acpSessionConfig,
      prompt: nextTask,
      inputBlocks: nextInputBlocks.length > 0 ? nextInputBlocks : undefined,
    },
  };
}

/**
 * Session chat interface component
 * Only loads the active session document; allows switching history from the header.
 */
export const SessionChatInterface = memo(
  forwardRef<SessionChatInterfaceHandle, SessionChatInterfaceProps>(function SessionChatInterface(
    {
      session,
      workspaceSession,
      className,
      hideHeader = false,
      onFileDiffClick,
      onFilePathClick,
      onOpenHtmlFile,
      messageFileDiffEntriesByTurn,
      headerActionsSlot,
      headerEndSlot,
      headerStartSlot,
      titleSyncing,
      subHeader,
      hideMessageArea = false,
      syncEnabled = !hideMessageArea,
      isVisible = true,
      claimNavigationFocus,
      isExternalHistoryRefreshing = false,
      externalHistoryProviderLabel,
      onNavigateToComment,
      onCommentReferencesChange,
      onVisualAnnotationReferencesChange,
      onVisualAnnotationReferencesSubmitted,
      isChildTab = false,
      onArchiveSession,
      onRestoreSession,
      onDeleteSession,
      onOpenSearch: onOpenSearchExternal,
      onCopyConversationHistory: onCopyConversationHistoryExternal,
      onRequestRename,
      onForkSession: onForkSessionExternal,
      sharing,
      onShareWithTeam,
      onOpenPrTab,
      browserActionSession,
      onOpenBrowser,
      onOpenExistingBrowser,
      headerVariant = 'page',
      paintSessionMentionOverlay = true,
      changesDiffStat,
      onOpenAllChanges,
      onForkLastAssistant,
      forkWorktreeAvailability = 'hidden',
      onForkWorktreeMenuOpen,
      forkingAssistantMessageId,
      onNavigateSession,
      onConversationPrepared,
      onConversationPrepareError,
    },
    ref
  ) {
    /* Mount/unmount into the crash-report render trace. The 0.89.x #185 crash
       ends in this component's mount layout effects — a LAYOUT effect (passive
       ones may never flush inside the crashing cascade) is what proves whether
       the loop is remounting this surface or lives elsewhere. */
    useLayoutEffect(() => {
      recordSessionRenderTrace(`surface mount ${shortTraceId(session.id)}`);
      return () => {
        recordSessionRenderTrace(`surface unmount ${shortTraceId(session.id)}`);
      };
    }, [session.id]);
    const { t, i18n } = useTranslation();
    const isMobile = useIsMobile();
    const isNativeApp = isNativeAppShell();
    const hidesBillingUi = isMobile || isNativeApp;
    const isElectronFullscreen = useElectronFullscreen();
    const resolvedTheme = useResolvedTheme();
    const isDark = resolvedTheme === 'dark';
    const postHog = usePostHog();
    const localeObj = i18n.language?.startsWith('zh') ? zhCN : enUS;
    const workspaceId = useAtomValue(currentWorkspaceIdAtom);
    const currentUser = useAtomValue(userAtom);
    const tasksEnabled = useAtomValue(tasksFeatureEnabledAtom);
    const { openSettings } = useOpenSettings();
    const billingEntitlement = useCloudQuery(
      cloudOperations.billing.getWorkspaceBillingEntitlement,
      workspaceId ? { workspaceId } : 'skip'
    );
    const conversationFontSize = useAtomValue(conversationFontSizeAtom);
    const analyticsSessionProject = session.project;
    const analyticsSessionProjectKind = analyticsSessionProject?.kind ?? null;
    const analyticsSessionProjectRepoFullName =
      analyticsSessionProject?.kind === 'github' ? analyticsSessionProject.repoFullName : null;
    const analyticsSessionProjectGithubRepoFullName =
      analyticsSessionProject?.kind === 'local'
        ? (analyticsSessionProject.githubRepoFullName ?? null)
        : null;
    const analyticsSessionProjectLocalProjectId =
      analyticsSessionProject?.kind === 'local'
        ? (analyticsSessionProject.localProjectId ?? null)
        : null;
    const sessionAnalyticsProject = useMemo(
      () =>
        getSessionAnalyticsProject({
          kind: analyticsSessionProjectKind,
          repoFullName: analyticsSessionProjectRepoFullName,
          githubRepoFullName: analyticsSessionProjectGithubRepoFullName,
          localProjectId: analyticsSessionProjectLocalProjectId,
          sessionRepoFullName: session.repoFullName,
        }),
      [
        analyticsSessionProjectGithubRepoFullName,
        analyticsSessionProjectKind,
        analyticsSessionProjectLocalProjectId,
        analyticsSessionProjectRepoFullName,
        session.repoFullName,
      ]
    );
    const sessionAnalyticsProperties = useMemo(
      () => ({
        session_id: session.id,
        workspace_id: workspaceId ?? null,
        machine_id: session.machineId,
        agent_config_id: session.agentConfigId ?? null,
        cli_type: session.cliType,
        agent_type: session.agentType,
        is_mobile: isMobile,
        is_child_session: isChildTab || Boolean(session.parentSessionId),
        parent_session_id: session.parentSessionId ?? null,
        ...sessionAnalyticsProject,
      }),
      [
        isChildTab,
        isMobile,
        session.agentConfigId,
        session.agentType,
        session.cliType,
        session.id,
        session.machineId,
        session.parentSessionId,
        sessionAnalyticsProject,
        workspaceId,
      ]
    );
    const captureSessionEvent = useCallback(
      (event: string, properties?: Record<string, unknown>) => {
        capturePostHogEvent(postHog, event, {
          ...sessionAnalyticsProperties,
          ...properties,
        });
      },
      [postHog, sessionAnalyticsProperties]
    );

    const localMachineId = useAtomValue(localMachineIdAtom);
    const localHomeDir = useAtomValue(localHomeDirAtom);
    const liveSessionPresence = useAtomValue(sessionLivePresenceAtomFamily(session.id));
    const liveSessionStatus = liveSessionPresence?.status ?? null;
    const isLocalSession = !!localMachineId && session.machineId === localMachineId;
    const [pendingRemoteHtmlFileName, setPendingRemoteHtmlFileName] = useState<string | null>(null);
    const {
      doc: sessionDoc,
      addHistory: addSessionHistory,
      pushMessageQueue,
      removeMessageQueueItem,
      updateMessageQueueItem,
      reorderMessageQueueItem,
      updateHistoryEntry,
      waitUntilSynced,
      ready: sessionDocReady,
      synced: sessionDocSynced,
      syncState: sessionDocSyncState,
    } = useSessionDoc(session.id, {
      enabled: !hideMessageArea,
      syncEnabled: !hideMessageArea && syncEnabled,
    });
    const sessionConversationConfig = useMemo(
      () => resolveSessionConversationConfig(sessionDoc?.history ?? [], sessionDoc?.mq ?? []),
      [sessionDoc?.history, sessionDoc?.mq]
    );
    const sessionConversationSourceFence = useMemo(
      () => resolveSessionConversationSourceFence(sessionDoc?.history ?? [], sessionDoc?.mq ?? []),
      [sessionDoc?.history, sessionDoc?.mq]
    );
    const sessionRuntimeConfig = useMemo(
      () =>
        resolveSessionAcpRuntimeConfig(
          sessionDoc?.history ?? [],
          sessionDoc?.mq ?? [],
          sessionDoc?.acpRuntimeConfig
        ),
      [sessionDoc?.acpRuntimeConfig, sessionDoc?.history, sessionDoc?.mq]
    );
    // `sourceConfigKey` identifies the durable turn selected by the resolver,
    // so there is no need to hash its mode/model/option values separately.
    const sessionConversationConfigRevision = `${session.id}:${
      sessionConversationConfig.sourceConfigKey ?? ''
    }`;
    const sessionConfigPreferences = useMemo(
      () => ({
        modeId: sessionConversationConfig.modeId,
        modelId: sessionConversationConfig.modelId,
        configOptionValues: sessionConversationConfig.configOptionValues,
      }),
      [
        sessionConversationConfig.configOptionValues,
        sessionConversationConfig.modeId,
        sessionConversationConfig.modelId,
      ]
    );
    /* No effects here: user edits are the only stored selection state and the
       effective values derive per render. The UNVALIDATED candidates feed the
       capability lookup so the catalog can depend on the selection (Codex
       reasoning tiers, provisional menu enrichment) without feeding back into
       the values it validates — the #185 reconcile loop is unrepresentable. */
    const {
      selection: sessionConfigSelection,
      candidates: sessionConfigCandidates,
      hasUserEdits: sessionRunConfigHasUserEdits,
      selectMode: handleModeChange,
      selectModel: handleModelChange,
      selectConfigOption: handleConfigOptionChange,
    } = useAcpSessionConfigSelectionState({
      enabled: !hideMessageArea && sessionDocReady,
      targetKey: `${session.id}:${session.cliType}:${session.agentType}`,
      preferenceRevision: sessionConversationConfigRevision,
      preferences: sessionConfigPreferences,
      runtimePreferences: sessionRuntimeConfig,
      preserveUnsentUserEdits: true,
    });
    const {
      availableCommands,
      capabilityAuthority,
      configOptionSelectors,
      defaultModeId,
      defaultModelId,
      machineFlockRows,
      modeOptions,
      modelOptions,
      sessionMachine,
    } = useSessionAcpSelectorContext({
      machineId: session.machineId,
      configId: session.agentConfigId,
      cliType: session.cliType,
      agentType: session.agentType,
      selectedModeId: sessionConfigCandidates.modeId,
      selectedModelId: sessionConfigCandidates.modelId,
      configOptionValues: sessionConfigCandidates.configOptionValues,
    });
    const sessionSelectorOptions = useMemo(
      () => ({
        capabilityAuthority,
        configOptionSelectors,
        defaultModeId,
        defaultModelId,
        modeOptions,
        modelOptions,
      }),
      [
        capabilityAuthority,
        configOptionSelectors,
        defaultModeId,
        defaultModelId,
        modeOptions,
        modelOptions,
      ]
    );
    const { selectedModeId, selectedModelId, configOptionValues } =
      useResolvedAcpSessionConfigSelection(sessionConfigSelection, sessionSelectorOptions, {
        cliType: session.cliType,
        agentType: session.agentType,
      });
    useMachineFlockAgentConfigsForMachineIds([session.machineId]);
    const machineDotlodyPath = useMemo(
      () => resolveMachineDotlodyPath(machineFlockRows, isLocalSession ? localHomeDir : null),
      [isLocalSession, localHomeDir, machineFlockRows]
    );
    const sessionMachineLocalProjects = useMemo(
      () => ({
        ...(sessionMachine?.localProjects ?? {}),
        ...getMachineFlockLocalProjects(machineFlockRows),
      }),
      [machineFlockRows, sessionMachine?.localProjects]
    );
    // Two distinct machine states, previously conflated:
    // - removed: machine meta no longer exists (deleted from the workspace).
    //   Blocks sending. Gated on doc-meta cache readiness so a cold start
    //   never mistakes "meta not loaded yet" for "machine gone".
    // - offline: presence heartbeat missing. Informational only — the turn is
    //   written durably and runs when the machine reconnects.
    const docMetaCacheReady = useAtomValue(docMetaCacheReadyAtom);
    const isMachineRemoved = !sessionMachine && docMetaCacheReady;
    const sessionMachineOnlineStatus = useMachineOnlineStatus(session.machineId);
    const browserOnline = useAtomValue(browserOnlineAtom);
    const externalHistorySyncLabel = isExternalHistoryRefreshing
      ? t('sessions.externalHistorySyncing', {
          defaultValue: 'Syncing {{provider}} history',
          provider: externalHistoryProviderLabel ?? 'external',
        })
      : undefined;
    // Resolve local project metadata for header display
    const resolvedLocalProjectMeta = useMemo(() => {
      const proj = session.project as { kind?: string; localProjectId?: string } | undefined;
      if (proj?.kind !== 'local' || !proj.localProjectId) return null;
      return sessionMachineLocalProjects[proj.localProjectId as LocalProjectId] ?? null;
    }, [session.project, sessionMachineLocalProjects]);
    const sessionWorkspacePath = useMemo(() => {
      return resolveSessionWorkspacePath({
        sessionId: session.id,
        ownerSessionId: session.parentSessionId,
        isWorktree: session.isWorktree,
        dotlodyPath: machineDotlodyPath,
        localProjectRootPath: resolvedLocalProjectMeta?.rootPath,
        repoFullName: resolveProjectGitHubRepo(session.project) ?? session.repoFullName,
        legacyWorkspacePath: sessionMachine?.workspacePaths?.[session.id],
      });
    }, [
      machineDotlodyPath,
      resolvedLocalProjectMeta?.rootPath,
      session.id,
      session.isWorktree,
      session.parentSessionId,
      session.project,
      session.repoFullName,
      sessionMachine,
    ]);
    const agentConfigs = useAtomValue(getAllAgentConfigAtom);
    const sessionAgentConfig = useMemo(
      () => agentConfigs.find((config) => config.id === session.agentConfigId),
      [agentConfigs, session.agentConfigId]
    );
    // Same guard as the rate limits below: wait for the config to resolve, then
    // judge on the full provider identity. `cliType`/`agentType` alone would let
    // a Codex-compatible provider behind a custom key show OpenAI's forecast.
    const showCodexResetForecast =
      (!session.agentConfigId || !!sessionAgentConfig) &&
      canShowCodexResetForecast({
        cliType: session.cliType,
        agentType: session.agentType,
        config: sessionAgentConfig,
      });
    const sessionRateLimits =
      (!session.agentConfigId || sessionAgentConfig) &&
      canShowSubscriptionRateLimits({
        cliType: session.cliType,
        agentType: session.agentType,
        config: sessionAgentConfig,
      })
        ? sessionMachine?.raceLimits
        : undefined;
    const sessionDividerLabel = useMemo(() => {
      if (!session) return '';
      return formatSessionDate(session.createdAt, localeObj) || session.id;
    }, [session, localeObj]);

    const {
      repoFullName,
      latestPr,
      latestPrState,
      canShowGitHubActions,
      hasExistingPr,
      workspaceDirty,
      hasChanges,
    } = useMemo(
      () => getSessionGitHubState(session, workspaceSession),
      [session, workspaceSession]
    );
    const latestPrNumber = getPullRequestNumber(latestPr);
    const latestPrRepoFullName = getPullRequestRepoFullName(latestPr) ?? repoFullName;
    const preferredMergeMethod = usePreferredPrMergeMethod();
    const activePrDetails = useGitHubPrDetails({
      workspaceId,
      repoFullName: latestPrRepoFullName,
      prNumber: latestPrNumber,
      headCommitSha: getSessionPullRequestLegacyFields(latestPr).headCommitSha,
      enabled: canShowGitHubActions && hasExistingPr,
    });
    const {
      data: activePrData,
      state: activePrState,
      refreshCheckRuns: refreshActivePrCheckRuns,
      mergePullRequest: mergeActivePullRequest,
      isMerging: isActivePrMerging,
      markReadyForReview: markActivePrReadyForReview,
      isMarkingReady: isActivePrMarkingReady,
    } = activePrDetails;
    const [isPrActionPending, setIsPrActionPending] = useState(false);
    // Shared with the PR-tab "Resolve conflicts" button through
    // `resolveConflictsActionAtomFamily`; both surfaces block re-clicks + show
    // loading off this one flag while the prompt dispatch is in flight.
    const [isResolvingConflicts, setIsResolvingConflicts] = useState(false);
    const repositories = useCloudQuery(
      cloudOperations.github.getWorkspaceRepositories,
      workspaceId ? { workspaceId } : 'skip'
    );
    const isRepoPublic = useMemo(() => {
      if (!repoFullName || !repositories) return undefined;
      const repo = repositories.find((r) => r.fullName === repoFullName);
      return repo ? !repo.private : undefined;
    }, [repoFullName, repositories]);

    const { knownItems: knownIssuePrItems } = useKnownIssuePrItems(repoFullName, isRepoPublic);

    type InputActionState = 'ready' | 'dispatching';
    const [inputActionState, setInputActionState] = useState<InputActionState>('ready');
    const directDispatchInFlightRef = useRef(false);
    const previousStatusTypeRef = useRef<SessionStatus['type'] | undefined>(session.status?.type);
    const pendingUserInterruptRef = useRef(false);
    const steeringQueueItemIdsRef = useRef(new Set<string>());
    // requestId -> { shownAtMs, requestKind, toolKind }. Tracks permission
    // requests already observed so the diff effect emits shown/responded exactly
    // once per request. shownAtMs uses performance.now() (local-only wait timing).
    const permissionRequestStateRef = useRef<
      Map<
        string,
        {
          shownAtMs: number;
          requestKind: 'ask_user_question' | 'tool_permission';
          toolKind: ToolKind | null;
          responded: boolean;
        }
      >
    >(new Map());
    const isArchivedSession = session.isArchived === true;
    const [pendingGoalCommand, setPendingGoalCommand] = useState<{
      threadId: string;
      command: GoalCommand;
    } | null>(null);
    const chatStreamRef = useRef<SessionChatStreamHandle>(null);
    const inputAreaRef = useRef<SessionChatInputAreaHandle>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const messageAreaRef = useRef<HTMLDivElement>(null);
    const [outlineOverlayRoot, setOutlineOverlayRoot] = useState<HTMLDivElement | null>(null);
    const skipNextViewportResizeAutoScrollRef = useRef(false);
    const suppressStickyAutoScrollRef = useRef(false);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const deferredSearchQuery = useDeferredValue(searchQuery);
    const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
    const lastSearchAnalyticsKeyRef = useRef<string | null>(null);

    const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
    const queuedMessageBehavior = useAtomValue(queuedMessageBehaviorAtom);
    const {
      markSessionRead,
      requestSessionCancel,
      requestSessionDispatch,
      requestSessionSteer,
      touchSessionActivity,
      transferSessionOwner,
    } = useSessionActions();
    const [renameDialogTarget, setRenameDialogTarget] = useState<RenameSessionDialogTarget | null>(
      null
    );
    const { members: workspaceMembers, isMultiMember } = useWorkspaceMembers();
    const [pendingOwnerUserId, setPendingOwnerUserId] = useState<string | null>(null);
    const handleChangeOwner = useCallback(
      async (nextUserId: string) => {
        setPendingOwnerUserId(nextUserId);
        try {
          await transferSessionOwner(session.id, nextUserId);
          const name =
            workspaceMembers.find((member) => member.userId === nextUserId)?.name ?? nextUserId;
          toast.success(t('sessions.owner.changed', 'Session owner is now {{name}}', { name }));
        } catch (error) {
          console.error('Failed to transfer session owner', error);
          toast.error(t('sessions.owner.changeFailed', 'Could not change the session owner'));
        } finally {
          setPendingOwnerUserId(null);
        }
      },
      [session.id, t, transferSessionOwner, workspaceMembers]
    );
    const ownerMenuState = useMemo<SessionOwnerMenuState | undefined>(
      () =>
        isMultiMember
          ? {
              members: workspaceMembers,
              ownerUserId: session.userId,
              onChangeOwner: handleChangeOwner,
              pendingUserId: pendingOwnerUserId,
            }
          : undefined,
      [handleChangeOwner, isMultiMember, pendingOwnerUserId, session.userId, workspaceMembers]
    );
    const [sendingMessageIds, setSendingMessageIds] = useState<ReadonlySet<string>>(new Set());
    const [dismissedProposedPlanDecisionKeys, setDismissedProposedPlanDecisionKeys] = useState<
      ReadonlySet<string>
    >(new Set());
    const [pendingProposedPlanDecisionKey, setPendingProposedPlanDecisionKey] = useState<
      string | null
    >(null);
    const pendingProposedPlanDecisionKeyRef = useRef<string | null>(null);
    // Reset per-session transient UI state on session change.
    useEffect(() => {
      setSendingMessageIds(new Set());
      setDismissedProposedPlanDecisionKeys(new Set());
      setPendingProposedPlanDecisionKey(null);
      pendingProposedPlanDecisionKeyRef.current = null;
    }, [session.id]);

    const trackMessageSend = useCallback(
      (messageId: string) => {
        setSendingMessageIds((prev) => new Set(prev).add(messageId));
        waitUntilSynced()
          .then(() => {
            setSendingMessageIds((prev) => {
              const next = new Set(prev);
              next.delete(messageId);
              return next;
            });
          })
          .catch(() => {
            // On error, remove from sending set — transport will retry automatically
            setSendingMessageIds((prev) => {
              const next = new Set(prev);
              next.delete(messageId);
              return next;
            });
          });
      },
      [waitUntilSynced]
    );

    const sessionHistoryLength = sessionDoc?.history?.length ?? 0;
    const conversationPreparationSignalRef = useRef<SessionConversationPreparationState | null>(
      null
    );
    useEffect(() => {
      if (!onConversationPrepared && !onConversationPrepareError) {
        conversationPreparationSignalRef.current = null;
        return;
      }
      const preparationState = resolveSessionConversationPreparationState({
        docReady: sessionDocReady,
        historyLength: sessionHistoryLength,
        syncState: sessionDocSyncState,
      });
      if (
        preparationState === 'waiting' ||
        conversationPreparationSignalRef.current === preparationState
      ) {
        return;
      }
      conversationPreparationSignalRef.current = preparationState;
      if (preparationState === 'ready') {
        onConversationPrepared?.();
        return;
      }
      onConversationPrepareError?.();
    }, [
      onConversationPrepareError,
      onConversationPrepared,
      sessionDocReady,
      sessionDocSyncState,
      sessionHistoryLength,
    ]);
    const isEmptyConversation = useMemo(() => {
      if (!sessionDocReady) return false;
      return sessionHistoryLength === 0;
    }, [sessionHistoryLength, sessionDocReady]);

    const shouldShowTitleLoading = isEmptyConversation && !sessionDocSynced;
    // The header spinner only means "actively catching up". Degraded states
    // (disconnected/error) escalate to the status strip instead of spinning
    // forever, and a ~400ms delay keeps routine session switches flicker-free.
    const shouldShowTitleSyncing =
      !isEmptyConversation && sessionDocReady && isSyncingRoomSyncState(sessionDocSyncState);
    const effectiveTitleSyncing = useDelayedFlag(
      titleSyncing ?? shouldShowTitleSyncing,
      TITLE_SYNCING_INDICATOR_DELAY_MS
    );

    const mcpSelection = useSessionMcpSelection(sessionConversationConfig.mcpServerIds, {
      existingSession: true,
      disabled: isArchivedSession,
    });
    const executionTurnConfigOverrides = useMemo(
      () =>
        buildExecutionTurnConfigOverrides({
          selectedModeId,
          defaultModeId,
          modeOptions,
          configOptionSelectors,
          configOptionValues,
        }),
      [configOptionSelectors, configOptionValues, defaultModeId, modeOptions, selectedModeId]
    );

    // Session status strip above the composer: one priority-ordered slot for
    // "will my message run?" (self offline > machine removed > machine offline).
    const statusStripState = useMemo(
      () =>
        resolveSessionStatusStripState({
          browserOnline,
          machineRemoved: isMachineRemoved,
          machineOnlineStatus: sessionMachineOnlineStatus,
          machineName: sessionMachine?.name ?? null,
        }),
      [browserOnline, isMachineRemoved, sessionMachineOnlineStatus, sessionMachine?.name]
    );

    // Keyboard cyclers (⇧Tab mode + rebindable model / thinking). The agent provider is
    // fixed once a session exists, so it isn't cyclable here (only on the chat landing).
    const thinkEffortSelector = useMemo(
      () =>
        configOptionSelectors.find(
          (selector): selector is AcpSelectConfigOptionSelector =>
            selector.type === 'select' && isThoughtLevelSelector(selector)
        ),
      [configOptionSelectors]
    );
    const thinkEffortCurrent = thinkEffortSelector
      ? configOptionValues[thinkEffortSelector.configId]
      : undefined;
    useComposerCycleCommands({
      // Session detail keeps its toolbar and inactive tabs mounted. Only the active
      // conversation may own these duplicate command ids.
      enabled: !hideMessageArea && syncEnabled,
      mode: hideMessageArea
        ? null
        : {
            values: modeOptions.map((option) => option.value),
            current: selectedModeId,
            onSelect: handleModeChange,
          },
      model: hideMessageArea
        ? null
        : {
            values: modelOptions.map((option) => option.value),
            current: selectedModelId,
            onSelect: handleModelChange,
          },
      thinkEffort:
        !hideMessageArea && thinkEffortSelector
          ? {
              values: thinkEffortSelector.options.map((option) => option.value),
              current:
                typeof thinkEffortCurrent === 'string'
                  ? thinkEffortCurrent
                  : thinkEffortSelector.currentValue,
              onSelect: (value) => handleConfigOptionChange(thinkEffortSelector.configId, value),
            }
          : null,
      provider: null,
    });

    const initStatusLabel = useMemo<string | null>(() => {
      const heartbeatStepMs = 20_000;
      const heartbeatWindowMs = 120_000;
      const heartbeatBucketCount = 6;

      const createdAtMs = Date.parse(session.createdAt);
      const fallbackElapsedMs = Number.isFinite(createdAtMs)
        ? Math.max(0, Date.now() - createdAtMs)
        : 0;
      const elapsedMs = fallbackElapsedMs;
      const isSlow = elapsedMs >= heartbeatWindowMs;
      const bucket = Math.min(
        heartbeatBucketCount - 1,
        Math.max(0, Math.floor(elapsedMs / heartbeatStepMs))
      );
      const variantKey = isSlow ? 'slow' : (`h${bucket}` as const);

      const tHeartbeat = (baseKey: string, vars?: Record<string, unknown>) =>
        String(
          (t as unknown as (key: string, options?: Record<string, unknown>) => string)(
            `${baseKey}.${variantKey}`,
            vars
          )
        );

      if (liveSessionStatus == null) {
        return null;
      }

      switch (liveSessionStatus.type) {
        case 'initializing': {
          const stage = liveSessionStatus.stage;
          switch (stage) {
            case 'git-clone':
              return tHeartbeat('sessions.statusIndicator.gitClone', {
                repo: '',
              });
            case 'managed-runtime':
              return (
                liveSessionStatus.detail ??
                t('sessions.statusIndicator.managedRuntime', 'Preparing agent runtime')
              );
            case 'acp':
              return tHeartbeat('sessions.statusIndicator.acpInitialize', {
                agent: 'ACP',
              });
            case 'resuming':
              return t('sessions.statusIndicator.resuming');
            default:
              return tHeartbeat('sessions.statusIndicator.created');
          }
        }
        case 'running':
        case 'requestPermission':
          return null;
      }
      return null;
    }, [liveSessionStatus, session.createdAt, t]);

    const sessionHistory = useMemo(
      () => (sessionDoc?.history as SessionHistory[] | undefined) ?? [],
      [sessionDoc?.history]
    );
    const [lastCompletedAssistantTarget, setLastCompletedAssistantTarget] = useState<{
      sessionId: SessionId;
      messageId: string | null;
    } | null>(null);
    const lastCompletedAssistantMessageId =
      lastCompletedAssistantTarget?.sessionId === session.id
        ? lastCompletedAssistantTarget.messageId
        : null;
    const handleLastCompletedAssistantMessageIdChange = useCallback(
      (messageId: string | null) => {
        setLastCompletedAssistantTarget((current) => {
          if (current?.sessionId === session.id && current.messageId === messageId) {
            return current;
          }
          return { sessionId: session.id, messageId };
        });
      },
      [session.id]
    );
    const handleForkFromMenu = useCallback(
      (destination?: SessionForkDestination) => {
        if (onForkSessionExternal) {
          void onForkSessionExternal(destination);
          return;
        }
        if (lastCompletedAssistantMessageId && onForkLastAssistant) {
          onForkLastAssistant(lastCompletedAssistantMessageId, destination);
        }
      },
      [lastCompletedAssistantMessageId, onForkLastAssistant, onForkSessionExternal]
    );
    const canForkFromMenu = Boolean(
      onForkSessionExternal || (lastCompletedAssistantMessageId && onForkLastAssistant)
    );
    const isContextCompacting = useMemo(
      () => isSessionContextCompacting(sessionHistory),
      [sessionHistory]
    );
    // Pending scheduled tasks (cron / wakeup) are derived on the fly from the
    // Cron*/ScheduleWakeup tool_call items already in history — nothing extra is
    // persisted. Serialize to a key so the input area only re-renders when the
    // derived set actually changes (not on every streaming token).
    const scheduledTasksKey = useMemo(
      () => JSON.stringify(collectPendingScheduledTasksFromHistory(sessionHistory)),
      [sessionHistory]
    );
    const pendingScheduledTasks = useMemo(
      () => JSON.parse(scheduledTasksKey) as PendingScheduledTask[],
      [scheduledTasksKey]
    );
    const legacySession = session as SessionLegacyMetaFields;
    const latestGoal = useMemo(
      () =>
        resolveVisibleSessionGoal(
          sessionHistory,
          legacySession.latestGoal,
          session.dismissedGoalThreadId
        ),
      [legacySession.latestGoal, session.dismissedGoalThreadId, sessionHistory]
    );
    const isGoalActive = isSessionGoalActive(latestGoal);
    // The existing prompt bridge is Codex-specific. Other providers may publish
    // neutral goal snapshots, but their advertised `_session/goal` extension is
    // not yet routed through Lody's session control plane, so keep them read-only.
    const goalCommands = getPromptBridgeGoalCommands(session.agentType);
    const canPauseGoal = canPauseGoalThroughPromptBridge(session.agentType);

    useEffect(() => {
      if (!pendingGoalCommand) {
        return;
      }

      if (pendingGoalCommand.command === 'clear') {
        // Clear now lands as a 'cleared' status (not a delete), so treat either
        // a missing goal, a thread switch, or the cleared status as success.
        if (
          !latestGoal ||
          latestGoal.threadId !== pendingGoalCommand.threadId ||
          isSessionGoalCleared(latestGoal)
        ) {
          setPendingGoalCommand(null);
        }
        return;
      }

      if (latestGoal?.threadId !== pendingGoalCommand.threadId) {
        return;
      }
      if (pendingGoalCommand.command === 'pause' && latestGoal.status === 'paused') {
        setPendingGoalCommand(null);
        return;
      }
      if (pendingGoalCommand.command === 'resume' && latestGoal.status === 'active') {
        setPendingGoalCommand(null);
      }
    }, [latestGoal, pendingGoalCommand]);

    const isSessionActive = liveSessionStatus != null;
    // CLI-reported presence is the fact source for "working now". The only
    // frontend-derived state is the dispatched-but-not-started window, read
    // from the trailing pending user turn in history — never from meta
    // dispatch pointers, which can be stale in this client.
    //
    // That optimism is time-bounded: it is anchored on the turn's own durable
    // dispatch timestamp and expires after
    // `UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS` if the CLI never publishes
    // presence. Without the bound a crashed daemon / desynced dispatch left
    // "Starting…" showing forever, reading as a stuck-busy agent. Anchoring on
    // the durable timestamp (not mount time) makes a stalled turn report its
    // full age immediately after a reload instead of restarting the clock.
    const pendingDispatchAtMs = useMemo(
      () => resolveUnstartedTrailingDispatchAtMs(sessionHistory),
      [sessionHistory]
    );
    const [dispatchNowMs, setDispatchNowMs] = useState(() => getServerNow());
    useEffect(() => {
      if (pendingDispatchAtMs == null) return undefined;
      const tick = () => setDispatchNowMs(getServerNow());
      const remaining =
        pendingDispatchAtMs + UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS - getServerNow();
      if (remaining <= 0) {
        tick();
        return undefined;
      }
      const timer = setTimeout(tick, remaining);
      return () => clearTimeout(timer);
    }, [pendingDispatchAtMs]);
    const hasPendingDispatch =
      pendingDispatchAtMs != null &&
      dispatchNowMs - pendingDispatchAtMs < UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS;
    const isSessionWorking = isSessionActive || hasPendingDispatch;

    useAppStoreReviewPrompt({
      sessionId: session.id,
      sessionOwnerId: session.userId,
      currentUserId: currentUser?.id,
      history: sessionHistory,
      historyHydrated: sessionDocReady && sessionDocSynced,
      sessionCompleted: session.status?.type === 'idle' && !isSessionWorking,
      lastCompletedAssistantMessageId,
    });

    const runningActivity = useMemo<AgentActivity | null>(() => {
      if (liveSessionStatus == null) {
        return null;
      }
      const statusActivity = resolveActivityFromSessionStatus(liveSessionStatus);
      if (statusActivity) {
        return statusActivity;
      }
      return resolveActivityFromHistory(sessionHistory);
    }, [liveSessionStatus, sessionHistory]);

    const activeAssistantTurnId = useMemo(() => {
      return resolveActiveAssistantTurnId(sessionHistory);
    }, [sessionHistory]);
    const messageQueue = useMemo(
      () => (sessionDoc?.mq ?? []) as MessageQueueItem[],
      [sessionDoc?.mq]
    );
    const billableSessionTurnCount = useMemo(
      () => countBillableSessionTurns({ history: sessionHistory, queue: messageQueue }),
      [messageQueue, sessionHistory]
    );
    const handleOpenBillingSettings = useCallback(() => {
      captureSessionEvent('session/free_turn_limit_upgrade_clicked');
      openSettings('billing');
    }, [captureSessionEvent, openSettings]);
    const freeSessionTurnNotice = useMemo(() => {
      if (billingEntitlement?.effectivePlanTier !== 'free') {
        return null;
      }
      const remaining = FREE_SESSION_TURN_LIMIT - billableSessionTurnCount;
      if (remaining > FREE_SESSION_TURN_WARNING_REMAINING) {
        return null;
      }
      return {
        current: billableSessionTurnCount,
        limit: FREE_SESSION_TURN_LIMIT,
        onUpgrade: hidesBillingUi ? undefined : handleOpenBillingSettings,
      };
    }, [
      billableSessionTurnCount,
      billingEntitlement?.effectivePlanTier,
      handleOpenBillingSettings,
      hidesBillingUi,
    ]);
    const showTurnBlockToast = useCallback(
      (kind: 'turn_limit' | 'checkout_pending', current: number, limit: number) => {
        if (kind === 'checkout_pending') {
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
          return;
        }
        toast.error(t('sessions.freeTurnLimitReachedTitle'), {
          description: t('sessions.freeTurnLimitReachedDescription', { current, limit }),
        });
      },
      [hidesBillingUi, t]
    );

    /**
     * Synchronous, local-only send gate. Per the send hot-path invariant the
     * local history write is the accept boundary, so this must never await
     * the network. The reactive entitlement query selects the plan while the
     * Flock document supplies the current turn count.
     */
    const guardNewBillableTurn = useCallback((): boolean => {
      if (!workspaceId) {
        toast.error(t('sessions.sendError'), {
          description: t(
            'sessions.billingWorkspaceUnavailable',
            'Workspace billing state is not ready.'
          ),
        });
        return false;
      }
      const admission = evaluateBillingQuota({
        effectivePlanTier: billingEntitlement?.effectivePlanTier,
        checkoutPending: billingEntitlement?.checkoutPending,
        current: billableSessionTurnCount,
        limit: FREE_SESSION_TURN_LIMIT,
      });
      if (!admission.allowed && admission.reason === 'checkout_pending') {
        captureSessionEvent('session/input_blocked', {
          reason: 'workspace_payment_required',
          entrypoint: 'session_chat',
        });
        showTurnBlockToast('checkout_pending', 0, 0);
        return false;
      }
      if (!admission.allowed) {
        captureSessionEvent('session/input_blocked', {
          reason: 'free_session_turn_limit_reached',
          entrypoint: 'session_chat',
          current_turn_count: admission.current,
          turn_limit: admission.limit,
        });
        showTurnBlockToast('turn_limit', admission.current, admission.limit);
        return false;
      }
      return true;
    }, [
      billableSessionTurnCount,
      billingEntitlement?.checkoutPending,
      billingEntitlement?.effectivePlanTier,
      captureSessionEvent,
      showTurnBlockToast,
      t,
      workspaceId,
    ]);
    const editableLastUserMessageId = useMemo(() => {
      if (
        session.isArchived ||
        session.autoReview ||
        isGoalActive ||
        session.cliType !== 'builtin' ||
        (session.agentType !== 'codex' && session.agentType !== 'claude')
      ) {
        return null;
      }
      let userIndex = -1;
      for (let index = sessionHistory.length - 1; index >= 0; index -= 1) {
        if (sessionHistory[index]?.role === 'user') {
          userIndex = index;
          break;
        }
      }
      const userMessage = sessionHistory[userIndex];
      if (
        !userMessage ||
        userMessage.status === 'pending_apply' ||
        (userMessage.inputConfig as Record<string, unknown> | undefined)?._lodyDeliveryKind ===
          'steer'
      ) {
        return null;
      }

      for (let index = userIndex - 1; index >= 0; index -= 1) {
        const entry = sessionHistory[index];
        if (!entry) continue;
        if (entry.role === 'user') return null;
        if (entry.role !== 'assistant') continue;
        if (entry.finished !== true || !entry.acpTurnId || !session.agentConfigId) return null;
        const capability =
          sessionMachine?.acpCapabilities?.[getAcpCapabilityCacheKey(session.agentConfigId)];
        return getAcpCapabilityCacheEntryAuthority(capability, undefined) === 'authoritative' &&
          capability?.sessionFork === true
          ? userMessage.id
          : null;
      }

      // The first user message uses session/new and therefore has no fork boundary.
      return userMessage.id;
    }, [
      isGoalActive,
      session.agentConfigId,
      session.agentType,
      session.autoReview,
      session.cliType,
      session.isArchived,
      sessionHistory,
      sessionMachine?.acpCapabilities,
    ]);
    const handleEditLastUser = useCallback(
      async (message: SessionHistoryParsed, text: string): Promise<boolean> => {
        const nextText = text.trim();
        const requesterUserId = currentUser?.id ?? session.userId;
        if (
          !runtime ||
          !requesterUserId ||
          message.id !== editableLastUserMessageId ||
          !nextText ||
          !guardNewBillableTurn()
        ) {
          return false;
        }

        const originalBlocks = historyItemsToInputBlocks(message.items);
        const inputBlocks: SessionInputBlock[] = [];
        let replacedText = false;
        for (const block of originalBlocks) {
          if (block.type === 'text') {
            if (!replacedText) {
              inputBlocks.push({ type: 'text', text: nextText });
              replacedText = true;
            }
            continue;
          }
          inputBlocks.push(block);
        }
        if (!replacedText) {
          inputBlocks.push({ type: 'text', text: nextText });
        }

        const originalConfig = normalizeSessionTurnInputConfig(message.inputConfig) ?? {};
        const inputConfig: SessionTurnInputConfig = {
          ...originalConfig,
          prompt: extractPromptPreviewFromInputBlocks(inputBlocks),
          inputBlocks,
          cliType: session.cliType,
          agentType: session.agentType,
        };
        const replacementUserTurnId = uuidv4();
        try {
          const response = await runtime.requestSessionEditAndResend(
            session.machineId,
            {
              sessionId: session.id,
              expectedUserTurnId: message.id,
              replacementUserTurnId,
              requestedByUserId: requesterUserId,
              timestamp: new Date(getServerNow()).toISOString(),
              inputConfig,
            },
            { timeoutMs: 120_000 }
          );
          if (!response?.success) {
            toast.error(
              response?.error?.message ??
                t('sessions.editAndResendFailed', 'Unable to edit and resend this message')
            );
            return false;
          }
        } catch (error) {
          console.warn('Edit and resend RPC failed', error);
          toast.error(t('sessions.editAndResendFailed', 'Unable to edit and resend this message'));
          return false;
        }
        captureSessionEvent('session/edit_and_resend_succeeded', {
          replaced_user_turn_id: message.id,
          replacement_user_turn_id: replacementUserTurnId,
        });
        return true;
      },
      [
        captureSessionEvent,
        currentUser?.id,
        editableLastUserMessageId,
        guardNewBillableTurn,
        runtime,
        session.agentType,
        session.cliType,
        session.id,
        session.machineId,
        session.userId,
        t,
      ]
    );
    const searchBlocks = useIncrementalSearchBlocks(sessionHistory, isSearchOpen);
    const normalizedSearchQuery = useMemo(
      () => normalizeSessionSearchQuery(deferredSearchQuery),
      [deferredSearchQuery]
    );
    const searchResults = useMemo<SessionSearchResult[]>(
      () => buildSessionSearchResults(searchBlocks, normalizedSearchQuery),
      [normalizedSearchQuery, searchBlocks]
    );
    const activeSearchResult = searchResults[activeSearchResultIndex] ?? null;
    const searchBlockMatches = useMemo(() => {
      const next = new Map<
        string,
        {
          blockId: string;
          resultIds: string[];
          activeResultId: string | null;
          activeOccurrenceIndex: number | null;
        }
      >();

      searchResults.forEach((result) => {
        const existing = next.get(result.blockId);
        if (existing) {
          existing.resultIds.push(result.resultId);
          if (activeSearchResult?.resultId === result.resultId) {
            existing.activeResultId = result.resultId;
            existing.activeOccurrenceIndex = result.localIndex;
          }
          return;
        }

        next.set(result.blockId, {
          blockId: result.blockId,
          resultIds: [result.resultId],
          activeResultId: activeSearchResult?.resultId === result.resultId ? result.resultId : null,
          activeOccurrenceIndex:
            activeSearchResult?.resultId === result.resultId ? result.localIndex : null,
        });
      });

      return next;
    }, [activeSearchResult?.resultId, searchResults]);
    const searchContextValue = useMemo(() => {
      const isSearchActive = isSearchOpen && normalizedSearchQuery.length > 0;
      const matchedBlockIds = isSearchActive ? Array.from(searchBlockMatches.keys()) : [];
      const activeBlockId = isSearchActive ? (activeSearchResult?.blockId ?? null) : null;
      return {
        isOpen: isSearchActive,
        query: isSearchActive ? normalizedSearchQuery : '',
        activeBlockId,
        activeResultId: isSearchActive ? (activeSearchResult?.resultId ?? null) : null,
        blockMatches: isSearchActive ? searchBlockMatches : new Map(),
        hasMatchedPrefix: (prefix: string) =>
          matchedBlockIds.some((blockId) => blockId === prefix || blockId.startsWith(`${prefix}:`)),
        hasActivePrefix: (prefix: string) =>
          activeBlockId !== null &&
          (activeBlockId === prefix || activeBlockId.startsWith(`${prefix}:`)),
      };
    }, [
      activeSearchResult?.blockId,
      activeSearchResult?.resultId,
      isSearchOpen,
      normalizedSearchQuery,
      searchBlockMatches,
    ]);

    const focusSearchInput = useCallback(() => {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }, []);

    const openSearch = useCallback(() => {
      if (!isSearchOpen) {
        captureSessionEvent('session/search_opened', {
          history_count: sessionHistory.length,
          searchable_block_count: searchBlocks.length,
          source: 'conversation',
        });
      }
      setIsSearchOpen(true);
      focusSearchInput();
    }, [
      captureSessionEvent,
      focusSearchInput,
      isSearchOpen,
      searchBlocks.length,
      sessionHistory.length,
    ]);

    const closeSearch = useCallback(() => {
      captureSessionEvent('session/search_closed', {
        had_query: normalizedSearchQuery.length > 0,
        query_length: searchQuery.trim().length,
        result_count: searchResults.length,
      });
      setIsSearchOpen(false);
    }, [captureSessionEvent, normalizedSearchQuery.length, searchQuery, searchResults.length]);

    const moveToSearchResult = useCallback(
      (direction: 'previous' | 'next') => {
        if (searchResults.length === 0) {
          return;
        }
        captureSessionEvent('session/search_navigated', {
          direction,
          result_count: searchResults.length,
          current_index: activeSearchResultIndex,
        });
        startTransition(() => {
          setActiveSearchResultIndex((previousIndex) => {
            if (direction === 'previous') {
              return previousIndex <= 0 ? searchResults.length - 1 : previousIndex - 1;
            }
            return previousIndex >= searchResults.length - 1 ? 0 : previousIndex + 1;
          });
        });
      },
      [activeSearchResultIndex, captureSessionEvent, searchResults.length]
    );

    useEffect(() => {
      if (!isSearchOpen || normalizedSearchQuery.length === 0) {
        return undefined;
      }

      const analyticsKey = `${session.id}:${normalizedSearchQuery}:${searchResults.length}`;
      const timeoutId = window.setTimeout(() => {
        if (lastSearchAnalyticsKeyRef.current === analyticsKey) {
          return;
        }
        lastSearchAnalyticsKeyRef.current = analyticsKey;
        captureSessionEvent('session/search_performed', {
          query_length: searchQuery.trim().length,
          result_count: searchResults.length,
          searchable_block_count: searchBlocks.length,
          searchable_block_type_counts: countSearchBlockTypes(searchBlocks),
          matched_block_count: searchBlockMatches.size,
        });
      }, 750);

      return () => window.clearTimeout(timeoutId);
    }, [
      captureSessionEvent,
      isSearchOpen,
      normalizedSearchQuery,
      searchBlockMatches.size,
      searchBlocks,
      searchQuery,
      searchResults.length,
      session.id,
    ]);

    useEffect(() => {
      setIsSearchOpen(false);
      setSearchQuery('');
      setActiveSearchResultIndex(0);
    }, [session.id]);

    const handleSearchQueryChange = useCallback((next: string) => {
      setSearchQuery(next);
      setActiveSearchResultIndex(0);
    }, []);

    // ── Page-level drag-and-drop ────────────────────────────────────────
    // Two kinds land on the whole conversation, not just on the composer: image
    // and file attachments, and a session dragged out of the sidebar, which
    // becomes a mention of that conversation. Each zone ignores the other's
    // transfer, so they share the container without competing for it.
    const canHandlePageDrop = !isArchivedSession && !isMobile && !hideMessageArea;
    const imageDropZone = useDropZone({
      enabled: canHandlePageDrop,
      accepts: hasFileTransfer,
      onDrop: useCallback((dataTransfer: DataTransfer) => {
        const files = getFilesFromDataTransfer(dataTransfer);
        if (files.length > 0) {
          inputAreaRef.current?.handleImageDrop(files);
        }
      }, []),
    });
    const { dropZone: sessionMentionDropZone, overlayActive: sessionMentionOverlay } =
      useSessionMentionDropZone({
        enabled: canHandlePageDrop,
        excludeSessionId: session.id,
        observeInFlight: paintSessionMentionOverlay && isVisible,
        onDropSessionId: useCallback((droppedSessionId: string) => {
          inputAreaRef.current?.insertSessionMention(droppedSessionId);
        }, []),
      });
    const pageDropHandlers = mergeDropZoneHandlers(imageDropZone, sessionMentionDropZone);

    useEffect(() => {
      if (searchResults.length === 0) {
        if (activeSearchResultIndex !== 0) {
          setActiveSearchResultIndex(0);
        }
        return;
      }
      if (activeSearchResultIndex < searchResults.length) {
        return;
      }
      setActiveSearchResultIndex(searchResults.length - 1);
    }, [activeSearchResultIndex, searchResults.length]);

    useEffect(() => {
      if (hideMessageArea) {
        return undefined;
      }
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented) {
          return;
        }
        // Exact chord only: ⌘F (macOS) / Ctrl+F (Windows/Linux). Refuse any extra
        // modifier (Shift/Alt/the other primary mod) so chords like ⌘⌥F, ⌘⇧F, or
        // ⌘⌃F keep their other meanings and are not stolen via preventDefault.
        // Matches the command registry's `$mod+f` matcher (primary-mod exclusive).
        if (!matchesKeyboardEvent(FIND_IN_CHAT_BINDING, event, isMac())) {
          return;
        }
        event.preventDefault();
        openSearch();
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [hideMessageArea, openSearch]);

    useEffect(() => {
      if (!isSearchOpen || !activeSearchResult) {
        return undefined;
      }

      // Disable smooth scrolling and sticky auto-scroll during search navigation
      // to prevent virtua animation from fighting scrollIntoView and causing freezes.
      suppressStickyAutoScrollRef.current = true;
      chatStreamRef.current?.scrollToIndex(activeSearchResult.messageIndex, false);

      let cancelled = false;
      let attempts = 0;
      const maxAttempts = 12;

      const tryReveal = () => {
        if (cancelled) {
          // Don't reset suppressStickyAutoScrollRef here — cleanup already handles it.
          // Resetting here would race with a newer effect instance that has already
          // set it back to true.
          return;
        }
        const root = messageAreaRef.current;
        if (!root) {
          return;
        }

        const byResult = root.querySelector(
          `[data-search-result-id="${activeSearchResult.resultId}"]`
        );
        const byBlock = root.querySelector(
          `[data-search-block-id="${activeSearchResult.blockId}"]`
        );
        const target = (byResult ?? byBlock) as HTMLElement | null;

        if (target) {
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          suppressStickyAutoScrollRef.current = false;
          return;
        }

        if (attempts >= maxAttempts) {
          suppressStickyAutoScrollRef.current = false;
          return;
        }
        attempts += 1;
        setTimeout(() => {
          requestAnimationFrame(tryReveal);
        }, 50);
      };

      // Give the instant scroll + virtual-list render a short buffer before revealing.
      const timeoutId = window.setTimeout(() => {
        requestAnimationFrame(tryReveal);
      }, 100);

      return () => {
        cancelled = true;
        window.clearTimeout(timeoutId);
        suppressStickyAutoScrollRef.current = false;
      };
    }, [activeSearchResult, isSearchOpen]);

    const handleCopyConversationHistory = useCallback(async () => {
      if (!sessionDoc?.history?.length) {
        captureSessionEvent('session/history_copy_failed', {
          reason: 'empty_history',
          history_count: 0,
        });
        toast.error(t('sessions.copyConversationHistoryEmpty', 'No conversation history to copy'));
        return;
      }

      try {
        const { markdown, stats } = buildConversationMarkdown({
          history: sessionDoc.history as Parameters<typeof buildConversationMarkdown>[0]['history'],
          title: session.title ?? undefined,
        });
        await navigator.clipboard.writeText(markdown);
        captureSessionEvent('session/history_copy_succeeded', {
          history_count: sessionDoc.history.length,
          prompt_length: stats.chars,
          estimated_tokens: stats.estimatedTokens,
          over_budget: stats.overBudget,
          thinking_omitted: stats.thinkingOmitted,
          terminal_omitted: stats.terminalOutputOmitted,
          tool_calls_collapsed: stats.toolCallsCollapsed,
          tool_results_truncated: stats.toolResultsTruncated,
        });
        toast.success(describeCopiedConversation(stats, t));
      } catch (error) {
        console.error('Failed to copy conversation history', error);
        captureSessionEvent('session/history_copy_failed', {
          reason: 'clipboard_error',
          history_count: sessionDoc.history.length,
          error_name: error instanceof Error ? error.name : typeof error,
          error_message: error instanceof Error ? error.message : String(error),
        });
        toast.error(
          t('sessions.copyConversationHistoryFailed', 'Failed to copy conversation history')
        );
      }
    }, [captureSessionEvent, session.title, sessionDoc?.history, t]);

    // Inactive tabs and collapsed side chats stay mounted for fast switching, so
    // being mounted is not evidence the user saw this conversation: only the
    // visible surface may clear unread state. Otherwise opening a parent session
    // marks every one of its sub-sessions read at once.
    const lastReadAtForReceiptRef = useRef(parseTimestamp(session.lastReadAt));
    lastReadAtForReceiptRef.current = parseTimestamp(session.lastReadAt);

    useEffect(() => {
      const lastMessageAt = parseTimestamp(session.lastMessageAt);
      if (
        !shouldMarkSessionRead({
          rendersConversation: !hideMessageArea,
          isVisible,
          lastMessageAt,
          lastReadAt: lastReadAtForReceiptRef.current,
        })
      ) {
        return;
      }
      void markSessionRead(session.id, session.lastMessageAt ?? null).catch((error: unknown) => {
        console.warn('Failed to mark session as read', error);
      });
      // A receipt gets a new opportunity when this surface becomes visible or
      // a new message arrives. Deliberately do not depend on lastReadAt: moving
      // that receipt backwards is the user's explicit "Mark as unread" action,
      // which must remain visible until they leave and reopen the conversation.
    }, [hideMessageArea, isVisible, markSessionRead, session.id, session.lastMessageAt]);

    const isDispatching = inputActionState === 'dispatching';
    const isAgentBusy = isSessionPromptBusy({
      isDispatching,
      isSessionWorking,
      isGoalActive,
    });
    const canStopAgent =
      (isSessionActive && activeAssistantTurnId != null) || (isGoalActive && canPauseGoal);
    const latestCompletedProposedPlan = useMemo(
      () => findLatestCompletedCodexProposedPlan(sessionDoc?.history),
      [sessionDoc?.history]
    );
    const isCodexPlanSession = session.agentType === 'codex';
    const isProposedPlanDecisionPending =
      latestCompletedProposedPlan !== null &&
      pendingProposedPlanDecisionKey === latestCompletedProposedPlan.key;
    const shouldShowProposedPlanDecisionPrompt = shouldShowCodexProposedPlanDecision({
      plan: latestCompletedProposedPlan,
      dismissed:
        latestCompletedProposedPlan !== null &&
        dismissedProposedPlanDecisionKeys.has(latestCompletedProposedPlan.key),
      pending: isProposedPlanDecisionPending,
      isCodexSession: isCodexPlanSession,
      isSessionIdle: session.status?.type === 'idle',
      isSessionActive,
      isAgentBusy,
    });
    const isProposedPlanDecisionReady =
      !isMachineRemoved && !isArchivedSession && !isExternalHistoryRefreshing;

    const sessionBranch = useMemo(
      () =>
        resolveBaseBranchPreference({
          preferredBranch: getProjectRefBranch(session.project),
          baseBranch: session.baseBranch,
        }),
      [session.baseBranch, session.project]
    );
    const sessionProject = useMemo<ProjectRef | undefined>(() => {
      const rawProject = session.project as
        | (
            | { kind: 'github'; repoFullName?: unknown; branch?: unknown }
            | {
                kind: 'local';
                localProjectId?: unknown;
                branch?: unknown;
                githubRepoFullName?: unknown;
                useWorktree?: unknown;
              }
          )
        | undefined;
      if (rawProject?.kind === 'github') {
        const projectRepoFullName =
          typeof rawProject.repoFullName === 'string'
            ? rawProject.repoFullName.trim()
            : (session.repoFullName?.trim() ?? '');
        if (!projectRepoFullName) {
          return undefined;
        }
        const branch =
          typeof rawProject.branch === 'string' && rawProject.branch.trim()
            ? rawProject.branch.trim()
            : sessionBranch;
        return { kind: 'github', repoFullName: projectRepoFullName, branch };
      }
      if (rawProject?.kind === 'local') {
        if (typeof rawProject.localProjectId !== 'string' || !rawProject.localProjectId.trim()) {
          return undefined;
        }
        const branch =
          typeof rawProject.branch === 'string' && rawProject.branch.trim()
            ? rawProject.branch.trim()
            : undefined;
        return {
          kind: 'local',
          localProjectId: rawProject.localProjectId as LocalProjectId,
          githubRepoFullName:
            typeof rawProject.githubRepoFullName === 'string' &&
            rawProject.githubRepoFullName.trim()
              ? rawProject.githubRepoFullName.trim()
              : (session.repoFullName?.trim() ?? undefined),
          ...(branch ? { branch } : {}),
          ...(typeof rawProject.useWorktree === 'boolean'
            ? { useWorktree: rawProject.useWorktree }
            : session.isWorktree
              ? { useWorktree: true }
              : {}),
        };
      }
      const fallbackRepo = session.repoFullName?.trim();
      if (!fallbackRepo) {
        return undefined;
      }
      return { kind: 'github', repoFullName: fallbackRepo, branch: sessionBranch };
    }, [session.isWorktree, session.project, session.repoFullName, sessionBranch]);
    const trackUserInterruptEnd = useCallback(() => {
      const timing = summarizeSessionEndTiming(sessionDoc?.history as SessionHistory[] | undefined);
      capturePostHogEvent(postHog, 'session/end_user_interrupt', {
        session_id: session.id,
        workspace_id: workspaceId ?? null,
        machine_id: session.machineId,
        agent_config_id: session.agentConfigId ?? null,
        cli_type: session.cliType,
        agent_type: session.agentType,
        project_kind: sessionProject?.kind ?? 'none',
        repo_full_name: resolveProjectGitHubRepo(sessionProject) ?? session.repoFullName ?? null,
        duration_ms: timing.duration_ms,
        turn_count: timing.turn_count,
        first_to_last_turn_ms: timing.first_to_last_turn_ms,
        permission_wait_ms: timing.permission_wait_ms,
      });
    }, [
      postHog,
      session.agentConfigId,
      session.cliType,
      session.agentType,
      session.id,
      session.machineId,
      session.repoFullName,
      sessionDoc?.history,
      sessionProject,
      workspaceId,
    ]);
    const agentActivityLabel =
      initStatusLabel && !isEmptyConversation
        ? initStatusLabel
        : isSessionActive
          ? liveSessionStatus?.type === 'requestPermission'
            ? t('sessions.statusIndicator.requestPermission')
            : t(`sessions.statusIndicator.${runningActivity ?? 'thinking'}`)
          : hasPendingDispatch && statusStripState == null
            ? // Pre-start only while the turn can actually start: any
              // connection/machine problem (browser offline, machine removed or
              // offline) hands the story to the status chip instead.
              t('sessions.statusIndicator.pendingDispatch')
            : null;
    const agentActivityTone =
      isSessionActive && liveSessionStatus?.type === 'requestPermission' ? 'warning' : 'primary';

    const scrollChatToBottom = useCallback(() => {
      requestAnimationFrame(() => chatStreamRef.current?.scrollToBottom());
    }, []);

    const guideHistoryEntry = useCallback(
      async (userTurnId: string, expectedTurnId: string): Promise<boolean> => {
        const applied = await requestSessionSteer(session.id, expectedTurnId, userTurnId, {
          machineId: session.machineId,
        });
        if (!applied) {
          return false;
        }
        try {
          await updateHistoryEntry(userTurnId, (entry) => ({
            ...entry,
            status: 'processing',
            read: true,
            inputConfig: {
              ...entry.inputConfig,
              _lodyDeliveryKind: 'steer',
            },
          }));
        } catch (error) {
          console.warn('Guide was applied before local history status updated', error);
        }
        return true;
      },
      [requestSessionSteer, session.id, session.machineId, updateHistoryEntry]
    );

    const enqueueInputBlocks = useCallback(
      async (
        inputBlocks: SessionInputBlock[],
        options?: {
          createHistory?: boolean;
          existingUserTurnId?: string;
          requestDispatch?: boolean;
          guideExpectedTurnId?: string;
          modeIdOverride?: string | null;
          modelIdOverride?: string | null;
          configOptionValuesOverride?: Record<string, AcpConfigOptionValue>;
          agentRole?: SessionTurnAgentRoleSelection;
        }
      ): Promise<boolean> => {
        try {
          const turnModeId =
            options?.modeIdOverride !== undefined ? options.modeIdOverride : selectedModeId;
          const turnModelId =
            options?.modelIdOverride !== undefined ? options.modelIdOverride : selectedModelId;
          const turnConfigOptionValues = options?.configOptionValuesOverride ?? configOptionValues;
          const derivedUserId = currentUser?.id ?? session.userId;
          const prompt = extractPromptPreviewFromInputBlocks(inputBlocks);
          const issuePRMentions = prompt
            ? extractIssuePRMentionsFromText(prompt, knownIssuePrItems, repoFullName)
            : undefined;
          const inputConfig = buildSessionTurnInputConfig({
            inputBlocks,
            cliType: session.cliType,
            agentType: session.agentType,
            modeId: turnModeId,
            modelId: turnModelId,
            configOptionValues: turnConfigOptionValues,
            issuePRMentions,
            mcpServerIds: mcpSelection.selectedIds,
            taskToolsEnabled: tasksEnabled,
            agentRoleId:
              options?.agentRole?.agentRoleId ?? (options?.agentRole === null ? null : undefined),
            agentRoleRevision: options?.agentRole?.agentRoleRevision,
            resume: session.acpSessionId ?? undefined,
          });

          let userTurnId = options?.existingUserTurnId?.trim() || null;
          if (!userTurnId && options?.createHistory) {
            const pendingHistoryEntry = buildPendingUserHistoryEntry({
              userId: derivedUserId,
              inputBlocks,
              timestamp: new Date().toISOString(),
              inputConfig,
              status: options?.guideExpectedTurnId ? 'pending_apply' : 'pending',
            });
            if (!pendingHistoryEntry) {
              return false;
            }
            if (!guardNewBillableTurn()) {
              return false;
            }
            const { entry: historyEntry } = await addSessionHistory(pendingHistoryEntry, {
              dispatch: options?.requestDispatch === true,
            });
            userTurnId = historyEntry.id;
            touchSessionActivity(session.id).catch((err: unknown) => {
              console.warn('Failed to update session lastMessageAt/lastReadAt', err);
            });
          } else if (userTurnId) {
            await updateHistoryEntry(userTurnId, (entry) => ({
              ...entry,
              status: 'pending',
              inputConfig,
              read: false,
            }));
          }

          // Track CRDT sync to server for this message
          if (userTurnId) {
            trackMessageSend(userTurnId);
          }
          if (options?.requestDispatch && userTurnId) {
            void requestSessionDispatch(session.id, userTurnId, {
              inputConfig,
              machineId: session.machineId,
            }).catch((err: unknown) => {
              console.error('Failed to request session dispatch', err);
              captureSessionEvent('session/message_dispatch_failed', {
                route: 'direct_dispatch',
                error_name: err instanceof Error ? err.name : typeof err,
                error_message: getErrorMessage(err),
              });
              // A failed dispatch must unblock resend right away; otherwise the
              // composer stays locked until DISPATCHING_TIMEOUT_MS expires.
              directDispatchInFlightRef.current = false;
              setInputActionState('ready');
              toast.error(t('sessions.sendError'), { description: getErrorMessage(err) });
            });
          } else if (options?.guideExpectedTurnId && userTurnId) {
            void guideHistoryEntry(userTurnId, options.guideExpectedTurnId)
              .then((applied) => {
                captureSessionEvent('session/message_guide_result', {
                  user_turn_id: userTurnId,
                  applied,
                });
              })
              .catch((error: unknown) => {
                console.error('Failed to apply guide message', error);
              });
          }

          scrollChatToBottom();
          return true;
        } catch (err) {
          console.error('Failed to queue session message', err);
          captureSessionEvent('session/message_enqueue_failed', {
            route: 'direct_dispatch',
            error_name: err instanceof Error ? err.name : typeof err,
            error_message: getErrorMessage(err),
          });
          toast.error(t('sessions.sendError'), { description: getErrorMessage(err) });
          return false;
        }
      },
      [
        addSessionHistory,
        captureSessionEvent,
        configOptionValues,
        currentUser?.id,
        guardNewBillableTurn,
        guideHistoryEntry,
        knownIssuePrItems,
        mcpSelection.selectedIds,
        repoFullName,
        requestSessionDispatch,
        scrollChatToBottom,
        selectedModeId,
        selectedModelId,
        session.acpSessionId,
        session.agentType,
        session.cliType,
        session.id,
        session.machineId,
        session.userId,
        trackMessageSend,
        touchSessionActivity,
        updateHistoryEntry,
        t,
        tasksEnabled,
      ]
    );

    const queueInputBlocks = useCallback(
      async (
        inputBlocks: SessionInputBlock[],
        options?: Pick<
          DispatchInputBlocksOptions,
          'modeIdOverride' | 'modelIdOverride' | 'configOptionValuesOverride' | 'agentRole'
        >
      ): Promise<boolean> => {
        try {
          const turnModeId =
            options?.modeIdOverride !== undefined ? options.modeIdOverride : selectedModeId;
          const turnModelId =
            options?.modelIdOverride !== undefined ? options.modelIdOverride : selectedModelId;
          const turnConfigOptionValues = options?.configOptionValuesOverride ?? configOptionValues;
          const derivedUserId = currentUser?.id ?? session.userId;
          const prompt = extractPromptPreviewFromInputBlocks(inputBlocks);
          const issuePRMentions = prompt
            ? extractIssuePRMentionsFromText(prompt, knownIssuePrItems, repoFullName)
            : undefined;
          const inputConfig = buildSessionTurnInputConfig({
            inputBlocks,
            cliType: session.cliType,
            agentType: session.agentType,
            modeId: turnModeId,
            modelId: turnModelId,
            configOptionValues: turnConfigOptionValues,
            issuePRMentions,
            mcpServerIds: mcpSelection.selectedIds,
            taskToolsEnabled: tasksEnabled,
            agentRoleId:
              options?.agentRole?.agentRoleId ?? (options?.agentRole === null ? null : undefined),
            agentRoleRevision: options?.agentRole?.agentRoleRevision,
            resume: session.acpSessionId ?? undefined,
          });
          const queuedInputConfig: MessageQueueItemInput['acpSessionConfig'] = {
            prompt: inputConfig.prompt,
            inputBlocks,
            cliType: inputConfig.cliType,
            agentType: inputConfig.agentType,
            modeId: inputConfig.modeId ?? undefined,
            modelId: inputConfig.modelId ?? undefined,
            configOptionValues: inputConfig.configOptionValues ?? undefined,
            issuePRMentions: inputConfig.issuePRMentions ?? undefined,
            mcpServerIds: [...mcpSelection.selectedIds],
            taskToolsEnabled: inputConfig.taskToolsEnabled,
            agentRoleId: inputConfig.agentRoleId,
            agentRoleRevision: inputConfig.agentRoleRevision,
            resume: inputConfig.resume ?? undefined,
            chainDepth: 0,
          };

          if (!guardNewBillableTurn()) {
            return false;
          }
          const userTurnId = uuidv4();
          await pushMessageQueue({
            task: prompt || t('sessions.messageQueue.imageOnly', '[Image message]'),
            project: sessionProject,
            userId: derivedUserId,
            userTurnId,
            acpSessionConfig: queuedInputConfig,
          });
          return true;
        } catch (err) {
          console.error('Failed to queue session message', err);
          captureSessionEvent('session/message_enqueue_failed', {
            route: 'queue',
            error_name: err instanceof Error ? err.name : typeof err,
            error_message: getErrorMessage(err),
          });
          toast.error(t('sessions.queueError', 'Failed to queue message'), {
            description: getErrorMessage(err),
          });
          return false;
        }
      },
      [
        captureSessionEvent,
        configOptionValues,
        currentUser?.id,
        guardNewBillableTurn,
        knownIssuePrItems,
        mcpSelection.selectedIds,
        pushMessageQueue,
        repoFullName,
        selectedModeId,
        selectedModelId,
        session.acpSessionId,
        session.agentType,
        session.cliType,
        session.userId,
        sessionProject,
        t,
        tasksEnabled,
      ]
    );

    const directDispatchInputBlocks = useCallback(
      async (
        inputBlocks: SessionInputBlock[],
        options?: Pick<
          DispatchInputBlocksOptions,
          'modeIdOverride' | 'modelIdOverride' | 'configOptionValuesOverride' | 'agentRole'
        >
      ): Promise<boolean> => {
        const turnConfigOptionValues = options?.configOptionValuesOverride ?? configOptionValues;
        return await enqueueInputBlocks(inputBlocks, {
          createHistory: true,
          requestDispatch: true,
          modeIdOverride: options?.modeIdOverride,
          modelIdOverride: options?.modelIdOverride,
          configOptionValuesOverride: turnConfigOptionValues,
          agentRole: options?.agentRole,
        });
      },
      [configOptionValues, enqueueInputBlocks]
    );

    const dispatchInputBlocks = useCallback(
      async (
        inputBlocks: SessionInputBlock[],
        options?: DispatchInputBlocksOptions
      ): Promise<boolean> => {
        const normalized = normalizeSessionInputBlocks(inputBlocks, '');
        if (normalized.length === 0) {
          return false;
        }
        if (!sessionDocReady) {
          return false;
        }

        const turnModeId =
          options?.modeIdOverride !== undefined ? options.modeIdOverride : selectedModeId;
        const turnModelId =
          options?.modelIdOverride !== undefined ? options.modelIdOverride : selectedModelId;
        const turnConfigOptionValues = options?.configOptionValuesOverride ?? configOptionValues;
        const forceDirect = options?.forceDirect === true;
        const submitRoute = resolveSessionMessageSubmitRoute({
          forceDirect,
          forceQueue: options?.forceQueue === true,
          isPromptBusy: isAgentBusy,
          hasUnfinishedAssistantTurn: activeAssistantTurnId != null,
          queuedMessageBehavior,
        });
        const startedAtMs = getPerformanceNowMs();
        const inputSummary = summarizeInputBlocksForAnalytics(normalized);
        if (isArchivedSession) {
          captureSessionEvent('session/input_blocked', {
            reason: 'session_archived',
            entrypoint: 'session_chat',
            has_pending_images: inputSummary.has_images,
          });
          return false;
        }
        if (isExternalHistoryRefreshing) {
          captureSessionEvent('session/input_blocked', {
            reason: 'external_history_syncing',
            entrypoint: 'session_chat',
            has_pending_images: inputSummary.has_images,
          });
          return false;
        }
        captureSessionEvent('session/message_submit_requested', {
          ...inputSummary,
          force_queue: Boolean(options?.forceQueue),
          force_direct: forceDirect,
          submit_route: submitRoute.type,
          is_agent_busy: isAgentBusy,
          mode_id: turnModeId ?? null,
          model_id: turnModelId ?? null,
          config_option_count: Object.keys(turnConfigOptionValues).length,
        });
        if (submitRoute.type === 'queue') {
          const accepted = await queueInputBlocks(normalized, {
            modeIdOverride: turnModeId,
            modelIdOverride: turnModelId,
            configOptionValuesOverride: turnConfigOptionValues,
            agentRole: options?.agentRole,
          });
          captureSessionEvent(
            accepted ? 'session/message_queued' : 'session/message_submit_failed',
            {
              ...inputSummary,
              submit_route: 'queue',
              duration_ms: getDurationSinceMs(startedAtMs),
              queue_reason: submitRoute.reason,
            }
          );
          return accepted;
        }

        if (submitRoute.type === 'guide' && activeAssistantTurnId) {
          const accepted = await enqueueInputBlocks(normalized, {
            createHistory: true,
            guideExpectedTurnId: activeAssistantTurnId,
            modeIdOverride: turnModeId,
            modelIdOverride: turnModelId,
            configOptionValuesOverride: turnConfigOptionValues,
            agentRole: options?.agentRole,
          });
          captureSessionEvent(
            accepted ? 'session/message_guide_requested' : 'session/message_submit_failed',
            {
              ...inputSummary,
              submit_route: 'guide',
              duration_ms: getDurationSinceMs(startedAtMs),
            }
          );
          return accepted;
        }

        if (directDispatchInFlightRef.current) {
          captureSessionEvent('session/input_blocked', {
            reason: 'direct_dispatch_in_flight',
            entrypoint: 'session_chat',
            has_pending_images: inputSummary.has_images,
          });
          return false;
        }

        directDispatchInFlightRef.current = true;
        setInputActionState('dispatching');

        const accepted = await directDispatchInputBlocks(normalized, {
          modeIdOverride: turnModeId,
          modelIdOverride: turnModelId,
          configOptionValuesOverride: turnConfigOptionValues,
          agentRole: options?.agentRole,
        });
        if (!accepted) {
          captureSessionEvent('session/message_submit_failed', {
            ...inputSummary,
            submit_route: 'direct_dispatch',
            duration_ms: getDurationSinceMs(startedAtMs),
          });
          directDispatchInFlightRef.current = false;
          setInputActionState('ready');
        }
        return accepted;
      },
      [
        captureSessionEvent,
        configOptionValues,
        directDispatchInputBlocks,
        activeAssistantTurnId,
        enqueueInputBlocks,
        isExternalHistoryRefreshing,
        isArchivedSession,
        isAgentBusy,
        queueInputBlocks,
        queuedMessageBehavior,
        sessionDocReady,
        selectedModeId,
        selectedModelId,
      ]
    );

    const dispatchPrompt = useCallback(
      async (prompt: string, options?: DispatchInputBlocksOptions): Promise<boolean> => {
        const inputArea = inputAreaRef.current;
        const hasRunConfigOverride =
          options?.modeIdOverride !== undefined ||
          options?.modelIdOverride !== undefined ||
          options?.configOptionValuesOverride !== undefined;
        const agentRole = resolveProgrammaticTurnAgentRole({
          requested: options?.agentRole,
          composer: inputArea
            ? inputArea.getAgentRoleSelection(options)
            : hasRunConfigOverride
              ? null
              : undefined,
          durableRoleId: sessionConversationConfig.agentRoleId,
          durableRoleRevision: sessionConversationConfig.agentRoleRevision,
        });
        return await dispatchInputBlocks(
          [{ type: 'text', text: prompt }],
          agentRole === undefined ? options : { ...options, agentRole }
        );
      },
      [
        dispatchInputBlocks,
        sessionConversationConfig.agentRoleId,
        sessionConversationConfig.agentRoleRevision,
      ]
    );

    const handleSendMessage = useCallback(
      async (
        inputBlocks: SessionInputBlock[],
        agentRole?: SessionTurnAgentRoleSelection
      ): Promise<boolean> => {
        return await dispatchInputBlocks(inputBlocks, { agentRole });
      },
      [dispatchInputBlocks]
    );

    const capacityRetry = useCapacityAutoRetry({
      sessionId: session.id,
      history: sessionDoc?.history,
      canRetry:
        sessionDocReady &&
        !isAgentBusy &&
        !isMachineRemoved &&
        !isArchivedSession &&
        !isExternalHistoryRefreshing,
      onRetry: async () =>
        await dispatchPrompt(
          t('sessions.capacityRetry.continuationPrompt', CAPACITY_RETRY_CONTINUATION_PROMPT)
        ),
    });

    // Resend a user turn the missing-history recovery negatively acknowledged:
    // the row's "Not delivered" label opens a confirmation dialog that calls
    // this with the turn's exact content. It rides the ordinary send path as a
    // NEW message — the old turn is never revived.
    const handleResendUndelivered = useCallback(
      async (userTurnId: string, inputBlocks: SessionInputBlock[]): Promise<boolean> => {
        // This is a new Turn with the old content, not a replay of the old run:
        // freeze the currently committed composer Role beside the current run
        // config. Copying only the original Role would pair it with unrelated
        // current mode/model values.
        const currentAgentRole = resolveProgrammaticTurnAgentRole({
          composer: inputAreaRef.current?.getAgentRoleSelection(),
          durableRoleId: sessionConversationConfig.agentRoleId,
          durableRoleRevision: sessionConversationConfig.agentRoleRevision,
        });
        const accepted = await handleSendMessage(inputBlocks, currentAgentRole);
        if (accepted) {
          // The marker stays as a tombstone; terminalize the abandoned entry.
          try {
            await updateHistoryEntry(userTurnId, (entry) => ({
              ...entry,
              status: 'canceled',
              read: true,
            }));
          } catch (error) {
            console.warn('Failed to supersede the undelivered user turn', {
              userTurnId,
              error,
            });
          }
        }
        return accepted;
      },
      [
        handleSendMessage,
        sessionConversationConfig.agentRoleId,
        sessionConversationConfig.agentRoleRevision,
        updateHistoryEntry,
      ]
    );

    const autoReview = useAutoReview(session?.id, session);

    const handleContinueDiscussingProposedPlan = useCallback(() => {
      if (!latestCompletedProposedPlan) {
        return;
      }
      setDismissedProposedPlanDecisionKeys((prev) => {
        const next = new Set(prev);
        next.add(latestCompletedProposedPlan.key);
        return next;
      });
    }, [latestCompletedProposedPlan]);

    const handleExecuteProposedPlan = useCallback(async () => {
      if (!latestCompletedProposedPlan || pendingProposedPlanDecisionKeyRef.current) {
        return;
      }

      const decisionKey = latestCompletedProposedPlan.key;
      pendingProposedPlanDecisionKeyRef.current = decisionKey;
      setPendingProposedPlanDecisionKey(decisionKey);

      const accepted = await dispatchPrompt(
        t('sessions.proposedPlanDecision.executePrompt', 'Implement the plan'),
        {
          ...executionTurnConfigOverrides,
          forceDirect: true,
        }
      );

      if (accepted) {
        setDismissedProposedPlanDecisionKeys((prev) => {
          const next = new Set(prev);
          next.add(decisionKey);
          return next;
        });
      } else {
        toast.error(t('sessions.proposedPlanDecision.executeError', 'Failed to execute plan'));
      }

      pendingProposedPlanDecisionKeyRef.current = null;
      setPendingProposedPlanDecisionKey(null);
    }, [dispatchPrompt, executionTurnConfigOverrides, latestCompletedProposedPlan, t]);

    const handleGoalCommand = useCallback(
      async (
        command: GoalCommand,
        goal: Extract<MessageContent, { type: 'goal' }> | null = latestGoal,
        options?: { showPending?: boolean }
      ): Promise<boolean> => {
        if (!goalCommands.includes(command)) {
          captureSessionEvent('session/goal_command_failed', {
            command,
            goal_thread_id: goal?.threadId ?? null,
            error_name: 'UnsupportedGoalCommand',
            error_message: 'Goal command is unavailable for this agent transport',
          });
          toast.error(t('sessions.goal.commandError', 'Failed to send goal command'));
          return false;
        }

        if (!goal) {
          toast.error(t('sessions.goal.commandError', 'Failed to send goal command'));
          return false;
        }

        directDispatchInFlightRef.current = false;
        setInputActionState('ready');
        if (options?.showPending !== false) {
          setPendingGoalCommand({ threadId: goal.threadId, command });
        }

        try {
          const accepted = await dispatchPrompt(`/goal ${command}`, GOAL_PROMPT_DISPATCH_OPTIONS);
          if (!accepted) {
            throw new Error('Goal command was not accepted for dispatch');
          }
          captureSessionEvent('session/goal_command_dispatched', {
            command,
            goal_thread_id: goal.threadId,
          });
          return true;
        } catch (error) {
          if (options?.showPending !== false) {
            setPendingGoalCommand((current) =>
              current?.threadId === goal.threadId && current.command === command ? null : current
            );
          }
          captureSessionEvent('session/goal_command_failed', {
            command,
            goal_thread_id: goal.threadId,
            error_name: error instanceof Error ? error.name : typeof error,
            error_message: getErrorMessage(error),
          });
          toast.error(t('sessions.goal.commandError', 'Failed to send goal command'), {
            description: getErrorMessage(error),
          });
          return false;
        }
      },
      [captureSessionEvent, dispatchPrompt, goalCommands, latestGoal, t]
    );

    const handleGoalCardCommand = useCallback(
      (command: GoalCommand, goal: Extract<MessageContent, { type: 'goal' }>) => {
        void handleGoalCommand(command, goal);
      },
      [handleGoalCommand]
    );

    const handleDismissGoalBanner = useCallback(
      (goal: Extract<MessageContent, { type: 'goal' }>) => {
        if (!runtime) return;
        if (session.dismissedGoalThreadId === goal.threadId) return;
        const roomId = getSessionRoomId(session.id);
        void runtime.writer.upsertDocMeta(roomId, {
          dismissedGoalThreadId: goal.threadId,
        } as Partial<SessionMeta>);
        captureSessionEvent('session/goal_banner_dismissed', {
          goal_thread_id: goal.threadId,
          goal_status: goal.status,
        });
      },
      [captureSessionEvent, runtime, session.id, session.dismissedGoalThreadId]
    );

    // Allow child sessions to change agent config before first message
    const isChildSession = isChildTab || !!session.parentSessionId;
    const handleChildEmptyStateSuggest = useCallback((text: string) => {
      inputAreaRef.current?.setInputText(text);
    }, []);
    const chatStreamEmptyState = useMemo(
      () =>
        isChildSession ? (
          <ChildTabEmptyState onSuggest={handleChildEmptyStateSuggest} />
        ) : (
          EMPTY_CHAT_STREAM_EMPTY_STATE
        ),
      [handleChildEmptyStateSuggest, isChildSession]
    );
    const handleAgentConfigChange = useCallback(
      (selection: AgentSelection) => {
        if (!runtime) return;
        const config = agentConfigs.find((c) => c.id === selection.agentId);
        if (!config) return;
        const roomId = getSessionRoomId(session.id);
        void runtime.writer.upsertDocMeta(roomId, {
          agentConfigId: config.id,
          cliType: config.cliType,
          agentType: config.agentType,
        } as Partial<SessionMeta>);
      },
      [runtime, agentConfigs, session.id]
    );

    // ── Pin management ──────────────────────────────────────────────────
    const handlePinMessage = useCallback(
      (historyId: string | null) => {
        if (!runtime) {
          captureSessionEvent('session/message_pin_failed', {
            reason: 'missing_runtime',
            action: historyId ? 'pin' : 'unpin',
          });
          return;
        }
        const roomId = getSessionRoomId(session.id);
        const history = (sessionDoc?.history as SessionHistory[] | undefined) ?? [];
        const historyIndex = historyId ? history.findIndex((entry) => entry.id === historyId) : -1;
        // Use empty string as "cleared" — undefined is skipped by upsertDocMeta merge
        void runtime.writer.upsertDocMeta(roomId, {
          pinnedHistoryId: historyId ?? '',
        } as Partial<SessionMeta>);
        captureSessionEvent(historyId ? 'session/message_pinned' : 'session/message_unpinned', {
          history_id: historyId ?? null,
          history_index: historyIndex >= 0 ? historyIndex : null,
          previous_pinned_history_id: session.pinnedHistoryId || null,
        });
      },
      [captureSessionEvent, runtime, session.id, session.pinnedHistoryId, sessionDoc?.history]
    );

    const pinnedHistoryId = session.pinnedHistoryId || null;

    const handleUnpin = useCallback(() => {
      handlePinMessage(null);
    }, [handlePinMessage]);

    const pinContextValue = useMemo<SessionPinContextValue>(
      () => ({
        pinnedHistoryId,
        onPin: handlePinMessage,
      }),
      [pinnedHistoryId, handlePinMessage]
    );

    const sessionHistoryForPin = useMemo(() => {
      const history = (sessionDoc?.history as SessionHistory[] | undefined) ?? [];
      return history.map((h) => {
        const rawItems: unknown = h.items;
        const items = Array.isArray(rawItems) ? rawItems : [];
        return {
          id: h.id,
          role: h.role,
          items,
          status: h.status,
          read: h.read ?? false,
          timestamp: h.timestamp,
          endedAt: h.endedAt,
          userId: h.userId,
          modelInfo: h.modelInfo,
          fileDiff: h.fileDiff,
          finished: h.finished,
          plan: h.plan,
        };
      });
    }, [sessionDoc?.history]);

    const handleScrollToMessage = useCallback(
      (historyId: string) => {
        const history = (sessionDoc?.history as SessionHistory[] | undefined) ?? [];
        const index = history.findIndex((h) => h.id === historyId);
        if (index >= 0) {
          chatStreamRef.current?.scrollToIndex(index);
        }
      },
      [sessionDoc?.history]
    );

    const createPrPrompt = t('sessions.prompts.createPr', CREATE_PR_PROMPT);
    const createDraftPrPrompt = t('sessions.prompts.createDraftPr', CREATE_DRAFT_PR_PROMPT);
    const commitAndPushPrompt = t('sessions.prompts.commitAndPush', COMMIT_AND_PUSH_PROMPT);

    const handleCreatePr = useCallback(() => {
      captureSessionEvent('session/quick_action_selected', {
        action_id: 'create-pr',
        has_existing_pr: hasExistingPr,
        workspace_dirty: workspaceDirty,
      });
      void dispatchPrompt(createPrPrompt, executionTurnConfigOverrides);
    }, [
      captureSessionEvent,
      createPrPrompt,
      dispatchPrompt,
      executionTurnConfigOverrides,
      hasExistingPr,
      workspaceDirty,
    ]);

    const handleCreateDraftPr = useCallback(() => {
      captureSessionEvent('session/quick_action_selected', {
        action_id: 'create-draft-pr',
        has_existing_pr: hasExistingPr,
        workspace_dirty: workspaceDirty,
      });
      void dispatchPrompt(createDraftPrPrompt, executionTurnConfigOverrides);
    }, [
      captureSessionEvent,
      createDraftPrPrompt,
      dispatchPrompt,
      executionTurnConfigOverrides,
      hasExistingPr,
      workspaceDirty,
    ]);

    const handleCommitAndPush = useCallback(() => {
      captureSessionEvent('session/quick_action_selected', {
        action_id: 'commit-and-push',
        has_existing_pr: hasExistingPr,
        workspace_dirty: workspaceDirty,
      });
      void dispatchPrompt(commitAndPushPrompt, executionTurnConfigOverrides);
    }, [
      captureSessionEvent,
      commitAndPushPrompt,
      dispatchPrompt,
      executionTurnConfigOverrides,
      hasExistingPr,
      workspaceDirty,
    ]);

    const handleResolveConflicts = useCallback(async () => {
      if (isResolvingConflicts || !latestPr?.url) return;
      setIsResolvingConflicts(true);
      captureSessionEvent('session/quick_action_selected', {
        action_id: 'resolve-conflicts',
        has_existing_pr: true,
        workspace_dirty: workspaceDirty,
      });
      try {
        await dispatchPrompt(
          buildResolvePrConflictsPrompt(
            {
              repoFullName: latestPrRepoFullName,
              prNumber: latestPrNumber,
              prUrl: latestPr.url,
            },
            t
          ),
          executionTurnConfigOverrides
        );
      } finally {
        setIsResolvingConflicts(false);
      }
    }, [
      captureSessionEvent,
      dispatchPrompt,
      executionTurnConfigOverrides,
      isResolvingConflicts,
      latestPr,
      latestPrNumber,
      latestPrRepoFullName,
      t,
      workspaceDirty,
    ]);

    const handleFixCiErrors = useCallback(async () => {
      if (isPrActionPending) return;
      setIsPrActionPending(true);
      captureSessionEvent('session/quick_action_selected', {
        action_id: 'fix-ci-errors',
        has_existing_pr: true,
        workspace_dirty: workspaceDirty,
      });
      try {
        const refreshed = await refreshActivePrCheckRuns();
        if (!refreshed) {
          toast.error(t('sessions.fixCiErrors.fetchError', 'Failed to load the failed CI checks'));
          return;
        }
        const prompt = buildFixCiErrorsPrompt(
          {
            repoFullName: latestPrRepoFullName,
            pullRequest: refreshed.pullRequest,
            checkRuns: refreshed.checkRuns,
          },
          t
        );
        if (!prompt) {
          toast.info(t('sessions.fixCiErrors.noFailures', 'No failing CI checks were found'));
          return;
        }
        const accepted = await dispatchPrompt(prompt, executionTurnConfigOverrides);
        if (!accepted) {
          toast.error(t('sessions.fixCiErrors.sendError', 'Failed to send the CI fix request'));
        }
      } catch (error) {
        toast.error(t('sessions.fixCiErrors.fetchError', 'Failed to load the failed CI checks'), {
          description: getErrorMessage(error),
        });
      } finally {
        setIsPrActionPending(false);
      }
    }, [
      captureSessionEvent,
      dispatchPrompt,
      executionTurnConfigOverrides,
      isPrActionPending,
      latestPrRepoFullName,
      refreshActivePrCheckRuns,
      t,
      workspaceDirty,
    ]);

    const handleMergePullRequest = useCallback(
      async (method: GitHubMergeMethod) => {
        captureSessionEvent('session/quick_action_selected', {
          action_id: 'merge',
          merge_method: method,
          has_existing_pr: true,
          workspace_dirty: workspaceDirty,
        });
        try {
          await mergeActivePullRequest(method);
        } catch (error) {
          toast.error(t('sessions.prTab.mergeError', 'Failed to merge'), {
            description: getErrorMessage(error),
          });
        }
      },
      [captureSessionEvent, mergeActivePullRequest, t, workspaceDirty]
    );

    const handleMarkReadyForReview = useCallback(async () => {
      captureSessionEvent('session/quick_action_selected', {
        action_id: 'ready-for-review',
        has_existing_pr: true,
        workspace_dirty: workspaceDirty,
      });
      try {
        await markActivePrReadyForReview();
      } catch (error) {
        const description =
          error instanceof ReadyForReviewStillDraftError
            ? t(
                'sessions.prTab.readyForReviewStillDraft',
                'GitHub is still reporting this pull request as a draft. Try again in a moment.'
              )
            : getErrorMessage(error);
        toast.error(t('sessions.prTab.readyForReviewError', 'Failed to mark as ready for review'), {
          description,
        });
      }
    }, [captureSessionEvent, markActivePrReadyForReview, t, workspaceDirty]);

    const effectivePrStatus = activePrData
      ? derivePrStatusFromDetails(activePrData.pullRequest)
      : (latestPr?.status ?? null);

    // The compact `SessionMeta.pullRequests` status (`latestPr.status`) is only
    // written by the CLI PR poller / webhook fan-out, so it can lag behind
    // ready-for-review and merge transitions. Once live PR details load, they
    // are the action bar's complete status truth so the action and status marker
    // switch together without waiting for background reconciliation.
    const effectiveLatestPr = useMemo(
      () => (latestPr ? { ...latestPr, status: effectivePrStatus ?? latestPr.status } : latestPr),
      [latestPr, effectivePrStatus]
    );

    const infoBarPrCiRuns = useMemo(
      () => activePrData?.checkRuns.runs.map(mapGitHubCheckRunToInfoBar),
      [activePrData?.checkRuns.runs]
    );
    const handleOpenPrCiRun = useCallback((run: PrCiRun) => {
      if (run.url) window.open(run.url, '_blank', 'noopener,noreferrer');
    }, []);

    // The task this session belongs to. Titles come from the workspace task
    // index, which is already loaded for the sidebar count, so the chip costs no
    // extra read.
    const router = useRouter();
    const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
    const sessionTaskId = session.taskId;
    const taskIndexRows = useAtomValue(taskIndexRowsAtom);
    // A session keeps its `taskId` even for a user who never enabled the Tasks
    // beta (an agent or another device can set it), so the chip is gated too —
    // otherwise it would be a visible door to a feature that is supposed to be
    // absent, and the index it reads from is not even synced.
    const sessionTaskChip = useMemo(() => {
      if (!tasksEnabled || !sessionTaskId) return null;
      const row = taskIndexRows[sessionTaskId];
      return { taskId: sessionTaskId as string, title: row?.title ?? '' };
    }, [tasksEnabled, sessionTaskId, taskIndexRows]);
    const handleOpenSessionTask = useCallback(
      (taskId: string) => {
        if (!workspaceSlug) return;
        void router.navigate({
          to: '/$workspaceName/tasks/$taskId',
          params: { workspaceName: workspaceSlug, taskId },
        });
      },
      [router, workspaceSlug]
    );

    // Presentation-only "opened by" provenance (MCP `lody_session_create`).
    // Read from the already-loaded session meta cache, so it costs no extra
    // document. `parentSessionId` children are excluded by the atom — they are
    // child tabs / side chats and must keep their own semantics.
    const openerSessionId = session.openedBySessionId ?? null;
    const openerSessionMeta = useAtomValue(
      sessionMetaAtomFamily(openerSessionId ? getSessionRoomId(openerSessionId) : '')
    );
    const openedSessions = useAtomValue(openedSessionsAtomFamily(session.id));
    const openerNavigationTarget = useMemo(
      () => resolveOpenedByNavigationTarget(session, openerSessionMeta),
      [openerSessionMeta, session]
    );
    const handleOpenRelatedSession = useCallback(
      (target: SessionNavigationTarget) => {
        onNavigateSession?.(target);
      },
      [onNavigateSession]
    );
    const openedByRelations = useMemo<SessionOpenedByMenuState | undefined>(() => {
      const opened = openedSessions.map((item) => ({
        sessionId: item.id,
        title: (item.title ?? '').trim() || t('sessions.untitled', 'Untitled session'),
        target: { sessionId: item.id },
      }));
      // An opener that is archived or not synced to this client still has a
      // usable id, so navigation stays available; only the label falls back.
      const openedBy =
        openerSessionId && openerNavigationTarget
          ? {
              sessionId: openerSessionId,
              title:
                (openerSessionMeta?.title ?? '').trim() ||
                t('sessions.untitled', 'Untitled session'),
              target: openerNavigationTarget,
            }
          : null;
      if (!openedBy && opened.length === 0) return undefined;
      return { openedBy, opened, onOpenSession: handleOpenRelatedSession };
    }, [
      handleOpenRelatedSession,
      openedSessions,
      openerNavigationTarget,
      openerSessionId,
      openerSessionMeta?.title,
      t,
    ]);
    const openedByConversationStart = useMemo(() => {
      const openedBy = openedByRelations?.openedBy;
      if (!openedBy) return undefined;
      return (
        <ConversationColumn className="py-2 sm:py-3">
          <SessionRelationCard
            relation="opened-by"
            label={t(
              'sessions.openedBy.createdAutomaticallyBy',
              'This session was automatically created by'
            )}
            sessionTitle={openedBy.title}
            actionLabel={t('sessions.openedBy.backToOpener', 'Back to session')}
            actionIcon={CornerLeftUp}
            onAction={() => openedByRelations.onOpenSession(openedBy.target)}
          />
        </ConversationColumn>
      );
    }, [openedByRelations, t]);

    const infoBarContextActions = useMemo<ContextChipAction[]>(() => {
      // The CI pill renders from live check runs, so the action gating must
      // honor them too: whenever the pill shows "CI failed", the Fix CI Errors
      // action has to be available even if the compact meta `s` hasn't caught
      // up (e.g. the machine-side reconciler isn't running).
      const liveCiFailed = infoBarPrCiRuns?.some((run) => run.status === 'failure') ?? false;
      return resolveSessionInfoBarGitHubActionIds({
        canShowGitHubActions,
        hasExistingPr,
        workspaceDirty,
        hasChanges,
        isAgentBusy,
        prCiState: liveCiFailed ? 'f' : latestPrState?.s,
        prMergeState: latestPrState?.m,
        prReadiness: deriveSessionPullRequestReadiness(latestPrState),
        prStatus: effectivePrStatus,
      }).map((actionId) => {
        const disabledForHydration = shouldDisableSessionInfoBarGitHubActionForHydration(
          actionId,
          sessionDocReady
        );
        switch (actionId) {
          case 'create-pr':
            return {
              id: actionId,
              label: t('sessions.createPr', 'Create PR'),
              onClick: handleCreatePr,
              disabled: disabledForHydration,
            };
          case 'create-draft-pr':
            return {
              id: actionId,
              label: t('sessions.createDraftPr', 'Create Draft PR'),
              onClick: handleCreateDraftPr,
              disabled: disabledForHydration,
            };
          case 'commit-and-push':
            return {
              id: actionId,
              label: t('sessions.commitAndPush', 'Commit & Push'),
              onClick: handleCommitAndPush,
              disabled: disabledForHydration,
            };
          case 'resolve-conflicts':
            return {
              id: actionId,
              label: t('sessions.resolveConflicts', 'Resolve Conflicts'),
              onClick: () => void handleResolveConflicts(),
              disabled: disabledForHydration || isResolvingConflicts,
            };
          case 'fix-ci-errors':
            return {
              id: actionId,
              label: t('sessions.fixCiErrors', 'Fix CI Errors'),
              onClick: () => void handleFixCiErrors(),
              disabled: disabledForHydration || isPrActionPending,
            };
          case 'ready-for-review':
            return {
              id: actionId,
              label: isActivePrMarkingReady
                ? t('sessions.prTab.markingReadyForReview', 'Marking ready…')
                : t('sessions.prTab.readyForReview', 'Ready for review'),
              onClick: () => void handleMarkReadyForReview(),
              disabled: activePrState !== 'ready' || isActivePrMarkingReady,
            };
          case 'merge':
            return {
              kind: 'merge' as const,
              id: 'merge' as const,
              method: preferredMergeMethod,
              isMerging: isActivePrMerging,
              disabled: activePrState !== 'ready',
              onMerge: handleMergePullRequest,
              onSelectMethod: setPreferredPrMergeMethod,
            };
          default: {
            const unsupportedActionId: never = actionId;
            throw new Error(`Unsupported Info Bar action: ${unsupportedActionId}`);
          }
        }
      });
    }, [
      canShowGitHubActions,
      handleCommitAndPush,
      handleCreateDraftPr,
      handleCreatePr,
      handleFixCiErrors,
      handleMarkReadyForReview,
      handleMergePullRequest,
      handleResolveConflicts,
      hasExistingPr,
      effectivePrStatus,
      infoBarPrCiRuns,
      isAgentBusy,
      isPrActionPending,
      isResolvingConflicts,
      latestPrState,
      activePrState,
      isActivePrMarkingReady,
      preferredMergeMethod,
      isActivePrMerging,
      sessionDocReady,
      t,
      workspaceDirty,
      hasChanges,
    ]);

    // Bridge the "Resolve conflicts" action to the PR tab (a separate subtree).
    // It is offerable exactly when the info bar would show it, so both buttons
    // appear, disable, and disappear together.
    const resolveConflictsAvailable = useMemo(
      () => infoBarContextActions.some((action) => action.id === 'resolve-conflicts'),
      [infoBarContextActions]
    );
    const setResolveConflictsAction = useSetAtom(resolveConflictsActionAtomFamily(session.id));
    useEffect(() => {
      setResolveConflictsAction({
        run: () => void handleResolveConflicts(),
        pending: !sessionDocReady || isResolvingConflicts,
        available: resolveConflictsAvailable,
      });
      return () => setResolveConflictsAction(null);
    }, [
      setResolveConflictsAction,
      handleResolveConflicts,
      isResolvingConflicts,
      resolveConflictsAvailable,
      sessionDocReady,
    ]);

    const headerBrowserSession =
      browserActionSession === undefined ? session : browserActionSession;
    // Agent-driven action: it appears only once the session actually has a
    // preview target, i.e. after `lody_report_preview_candidate` reported a
    // url+port (or a connection from an earlier report is still live). Showing
    // it on every session promised a preview that did not exist.
    const browserActionAvailable = Boolean(
      onOpenBrowser &&
      headerBrowserSession &&
      hasReportedPreviewTarget({
        candidateStatus: headerBrowserSession.previewCandidate?.status,
        connectionStatus: headerBrowserSession.previewConnection?.status,
      })
    );

    const handleOpenBrowser = useCallback(() => {
      const browserSession = headerBrowserSession ?? session;
      captureSessionEvent('session/quick_action_selected', {
        action_id: 'browser',
        preview_status:
          browserSession.previewConnection?.status ??
          browserSession.previewCandidate?.status ??
          null,
      });
      onOpenBrowser?.();
    }, [captureSessionEvent, headerBrowserSession, onOpenBrowser, session]);

    const assistantQuickActions = useMemo<AssistantMessageAction[]>(() => {
      const actions: AssistantMessageAction[] = [];

      if (shouldShowProposedPlanDecisionPrompt) {
        actions.push(
          {
            id: 'codex-implement-plan',
            label: isProposedPlanDecisionPending
              ? t('sessions.proposedPlanDecision.executing', 'Implementing plan...')
              : t('sessions.proposedPlanDecision.execute', 'Implement plan'),
            onClick: () => {
              void handleExecuteProposedPlan();
            },
            disabled: !isProposedPlanDecisionReady || isProposedPlanDecisionPending,
            icon: isProposedPlanDecisionPending ? SpinningLoaderIcon : Play,
            tone: 'accent',
          },
          {
            id: 'codex-continue-discussing',
            label: t('sessions.proposedPlanDecision.continue', 'Continue discussing'),
            onClick: handleContinueDiscussingProposedPlan,
            disabled: isProposedPlanDecisionPending,
            icon: MessageCircle,
          }
        );
      }

      // Identity matters downstream: this array invalidates the last assistant
      // turn's cached virtual rows (view.tsx assistantTurnRowsCache), and the
      // memo deps churn on every history change. Hand back a stable empty so
      // the common no-actions case never busts that cache.
      return actions.length > 0 ? actions : EMPTY_ASSISTANT_QUICK_ACTIONS;
    }, [
      handleContinueDiscussingProposedPlan,
      handleExecuteProposedPlan,
      isProposedPlanDecisionPending,
      isProposedPlanDecisionReady,
      shouldShowProposedPlanDecisionPrompt,
      t,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        focusInput: () => {
          inputAreaRef.current?.focusInput();
        },
        addCommentReference: (reference) => {
          return inputAreaRef.current?.addCommentReference(reference) ?? false;
        },
        toggleCommentReference: (reference) => {
          return inputAreaRef.current?.toggleCommentReference(reference) ?? false;
        },
        addVisualAnnotationReference: (reference) => {
          return inputAreaRef.current?.addVisualAnnotationReference(reference) ?? false;
        },
        toggleVisualAnnotationReference: (reference) => {
          return inputAreaRef.current?.toggleVisualAnnotationReference(reference) ?? false;
        },
        copyConversationHistory: handleCopyConversationHistory,
        openSearch,
        getLastAssistantTurnId: () => lastCompletedAssistantMessageId,
        insertSessionMention: (sessionId: string) => {
          return inputAreaRef.current?.insertSessionMention(sessionId) ?? false;
        },
      }),
      [handleCopyConversationHistory, lastCompletedAssistantMessageId, openSearch]
    );

    const [prevSessionIdForActionReset, setPrevSessionIdForActionReset] = useState(session.id);
    if (prevSessionIdForActionReset !== session.id) {
      setPrevSessionIdForActionReset(session.id);
      setInputActionState('ready');
      directDispatchInFlightRef.current = false;
      previousStatusTypeRef.current = undefined;
      pendingUserInterruptRef.current = false;
      permissionRequestStateRef.current = new Map();
      setPendingGoalCommand(null);
    }

    useEffect(() => {
      const dispatchWaitStatusType = liveSessionStatus?.type ?? null;
      if (inputActionState !== 'dispatching') {
        directDispatchInFlightRef.current = false;
        return undefined;
      }

      if (isSessionWorking) {
        setInputActionState('ready');
        return undefined;
      }

      const timeoutId = window.setTimeout(() => {
        captureSessionEvent('session/message_dispatch_wait_timeout', {
          timeout_ms: DISPATCHING_TIMEOUT_MS,
          status_type: dispatchWaitStatusType,
        });
        setInputActionState('ready');
      }, DISPATCHING_TIMEOUT_MS);

      return () => window.clearTimeout(timeoutId);
    }, [captureSessionEvent, inputActionState, isSessionWorking, liveSessionStatus]);

    useEffect(() => {
      if (hideMessageArea) return undefined;
      const previousStatusType = previousStatusTypeRef.current;
      const currentStatusType = session.status?.type;

      const transitionedToIdle =
        isTrackableRunningStatusType(previousStatusType) && currentStatusType === 'idle';

      if (transitionedToIdle) {
        if (pendingUserInterruptRef.current) {
          trackUserInterruptEnd();
        }
        pendingUserInterruptRef.current = false;
      }

      previousStatusTypeRef.current = currentStatusType;
      return undefined;
    }, [hideMessageArea, session.status?.type, trackUserInterruptEnd]);

    // Permission funnel (spec §5.5): emit shown/responded by diffing the set of
    // tool-call permission requests in history. A request seen without an outcome
    // emits `_shown`; the same request later carrying an outcome emits
    // `_responded` with the local wait_ms. An outcome that appears for a request
    // we never saw pending is treated as resolved elsewhere and never surfaced
    // a card to this client.
    useEffect(() => {
      if (hideMessageArea) return undefined;
      const history = sessionDoc?.history as SessionHistory[] | undefined;
      const scanned = scanPermissionRequests(history);
      if (scanned.length === 0) return undefined;
      const state = permissionRequestStateRef.current;

      for (const entry of scanned) {
        const tracked = state.get(entry.requestId);
        if (!tracked) {
          if (entry.hasOutcome) {
            state.set(entry.requestId, {
              shownAtMs: getPerformanceNowMs(),
              requestKind: entry.requestKind,
              toolKind: entry.toolKind,
              responded: true,
            });
            continue;
          }
          capturePostHogEvent(postHog, 'session/permission_request_shown', {
            ...sessionAnalyticsProperties,
            request_kind: entry.requestKind,
            tool_kind: entry.toolKind,
          });
          state.set(entry.requestId, {
            shownAtMs: getPerformanceNowMs(),
            requestKind: entry.requestKind,
            toolKind: entry.toolKind,
            responded: false,
          });
          continue;
        }

        if (entry.hasOutcome && !tracked.responded) {
          tracked.responded = true;
          const outcome: AnalyticsOutcome = entry.decision === 'allow' ? 'success' : 'blocked';
          capturePostHogOutcome(postHog, 'session/permission_request_responded', outcome, {
            ...sessionAnalyticsProperties,
            request_kind: tracked.requestKind,
            tool_kind: tracked.toolKind,
            decision: entry.decision,
            wait_ms: getDurationSinceMs(tracked.shownAtMs),
          });
        }
      }
      return undefined;
    }, [hideMessageArea, postHog, sessionAnalyticsProperties, sessionDoc?.history]);

    const handleStop = useCallback(async () => {
      if (!workspaceId) {
        captureSessionEvent('session/stop_blocked', {
          reason: 'missing_workspace',
        });
        toast.error(t('sessions.stopError'));
        return;
      }

      const goalToPause = isGoalActive && canPauseGoal ? latestGoal : null;
      const goalTurnId = goalToPause?.turnId?.trim() || null;
      const turnIdToCancel = activeAssistantTurnId ?? goalTurnId;

      if (goalToPause) {
        setInputActionState('ready');
        captureSessionEvent('session/goal_pause_requested', {
          goal_thread_id: goalToPause.threadId,
          cancel_turn_id: turnIdToCancel,
        });
      }

      if (!turnIdToCancel) {
        if (goalToPause) {
          await handleGoalCommand('pause', goalToPause, { showPending: false });
          return;
        }
        captureSessionEvent('session/stop_blocked', {
          reason: 'missing_active_turn',
        });
        toast.error(t('sessions.stopError'));
        return;
      }

      setInputActionState('ready');
      pendingUserInterruptRef.current = true;
      const stopAnalyticsProperties = {
        active_assistant_turn_id: activeAssistantTurnId ?? null,
        cancel_turn_id: turnIdToCancel,
        goal_thread_id: goalToPause?.threadId ?? null,
      };
      captureSessionEvent('session/stop_requested', stopAnalyticsProperties);
      try {
        await requestSessionCancel(session.id, turnIdToCancel);
        captureSessionEvent('session/stop_request_succeeded', stopAnalyticsProperties);
      } catch (error) {
        console.error('Failed to request session cancel', error);
        pendingUserInterruptRef.current = false;
        captureSessionEvent('session/stop_request_failed', {
          ...stopAnalyticsProperties,
          error_name: error instanceof Error ? error.name : typeof error,
          error_message: getErrorMessage(error),
        });
        toast.error(t('sessions.stopError'), { description: getErrorMessage(error) });
        return;
      }

      if (goalToPause) {
        await handleGoalCommand('pause', goalToPause, { showPending: false });
      }
    }, [
      activeAssistantTurnId,
      canPauseGoal,
      captureSessionEvent,
      handleGoalCommand,
      isGoalActive,
      latestGoal,
      requestSessionCancel,
      session.id,
      t,
      workspaceId,
    ]);

    const handleInterruptAndSend = useCallback(
      async (item: MessageQueueItem) => {
        if (isExternalHistoryRefreshing) {
          captureSessionEvent('session/queue_interrupt_blocked', {
            reason: 'external_history_syncing',
            queue_item_id: item.$cid,
          });
          return;
        }
        if (!workspaceId || !activeAssistantTurnId) {
          captureSessionEvent('session/queue_interrupt_blocked', {
            reason: !workspaceId ? 'missing_workspace' : 'missing_active_turn',
            queue_item_id: item.$cid,
          });
          toast.error(t('sessions.interruptFailed', 'Failed to interrupt current task'));
          return;
        }
        setInputActionState('ready');
        pendingUserInterruptRef.current = true;
        try {
          await requestSessionCancel(session.id, activeAssistantTurnId);
          captureSessionEvent('session/queue_interrupt_succeeded', {
            queue_item_id: item.$cid,
            active_assistant_turn_id: activeAssistantTurnId,
          });
        } catch (error) {
          console.error('Failed to interrupt for queued message', error);
          pendingUserInterruptRef.current = false;
          captureSessionEvent('session/queue_interrupt_failed', {
            queue_item_id: item.$cid,
            active_assistant_turn_id: activeAssistantTurnId,
            error_name: error instanceof Error ? error.name : typeof error,
            error_message: getErrorMessage(error),
          });
          toast.error(t('sessions.interruptFailed', 'Failed to interrupt current task'), {
            description: getErrorMessage(error),
          });
        }
      },
      [
        activeAssistantTurnId,
        captureSessionEvent,
        isExternalHistoryRefreshing,
        requestSessionCancel,
        session.id,
        t,
        workspaceId,
      ]
    );

    const handleNativeSteerQueuedMessage = useCallback(
      async (item: MessageQueueItem) => {
        if (isExternalHistoryRefreshing || !activeAssistantTurnId) {
          return;
        }
        if (steeringQueueItemIdsRef.current.has(item.$cid)) {
          return;
        }
        steeringQueueItemIdsRef.current.add(item.$cid);
        try {
          const inputConfig = normalizeSessionTurnInputConfig(item.acpSessionConfig);
          if (!inputConfig) {
            throw new Error('Queued message input config is invalid');
          }
          const inputBlocks = normalizeSessionInputBlocks(
            inputConfig.inputBlocks,
            inputConfig.prompt ?? item.task
          );
          const pendingHistoryEntry = buildPendingUserHistoryEntry({
            userId: item.userId,
            inputBlocks,
            timestamp: item.timestamp,
            inputConfig,
            status: 'pending_apply',
          });
          if (!pendingHistoryEntry) {
            throw new Error('Queued message is empty');
          }
          const queuedUserTurnId = item.userTurnId?.trim() || `queued-${item.$cid}`;
          const { entry: historyEntry } = await addSessionHistory({
            ...pendingHistoryEntry,
            id: queuedUserTurnId,
          });
          await removeMessageQueueItem(item.$cid);
          trackMessageSend(historyEntry.id);
          touchSessionActivity(session.id).catch((error: unknown) => {
            console.warn('Failed to update session activity for steer', error);
          });
          const applied = await guideHistoryEntry(historyEntry.id, activeAssistantTurnId);
          captureSessionEvent('session/queue_guide_result', {
            queue_item_id: item.$cid,
            active_assistant_turn_id: activeAssistantTurnId,
            applied,
          });
        } catch (error) {
          console.error('Failed to guide with queued message', error);
          captureSessionEvent('session/queue_guide_failed', {
            queue_item_id: item.$cid,
            active_assistant_turn_id: activeAssistantTurnId,
            error_name: error instanceof Error ? error.name : typeof error,
            error_message: getErrorMessage(error),
          });
          toast.error(t('sessions.sendError'), {
            description: getErrorMessage(error),
          });
        } finally {
          steeringQueueItemIdsRef.current.delete(item.$cid);
        }
      },
      [
        activeAssistantTurnId,
        addSessionHistory,
        captureSessionEvent,
        guideHistoryEntry,
        isExternalHistoryRefreshing,
        removeMessageQueueItem,
        session.id,
        t,
        touchSessionActivity,
        trackMessageSend,
      ]
    );

    const queueSteerCapability = session.agentConfigId
      ? sessionMachine?.acpCapabilities?.[getAcpCapabilityCacheKey(session.agentConfigId)]
      : undefined;
    const shouldUseNativeQueueSteer = shouldRequestNativeQueueSteer(
      capabilityAuthority,
      queueSteerCapability
    );
    const handleSteerQueuedMessage = useCallback(
      async (item: MessageQueueItem) => {
        if (shouldUseNativeQueueSteer) {
          await handleNativeSteerQueuedMessage(item);
          return;
        }
        await handleInterruptAndSend(item);
      },
      [handleInterruptAndSend, handleNativeSteerQueuedMessage, shouldUseNativeQueueSteer]
    );

    const handleReorderQueueItem = useCallback(
      async (activeCid: string, overCid: string) => {
        try {
          captureSessionEvent('session/queue_item_reorder_requested', {
            queue_item_id: activeCid,
            over_queue_item_id: overCid,
          });
          await reorderMessageQueueItem(activeCid, overCid);
          captureSessionEvent('session/queue_item_reordered', {
            queue_item_id: activeCid,
            over_queue_item_id: overCid,
          });
        } catch (error) {
          console.error('Failed to reorder queued message', error);
          captureSessionEvent('session/queue_item_reorder_failed', {
            queue_item_id: activeCid,
            over_queue_item_id: overCid,
            error_name: error instanceof Error ? error.name : typeof error,
            error_message: getErrorMessage(error),
          });
          toast.error(t('sessions.queueReorderError', 'Failed to reorder messages'), {
            description: getErrorMessage(error),
          });
          throw error;
        }
      },
      [captureSessionEvent, reorderMessageQueueItem, t]
    );

    const handleStartQueueItemEdit = useCallback(
      async (item: MessageQueueItem) => {
        const isFirstItem = messageQueue[0]?.$cid === item.$cid;
        try {
          captureSessionEvent('session/queue_item_edit_started', {
            queue_item_id: item.$cid,
            is_first_queue_item: isFirstItem,
          });
          await updateMessageQueueItem(item.$cid, (current) =>
            current.isEditing
              ? current
              : { ...current, isEditing: true, editingStartedAt: getServerNow() }
          );
          if (isFirstItem) {
            await waitUntilSynced();
          }
        } catch (error) {
          console.error('Failed to start editing queued message', error);
          captureSessionEvent('session/queue_item_edit_start_failed', {
            queue_item_id: item.$cid,
            is_first_queue_item: isFirstItem,
            error_name: error instanceof Error ? error.name : typeof error,
            error_message: getErrorMessage(error),
          });
          toast.error(t('sessions.queueEditError', 'Failed to edit message'), {
            description: getErrorMessage(error),
          });
          throw error;
        }
      },
      [captureSessionEvent, messageQueue, t, updateMessageQueueItem, waitUntilSynced]
    );

    const handleCancelQueueItemEdit = useCallback(
      async (item: MessageQueueItem) => {
        const isFirstItem = messageQueue[0]?.$cid === item.$cid;
        try {
          await updateMessageQueueItem(item.$cid, (current) =>
            current.isEditing
              ? { ...current, isEditing: false, editingStartedAt: undefined }
              : current
          );
          if (isFirstItem) {
            await waitUntilSynced();
          }
          captureSessionEvent('session/queue_item_edit_cancelled', {
            queue_item_id: item.$cid,
            is_first_queue_item: isFirstItem,
          });
        } catch (error) {
          console.error('Failed to cancel queued message edit', error);
          captureSessionEvent('session/queue_item_edit_cancel_failed', {
            queue_item_id: item.$cid,
            is_first_queue_item: isFirstItem,
            error_name: error instanceof Error ? error.name : typeof error,
            error_message: getErrorMessage(error),
          });
          toast.error(t('sessions.queueEditError', 'Failed to edit message'), {
            description: getErrorMessage(error),
          });
          throw error;
        }
      },
      [captureSessionEvent, messageQueue, t, updateMessageQueueItem, waitUntilSynced]
    );

    const handleSaveQueueItemEdit = useCallback(
      async (item: MessageQueueItem, task: string) => {
        const isFirstItem = messageQueue[0]?.$cid === item.$cid;
        try {
          await updateMessageQueueItem(item.$cid, (current) =>
            buildEditedMessageQueueItem(
              current,
              task,
              t('sessions.messageQueue.imageOnly', '[Image message]')
            )
          );
          if (isFirstItem) {
            await waitUntilSynced();
          }
          captureSessionEvent('session/queue_item_edit_saved', {
            queue_item_id: item.$cid,
            is_first_queue_item: isFirstItem,
          });
        } catch (error) {
          console.error('Failed to save queued message edit', error);
          captureSessionEvent('session/queue_item_edit_save_failed', {
            queue_item_id: item.$cid,
            is_first_queue_item: isFirstItem,
            error_name: error instanceof Error ? error.name : typeof error,
            error_message: getErrorMessage(error),
          });
          toast.error(t('sessions.queueEditError', 'Failed to edit message'), {
            description: getErrorMessage(error),
          });
          throw error;
        }
      },
      [captureSessionEvent, messageQueue, t, updateMessageQueueItem, waitUntilSynced]
    );

    const handleRemoveQueueItem = useCallback(
      async (itemId: string) => {
        try {
          await removeMessageQueueItem(itemId);
          captureSessionEvent('session/queue_item_removed', {
            queue_item_id: itemId,
          });
        } catch (error) {
          console.error('Failed to remove queued message', error);
          captureSessionEvent('session/queue_item_remove_failed', {
            queue_item_id: itemId,
            error_name: error instanceof Error ? error.name : typeof error,
            error_message: getErrorMessage(error),
          });
          toast.error(t('sessions.queueRemoveError', 'Failed to remove message'), {
            description: getErrorMessage(error),
          });
        }
      },
      [captureSessionEvent, removeMessageQueueItem, t]
    );

    const shouldHideHeader = hideHeader;

    const prBadge =
      canShowGitHubActions && latestPr ? (
        <PullRequestBadge
          pr={latestPr}
          size="md"
          onOpenTab={
            onOpenPrTab && latestPrNumber && latestPrRepoFullName
              ? () =>
                  onOpenPrTab({
                    prNumber: latestPrNumber,
                    repoFullName: latestPrRepoFullName,
                    headCommitSha: getSessionPullRequestLegacyFields(latestPr).headCommitSha,
                  })
              : undefined
          }
        />
      ) : null;

    const localProjectId = useMemo(() => {
      const rawSessionProject = session.project;
      if (!rawSessionProject || rawSessionProject.kind !== 'local') {
        return null;
      }
      if (typeof rawSessionProject.localProjectId !== 'string') {
        return null;
      }
      const trimmed = rawSessionProject.localProjectId.trim();
      return trimmed ? (trimmed as LocalProjectId) : null;
    }, [session.project]);

    const localProjectRootPath = useMemo(() => {
      if (!isLocalSession || !localProjectId) {
        return null;
      }
      const rawPath = sessionMachineLocalProjects[localProjectId]?.rootPath;
      if (typeof rawPath !== 'string') {
        return null;
      }
      const trimmed = rawPath.trim();
      return trimmed || null;
    }, [isLocalSession, localProjectId, sessionMachineLocalProjects]);

    const worktreePath = useMemo(() => {
      if (!isLocalSession || !session.isWorktree) return null;
      return resolveSessionWorkspacePath({
        sessionId: session.id,
        ownerSessionId: session.parentSessionId,
        isWorktree: true,
        dotlodyPath: machineDotlodyPath,
        localProjectRootPath,
        repoFullName,
      });
    }, [
      isLocalSession,
      localProjectRootPath,
      machineDotlodyPath,
      repoFullName,
      session.id,
      session.isWorktree,
      session.parentSessionId,
    ]);
    const handleFilePathClick = useStableCallback((filePath: string) => {
      onFilePathClick?.(filePath);
    });
    const handleOpenHtmlAttachment = useStableCallback((file: SessionFilePayload): boolean => {
      const action = resolveSessionHtmlAttachmentAction({
        isLocalSession,
        sourcePath: file.sourcePath,
        connectionStatus: session.previewConnection?.status,
        candidateStatus: session.previewCandidate?.status,
      });
      switch (action.kind) {
        case 'open-local-file':
          if (!onOpenHtmlFile) return false;
          onOpenHtmlFile(action.sourcePath);
          return true;
        case 'open-existing-browser':
          if (!onOpenExistingBrowser) return false;
          onOpenExistingBrowser();
          return true;
        case 'confirm-reported-port':
          if (!onOpenBrowser) return false;
          setPendingRemoteHtmlFileName(file.fileName);
          return true;
        case 'fallback':
          return false;
      }
      return false;
    });
    const openInIdeTarget = useMemo(
      () =>
        resolveSessionOpenInIdePathTarget({
          worktreePath,
          localProjectRootPath,
        }),
      [localProjectRootPath, worktreePath]
    );
    const openInIdePath = openInIdeTarget?.path ?? null;
    const openInIdePathSource = openInIdeTarget?.source ?? null;
    const resolveOpenInIdePath = useCallback(async (): Promise<string | null> => {
      return openInIdePath;
    }, [openInIdePath]);

    const [pathLauncherPreference, setPathLauncherPreference] = useState(
      readStoredPathLauncherPreference
    );
    useEffect(() => {
      if (typeof window === 'undefined') return undefined;

      const refreshPreference = () => {
        setPathLauncherPreference(readStoredPathLauncherPreference());
      };
      const handleStorage = (event: StorageEvent) => {
        if (event.key === PATH_LAUNCHER_PREFERENCE_STORAGE_KEY) {
          refreshPreference();
        }
      };

      window.addEventListener(PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT, refreshPreference);
      window.addEventListener('storage', handleStorage);
      return () => {
        window.removeEventListener(PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT, refreshPreference);
        window.removeEventListener('storage', handleStorage);
      };
    }, []);

    const isElectronRendererForPathLaunch =
      typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
    const electronPathLauncherPlatform =
      typeof window !== 'undefined' ? window.__LODY_PLATFORM__?.os : undefined;
    const launcherCandidates = useMemo(
      () =>
        getAvailablePathLauncherOptions({
          customLaunchers: pathLauncherPreference.customLaunchers,
          isElectron: isElectronRendererForPathLaunch,
          platform: electronPathLauncherPlatform,
        }),
      [
        electronPathLauncherPlatform,
        isElectronRendererForPathLaunch,
        pathLauncherPreference.customLaunchers,
      ]
    );
    const [availableLauncherIds, setAvailableLauncherIds] = useState(new Set<string>());
    useEffect(() => {
      if (!isElectronRendererForPathLaunch || !openInIdePath) {
        setAvailableLauncherIds(new Set());
        return undefined;
      }
      const services = getIpcServices();
      if (!services) return undefined;

      let cancelled = false;
      const launchers = buildPathLauncherProbes(
        launcherCandidates,
        openInIdePath,
        electronPathLauncherPlatform
      );
      void services.app
        .probePathLaunchers({
          launchers,
        })
        .then(
          (result) => {
            if (!cancelled) {
              setAvailableLauncherIds(new Set(result.availableIds));
            }
          },
          () => {
            // A failed probe must not advertise launchers whose presence could
            // not be established.
            if (!cancelled) setAvailableLauncherIds(new Set());
          }
        );
      return () => {
        cancelled = true;
      };
    }, [
      launcherCandidates,
      electronPathLauncherPlatform,
      isElectronRendererForPathLaunch,
      openInIdePath,
    ]);
    const pathLauncherOptions = useMemo(
      () =>
        launcherCandidates.filter((launcher) =>
          availableLauncherIds.has(getPathLauncherId(launcher))
        ),
      [availableLauncherIds, launcherCandidates]
    );
    const shouldShowOpenInIdeButton = Boolean(openInIdePath) && pathLauncherOptions.length > 0;
    const selectedPathLauncher = useMemo(
      () =>
        resolveSelectedPathLauncher(pathLauncherPreference.selectedLauncherId, pathLauncherOptions),
      [pathLauncherOptions, pathLauncherPreference.selectedLauncherId]
    );
    const SelectedPathLauncherIcon = getPathLauncherIcon(selectedPathLauncher);

    const persistSelectedPathLauncher = useCallback(
      (launcherId: string) => {
        const nextPreference = { ...pathLauncherPreference, selectedLauncherId: launcherId };
        setPathLauncherPreference(nextPreference);
        writeStoredPathLauncherPreference(nextPreference);
      },
      [pathLauncherPreference]
    );

    const launchPathWithLauncher = useCallback(
      async (launcher: PathLauncherOption, analyticsEvent: string) => {
        const path = await resolveOpenInIdePath();
        if (!path) return;

        const launcherId = getPathLauncherId(launcher);
        try {
          const request = buildPathLauncherLaunchInput(
            launcher,
            path,
            electronPathLauncherPlatform
          );
          const analyticsProperties = {
            // Custom launcher ids are random uuids, so collapse them to a single
            // `custom` value to keep `ide_id` low-cardinality in analytics;
            // `launcher_kind` already distinguishes builtin vs custom.
            ide_id: launcher.kind === 'custom' ? 'custom' : launcherId,
            launcher_kind: launcher.kind,
            launch_method: request.kind,
            path_source: openInIdePathSource,
          };
          captureSessionEvent(analyticsEvent, analyticsProperties);

          // Launchers run entirely through the desktop bridge now (CLI spawn with
          // native protocol fallbacks); web no longer probes local apps.
          if (!getIpcServices()) {
            captureSessionEvent('session/open_in_ide_failed', {
              ...analyticsProperties,
              reason: 'native_bridge_unavailable',
            });
            toast.error(
              t(
                'sessions.pathLaunchUnsupported',
                'This launcher is only available in the desktop app'
              )
            );
            return;
          }

          const result = await getIpcServices()!.app.launchLocalPath(request);
          if (!result.launched) {
            captureSessionEvent('session/open_in_ide_failed', {
              ...analyticsProperties,
              reason: result.error,
            });
            toast.error(t('sessions.pathLaunchFailed', 'Failed to open path'));
          }
        } catch (error) {
          captureSessionEvent('session/open_in_ide_failed', {
            ide_id: launcher.kind === 'custom' ? 'custom' : launcherId,
            launcher_kind: launcher.kind,
            path_source: openInIdePathSource,
            reason: getErrorMessage(error),
          });
          toast.error(t('sessions.pathLaunchFailed', 'Failed to open path'));
        }
      },
      [
        captureSessionEvent,
        electronPathLauncherPlatform,
        openInIdePathSource,
        resolveOpenInIdePath,
        t,
      ]
    );

    const handleSelectPathLauncher = useCallback(
      async (launcher: PathLauncherOption) => {
        persistSelectedPathLauncher(getPathLauncherId(launcher));
        await launchPathWithLauncher(launcher, 'session/open_in_ide_selected');
      },
      [launchPathWithLauncher, persistSelectedPathLauncher]
    );

    const handleOpenInIde = useCallback(() => {
      void launchPathWithLauncher(selectedPathLauncher, 'session/open_in_ide_clicked');
    }, [launchPathWithLauncher, selectedPathLauncher]);

    const handleCopyPath = useCallback(async () => {
      const path = await resolveOpenInIdePath();
      if (!path) {
        captureSessionEvent('session/path_copy_failed', {
          reason: 'missing_path',
        });
        toast.error(t('sessions.pathCopyFailed', 'Failed to copy path'));
        return;
      }
      try {
        await navigator.clipboard.writeText(path);
        captureSessionEvent('session/path_copied', {
          path_source: openInIdePathSource,
        });
      } catch {
        captureSessionEvent('session/path_copy_failed', {
          reason: 'clipboard_error',
        });
        toast.error(t('sessions.pathCopyFailed', 'Failed to copy path'));
      }
    }, [captureSessionEvent, openInIdePathSource, resolveOpenInIdePath, t]);

    const handleOpenPathLauncherSettings = useCallback(() => {
      captureSessionEvent('session/open_in_ide_manage_clicked');
      openSettings('preferences');
    }, [captureSessionEvent, openSettings]);

    const handleCopySessionLink = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(getAppShareUrl());
        captureSessionEvent('session/share_link_copied');
        toast.success(t('sessions.urlCopied', 'Session URL copied to clipboard'));
      } catch {
        captureSessionEvent('session/share_link_copy_failed');
        toast.error(t('sessions.shareFailed', 'Unable to share link'));
      }
    }, [captureSessionEvent, t]);

    const headerGitHubActions = headerActionsSlot !== undefined ? headerActionsSlot : prBadge;

    const prLinkHandler =
      onOpenPrTab && latestPr && latestPrRepoFullName && latestPrNumber
        ? () =>
            onOpenPrTab({
              prNumber: latestPrNumber,
              repoFullName: latestPrRepoFullName,
              headCommitSha: getSessionPullRequestLegacyFields(latestPr).headCommitSha,
            })
        : undefined;
    const permissionSessionHistory = sessionDoc?.history as Parameters<
      typeof FloatingPermissionRequest
    >[0]['sessionHistory'];
    const shouldReplaceComposerWithPermission = hasPendingPermissionRequest(
      liveSessionStatus ?? undefined,
      permissionSessionHistory
    );

    /* Shared header pieces used by both header variants. */
    const headerLauncherActions = (
      <>
        {shouldShowOpenInIdeButton && isElectronRendererForPathLaunch && (
          <div className="flex items-center">
            <Button
              className="h-6 px-2 py-1 rounded-r-none border-r-0 gap-1"
              variant="outline"
              size="sm"
              onClick={handleOpenInIde}
            >
              <SelectedPathLauncherIcon className="h-3.5 w-3.5" />
              <span className="text-xs">{selectedPathLauncher.label}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className="h-6 px-1 py-1 rounded-l-none"
                  variant="outline"
                  size="sm"
                  aria-label={t('sessions.selectPathLauncher', 'Select launcher')}
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {pathLauncherOptions.map((launcher) => {
                  const launcherId = getPathLauncherId(launcher);
                  const LauncherIcon = getPathLauncherIcon(launcher);
                  return (
                    <DropdownMenuItem
                      key={launcherId}
                      onClick={() => {
                        void handleSelectPathLauncher(launcher);
                      }}
                    >
                      <LauncherIcon className="h-3.5 w-3.5" />
                      {launcher.label}
                      {launcherId === getPathLauncherId(selectedPathLauncher) && (
                        <Check className="ml-auto h-3.5 w-3.5" />
                      )}
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuSeparator />
                {ACTION_OPTIONS.map((action) => (
                  <DropdownMenuItem
                    key={action.id}
                    onClick={
                      action.id === 'copy-path'
                        ? () => {
                            void handleCopyPath();
                          }
                        : undefined
                    }
                  >
                    <action.Icon className="h-3.5 w-3.5" />
                    {t('sessions.copyPath', action.label)}
                  </DropdownMenuItem>
                ))}
                {isElectronRendererForPathLaunch && (
                  <DropdownMenuItem onClick={handleOpenPathLauncherSettings}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('sessions.managePathLaunchers', 'Add more…')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </>
    );
    const headerMenuNode = (
      <SessionHeaderMenu
        session={session}
        localProjectMeta={resolvedLocalProjectMeta}
        workspacePath={sessionWorkspacePath}
        machineName={sessionMachine?.name}
        onCopyConversationHistory={
          hideMessageArea && onCopyConversationHistoryExternal
            ? onCopyConversationHistoryExternal
            : () => {
                void handleCopyConversationHistory();
              }
        }
        onCopyUrl={() => {
          void handleCopySessionLink();
        }}
        sharing={sharing}
        onShareWithTeam={onShareWithTeam}
        onOpenSearch={hideMessageArea ? onOpenSearchExternal : openSearch}
        onFork={canForkFromMenu ? handleForkFromMenu : undefined}
        isForking={forkingAssistantMessageId !== null && forkingAssistantMessageId !== undefined}
        forkWorktreeAvailability={forkWorktreeAvailability}
        onForkMenuOpen={onForkWorktreeMenuOpen}
        onRename={
          headerVariant === 'toolbar'
            ? onRequestRename
            : () => {
                setRenameDialogTarget({
                  sessionId: session.id,
                  initialTitle: session.title ?? '',
                });
              }
        }
        onOpenReviewSettings={() => openSettings('preferences')}
        owner={ownerMenuState}
        openedByRelations={openedByRelations}
        onArchive={onArchiveSession}
        onRestore={onRestoreSession}
        onDelete={onDeleteSession}
        t={t}
      />
    );
    const headerAccessNode =
      sharing && !isMobile ? (
        <SessionAccessControl state={sharing} onShareWithTeam={onShareWithTeam} />
      ) : null;
    const headerArchivedNode = session.isArchived === true ? <SessionArchivedBadge /> : null;

    return (
      <PrLinkProvider prUrl={latestPr?.url} onOpenPrTab={prLinkHandler}>
        <SessionConversationPage
          className={className}
          dropActive={imageDropZone.isActive || sessionMentionOverlay}
          dropKind={sessionMentionOverlay ? 'session-mention' : 'files'}
          hideMessageArea={hideMessageArea}
          {...pageDropHandlers}
        >
          {/* The outline must centre in the whole conversation page, not only
              the flex area left after the composer takes its height. */}
          <div
            ref={setOutlineOverlayRoot}
            className="pointer-events-none absolute inset-0 @container"
          />
          {!shouldHideHeader &&
            (headerVariant === 'toolbar' ? (
              /* Compact toolbar for the merged desktop tab row: right-side
                 controls only — no title (the context strip owns identity) and
                 no PR badge (the strip owns PR). */
              <ErrorBoundary name="SessionChatHeader" variant="inline" resetKeys={[session.id]}>
                <div className="flex h-full shrink-0 items-center gap-1 pl-1 pr-2">
                  {headerLauncherActions}
                  {headerArchivedNode}
                  {headerAccessNode}
                  {headerMenuNode}
                  {headerEndSlot}
                </div>
              </ErrorBoundary>
            ) : (
              <ErrorBoundary name="SessionChatHeader" variant="inline" resetKeys={[session.id]}>
                <SessionConversationPageHeader
                  startSlot={headerStartSlot}
                  titleSlot={
                    <SessionProjectInfo
                      session={session}
                      isLoading={shouldShowTitleLoading}
                      isSyncing={effectiveTitleSyncing}
                      isMachineOffline={sessionMachineOnlineStatus === 'offline'}
                      t={t}
                      localProjectMeta={resolvedLocalProjectMeta}
                    />
                  }
                  desktopActionsSlot={
                    <div className={cn('flex shrink-0 items-center gap-2', isMobile && 'hidden')}>
                      {headerLauncherActions}
                      {headerGitHubActions}
                      {headerArchivedNode}
                      {headerAccessNode}
                    </div>
                  }
                  menuSlot={headerMenuNode}
                  endSlot={headerEndSlot}
                  nativeApp={isNativeApp}
                  reserveMacTrafficLightInset={
                    !isNativeApp &&
                    Boolean(headerStartSlot) &&
                    isMacOSElectronRenderer() &&
                    !isElectronFullscreen
                  }
                />
              </ErrorBoundary>
            ))}
          {subHeader}
          {hideMessageArea ? null : (
            <>
              <SessionPin
                pinnedHistoryId={pinnedHistoryId}
                history={sessionHistoryForPin}
                onUnpin={handleUnpin}
                onScrollToMessage={handleScrollToMessage}
              />
              <SessionSearchProvider value={searchContextValue}>
                <SessionPinContext.Provider value={pinContextValue}>
                  {/* Message area */}
                  <div ref={messageAreaRef} className="relative flex-1 min-h-0">
                    {isSearchOpen ? (
                      <SessionSearchBar
                        query={searchQuery}
                        currentIndex={activeSearchResultIndex}
                        totalCount={searchResults.length}
                        inputRef={searchInputRef}
                        onQueryChange={handleSearchQueryChange}
                        onPrevious={() => moveToSearchResult('previous')}
                        onNext={() => moveToSearchResult('next')}
                        onClose={closeSearch}
                        t={t}
                      />
                    ) : null}
                    <ErrorBoundary
                      name="SessionChatStream"
                      variant="section"
                      resetKeys={[session.id]}
                      fallbackRender={({ resetErrorBoundary }) => (
                        <div className="flex h-full w-full items-center justify-center p-4 text-center">
                          <div className="max-w-md">
                            <div className="text-sm font-semibold text-foreground">
                              {t('common.somethingWentWrong', 'Something went wrong')}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {t(
                                'sessions.messageListCrashed',
                                'The message list failed to render. Your draft message below is safe.'
                              )}
                            </div>
                            <div className="mt-3 flex justify-center gap-2">
                              <button
                                type="button"
                                className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                                onClick={resetErrorBoundary}
                              >
                                {t('common.tryAgain', 'Try again')}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    >
                      {/* Key forces remount on session change, preventing scroll state bleed between sessions */}
                      <MessageSendStatusContext.Provider value={sendingMessageIds}>
                        <SessionChatStream
                          key={session.id}
                          ref={chatStreamRef}
                          sessionId={session?.id}
                          workspaceId={workspaceId}
                          sessionDoc={sessionDoc}
                          sessionCreatedAt={session?.createdAt}
                          dividerLabel={sessionDividerLabel}
                          className="h-full"
                          leadingContent={openedByConversationStart}
                          emptyState={chatStreamEmptyState}
                          agentActivityLabel={agentActivityLabel}
                          agentActivityTone={agentActivityTone}
                          onFileDiffClick={onFileDiffClick}
                          onFilePathClick={onFilePathClick ? handleFilePathClick : undefined}
                          onOpenHtmlFile={handleOpenHtmlAttachment}
                          messageFileDiffEntriesByTurn={messageFileDiffEntriesByTurn}
                          assistantActions={assistantQuickActions}
                          assistantActionsMessageId={latestCompletedProposedPlan?.entryId}
                          onForkLastAssistant={onForkLastAssistant}
                          forkWorktreeAvailability={forkWorktreeAvailability}
                          onForkWorktreeMenuOpen={onForkWorktreeMenuOpen}
                          onEditLastUser={
                            editableLastUserMessageId ? handleEditLastUser : undefined
                          }
                          onResendUndelivered={handleResendUndelivered}
                          capacityRetry={capacityRetry ?? undefined}
                          forkingAssistantMessageId={forkingAssistantMessageId}
                          onNavigateSession={onNavigateSession}
                          onLastCompletedAssistantMessageIdChange={
                            handleLastCompletedAssistantMessageIdChange
                          }
                          conversationFontSize={conversationFontSize}
                          skipNextViewportResizeAutoScrollRef={skipNextViewportResizeAutoScrollRef}
                          suppressStickyAutoScrollRef={suppressStickyAutoScrollRef}
                          outlineOverlayRoot={outlineOverlayRoot}
                        />
                      </MessageSendStatusContext.Provider>
                    </ErrorBoundary>
                  </div>

                  {/* Floating permission request - shown when session is waiting for permission */}
                  <FloatingPermissionRequest
                    sessionId={session.id}
                    sessionStatus={liveSessionStatus ?? undefined}
                    sessionHistory={permissionSessionHistory}
                  />

                  {/* Notification permission prompt - shown when session becomes idle (turn completed) */}
                  {/* TODO(analytics): session/notification_prompt_shown|_permission_granted|_permission_denied.
                      Visibility + enable/dismiss live inside NotificationPermissionPrompt (owned elsewhere)
                      and the actual grant/deny resolves on the settings page, so these must be emitted from
                      that component via onShown/onEnableClicked/onDismissed callbacks (see crossFileNeeds). */}
                  <NotificationPermissionPrompt
                    sessionCompleted={session.status?.type === 'idle' && !isSessionWorking}
                  />

                  {/* An active auto-review run states itself here rather than
                      only in the "…" menu: the failure mode worth designing
                      against is a user who ticked the box days ago, forgot, and
                      then finds a pull request merged itself. */}
                  {autoReview.run && autoReview.active ? (
                    <ConversationColumn className="px-3 pb-1.5">
                      <AutoReviewStatus
                        run={autoReview.run}
                        maxRounds={autoReview.run.policy.budget.reviewRounds}
                        onDisable={() => {
                          void autoReview.disable();
                        }}
                        onConfirmMerge={() => {
                          void autoReview.confirmMerge();
                        }}
                        onResume={() => {
                          void autoReview.resume();
                        }}
                        onFixFinding={(finding) => {
                          void dispatchPrompt(
                            buildAuthorFixPrompt([finding], {
                              // Same reason as the engine's own dispatch: with a
                              // PR open, a committed-but-unpushed fix is invisible
                              // to everything that reads the PR head.
                              hasPullRequest: hasExistingPr,
                            }),
                            executionTurnConfigOverrides
                          );
                        }}
                      />
                    </ConversationColumn>
                  ) : null}

                  {/* Session info bar (desktop AND mobile): the canonical
                      cluster + fixed stage row merging status, goal, schedule,
                      and work context, glued to the composer shell. It
                      replaced the mobile status strip / goal banner /
                      in-composer scheduled panel. */}
                  <SessionInfoBar
                    status={statusStripState}
                    goal={latestGoal}
                    goalCommands={goalCommands}
                    goalPendingCommand={
                      pendingGoalCommand && pendingGoalCommand.threadId === latestGoal?.threadId
                        ? pendingGoalCommand.command
                        : null
                    }
                    onGoalCommand={handleGoalCardCommand}
                    onGoalDismiss={handleDismissGoalBanner}
                    task={sessionTaskChip}
                    onOpenTask={handleOpenSessionTask}
                    scheduledTasks={pendingScheduledTasks}
                    prCiRuns={infoBarPrCiRuns}
                    onOpenPrCiRun={handleOpenPrCiRun}
                    projectName={repoFullName || resolvedLocalProjectMeta?.name || null}
                    branch={isMobile ? null : session.branchName?.trim() || null}
                    workspaceLocation={
                      session.isWorktree
                        ? {
                            // GitHub sessions are always worktrees, so surface the
                            // GitHub identity rather than the redundant worktree mark.
                            kind: repoFullName ? 'github-worktree' : 'worktree',
                            path: sessionWorkspacePath,
                          }
                        : resolvedLocalProjectMeta
                          ? { kind: 'folder', path: sessionWorkspacePath }
                          : null
                    }
                    pr={canShowGitHubActions ? effectiveLatestPr : null}
                    onOpenPr={prLinkHandler}
                    contextActions={infoBarContextActions}
                    onOpenAllChanges={onOpenAllChanges}
                    onOpenBrowser={browserActionAvailable ? handleOpenBrowser : undefined}
                    privateAccessStatus={
                      isMobile && sharing?.visibility === 'private'
                        ? {
                            label: t('sharing.privateOnlyYou', 'Private · Only you'),
                            description: getSessionSharingDescription(t, sharing),
                            onAction:
                              sharing.canManage && onShareWithTeam
                                ? () => {
                                    void onShareWithTeam();
                                  }
                                : undefined,
                          }
                        : undefined
                    }
                    diffStat={changesDiffStat}
                    // Desktop only: mobile already shows catch-up in its header.
                    syncing={!isMobile && effectiveTitleSyncing}
                    // Mobile keeps the bar above the session drawer's z-30
                    // edge-back strip so its leading chip stays tappable.
                    protectFromEdgeBackZone={isMobile}
                  />

                  {/* Input area - isolated component to prevent full re-renders on typing.
                      Hidden while a permission is pending so the response buttons claim
                      the bottom surface; chat queue is bypassed for the same reason. */}
                  {shouldReplaceComposerWithPermission ? null : (
                    <SessionChatInputArea
                      claimNavigationFocus={isVisible ? claimNavigationFocus : undefined}
                      ref={inputAreaRef}
                      session={session}
                      sessionLocalProjectRootPath={resolvedLocalProjectMeta?.rootPath ?? null}
                      isMachineRemoved={isMachineRemoved}
                      isAgentBusy={isAgentBusy}
                      canStopAgent={canStopAgent}
                      isExternalHistoryRefreshing={isExternalHistoryRefreshing}
                      externalHistorySyncLabel={externalHistorySyncLabel}
                      isDark={isDark}
                      isEmptyConversation={isEmptyConversation}
                      selectedModeId={selectedModeId}
                      selectedModelId={selectedModelId}
                      durableAgentRoleId={sessionConversationConfig.agentRoleId}
                      durableAgentRoleRevision={sessionConversationConfig.agentRoleRevision}
                      durableAgentRoleSourceTurnKey={sessionConversationSourceFence.currentTurnKey}
                      durableAgentRoleKnownTurnKeys={sessionConversationSourceFence.knownTurnKeys}
                      durableAgentRoleReady={sessionDocReady}
                      runConfigHasUserEdits={sessionRunConfigHasUserEdits}
                      modeOptions={modeOptions}
                      modelOptions={modelOptions}
                      rateLimits={sessionRateLimits}
                      showCodexResetForecast={showCodexResetForecast}
                      isContextCompacting={isContextCompacting}
                      configOptionSelectors={configOptionSelectors}
                      configOptionValues={configOptionValues}
                      isRepoPublic={isRepoPublic}
                      availableCommands={availableCommands}
                      commandsEnabled={isVisible}
                      freeTurnLimitNotice={freeSessionTurnNotice}
                      queueDisplay={
                        messageQueue.length > 0 ? (
                          <MessageQueueDisplay
                            sessionId={session.id}
                            items={messageQueue}
                            onRemove={handleRemoveQueueItem}
                            onReorder={handleReorderQueueItem}
                            onEditStart={handleStartQueueItemEdit}
                            onEditCancel={handleCancelQueueItemEdit}
                            onEditSave={handleSaveQueueItemEdit}
                            onSteer={handleSteerQueuedMessage}
                            showSteerAction={
                              isSessionActive &&
                              !!activeAssistantTurnId &&
                              !isExternalHistoryRefreshing
                            }
                          />
                        ) : null
                      }
                      mcp={mcpSelection.menu}
                      skipNextViewportResizeAutoScrollRef={skipNextViewportResizeAutoScrollRef}
                      onModeChange={handleModeChange}
                      onModelChange={handleModelChange}
                      onConfigOptionChange={handleConfigOptionChange}
                      onSendMessage={handleSendMessage}
                      onStop={() => {
                        void handleStop();
                      }}
                      onRemoveQueueItem={handleRemoveQueueItem}
                      onAgentConfigChange={isChildSession ? handleAgentConfigChange : undefined}
                      onNavigateToComment={onNavigateToComment}
                      onCommentReferencesChange={onCommentReferencesChange}
                      onVisualAnnotationReferencesChange={onVisualAnnotationReferencesChange}
                      onVisualAnnotationReferencesSubmitted={onVisualAnnotationReferencesSubmitted}
                    />
                  )}
                </SessionPinContext.Provider>
              </SessionSearchProvider>
            </>
          )}
          <RenameSessionDialog
            target={renameDialogTarget}
            onClose={() => setRenameDialogTarget(null)}
          />
          <AlertDialog
            open={pendingRemoteHtmlFileName !== null}
            onOpenChange={(open) => {
              if (!open) setPendingRemoteHtmlFileName(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('sessions.htmlAttachment.openReportedPortTitle', 'Open the reported port?')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    'sessions.htmlAttachment.openReportedPortDescription',
                    'To preview {{name}}, Lody will connect to the local port reported by the Agent and open it in Browser.',
                    { name: pendingRemoteHtmlFileName ?? '' }
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setPendingRemoteHtmlFileName(null);
                    onOpenBrowser?.();
                  }}
                >
                  {t('sessions.htmlAttachment.openReportedPortAction', 'Connect and open')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </SessionConversationPage>
      </PrLinkProvider>
    );
  })
);

SessionChatInterface.displayName = 'SessionChatInterface';
