import {
  type ComponentPropsWithoutRef,
  type ComponentType,
  type ElementType,
  createContext,
  forwardRef,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ZoomableImageViewer,
  type ImagePreviewPortalAnchorRef,
} from '@/components/shared/zoomable-image-viewer';
import { useIsMessageSendingVisible } from './message-send-status-context';
import {
  getCopyTextFromMessageItems,
  getTextContentFromMessageItems,
  getUserTextRenderSlice,
  getVisibleAssistantTextContent,
  hasTextContentFromMessageItems,
} from './message-copy';
import { useAtomValue } from 'jotai';
import { getRpcDeliveredTurnKey, rpcDeliveredTurnsAtom } from '@/atoms/session-dispatch-delivery';
import { selectAtom } from 'jotai/utils';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import {
  type AgentConfigCliType,
  type ChatFailedCode,
  type ClientToServer,
  MODEL_THOUGHT_LEVEL_META_KEY,
  isAcpFastModeConfigId,
  isAcpThoughtLevelConfigOption,
  isAcpPlanModeConfigOption,
  isSessionHistoryDelivered,
  type AcpConfigOptionValue,
  type MessageContent,
  type SessionHistoryParsed,
  type SessionId,
  type SessionInputBlock,
  type SessionTurnInputConfig,
  type SessionMeta,
  type SessionGoalCommand,
  type WorkspaceId,
  getSessionLaunchConfigLegacyFields,
  getSessionRoomId,
  machineSupportsAcpProtocolAuthentication,
  supportsAuthenticationWhenRequired,
  usesAcpProtocolAuthentication,
  type CommentReferencePayload,
  type VisualAnnotationReferencePayload,
  sanitizeGoalObjective,
  extractAskUserQuestionAnswersFromOutcome,
  parseAskUserQuestionPermissionMeta,
  SESSION_FILE_MAX_COUNT,
} from '@lody/shared';
import { AskUserQuestionCard } from '@/components/sessions/ask-user-question-card';
import { PermissionRequestCard } from '@/components/sessions/floating-permission-request';
import { CommentReferenceCard } from './comment-reference-card';
import { VisualAnnotationReferenceCard } from './visual-annotation-reference-card';
import { currentWorkspaceIdAtom } from '@/atoms';
import { getAgentMetaByIdAtomFamily } from '@/atoms/agents';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { authTokenAtom } from '@/atoms/runtime';
import { useStickyScroll } from '@/hooks/use-sticky-scroll';
import { buildResendInputBlocks, isUndeliveredUserTurnEntry } from '@/lib/undelivered-user-turn';
import { ConversationOutlineRail } from './conversation-outline-rail';
import { TurnPlaceholderRow } from './turn-placeholder-row';
import type { TurnIndexRow } from '@/lib/conversation-view';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import {
  buildConversationOutline,
  buildOutlineAnchors,
  resolveActiveOutlineIndex,
  reuseConversationOutline,
  reuseOutlineAnchors,
  type ConversationOutlineAnchor,
  type ConversationOutlineEntry,
} from '@/lib/conversation-outline';
import {
  AlertCircle,
  ArrowDown,
  BookOpen,
  Brain,
  BrushCleaning,
  Check,
  X,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Copy,
  FileText,
  Globe,
  Info,
  ListChecks,
  Loader2,
  MoveRight,
  PencilLine,
  Search,
  Sparkles,
  Target,
  Terminal,
  Trash2,
  TriangleAlert,
  Workflow,
  GitFork,
  Pin,
  PinOff,
  Wrench,
} from 'lucide-react';
import { MarkdownRenderer } from './markdown-renderer';
import { CarbonInProgress } from '@/components/icons/carbon-in-progress';
import { getGoalStatusPresentation } from '@/lib/session-goal-status';
import { FileIcon } from '@/components/icons/file-icons';
import { AnthropicIcon } from '@/components/icons/anthropic-icon';
import { OpenAIIcon } from '@/components/icons/openai-icon';
import { AgentIcon } from '@/components/icons/agent-icon';
import { AssistantEditedFiles, type AssistantEditedFileEntry } from './assistant-edited-files';
import {
  SessionForkDestinationPopover,
  type SessionForkDestination,
  type SessionForkWorktreeAvailability,
} from '@/components/sessions/session-fork-destination-menu';
import {
  buildAssistantMessageRenderItems,
  type AssistantMessageRenderItem,
} from './assistant-message-render-items';
import {
  buildAssistantTurnRenderLayout,
  type AssistantActivityRenderItem,
  type AssistantActivitySummary,
  type AssistantToolCallRenderItem,
  type AssistantTurnRenderBlock,
} from './assistant-turn-render-blocks';
import { SubagentTaskPanel, collectSubagentTasks } from './subagent-task-panel';
import { UserMessageEditor } from './user-message-editor';
import { resolvePermissionRecord } from './permission-record';
import {
  hasSeparatePlanItem,
  hasUnansweredPlanApproval,
  resolvePlanExitMarkdown,
} from './plan-surface';
import {
  CONVERSATION_PANEL_BODY_CLASS,
  CONVERSATION_PANEL_FRAME_CLASS,
  CONVERSATION_PANEL_HEADER_CLASS,
  CONVERSATION_PANEL_HEADER_RULE_CLASS,
  CONVERSATION_PANEL_TITLE_CLASS,
} from './conversation-panel';
import { TerminalComponent } from './terminal-component';
import { prepareTerminalOutputBlocksPreview } from './terminal-preview';
import { type DurationUnitLabels, formatDurationCompact } from '@/lib/format-duration';
import { resolveSessionHistoryDurationMs } from '@/lib/session-history-duration';
import { cn } from '@/lib/utils';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { SessionRelationCard } from '@/components/shared/session-relation-card';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { AcpAuthenticationPanel } from '@/components/settings/acp-authentication-panel';
import { formatConversationTimestamp } from '@/lib/format-conversation-timestamp';
import { toIntlLocale } from '@/lib/intl-locale';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { normalizeWorktreePath, normalizeWorktreeTitle } from '@/lib/worktree-path';
import { Badge } from '@/ui/badge';
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
import { Button } from '@/ui/button';
import {
  AgentActivityIndicator,
  type AgentActivityTone,
} from '@/components/shared/agent-activity-indicator';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import { DiffViewer } from '@/ui/diff-viewer/diff-viewer';
import { Skeleton } from '@/ui/skeleton';
import { getSessionImageBlobUrl, getSessionImageDataUrl } from '@/lib/session-image-cache';
import { SessionFileCard, SessionFileCardList } from './session-file-card';
import {
  SessionFilePreviewDialog,
  type SessionFilePreviewStatus,
} from './session-file-preview-dialog';
import { downloadSessionFile, fetchSessionFilePreview } from '@/lib/session-file-download';
import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import { isHtmlSessionFile } from '@/lib/session-file-presentation';
import type {
  MachineId,
  MessageTextSpan,
  SessionFilePayload,
  TaskProposalMeta,
  ToolCallRef,
} from '@lody/shared';
import { MessageTextWithChips } from '@/components/mentions/message-text-chips';
import { isNativeIOSAppShell } from '@/lib/native-platform';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { UserAvatar } from '../user-avatar';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SessionPlanBar } from '@/components/sessions/session-plan-bar';
import { ContainerQueryProvider } from './container-query-provider';
import { usePermissionResponse } from '@/hooks/use-permission-response';
import { TaskProposalNotice } from '@/components/tasks/task-proposal-notice';
import { tasksFeatureEnabledAtom } from '@/atoms/settings';
import { shouldRenderSystemRowItem } from './message-content-guards';
import { getShortMachineId, getToolCallStableId, isToolCallSkeleton } from './tool-call-skeleton';
import { useToolCallPayload } from './use-tool-call-payload';
import { getChatFailedDiagnosticCopy } from './chat-failed-diagnostic-copy';
import { extractReadableChatFailedMessage } from './chat-failed-error-report';
import { ChatFailedDetailDialog } from './chat-failed-detail-dialog';
import { DEFAULT_CONVERSATION_FONT_SIZE, type ConversationFontSize } from '@/atoms/settings';
import {
  conversationMonoFontSizeStyle,
  conversationTextFontSizeStyle,
  userTextCollapsedHeight,
} from './conversation-font-size-classes';
import { useSessionPin } from '@/components/sessions/session-pin-context';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  SEARCH_HIGHLIGHT_CONTAINER_ACTIVE_CLASS_NAME,
  SEARCH_HIGHLIGHT_CONTAINER_MATCHED_CLASS_NAME,
  SearchHighlightedText,
  useSessionSearch,
  useSessionSearchBlock,
  useSessionSearchBlockPrefix,
} from '@/components/sessions/session-search-context';
import {
  collectSessionImageGalleryEntries,
  createSessionImageGalleryEntry,
  findSessionImageGalleryEntryIndex,
  type SessionImageGalleryEntry,
} from '@/lib/session-image-gallery';
import {
  getMessageItemPrefix,
  getProposedPlanSearchBlockId,
  getTextSearchBlockId,
  getThoughtSearchBlockId,
} from '@/lib/session-chat-search';

const EMPTY_GALLERY_ENTRIES: readonly SessionImageGalleryEntry[] = [];

// ── Expand/collapse state cache ──────────────────────────────────────────────
// Survives virtual-scroll unmount/remount so expand/collapse state is not lost
// when the user scrolls a message out of the VList buffer and back.
interface BubbleExpandState {
  /** Keyed by `AssistantTurnRenderSegment.key`: a turn can have more than one
   *  foldable region (plan, then the approved implementation). */
  expandedWorkedGroups: Record<string, boolean>;
  expandedGroups: Record<string, boolean>;
  expandedByIndex: Record<number, boolean>;
  planOpen: boolean;
}
type SearchContainerProps = ComponentPropsWithoutRef<'div'> & {
  'data-search-block-id'?: string;
  'data-search-result-id'?: string;
};
const expandStateCache = new Map<string, BubbleExpandState>();
const MAX_EXPAND_CACHE = 500;

function getExpandState(messageId: string): BubbleExpandState {
  return (
    expandStateCache.get(messageId) ?? {
      expandedWorkedGroups: {},
      expandedGroups: {},
      expandedByIndex: {},
      planOpen: false,
    }
  );
}

function setExpandState(messageId: string, state: BubbleExpandState): void {
  expandStateCache.set(messageId, state);
  // Evict oldest entries if too large
  if (expandStateCache.size > MAX_EXPAND_CACHE) {
    const firstKey = expandStateCache.keys().next().value;
    if (firstKey !== undefined) {
      expandStateCache.delete(firstKey);
    }
  }
}

const getFileNameFromPath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
};

export interface SessionMessageItem {
  type: 'message';
  sessionId: SessionId;
  /** Position in the conversation (ConversationView index, or history index on the rollback path). */
  turnIndex?: number;
  message: SessionHistoryParsed;
}

export interface EmptySessionItem {
  type: 'empty';
}

/**
 * A turn the `ConversationView` has not hydrated. Rendered from its index row
 * with an estimated height under the SAME key its message rows will use, so
 * hydration swaps content without disturbing Virtua's element↔index map.
 */
export interface TurnPlaceholderItem {
  type: 'placeholder';
  sessionId: SessionId;
  turnIndex: number;
  row: TurnIndexRow;
}

export type MessageFileDiffEntriesByTurn = Readonly<
  Record<string, readonly AssistantEditedFileEntry[]>
>;

const EMPTY_EDITED_FILE_ENTRIES: readonly AssistantEditedFileEntry[] = [];

/** How close an outline jump has to land before it counts as arrived. */
const OUTLINE_JUMP_TOLERANCE_PX = 2;
/**
 * One correction is normally enough — arriving measures the target's rows, so
 * the re-issued jump uses real offsets. The bound only exists so a target that
 * genuinely cannot reach the top (the list's tail) stops retrying.
 */
const OUTLINE_JUMP_MAX_CORRECTIONS = 3;

export type ChatStreamItem = SessionMessageItem | EmptySessionItem | TurnPlaceholderItem;

type AssistantVirtualContent =
  | { kind: 'plan' }
  | {
      kind: 'worked_group_header';
      segmentKey: string;
      expanded: boolean;
      durationMs: number | null;
    }
  | { kind: 'content'; block: Extract<AssistantTurnRenderBlock, { kind: 'content' }> }
  | {
      kind: 'activity_group_header';
      block: Extract<AssistantTurnRenderBlock, { kind: 'activity_group' }>;
      expanded: boolean;
      isThinking: boolean;
    }
  | {
      kind: 'activity_detail';
      entry: AssistantActivityRenderItem;
      groupKey: string;
      showThoughtLabel: boolean;
      isThinking: boolean;
    }
  | { kind: 'subagent_tasks' }
  | { kind: 'footer'; showDuration: boolean };

type AssistantChatVirtualRow = {
  type: 'assistant';
  key: string;
  messageIndex: number;
  turnIndex: number;
  itemIndex?: number;
  item: SessionMessageItem;
  content: AssistantVirtualContent;
  isWorkedDetail?: boolean;
  isLastRowForMessage: boolean;
};

type StandardChatVirtualRow = {
  type: 'standard';
  key: string;
  messageIndex: number;
  /** -1 for the empty-conversation row. */
  turnIndex: number;
  item: SessionMessageItem | EmptySessionItem;
};

type PlaceholderChatVirtualRow = {
  type: 'placeholder';
  key: string;
  messageIndex: number;
  turnIndex: number;
  item: TurnPlaceholderItem;
};

export type ChatVirtualRow =
  | AssistantChatVirtualRow
  | StandardChatVirtualRow
  | PlaceholderChatVirtualRow;

export interface SessionChatStreamHandle {
  scrollToBottom: () => void;
  /** Scroll the turn at `turnIndex` (a `ConversationView` index, or a history index on the rollback path) to the top. */
  scrollToIndex: (turnIndex: number, smooth?: boolean) => void;
}

export type SessionChatUser =
  | {
      name?: string | null;
      image?: string | null;
      email?: string | null;
    }
  | null
  | undefined;

export interface AssistantMessageAction {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: ElementType<{ className?: string }>;
  tone?: 'default' | 'accent';
}

export interface CapacityRetryControl {
  noticeId: string;
  retryInSeconds: number | null;
  retryRemainingRatio: number | null;
  pending: boolean;
  canRetry: boolean;
  autoRetryEnabled: boolean;
  autoRetryExhausted: boolean;
  retry: () => void;
  stopAutoRetry: () => void;
}

// Exported for focused message/action binding tests.
export const resolveAssistantMessageActions = (
  messageId: string,
  actionsMessageId: string | null | undefined,
  actions: AssistantMessageAction[] | undefined
): AssistantMessageAction[] | undefined => (messageId === actionsMessageId ? actions : undefined);

export type GoalCommand = SessionGoalCommand;

export interface SessionChatStreamViewProps {
  items: ChatStreamItem[];
  sessionId: SessionId;
  className?: string;
  /** Scrolls as the first conversation row (for example, Session provenance). */
  leadingContent?: ReactNode;
  emptyState?: ReactNode;
  onAtBottomChange?: (atBottom: boolean) => void;
  showScrollToLatest?: boolean;
  sendMessage?: (message: ClientToServer) => void;
  renderMessageRow: (args: { message: SessionHistoryParsed; sessionId: SessionId }) => ReactNode;
  onFileDiffClick?: (turnId: string, filePath: string) => void;
  onFilePathClick?: (filePath: string) => void;
  /** Returns true when an HTML attachment click was routed to a richer surface. */
  onOpenHtmlFile?: (file: SessionFilePayload) => boolean;
  lastAssistantMessageId?: string | null;
  lastCompletedAssistantMessageId?: string | null;
  messageFileDiffEntriesByTurn?: MessageFileDiffEntriesByTurn;
  assistantActions?: AssistantMessageAction[];
  assistantActionsMessageId?: string | null;
  onForkLastAssistant?: (turnId: string, destination?: SessionForkDestination) => void;
  forkWorktreeAvailability?: SessionForkWorktreeAvailability;
  onForkWorktreeMenuOpen?: () => void;
  forkingAssistantMessageId?: string | null;
  agentActivityLabel?: string | null;
  agentActivityTone?: AgentActivityTone;
  conversationFontSize?: ConversationFontSize;
  /** Skips one auto-follow caused by the session composer changing height. */
  skipNextViewportResizeAutoScrollRef?: MutableRefObject<boolean>;
  /** Full-page overlay that keeps the conversation outline independent of composer height. */
  outlineOverlayRoot?: HTMLElement | null;
  /**
   * When true, prevents sticky auto-scroll from fighting programmatic scrolls
   * (e.g. during search result navigation).
   */
  suppressStickyAutoScrollRef?: React.RefObject<boolean>;
  /**
   * The turns whose rows intersect the viewport, `[from, to)`, whenever that
   * window changes. Reported only after the initial scroll restore so the
   * pre-restore top-of-list position never drives hydration.
   */
  onVisibleTurnRangeChange?: (from: number, to: number) => void;
  /** The turn whose outline hover card just opened; the stream hydrates it for its preview. */
  onOutlineHoverTurn?: (turnIndex: number) => void;
}

const SessionChatActionContext = createContext<{
  sendMessage?: (message: ClientToServer) => void;
  openHtmlFile?: (file: SessionFilePayload) => boolean;
}>({});
const SessionImagePreviewContext = createContext<{
  openImagePreview: (imageKey: string) => void;
} | null>(null);

const AgentActivityRow = ({
  label,
  tone = 'primary',
}: {
  label: string;
  tone?: AgentActivityTone;
}) => {
  return (
    <ConversationColumn className="flex items-start -mt-2 pb-1.5 pt-0.5">
      <div className="flex h-6 items-center">
        <AgentActivityIndicator
          label={label}
          tone={tone}
          displaySize={14}
          labelClassName="text-[12.5px] font-medium leading-snug"
        />
      </div>
    </ConversationColumn>
  );
};

type ModelProvider = 'anthropic' | 'openai' | 'unknown';

const getModelProvider = (modelInfo?: { modelId?: string; name?: string }): ModelProvider => {
  if (!modelInfo) return 'anthropic'; // Default to Anthropic
  const modelId = modelInfo.modelId?.toLowerCase() ?? '';
  const name = modelInfo.name?.toLowerCase() ?? '';

  // Check for OpenAI/GPT models
  if (
    modelId.includes('gpt') ||
    modelId.includes('codex') ||
    name.includes('gpt') ||
    name.includes('codex')
  ) {
    return 'openai';
  }

  // Check for Anthropic/Claude models
  if (
    modelId.includes('claude') ||
    modelId.includes('sonnet') ||
    modelId.includes('haiku') ||
    modelId.includes('opus') ||
    name.includes('claude') ||
    name.includes('sonnet') ||
    name.includes('haiku') ||
    name.includes('opus')
  ) {
    return 'anthropic';
  }

  // Default to Anthropic for unknown models
  return 'anthropic';
};

/** Base model name only — no reasoning effort / mode suffix. */
const formatAssistantModelBaseName = (modelInfo: { name?: string }): string =>
  stripRecommended(modelInfo.name ?? '');

const humanizeConfigKey = (key: string): string => {
  const known: Record<string, string> = {
    reasoning_effort: 'Reasoning',
    effort: 'Reasoning',
    thought_level: 'Reasoning',
    'fast-mode': 'Fast mode',
    fast: 'Fast mode',
    collaboration_mode: 'Plan mode',
    mode: 'Mode',
  };
  if (known[key]) return known[key];
  return key
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const formatConfigValue = (value: AcpConfigOptionValue): string => {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  const s = String(value).trim();
  if (!s) return '—';
  const lower = s.toLowerCase();
  if (lower === 'on' || lower === 'true') return 'On';
  if (lower === 'off' || lower === 'false') return 'Off';
  return s;
};

const humanizeModeId = (modeId: string): string => {
  if (modeId === 'default') return 'Default';
  if (modeId === 'plan') return 'Plan';
  if (modeId === 'acceptEdits') return 'Accept edits';
  return humanizeConfigKey(modeId);
};

export type AssistantTurnConfigRow = { label: string; value: string };

/**
 * Full run-config rows for an assistant turn header popover: mode, reasoning,
 * plan/fast toggles, and any other configOptionValues from the triggering
 * user turn — plus model + thought level recorded on modelInfo.
 */
export const buildAssistantTurnConfigRows = (
  modelInfo?: {
    name?: string;
    modelId?: string;
    _meta?: Record<string, unknown> | null;
  } | null,
  inputConfig?: SessionTurnInputConfig | null
): AssistantTurnConfigRow[] => {
  const rows: AssistantTurnConfigRow[] = [];
  const seen = new Set<string>();
  const push = (label: string, value: string | undefined | null) => {
    const v = value?.trim();
    if (!v) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ label, value: v });
  };

  const modelName = modelInfo ? formatAssistantModelBaseName(modelInfo) : '';
  push('Model', modelName || undefined);

  if (inputConfig?.modeId) {
    push('Mode', humanizeModeId(inputConfig.modeId));
  }

  const thoughtMeta = modelInfo?._meta?.[MODEL_THOUGHT_LEVEL_META_KEY];
  if (typeof thoughtMeta === 'string') {
    push('Reasoning', thoughtMeta);
  }

  const cov = inputConfig?.configOptionValues;
  if (cov && typeof cov === 'object') {
    for (const [configId, raw] of Object.entries(cov)) {
      if (raw === undefined || raw === null) continue;
      if (
        isAcpThoughtLevelConfigOption({ id: configId, category: undefined }) ||
        configId === 'effort' ||
        configId === 'thought_level'
      ) {
        push('Reasoning', formatConfigValue(raw as AcpConfigOptionValue));
        continue;
      }
      if (isAcpFastModeConfigId(configId)) {
        push('Fast mode', formatConfigValue(raw as AcpConfigOptionValue));
        continue;
      }
      if (isAcpPlanModeConfigOption({ id: configId, category: configId })) {
        push('Plan mode', formatConfigValue(raw as AcpConfigOptionValue));
        continue;
      }
      // Surface every other config so the popover is complete.
      if (configId === 'model' || configId.endsWith('/model')) continue;
      push(humanizeConfigKey(configId), formatConfigValue(raw as AcpConfigOptionValue));
    }
  }

  // Plan expressed only as permission mode.
  if (inputConfig?.modeId === 'plan') {
    push('Plan mode', 'On');
  }

  return rows;
};

const AgentAvatar = ({
  className,
  modelInfo,
  cliType,
  agentType,
  env,
}: {
  className?: string;
  modelInfo?: { modelId?: string; name?: string; _meta?: Record<string, unknown> | null };
  cliType?: AgentConfigCliType;
  agentType?: string;
  env?: Record<string, string>;
}) => {
  // Prefer the agent's own logo whenever the session is bound to a known ACP.
  // Imported external-ACP sessions carry cliType/agentType but their per-turn
  // modelInfo isn't a reliable provider hint (often absent on replayed turns),
  // so the model-name fallback would silently mislabel e.g. an imported Codex
  // or Gemini session with the default Claude icon.
  if (cliType && agentType) {
    return <AgentIcon cliType={cliType} agentType={agentType} env={env} className={className} />;
  }

  const provider = getModelProvider(modelInfo);

  if (provider === 'openai') {
    return <OpenAIIcon className={className} />;
  }

  return <AnthropicIcon className={className} />;
};

type AgentAvatarSessionMeta = {
  readonly agentConfigId?: SessionMeta['agentConfigId'];
  readonly cliType?: AgentConfigCliType;
  readonly agentType?: string;
  readonly env?: Record<string, string>;
};

const selectAgentAvatarSessionMeta = (meta: SessionMeta | undefined): AgentAvatarSessionMeta => ({
  agentConfigId: meta?.agentConfigId,
  cliType: meta?.cliType,
  agentType: meta?.agentType,
  env: getSessionLaunchConfigLegacyFields(meta)?.env,
});

const agentAvatarSessionMetaEqual = (
  left: AgentAvatarSessionMeta,
  right: AgentAvatarSessionMeta
): boolean =>
  left.agentConfigId === right.agentConfigId &&
  left.cliType === right.cliType &&
  left.agentType === right.agentType &&
  (left.env === right.env || JSON.stringify(left.env) === JSON.stringify(right.env));

/**
 * Memoized item renderer to prevent unnecessary re-renders during scrolling.
 * Virtua recommends memoizing render functions for optimal performance.
 */
const ChatItem = memo(function ChatItem({
  item,
  renderMessageRow,
  noMessagesLabel,
  emptyState,
}: {
  item: ChatStreamItem;
  renderMessageRow: SessionChatStreamViewProps['renderMessageRow'];
  noMessagesLabel: string;
  emptyState?: React.ReactNode;
}) {
  if (item.type === 'message') {
    // Skip empty agent messages entirely so the padding wrapper doesn't cause visual jitter
    const msg = item.message;
    if (msg.role === 'assistant' && !msg.items.length && !(msg.plan && msg.plan.length > 0)) {
      return null;
    }
    return (
      <ConversationColumn className="py-2 sm:py-3">
        {renderMessageRow({
          message: item.message,
          sessionId: item.sessionId,
        })}
      </ConversationColumn>
    );
  }
  if (emptyState) {
    return <>{emptyState}</>;
  }
  return (
    <div className="flex justify-center py-6 text-sm font-medium text-muted-foreground text-center">
      {noMessagesLabel}
    </div>
  );
}, areChatItemsEqual);

function areChatItemsEqual(
  previous: Readonly<{
    item: ChatStreamItem;
    renderMessageRow: SessionChatStreamViewProps['renderMessageRow'];
    noMessagesLabel: string;
    emptyState?: React.ReactNode;
  }>,
  next: Readonly<{
    item: ChatStreamItem;
    renderMessageRow: SessionChatStreamViewProps['renderMessageRow'];
    noMessagesLabel: string;
    emptyState?: React.ReactNode;
  }>
): boolean {
  return (
    previous.item === next.item &&
    previous.renderMessageRow === next.renderMessageRow &&
    previous.noMessagesLabel === next.noMessagesLabel &&
    previous.emptyState === next.emptyState
  );
}

const assistantGroupHasActiveSearch = (
  messageId: string,
  entries: readonly { itemIndex: number }[],
  activeBlockId: string | null | undefined
): boolean => {
  if (!activeBlockId) return false;
  return entries.some((entry) => {
    const prefix = getMessageItemPrefix(messageId, entry.itemIndex);
    return activeBlockId === prefix || activeBlockId.startsWith(`${prefix}:`);
  });
};

const hasAssistantTurnConfigInfo = (message: SessionHistoryParsed): boolean =>
  Boolean(message.modelInfo?.name) ||
  Boolean(message.inputConfig?.modeId) ||
  Boolean(message.inputConfig?.configOptionValues) ||
  Boolean(message.modelInfo?._meta);

const shouldRenderAssistantFooter = ({
  message,
  renderEntries,
  fileDiffs,
  assistantActions,
  showDuration,
}: {
  message: SessionHistoryParsed;
  renderEntries: readonly AssistantMessageRenderItem[];
  fileDiffs: readonly AssistantEditedFileEntry[];
  assistantActions?: AssistantMessageAction[];
  showDuration: boolean;
}): boolean => {
  if ((assistantActions?.length ?? 0) > 0) return true;
  if (message.finished !== true) return false;
  const visibleContentItems = renderEntries.map((entry) => entry.content);
  return (
    getVisibleAssistantTextContent(visibleContentItems, true).trim().length > 0 ||
    fileDiffs.length > 0 ||
    hasAssistantTurnConfigInfo(message) ||
    (typeof message.endedAt === 'number' && Number.isFinite(message.endedAt)) ||
    (showDuration && resolveSessionHistoryDurationMs(message) !== null)
  );
};

type AssistantTurnLayout = ReturnType<typeof buildAssistantTurnRenderLayout> & {
  subagentTasks: ReturnType<typeof collectSubagentTasks>;
};

const EMPTY_SUBAGENT_TASKS: ReturnType<typeof collectSubagentTasks> = [];

// Assistant-turn layout (block grouping + subagent-task collection) is derived
// purely from the message's id/items/finished state, and `buildChatStreamItems`
// hands back a stable parsed-message object for unchanged turns and a fresh one
// whenever the turn changes. Keying the cache by that reference lets only the
// streaming turn recompute; without it, each streamed token re-runs these
// O(items) passes for every turn in the whole conversation.
const assistantTurnLayoutCache = new WeakMap<SessionHistoryParsed, AssistantTurnLayout>();

const getAssistantTurnLayout = (message: SessionHistoryParsed): AssistantTurnLayout => {
  const cached = assistantTurnLayoutCache.get(message);
  if (cached) return cached;
  const layout: AssistantTurnLayout = {
    ...buildAssistantTurnRenderLayout(message.id, message.items, message.finished === true),
    subagentTasks: collectSubagentTasks(message.items),
  };
  assistantTurnLayoutCache.set(message, layout);
  return layout;
};

// Per-turn row cache. `buildChatVirtualRows` runs on every streaming delta, and
// `AssistantChatItem` is memo()'d — but memo only helps if unchanged turns hand
// back the *same* row objects. Keyed by the SessionMessageItem wrapper, which
// `buildChatStreamItems` keeps reference-stable for unchanged turns; the deps
// snapshot covers every other input that shapes this turn's rows. Without this,
// each streamed token re-allocates every row, the shallow prop compare fails
// for the whole mounted window, and long sessions freeze the renderer.
type AssistantTurnRowsCacheEntry = {
  rows: AssistantChatVirtualRow[];
  messageIndex: number;
  turnIndex: number;
  isLastAssistantMessage: boolean;
  fileDiffs: readonly AssistantEditedFileEntry[];
  scopedAssistantActions: AssistantMessageAction[] | undefined;
  activeSearchBlockId: string | null | undefined;
  expansionVersion: number;
};
const assistantTurnRowsCache = new WeakMap<SessionMessageItem, AssistantTurnRowsCacheEntry>();

// Exported for tests only (chat-virtual-rows-identity.test.ts).
export const buildChatVirtualRows = ({
  items,
  lastAssistantMessageId,
  messageFileDiffEntriesByTurn,
  assistantActions,
  assistantActionsMessageId,
  activeSearchBlockId,
  expansionVersion,
}: {
  items: ChatStreamItem[];
  lastAssistantMessageId: string | null;
  messageFileDiffEntriesByTurn?: MessageFileDiffEntriesByTurn;
  assistantActions?: AssistantMessageAction[];
  assistantActionsMessageId?: string | null;
  activeSearchBlockId?: string | null;
  expansionVersion: number;
}): ChatVirtualRow[] => {
  const rows: ChatVirtualRow[] = [];

  for (let messageIndex = 0; messageIndex < items.length; messageIndex += 1) {
    const item = items[messageIndex];
    if (!item) continue;
    if (item.type === 'placeholder') {
      rows.push({
        type: 'placeholder',
        key: item.row.id,
        messageIndex,
        turnIndex: item.turnIndex,
        item,
      });
      continue;
    }
    if (item.type !== 'message' || item.message.role !== 'assistant') {
      rows.push({
        type: 'standard',
        key: item.type === 'message' ? item.message.id : `empty-${messageIndex}`,
        messageIndex,
        turnIndex: item.type === 'message' ? (item.turnIndex ?? messageIndex) : -1,
        item,
      });
      continue;
    }

    const message = item.message;
    const turnIndex = item.turnIndex ?? messageIndex;
    const fileDiffs =
      messageFileDiffEntriesByTurn === undefined
        ? (message.fileDiff ?? EMPTY_EDITED_FILE_ENTRIES)
        : (messageFileDiffEntriesByTurn[message.id] ?? EMPTY_EDITED_FILE_ENTRIES);
    const isLastAssistantMessage = message.id === lastAssistantMessageId;
    const scopedAssistantActions = resolveAssistantMessageActions(
      message.id,
      assistantActionsMessageId,
      assistantActions
    );
    const cachedRows = assistantTurnRowsCache.get(item);
    if (
      cachedRows &&
      cachedRows.messageIndex === messageIndex &&
      cachedRows.turnIndex === turnIndex &&
      cachedRows.isLastAssistantMessage === isLastAssistantMessage &&
      cachedRows.fileDiffs === fileDiffs &&
      cachedRows.scopedAssistantActions === scopedAssistantActions &&
      cachedRows.activeSearchBlockId === activeSearchBlockId &&
      cachedRows.expansionVersion === expansionVersion
    ) {
      rows.push(...cachedRows.rows);
      continue;
    }

    const { blocks, segments, entries, subagentTasks } = getAssistantTurnLayout(message);
    const cachedState = getExpandState(message.id);
    const cachedExpansion = cachedState.expandedGroups;
    // Collapse into a "Worked for …" summary ONLY when the turn both finished and
    // produced a genuine final answer to show. `hasVisibleFinalContent` = there is at
    // least one block NOT folded into the worked group (the visible answer/result tail).
    // Why: activity groups are unconditionally added to `workBlockKeys`
    // (see assistant-turn-render-blocks.ts), so an interrupted/cancelled turn that ends
    // mid-tool with no final text would otherwise fold EVERYTHING and render an empty
    // "Worked for …" row with nothing beneath it. Requiring a visible tail keeps such
    // turns fully expanded. `message.finished` alone is not enough: it is set on every
    // teardown/cancel path too, not just on a completed answer. Do not relax this back to
    // `finished && workBlockKeys.size > 0` — see AGENTS.md "Worked for …" invariants.
    //
    // Evaluated PER SEGMENT: a plan-approval turn has two regions and each needs
    // its own verdict, or the implementation would fold into the plan's row.
    const isTurnFinished = message.finished === true;
    // Subagent tasks are message-scoped, so they ride the LAST segment.
    const lastSegmentIndex = segments.length - 1;
    const assistantRows: AssistantChatVirtualRow[] = [];

    if ((message.plan?.length ?? 0) > 0) {
      assistantRows.push({
        type: 'assistant',
        key: `assistant:${message.id}:plan`,
        messageIndex,
        turnIndex,
        item,
        content: { kind: 'plan' },
        isLastRowForMessage: false,
      });
    }

    const appendBlockRows = (
      target: AssistantChatVirtualRow[],
      block: AssistantTurnRenderBlock,
      blockIndex: number,
      isWorkedDetail: boolean
    ) => {
      if (block.kind === 'content') {
        target.push({
          type: 'assistant',
          key: `assistant:${message.id}:${block.key}`,
          messageIndex,
          turnIndex,
          itemIndex: block.entry.itemIndex,
          item,
          content: { kind: 'content', block },
          isWorkedDetail,
          isLastRowForMessage: false,
        });
        return;
      }

      const isSearchExpanded = assistantGroupHasActiveSearch(
        message.id,
        block.entries,
        activeSearchBlockId
      );
      const expanded = isSearchExpanded || cachedExpansion[block.key] === true;
      const isActive =
        isLastAssistantMessage && message.finished !== true && blockIndex === blocks.length - 1;
      const lastEntry = block.entries[block.entries.length - 1];
      const isThinking = Boolean(
        isActive &&
        lastEntry &&
        (lastEntry.content.type === 'thought' || lastEntry.content.kind === 'think')
      );

      target.push({
        type: 'assistant',
        key: `assistant:${message.id}:${block.key}:header`,
        messageIndex,
        turnIndex,
        item,
        content: { kind: 'activity_group_header', block, expanded, isThinking },
        isWorkedDetail,
        isLastRowForMessage: false,
      });
      if (expanded) {
        for (const entry of block.entries) {
          const entrySuffix =
            entry.content.type === 'tool_call' ? getToolCallStableId(entry.content) : 'thought';
          target.push({
            type: 'assistant',
            key: `assistant:${message.id}:${block.key}:item:${entry.itemIndex}:${entrySuffix}`,
            messageIndex,
            turnIndex,
            itemIndex: entry.itemIndex,
            item,
            content: {
              kind: 'activity_detail',
              entry,
              groupKey: block.key,
              showThoughtLabel: block.entries.length > 1,
              isThinking: isThinking && entry === lastEntry,
            },
            isWorkedDetail,
            isLastRowForMessage: false,
          });
        }
      }
    };

    const appendSubagentTasksRow = (target: AssistantChatVirtualRow[], isWorkedDetail: boolean) => {
      target.push({
        type: 'assistant',
        key: `assistant:${message.id}:subagent-tasks`,
        messageIndex,
        turnIndex,
        item,
        content: { kind: 'subagent_tasks' },
        isWorkedDetail,
        isLastRowForMessage: false,
      });
    };

    let anySegmentUsesWorkedGroup = false;
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      if (!segment) continue;
      const [segmentStart, segmentEnd] = segment.blockRange;
      const isLastSegment = segmentIndex === lastSegmentIndex;
      const segmentSubagentTasks = isLastSegment ? subagentTasks : EMPTY_SUBAGENT_TASKS;

      let hasVisibleFinalContent = false;
      for (let blockIndex = segmentStart; blockIndex < segmentEnd; blockIndex += 1) {
        const block = blocks[blockIndex];
        if (block && !segment.workBlockKeys.has(block.key)) {
          hasVisibleFinalContent = true;
          break;
        }
      }
      const shouldUseWorkedGroup =
        isTurnFinished &&
        (segment.workBlockKeys.size > 0 || segmentSubagentTasks.length > 0) &&
        hasVisibleFinalContent;

      const workedSearchEntries: { itemIndex: number }[] = [];
      for (let blockIndex = segmentStart; blockIndex < segmentEnd; blockIndex += 1) {
        const block = blocks[blockIndex];
        if (!block || !segment.workBlockKeys.has(block.key)) continue;
        if (block.kind === 'content') {
          workedSearchEntries.push(block.entry);
        } else {
          workedSearchEntries.push(...block.entries);
        }
      }
      if (isLastSegment) {
        for (let itemIndex = 0; itemIndex < message.items.length; itemIndex += 1) {
          if (message.items[itemIndex]?.type === 'subagent_task') {
            workedSearchEntries.push({ itemIndex });
          }
        }
      }
      const isWorkedSearchExpanded = assistantGroupHasActiveSearch(
        message.id,
        workedSearchEntries,
        activeSearchBlockId
      );
      const isWorkedGroupExpanded =
        shouldUseWorkedGroup &&
        (isWorkedSearchExpanded || cachedState.expandedWorkedGroups[segment.key] === true);
      anySegmentUsesWorkedGroup ||= shouldUseWorkedGroup;

      if (!shouldUseWorkedGroup) {
        for (let blockIndex = segmentStart; blockIndex < segmentEnd; blockIndex += 1) {
          const block = blocks[blockIndex];
          if (block) appendBlockRows(assistantRows, block, blockIndex, false);
        }
        if (segmentSubagentTasks.length > 0) {
          appendSubagentTasksRow(assistantRows, false);
        }
        continue;
      }

      // Collapsed is the default state, and the detail rows of a collapsed
      // group are discarded unrendered — don't pay for building them. Initial
      // mount of a long finished session hits this for every turn.
      const workedRows: AssistantChatVirtualRow[] = [];
      if (isWorkedGroupExpanded) {
        for (let blockIndex = segmentStart; blockIndex < segmentEnd; blockIndex += 1) {
          const block = blocks[blockIndex];
          if (block && segment.workBlockKeys.has(block.key)) {
            appendBlockRows(workedRows, block, blockIndex, true);
          }
        }
        if (segmentSubagentTasks.length > 0) {
          appendSubagentTasksRow(workedRows, true);
        }
      }

      const insertWorkedGroup = () => {
        assistantRows.push({
          type: 'assistant',
          key: `assistant:${message.id}:${segment.key}:worked-header`,
          messageIndex,
          turnIndex,
          item,
          content: {
            kind: 'worked_group_header',
            segmentKey: segment.key,
            expanded: isWorkedGroupExpanded,
            // The turn's duration covers ALL its segments, so only the last one
            // may claim it; earlier regions fall back to "Finished working".
            durationMs: isLastSegment ? resolveSessionHistoryDurationMs(message) : null,
          },
          isLastRowForMessage: false,
        });
        if (isWorkedGroupExpanded) {
          assistantRows.push(...workedRows);
        }
      };

      const insertionBlockIndex =
        segment.firstWorkBlockIndex === -1 ? segmentStart : segment.firstWorkBlockIndex;
      let didInsertWorkedGroup = false;
      for (let blockIndex = segmentStart; blockIndex < segmentEnd; blockIndex += 1) {
        const block = blocks[blockIndex];
        if (!block) continue;
        if (!didInsertWorkedGroup && blockIndex === insertionBlockIndex) {
          insertWorkedGroup();
          didInsertWorkedGroup = true;
        }
        if (!segment.workBlockKeys.has(block.key)) {
          appendBlockRows(assistantRows, block, blockIndex, false);
        }
      }
      if (!didInsertWorkedGroup) {
        insertWorkedGroup();
      }
    }

    const showDurationInFooter = !anySegmentUsesWorkedGroup;
    if (
      shouldRenderAssistantFooter({
        message,
        renderEntries: entries,
        fileDiffs,
        assistantActions: scopedAssistantActions,
        showDuration: showDurationInFooter,
      })
    ) {
      assistantRows.push({
        type: 'assistant',
        key: `assistant:${message.id}:footer`,
        messageIndex,
        turnIndex,
        item,
        content: { kind: 'footer', showDuration: showDurationInFooter },
        isLastRowForMessage: false,
      });
    }

    const lastRow = assistantRows[assistantRows.length - 1];
    if (lastRow) lastRow.isLastRowForMessage = true;
    assistantTurnRowsCache.set(item, {
      rows: assistantRows,
      messageIndex,
      turnIndex,
      isLastAssistantMessage,
      fileDiffs,
      scopedAssistantActions,
      activeSearchBlockId,
      expansionVersion,
    });
    rows.push(...assistantRows);
  }

  return rows;
};

/**
 * The `[from, to)` turn window covered by rows `startRow..endRow` (both may
 * fall outside the row list — the leading content row or the agent activity
 * row — and are clamped). Exported for tests.
 */
export const resolveVisibleTurnRange = (
  rows: readonly { turnIndex: number }[],
  startRow: number,
  endRow: number
): { from: number; to: number } | null => {
  if (rows.length === 0) return null;
  const last = rows.length - 1;
  let start = Math.min(Math.max(startRow, 0), last);
  let end = Math.min(Math.max(endRow, start), last);
  while (start < end && (rows[start]?.turnIndex ?? -1) < 0) start += 1;
  while (end > start && (rows[end]?.turnIndex ?? -1) < 0) end -= 1;
  const from = rows[start]?.turnIndex ?? -1;
  const to = rows[end]?.turnIndex ?? -1;
  if (from < 0 || to < 0) return null;
  return { from, to: to + 1 };
};

/**
 * Chat virtual scroll using Virtua library.
 *
 * IMPORTANT: Do NOT dynamically toggle Virtua's `shift` prop — it causes
 * element overlap bugs (Virtua bug #284). We use shift={false} since chat
 * messages are appended to the end.
 *
 * Sticky-to-bottom behavior (ResizeObserver, hysteresis, scroll position
 * caching) is encapsulated in the `useStickyScroll` hook.
 */
export const SessionChatStreamView = forwardRef<
  SessionChatStreamHandle,
  SessionChatStreamViewProps
>(
  (
    {
      items,
      sessionId,
      className,
      leadingContent,
      emptyState,
      onAtBottomChange,
      showScrollToLatest = true,
      sendMessage,
      renderMessageRow,
      onFileDiffClick,
      onFilePathClick,
      onOpenHtmlFile,
      lastAssistantMessageId = null,
      lastCompletedAssistantMessageId = null,
      messageFileDiffEntriesByTurn,
      assistantActions,
      assistantActionsMessageId = null,
      onForkLastAssistant,
      forkWorktreeAvailability = 'hidden',
      onForkWorktreeMenuOpen,
      forkingAssistantMessageId,
      agentActivityLabel = null,
      agentActivityTone = 'primary',
      conversationFontSize = DEFAULT_CONVERSATION_FONT_SIZE,
      skipNextViewportResizeAutoScrollRef,
      suppressStickyAutoScrollRef,
      outlineOverlayRoot,
      onVisibleTurnRangeChange,
      onOutlineHoverTurn,
    },
    ref
  ) => {
    const vlistRef = useRef<VirtualizerHandle>(null);
    const scrollRootRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();
    const search = useSessionSearch();
    const activeSearchBlockId = search?.activeBlockId ?? null;
    const shouldShowAgentActivity = Boolean(agentActivityLabel);
    const [assistantExpansionVersion, setAssistantExpansionVersion] = useState(0);
    const [hoveredAssistantMessageId, setHoveredAssistantMessageId] = useState<string | null>(null);
    const pendingExpandedGroupRowKeyRef = useRef<string | null>(null);
    const groupExpansionAutoScrollSuppressedRef = useRef(false);
    const releaseGroupExpansionSuppressionRef = useRef(false);
    /**
     * An outline jump in flight. Declared here, beside the other suppression
     * state, because `autoScrollSuppressedRef` below reads it — see
     * `handleOutlineJump` for what maintains it.
     */
    const pendingOutlineJumpRef = useRef<{ rowIndex: number; attempts: number } | null>(null);
    /**
     * Every reason this component has to stop follow-output. Group expansion
     * releases in the layout effect of its own commit; an outline jump releases
     * when the jump finishes (see `pendingOutlineJumpRef`), because an event
     * handler cannot count on a commit happening at all.
     */
    const autoScrollSuppressedRef = useMemo(
      () => ({
        get current() {
          return (
            groupExpansionAutoScrollSuppressedRef.current ||
            pendingOutlineJumpRef.current !== null ||
            Boolean(suppressStickyAutoScrollRef?.current)
          );
        },
      }),
      [suppressStickyAutoScrollRef]
    );
    const handleAssistantGroupExpandedChange = useCallback(
      (messageId: string, groupKey: string, expanded: boolean) => {
        const cached = getExpandState(messageId);
        setExpandState(messageId, {
          ...cached,
          expandedGroups: {
            ...cached.expandedGroups,
            [groupKey]: expanded,
          },
        });
        if (expanded) {
          pendingExpandedGroupRowKeyRef.current = `assistant:${messageId}:${groupKey}:header`;
          groupExpansionAutoScrollSuppressedRef.current = true;
        }
        setAssistantExpansionVersion((version) => version + 1);
      },
      []
    );
    const handleAssistantWorkedGroupExpandedChange = useCallback(
      (messageId: string, segmentKey: string, expanded: boolean) => {
        const cached = getExpandState(messageId);
        setExpandState(messageId, {
          ...cached,
          expandedWorkedGroups: {
            ...cached.expandedWorkedGroups,
            [segmentKey]: expanded,
          },
        });
        if (expanded) {
          pendingExpandedGroupRowKeyRef.current = `assistant:${messageId}:${segmentKey}:worked-header`;
          groupExpansionAutoScrollSuppressedRef.current = true;
        }
        setAssistantExpansionVersion((version) => version + 1);
      },
      []
    );
    const handleAssistantTurnHoverChange = useCallback((messageId: string, hovered: boolean) => {
      setHoveredAssistantMessageId((current) => {
        if (hovered) return messageId;
        return current === messageId ? null : current;
      });
    }, []);

    const virtualRows = useMemo(() => {
      // Expansion lives in the module cache so virtualized child rows retain
      // their state after unmounting; this counter is its React invalidation
      // signal and also busts the per-turn row cache.
      return buildChatVirtualRows({
        items,
        lastAssistantMessageId,
        messageFileDiffEntriesByTurn,
        assistantActions,
        assistantActionsMessageId,
        activeSearchBlockId,
        expansionVersion: assistantExpansionVersion,
      });
    }, [
      activeSearchBlockId,
      assistantActions,
      assistantActionsMessageId,
      assistantExpansionVersion,
      items,
      lastAssistantMessageId,
      messageFileDiffEntriesByTurn,
    ]);
    const leadingRowCount = leadingContent == null ? 0 : 1;

    /**
     * The gap between the viewport's scroll space and Virtua's item-offset
     * space — the viewport's top padding (`--conversation-top-inset` plus
     * `py-6`), which Virtua does not account for. Measured from the DOM rather
     * than assumed, and only on mount / viewport resize; see
     * `measureItemOffsetDelta`.
     */
    const itemOffsetDeltaRef = useRef(0);

    /**
     * Put a row's top at the viewport's top edge.
     *
     * THE one place that turns a row index into a scroll, so every jump in this
     * component lands in the same coordinate space that
     * `resolveActiveOutlineIndex` reads positions back out of. Without the
     * `offset` compensation a jump settles a padding's worth low, and the
     * outline rail then reports the round BEFORE the one that was asked for.
     * (`scrollViewportToRealBottom` compensates the bottom padding the same way.)
     */
    const scrollRowToTop = useCallback(
      (rowIndex: number, smooth = false) => {
        vlistRef.current?.scrollToIndex(rowIndex + leadingRowCount, {
          align: 'start',
          smooth,
          offset: itemOffsetDeltaRef.current,
        });
      },
      [leadingRowCount]
    );

    useLayoutEffect(() => {
      const rowKey = pendingExpandedGroupRowKeyRef.current;
      if (!rowKey) return undefined;

      const rowIndex = virtualRows.findIndex((row) => row.key === rowKey);
      if (rowIndex === -1) {
        pendingExpandedGroupRowKeyRef.current = null;
        groupExpansionAutoScrollSuppressedRef.current = false;
        return undefined;
      }

      pendingExpandedGroupRowKeyRef.current = null;
      // Descendant layout effects run before this parent effect, so Virtua has
      // committed and measured the expanded row set when this call runs.
      scrollRowToTop(rowIndex);
      releaseGroupExpansionSuppressionRef.current = true;
      return undefined;
    }, [scrollRowToTop, virtualRows]);

    const {
      scrollRef: scrollContainerRef,
      scrollElement: scrollViewportElement,
      isSticky,
      scrollToBottom,
      initialScrollRestored,
      handleScroll,
    } = useStickyScroll({
      sessionId,
      vlistRef,
      // `leadingContent` is a real first Virtua row, so it counts here — sticky
      // scroll otherwise targets an index short of the true bottom.
      itemCount: virtualRows.length + leadingRowCount + (shouldShowAgentActivity ? 1 : 0),
      onAtBottomChange,
      skipNextViewportResizeAutoScrollRef,
      suppressAutoScrollRef: autoScrollSuppressedRef,
    });

    // useStickyScroll's layout effect runs before this one in hook order and
    // consumes the suppression for the expansion commit. Release it at the end
    // of that same commit instead of guessing when Virtua settles with a timer.
    useLayoutEffect(() => {
      if (!releaseGroupExpansionSuppressionRef.current) return;
      releaseGroupExpansionSuppressionRef.current = false;
      groupExpansionAutoScrollSuppressedRef.current = false;
    });

    // ---- Outline rail ------------------------------------------------------
    // The left table of contents. Everything here is derived from `items` and
    // from Virtua's index math; the rail never inspects the DOM of the message
    // rows, because virtualization means most rounds have no DOM at all.
    const isMobile = useIsMobile();
    const previousOutlineRef = useRef<readonly ConversationOutlineEntry[] | undefined>(undefined);
    const outlineEntries = useMemo(() => {
      // `items` gets a new identity on every streamed delta, so this runs at
      // token rate. `buildConversationOutline` is per-message memoized and
      // `reuseConversationOutline` hands back the previous ARRAY when nothing
      // visible changed, which is what keeps the tick list from re-rendering.
      const next = reuseConversationOutline(
        previousOutlineRef.current,
        buildConversationOutline(items)
      );
      previousOutlineRef.current = next;
      return next;
    }, [items]);
    const previousAnchorsRef = useRef<readonly ConversationOutlineAnchor[] | undefined>(undefined);
    const outlineAnchors = useMemo(() => {
      // `virtualRows` is rebuilt per delta, so this runs at token rate too;
      // reusing the array keeps everything derived from it identity-stable.
      const next = reuseOutlineAnchors(
        previousAnchorsRef.current,
        buildOutlineAnchors(virtualRows, outlineEntries)
      );
      previousAnchorsRef.current = next;
      return next;
    }, [outlineEntries, virtualRows]);
    const [activeOutlineIndex, setActiveOutlineIndex] = useState(-1);

    // Measured, not assumed: the rect difference also absorbs any border or
    // start spacer, which a `padding-top` read would miss. Never on a scroll
    // path — `getBoundingClientRect` forces layout.
    const measureItemOffsetDelta = useCallback(() => {
      const content = scrollViewportElement?.firstElementChild;
      if (!scrollViewportElement || !(content instanceof HTMLElement)) return;
      itemOffsetDeltaRef.current =
        content.getBoundingClientRect().top -
        scrollViewportElement.getBoundingClientRect().top +
        scrollViewportElement.scrollTop;
    }, [scrollViewportElement]);

    const syncActiveOutlineIndex = useCallback(() => {
      const vlist = vlistRef.current;
      if (!initialScrollRestored || !vlist || outlineAnchors.length === 0) {
        setActiveOutlineIndex(-1);
        return;
      }
      // `scrollSize` / `viewportSize` are the scroller's own cached
      // scrollHeight / offsetHeight, so this costs no layout read.
      const maxScrollOffset = vlist.scrollSize - vlist.viewportSize;
      const isAtEnd = maxScrollOffset > 0 && vlist.scrollOffset >= maxScrollOffset - 2;
      // O(log rounds) offset lookups, and setState bails out when the round is
      // unchanged — which it is for the overwhelming majority of scroll events.
      const next = resolveActiveOutlineIndex(
        outlineAnchors,
        (rowIndex) => vlist.getItemOffset(rowIndex + leadingRowCount),
        vlist.scrollOffset - itemOffsetDeltaRef.current,
        isAtEnd
      );
      setActiveOutlineIndex(next);
    }, [initialScrollRestored, leadingRowCount, outlineAnchors]);

    // Read the sync through refs so this effect only re-runs when the viewport
    // is bound or its one-time initial position restore completes. Depending on
    // the callback would re-run it on every streamed delta, which is exactly the
    // forced layout the measurement comment above rules out.
    const syncActiveOutlineIndexRef = useLatestRef(syncActiveOutlineIndex);
    const measureItemOffsetDeltaRef = useLatestRef(measureItemOffsetDelta);
    useEffect(() => {
      if (!scrollViewportElement) return undefined;
      const remeasure = () => {
        measureItemOffsetDeltaRef.current();
        syncActiveOutlineIndexRef.current();
      };
      remeasure();
      return observeResizeOnAnimationFrame(scrollViewportElement, remeasure);
    }, [
      initialScrollRestored,
      measureItemOffsetDeltaRef,
      scrollViewportElement,
      syncActiveOutlineIndexRef,
    ]);

    /** How far a pending jump still is from its target, in item-offset space. */
    const outlineJumpDrift = useCallback(
      (rowIndex: number): number => {
        const vlist = vlistRef.current;
        if (!vlist) return 0;
        const targetOffset = vlist.getItemOffset(rowIndex + leadingRowCount);
        return Math.abs(vlist.scrollOffset - itemOffsetDeltaRef.current - targetOffset);
      },
      [leadingRowCount]
    );

    /**
     * A jump into rows Virtua has never measured lands on ESTIMATED offsets.
     * Virtua does re-issue internally as measurements arrive, but it gives up
     * after 150ms of silence (`core/index.js`), and a React commit plus the
     * ResizeObserver round trip for a screenful of message rows routinely takes
     * longer than that — so a far jump settles a round short. Arriving is what
     * measures the rows, so re-issuing once the scroll settles converges.
     *
     * While a jump is pending it also suppresses follow-output, so a jump upward
     * out of a sticky conversation is not pulled straight back to the bottom.
     * Tying suppression to this ref rather than to a render is deliberate: the
     * release must not depend on a commit that React can skip.
     */
    const handleOutlineJump = useCallback(
      (outlineIndex: number) => {
        const anchor = outlineAnchors.find((item) => item.outlineIndex === outlineIndex);
        if (!anchor) return;
        pendingOutlineJumpRef.current = { rowIndex: anchor.rowIndex, attempts: 0 };
        scrollRowToTop(anchor.rowIndex);
        // Clicking the round already at the top scrolls nowhere, so no
        // `onScrollEnd` will arrive to clear the pending jump — and suppression
        // would stay armed until some unrelated render happened to release it.
        if (outlineJumpDrift(anchor.rowIndex) <= OUTLINE_JUMP_TOLERANCE_PX) {
          pendingOutlineJumpRef.current = null;
        }
        setActiveOutlineIndex(outlineIndex);
      },
      [outlineAnchors, outlineJumpDrift, scrollRowToTop]
    );

    const handleStreamScrollEnd = useCallback(() => {
      const pending = pendingOutlineJumpRef.current;
      if (!pending) return;
      if (
        outlineJumpDrift(pending.rowIndex) <= OUTLINE_JUMP_TOLERANCE_PX ||
        pending.attempts >= OUTLINE_JUMP_MAX_CORRECTIONS
      ) {
        // Not settling within the bound means the target simply cannot reach the
        // top — the last rounds are shorter than the viewport, so the scroll
        // clamps. Stop rather than retry against a wall.
        pendingOutlineJumpRef.current = null;
        return;
      }
      pendingOutlineJumpRef.current = {
        rowIndex: pending.rowIndex,
        attempts: pending.attempts + 1,
      };
      scrollRowToTop(pending.rowIndex);
    }, [outlineJumpDrift, scrollRowToTop]);

    // Any real input abandons the correction: a reader who starts scrolling
    // must never be yanked back by a jump they have already moved on from.
    useEffect(() => {
      if (!scrollViewportElement) return undefined;
      const abandon = () => {
        pendingOutlineJumpRef.current = null;
      };
      const options = { passive: true } as const;
      scrollViewportElement.addEventListener('wheel', abandon, options);
      scrollViewportElement.addEventListener('touchstart', abandon, options);
      scrollViewportElement.addEventListener('keydown', abandon, options);
      return () => {
        scrollViewportElement.removeEventListener('wheel', abandon);
        scrollViewportElement.removeEventListener('touchstart', abandon);
        scrollViewportElement.removeEventListener('keydown', abandon);
      };
    }, [scrollViewportElement]);

    // Desktop-only top fade: shown only when content has scrolled under the top
    // edge, so it reads as "more conversation above" without dimming the first
    // message while the list sits at its start. setState with an unchanged
    // boolean bails out, so per-scroll-event updates are effectively free.
    const [isScrolledFromTop, setIsScrolledFromTop] = useState(false);

    // ---- Visible turn window -------------------------------------------------
    // Which turns intersect the viewport, from Virtua's own offset math (no
    // layout read): the row under the top edge and the row under the bottom
    // edge, mapped back to turn indices. The stream hydrates around it.
    const lastVisibleTurnRangeRef = useRef<{ from: number; to: number } | null>(null);
    const virtualRowsRef = useLatestRef(virtualRows);
    const onVisibleTurnRangeChangeRef = useLatestRef(onVisibleTurnRangeChange);
    const reportVisibleTurnRange = useCallback(() => {
      const vlist = vlistRef.current;
      const report = onVisibleTurnRangeChangeRef.current;
      const rows = virtualRowsRef.current;
      if (!vlist || !report || rows.length === 0) return;
      const range = resolveVisibleTurnRange(
        rows,
        vlist.findItemIndex(vlist.scrollOffset) - leadingRowCount,
        vlist.findItemIndex(vlist.scrollOffset + vlist.viewportSize) - leadingRowCount
      );
      if (!range) return;
      const last = lastVisibleTurnRangeRef.current;
      if (last && last.from === range.from && last.to === range.to) return;
      lastVisibleTurnRangeRef.current = range;
      report(range.from, range.to);
    }, [leadingRowCount, onVisibleTurnRangeChangeRef, virtualRowsRef]);
    useEffect(() => {
      if (!initialScrollRestored) return;
      reportVisibleTurnRange();
    }, [initialScrollRestored, reportVisibleTurnRange, virtualRows]);

    const handleStreamScroll = useCallback(
      (offset: number) => {
        handleScroll(offset);
        setIsScrolledFromTop(offset > 0);
        syncActiveOutlineIndex();
        if (initialScrollRestored) reportVisibleTurnRange();
      },
      [handleScroll, initialScrollRestored, reportVisibleTurnRange, syncActiveOutlineIndex]
    );

    const scrollToIndex = useCallback(
      (turnIndex: number, smooth?: boolean) => {
        const firstRow = virtualRows.find((row) => row.turnIndex === turnIndex);
        if (!firstRow) return;
        let virtualIndex = -1;
        const messageItem = firstRow.item;
        if (messageItem.type === 'message' && activeSearchBlockId) {
          const prefix = getMessageItemPrefix(messageItem.message.id, 0).slice(0, -1);
          if (activeSearchBlockId.startsWith(prefix)) {
            const itemIndexText = activeSearchBlockId.slice(prefix.length).split(':', 1)[0];
            const itemIndex = Number(itemIndexText);
            if (Number.isInteger(itemIndex)) {
              virtualIndex = virtualRows.findIndex(
                (row) =>
                  row.type === 'assistant' &&
                  row.turnIndex === turnIndex &&
                  row.itemIndex === itemIndex
              );
            }
          }
        }
        if (virtualIndex === -1) {
          virtualIndex = virtualRows.indexOf(firstRow);
        }
        if (virtualIndex === -1) return;
        scrollRowToTop(virtualIndex, smooth ?? true);
      },
      [activeSearchBlockId, scrollRowToTop, virtualRows]
    );

    const handleOutlineHoverRound = useCallback(
      (outlineIndex: number) => {
        if (!onOutlineHoverTurn) return;
        const entry = outlineEntries[outlineIndex];
        const item = entry ? items[entry.messageIndex] : undefined;
        const turnIndex =
          item?.type === 'placeholder'
            ? item.turnIndex
            : item?.type === 'message'
              ? (item.turnIndex ?? entry?.messageIndex)
              : undefined;
        if (turnIndex !== undefined) onOutlineHoverTurn(turnIndex);
      },
      [items, onOutlineHoverTurn, outlineEntries]
    );

    useImperativeHandle(ref, () => ({ scrollToBottom, scrollToIndex }), [
      scrollToBottom,
      scrollToIndex,
    ]);

    const noMessagesLabel = t('sessions.noMessages');
    const galleryEntries = useMemo(
      () =>
        collectSessionImageGalleryEntries(
          items.flatMap((item) => (item.type === 'message' ? [item.message] : [])),
          sessionId
        ),
      [items, sessionId]
    );
    const [activeImageKey, setActiveImageKey] = useState<string | null>(null);
    const activeGalleryEntries = useMemo(() => {
      if (!activeImageKey) return EMPTY_GALLERY_ENTRIES;

      const activeEntry = galleryEntries.find((e) => e.key === activeImageKey);
      if (!activeEntry) return EMPTY_GALLERY_ENTRIES;

      return galleryEntries.filter((e) => e.galleryGroupId === activeEntry.galleryGroupId);
    }, [activeImageKey, galleryEntries]);

    useEffect(() => {
      if (!activeImageKey) {
        return;
      }
      if (findSessionImageGalleryEntryIndex(activeGalleryEntries, activeImageKey) !== -1) {
        return;
      }
      setActiveImageKey(null);
    }, [activeGalleryEntries, activeImageKey]);

    const imagePreviewContextValue = useMemo(
      () => ({
        openImagePreview: (imageKey: string) => {
          setActiveImageKey(imageKey);
        },
      }),
      []
    );
    const chatActionContextValue = useMemo(
      () => ({
        ...(sendMessage ? { sendMessage } : {}),
        ...(onOpenHtmlFile ? { openHtmlFile: onOpenHtmlFile } : {}),
      }),
      [onOpenHtmlFile, sendMessage]
    );
    const hasOnlyEmptyItem = items.length === 1 && items[0]?.type === 'empty';

    if ((!items.length || (hasOnlyEmptyItem && emptyState)) && leadingContent == null) {
      return (
        <SessionChatActionContext.Provider value={chatActionContextValue}>
          <SessionImagePreviewContext.Provider value={imagePreviewContextValue}>
            <ContainerQueryProvider
              ref={scrollRootRef}
              className={cn('relative bg-background', className)}
            >
              {emptyState ?? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No messages yet
                </div>
              )}
            </ContainerQueryProvider>
          </SessionImagePreviewContext.Provider>
        </SessionChatActionContext.Provider>
      );
    }

    return (
      <SessionChatActionContext.Provider value={chatActionContextValue}>
        <SessionImagePreviewContext.Provider value={imagePreviewContextValue}>
          <ContainerQueryProvider
            ref={scrollRootRef}
            className={cn('relative bg-background', className)}
          >
            <div
              ref={scrollContainerRef}
              // Keep x overflow explicit: overflow-y:auto otherwise computes
              // the untouched x axis to auto too, letting any wide row pan the
              // entire conversation instead of its own nested scroller.
              className="chat-scrollbar h-full overflow-x-hidden py-5 sm:py-6"
              // Mobile session page floats a frosted header over the list;
              // `--conversation-top-inset` (set by session-detail's mobile
              // branch) pads the scroll content so the first message clears the
              // header at rest while later content scrolls under it and blurs.
              // Unset elsewhere → falls back to py-6's 1.5rem, a no-op.
              style={{
                display: 'block',
                overflowY: 'auto',
                contain: 'strict',
                width: '100%',
                height: '100%',
                paddingTop: 'calc(var(--conversation-top-inset, 0px) + 1.5rem)',
              }}
            >
              <Virtualizer
                ref={vlistRef}
                shift={false}
                onScroll={handleStreamScroll}
                onScrollEnd={handleStreamScrollEnd}
                // Pre-render extra items outside the viewport to reduce blank areas
                // during fast scrolling (especially on mobile). This is 4x Virtua's
                // default (200px) — generous, but deliberately not the previous 2000px:
                // an oversized buffer keeps a huge set of still-resizing rows mounted,
                // which widens the window where Virtua's offsets are mid-recompute and
                // rows can transiently overlap. 800 keeps ~2 viewports of headroom.
                bufferSize={800}
              >
                {leadingContent == null ? null : (
                  <div data-conversation-leading-content="">{leadingContent}</div>
                )}
                {virtualRows.map((row) => {
                  if (row.type === 'placeholder') {
                    return <TurnPlaceholderRow key={row.key} row={row.item.row} />;
                  }
                  if (row.type === 'standard') {
                    // Standard rows are only ever system or user messages
                    // (assistant turns are flattened into `assistant` rows below),
                    // so they carry no per-turn file diffs or last-assistant
                    // quick actions.
                    return (
                      <ChatItem
                        key={row.key}
                        item={row.item}
                        renderMessageRow={renderMessageRow}
                        noMessagesLabel={noMessagesLabel}
                        emptyState={emptyState}
                      />
                    );
                  }

                  const canForkAssistantMessage =
                    row.item.message.finished === true &&
                    (row.item.message.id === lastCompletedAssistantMessageId ||
                      Boolean(row.item.message.acpTurnId));
                  const fileDiffOverride =
                    messageFileDiffEntriesByTurn === undefined
                      ? undefined
                      : (messageFileDiffEntriesByTurn[row.item.message.id] ??
                        EMPTY_EDITED_FILE_ENTRIES);
                  return (
                    <AssistantChatItem
                      key={row.key}
                      row={row}
                      fileDiffOverride={fileDiffOverride}
                      assistantActions={resolveAssistantMessageActions(
                        row.item.message.id,
                        assistantActionsMessageId,
                        assistantActions
                      )}
                      onFork={canForkAssistantMessage ? onForkLastAssistant : undefined}
                      forkWorktreeAvailability={forkWorktreeAvailability}
                      onForkWorktreeMenuOpen={onForkWorktreeMenuOpen}
                      isForking={forkingAssistantMessageId === row.item.message.id}
                      onFileDiffClick={onFileDiffClick}
                      onFilePathClick={onFilePathClick}
                      onGroupExpandedChange={handleAssistantGroupExpandedChange}
                      onWorkedGroupExpandedChange={handleAssistantWorkedGroupExpandedChange}
                      isTurnHovered={hoveredAssistantMessageId === row.item.message.id}
                      onTurnHoverChange={handleAssistantTurnHoverChange}
                      conversationFontSize={conversationFontSize}
                    />
                  );
                })}
                {shouldShowAgentActivity && agentActivityLabel && (
                  <AgentActivityRow label={agentActivityLabel} tone={agentActivityTone} />
                )}
              </Virtualizer>
            </div>
            {/* Top fade into the bg-background canvas above (desktop only),
                hinting that the conversation continues past the top edge. */}
            {!isMobile && isScrolledFromTop ? (
              <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-background to-transparent" />
            ) : null}
            {/* Round outline. Its visual layer portals to the full-page overlay
                when supplied, so composer growth cannot move its centre. It is
                never a Virtua row or a child of the viewport: sticky scroll
                takes the content element from that div's `firstElementChild`.
                Touch has no hover, so mobile is excluded rather than shipped
                without its preview card. */}
            {isMobile ? null : (
              <ConversationOutlineRail
                entries={outlineEntries}
                activeIndex={activeOutlineIndex}
                onJumpToRound={handleOutlineJump}
                onHoverRound={onOutlineHoverTurn ? handleOutlineHoverRound : undefined}
                overlayRoot={outlineOverlayRoot}
                enableArrivalIntent
              />
            )}
            {showScrollToLatest && !isSticky && (
              /* Full-bleed overlay; ConversationColumn carries the shared
                 horizontal gutter so the button lines up with the composer. */
              <div className="pointer-events-none absolute inset-x-0 bottom-4">
                <ConversationColumn className="flex justify-end">
                  <Button
                    variant="secondary"
                    size="icon"
                    className="pointer-events-auto rounded-full border border-border/70 shadow-lg"
                    onClick={scrollToBottom}
                    aria-label={t('sessions.scrollToLatest')}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </ConversationColumn>
              </div>
            )}
            <ImagePreviewDialog
              open={findSessionImageGalleryEntryIndex(activeGalleryEntries, activeImageKey) !== -1}
              onOpenChange={(open) => {
                if (!open) {
                  setActiveImageKey(null);
                }
              }}
              activeImageKey={activeImageKey}
              onActiveImageKeyChange={setActiveImageKey}
              entries={activeGalleryEntries}
              portalAnchorRef={scrollRootRef}
            />
          </ContainerQueryProvider>
        </SessionImagePreviewContext.Provider>
      </SessionChatActionContext.Provider>
    );
  }
);

SessionChatStreamView.displayName = 'SessionChatStreamView';

export const MessageRowView = memo(function MessageRowView({
  message,
  sessionId,
  user,
  onNavigateSession,
  onEdit,
  onResendUndelivered,
  capacityRetry,
  conversationFontSize = DEFAULT_CONVERSATION_FONT_SIZE,
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
  onEdit?: (message: SessionHistoryParsed, text: string) => Promise<boolean>;
  onResendUndelivered?: (userTurnId: string, inputBlocks: SessionInputBlock[]) => Promise<boolean>;
  capacityRetry?: CapacityRetryControl;
  user?: SessionChatUser;
  conversationFontSize?: ConversationFontSize;
}) {
  const { i18n } = useTranslation();
  const timestampLabel = formatConversationTimestamp(message.timestamp, {
    locale: toIntlLocale(i18n?.resolvedLanguage ?? i18n?.language),
  });
  const hasWideContent = message.items.some((entry) => {
    if (entry.type === 'tool_call') {
      return Boolean(entry.content?.some((block) => block.type === 'diff'));
    }
    return false;
  });

  if (message.role === 'system') {
    return (
      <SystemMessageRowView
        message={message}
        sessionId={sessionId}
        onNavigateSession={onNavigateSession}
        capacityRetry={capacityRetry}
      />
    );
  }

  if (message.role === 'user') {
    return (
      <UserMessageRowView
        message={message}
        sessionId={sessionId}
        user={user}
        timestampLabel={timestampLabel}
        hasWideContent={hasWideContent}
        conversationFontSize={conversationFontSize}
        onEdit={onEdit}
        onResendUndelivered={onResendUndelivered}
      />
    );
  }

  // Assistant turns are rendered by `AssistantChatItem` (the `assistant` virtual
  // rows), never through `renderMessageRow`/`MessageRowView`, so a standard row
  // is only ever a system or user message.
  return null;
});

/**
 * Renders system messages (e.g., system notices like resume_from_external_chat_history)
 */
const SystemMessageRowView = ({
  message,
  sessionId,
  onNavigateSession,
  capacityRetry,
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
  capacityRetry?: CapacityRetryControl;
}) => {
  const tasksEnabled = useAtomValue(tasksFeatureEnabledAtom);
  const systemItems = message.items.flatMap((item, itemIndex) =>
    shouldRenderSystemRowItem(item, tasksEnabled) ? [{ item, itemIndex }] : []
  );

  if (systemItems.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {systemItems.map(({ item, itemIndex }) =>
        item.type === 'system_notice' && item.name === 'task_proposal' ? (
          <TaskProposalNotice
            key={`task-proposal-${itemIndex}`}
            meta={(item.meta ?? { proposalId: '', title: '' }) as TaskProposalMeta}
            sessionId={sessionId}
            entryId={message.id}
            itemIndex={itemIndex}
          />
        ) : item.type === 'system_notice' ? (
          <SystemNoticeView
            key={`${item.name}-${itemIndex}`}
            notice={item}
            sessionId={sessionId}
            onNavigateSession={onNavigateSession}
            capacityRetry={capacityRetry}
          />
        ) : item.type === 'worktree_script' ? (
          <WorktreeScriptNoticeView
            key={`worktree-script-${item.phase}-${itemIndex}`}
            script={item}
          />
        ) : (
          <OperationCompletionView
            key={`${item.deliveryId}-${itemIndex}`}
            completion={item}
            onNavigateSession={onNavigateSession}
          />
        )
      )}
    </div>
  );
};

const selectSessionTitle = (session: SessionMeta | null | undefined): string | null =>
  session?.title?.trim() || null;

const CreatedSessionOperationCard = ({
  sessionId,
  fallbackTitle,
  onNavigateSession,
}: {
  sessionId: SessionId;
  fallbackTitle?: string;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
}) => {
  const { t } = useTranslation();
  const titleAtom = useMemo(
    () => selectAtom(sessionMetaAtomFamily(getSessionRoomId(sessionId)), selectSessionTitle),
    [sessionId]
  );
  const liveTitle = useAtomValue(titleAtom);
  const title = liveTitle || fallbackTitle?.trim() || t('sessions.untitled', 'Untitled session');

  return (
    <SessionRelationCard
      relation="opened"
      label={t('sessions.openedBy.createdSession', 'Session created')}
      sessionTitle={title}
      actionLabel={t('sessions.openedBy.viewSession', 'View session')}
      onAction={onNavigateSession ? () => onNavigateSession({ sessionId }) : undefined}
    />
  );
};

const OperationCompletionView = ({
  completion,
  onNavigateSession,
}: {
  completion: Extract<MessageContent, { type: 'operation_completion' }>;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
}) => {
  const { t } = useTranslation();
  const resultItems =
    completion.completion.type === 'result'
      ? completion.completion.value.items
      : completion.completion.type === 'cancelled'
        ? (completion.completion.partial?.items ?? [])
        : [];
  const succeeded = resultItems.filter((item) => item.status === 'succeeded').length;
  const failed = resultItems.filter((item) => item.status === 'failed').length;
  const cancelled = resultItems.filter((item) => item.status === 'cancelled').length;
  const failedCompletion = completion.completion.type === 'error';
  const cancelledCompletion = completion.completion.type === 'cancelled';
  const StatusIcon = failedCompletion ? AlertCircle : cancelledCompletion ? Circle : CheckCircle2;
  const createdSessions =
    completion.operationKind === 'session_create' ||
    completion.operationKind === 'session_create_many'
      ? resultItems.flatMap((item) =>
          item.status === 'succeeded'
            ? [
                {
                  sessionId: item.target.sessionId,
                  fallbackTitle: item.label,
                },
              ]
            : []
        )
      : [];

  if (createdSessions.length > 0) {
    return (
      <div className="flex flex-col gap-2" data-session-create-completion="">
        {createdSessions.map((created) => (
          <CreatedSessionOperationCard
            key={created.sessionId}
            sessionId={created.sessionId}
            fallbackTitle={created.fallbackTitle}
            onNavigateSession={onNavigateSession}
          />
        ))}
        {failedCompletion || cancelledCompletion || failed > 0 || cancelled > 0 ? (
          <div className="px-1 text-xs text-muted-foreground">
            {failedCompletion
              ? t('orchestration.operationFailed', { id: completion.operationId })
              : cancelledCompletion
                ? t('orchestration.operationCancelled', { id: completion.operationId })
                : t('orchestration.operationItemSummary', {
                    total: resultItems.length,
                    succeeded,
                    failed,
                    cancelled,
                  })}
          </div>
        ) : null}
        {completion.continuation?.status === 'not_started' ? (
          <div className="px-1 text-xs text-muted-foreground">
            {t('orchestration.continuationNotStarted')}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="border-border/70 bg-muted/30 flex items-start gap-2 border-y px-3 py-2 text-sm">
      <StatusIcon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          failedCompletion ? 'text-destructive' : 'text-muted-foreground'
        )}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="font-medium">
          {t(
            failedCompletion
              ? 'orchestration.operationFailed'
              : cancelledCompletion
                ? 'orchestration.operationCancelled'
                : 'orchestration.operationCompleted',
            { id: completion.operationId }
          )}
        </div>
        {resultItems.length > 0 ? (
          <div className="text-muted-foreground mt-0.5">
            {t('orchestration.operationItemSummary', {
              total: resultItems.length,
              succeeded,
              failed,
              cancelled,
            })}
          </div>
        ) : null}
        {completion.continuation?.status === 'not_started' ? (
          <div className="text-muted-foreground mt-0.5">
            {t('orchestration.continuationNotStarted')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const DashedNoticeRule = () => (
  <div
    className="h-px flex-1 opacity-60"
    style={{
      backgroundImage:
        'repeating-linear-gradient(to right, hsl(var(--border)) 0 4px, transparent 4px 7px)',
    }}
  />
);

/**
 * Renders a single system notice as a divider with tooltip
 */
const SystemNoticeView = ({
  notice,
  sessionId,
  onNavigateSession,
  capacityRetry,
}: {
  notice: Extract<MessageContent, { type: 'system_notice' }>;
  sessionId: SessionId;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
  capacityRetry?: CapacityRetryControl;
}) => {
  const { t } = useTranslation();

  switch (notice.name) {
    case 'chat_failed':
      return (
        <ChatFailedNoticeView notice={notice} sessionId={sessionId} capacityRetry={capacityRetry} />
      );
    case 'agent_warning':
      return <AgentWarningNoticeView notice={notice} />;
    case 'resume_from_external_chat_history':
      break;
    case 'session_fork_origin': {
      const meta = notice.meta as
        | { sourceSessionId: SessionId; sourceTurnId: string; sourceTitle: string }
        | undefined;
      if (!meta) return null;
      return (
        <div className="flex items-center gap-3 py-4 text-xs text-muted-foreground/75">
          <DashedNoticeRule />
          {/* min-w-0 on the wrapper + truncate on the button: a long source
              title ellipsizes inside the column instead of pushing past it and
              clipping at the pane edge. Truncation must live on the button —
              on the wrapper the whole button is one atomic inline box, so the
              ellipsis would replace the entire title. */}
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="shrink-0">
              {t('sessions.systemNotices.forkOrigin.prefix', 'This conversation was forked from')}
            </span>
            <button
              type="button"
              title={meta.sourceTitle}
              className="min-w-0 truncate font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              onClick={() => onNavigateSession?.({ sessionId: meta.sourceSessionId })}
            >
              {meta.sourceTitle}
            </button>
          </span>
          <DashedNoticeRule />
        </div>
      );
    }
    default:
      return null;
  }

  const meta = notice.meta as
    | {
        truncated?: boolean;
        terminalOmitted?: boolean;
        thinkingOmitted?: boolean;
      }
    | undefined;

  // Build the main message
  let mainMessage = t(
    'sessions.systemNotices.resumeFromExternalChatHistory.message',
    'Resuming conversation from chat history. Some context may be limited.'
  );

  // Add suffix if truncated
  if (meta?.truncated) {
    mainMessage += ` ${t(
      'sessions.systemNotices.resumeFromExternalChatHistory.truncatedSuffix',
      '(History truncated due to length)'
    )}`;
  }

  // Build tooltip content
  const tooltipContent = t(
    'sessions.systemNotices.resumeFromExternalChatHistory.tooltip',
    'Native ACP resume is not yet supported (WIP). Context is restored from chat history.'
  );

  return (
    <div className="relative flex items-center gap-3 py-4">
      {/* Left divider line */}
      <div className="flex-1 h-px bg-border" />

      {/* Center content */}
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted/50 border border-border/60">
        <TooltipProvider>
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <Info className="h-4 w-4 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-center">
              <p>{tooltipContent}</p>
              {meta?.terminalOmitted && (
                <p className="mt-1 text-xs opacity-80">
                  {t(
                    'sessions.systemNotices.resumeFromExternalChatHistory.terminalOmitted',
                    'Terminal output was omitted to fit context.'
                  )}
                </p>
              )}
              {meta?.thinkingOmitted && (
                <p className="mt-1 text-xs opacity-80">
                  {t(
                    'sessions.systemNotices.resumeFromExternalChatHistory.thinkingOmitted',
                    'Agent thinking was omitted to fit context.'
                  )}
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span className="text-xs text-muted-foreground">{mainMessage}</span>
      </div>

      {/* Right divider line */}
      <div className="flex-1 h-px bg-border" />
    </div>
  );
};

/**
 * Renders a chat_failed system notice as an error message
 */
const ChatFailedNoticeView = ({
  notice,
  sessionId,
  capacityRetry,
}: {
  notice: Extract<MessageContent, { type: 'system_notice' }>;
  sessionId: SessionId;
  capacityRetry?: CapacityRetryControl;
}) => {
  const { t } = useTranslation();
  const sessionMeta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const agentConfig = useAtomValue(getAgentMetaByIdAtomFamily(sessionMeta?.agentConfigId));
  const sessionLaunch = getSessionLaunchConfigLegacyFields(sessionMeta);
  const sessionMachineMeta = useAtomValue(getMachineMetaByIdAtomFamily(sessionMeta?.machineId));
  // The ACP `authenticate` exchange runs entirely on the daemon, so a machine
  // that predates it answers "Authentication is not supported": offering a
  // sign-in button there would only ever fail. Builtin providers keep their
  // long-standing login flow and need no negotiation.
  const canAuthenticateSessionAgent =
    !!sessionMeta &&
    supportsAuthenticationWhenRequired({
      cliType: sessionMeta.cliType,
      agentType: sessionMeta.agentType,
    }) &&
    (!usesAcpProtocolAuthentication(sessionMeta.cliType) ||
      machineSupportsAcpProtocolAuthentication(sessionMachineMeta));
  const [detailOpen, setDetailOpen] = useState(false);

  const meta = notice.meta as
    | {
        reason?: string;
        code?: ChatFailedCode;
        message?: string;
      }
    | undefined;

  const diagnosticCopy = getChatFailedDiagnosticCopy(meta?.code);

  // Map reason codes to user-friendly messages
  const getReasonMessage = (reason?: string): string => {
    if (diagnosticCopy) {
      return t(diagnosticCopy.titleKey, diagnosticCopy.title);
    }
    switch (reason) {
      case 'session_archived':
        return t('sessions.systemNotices.chatFailed.sessionArchived', 'Session is archived');
      case 'agent_type_mismatch':
        return t(
          'sessions.systemNotices.chatFailed.agentTypeMismatch',
          'Agent type mismatch - cannot resume with different agent'
        );
      case 'session_init_failed':
        return t(
          'sessions.systemNotices.chatFailed.sessionInitFailed',
          'Session initialization failed'
        );
      case 'session_restore_failed':
        return t(
          'sessions.systemNotices.chatFailed.sessionRestoreFailed',
          'Failed to restore session'
        );
      case 'session_not_found':
        return t('sessions.systemNotices.chatFailed.sessionNotFound', 'Session not found');
      case 'acp_not_ready':
        return t(
          'sessions.systemNotices.chatFailed.acpNotReady',
          'Agent session was not ready. Please try again.'
        );
      case 'agent_disconnected':
        return t(
          'sessions.systemNotices.chatFailed.agentDisconnected',
          'Agent disconnected unexpectedly'
        );
      case 'agent_no_output':
        return t(
          'sessions.systemNotices.chatFailed.agentNoOutput',
          'The agent ended the turn without producing any output — you can retry your message'
        );
      case 'turn_pre_prompt_failed':
        return t(
          'sessions.systemNotices.chatFailed.turnPrePromptFailed',
          'Failed before the agent could start'
        );
      case 'message_delivery_failed':
        return t(
          'sessions.systemNotices.chatFailed.messageDeliveryFailed',
          'Message delivery failed - please resend after sync recovers'
        );
      case 'machine_access_denied':
        return t('sessions.systemNotices.chatFailed.machineAccessDenied', 'Machine access denied');
      case 'memory_pressure':
        return t(
          'sessions.systemNotices.chatFailed.memoryPressure',
          'The machine is low on memory - free some memory and retry'
        );
      case 'acp_auth_required':
        return t('sessions.systemNotices.chatFailed.acpAuthRequired', 'Authentication required');
      case 'acp_internal_error':
        return t('sessions.systemNotices.chatFailed.acpInternalError', 'Agent internal error');
      case 'acp_upstream_api_error':
        return t(
          'sessions.systemNotices.chatFailed.acpUpstreamApiError',
          'Upstream API error — you can retry your message'
        );
      case 'acp_provider_overloaded':
        return t(
          'sessions.systemNotices.chatFailed.acpProviderOverloaded',
          'Selected model is at capacity. Please try a different model.'
        );
      case 'acp_session_storage_incompatible':
        return t(
          'sessions.systemNotices.chatFailed.acpSessionStorageIncompatible',
          'DeepSeek session storage uses incompatible compression — keep one format or use a separate DSH_HOME'
        );
      case 'acp_resource_not_found':
        return t(
          'sessions.systemNotices.chatFailed.acpResourceNotFound',
          'Agent resource not found'
        );
      case 'acp_request_cancelled':
        return t('sessions.systemNotices.chatFailed.acpRequestCancelled', 'Request was cancelled');
      case 'acp_method_not_found':
        return t(
          'sessions.systemNotices.chatFailed.acpMethodNotFound',
          'Agent protocol method not found'
        );
      case 'acp_invalid_params':
        return t(
          'sessions.systemNotices.chatFailed.acpInvalidParams',
          'Invalid request parameters'
        );
      case 'acp_invalid_request':
        return t('sessions.systemNotices.chatFailed.acpInvalidRequest', 'Invalid request');
      case 'acp_parse_error':
        return t('sessions.systemNotices.chatFailed.acpParseError', 'Failed to parse request');
      case 'acp_unknown_error':
        return t('sessions.systemNotices.chatFailed.acpUnknownError', 'Agent error');
      default:
        return t('sessions.systemNotices.chatFailed.unknown', 'Failed to process message');
    }
  };

  const reasonMessage = getReasonMessage(meta?.reason);
  const actionMessage = diagnosticCopy
    ? t(diagnosticCopy.actionKey, diagnosticCopy.action)
    : undefined;
  const rawMessage = meta?.message?.trim() ? meta.message : undefined;
  const detailMessage = (() => {
    if (!rawMessage) return undefined;
    const extracted = extractReadableChatFailedMessage(rawMessage);
    return extracted !== reasonMessage ? extracted : undefined;
  })();
  // The raw error only lives behind the modal, so open it whenever there is a
  // raw message at all — even one whose readable extract equals the title, the
  // full payload (stack, upstream JSON) is still worth reading and copying.
  const hasDetail = Boolean(rawMessage && rawMessage.trim() !== reasonMessage);
  const isProviderOverloaded = meta?.reason === 'acp_provider_overloaded';

  const noticeBody = (
    <>
      <AlertCircle
        className={cn('mt-0.5 h-4 w-4 shrink-0', isProviderOverloaded && 'text-muted-foreground')}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-col items-start">
        <span
          className={cn(
            'break-words text-left text-xs leading-5',
            isProviderOverloaded ? 'font-normal text-foreground/80' : 'font-medium'
          )}
        >
          {reasonMessage}
        </span>
        {actionMessage ? (
          <span className="max-w-xl break-words text-left text-xs font-normal leading-5 text-muted-foreground">
            {actionMessage}
          </span>
        ) : null}
        {hasDetail ? (
          <span
            className={cn(
              'mt-0.5 inline-flex items-center gap-0.5 text-xs font-normal leading-5 underline underline-offset-2',
              isProviderOverloaded ? 'text-muted-foreground' : 'text-destructive/80'
            )}
          >
            {t('sessions.systemNotices.chatFailed.viewDetails', 'View details')}
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          </span>
        ) : null}
      </span>
    </>
  );

  const rowClassName = cn(
    'flex w-fit max-w-full items-start gap-2 rounded-md px-2 py-1 text-left focus-visible:outline-none',
    isProviderOverloaded
      ? 'text-muted-foreground hover:bg-muted/40 focus-visible:bg-muted/40'
      : 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10'
  );

  const retryInSeconds = capacityRetry?.retryInSeconds ?? null;
  const isRetryCountdown = retryInSeconds !== null;
  const stopAutoRetryLabel = t(
    'sessions.systemNotices.chatFailed.stopAutoRetry',
    'Stop auto-retry'
  );
  const retryAction =
    isProviderOverloaded && capacityRetry ? (
      <button
        type="button"
        aria-label={isRetryCountdown ? stopAutoRetryLabel : undefined}
        className="group relative isolate inline-grid h-7 shrink-0 place-items-center overflow-hidden rounded-full bg-muted-foreground/[0.04] px-2.5 text-xs font-normal tabular-nums text-foreground/80 transition-colors hover:bg-muted-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        disabled={capacityRetry.pending || !capacityRetry.canRetry}
        onClick={isRetryCountdown ? capacityRetry.stopAutoRetry : capacityRetry.retry}
      >
        {capacityRetry.retryRemainingRatio !== null ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 -z-10 bg-muted-foreground/[0.08] transition-[width] duration-300 ease-linear"
            style={{ width: `${capacityRetry.retryRemainingRatio * 100}%` }}
          />
        ) : null}
        {isRetryCountdown ? (
          <>
            <span className="relative z-10 col-start-1 row-start-1 group-hover:invisible group-focus-visible:invisible [@media(hover:none)]:invisible">
              {t('sessions.systemNotices.chatFailed.retryIn', 'Retry in {{seconds}}s', {
                seconds: retryInSeconds,
              })}
            </span>
            <span className="invisible relative z-10 col-start-1 row-start-1 group-hover:visible group-focus-visible:visible [@media(hover:none)]:visible">
              {stopAutoRetryLabel}
            </span>
          </>
        ) : (
          <span className="relative z-10">
            {capacityRetry.pending
              ? t('sessions.systemNotices.chatFailed.retrying', 'Retrying…')
              : capacityRetry.autoRetryExhausted
                ? t('sessions.systemNotices.chatFailed.retryAgain', 'Retry again')
                : capacityRetry.autoRetryEnabled
                  ? t('sessions.systemNotices.chatFailed.retryNow', 'Retry now')
                  : t(
                      'sessions.systemNotices.chatFailed.retryAndEnableAuto',
                      'Retry and auto-retry'
                    )}
          </span>
        )}
      </button>
    ) : null;

  return (
    <div className="space-y-2 py-1 @[640px]:pl-3">
      {/* Tapping the notice opens a modal instead of a hover tooltip: a tooltip
          is unreachable on touch devices, which left mobile users with no way to
          read or copy the actual agent error. */}
      <div role="alert" className="flex w-fit max-w-full flex-wrap items-center gap-2">
        {hasDetail ? (
          <button
            type="button"
            aria-haspopup="dialog"
            className={cn(rowClassName, 'cursor-pointer')}
            onClick={() => setDetailOpen(true)}
          >
            {noticeBody}
          </button>
        ) : (
          <div className={rowClassName}>{noticeBody}</div>
        )}
        {retryAction}
      </div>
      {hasDetail ? (
        <ChatFailedDetailDialog
          open={detailOpen}
          onOpenChange={setDetailOpen}
          title={reasonMessage}
          action={actionMessage}
          summary={detailMessage}
          reason={meta?.reason}
          code={meta?.code}
          message={rawMessage}
          sessionId={sessionId}
          agentType={sessionMeta?.agentType}
          machineId={sessionMeta?.machineId}
        />
      ) : null}
      {meta?.reason === 'acp_auth_required' && sessionMeta && canAuthenticateSessionAgent ? (
        <AcpAuthenticationPanel
          machineId={sessionMeta.machineId}
          configId={sessionMeta.agentConfigId}
          cliType={sessionMeta.cliType}
          agentType={sessionMeta.agentType}
          providerName={agentConfig?.name}
          customAcp={agentConfig?.customAcp ?? sessionLaunch?.customAcp}
          runtimeOverrides={agentConfig?.runtimeOverrides ?? sessionLaunch?.runtimeOverrides}
          env={agentConfig?.env ?? sessionLaunch?.env}
          compact
        />
      ) : null}
    </div>
  );
};

const AgentWarningNoticeView = ({
  notice,
}: {
  notice: Extract<MessageContent, { type: 'system_notice' }>;
}) => {
  const { t } = useTranslation();
  const meta = notice.meta as { message?: string; source?: string } | undefined;
  if (!meta?.message) {
    return null;
  }

  return (
    <div className="py-1 @[640px]:pl-3">
      <div
        role="alert"
        className="flex w-fit max-w-full items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-2.5 py-1.5"
      >
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium leading-4 text-status-warning">
            {t('sessions.systemNotices.agentWarning.title', 'Agent warning')}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
            {meta.message}
          </span>
        </div>
      </div>
    </div>
  );
};

const WorktreeScriptNoticeView = ({
  script,
}: {
  script: Extract<MessageContent, { type: 'worktree_script' }>;
}) => {
  const { t } = useTranslation();
  const isRunning = script.status === 'in_progress';
  const isFailed = script.status === 'failed';
  const hasSteps = script.steps.length > 0;
  const hasOutput = script.steps.some((step) => step.output.length > 0);
  const stepStatusKey = script.steps.map((step) => step.status).join('|');
  const [isOutputOpen, setIsOutputOpen] = useState(isRunning || isFailed);
  const [openTerminalSteps, setOpenTerminalSteps] = useState<Set<number>>(
    () => new Set(getDefaultOpenWorktreeScriptStepIndexes(script.status, stepStatusKey))
  );
  const previousStatusRef = useRef(script.status);

  useEffect(() => {
    if (previousStatusRef.current === script.status) {
      return;
    }
    previousStatusRef.current = script.status;
    // Open while running / on failure (keep the error visible); collapse only
    // once it completes cleanly.
    setIsOutputOpen(script.status !== 'completed');
  }, [script.status]);

  useEffect(() => {
    setOpenTerminalSteps(
      new Set(getDefaultOpenWorktreeScriptStepIndexes(script.status, stepStatusKey))
    );
  }, [script.status, script.steps.length, stepStatusKey]);

  const PhaseIcon = script.phase === 'cleanup' ? BrushCleaning : Wrench;
  const title =
    script.phase === 'setup'
      ? t('sessions.worktreeScript.setup', 'worktree setup')
      : t('sessions.worktreeScript.cleanup', 'worktree cleanup');
  const waitingOutput = t('sessions.worktreeScript.waitingOutput', 'Waiting for script output…');
  const canToggle = hasSteps || hasOutput || isRunning;

  return (
    <CollapsibleCard
      isCollapsible={canToggle}
      showDisclosureIcon
      expanded={canToggle ? isOutputOpen : undefined}
      onExpandedChange={setIsOutputOpen}
      containerClassName="w-full max-w-[760px]"
      bodyClassName="px-0"
      left={
        <Fragment>
          <PhaseIcon
            className={cn(
              'h-3.5 w-3.5 flex-none shrink-0',
              isFailed ? 'text-destructive' : 'text-muted-foreground'
            )}
          />
          <span
            className={cn(
              'truncate text-[13px] font-medium leading-tight',
              isFailed ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {title}
          </span>
          {isRunning ? (
            <Loader2 className="h-3 w-3 flex-none shrink-0 animate-spin text-muted-foreground" />
          ) : null}
        </Fragment>
      }
    >
      {canToggle ? (
        <div className="flex flex-col gap-2">
          {script.steps.map((step, stepIndex) => {
            const isStepOpen = openTerminalSteps.has(stepIndex);
            const output =
              step.output.length > 0 || step.status !== 'in_progress' ? step.output : waitingOutput;
            return (
              <TerminalComponent
                key={`${stepIndex}-${step.command}`}
                title={step.command}
                command=""
                output={output}
                className={cn('rounded-md', step.status === 'failed' && 'border-destructive/30')}
                showHeader
                showBorder
                bodyVisible={isStepOpen}
                onHeaderClick={() =>
                  setOpenTerminalSteps((current) => {
                    const next = new Set(current);
                    if (next.has(stepIndex)) {
                      next.delete(stepIndex);
                    } else {
                      next.add(stepIndex);
                    }
                    return next;
                  })
                }
                headerExpanded={isStepOpen}
              />
            );
          })}
        </div>
      ) : null}
    </CollapsibleCard>
  );
};

function getDefaultOpenWorktreeScriptStepIndexes(
  scriptStatus: 'in_progress' | 'completed' | 'failed',
  stepStatusKey: string
): number[] {
  const stepStatuses = stepStatusKey ? stepStatusKey.split('|') : [];
  for (let index = stepStatuses.length - 1; index >= 0; index -= 1) {
    if (stepStatuses[index] === 'in_progress') {
      return [index];
    }
  }
  if (scriptStatus === 'failed') {
    for (let index = stepStatuses.length - 1; index >= 0; index -= 1) {
      if (stepStatuses[index] === 'failed') {
        return [index];
      }
    }
  }
  return [];
}

const UserMessageRowView = ({
  message,
  sessionId,
  user,
  timestampLabel,
  hasWideContent,
  conversationFontSize,
  onEdit,
  onResendUndelivered,
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
  user?: SessionChatUser;
  timestampLabel: string;
  hasWideContent: boolean;
  conversationFontSize: ConversationFontSize;
  onEdit?: (message: SessionHistoryParsed, text: string) => Promise<boolean>;
  onResendUndelivered?: (userTurnId: string, inputBlocks: SessionInputBlock[]) => Promise<boolean>;
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  // The RPC fast-path ACK overlays "delivered" before the entry's CRDT status
  // flip syncs back (the machine may run the whole turn before it can see the
  // entry to flip it).
  const rpcDeliveredTurns = useAtomValue(rpcDeliveredTurnsAtom);
  const rpcDelivered = rpcDeliveredTurns.has(getRpcDeliveredTurnKey(sessionId, message.id));
  const isPendingApply = message.status === 'pending_apply' && !rpcDelivered;
  const isDelivered = !isPendingApply && (isSessionHistoryDelivered(message) || rpcDelivered);
  // Missing-history recovery negatively acknowledged this exact turn
  // (`SessionMeta.lastMissingHistoryUserMsgId`): the entry is visible but kept
  // out of every dispatch path permanently, so it renders as a terminal "not
  // delivered" label instead of an endless "sending" one. The label is the
  // recovery entry point: clicking it opens a confirmation dialog that resends
  // the SAME content as a NEW message — the old turn never revives.
  const sessionMeta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const isUndelivered = isUndeliveredUserTurnEntry(
    sessionMeta?.lastMissingHistoryUserMsgId,
    message
  );
  const pinCtx = useSessionPin();
  const showSendingSpinner =
    useIsMessageSendingVisible(message.id) && !isDelivered && !isUndelivered;

  const hasTextContent = hasTextContentFromMessageItems(message.items);
  const [didCopy, setDidCopy] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [resendDialogOpen, setResendDialogOpen] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [editText, setEditText] = useState(() => getTextContentFromMessageItems(message.items));
  const [didCopyMessageId, setDidCopyMessageId] = useState(message.id);
  if (didCopyMessageId !== message.id) {
    setDidCopyMessageId(message.id);
    setDidCopy(false);
  }

  const isPinned = pinCtx?.pinnedHistoryId === message.id;

  const handleCopy = useCallback(async () => {
    if (!hasTextContent) return;

    // The chip form, not the rewritten instruction the agent received.
    const textContent = getCopyTextFromMessageItems(message.items);
    const ok = await writeTextToClipboard(textContent);
    if (!ok) return;

    setDidCopy(true);
    window.setTimeout(() => setDidCopy(false), 1200);
  }, [hasTextContent, message.items]);

  const handlePin = useCallback(() => {
    if (!pinCtx) return;
    pinCtx.onPin(isPinned ? null : message.id);
  }, [pinCtx, isPinned, message.id]);

  const handleConfirmResend = useCallback(async () => {
    if (!onResendUndelivered || isResending) {
      return;
    }
    const inputBlocks = buildResendInputBlocks(message);
    if (inputBlocks.length === 0) {
      return;
    }
    setIsResending(true);
    try {
      const accepted = await onResendUndelivered(message.id, inputBlocks);
      if (!accepted) {
        toast.error(t('sessions.resendUndelivered.failed', 'Failed to resend the message'));
      }
    } catch (error) {
      console.warn('Failed to resend undelivered user turn', {
        sessionId,
        userTurnId: message.id,
        error,
      });
      toast.error(t('sessions.resendUndelivered.failed', 'Failed to resend the message'));
    } finally {
      setIsResending(false);
      setResendDialogOpen(false);
    }
  }, [isResending, message, onResendUndelivered, sessionId, t]);

  const handleSaveEdit = useCallback(async () => {
    if (!onEdit || isSavingEdit || !editText.trim()) return;
    setIsSavingEdit(true);
    try {
      if (await onEdit(message, editText)) {
        setIsEditing(false);
      }
    } finally {
      setIsSavingEdit(false);
    }
  }, [editText, isSavingEdit, message, onEdit]);

  return (
    <div className={cn('flex w-full flex-row-reverse', isMobile ? 'gap-2 pl-7' : 'gap-2.5')}>
      <div className="mt-0.5 shrink-0 text-muted-foreground">
        <UserAvatar user={user} className={cn(isMobile ? 'h-7 w-7' : 'h-8 w-8')} showIcon />
      </div>
      <div
        className={cn(
          'group/usermsg flex min-w-0 flex-1 flex-col items-end text-left',
          isMobile ? 'max-w-[min(100%,28rem)] gap-1' : 'max-w-[80%] gap-1.5 sm:max-w-[70%]'
        )}
      >
        <div className="flex flex-row-reverse items-center gap-1.5 text-[11px] text-muted-foreground">
          {timestampLabel ? <span className="tabular-nums">{timestampLabel}</span> : null}
          {isUndelivered ? (
            onResendUndelivered ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-sm text-destructive underline-offset-2 transition-colors hover:text-destructive/80 hover:underline"
                aria-label={t('sessions.resendUndelivered.action', 'Resend message')}
                onClick={() => setResendDialogOpen(true)}
              >
                <AlertCircle className="h-3.5 w-3.5" strokeWidth={2} />
                {!isMobile ? t('sessions.messageStatus.notDelivered', 'Not delivered') : null}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 text-destructive">
                <AlertCircle className="h-3.5 w-3.5" strokeWidth={2} />
                {!isMobile ? t('sessions.messageStatus.notDelivered', 'Not delivered') : null}
              </span>
            )
          ) : isPendingApply ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" strokeWidth={2} />
              {!isMobile ? t('sessions.messageStatus.pendingApply', 'Steering') : null}
            </span>
          ) : (
            <span title={isDelivered ? 'Delivered' : 'Sending'}>
              {isDelivered ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" strokeWidth={2} />
              ) : (
                <Circle className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2} />
              )}
            </span>
          )}
        </div>
        <div className="flex w-full min-w-0 items-start justify-end">
          <div
            className={cn(
              'flex w-full min-w-0 justify-end',
              'max-w-full',
              hasWideContent ? 'scrollbar-pro overflow-x-auto' : ''
            )}
          >
            {/* min-w-0: this is the flex item wrapping the content stack. Without it the flex
                item's `min-width:auto` resolves to the content's min-content, which WebKit
                (Safari / iOS Capacitor WebView) computes WITHOUT honoring the inner
                `overflow-wrap:anywhere`. The item then refuses to shrink below a long
                unbreakable line, the content grows to its `sm:max-w-[800px]` cap, and being
                right-aligned (`justify-end`) it overflows the column on the left. Chromium
                honors overflow-wrap here so it doesn't repro there — hence "only sometimes". */}
            <div className={cn('relative min-w-0 max-w-full', isEditing ? 'w-full' : 'w-fit')}>
              {showSendingSpinner && (
                <Loader2 className="absolute bottom-[13px] right-full mr-1.5 h-4 w-4 animate-spin text-muted-foreground" />
              )}
              <div
                className={cn(
                  'min-w-0 max-w-full text-foreground',
                  isEditing ? 'w-full' : 'w-fit',
                  hasWideContent ? 'min-w-[480px]' : '',
                  'sm:max-w-[800px]'
                )}
                data-native-selection-allow
              >
                {isEditing ? (
                  <div className="flex min-w-0 max-w-full flex-col items-end gap-2">
                    <UserChatBubble
                      sessionId={sessionId}
                      message={message}
                      conversationFontSize={conversationFontSize}
                      variant="attachments"
                    />
                    <UserMessageEditor
                      value={editText}
                      onChange={setEditText}
                      onCancel={() => setIsEditing(false)}
                      onSave={() => void handleSaveEdit()}
                      isSaving={isSavingEdit}
                      conversationFontSize={conversationFontSize}
                    />
                  </div>
                ) : (
                  <UserChatBubble
                    sessionId={sessionId}
                    message={message}
                    conversationFontSize={conversationFontSize}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
        {/* While editing, the row's own actions (edit/pin/copy) would compete with
            the editor's Cancel / Save & resend — hide them until it closes. */}
        {hasTextContent && !isEditing ? (
          <div className="flex gap-0.5">
            {onEdit ? (
              <TooltipProvider>
                <Tooltip delayDuration={500}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'h-7 w-7 text-muted-foreground hover:bg-hover hover:text-foreground transition-opacity',
                        !isMobile &&
                          'opacity-0 group-hover/usermsg:opacity-100 focus-visible:opacity-100'
                      )}
                      onClick={() => {
                        setEditText(getTextContentFromMessageItems(message.items));
                        setIsEditing(true);
                      }}
                      aria-label={t('sessions.editMessage', 'Edit message')}
                    >
                      <PencilLine className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('sessions.editMessage', 'Edit message')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            {pinCtx ? (
              <TooltipProvider>
                <Tooltip delayDuration={500}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'h-7 w-7 text-muted-foreground hover:bg-hover hover:text-foreground transition-opacity',
                        !isMobile &&
                          'opacity-0 group-hover/usermsg:opacity-100 focus-visible:opacity-100'
                      )}
                      onClick={handlePin}
                      aria-label={
                        isPinned
                          ? t('sessions.pin.unpin', 'Unpin message')
                          : t('sessions.pin.pin', 'Pin this message')
                      }
                    >
                      {isPinned ? (
                        <PinOff className="h-3.5 w-3.5" />
                      ) : (
                        <Pin className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isPinned
                      ? t('sessions.pin.unpin', 'Unpin message')
                      : t('sessions.pin.pin', 'Pin this message')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            <TooltipProvider>
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'h-7 w-7 text-muted-foreground hover:bg-hover hover:text-foreground transition-opacity',
                      !isMobile &&
                        'opacity-0 group-hover/usermsg:opacity-100 focus-visible:opacity-100'
                    )}
                    onClick={() => {
                      void handleCopy();
                    }}
                    aria-label="Copy message"
                  >
                    {didCopy ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{didCopy ? 'Copied' : 'Copy message'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ) : null}
      </div>
      {onResendUndelivered ? (
        <ResendUndeliveredDialog
          open={resendDialogOpen}
          onOpenChange={setResendDialogOpen}
          isResending={isResending}
          onConfirm={() => {
            void handleConfirmResend();
          }}
        />
      ) : null}
    </div>
  );
};

/**
 * Confirmation dialog behind the "Not delivered" label: resends the
 * undelivered turn's exact content as a NEW message (the old turn is never
 * revived). The row's label is the only entry point.
 */
const ResendUndeliveredDialog = ({
  open,
  onOpenChange,
  isResending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isResending: boolean;
  onConfirm: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('sessions.resendUndelivered.title', 'Message not delivered')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              'sessions.resendUndelivered.description',
              'This message never reached the agent, so it did not run. Resend the same content as a new message?'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isResending}>
            {t('common.cancel', 'Cancel')}
          </AlertDialogCancel>
          <AlertDialogAction disabled={isResending} onClick={onConfirm}>
            {isResending ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : null}
            {t('sessions.resendUndelivered.action', 'Resend message')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** Hover tooltip + click popover for turn model / run-config. */
const AssistantTurnConfigInfoButton = ({
  message,
  sessionId,
  className,
  iconClassName,
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
  className?: string;
  iconClassName?: string;
}) => {
  const { t } = useTranslation();
  const [configOpen, setConfigOpen] = useState(false);
  const avatarMetaAtom = useMemo(
    () =>
      selectAtom(
        sessionMetaAtomFamily(getSessionRoomId(sessionId)),
        selectAgentAvatarSessionMeta,
        agentAvatarSessionMetaEqual
      ),
    [sessionId]
  );
  const sessionAvatarMeta = useAtomValue(avatarMetaAtom);
  const avatarAgentConfig = useAtomValue(
    getAgentMetaByIdAtomFamily(sessionAvatarMeta.agentConfigId)
  );
  const configRows = useMemo(
    () => buildAssistantTurnConfigRows(message.modelInfo, message.inputConfig),
    [message.modelInfo, message.inputConfig]
  );
  const modelBaseName = message.modelInfo ? formatAssistantModelBaseName(message.modelInfo) : '';
  if (configRows.length === 0 && !modelBaseName) {
    return null;
  }
  const tooltipPreview = (() => {
    if (configRows.length === 0) {
      return t('sessions.turnConfig.tooltipEmpty', 'No run configuration recorded for this turn');
    }
    const bits = configRows
      .filter((row) => row.label !== 'Model')
      .slice(0, 3)
      .map((row) => `${row.label}: ${row.value}`);
    if (bits.length === 0) {
      return modelBaseName || t('sessions.turnConfig.tooltip', 'View turn configuration');
    }
    return bits.join(' · ');
  })();

  return (
    <Popover open={configOpen} onOpenChange={setConfigOpen}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex shrink-0 items-center justify-center rounded-sm',
                  /* Rest tone matches every other icon in the turn; hover is
                     what brightens. */
                  'text-muted-foreground transition-colors',
                  'hover:bg-hover/50 hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  className
                )}
                aria-label={t('sessions.turnConfig.open', 'Turn configuration')}
                aria-expanded={configOpen}
              >
                <Info className={cn('h-3.5 w-3.5', iconClassName)} strokeWidth={2} />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          {!configOpen ? (
            <TooltipContent side="top" className="max-w-xs">
              {tooltipPreview}
            </TooltipContent>
          ) : null}
        </Tooltip>
      </TooltipProvider>
      <PopoverContent align="start" side="bottom" sideOffset={6} className="w-64 gap-0 p-0">
        <div className="border-b border-border/60 px-3 py-2">
          <div className="text-[11px] font-medium text-foreground">
            {t('sessions.turnConfig.title', 'Turn configuration')}
          </div>
        </div>
        <dl className="space-y-1.5 px-3 py-2.5">
          {configRows.map((row) => (
            <div key={row.label} className="flex items-start justify-between gap-3 text-[11px]">
              <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
              <dd className="flex min-w-0 items-center justify-end gap-1.5 text-right font-medium text-foreground">
                {row.label === 'Model' ? (
                  <AgentAvatar
                    className="h-3.5 w-3.5 shrink-0"
                    modelInfo={message.modelInfo}
                    cliType={sessionAvatarMeta.cliType}
                    agentType={sessionAvatarMeta.agentType}
                    env={avatarAgentConfig?.env ?? sessionAvatarMeta.env}
                  />
                ) : null}
                <span className="min-w-0 break-words">{row.value}</span>
              </dd>
            </div>
          ))}
          {configRows.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t('sessions.turnConfig.empty', 'No configuration recorded for this turn.')}
            </p>
          ) : null}
        </dl>
      </PopoverContent>
    </Popover>
  );
};

/* Shared type/icon for the activity group header AND every tool/thought
   step under it — one size, one color so the stack reads as one list. */
const ACTIVITY_PROCESS_TEXT_CLASS = 'text-[12.5px] font-medium leading-snug text-muted-foreground';
const ACTIVITY_PROCESS_ICON_CLASS = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';
/* One tone for every icon in a turn — see `ACTIVITY_PROCESS_ICON_CLASS`. Only
   the optical nudge is local; no per-icon opacity. */
const ACTIVITY_STEP_ICON_CLASS = cn(ACTIVITY_PROCESS_ICON_CLASS, 'mt-0.5');
/* `-mx-1` + `px-1`: the hover pill still bleeds a little past the text, but the
   icon starts ON the rail. A plain `px-1` pushed every expanded step 4px right
   of the group header that owns it. */
const ACTIVITY_STEP_BUTTON_CLASS = cn(
  '-mx-1 min-h-7 items-start rounded-md px-1 py-1 hover:bg-hover/40',
  ACTIVITY_PROCESS_TEXT_CLASS
);
const ACTIVITY_STEP_TITLE_CLASS = cn('min-w-0 flex-1', ACTIVITY_PROCESS_TEXT_CLASS);
const ACTIVITY_STEP_BODY_CLASS =
  'text-[12.5px] font-medium leading-[1.5] text-muted-foreground ' +
  '[&_:is(h1,h2,h3,h4,h5,h6)]:!my-1 [&_:is(h1,h2,h3,h4,h5,h6)]:!text-[12.5px] ' +
  '[&_:is(h1,h2,h3,h4,h5,h6)]:!font-medium [&_:is(h1,h2,h3,h4,h5,h6)]:!text-muted-foreground ' +
  '[&_:is(h1,h2,h3,h4,h5,h6):first-child]:!mt-0 ' +
  '[&_p]:!mb-1 [&_p:last-child]:!mb-0 [&_li:not(:first-child)]:!mt-0.5';

const ActivityGroupHeader = ({
  summary,
  expanded,
  isThinking,
  onExpandedChange,
}: {
  summary: AssistantActivitySummary;
  expanded: boolean;
  isThinking: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) => {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (summary.hasThought) {
    parts.push(
      isThinking
        ? t('sessions.toolActivity.thinking', 'Thinking…')
        : t('sessions.toolActivity.thought', 'Thought')
    );
  }
  if (summary.commandCount > 0) {
    parts.push(t('sessions.toolActivity.commands', { count: summary.commandCount }));
  }
  if (summary.readFileCount > 0) {
    parts.push(t('sessions.toolActivity.readFiles', { count: summary.readFileCount }));
  }
  if (summary.editFileCount > 0) {
    parts.push(t('sessions.toolActivity.editedFiles', { count: summary.editFileCount }));
  }
  if (summary.searchCount > 0) {
    parts.push(t('sessions.toolActivity.searches', { count: summary.searchCount }));
  }
  if (summary.fetchCount > 0) {
    parts.push(t('sessions.toolActivity.fetches', { count: summary.fetchCount }));
  }
  if (summary.otherCount > 0) {
    parts.push(t('sessions.toolActivity.tools', { count: summary.otherCount }));
  }
  return (
    <button
      type="button"
      /* pl-0 so the chevron’s left edge lines up with the body text
         under this group (shared process-rail content box). */
      className={cn(
        'group flex w-full items-center gap-1.5 rounded-md py-1 pl-0 pr-1 text-left transition-colors hover:bg-hover/40',
        ACTIVITY_PROCESS_TEXT_CLASS
      )}
      onClick={() => onExpandedChange(!expanded)}
      aria-expanded={expanded}
    >
      <ChevronRight
        className={cn(
          ACTIVITY_PROCESS_ICON_CLASS,
          'flex-none transition-transform duration-200',
          expanded && 'rotate-90'
        )}
      />
      <span className={cn('min-w-0 flex-1', ACTIVITY_PROCESS_TEXT_CLASS)}>{parts.join(' · ')}</span>
    </button>
  );
};

const WorkedGroupHeader = ({
  durationMs,
  expanded,
  onExpandedChange,
}: {
  durationMs: number | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const durationUnitLabels: DurationUnitLabels = {
    hour: t('time.unitShort.hour', 'h'),
    minute: t('time.unitShort.minute', 'm'),
    second: t('time.unitShort.second', 's'),
  };
  /* Mobile moves the turn duration to the footer action bar, where it also
     keeps the copy button clear of the session drawer's left-edge back-swipe
     strip. Both rows read the same `resolveSessionHistoryDurationMs(message)`,
     so keeping it here too would print the same "Worked for 12s" twice, a few
     rows apart. The header falls back to its existing no-duration copy. */
  const effectiveDurationMs = isMobile ? null : durationMs;
  const durationLabel =
    effectiveDurationMs === null
      ? ''
      : formatDurationCompact(effectiveDurationMs, durationUnitLabels);
  const label = durationLabel
    ? t('sessions.workedFor', {
        duration: durationLabel,
        defaultValue: 'Worked for {{duration}}',
      })
    : t('sessions.finishedWorking', 'Finished working');

  return (
    <button
      type="button"
      className={cn(
        'group flex w-full items-center gap-1 rounded-md py-0.5 text-left transition-colors',
        /* Quieter than the answer body so process chrome does not compete. */
        'text-muted-foreground hover:bg-hover/40 hover:text-foreground',
        /* No leading pad: this chevron shares the turn's left rail with
           `ActivityGroupHeader` and the answer prose. */
        'sm:gap-1.5 sm:pr-1'
      )}
      onClick={() => onExpandedChange(!expanded)}
      aria-expanded={expanded}
    >
      <ChevronRight
        className={cn(
          'h-3.5 w-3.5 flex-none shrink-0 text-muted-foreground transition-transform duration-200',
          expanded && 'rotate-90'
        )}
      />
      <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-tight tracking-tight">
        {label}
      </span>
    </button>
  );
};

/** Icon + body shell shared by thought / tool steps in a process group. */
function ActivityProcessStep({
  icon,
  children,
  className,
}: {
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        /* No horizontal shell pad: a step inside an expanded region starts on
           the rail, like the group header above it. */
        'flex w-full min-h-7 items-start gap-1.5 py-1',
        ACTIVITY_PROCESS_TEXT_CLASS,
        className
      )}
    >
      <span className="inline-flex shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const AssistantToolCallVirtualRow = memo(
  function AssistantToolCallVirtualRow({
    sessionId,
    messageId,
    entry,
    onFilePathClick,
    fontSize,
  }: {
    sessionId: SessionId;
    messageId: string;
    entry: AssistantToolCallRenderItem;
    onFilePathClick?: (filePath: string) => void;
    fontSize: ConversationFontSize;
  }) {
    const cachedExpanded = getExpandState(messageId).expandedByIndex[entry.itemIndex];
    const [expanded, setExpandedState] = useState(cachedExpanded ?? false);
    const setExpanded = useCallback(
      (next: boolean) => {
        setExpandedState(next);
        const cached = getExpandState(messageId);
        setExpandState(messageId, {
          ...cached,
          expandedByIndex: {
            ...cached.expandedByIndex,
            [entry.itemIndex]: next,
          },
        });
      },
      [entry.itemIndex, messageId]
    );

    return (
      <ToolCallCard
        sessionId={sessionId}
        toolCall={entry.content}
        expanded={expanded}
        onExpandedChange={setExpanded}
        onFilePathClick={onFilePathClick}
        inlineOutput
        fontSize={fontSize}
      />
    );
  },
  // The streaming turn's layout is recomputed per delta, so `entry` wrappers are
  // fresh objects even for tool calls that did not change — but `entry.content`
  // is the parsed history item, whose identity loro-mirror preserves for
  // unchanged sub-trees. Comparing it keeps completed tool calls (and their
  // terminal-preview scans) out of the per-token render path.
  (prev, next) =>
    prev.sessionId === next.sessionId &&
    prev.messageId === next.messageId &&
    prev.entry.content === next.entry.content &&
    prev.entry.itemIndex === next.entry.itemIndex &&
    prev.onFilePathClick === next.onFilePathClick &&
    prev.fontSize === next.fontSize
);

const AssistantSubagentTasksRow = ({ message }: { message: SessionHistoryParsed }) => {
  const tasks = useMemo(() => collectSubagentTasks(message.items), [message.items]);
  return <SubagentTaskPanel tasks={tasks} />;
};

/**
 * Does this top-level block paint a surface (card, attachment, plan) rather than
 * flow as prose? Surfaces are separate objects and take `cardSiblingGap`; prose
 * takes the tighter `turnSiblingGap` because its leading already separates it.
 */
const CARD_CONTENT_TYPES = new Set<MessageContent['type']>([
  'tool_call',
  'proposed_plan',
  'plan',
  'image',
  'image_group',
  'file',
]);

const isCardContentBlock = (block: AssistantTurnRenderBlock): boolean =>
  block.kind === 'content' && CARD_CONTENT_TYPES.has(block.entry.content.type);

const isAssistantToolCallActivityEntry = (
  entry: AssistantActivityRenderItem
): entry is AssistantToolCallRenderItem => entry.content.type === 'tool_call';

// All props are primitives, so plain memo() keeps finished thoughts inside a
// still-streaming turn from re-rendering on every delta.
const AssistantThoughtVirtualRow = memo(function AssistantThoughtVirtualRow({
  messageId,
  itemIndex,
  text,
  showLabel: _showLabel,
  isThinking,
  isStreaming,
  fontSize,
}: {
  messageId: string;
  itemIndex: number;
  text: string;
  showLabel: boolean;
  isThinking: boolean;
  isStreaming: boolean;
  fontSize: ConversationFontSize;
}) {
  const { t } = useTranslation();
  /* Match tool-step layout: leading icon + body. Group header already
     says "Thought", so we don't stack a second "思考过程" label. */
  return (
    <ActivityProcessStep
      icon={
        <Sparkles
          className={ACTIVITY_STEP_ICON_CLASS}
          aria-label={
            isThinking
              ? t('sessions.toolActivity.thinking', 'Thinking…')
              : t('sessions.toolActivity.thought', 'Thought')
          }
        />
      }
    >
      <MarkdownRenderer
        text={text}
        size={fontSize}
        className={ACTIVITY_STEP_BODY_CLASS}
        isStreaming={isStreaming}
        searchBlockId={getThoughtSearchBlockId(messageId, itemIndex)}
      />
    </ActivityProcessStep>
  );
});

/**
 * Width reserved before the mobile assistant-turn action buttons, so the copy
 * button always clears the session drawer's left-edge back-swipe strip
 * (`EDGE_ZONE_PX` in `../mobile/mobile-edge-back-swipe`). The turn duration
 * renders inside it; the reserved width is what makes the guarantee hold even
 * when the duration is unknown.
 *
 * Kept as a local number rather than importing `EDGE_ZONE_PX`, which would pull
 * the gesture module into the conversation renderer's import graph.
 * `tests/assistant-turn-action-inset.test.ts` asserts the two stay in sync.
 */
export const MOBILE_TURN_ACTION_LEADING_INSET_PX = 48;

const AssistantForkButton = ({
  turnId,
  isForking,
  worktreeAvailability,
  onFork,
  onWorktreeMenuOpen,
}: {
  turnId: string;
  isForking?: boolean;
  worktreeAvailability: SessionForkWorktreeAvailability;
  onFork: (turnId: string, destination?: SessionForkDestination) => void;
  onWorktreeMenuOpen?: () => void;
}) => {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const offerWorktree = worktreeAvailability !== 'hidden';
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:bg-hover hover:text-foreground"
      onClick={offerWorktree ? undefined : () => onFork(turnId, 'shared')}
      disabled={isForking}
      aria-label={t('sessions.forkSession', 'Fork session')}
    >
      {isForking ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <GitFork className="h-3.5 w-3.5" />
      )}
    </Button>
  );

  if (!offerWorktree) {
    return (
      <TooltipProvider>
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{t('sessions.forkSession', 'Fork session')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <SessionForkDestinationPopover
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (open) onWorktreeMenuOpen?.();
      }}
      worktreeAvailability={worktreeAvailability}
      disabled={isForking}
      onSelect={(destination) => onFork(turnId, destination)}
    >
      {button}
    </SessionForkDestinationPopover>
  );
};

const AssistantTurnFooter = ({
  message,
  sessionId,
  fileDiffOverride,
  assistantActions,
  onFileDiffClick,
  showDuration,
  isTurnHovered,
  onFork,
  forkWorktreeAvailability = 'hidden',
  onForkWorktreeMenuOpen,
  isForking,
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
  fileDiffOverride?: readonly AssistantEditedFileEntry[];
  assistantActions?: AssistantMessageAction[];
  onFileDiffClick?: (turnId: string, filePath: string) => void;
  showDuration: boolean;
  isTurnHovered: boolean;
  onFork?: (turnId: string, destination?: SessionForkDestination) => void;
  forkWorktreeAvailability?: SessionForkWorktreeAvailability;
  onForkWorktreeMenuOpen?: () => void;
  isForking?: boolean;
}) => {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const [didCopy, setDidCopy] = useState(false);
  const textContent = useMemo(() => {
    const contentItems = buildAssistantMessageRenderItems(message.items).map(
      (entry) => entry.content
    );
    return getVisibleAssistantTextContent(contentItems, message.finished === true);
  }, [message.finished, message.items]);
  const hasCopyableText = textContent.trim().length > 0;
  const fileDiffs = fileDiffOverride ?? message.fileDiff ?? EMPTY_EDITED_FILE_ENTRIES;
  const durationUnitLabels: DurationUnitLabels = {
    hour: t('time.unitShort.hour', 'h'),
    minute: t('time.unitShort.minute', 'm'),
    second: t('time.unitShort.second', 's'),
  };
  const durationMs = resolveSessionHistoryDurationMs(message);
  const durationLabel =
    durationMs === null ? '' : formatDurationCompact(durationMs, durationUnitLabels);
  const showFinishedMetadata = message.finished === true;
  /* Mobile: no completion timestamp — model meta + Worked-for already carry
     enough chrome; the stamp only adds a second clock under the answer. */
  const completionTimestampLabel = isMobile
    ? ''
    : formatConversationTimestamp(message.endedAt, {
        locale: toIntlLocale(i18n.resolvedLanguage ?? i18n.language),
      });
  const hasTurnConfigInfo = hasAssistantTurnConfigInfo(message);
  /* Mobile shows the duration here for EVERY finished turn, ignoring
     `showDuration`: `WorkedGroupHeader` drops it on mobile (it would otherwise
     print the identical `resolveSessionHistoryDurationMs` value twice per turn),
     so this footer is the single place the turn duration appears. */
  const mobileDurationLabel =
    isMobile && durationLabel
      ? t('sessions.workedFor', {
          duration: durationLabel,
          defaultValue: 'Worked for {{duration}}',
        })
      : '';
  const hasActionBarContent =
    hasCopyableText ||
    completionTimestampLabel.length > 0 ||
    (durationLabel.length > 0 && (isMobile || showDuration)) ||
    hasTurnConfigInfo;
  const showActionBar = hasActionBarContent || onFork !== undefined;

  const handleCopy = useCallback(async () => {
    if (!hasCopyableText) return;
    const ok = await writeTextToClipboard(textContent);
    if (!ok) return;
    setDidCopy(true);
    window.setTimeout(() => setDidCopy(false), 1200);
  }, [hasCopyableText, textContent]);

  return (
    <div className="flex flex-col gap-1">
      {showFinishedMetadata && fileDiffs.length > 0 ? (
        <AssistantEditedFiles
          files={fileDiffs}
          /* Mobile: quieter surface so the file card does not outrank the answer. */
          className={cn(
            /* The footer ROW is `pt-0` (see `verticalClass`) because a text-only
               action bar can ride on the answer's line leading. This is a
               bordered card, not text, so it needs its own separation: without
               it the card border lands flush against the answer's last line box
               (measured 0px, and since the card shares the text's left edge it
               read as part of the paragraph). 8px puts the visible gap at ~10px,
               matching the block rhythm of the rest of the turn. */
            'pt-2',
            isMobile && '[&>div]:rounded-lg [&>div]:border-border/40 [&>div]:bg-muted/10'
          )}
          onFileClick={
            onFileDiffClick ? (filePath) => onFileDiffClick(message.id, filePath) : undefined
          }
        />
      ) : null}
      {showFinishedMetadata && showActionBar ? (
        <div
          className={cn(
            'flex flex-wrap items-center justify-start text-[11px] text-muted-foreground',
            isMobile ? 'min-h-6 gap-1' : 'min-h-7 gap-2',
            !isMobile && 'opacity-0 transition-opacity duration-150 focus-within:opacity-100',
            !isMobile && isTurnHovered && 'opacity-100'
          )}
          data-assistant-turn-actions
        >
          {/* Mobile leads with the turn duration, and that is load-bearing: the
             native session drawer owns a left-edge back-swipe strip, and no row
             inside the conversation `VList` can paint above it (virtua sets
             `contain: strict`, so the list is its own stacking context and the
             composer's `z-40` trick does not reach here). A leading copy button
             lands inside that strip and is all but untappable, so this label is
             what pushes the cluster clear of it. The reserved min-width holds
             even when the duration is unknown and the text is empty.
             Desktop keeps the duration AFTER the buttons (see below). */}
          {isMobile ? (
            <span
              className="shrink-0 tabular-nums"
              style={{ minWidth: MOBILE_TURN_ACTION_LEADING_INSET_PX }}
            >
              {mobileDurationLabel}
            </span>
          ) : null}
          {/* Icon buttons are 28px boxes around 14px glyphs, so their own 7px of
             interior padding would push the glyph 7px inside the answer text
             above. Pull the cluster back by that padding so the outermost glyph
             sits on the text's edge (and the inner one keeps the row gap to the
             timestamp). Keep it on the cluster, not the row: when no buttons
             render, the timestamp must stay on the plain gutter. Mobile pulls
             only the trailing edge — its leading glyph aligns to the duration
             label, not to the answer text. */}
          {hasCopyableText || hasTurnConfigInfo || onFork ? (
            <div className={cn('flex items-center gap-0.5', isMobile ? '-mr-[7px]' : '-mx-[7px]')}>
              {hasCopyableText ? (
                <TooltipProvider>
                  <Tooltip delayDuration={500}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:bg-hover hover:text-foreground"
                        onClick={() => {
                          void handleCopy();
                        }}
                        aria-label={t('sessions.copyResponse', 'Copy response')}
                      >
                        {didCopy ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {didCopy
                        ? t('common.copied', 'Copied')
                        : t('sessions.copyResponse', 'Copy response')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
              {/* The turn config lives below the output on every layout. */}
              {hasTurnConfigInfo ? (
                <AssistantTurnConfigInfoButton
                  message={message}
                  sessionId={sessionId}
                  className="h-7 w-7"
                />
              ) : null}
              {onFork ? (
                <AssistantForkButton
                  turnId={message.id}
                  isForking={isForking}
                  worktreeAvailability={forkWorktreeAvailability}
                  onFork={onFork}
                  onWorktreeMenuOpen={onForkWorktreeMenuOpen}
                />
              ) : null}
            </div>
          ) : null}
          {completionTimestampLabel ? (
            <span className="tabular-nums">{completionTimestampLabel}</span>
          ) : null}
          {!isMobile && showDuration && durationLabel ? (
            <>
              {completionTimestampLabel ? <span aria-hidden="true">·</span> : null}
              <span className="font-mono tabular-nums">{durationLabel}</span>
            </>
          ) : null}
        </div>
      ) : null}
      {(assistantActions?.length ?? 0) > 0 ? (
        <div className="flex flex-wrap gap-2 px-2">
          {assistantActions?.map((action) => {
            const Icon = action.icon;
            const isAccent = action.tone === 'accent';
            return (
              <Button
                key={action.id}
                type="button"
                variant={isAccent ? 'default' : 'outline'}
                size="sm"
                className={cn(
                  'h-8 gap-1.5 rounded-md px-3 text-xs font-medium transition-colors',
                  isAccent
                    ? 'border border-primary/40 bg-primary/[0.12] text-primary shadow-xs hover:bg-primary/[0.18] hover:text-primary disabled:opacity-60'
                    : 'border-border/60 bg-background/60 text-foreground/85 shadow-none hover:bg-muted/55 hover:text-foreground'
                )}
                onClick={action.onClick}
                disabled={action.disabled}
              >
                {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
                {action.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

const AssistantPlanVirtualRow = ({
  messageId,
  entries,
}: {
  messageId: string;
  entries: PlanEntryItem[];
}) => {
  const [open, setOpenState] = useState(getExpandState(messageId).planOpen);
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      setExpandState(messageId, { ...getExpandState(messageId), planOpen: next });
    },
    [messageId]
  );
  return <SessionPlanBar entries={entries} open={open} onOpenChange={setOpen} />;
};

interface AssistantChatItemProps {
  row: AssistantChatVirtualRow;
  fileDiffOverride?: readonly AssistantEditedFileEntry[];
  assistantActions?: AssistantMessageAction[];
  onFork?: (turnId: string, destination?: SessionForkDestination) => void;
  forkWorktreeAvailability?: SessionForkWorktreeAvailability;
  onForkWorktreeMenuOpen?: () => void;
  isForking?: boolean;
  onFileDiffClick?: (turnId: string, filePath: string) => void;
  onFilePathClick?: (filePath: string) => void;
  onGroupExpandedChange: (messageId: string, groupKey: string, expanded: boolean) => void;
  onWorkedGroupExpandedChange: (messageId: string, segmentKey: string, expanded: boolean) => void;
  isTurnHovered: boolean;
  onTurnHoverChange: (messageId: string, hovered: boolean) => void;
  conversationFontSize: ConversationFontSize;
}

// Rows for unchanged turns are reference-stable via `assistantTurnRowsCache`,
// but a global rebuild (expansion toggle, search change, new turn) re-allocates
// them. The `block`/`entry` refs inside still come from `assistantTurnLayoutCache`
// keyed on the (unchanged) message, so comparing those refs plus the scalar
// flags is exact — never compare `content` objects themselves by identity here.
const areAssistantVirtualContentsEqual = (
  a: AssistantVirtualContent,
  b: AssistantVirtualContent
): boolean => {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'plan':
    case 'subagent_tasks':
      return true;
    case 'worked_group_header':
      return (
        b.kind === 'worked_group_header' &&
        a.segmentKey === b.segmentKey &&
        a.expanded === b.expanded &&
        a.durationMs === b.durationMs
      );
    case 'content':
      return b.kind === 'content' && a.block === b.block;
    case 'activity_group_header':
      return (
        b.kind === 'activity_group_header' &&
        a.block === b.block &&
        a.expanded === b.expanded &&
        a.isThinking === b.isThinking
      );
    case 'activity_detail':
      return (
        b.kind === 'activity_detail' &&
        a.entry === b.entry &&
        a.groupKey === b.groupKey &&
        a.showThoughtLabel === b.showThoughtLabel &&
        a.isThinking === b.isThinking
      );
    case 'footer':
      return b.kind === 'footer' && a.showDuration === b.showDuration;
    default:
      return false;
  }
};

const areAssistantChatVirtualRowsEqual = (
  a: AssistantChatVirtualRow,
  b: AssistantChatVirtualRow
): boolean =>
  a === b ||
  (a.item === b.item &&
    a.key === b.key &&
    a.messageIndex === b.messageIndex &&
    a.itemIndex === b.itemIndex &&
    a.isWorkedDetail === b.isWorkedDetail &&
    a.isLastRowForMessage === b.isLastRowForMessage &&
    areAssistantVirtualContentsEqual(a.content, b.content));

const areAssistantChatItemPropsEqual = (
  prev: AssistantChatItemProps,
  next: AssistantChatItemProps
): boolean =>
  areAssistantChatVirtualRowsEqual(prev.row, next.row) &&
  prev.fileDiffOverride === next.fileDiffOverride &&
  prev.assistantActions === next.assistantActions &&
  prev.onFileDiffClick === next.onFileDiffClick &&
  prev.onFilePathClick === next.onFilePathClick &&
  prev.onGroupExpandedChange === next.onGroupExpandedChange &&
  prev.onWorkedGroupExpandedChange === next.onWorkedGroupExpandedChange &&
  prev.onFork === next.onFork &&
  prev.forkWorktreeAvailability === next.forkWorktreeAvailability &&
  prev.onForkWorktreeMenuOpen === next.onForkWorktreeMenuOpen &&
  prev.isForking === next.isForking &&
  prev.isTurnHovered === next.isTurnHovered &&
  prev.onTurnHoverChange === next.onTurnHoverChange &&
  prev.conversationFontSize === next.conversationFontSize;

const AssistantChatItem = memo(function AssistantChatItem({
  row,
  fileDiffOverride,
  assistantActions,
  onFork,
  forkWorktreeAvailability,
  onForkWorktreeMenuOpen,
  isForking,
  onFileDiffClick,
  onFilePathClick,
  onGroupExpandedChange,
  onWorkedGroupExpandedChange,
  isTurnHovered,
  onTurnHoverChange,
  conversationFontSize,
}: AssistantChatItemProps) {
  const message = row.item.message;
  const { content } = row;
  const handleMouseLeave = (event: ReactMouseEvent<HTMLDivElement>) => {
    const nextTurn =
      event.relatedTarget instanceof Element
        ? event.relatedTarget
            .closest('[data-assistant-turn-id]')
            ?.getAttribute('data-assistant-turn-id')
        : null;
    if (nextTurn !== message.id) onTurnHoverChange(message.id, false);
  };

  const hasWideContent =
    content.kind === 'activity_detail' &&
    content.entry.content.type === 'tool_call' &&
    content.entry.content.content?.some((block) => block.type === 'diff');
  const isWorkedDetail = row.isWorkedDetail === true;
  const rowBody = (() => {
    switch (content.kind) {
      case 'plan':
        return message.plan ? (
          <AssistantPlanVirtualRow messageId={message.id} entries={message.plan} />
        ) : null;
      case 'worked_group_header':
        return (
          <WorkedGroupHeader
            durationMs={content.durationMs}
            expanded={content.expanded}
            onExpandedChange={(expanded) =>
              onWorkedGroupExpandedChange(message.id, content.segmentKey, expanded)
            }
          />
        );
      case 'content': {
        const { entry } = content.block;
        return renderAssistantContent(entry.content, row.item.sessionId, {
          messageId: message.id,
          itemIndex: entry.itemIndex,
          isStreaming: message.finished !== true,
          onFilePathClick,
          conversationFontSize,
          planAwaitingDecision: hasUnansweredPlanApproval(message.items),
          planRenderedSeparately: hasSeparatePlanItem(message.items),
        });
      }
      case 'activity_group_header':
        return (
          <ActivityGroupHeader
            summary={content.block.summary}
            expanded={content.expanded}
            isThinking={content.isThinking}
            onExpandedChange={(expanded) =>
              onGroupExpandedChange(message.id, content.block.key, expanded)
            }
          />
        );
      case 'activity_detail': {
        const { entry } = content;
        /* No indent: expanding a region must not shift its contents off the
           rail. The disclosure chevron and the group header carry the
           hierarchy — see `cardSiblingGap` above and `ai-gui/AGENTS.md`. */
        return isAssistantToolCallActivityEntry(entry) ? (
          <AssistantToolCallVirtualRow
            sessionId={row.item.sessionId}
            messageId={message.id}
            entry={entry}
            onFilePathClick={onFilePathClick}
            fontSize={conversationFontSize}
          />
        ) : (
          <AssistantThoughtVirtualRow
            messageId={message.id}
            itemIndex={entry.itemIndex}
            text={entry.content.text}
            showLabel={content.showThoughtLabel}
            isThinking={content.isThinking}
            isStreaming={message.finished !== true}
            fontSize={conversationFontSize}
          />
        );
      }
      case 'subagent_tasks':
        return <AssistantSubagentTasksRow message={message} />;
      case 'footer':
        return (
          <AssistantTurnFooter
            message={message}
            sessionId={row.item.sessionId}
            fileDiffOverride={fileDiffOverride}
            assistantActions={assistantActions}
            onFileDiffClick={onFileDiffClick}
            showDuration={content.showDuration}
            isTurnHovered={isTurnHovered}
            onFork={onFork}
            forkWorktreeAvailability={forkWorktreeAvailability}
            onForkWorktreeMenuOpen={onForkWorktreeMenuOpen}
            isForking={isForking}
          />
        );
      default:
        return null;
    }
  })();

  /* Hierarchy (L1 worked → L2 step → L3 detail → L4 result).
     Shared gap for process/answer siblings; footer sits tighter under the
     answer so edited-files is not double-spaced by line-height + pt-1. */
  const turnSiblingGap = 'pt-1 pb-0';
  const processSiblingGap = 'pt-0.5 pb-0.5';
  /* A row that paints a surface needs a real gap, not the prose gap. `pt-1`
     left cards 4-8px apart while their own padding was 10-12px, so the space
     BETWEEN objects read tighter than the space inside one and the turn
     collapsed into a stack of bordered strips. Prose keeps `pt-1`: its line
     leading already supplies the separation. */
  const cardSiblingGap = 'pt-3 pb-0';
  const verticalClass = (() => {
    if (isWorkedDetail) {
      return processSiblingGap;
    }
    switch (content.kind) {
      case 'content':
        return isCardContentBlock(content.block) ? cardSiblingGap : turnSiblingGap;
      case 'plan':
        return cardSiblingGap;
      case 'worked_group_header':
      case 'activity_group_header':
      case 'subagent_tasks':
        return turnSiblingGap;
      case 'footer':
        /* No top pad: answer markdown already has leading below the last line.
           A full turnSiblingGap here reads as a large empty band. This holds
           only for the footer's TEXT chrome (the action bar); the edited-files
           card is a bordered surface and carries its own `pt-2` in
           `AssistantTurnFooter` — do not move that pad up here, it would
           re-open the empty band whenever the turn edited no files. */
        return 'pt-0 pb-0';
      case 'activity_detail':
        return 'pt-0 pb-0';
      default:
        return turnSiblingGap;
    }
  })();

  const isFinalAnswer = content.kind === 'content' && !isWorkedDetail;
  const isProcessCluster =
    isWorkedDetail ||
    content.kind === 'worked_group_header' ||
    content.kind === 'activity_group_header' ||
    content.kind === 'activity_detail';

  return (
    <ConversationColumn
      className={cn(
        /* Horizontal gutter is CONVERSATION_GUTTER_X_CLASS on the column
           (shared with composer / header). Never set margin-left here. */
        verticalClass,
        row.isLastRowForMessage && 'pb-2 sm:pb-3'
      )}
      data-assistant-turn-id={message.id}
      onMouseEnter={() => onTurnHoverChange(message.id, true)}
      onMouseLeave={handleMouseLeave}
    >
      <div className={cn('w-full', hasWideContent && 'scrollbar-pro overflow-x-auto')}>
        <div
          className={cn(
            'max-w-[800px] break-words',
            /* A folded region's contents stay on the rail: expanding "Worked
               for 12s" must reveal rows, not shift them right. Tone below is
               what separates process from answer. */
            /* L4 result: full contrast. Process: muted so answer pops. */
            isFinalAnswer || content.kind === 'footer'
              ? 'text-foreground'
              : isProcessCluster
                ? 'text-muted-foreground'
                : 'text-foreground',
            hasWideContent && 'min-w-[480px]'
          )}
          style={conversationTextFontSizeStyle(conversationFontSize)}
          data-native-selection-allow
        >
          {rowBody}
        </div>
      </div>
    </ConversationColumn>
  );
}, areAssistantChatItemPropsEqual);

const UserChatBubble = ({
  message,
  sessionId,
  conversationFontSize,
  /**
   * `attachments` drops the text bubble and keeps only images/files. Editing the
   * message replaces the text in place but resends the other blocks untouched,
   * so they must stay visible above the editor instead of silently disappearing.
   */
  variant = 'full',
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
  conversationFontSize: ConversationFontSize;
  variant?: 'full' | 'attachments';
}) => {
  if (!message.items.length) {
    return variant === 'attachments' ? null : (
      <span className="text-xs text-muted-foreground">No Message</span>
    );
  }

  type UserImageGroup = {
    kind: 'images';
    images: Array<{ entry: SessionImageGalleryEntry; itemIndex: number }>;
    key: string;
  };
  type UserRenderGroup =
    | { kind: 'files'; files: SessionFilePayload[]; key: string }
    | UserImageGroup
    | { kind: 'other'; content: MessageContent; itemIndex: number; key: string };

  // Attachments are shown above the typed prompt, matching native chat UIs and
  // keeping file/image previews out of the text bubble.
  const attachmentGroups: UserRenderGroup[] = [];
  const textGroups: UserRenderGroup[] = [];
  for (let itemIndex = 0; itemIndex < message.items.length; itemIndex += 1) {
    const content = message.items[itemIndex];
    if (!content) continue;

    if (content.type === 'text') {
      textGroups.push({ kind: 'other', content, itemIndex, key: `text-${itemIndex}` });
      continue;
    }

    if (content.type === 'file') {
      const last = attachmentGroups[attachmentGroups.length - 1];
      if (last && last.kind === 'files') {
        last.files.push(content);
      } else {
        attachmentGroups.push({ kind: 'files', files: [content], key: `files-${itemIndex}` });
      }
      continue;
    }

    if (content.type === 'image') {
      const entry = createSessionImageGalleryEntry({
        sessionId,
        messageId: message.id,
        itemIndex,
        imageIndex: 0,
        image: content,
      });
      const last = attachmentGroups[attachmentGroups.length - 1];
      if (last && last.kind === 'images') {
        last.images.push({ entry, itemIndex });
      } else {
        attachmentGroups.push({
          kind: 'images',
          images: [{ entry, itemIndex }],
          key: `images-${itemIndex}`,
        });
      }
      continue;
    }

    attachmentGroups.push({
      kind: 'other',
      content,
      itemIndex,
      key: `${content.type}-${itemIndex}`,
    });
  }

  const renderGroup = (group: UserRenderGroup) => {
    if (group.kind === 'files') {
      return (
        <SessionFileGroup key={group.key} files={group.files} sessionId={sessionId} align="end" />
      );
    }
    if (group.kind === 'images') {
      const hasSingleImage = group.images.length === 1;
      return (
        <div key={group.key} className="flex w-full justify-end px-2 pt-1">
          {hasSingleImage ? (
            <UserImageBlock entry={group.images[0]!.entry} variant="full" />
          ) : (
            <div className="grid max-w-[32rem] grid-cols-2 gap-2">
              {group.images.map(({ entry }, index) => (
                <div key={`image-${entry.imageId}-${index}`} className="shrink-0">
                  <UserImageBlock entry={entry} variant="thumbnail" thumbnailSize="large" />
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
    return (
      <Fragment key={group.key}>
        {renderUserContent(group.content, sessionId, {
          messageId: message.id,
          itemIndex: group.itemIndex,
          conversationFontSize,
          thumbnailSize: 'large',
        })}
      </Fragment>
    );
  };

  if (variant === 'attachments') {
    if (attachmentGroups.length === 0) return null;
    return (
      <div className="flex min-w-0 max-w-full flex-col items-end gap-2" data-native-selection-allow>
        {attachmentGroups.map(renderGroup)}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 max-w-full flex-col items-end gap-2" data-native-selection-allow>
      {attachmentGroups.map(renderGroup)}
      {textGroups.map(renderGroup)}
    </div>
  );
};

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;
type ToolCallContentBlock = NonNullable<ToolCallMessage['content']>[number];
type StandardToolContent = Extract<ToolCallContentBlock, { type: 'content' }>['content'];
type PlanEntryItem = Extract<MessageContent, { type: 'plan' }>['entries'][number];
type ProposedPlanMessage = Extract<MessageContent, { type: 'proposed_plan' }>;
type GoalMessage = Extract<MessageContent, { type: 'goal' }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const writeTextToClipboard = async (text: string): Promise<boolean> => {
  if (!text.trim()) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.top = '0';
      el.style.left = '0';
      el.style.width = '1px';
      el.style.height = '1px';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.focus();
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
};

const formatJsonValue = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const renderAssistantContent = (
  content: MessageContent,
  sessionId: SessionId,
  options?: {
    messageId: string;
    itemIndex: number;
    isStreaming?: boolean;
    onFilePathClick?: (filePath: string) => void;
    conversationFontSize?: ConversationFontSize;
    /** This turn's plan approval is still unanswered — see `PlanPanel`. */
    planAwaitingDecision?: boolean;
    /** This turn renders the plan as its own row, so the card must not repeat it. */
    planRenderedSeparately?: boolean;
  }
) => {
  const messageId = options?.messageId ?? 'assistant';
  const itemIndex = options?.itemIndex ?? 0;
  const conversationFontSize = options?.conversationFontSize ?? DEFAULT_CONVERSATION_FONT_SIZE;

  switch (content.type) {
    case 'text':
      return (
        <MarkdownBlock
          text={content.text}
          size={conversationFontSize}
          isStreaming={options?.isStreaming}
          onFilePathClick={options?.onFilePathClick}
          searchBlockId={getTextSearchBlockId(messageId, itemIndex)}
        />
      );
    case 'image':
      return (
        <div className="flex w-full">
          <UserImageBlock
            entry={createSessionImageGalleryEntry({
              sessionId,
              messageId: options?.messageId ?? 'assistant-image',
              itemIndex: options?.itemIndex ?? 0,
              imageIndex: 0,
              image: content,
            })}
          />
        </div>
      );
    case 'image_group':
      return (
        <ImageGroupBubble
          content={content}
          sessionId={sessionId}
          messageId={options?.messageId ?? 'assistant-image-group'}
          itemIndex={options?.itemIndex ?? 0}
          align="start"
        />
      );
    case 'file':
      return <SessionFileGroup files={[content]} sessionId={sessionId} align="start" />;
    case 'thought':
      return (
        <ThoughtCard
          text={content.text}
          fontSize={conversationFontSize}
          isStreaming={options?.isStreaming}
          searchBlockId={getThoughtSearchBlockId(messageId, itemIndex)}
        />
      );
    case 'plan':
      return <PlanBlock entries={content.entries} fontSize={conversationFontSize} />;
    case 'proposed_plan':
      return (
        <ProposedPlanBlock
          plan={content}
          messageId={messageId}
          itemIndex={itemIndex}
          onFilePathClick={options?.onFilePathClick}
          fontSize={conversationFontSize}
          awaitingDecision={options?.planAwaitingDecision}
        />
      );
    case 'goal':
      return <GoalBlock goal={content} />;
    case 'tool_call':
      /* The plan-approval card has no title of its own to show: the plan is
         right above it (Codex's `proposed_plan`, moved next to its approval) or
         inside it (Claude's `content`), and "Implement this plan?" directly over
         "Yes, implement this plan" asked and answered the same question twice.
         What is left is the decision. */
      return content.kind === 'switch_mode' ? (
        <PlanExitBlock
          sessionId={sessionId}
          toolCall={content}
          onFilePathClick={options?.onFilePathClick}
          fontSize={conversationFontSize}
          messageId={messageId}
          itemIndex={itemIndex}
          awaitingDecision={options?.planAwaitingDecision}
          planRenderedSeparately={options?.planRenderedSeparately}
        />
      ) : (
        <ToolCallCard
          sessionId={sessionId}
          toolCall={content}
          onFilePathClick={options?.onFilePathClick}
          fontSize={conversationFontSize}
        />
      );
    case 'available_commands':
      return null;
    default:
      return null;
  }
};

const IMAGE_THUMBNAIL_SIZE = 192;
const IMAGE_ATTACHMENT_THUMBNAIL_SIZE = 320;
const IMAGE_INLINE_PREVIEW_MAX_WIDTH = 768;

export type ImageBubbleAlign = 'start' | 'end';
type ImageThumbnailSize = 'compact' | 'large';

/**
 * Hook to manage blob URLs for image gallery entries.
 * Loads original images for visible entries and pre-fetches adjacent ones.
 */
function useImageBlobUrls(
  entries: ReadonlyArray<SessionImageGalleryEntry>,
  activeIndex: number,
  open: boolean
) {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const authToken = useAtomValue(authTokenAtom);
  const [blobUrls, setBlobUrls] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!open) {
      setBlobUrls(new Map());
      return undefined;
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex === -1 || !workspaceId || !authToken) {
      return undefined;
    }

    const indicesToLoad = [activeIndex - 1, activeIndex, activeIndex + 1].filter(
      (i) => i >= 0 && i < entries.length
    );

    let active = true;
    indicesToLoad.forEach((i) => {
      const entry = entries[i];
      if (!entry) {
        return;
      }

      void getSessionImageBlobUrl({
        workspaceId,
        sessionId: entry.sessionId,
        imageId: entry.imageId,
        token: authToken,
        variant: 'original',
      })
        .then((url) => {
          if (!active) {
            return;
          }
          setBlobUrls((prev) => {
            if (prev.get(entry.key) === url) {
              return prev;
            }
            const next = new Map(prev);
            next.set(entry.key, url);
            return next;
          });
        })
        .catch(() => undefined);
    });

    return () => {
      active = false;
    };
  }, [activeIndex, authToken, entries, open, workspaceId]);

  return blobUrls;
}

const ImagePreviewDialog = ({
  open,
  onOpenChange,
  activeImageKey,
  onActiveImageKeyChange,
  entries,
  portalAnchorRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeImageKey: string | null;
  onActiveImageKeyChange: (imageKey: string | null) => void;
  entries: ReadonlyArray<SessionImageGalleryEntry>;
  portalAnchorRef?: ImagePreviewPortalAnchorRef;
}) => {
  const activeIndex = useMemo(
    () => findSessionImageGalleryEntryIndex(entries, activeImageKey),
    [activeImageKey, entries]
  );

  const blobUrls = useImageBlobUrls(entries, activeIndex, open);
  const images = useMemo(
    () =>
      entries.map((entry) => ({
        key: entry.key,
        src: blobUrls.get(entry.key),
        fileName: entry.fileName,
      })),
    [entries, blobUrls]
  );

  const handleIndexChange = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (entry) {
        onActiveImageKeyChange(entry.key);
      }
    },
    [entries, onActiveImageKeyChange]
  );

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <ZoomableImageViewer
      open={open}
      onClose={handleClose}
      images={images}
      index={activeIndex}
      onIndexChange={handleIndexChange}
      {...(portalAnchorRef ? { portalAnchorRef } : {})}
    />
  );
};

const UserImageBlock = ({
  entry,
  onPreviewRequest,
  variant = 'full',
  thumbnailSize = 'compact',
}: {
  entry: SessionImageGalleryEntry;
  onPreviewRequest?: (imageKey: string) => void;
  variant?: 'full' | 'thumbnail';
  thumbnailSize?: ImageThumbnailSize;
}) => {
  const { t } = useTranslation();
  const sessionImagePreview = useContext(SessionImagePreviewContext);
  const previewPortalAnchorRef = useRef<HTMLDivElement>(null);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const authToken = useAtomValue(authTokenAtom);
  const [thumbnailBlobUrl, setThumbnailBlobUrl] = useState<string | null>(null);
  const [thumbnailLoadingError, setThumbnailLoadingError] = useState<string | null>(null);
  const [isThumbnailLoading, setIsThumbnailLoading] = useState(true);
  const [localActiveImageKey, setLocalActiveImageKey] = useState<string | null>(null);
  const isThumbnail = variant === 'thumbnail';
  const isLargeThumbnail = isThumbnail && thumbnailSize === 'large';
  const thumbnailEdge = isLargeThumbnail ? IMAGE_ATTACHMENT_THUMBNAIL_SIZE : IMAGE_THUMBNAIL_SIZE;
  const thumbnailWidth = isThumbnail ? thumbnailEdge : IMAGE_INLINE_PREVIEW_MAX_WIDTH;
  const thumbnailHeight = isThumbnail ? thumbnailEdge : undefined;
  // iOS WKWebView shares `blob:` image URLs as text from the native long-press menu.
  const useNativeIOSShareSafeImageUrl = isNativeIOSAppShell();
  const fullFrameWidthClass = 'w-56 max-w-full sm:w-72 md:w-80';
  const thumbnailFrameClass = isLargeThumbnail ? 'h-36 w-36 sm:h-40 sm:w-40' : 'h-24 w-24';
  const previewImageAlt =
    entry.fileName || entry.alt || t('sessions.uploadedImage', 'Uploaded image');
  const imageLoadUnavailableLabel = t('sessions.imageLoadUnavailable', 'Unable to load image');
  const imageLoadFailedLabel = t('sessions.imageLoadFailed', 'Failed to load image');

  useEffect(() => {
    let active = true;

    setLocalActiveImageKey(null);

    if (!workspaceId || !authToken) {
      setThumbnailBlobUrl(null);
      setIsThumbnailLoading(false);
      setThumbnailLoadingError(imageLoadUnavailableLabel);
      return () => {
        active = false;
      };
    }

    setIsThumbnailLoading(true);
    setThumbnailLoadingError(null);

    const loadImageUrl = useNativeIOSShareSafeImageUrl
      ? getSessionImageDataUrl
      : getSessionImageBlobUrl;

    void loadImageUrl({
      workspaceId,
      sessionId: entry.sessionId,
      imageId: entry.imageId,
      token: authToken,
      variant: 'thumbnail',
      thumbnailWidth,
      thumbnailHeight,
      thumbnailFit: isThumbnail ? 'cover' : 'scale-down',
      thumbnailQuality: 85,
    })
      .then((url) => {
        if (!active) return;
        setThumbnailBlobUrl(url);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setThumbnailBlobUrl(null);
        setThumbnailLoadingError(error instanceof Error ? error.message : imageLoadFailedLabel);
      })
      .finally(() => {
        if (!active) return;
        setIsThumbnailLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    authToken,
    entry.imageId,
    entry.sessionId,
    imageLoadFailedLabel,
    imageLoadUnavailableLabel,
    isThumbnail,
    thumbnailHeight,
    thumbnailWidth,
    useNativeIOSShareSafeImageUrl,
    workspaceId,
  ]);

  return (
    <div
      ref={previewPortalAnchorRef}
      className={cn(
        /* 12px: the shared radius of every top-level conversation card (file
           card, proposed plan, permission record). An 8px frame beside them
           read as a different family of object. */
        'overflow-hidden rounded-xl border border-border/70 bg-muted/20',
        isThumbnail ? thumbnailFrameClass : 'inline-flex max-w-full flex-col'
      )}
    >
      {isThumbnailLoading && (
        <Skeleton
          className={cn(isThumbnail ? thumbnailFrameClass : `h-36 ${fullFrameWidthClass}`)}
        />
      )}
      {!isThumbnailLoading && thumbnailLoadingError && (
        <div
          className={cn(
            'flex items-center justify-center px-3 py-4 text-xs text-muted-foreground',
            isThumbnail ? `${thumbnailFrameClass} p-2 text-xs` : `min-h-24 ${fullFrameWidthClass}`
          )}
        >
          {thumbnailLoadingError}
        </div>
      )}
      {!isThumbnailLoading && !thumbnailLoadingError && thumbnailBlobUrl && (
        <>
          <button
            type="button"
            className={cn(isThumbnail ? `block ${thumbnailFrameClass}` : 'inline-flex max-w-full')}
            onClick={() => {
              if (onPreviewRequest) {
                onPreviewRequest(entry.key);
                return;
              }
              if (sessionImagePreview) {
                sessionImagePreview.openImagePreview(entry.key);
                return;
              }
              setLocalActiveImageKey(entry.key);
            }}
          >
            <img
              src={thumbnailBlobUrl}
              alt={previewImageAlt}
              className={cn(
                isThumbnail
                  ? `${thumbnailFrameClass} object-cover`
                  : 'block max-h-[10.5rem] max-w-full object-contain'
              )}
            />
          </button>
        </>
      )}
      {!sessionImagePreview && !onPreviewRequest ? (
        <ImagePreviewDialog
          open={localActiveImageKey !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setLocalActiveImageKey(null);
            }
          }}
          activeImageKey={localActiveImageKey}
          onActiveImageKeyChange={setLocalActiveImageKey}
          entries={[entry]}
          portalAnchorRef={previewPortalAnchorRef}
        />
      ) : null}
    </div>
  );
};

export const ImageGroupBubble = ({
  content,
  sessionId,
  messageId,
  itemIndex,
  align = 'start',
  thumbnailSize = 'compact',
}: {
  content: Extract<MessageContent, { type: 'image_group' }>;
  sessionId: SessionId;
  messageId: string;
  itemIndex: number;
  align?: ImageBubbleAlign;
  thumbnailSize?: ImageThumbnailSize;
}) => {
  const sessionImagePreview = useContext(SessionImagePreviewContext);
  const previewPortalAnchorRef = useRef<HTMLDivElement>(null);
  const [localActiveImageKey, setLocalActiveImageKey] = useState<string | null>(null);
  /* An assistant attachment (`align="start"`) is a top-level row on the turn's
     left rail: no horizontal pad (the gutter belongs to `ConversationColumn`)
     and no top pad (the row gap belongs to `cardSiblingGap`). The user's own
     attachments keep hugging the right edge exactly as they did. */
  const rowClass = align === 'end' ? 'justify-end px-2 pt-1' : 'justify-start';
  const gridMaxWidthClass = thumbnailSize === 'large' ? 'max-w-[32rem]' : 'max-w-[26rem]';
  const entries = useMemo(
    () =>
      content.images.map((image, imageIndex) =>
        createSessionImageGalleryEntry({
          sessionId,
          messageId,
          itemIndex,
          imageIndex,
          image,
        })
      ),
    [content.images, itemIndex, messageId, sessionId]
  );
  const handlePreviewRequest = useCallback(
    (imageKey: string) => {
      if (sessionImagePreview) {
        sessionImagePreview.openImagePreview(imageKey);
        return;
      }
      setLocalActiveImageKey(imageKey);
    },
    [sessionImagePreview]
  );

  if (entries.length === 1) {
    const entry = entries[0]!;

    return (
      <>
        <div ref={previewPortalAnchorRef} className={cn('flex w-full', rowClass)}>
          <UserImageBlock entry={entry} onPreviewRequest={handlePreviewRequest} variant="full" />
        </div>
        {!sessionImagePreview ? (
          <ImagePreviewDialog
            open={localActiveImageKey !== null}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) {
                setLocalActiveImageKey(null);
              }
            }}
            activeImageKey={localActiveImageKey}
            onActiveImageKeyChange={setLocalActiveImageKey}
            entries={entries}
            portalAnchorRef={previewPortalAnchorRef}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <div ref={previewPortalAnchorRef} className={cn('flex w-full', rowClass)}>
        <div className={cn('grid grid-cols-2 gap-2', gridMaxWidthClass)}>
          {entries.map((entry, index) => (
            <UserImageBlock
              key={`${entry.imageId}-${index}`}
              entry={entry}
              onPreviewRequest={handlePreviewRequest}
              variant="thumbnail"
              thumbnailSize={thumbnailSize}
            />
          ))}
        </div>
      </div>
      {!sessionImagePreview ? (
        <ImagePreviewDialog
          open={localActiveImageKey !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setLocalActiveImageKey(null);
            }
          }}
          activeImageKey={localActiveImageKey}
          onActiveImageKeyChange={setLocalActiveImageKey}
          entries={entries}
          portalAnchorRef={previewPortalAnchorRef}
        />
      ) : null}
    </>
  );
};

/**
 * Container for a run of adjacent `file` blocks. Owns the workspace/token
 * atoms, machine-name resolution, download, and the in-app preview dialog, then
 * renders the pure `SessionFileCard`s. Adjacent file blocks are aggregated into
 * one list (decision #3) at the call site; this component handles however many
 * it is handed.
 */
export const SessionFileGroup = ({
  files,
  sessionId,
  align = 'start',
}: {
  files: SessionFilePayload[];
  sessionId: SessionId;
  align?: 'start' | 'end';
}) => {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const authToken = useAtomValue(authTokenAtom);
  const { openHtmlFile } = useContext(SessionChatActionContext);
  const [previewFile, setPreviewFile] = useState<SessionFilePayload | null>(null);
  const [previewStatus, setPreviewStatus] = useState<SessionFilePreviewStatus>({ kind: 'loading' });
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const previewRequestRef = useRef<string | null>(null);

  const handleDownload = useCallback(
    (file: SessionFilePayload) => {
      if (!workspaceId || !authToken) return;
      setDownloadingId(file.fileId);
      void downloadSessionFile({
        workspaceId,
        sessionId: file.storageSessionId ?? sessionId,
        fileId: file.fileId,
        token: authToken,
        fileName: file.fileName,
        mimeType: file.mimeType,
      })
        .catch(() => {
          toast.error(t('sessions.fileDownloadFailed', { name: file.fileName }));
        })
        .finally(() => setDownloadingId((current) => (current === file.fileId ? null : current)));
    },
    [authToken, sessionId, t, workspaceId]
  );

  const handlePreview = useCallback(
    (file: SessionFilePayload) => {
      if (isHtmlSessionFile(file) && openHtmlFile?.(file)) {
        return;
      }
      setPreviewFile(file);
      setPreviewStatus({ kind: 'loading' });
      if (!workspaceId || !authToken) {
        setPreviewStatus({
          kind: 'error',
          message: t('sessions.filePreviewUnavailable', 'Preview unavailable'),
        });
        return;
      }
      // Stale-response guard: rapid open/close or switching files must not let
      // an earlier fetch overwrite the state of the latest request.
      previewRequestRef.current = file.fileId;
      void fetchSessionFilePreview({
        workspaceId,
        sessionId: file.storageSessionId ?? sessionId,
        fileId: file.fileId,
        token: authToken,
        sizeBytes: file.sizeBytes,
      })
        .then((result) => {
          if (previewRequestRef.current !== file.fileId) return;
          setPreviewStatus({
            kind: 'loaded',
            text: result.text,
            truncated: result.truncated,
          });
        })
        .catch(() => {
          if (previewRequestRef.current !== file.fileId) return;
          // 4xx / network → degrade to a downloadable error state.
          setPreviewStatus({
            kind: 'error',
            message: t('sessions.filePreviewFailed', 'Could not load preview'),
          });
        });
    },
    [authToken, openHtmlFile, sessionId, t, workspaceId]
  );

  // The send path caps at 8 files/message, but a block list synced from another
  // client isn't bound by that input-path check; cap the render so a malformed
  // message can't spawn an unbounded number of cards/download buttons.
  const visibleFiles = files.slice(0, SESSION_FILE_MAX_COUNT);
  const overflowCount = files.length - visibleFiles.length;

  return (
    <>
      <SessionFileCardList align={align}>
        {visibleFiles.map((file, index) => (
          <SessionFileBlockCard
            // sha256 is the stable identity: fileId is rewritten when a
            // local-transport block is backfilled to r2, which would otherwise
            // remount the card and drop in-flight download/preview state.
            key={`${file.sha256}-${index}`}
            file={file}
            onPreview={handlePreview}
            onDownload={handleDownload}
            isDownloading={downloadingId === file.fileId}
          />
        ))}
        {overflowCount > 0 ? (
          <span className="px-1 text-xs text-muted-foreground">
            {t('sessions.fileGroupOverflow', '+{{count}} more files', { count: overflowCount })}
          </span>
        ) : null}
      </SessionFileCardList>
      {previewFile ? (
        <SessionFilePreviewDialog
          open={previewFile !== null}
          onOpenChange={(open) => {
            if (!open) setPreviewFile(null);
          }}
          file={previewFile}
          status={previewStatus}
          onDownload={handleDownload}
          isDownloading={downloadingId === previewFile.fileId}
        />
      ) : null}
    </>
  );
};

/** One card, resolving the pending machine name when transport is local. */
const SessionFileBlockCard = ({
  file,
  onPreview,
  onDownload,
  isDownloading,
}: {
  file: SessionFilePayload;
  onPreview: (file: SessionFilePayload) => void;
  onDownload: (file: SessionFilePayload) => void;
  isDownloading: boolean;
}) => {
  const machineMeta = useAtomValue(
    getMachineMetaByIdAtomFamily(
      file.transport === 'local' ? (file.machineId as MachineId | undefined) : undefined
    )
  );
  return (
    <SessionFileCard
      file={file}
      pendingMachineName={machineMeta?.name ?? file.machineId}
      onPreview={onPreview}
      onDownload={onDownload}
      isDownloading={isDownloading}
    />
  );
};

const renderUserContent = (
  content: MessageContent,
  sessionId: SessionId,
  options: {
    messageId: string;
    itemIndex: number;
    conversationFontSize: ConversationFontSize;
    thumbnailSize?: ImageThumbnailSize;
  }
) => {
  switch (content.type) {
    case 'text':
      return (
        <UserPlainTextBlock
          text={content.text}
          spans={content.spans}
          fontSize={options.conversationFontSize}
          searchBlockId={getTextSearchBlockId(options.messageId, options.itemIndex)}
        />
      );
    case 'image':
      return (
        <div className="flex w-full justify-end px-2 pt-1">
          <UserImageBlock
            entry={createSessionImageGalleryEntry({
              sessionId,
              messageId: options.messageId,
              itemIndex: options.itemIndex,
              imageIndex: 0,
              image: content,
            })}
            thumbnailSize={options.thumbnailSize}
          />
        </div>
      );
    case 'image_group':
      return (
        <ImageGroupBubble
          content={content}
          sessionId={sessionId}
          messageId={options.messageId}
          itemIndex={options.itemIndex}
          align="end"
          thumbnailSize={options.thumbnailSize}
        />
      );
    case 'file':
      return <SessionFileGroup files={[content]} sessionId={sessionId} align="end" />;
    case 'thought':
      return (
        <ThoughtCard
          text={content.text}
          fontSize={options.conversationFontSize}
          searchBlockId={getThoughtSearchBlockId(options.messageId, options.itemIndex)}
        />
      );
    case 'plan':
      return <PlanBlock entries={content.entries} fontSize={options.conversationFontSize} />;
    case 'proposed_plan':
      return (
        <ProposedPlanBlock
          plan={content}
          messageId={options.messageId}
          itemIndex={options.itemIndex}
          fontSize={options.conversationFontSize}
        />
      );
    case 'goal':
      return <GoalBlock goal={content} />;
    case 'tool_call':
      return (
        <ToolCallCard
          sessionId={sessionId}
          toolCall={content}
          fontSize={options.conversationFontSize}
        />
      );
    case 'comment_reference':
      return (
        <div className="flex w-full justify-end px-2 pt-1">
          <CommentReferenceCard reference={content as CommentReferencePayload} />
        </div>
      );
    case 'visual_annotation_reference':
      return (
        <div className="flex w-full justify-end px-2 pt-1">
          <VisualAnnotationReferenceCard reference={content as VisualAnnotationReferencePayload} />
        </div>
      );
    case 'available_commands':
      return null;
    default:
      return null;
  }
};

const sanitizeToolTitle = (title: string) => normalizeWorktreeTitle(title).trim().replace(/`/g, '');

const extractFilePathFromTitle = (title: string, label: string) => {
  const sanitized = sanitizeToolTitle(title);
  const prefix = `${label} `;
  if (!sanitized.startsWith(prefix)) return null;
  const rest = sanitized.slice(prefix.length).trim();
  const rangeIndex = rest.indexOf(' (');
  const path = rangeIndex === -1 ? rest : rest.slice(0, rangeIndex);
  return path.trim() || null;
};

/** Action words that should be highlighted in tool titles */
const TOOL_ACTION_WORDS = ['Find', 'Search', 'Grep', 'Glob'];

/**
 * Renders a tool title with the action word (e.g., "Find", "Search") slightly brighter.
 * If no action word is found at the start, renders the title as-is.
 */
const ToolTitleWithHighlight = ({ title, className }: { title: string; className?: string }) => {
  for (const action of TOOL_ACTION_WORDS) {
    if (title.startsWith(action + ' ')) {
      const rest = title.slice(action.length);
      return (
        <span className={className} title={title}>
          <span className="text-foreground/90">{action}</span>
          {rest}
        </span>
      );
    }
  }
  return (
    <span className={className} title={title}>
      {title}
    </span>
  );
};

// Exported for idle-rerender tests: this is the live memo boundary for assistant
// markdown (used by `renderAssistantContent`), guarding both callback-identity
// stability (via `useStableCallback`) and non-reaction to unrelated state.
export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  size = DEFAULT_CONVERSATION_FONT_SIZE,
  isStreaming = false,
  onFilePathClick,
  searchBlockId,
}: {
  text: string;
  size?: ConversationFontSize;
  isStreaming?: boolean;
  onFilePathClick?: (filePath: string) => void;
  searchBlockId?: string;
}) {
  const handleAgentFileLinkClick = useStableCallback((href: string) => {
    onFilePathClick?.(href);
  });

  /* No horizontal pad and no wrapper: assistant prose shares the turn's left
     rail with the activity/worked chevrons, the subagent card, and the footer.
     See the "one left rail" note in AGENTS.md. */
  return (
    <MarkdownRenderer
      text={text}
      size={size}
      isStreaming={isStreaming}
      onAgentFileLinkClick={onFilePathClick ? handleAgentFileLinkClick : undefined}
      searchBlockId={searchBlockId}
    />
  );
});

const UserPlainTextBlock = ({
  text,
  spans,
  fontSize,
  searchBlockId,
}: {
  text: string;
  spans?: MessageTextSpan[];
  fontSize: ConversationFontSize;
  searchBlockId?: string;
}) => {
  const renderSlice = useMemo(() => getUserTextRenderSlice(text, spans), [spans, text]);
  const isLong = renderSlice.isTruncated;
  const [isExpanded, setIsExpanded] = useState(false);
  const [prevText, setPrevText] = useState(text);
  if (prevText !== text) {
    setPrevText(text);
    setIsExpanded(false);
  }
  const searchMatch = useSessionSearchBlock(searchBlockId ?? '');
  const isSearchActive = Boolean(searchMatch?.activeResultId);
  const isFullTextVisible = !isLong || isExpanded || isSearchActive;
  const renderedText = isFullTextVisible ? text : renderSlice.text;
  // The slice remaps its spans onto the text it produced; the full text keeps
  // the originals.
  const renderedSpans = isFullTextVisible ? spans : renderSlice.spans;

  return (
    <div className="flex max-w-full justify-end sm:pl-2">
      <div className="min-w-0 max-w-full rounded-[1.15rem] border border-foreground/[0.08] bg-foreground/[0.05] px-3.5 py-2 sm:rounded-2xl sm:px-4 sm:py-2.5">
        <div
          className={cn(
            // overflow-wrap:anywhere (not break-words) is load-bearing: only `anywhere`
            // reduces the min-content width so the w-fit bubble can shrink below a long
            // unbreakable token (e.g. a pasted log URL). `break-words`/`overflow-wrap:break-word`
            // wraps visually but does NOT shrink min-content, so it must not be set here —
            // it would win by source order and let the bubble overflow its column on every engine.
            'min-w-0 max-w-full whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]',
            isLong && !isFullTextVisible ? 'overflow-hidden' : ''
          )}
          style={{
            ...conversationTextFontSizeStyle(fontSize),
            ...(isLong && !isFullTextVisible
              ? { maxHeight: userTextCollapsedHeight(fontSize) }
              : {}),
          }}
          data-search-block-id={searchBlockId}
        >
          {/* Search wins over chips: both want to split the same string, and a
              match that lands inside a chip has nowhere to paint. Chips come
              back the moment the search closes. */}
          {isSearchActive || !renderedSpans?.length ? (
            searchBlockId ? (
              <SearchHighlightedText blockId={searchBlockId} text={renderedText} />
            ) : (
              renderedText
            )
          ) : (
            <MessageTextWithChips text={renderedText} spans={renderedSpans} />
          )}
        </div>
        {isLong ? (
          <div className="mt-1 flex items-center justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setIsExpanded((prev) => !prev)}
            >
              {isExpanded ? 'Show less' : 'Show more'}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const CollapsibleCard = ({
  left,
  right,
  children,
  defaultExpanded = false,
  isCollapsible = true,
  expanded,
  onExpandedChange,
  showDisclosureIcon = false,
  containerClassName,
  containerProps,
  buttonClassName,
  bodyClassName,
}: {
  left: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  defaultExpanded?: boolean;
  isCollapsible?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  showDisclosureIcon?: boolean;
  containerClassName?: string;
  containerProps?: SearchContainerProps;
  buttonClassName?: string;
  bodyClassName?: string;
}) => {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const hasBody = children !== null && children !== undefined;
  const canToggle = Boolean(isCollapsible && hasBody);
  const isControlled = expanded !== undefined;
  const isExpanded = isControlled ? expanded : uncontrolledExpanded;
  const shouldRenderBody = canToggle ? isExpanded : hasBody;

  const setExpanded = (next: boolean) => {
    if (!isControlled) {
      setUncontrolledExpanded(next);
    }
    onExpandedChange?.(next);
  };

  return (
    <div
      {...containerProps}
      className={cn('rounded-xl', containerClassName, containerProps?.className)}
    >
      <button
        type="button"
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-muted-foreground transition-colors hover:text-foreground',
          canToggle ? 'cursor-pointer' : 'cursor-default',
          buttonClassName
        )}
        onClick={canToggle ? () => setExpanded(!isExpanded) : undefined}
        aria-expanded={canToggle ? isExpanded : undefined}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {canToggle && showDisclosureIcon ? (
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 flex-none shrink-0 text-current transition-transform duration-200 ease-out',
                isExpanded ? 'rotate-90' : ''
              )}
            />
          ) : null}
          {left}
        </div>
        {right ? <div className="flex items-center gap-2">{right}</div> : null}
      </button>

      {shouldRenderBody ? (
        <div className={cn('space-y-2 px-2 pb-1', bodyClassName)}>{children}</div>
      ) : null}
    </div>
  );
};

const ThoughtCard = ({
  text,
  fontSize,
  expanded,
  onExpandedChange,
  searchBlockId,
  isStreaming = false,
}: {
  text: string;
  fontSize: ConversationFontSize;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  searchBlockId?: string;
  isStreaming?: boolean;
}) => {
  const searchState = useSessionSearchBlockPrefix(searchBlockId ?? '');
  return (
    <CollapsibleCard
      isCollapsible
      expanded={searchState.hasActive ? true : expanded}
      onExpandedChange={onExpandedChange}
      containerClassName={cn(
        searchState.hasMatched && SEARCH_HIGHLIGHT_CONTAINER_MATCHED_CLASS_NAME,
        searchState.hasActive && SEARCH_HIGHLIGHT_CONTAINER_ACTIVE_CLASS_NAME
      )}
      containerProps={{ 'data-search-block-id': searchBlockId }}
      left={
        <Fragment>
          <Sparkles className="h-3.5 w-3.5 flex-none shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-semibold leading-tight text-muted-foreground">
            Agent thinking
          </span>
        </Fragment>
      }
    >
      <div className="text-muted-foreground/70">
        <MarkdownRenderer
          text={text}
          size={fontSize}
          isStreaming={isStreaming}
          searchBlockId={searchBlockId}
        />
      </div>
    </CollapsibleCard>
  );
};

const PlanBlock = ({
  entries,
  fontSize,
}: {
  entries: PlanEntryItem[];
  fontSize: ConversationFontSize;
}) => (
  <div className="space-y-2 rounded-lg border border-border/70 bg-background/80 p-2.5">
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <ListChecks className="h-4 w-4" />
      Plan
    </div>
    <div className="space-y-1.5">
      {entries.map((entry, index) => (
        <PlanEntryRow key={`${entry.content}-${index}`} entry={entry} fontSize={fontSize} />
      ))}
    </div>
  </div>
);

/**
 * The ONE plan surface. Every agent's plan reaches it, whatever carrier the
 * adapter used (`plan-surface.ts`): Codex's separate `proposed_plan` item and
 * Claude's / Kimi's card-carried `content` render the same panel, clamp the
 * same way, and open the same way while a decision is pending. Rendering the
 * card-carried ones as bare markdown was why a Claude plan looked nothing like
 * a Codex one.
 */
const PlanPanel = ({
  markdown,
  searchBlockId,
  messageId,
  itemIndex,
  onFilePathClick,
  fontSize = DEFAULT_CONVERSATION_FONT_SIZE,
  awaitingDecision = false,
  isStreaming = false,
}: {
  markdown: string;
  searchBlockId: string;
  messageId: string;
  itemIndex: number;
  onFilePathClick?: (filePath: string) => void;
  fontSize?: ConversationFontSize;
  /** The approval below this plan is still unanswered. */
  awaitingDecision?: boolean;
  /** The plan is still being written. */
  isStreaming?: boolean;
}) => {
  const plan = { markdown, status: isStreaming ? ('delta' as const) : ('completed' as const) };
  const handleAgentFileLinkClick = useCallback(
    (href: string) => {
      onFilePathClick?.(href);
    },
    [onFilePathClick]
  );
  const [didCopy, setDidCopy] = useState(false);
  const handleCopy = useCallback(async () => {
    const ok = await writeTextToClipboard(plan.markdown);
    if (!ok) return;
    setDidCopy(true);
    window.setTimeout(() => setDidCopy(false), 1200);
  }, [plan.markdown]);

  /* A plan is long by nature and it now sits near the TOP of its turn, above the
     work it produced — unclamped it would push everything that happened after it
     off the screen. So it clamps ONCE IT IS HISTORY. While the plan is still
     being written, or while its approval is unanswered, it opens in full: a
     reader asked to approve or reject has to see the whole thing, and hiding
     two thirds of it behind a chevron is the one moment that is unacceptable.
     Collapsing then happens on the next render after the decision, never under
     the reader who just made it (`useState` keeps the mounted value).
     The toggle only appears when there is actually more to show, so a
     three-line plan keeps no chrome. */
  const defaultExpanded = awaitingDecision || plan.status === 'delta';
  const cachedExpanded = getExpandState(messageId).expandedByIndex[itemIndex];
  const [expanded, setExpandedState] = useState(cachedExpanded ?? defaultExpanded);
  // Persisted so Virtua unmounting the row while it scrolls away does not throw
  // away a reader's manual expansion.
  const setExpanded = useCallback(
    (next: boolean) => {
      setExpandedState(next);
      const cached = getExpandState(messageId);
      setExpandState(messageId, {
        ...cached,
        expandedByIndex: { ...cached.expandedByIndex, [itemIndex]: next },
      });
    },
    [itemIndex, messageId]
  );
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchState = useSessionSearchBlockPrefix(searchBlockId);
  const forceOpen = searchState.hasActive;
  const isOpen = expanded || forceOpen;
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return undefined;
    const check = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    check();
    return observeResizeOnAnimationFrame(element, check);
  }, [plan.markdown, isOpen]);

  if (!plan.markdown.trim()) {
    return null;
  }

  /* The plan is the same kind of object as the command block and the tool
     output beside it, so it wears the same panel: lighter header, plain body,
     no accent. The tinted border/fill made one ordinary panel in the turn look
     like the turn's alert, and the status pill restated what the surrounding
     turn already shows (a drafting plan is visibly still growing). */
  return (
    <div className={CONVERSATION_PANEL_FRAME_CLASS}>
      <div className={cn(CONVERSATION_PANEL_HEADER_CLASS, CONVERSATION_PANEL_HEADER_RULE_CLASS)}>
        {/* The whole header toggles, matching `TerminalComponent`. The chevron is
            the affordance; it only exists when the body is actually clipped. */}
        <button
          type="button"
          className="-my-1 -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded py-1 pl-1 text-left"
          onClick={overflows || isOpen ? () => setExpanded(!isOpen) : undefined}
          aria-expanded={overflows || isOpen ? isOpen : undefined}
          disabled={!overflows && !isOpen}
        >
          {overflows || isOpen ? (
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
                isOpen && 'rotate-90'
              )}
            />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className={CONVERSATION_PANEL_TITLE_CLASS}>Proposed Plan</span>
        </button>
        <TooltipProvider>
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="-mr-1 h-6 w-6 shrink-0 text-muted-foreground hover:bg-hover hover:text-foreground"
                onClick={() => {
                  void handleCopy();
                }}
                aria-label="Copy plan"
              >
                {didCopy ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{didCopy ? 'Copied' : 'Copy plan'}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="relative">
        <div
          ref={bodyRef}
          className={cn(CONVERSATION_PANEL_BODY_CLASS, !isOpen && 'max-h-56 overflow-hidden')}
        >
          <MarkdownRenderer
            text={plan.markdown}
            size={fontSize}
            onAgentFileLinkClick={onFilePathClick ? handleAgentFileLinkClick : undefined}
            searchBlockId={searchBlockId}
          />
        </div>
        {!isOpen && overflows ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background/95 to-transparent"
          />
        ) : null}
      </div>
    </div>
  );
};

export const ProposedPlanBlock = ({
  plan,
  messageId,
  itemIndex,
  onFilePathClick,
  fontSize = DEFAULT_CONVERSATION_FONT_SIZE,
  awaitingDecision = false,
}: {
  plan: ProposedPlanMessage;
  messageId: string;
  itemIndex: number;
  onFilePathClick?: (filePath: string) => void;
  fontSize?: ConversationFontSize;
  awaitingDecision?: boolean;
}) => (
  <PlanPanel
    markdown={plan.markdown}
    searchBlockId={getProposedPlanSearchBlockId(messageId, itemIndex)}
    messageId={messageId}
    itemIndex={itemIndex}
    onFilePathClick={onFilePathClick}
    fontSize={fontSize}
    awaitingDecision={awaitingDecision}
    isStreaming={plan.status === 'delta'}
  />
);

// Inline marker so the user can locate where the goal entered the timeline.
// Rich controls and metrics live in the sticky `SessionGoalBanner`.
const GoalBlock = ({ goal }: { goal: GoalMessage }) => {
  const objective = sanitizeGoalObjective(goal.objective);
  const meta = getGoalStatusPresentation(goal.status);
  const StatusIcon = meta.Icon;

  return (
    <div className="flex w-full min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
      <Target className="h-3 w-3 flex-none" aria-hidden="true" />
      <StatusIcon
        className={cn('h-2.5 w-2.5 flex-none', meta.textClassName, meta.pulse && 'animate-pulse')}
        aria-hidden="true"
      />
      <span className={cn('block min-w-0 truncate', goal.status === 'cleared' && 'line-through')}>
        {objective}
      </span>
    </div>
  );
};

const PLAN_STATUS_META: Record<
  PlanEntryItem['status'],
  {
    label: string;
    icon: ComponentType<{ className?: string }>;
    className: string;
  }
> = {
  pending: {
    label: 'Pending',
    icon: Circle,
    className: 'text-muted-foreground',
  },
  in_progress: {
    label: 'In progress',
    icon: CarbonInProgress,
    className: 'text-status-info',
  },
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    className: 'text-status-success',
  },
};

const PRIORITY_META: Record<PlanEntryItem['priority'], { label: string; className: string }> = {
  high: {
    label: 'High',
    className: 'border-status-danger/20 bg-status-danger/[0.15] text-status-danger',
  },
  medium: {
    label: 'Medium',
    className: 'border-status-warning/20 bg-status-warning/[0.15] text-status-warning',
  },
  low: {
    label: 'Low',
    className: 'border-status-success/20 bg-status-success/[0.15] text-status-success',
  },
};

const PlanEntryRow = ({
  entry,
  fontSize,
}: {
  entry: PlanEntryItem;
  fontSize: ConversationFontSize;
}) => {
  const statusMeta =
    PLAN_STATUS_META[String(entry.status) as keyof typeof PLAN_STATUS_META] ??
    PLAN_STATUS_META.pending;
  const StatusIcon = statusMeta.icon;
  const priorityMeta =
    PRIORITY_META[String(entry.priority) as keyof typeof PRIORITY_META] ?? PRIORITY_META.medium;

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-background/60 p-2.5">
      <div className="flex items-center justify-between gap-1.5">
        <div
          className="flex items-center gap-1.5 font-medium"
          style={conversationTextFontSizeStyle(fontSize)}
        >
          <StatusIcon className={cn('h-4 w-4 flex-none shrink-0', statusMeta.className)} />
          <span className="break-words">{entry.content}</span>
        </div>
        <Badge
          variant="outline"
          className={cn('text-[10px] font-semibold uppercase', priorityMeta.className)}
        >
          {priorityMeta.label}
        </Badge>
      </div>
    </div>
  );
};

// memo matters here: this is the heaviest leaf in the chat stream (diffs,
// terminals, permission blocks), and during streaming its parents re-render
// per delta. `toolCall` identity is preserved by loro-mirror for unchanged
// items, so a shallow compare skips completed tool calls entirely.
const ToolCallCard = memo(function ToolCallCard({
  toolCall,
  sessionId,
  fontSize,
  expanded,
  onExpandedChange,
  onFilePathClick,
  inlineOutput = false,
}: {
  toolCall: ToolCallMessage;
  sessionId: SessionId;
  fontSize: ConversationFontSize;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onFilePathClick?: (filePath: string) => void;
  inlineOutput?: boolean;
}) {
  const { t } = useTranslation();
  // A sealed skeleton carries only `kind`/`status`/`title`/`locations`/`ref`;
  // its payload arrives via `useToolCallPayload` (Machine RPC pending — every
  // lookup is `unavailable` until then, and the placeholder row below shows).
  const payload = useToolCallPayload(toolCall.ref);
  const payloadValue = payload.state === 'ready' ? payload.value : undefined;
  const effectiveContent = payloadValue?.content ?? toolCall.content;
  const effectiveRawOutput = payloadValue?.rawOutput ?? toolCall.rawOutput;
  if (toolCall.activityKind === 'codex_retry') {
    if (toolCall.status !== 'pending' && toolCall.status !== 'in_progress') return null;
    return (
      <div className="flex min-h-7 items-center gap-2 py-1 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        <span>
          {t('sessions.activity.codexRetrying', 'Connection interrupted, Codex is retrying')}
        </span>
      </div>
    );
  }
  if (toolCall.activityKind === 'context_compaction') {
    const isCompacting = toolCall.status === 'pending' || toolCall.status === 'in_progress';
    const StatusIcon = isCompacting ? Loader2 : toolCall.status === 'failed' ? AlertCircle : Check;
    return (
      <div className="flex min-h-7 items-center gap-2 py-1 text-sm text-muted-foreground">
        <StatusIcon
          className={cn('h-4 w-4 shrink-0', isCompacting && 'animate-spin')}
          aria-hidden="true"
        />
        <span>
          {isCompacting
            ? t('sessions.activity.compactingContext', 'Compacting context')
            : toolCall.status === 'failed'
              ? t('sessions.activity.contextCompactionFailed', 'Context compaction failed')
              : t('sessions.activity.contextCompacted', 'Context compacted')}
        </span>
      </div>
    );
  }
  const kindMeta = toolCall.kind ? TOOL_KIND_META[toolCall.kind] : undefined;
  const KindIcon = kindMeta?.icon ?? Wrench;
  const isActivityRow = inlineOutput;
  const kindIconClass = isActivityRow
    ? ACTIVITY_STEP_ICON_CLASS
    : 'h-3.5 w-3.5 flex-none shrink-0 text-current';

  const hasDiffContent = Boolean(effectiveContent?.some((block) => block.type === 'diff'));
  const hasTerminalContent = Boolean(
    effectiveContent?.some(
      (block) => block.type === 'terminal_command' || block.type === 'terminal_output'
    )
  );
  const contentBlocks = effectiveContent?.filter((block) => {
    if (!hasDiffContent) return true;
    return block.type !== 'terminal' && block.type !== 'terminal_output';
  });

  const hasOutput = Boolean(effectiveRawOutput);
  const hasContent = Boolean(contentBlocks?.length);
  /* A cancelled request records nothing, so it must not count towards the body:
     otherwise the card stays collapsible and opens onto empty padding. */
  const hasPermission =
    Boolean(toolCall.permissionRequest) &&
    toolCall.permissionRequest?.outcome?.outcome !== 'cancelled';
  const hasDetails = hasOutput || hasContent || hasPermission;

  const title = toolCall.title
    ? sanitizeToolTitle(toolCall.title)
    : (kindMeta?.label ?? 'Tool call');

  const isFailed = toolCall.status === 'failed';
  const isRunning = toolCall.status === 'in_progress';
  const titleColorClass = isFailed ? 'text-status-danger' : '';

  const isFileAction = toolCall.kind === 'read' || toolCall.kind === 'edit';
  const isReadOnly = toolCall.kind === 'read';
  const isTerminalExecuteToolCall = toolCall.kind === 'execute' && hasTerminalContent;
  const filePath =
    (isFileAction && toolCall.locations?.[0]?.path) ||
    (isFileAction && toolCall.title && kindMeta?.label
      ? extractFilePathFromTitle(toolCall.title, kindMeta.label)
      : null);
  const normalizedFilePath = filePath ? normalizeWorktreePath(filePath) : null;
  const fileName = normalizedFilePath ? getFileNameFromPath(normalizedFilePath) : null;
  const isFilePathClickable = Boolean(filePath && onFilePathClick);
  const triggerFilePathClick = () => {
    if (filePath && onFilePathClick) {
      onFilePathClick(normalizeWorktreePath(filePath));
    }
  };
  const handleFilePathClick = (event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    triggerFilePathClick();
  };
  const handleFilePathKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      triggerFilePathClick();
    }
  };

  let terminalTitleBlockIndex: number | null = null;
  let terminalTitleFromContent: string | null = null;
  const hasTerminalBlocks = Boolean(
    contentBlocks?.some(
      (block) => block?.type === 'terminal_command' || block?.type === 'terminal_output'
    )
  );
  if (hasTerminalBlocks && contentBlocks) {
    for (let index = 0; index < contentBlocks.length; index += 1) {
      const block = contentBlocks[index];
      if (!block) continue;
      if (block.type !== 'content') continue;
      if (block.content.type !== 'text') continue;
      const text = block.content.text.trim();
      if (!text) continue;
      if (text.includes('\n')) continue;
      if (text.length > 96) continue;
      terminalTitleBlockIndex = index;
      terminalTitleFromContent = text;
      break;
    }
  }

  const terminalTitleDefault = terminalTitleFromContent ?? title;
  const displayTitle = isTerminalExecuteToolCall ? terminalTitleDefault : title;
  const runningIndicator = isRunning ? (
    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  ) : null;

  const renderContentBlocks = () => {
    if (!contentBlocks?.length) return null;
    const nodes: ReactNode[] = [];
    let terminalIndex = 0;

    for (let index = 0; index < contentBlocks.length; index += 1) {
      const block = contentBlocks[index];
      if (!block) continue;

      if (terminalTitleBlockIndex === index) {
        continue;
      }

      if (block.type === 'terminal' && hasTerminalBlocks) {
        continue;
      }

      if (block.type === 'terminal_command') {
        const outputs: TerminalOutputBlockType[] = [];
        let next = index + 1;
        while (next < contentBlocks.length) {
          if (next === terminalTitleBlockIndex) {
            next += 1;
            continue;
          }

          const nextBlock = contentBlocks[next];
          if (!nextBlock) {
            next += 1;
            continue;
          }
          if (nextBlock.type === 'terminal') {
            next += 1;
            continue;
          }
          if (nextBlock.type !== 'terminal_output') break;
          outputs.push(nextBlock as TerminalOutputBlockType);
          next += 1;
        }

        const terminalTitle = terminalIndex === 0 ? terminalTitleDefault : title;
        nodes.push(
          <TerminalComponent
            key={`terminal-component-${terminalIndex}`}
            title={terminalTitle}
            command={formatTerminalCommandLine(block)}
            output={prepareTerminalOutputBlocksPreview(outputs).text}
            className={isActivityRow ? 'rounded-md' : undefined}
            showHeader={!isTerminalExecuteToolCall}
            showBorder={!isTerminalExecuteToolCall}
            outputDisplayMode={inlineOutput ? 'full' : undefined}
            fontSize={fontSize}
          />
        );
        terminalIndex += 1;
        index = next - 1;
        continue;
      }

      if (block.type === 'terminal_output') {
        const outputs: TerminalOutputBlockType[] = [];
        let next = index;
        while (next < contentBlocks.length && contentBlocks[next]?.type === 'terminal_output') {
          outputs.push(contentBlocks[next] as TerminalOutputBlockType);
          next += 1;
        }

        const terminalTitle = terminalIndex === 0 ? terminalTitleDefault : title;
        nodes.push(
          <TerminalComponent
            key={`terminal-component-${terminalIndex}`}
            title={terminalTitle}
            command=""
            output={prepareTerminalOutputBlocksPreview(outputs).text}
            className={isActivityRow ? 'rounded-md' : undefined}
            showHeader={!isTerminalExecuteToolCall}
            showBorder={!isTerminalExecuteToolCall}
            outputDisplayMode={inlineOutput ? 'full' : undefined}
            fontSize={fontSize}
          />
        );
        terminalIndex += 1;
        index = next - 1;
        continue;
      }

      nodes.push(
        /* Inside a folded activity row the block needs its own surface to read as
           output. At top level the only tool call that gets here is the plan-exit
           `switch_mode` card, whose content is the plan prose itself — boxing it
           there stacked a near-invisible frame above the permission card and made
           one row look like three unrelated objects. Space groups it instead. */
        <div
          key={`${block.type}-${index}`}
          className={cn(
            isActivityRow && cn(CONVERSATION_PANEL_FRAME_CLASS, CONVERSATION_PANEL_BODY_CLASS)
          )}
        >
          <ToolCallContentRenderer
            block={block}
            onFilePathClick={onFilePathClick}
            fontSize={fontSize}
          />
        </div>
      );
    }

    return nodes;
  };

  const card = (
    <CollapsibleCard
      isCollapsible={hasDetails && !isReadOnly}
      defaultExpanded={isRunning || hasTerminalContent || isFailed || hasPermission}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      containerClassName={cn(
        isActivityRow && 'rounded-md',
        !isActivityRow &&
          isTerminalExecuteToolCall &&
          'overflow-hidden rounded-md border border-border/60 bg-background/70 shadow-xs'
      )}
      buttonClassName={
        isActivityRow
          ? ACTIVITY_STEP_BUTTON_CLASS
          : isTerminalExecuteToolCall
            ? 'rounded-none bg-muted/70 px-3 py-1.5 text-foreground hover:bg-muted/90'
            : /* A top-level tool call (the plan-approval `switch_mode` card) is a
                 SIBLING of the worked headers and the answer prose, so it starts
                 on the turn's left rail. `CollapsibleCard`'s default `px-1` put
                 its title 4px right of every chevron in the same column — and 8px
                 right of its own `px-0` body. */
              'px-0'
      }
      bodyClassName={cn(
        /* An expanded body starts on the rail, like every other collapsible
           region in a turn. It still needs air under the title — they were 0px
           apart — but not an indent. */
        isActivityRow
          ? 'space-y-1.5 px-0 pb-1.5 pt-1'
          : isTerminalExecuteToolCall
            ? /* Bordered card: the body is full-bleed to its own frame. */
              'space-y-3 border-t border-border/60 px-0 pb-0'
            : 'space-y-2.5 px-0 pb-1 pt-1.5'
      )}
      right={runningIndicator}
      left={
        <div
          className={cn(
            'flex min-w-0 flex-1 items-start gap-1.5',
            /* No leading margin: see `buttonClassName` — the rail is shared. */
            isTerminalExecuteToolCall ? null : titleColorClass
          )}
        >
          <KindIcon className={kindIconClass} />
          {isFileAction && fileName ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  isActivityRow
                    ? ACTIVITY_STEP_TITLE_CLASS
                    : 'text-[13px] font-semibold leading-tight'
                )}
              >
                {kindMeta?.label ?? title}
              </span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role={isFilePathClickable ? 'button' : undefined}
                      tabIndex={isFilePathClickable ? 0 : undefined}
                      onClick={isFilePathClickable ? handleFilePathClick : undefined}
                      onKeyDown={isFilePathClickable ? handleFilePathKeyDown : undefined}
                      className={cn(
                        isActivityRow
                          ? cn(
                              'inline-flex min-w-0 max-w-[min(100%,20rem)] shrink items-center truncate font-mono',
                              ACTIVITY_PROCESS_TEXT_CLASS
                            )
                          : 'inline-flex min-w-0 max-w-[240px] shrink items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-[11px]',
                        isFilePathClickable ? 'cursor-pointer hover:bg-hover/60' : ''
                      )}
                    >
                      {normalizedFilePath && !isActivityRow ? (
                        <FileIcon
                          filePath={normalizedFilePath}
                          className="h-3.5 w-3.5 shrink-0 grayscale"
                        />
                      ) : null}
                      <span
                        className={cn(
                          'min-w-0 truncate whitespace-nowrap font-mono',
                          isActivityRow ? ACTIVITY_PROCESS_TEXT_CLASS : 'text-xs'
                        )}
                      >
                        {fileName}
                      </span>
                    </span>
                  </TooltipTrigger>
                  {normalizedFilePath ? (
                    <TooltipContent>{normalizedFilePath}</TooltipContent>
                  ) : null}
                </Tooltip>
              </TooltipProvider>
            </div>
          ) : (
            <ToolTitleWithHighlight
              title={displayTitle}
              className={cn(
                'truncate',
                isActivityRow
                  ? ACTIVITY_STEP_TITLE_CLASS
                  : isTerminalExecuteToolCall
                    ? 'text-xs font-medium'
                    : 'text-[13px] font-semibold leading-tight'
              )}
            />
          )}
        </div>
      }
    >
      {hasDetails && !isReadOnly ? (
        <Fragment>
          {hasOutput && isRecord(effectiveRawOutput) ? (
            <StructuredObject
              label="Output"
              value={effectiveRawOutput}
              dense
              unbounded={inlineOutput}
              fontSize={fontSize}
            />
          ) : hasOutput ? (
            <div className={CONVERSATION_PANEL_FRAME_CLASS}>
              <div
                className={cn(
                  CONVERSATION_PANEL_HEADER_CLASS,
                  CONVERSATION_PANEL_HEADER_RULE_CLASS
                )}
              >
                <span className={CONVERSATION_PANEL_TITLE_CLASS}>Output</span>
              </div>
              <pre
                className={cn(
                  CONVERSATION_PANEL_BODY_CLASS,
                  inlineOutput ? 'overflow-x-auto' : 'max-h-60 overflow-auto'
                )}
                style={conversationMonoFontSizeStyle(fontSize)}
              >
                {formatJsonValue(effectiveRawOutput)}
              </pre>
            </div>
          ) : null}

          {hasContent ? <div className="space-y-2">{renderContentBlocks()}</div> : null}

          {hasPermission && <PermissionRequestBlock sessionId={sessionId} toolCall={toolCall} />}
        </Fragment>
      ) : null}
    </CollapsibleCard>
  );

  // A skeleton whose payload has not arrived says where the execution details
  // live instead of opening onto nothing.
  if (!isToolCallSkeleton(toolCall) || payload.state === 'ready') return card;
  return (
    <Fragment>
      {card}
      <ToolCallPayloadStoredRow toolCallRef={toolCall.ref} />
    </Fragment>
  );
});

/**
 * One small line under a sealed skeleton tool call naming the machine its
 * execution payload is stored on. The meta lookup falls back to a short id
 * when the machine's meta has not loaded (or the machine is unknown).
 */
const ToolCallPayloadStoredRow = ({ toolCallRef }: { toolCallRef: ToolCallRef }) => {
  const { t } = useTranslation();
  const machineMeta = useAtomValue(getMachineMetaByIdAtomFamily(toolCallRef.machineId));
  const machineName = machineMeta?.name ?? getShortMachineId(toolCallRef.machineId);
  return (
    <div className={cn('flex items-center gap-1.5 py-0.5', ACTIVITY_PROCESS_TEXT_CLASS)}>
      {t('sessions.toolCall.executionDetailsStoredOnMachine', {
        machine: machineName,
        defaultValue: 'Execution details are stored on {{machine}}',
      })}
    </div>
  );
};

const TOOL_KIND_META: Record<
  NonNullable<ToolCallMessage['kind']>,
  { label: string; icon: ComponentType<{ className?: string }> }
> = {
  read: { label: 'Read', icon: BookOpen },
  edit: { label: 'Edit', icon: PencilLine },
  delete: { label: 'Delete', icon: Trash2 },
  move: { label: 'Move', icon: MoveRight },
  search: { label: 'Search', icon: Search },
  execute: { label: 'Execute', icon: Terminal },
  bash: { label: 'Bash', icon: Terminal },
  computer: { label: 'Computer', icon: Info },
  write: { label: 'Write', icon: FileText },
  mcp: { label: 'MCP', icon: Wrench },
  think: { label: 'Think', icon: Brain },
  fetch: { label: 'Fetch', icon: Globe },
  switch_mode: { label: 'Switch mode', icon: Workflow },
  other: { label: 'Tool', icon: Wrench },
};

type DiffBlockType = Extract<ToolCallContentBlock, { type: 'diff' }>;
type TerminalCommandBlockType = Extract<ToolCallContentBlock, { type: 'terminal_command' }>;
type TerminalOutputBlockType = Extract<ToolCallContentBlock, { type: 'terminal_output' }>;

/**
 * Renders a diff block using the content directly from the block.
 */
const DiffBlockRenderer = ({ block }: { block: DiffBlockType }) => (
  <DiffViewer path={block.path} oldText={block.oldText ?? ''} newText={block.newText ?? ''} />
);

const formatTerminalCommandLine = (block: TerminalCommandBlockType) => {
  const normalizedCommand = normalizeWorktreePath(String(block.command ?? ''));
  const normalizedArgs = (block.args ?? []).map((arg: unknown) =>
    normalizeWorktreePath(String(arg))
  );
  return [normalizedCommand, ...normalizedArgs].filter(Boolean).join(' ');
};

const ToolCallContentRenderer = ({
  block,
  onFilePathClick,
  fontSize,
}: {
  block: ToolCallContentBlock;
  onFilePathClick?: (filePath: string) => void;
  fontSize: ConversationFontSize;
}) => {
  if (block.type === 'diff') {
    return <DiffBlockRenderer block={block} />;
  }

  if (block.type === 'terminal') {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 p-3 text-muted-foreground"
        style={conversationTextFontSizeStyle(fontSize)}
      >
        <Terminal className="h-4 w-4" />
        Terminal output is streaming in your CLI
      </div>
    );
  }

  if (block.type === 'terminal_command') {
    return null;
  }

  if (block.type === 'terminal_output') {
    return null;
  }

  if (block.type === 'content') {
    return (
      <StandardToolContentBlock
        content={block.content}
        onFilePathClick={onFilePathClick}
        fontSize={fontSize}
      />
    );
  }

  return null;
};

// MCP tool content (`resource_link`, `resource`, `image`) carries URIs supplied
// by the agent and arbitrary upstream MCP servers. Untrusted strings reach `<a
// href>` and `<source src>` sinks here; React doesn't strip `javascript:`
// hrefs, so we filter the scheme to `http(s):`/`mailto:`/`tel:` (plus same-origin
// paths) before rendering.
const SAFE_TOOL_HREF_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function sanitizeToolContentHref(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Permit plain paths and fragments (relative to the current document).
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('?') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    if (trimmed.startsWith('//')) return undefined; // protocol-relative → reject
    return trimmed;
  }
  if (typeof window === 'undefined') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, window.location.origin);
  } catch {
    return undefined;
  }
  if (!SAFE_TOOL_HREF_SCHEMES.has(parsed.protocol)) return undefined;
  return parsed.toString();
}

// MIME types in MCP responses are agent-controlled, so refuse anything that
// isn't a single `type/subtype` token before splicing into a `data:` URL.
// base64 payloads must be valid base64 alphabet only.
const SAFE_MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_+\-.]*\/[a-z0-9][a-z0-9!#$&^_+\-.]*$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]*$/;

function buildSafeBase64DataUrl(
  mimeType: string | undefined,
  data: string | undefined
): string | undefined {
  if (typeof mimeType !== 'string' || !SAFE_MIME_PATTERN.test(mimeType)) return undefined;
  if (typeof data !== 'string' || !BASE64_PATTERN.test(data)) return undefined;
  return `data:${mimeType};base64,${data.replace(/\s+/g, '')}`;
}

const StandardToolContentBlock = ({
  content,
  onFilePathClick,
  fontSize,
}: {
  content: StandardToolContent;
  onFilePathClick?: (filePath: string) => void;
  fontSize: ConversationFontSize;
}) => {
  switch (content.type) {
    case 'text':
      return (
        <MarkdownBlock text={content.text} size={fontSize} onFilePathClick={onFilePathClick} />
      );
    case 'image': {
      const src = content.uri
        ? sanitizeToolContentHref(content.uri)
        : buildSafeBase64DataUrl(content.mimeType, content.data);
      if (!src) return null;
      return (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Image</div>
          <img
            src={src}
            alt={content.annotations?.audience ? 'Shared image' : 'Generated image'}
            className="max-h-80 w-full rounded-lg object-contain"
          />
        </div>
      );
    }
    case 'audio': {
      const src = buildSafeBase64DataUrl(content.mimeType, content.data);
      if (!src) return null;
      return (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Audio</div>
          <audio controls className="w-full">
            <source src={src} />
          </audio>
        </div>
      );
    }
    case 'resource_link': {
      const href = sanitizeToolContentHref(content.uri);
      if (!href) {
        return (
          <div
            className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 p-3 text-muted-foreground"
            style={conversationTextFontSizeStyle(fontSize)}
          >
            <FileText className="h-4 w-4" />
            {content.title || content.name}
          </div>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 p-3 text-primary"
          style={conversationTextFontSizeStyle(fontSize)}
        >
          <FileText className="h-4 w-4" />
          {content.title || content.name}
        </a>
      );
    }
    case 'resource': {
      if ('text' in content.resource) {
        return (
          <MarkdownBlock
            text={content.resource.text}
            size={fontSize}
            onFilePathClick={onFilePathClick}
          />
        );
      }
      const href = sanitizeToolContentHref(content.resource.uri);
      if (!href) return null;
      return (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Resource</div>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary"
            style={conversationTextFontSizeStyle(fontSize)}
          >
            Download blob
          </a>
        </div>
      );
    }
    default:
      return null;
  }
};

/**
 * A plan exit (`switch_mode`) renders as the DECISION, nothing else.
 *
 * Claude's `ExitPlanMode` carries the plan as a `content` text block, so that
 * still renders here; Codex puts the plan in `rawInput` (never displayed) and
 * emits a separate `proposed_plan`, which `buildAssistantMessageRenderItems`
 * moves directly above this row. Either way the reader gets plan-then-decision,
 * with no title restating the question the outcome already answers.
 */
const PlanExitBlock = ({
  toolCall,
  sessionId,
  fontSize,
  onFilePathClick,
  messageId,
  itemIndex,
  awaitingDecision = false,
  planRenderedSeparately = false,
}: {
  toolCall: ToolCallMessage;
  sessionId: SessionId;
  fontSize: ConversationFontSize;
  onFilePathClick?: (filePath: string) => void;
  messageId: string;
  itemIndex: number;
  awaitingDecision?: boolean;
  /** The turn renders the plan as its own `proposed_plan` row (Codex). */
  planRenderedSeparately?: boolean;
}) => {
  /* Claude and Kimi carry the plan in the card; Codex renders it as its own row
     just above. Take it from the card only when nobody else is showing it, or
     the plan prints twice. */
  const carriedMarkdown = planRenderedSeparately ? null : resolvePlanExitMarkdown(toolCall);
  return (
    <div className="space-y-2">
      {carriedMarkdown ? (
        <PlanPanel
          markdown={carriedMarkdown}
          searchBlockId={getProposedPlanSearchBlockId(messageId, itemIndex)}
          messageId={messageId}
          itemIndex={itemIndex}
          onFilePathClick={onFilePathClick}
          fontSize={fontSize}
          awaitingDecision={awaitingDecision}
        />
      ) : null}
      <PermissionRequestBlock sessionId={sessionId} toolCall={toolCall} />
    </div>
  );
};

const PermissionRequestBlock = ({
  toolCall,
  sessionId,
}: {
  toolCall: ToolCallMessage;
  sessionId: SessionId;
}) => {
  const permission = toolCall.permissionRequest;
  const { t } = useTranslation();
  const { respondToPermission, isReady } = usePermissionResponse();
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null);

  const askQuestionMeta = useMemo(
    () => (permission ? parseAskUserQuestionPermissionMeta(permission._meta) : null),
    [permission]
  );
  const readonlyAnswers = useMemo(
    () =>
      askQuestionMeta && permission
        ? extractAskUserQuestionAnswersFromOutcome(askQuestionMeta, permission.outcome)
        : null,
    [askQuestionMeta, permission]
  );

  if (!permission) {
    return null;
  }

  if (askQuestionMeta && readonlyAnswers) {
    return (
      <AskUserQuestionCard
        meta={askQuestionMeta}
        mode={{ kind: 'readonly', answers: readonlyAnswers }}
      />
    );
  }

  const selectedOptionId =
    permission.outcome?.outcome === 'selected' ? permission.outcome.optionId : undefined;
  const isResolved = Boolean(permission.outcome);
  const isCancelled = permission.outcome?.outcome === 'cancelled';
  const record = resolvePermissionRecord(permission);

  // `ToolCallCard` also drops the body for a withdrawn request, so this is the
  // second gate rather than the only one.
  if (record.kind === 'withdrawn') {
    return null;
  }

  if (record.kind === 'settled') {
    const label =
      record.optionName ??
      (record.allowed
        ? t('sessions.permissionApproved', 'Permission Approved')
        : t('sessions.permissionDenied', 'Permission Denied'));
    const OutcomeIcon = record.allowed ? Check : X;
    return (
      <div
        className={cn('flex min-h-7 w-full items-start gap-1.5 py-1', ACTIVITY_PROCESS_TEXT_CLASS)}
      >
        {/* Check vs cross already carries approved-vs-denied, so the icon keeps
            the turn's one icon tone instead of introducing a hue no other icon
            in the row has. */}
        <OutcomeIcon className={ACTIVITY_STEP_ICON_CLASS} aria-hidden="true" />
        {/* Truncated like every other process row: an `allow_always` name runs
            to a full sentence, and the record must stay one line. */}
        <span className="min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
      </div>
    );
  }

  const handleSelect = async (optionId: string) => {
    if (isResolved || isCancelled || !isReady) {
      return;
    }
    setPendingOptionId(optionId);
    try {
      await respondToPermission(sessionId, permission.requestId, {
        outcome: 'selected',
        optionId,
      });
    } catch (error) {
      console.error('Failed to respond to permission request:', error);
      setPendingOptionId(null);
    }
  };

  return (
    <PermissionRequestCard
      options={permission.options}
      isResolved={isResolved}
      isCancelled={isCancelled}
      isReady={isReady}
      pendingOptionId={pendingOptionId}
      selectedOptionId={selectedOptionId}
      /* On the rail with the rest of its tool call's body. A private `ml-4`
         used to put it 16px right of its own siblings. */
      className="w-full max-w-[43rem]"
      onSelect={(optionId) => {
        void handleSelect(optionId);
      }}
    />
  );
};

const StructuredObject = ({
  label,
  value,
  dense = false,
  unbounded = false,
  fontSize = DEFAULT_CONVERSATION_FONT_SIZE,
}: {
  label: string;
  value: Record<string, unknown>;
  dense?: boolean;
  unbounded?: boolean;
  fontSize?: ConversationFontSize;
}) => {
  return (
    <div className={CONVERSATION_PANEL_FRAME_CLASS}>
      <div className={cn(CONVERSATION_PANEL_HEADER_CLASS, CONVERSATION_PANEL_HEADER_RULE_CLASS)}>
        <span className={CONVERSATION_PANEL_TITLE_CLASS}>{label}</span>
      </div>
      <pre
        className={cn(
          CONVERSATION_PANEL_BODY_CLASS,
          unbounded ? 'overflow-x-auto' : 'max-h-60 overflow-auto'
        )}
        style={
          dense ? conversationMonoFontSizeStyle(fontSize) : conversationTextFontSizeStyle(fontSize)
        }
      >
        {formatJsonValue(value)}
      </pre>
    </div>
  );
};
