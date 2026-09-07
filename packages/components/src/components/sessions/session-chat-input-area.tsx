import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useLayoutEffect,
  memo,
  forwardRef,
  useImperativeHandle,
  type ReactNode,
  type MutableRefObject,
} from 'react';
import { useAtomValue } from 'jotai';
import { ArrowUp, Loader2 } from 'lucide-react';
import { Button } from '@/ui/button';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import { useSessionAgentRole, type SessionAgentRoleControl } from '@/hooks/use-session-agent-role';
import { buildAgentRoleFormValueFromRunConfig } from '@/lib/agent-role-form';
import {
  doesAgentRolePinPermissionMode,
  resolveTurnAgentRoleForRunConfig,
  type ComposerRunConfigOverrides,
  type SessionTurnAgentRoleSelection as ComposerTurnAgentRoleSelection,
} from '@/lib/composer-agent-roles';
import { resolvePermissionModeFace } from '@/lib/permission-mode-face';
import {
  AgentRoleEditorDialog,
  openAgentRoleEditorForCreate,
  type AgentRoleEditorState,
} from '@/components/settings/agent-role-editor-dialog';
import { useWorkspaceAgentRoles } from '@/hooks/use-workspace-agent-roles';
import {
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import {
  ChatComposer,
  type ChatComposerFileItem,
  type ChatComposerImageItem,
} from '@/components/chat/chat-composer';
import type { CombinedMentionTextareaHandle } from '@/components/mentions/combined-mention-textarea';
import type { AttachmentAddMenuMcp } from '@/components/chat/attachment-add-menu';
import { useComposerSubmission } from '@/components/chat/submission/use-composer-submission';
import { MobileSessionRunConfig } from '@/components/mobile/mobile-session-run-config';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import {
  useMentionPromptExpansion,
  type ExpandedMentionPrompt,
  type MentionPromptExpansionArgs,
} from '@/components/mentions/mention-expansion';
import { reanchorMessageTextSpansForTrim } from '@lody/shared';
import type { Mention as MentionRange } from '@/ui/mention/index';
import {
  toPersistedMentionRanges,
  type PersistedMentionRange,
} from '@/components/mentions/mention-persistence';
import { useTranslation } from 'react-i18next';
import { usePostHog } from '@posthog/react';
import {
  capturePostHogEvent,
  getDurationSinceMs,
  getPerformanceNowMs,
} from '@/lib/posthog-analytics';
import { IMAGE_UPLOAD_REASONS, type ImageUploadReason } from '@lody/shared';
import type {
  AcpCommandSummary,
  AgentRole,
  AgentRoleId,
  CommentReferencePayload,
  SessionMeta,
  SessionId,
  SessionInputBlock,
  SessionImagePayload,
  WorkspaceId,
  VisualAnnotationReferencePayload,
} from '@lody/shared';
import type { CommentReferenceChipItem } from '@/components/chat/comment-reference-chip';
import type { VisualAnnotationReferenceChipItem } from '@/components/chat/visual-annotation-reference-chip';
import {
  addCommentReferenceItem,
  toggleCommentReferenceItem,
} from '@/components/chat/comment-reference-state';
import {
  addVisualAnnotationReferenceItem,
  toggleVisualAnnotationReferenceItem,
} from '@/components/chat/visual-annotation-reference-state';
import { SESSION_IMAGE_MAX_COUNT } from '@lody/shared';
import { cn } from '@/lib/utils';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { useIsMobile } from '@/hooks/use-mobile';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { authTokenAtom, runtimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom, mobileKeyboardActionAtom, userAtom } from '@/atoms';
import {
  resolveSessionLocalFileSource,
  resolveSessionRepoFullName,
} from '@/lib/session-local-file-source';
import { resolveEffectiveCodeCollabWorkspaceId } from '@/lib/code-collab-workspace-id';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { toast } from 'sonner';
import { uploadSessionImage, validateSessionImageFile } from '@/lib/session-image-upload';
import {
  computeSha256Hex,
  computeTextPreviewable,
  isUploadAbortedError,
  isSessionFileTransferPhase,
  uploadSessionFile,
  SESSION_FILE_MAX_SIZE_MB,
  validateSessionFile,
  type SessionFileTransferPhase,
  type SessionFileUploadProgress,
} from '@/lib/session-file-upload';
import { formatFileSize } from '@/lib/session-file-presentation';
import { SESSION_FILE_MAX_COUNT, SESSION_IMAGE_MAX_SIZE_BYTES } from '@lody/shared';
import type { SessionFilePayload } from '@lody/shared';
import {
  arePastedTextDraftsEqual,
  getPastedTextCharacterCount,
  getPastedTextDraftsAfterInsertion,
  insertPastedTextDraft,
  normalizePastedTextDraft,
  shouldCapturePastedTextDraft,
  type PastedTextDraft,
} from '@/lib/pasted-text-draft';
import { wrapPastedTextChipLabel } from '@/components/mentions/mention-chips';
import { toIntlLocale } from '@/lib/intl-locale';
import {
  canUseElectronLocalFileSend,
  sendSessionFileToLocalRuntime,
} from '@/lib/electron-session-file-sender';
import type { AgentSelection } from '@/components/shared/agent-selector';
import { isNativeAppShell } from '@/lib/native-platform';
import {
  resolveMobileKeyboardEnterKeyHint,
  shouldSubmitOnEnterForMobileKeyboardAction,
} from '@/lib/mobile-keyboard-action';
import { useCodeCollabSessionFileProvider } from '@/hooks/use-code-collab-session-file-provider';
import { useCodeCollabRequestedRole } from '@/hooks/use-code-collab-requested-role';
import { splitImageAndFileAttachments } from '@/lib/file-drop';
import { SessionUsagePopover } from './session-usage-popover';
import type { MachineRateLimits } from '@/lib/session-usage';

const sessionDraftsCache = new Map<SessionId, string>();

type PendingImage = {
  localId: string;
  previewUrl: string;
  file: File;
  status: 'uploading' | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  uploaded?: SessionImagePayload;
};

type PendingFile = {
  localId: string;
  file: File;
  status: SessionFileTransferPhase | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  uploaded?: SessionFilePayload;
  /** Abort controller for the in-flight upload (cleared on terminal state). */
  abort?: AbortController;
};

const imageUploadReasonSet = new Set<ImageUploadReason>(IMAGE_UPLOAD_REASONS);

// uploadSessionImage throws plain Errors whose message embeds the HTTP status
// ("Upload failed with status 503"). Until the uploader attaches a structured
// status (see crossFileNeeds), parse it here so failures carry http_status
// without ever sending the raw, denylisted error_message.
const parseUploadHttpStatus = (error: unknown): number | null => {
  if (!(error instanceof Error)) return null;
  const match = /status\s+(\d{3})/i.exec(error.message);
  if (!match?.[1]) return null;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
};

const classifyImageUploadReason = (error: unknown): ImageUploadReason => {
  const status = parseUploadHttpStatus(error);
  if (status === 404) return 'session_not_found';
  if (status === 403) return 'session_archived';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('unsupported') || message.includes('invalid') || message.includes('empty')) {
    return 'validation_error';
  }
  return 'upload_error';
};

const toImageUploadReason = (value: ImageUploadReason): ImageUploadReason =>
  imageUploadReasonSet.has(value) ? value : 'unknown';

const sessionImageDraftsCache = new Map<SessionId, PendingImage[]>();
const sessionFileDraftsCache = new Map<SessionId, PendingFile[]>();
const sessionPastedTextDraftsCache = new Map<SessionId, PastedTextDraft[]>();

const getSessionImageDrafts = (sessionId: SessionId): PendingImage[] => [
  ...(sessionImageDraftsCache.get(sessionId) ?? []),
];

const getSessionFileDrafts = (sessionId: SessionId): PendingFile[] => [
  ...(sessionFileDraftsCache.get(sessionId) ?? []),
];

const setSessionFileDrafts = (
  sessionId: SessionId,
  files: readonly PendingFile[]
): PendingFile[] => {
  const next = [...files];
  if (next.length === 0) {
    sessionFileDraftsCache.delete(sessionId);
  } else {
    sessionFileDraftsCache.set(sessionId, next);
  }
  return next;
};

const abortPendingFileUploads = (files: readonly PendingFile[]): void => {
  for (const file of files) {
    file.abort?.abort();
  }
};

const getSessionPastedTextDrafts = (sessionId: SessionId): PastedTextDraft[] => [
  ...(sessionPastedTextDraftsCache.get(sessionId) ?? []),
];

/**
 * Mention ranges for the session's draft, kept beside its text.
 *
 * Same lifetime as the other draft caches — in memory, so it covers leaving the
 * session and coming back, which is where the ranges were being lost. It does
 * not survive a restart, but neither does the draft text here, so there is
 * nothing to restore them onto.
 */
const sessionMentionRangesCache = new Map<SessionId, PersistedMentionRange[]>();

const getSessionMentionRanges = (sessionId: SessionId): PersistedMentionRange[] => [
  ...(sessionMentionRangesCache.get(sessionId) ?? []),
];

const setSessionMentionRanges = (
  sessionId: SessionId,
  ranges: readonly PersistedMentionRange[]
): void => {
  if (ranges.length === 0) {
    sessionMentionRangesCache.delete(sessionId);
  } else {
    sessionMentionRangesCache.set(sessionId, [...ranges]);
  }
};

const setSessionImageDrafts = (
  sessionId: SessionId,
  images: readonly PendingImage[]
): PendingImage[] => {
  const next = [...images];
  if (next.length === 0) {
    sessionImageDraftsCache.delete(sessionId);
  } else {
    sessionImageDraftsCache.set(sessionId, next);
  }
  return next;
};

const setSessionPastedTextDrafts = (
  sessionId: SessionId,
  drafts: readonly PastedTextDraft[]
): PastedTextDraft[] => {
  const next = [...drafts];
  if (next.length === 0) {
    sessionPastedTextDraftsCache.delete(sessionId);
  } else {
    sessionPastedTextDraftsCache.set(sessionId, next);
  }
  return next;
};

const revokeImagePreviewUrls = (images: readonly Pick<PendingImage, 'previewUrl'>[]): void => {
  for (const image of images) {
    URL.revokeObjectURL(image.previewUrl);
  }
};

/**
 * Seed the composer text draft for a session that has not mounted yet. The
 * composer hydrates from this cache on mount, so callers can hand text across
 * a tab promotion without holding a ref to the future component.
 */
export const setSessionChatInputTextDraft = (sessionId: SessionId, text: string): void => {
  if (text) {
    sessionDraftsCache.set(sessionId, text);
  } else {
    sessionDraftsCache.delete(sessionId);
  }
};

export const clearSessionChatInputDrafts = (sessionId: SessionId): void => {
  const images = getSessionImageDrafts(sessionId);
  const files = getSessionFileDrafts(sessionId);
  sessionDraftsCache.delete(sessionId);
  sessionImageDraftsCache.delete(sessionId);
  sessionFileDraftsCache.delete(sessionId);
  sessionPastedTextDraftsCache.delete(sessionId);
  // The ranges belong to the text that was just cleared. Left behind, they land
  // on whatever the user types next at the old offsets.
  sessionMentionRangesCache.delete(sessionId);
  revokeImagePreviewUrls(images);
  abortPendingFileUploads(files);
};

const toImageInputBlock = (image: SessionImagePayload): SessionInputBlock => ({
  type: 'image',
  imageId: image.imageId,
  mimeType: image.mimeType,
  fileName: image.fileName,
  sizeBytes: image.sizeBytes,
  width: image.width,
  height: image.height,
});

const toFileInputBlock = (file: SessionFilePayload): SessionInputBlock => ({
  type: 'file',
  fileId: file.fileId,
  fileName: file.fileName,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
  sha256: file.sha256,
  textPreview: file.textPreview,
  transport: file.transport,
  ...(file.machineId === undefined ? {} : { machineId: file.machineId }),
  uploadedAt: file.uploadedAt,
});

const createLocalFileId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const createLocalImageId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export function getSessionChatInputAreaShellClassName({
  protectFromEdgeBackZone = false,
}: { protectFromEdgeBackZone?: boolean } = {}): string {
  return cn(
    'relative shrink-0 pt-0',
    /* The native session drawer owns a z-30 transparent left-edge swipe zone.
       Keep the whole mobile composer above it so the zone cannot swallow the
       left side of controls such as the attachment button. Swiping still works
       everywhere in the message body above the composer. */
    protectFromEdgeBackZone && 'z-40',
    /* On iOS Capacitor the WebView is NOT resized when the soft keyboard opens
       (`resize: "none"` + `interactive-widget=overlaps-content`). The root
       layout's `pb-[var(--native-keyboard-height)]` can't reach the session
       detail page because it renders inside a portal'd drawer, so the composer
       has to lift itself: `mb` raises it by the keyboard height (the flex-1
       message list above it shrinks to match), and the bottom padding collapses
       the home-indicator safe-area once the keyboard covers it.
       `--native-keyboard-height` is `0px` on web / Android, so both are a no-op
       there. */
    'mb-[var(--native-keyboard-height,0px)] transition-[margin-bottom] duration-[250ms] ease-out',
    'pb-[calc(0.5rem+max(0px,env(safe-area-inset-bottom,0px)-var(--native-keyboard-height,0px)))]',
    'bg-background'
  );
}

export interface SessionChatInputAreaProps {
  /** Claims a one-shot navigation focus request; absent for ordinary session visits. */
  claimNavigationFocus?: () => boolean;
  session: SessionMeta;
  sessionLocalProjectRootPath: string | null;
  isMachineRemoved: boolean;
  isAgentBusy: boolean;
  canStopAgent?: boolean;
  isExternalHistoryRefreshing?: boolean;
  externalHistorySyncLabel?: string;
  isDark: boolean;
  isEmptyConversation: boolean;
  selectedModeId: string | null;
  selectedModelId: string | null;
  /** Role identity restored from the latest accepted/queued Turn. */
  durableAgentRoleId?: AgentRoleId | null;
  durableAgentRoleRevision?: number;
  durableAgentRoleSourceTurnKey?: string;
  durableAgentRoleKnownTurnKeys?: readonly string[];
  /** False while this Session's durable document is still hydrating. */
  durableAgentRoleReady?: boolean;
  /** True when the composer run config differs through an unsent user edit. */
  runConfigHasUserEdits?: boolean;
  modeOptions: AcpSessionSelectOption[];
  modelOptions: AcpSessionSelectOption[];
  /** Subscription limits already resolved from this session's machine Flock data. */
  rateLimits?: MachineRateLimits;
  /**
   * Whether to offer the third-party Codex reset forecast, resolved by the
   * container from `canShowCodexResetForecast` with the session's full
   * `AgentConfigMeta`. It must be decided there, not here: this component only
   * sees `cliType`/`agentType`, which cannot tell a first-party Codex provider
   * from a Codex-compatible one pointed at another vendor via env or brand.
   * Defaults to hidden, so a container that has not resolved its config yet
   * never shows an OpenAI forecast beside someone else's quota.
   */
  showCodexResetForecast?: boolean;
  isContextCompacting?: boolean;
  /** Dynamic config option selectors from the agent's configOptions. */
  configOptionSelectors?: AcpConfigOptionSelector[];
  /** Current values for each configOption (configId → value). */
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  /** Whether the session's repo is public (for #mention feature) */
  isRepoPublic?: boolean;
  /** Available slash commands from the ACP agent. */
  availableCommands?: AcpCommandSummary[];
  /** False while this retained composer is hidden behind another session tab. */
  commandsEnabled?: boolean;
  freeTurnLimitNotice?: {
    current: number;
    limit: number;
    onUpgrade?: () => void;
  } | null;
  queueDisplay?: ReactNode;
  /** Per-turn MCP selection, rendered inside the composer's "+" menu. */
  mcp?: AttachmentAddMenuMcp;
  /** One-shot guard for a viewport resize caused by the composer auto-growing. */
  skipNextViewportResizeAutoScrollRef?: MutableRefObject<boolean>;
  onModeChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
  onSendMessage: (
    inputBlocks: SessionInputBlock[],
    agentRole: SessionTurnAgentRoleSelection
  ) => Promise<boolean>;
  onStop: () => void | Promise<void>;
  onRemoveQueueItem: (itemId: string) => Promise<void>;
  /** When provided and conversation is empty, the agent config badge becomes a selector. */
  onAgentConfigChange?: (selection: AgentSelection) => void;
  /**
   * New-Session surfaces may provide complete Role semantics. Existing
   * Sessions omit this and keep the same-agent-type run-config-only behavior.
   */
  agentRoleControl?: SessionAgentRoleControl;
  /** Receives durable Role editor saves owned by a new-Session surface. */
  onAgentRoleSaved?: (role: AgentRole, meta: { created: boolean }) => void;
  initialInputText?: string;
  onInputValueChange?: (value: string) => void;
  disableImageUpload?: boolean;
  /** Called when a comment reference chip is clicked to navigate to the comment */
  onNavigateToComment?: (reference: CommentReferencePayload) => void;
  /** Called whenever comment references currently attached to the input change. */
  onCommentReferencesChange?: (references: CommentReferencePayload[]) => void;
  /** Called whenever visual annotation references currently attached to the input change. */
  onVisualAnnotationReferencesChange?: (references: VisualAnnotationReferencePayload[]) => void;
  /** Called after a send containing visual annotation references is accepted. */
  onVisualAnnotationReferencesSubmitted?: (
    references: VisualAnnotationReferencePayload[]
  ) => void | Promise<void>;
}

export type SessionTurnAgentRoleSelection = ComposerTurnAgentRoleSelection;

export type SessionChatInputAreaHandle = {
  setInputText: (text: string) => void;
  focusInput: () => void;
  addCommentReference: (reference: CommentReferencePayload) => boolean;
  toggleCommentReference: (reference: CommentReferencePayload) => boolean;
  addVisualAnnotationReference: (reference: VisualAnnotationReferencePayload) => boolean;
  toggleVisualAnnotationReference: (reference: VisualAnnotationReferencePayload) => boolean;
  handleImageDrop: (files: File[]) => void;
  /**
   * Mention another conversation in this draft. Returns false when nothing was
   * written (archived draft, unknown/own session, already mentioned), so the
   * caller can leave the gesture unacknowledged instead of implying a change.
   */
  insertSessionMention: (sessionId: string) => boolean;
  /** Role identity committed in the currently rendered composer. */
  getAgentRoleSelection: (
    runConfigOverrides?: ComposerRunConfigOverrides
  ) => SessionTurnAgentRoleSelection;
};

export const SessionChatInputArea = memo(
  forwardRef<SessionChatInputAreaHandle, SessionChatInputAreaProps>(function SessionChatInputArea(
    {
      session,
      claimNavigationFocus,
      sessionLocalProjectRootPath,
      isMachineRemoved,
      canStopAgent = false,
      isExternalHistoryRefreshing = false,
      externalHistorySyncLabel,
      isDark,
      isEmptyConversation,
      selectedModeId,
      selectedModelId,
      durableAgentRoleId,
      durableAgentRoleRevision,
      durableAgentRoleSourceTurnKey,
      durableAgentRoleKnownTurnKeys,
      durableAgentRoleReady,
      runConfigHasUserEdits,
      modeOptions,
      modelOptions,
      rateLimits,
      showCodexResetForecast = false,
      isContextCompacting = false,
      configOptionSelectors,
      configOptionValues,
      isRepoPublic,
      availableCommands,
      commandsEnabled = true,
      freeTurnLimitNotice,
      queueDisplay,
      mcp,
      skipNextViewportResizeAutoScrollRef,
      onModeChange,
      onModelChange,
      onConfigOptionChange,
      onSendMessage,
      onStop,
      onRemoveQueueItem: _onRemoveQueueItem,
      onAgentConfigChange,
      agentRoleControl,
      onAgentRoleSaved,
      initialInputText,
      onInputValueChange,
      disableImageUpload = false,
      onNavigateToComment,
      onCommentReferencesChange,
      onVisualAnnotationReferencesChange,
      onVisualAnnotationReferencesSubmitted,
    }: SessionChatInputAreaProps,
    ref: React.ForwardedRef<SessionChatInputAreaHandle>
  ) {
    const { t, i18n } = useTranslation();
    const intlLocale = useMemo(
      () => toIntlLocale(i18n.resolvedLanguage ?? i18n.language),
      [i18n.language, i18n.resolvedLanguage]
    );
    const isMobile = useIsMobile();
    const mobileKeyboardAction = useAtomValue(mobileKeyboardActionAtom);
    const usesMobileKeyboardAction = isMobile || isNativeAppShell();
    const promptEnterKeyHint = resolveMobileKeyboardEnterKeyHint(
      mobileKeyboardAction,
      usesMobileKeyboardAction
    );
    const numberFormatter = useMemo(() => new Intl.NumberFormat(intlLocale), [intlLocale]);
    const localMachineId = useAtomValue(localMachineIdAtom);
    // Desktop local-transport fast path is available only when this very machine
    // runs the session's runtime (its machineId matches the local CLI's) and the
    // Electron preload bridge exposes the handoff API. Otherwise file attachments
    // take the default cloud-upload path. We never fabricate a "local" machineId;
    // if the session has none, the condition is simply false.
    const canSendFileLocally =
      !!localMachineId &&
      !!session.machineId &&
      localMachineId === session.machineId &&
      canUseElectronLocalFileSend();
    const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
    const workspaceRuntime = useAtomValue(runtimeAtom);
    const effectiveWorkspaceId = resolveEffectiveCodeCollabWorkspaceId({
      currentWorkspaceId: workspaceId,
      runtimeWorkspaceId: workspaceRuntime?.workspaceId,
    });
    const authToken = useAtomValue(authTokenAtom);
    const currentUser = useAtomValue(userAtom);
    const postHog = usePostHog();
    const isArchived = session.isArchived === true;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
      if (claimNavigationFocus?.() && !usesMobileKeyboardAction) {
        textareaRef.current?.focus({ preventScroll: true });
      }
    }, [claimNavigationFocus, usesMobileKeyboardAction]);
    const agentRoleTurnSelectionRef = useRef<SessionTurnAgentRoleSelection>(undefined);
    const selectedAgentRoleRef = useRef<AgentRole | undefined>(undefined);
    const agentRoleRunConfigRef = useRef({
      modeId: selectedModeId,
      modelId: selectedModelId,
      configOptionValues: configOptionValues ?? {},
    });
    const attachmentInputRef = useRef<HTMLInputElement>(null);
    const activeSessionIdRef = useRef(session.id);
    activeSessionIdRef.current = session.id;
    const [pendingImages, setPendingImages] = useState<PendingImage[]>(() =>
      getSessionImageDrafts(session.id)
    );
    const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(() =>
      getSessionFileDrafts(session.id)
    );
    const [pastedTextDrafts, setPastedTextDrafts] = useState<PastedTextDraft[]>(() =>
      getSessionPastedTextDrafts(session.id)
    );
    const [commentReferences, setCommentReferences] = useState<CommentReferenceChipItem[]>([]);
    const commentReferencesRef = useRef<CommentReferenceChipItem[]>([]);
    const commentRefIdCounter = useRef(0);
    const [visualAnnotationReferences, setVisualAnnotationReferences] = useState<
      VisualAnnotationReferenceChipItem[]
    >([]);
    const visualAnnotationReferencesRef = useRef<VisualAnnotationReferenceChipItem[]>([]);
    const visualAnnotationRefIdCounter = useRef(0);

    const publishCommentReferences = useCallback(
      (items: CommentReferenceChipItem[]) => {
        commentReferencesRef.current = items;
        setCommentReferences(items);
        onCommentReferencesChange?.(items.map((item) => item.reference));
      },
      [onCommentReferencesChange]
    );

    const createCommentReferenceLocalId = useCallback(
      () => `cref-${++commentRefIdCounter.current}`,
      []
    );

    const publishVisualAnnotationReferences = useCallback(
      (items: VisualAnnotationReferenceChipItem[]) => {
        visualAnnotationReferencesRef.current = items;
        setVisualAnnotationReferences(items);
        onVisualAnnotationReferencesChange?.(items.map((item) => item.reference));
      },
      [onVisualAnnotationReferencesChange]
    );

    const createVisualAnnotationReferenceLocalId = useCallback(
      () => `vref-${++visualAnnotationRefIdCounter.current}`,
      []
    );

    const addCommentReference = useCallback(
      (reference: CommentReferencePayload) => {
        if (isArchived) {
          return false;
        }
        const result = addCommentReferenceItem(
          commentReferencesRef.current,
          reference,
          createCommentReferenceLocalId
        );
        if (result.changed) {
          publishCommentReferences(result.items);
        }
        return result.selected;
      },
      [createCommentReferenceLocalId, isArchived, publishCommentReferences]
    );

    const toggleCommentReference = useCallback(
      (reference: CommentReferencePayload) => {
        if (isArchived) {
          return false;
        }
        const result = toggleCommentReferenceItem(
          commentReferencesRef.current,
          reference,
          createCommentReferenceLocalId
        );
        publishCommentReferences(result.items);
        return result.selected;
      },
      [createCommentReferenceLocalId, isArchived, publishCommentReferences]
    );

    const removeCommentReference = useCallback(
      (localId: string) => {
        publishCommentReferences(
          commentReferencesRef.current.filter((item) => item.localId !== localId)
        );
      },
      [publishCommentReferences]
    );

    const addVisualAnnotationReference = useCallback(
      (reference: VisualAnnotationReferencePayload) => {
        if (isArchived) {
          return false;
        }
        const result = addVisualAnnotationReferenceItem(
          visualAnnotationReferencesRef.current,
          reference,
          createVisualAnnotationReferenceLocalId
        );
        if (result.changed) {
          publishVisualAnnotationReferences(result.items);
        }
        return result.selected;
      },
      [createVisualAnnotationReferenceLocalId, isArchived, publishVisualAnnotationReferences]
    );

    const toggleVisualAnnotationReference = useCallback(
      (reference: VisualAnnotationReferencePayload) => {
        if (isArchived) {
          return false;
        }
        const result = toggleVisualAnnotationReferenceItem(
          visualAnnotationReferencesRef.current,
          reference,
          createVisualAnnotationReferenceLocalId
        );
        publishVisualAnnotationReferences(result.items);
        return result.selected;
      },
      [createVisualAnnotationReferenceLocalId, isArchived, publishVisualAnnotationReferences]
    );

    const removeVisualAnnotationReference = useCallback(
      (localId: string) => {
        publishVisualAnnotationReferences(
          visualAnnotationReferencesRef.current.filter((item) => item.localId !== localId)
        );
      },
      [publishVisualAnnotationReferences]
    );

    const imageUploadFailedLabel = t('sessions.imageUploadFailed', 'Image upload failed');
    const imageUploadMissingAuthLabel = t(
      'sessions.imageUploadMissingAuth',
      'Missing workspace or auth token'
    );
    const fileUploadFailedLabel = t('sessions.fileUploadFailed', 'File upload failed');
    const fileUploadMissingAuthLabel = t(
      'sessions.fileUploadMissingAuth',
      'Missing workspace or auth token'
    );
    const imageCountLimitLabel = t(
      'sessions.imageCountLimit',
      'At most {{count}} images are allowed',
      { count: SESSION_IMAGE_MAX_COUNT }
    );
    const imageSelectionSkippedLabel = t(
      'sessions.imageSelectionSkipped',
      'Some images were not added'
    );
    const showImageSelectionIssues = useCallback(
      (issues: string[]) => {
        if (issues.length === 0) {
          return;
        }

        const uniqueIssues = Array.from(new Set(issues));
        if (uniqueIssues.length === 1) {
          const [issue] = uniqueIssues;
          if (issue) {
            toast.error(issue);
          }
          return;
        }

        toast.error(imageSelectionSkippedLabel, {
          description: uniqueIssues.join(' · '),
        });
      },
      [imageSelectionSkippedLabel]
    );
    const sessionProjectKind =
      session.project?.kind === 'local'
        ? 'local'
        : session.project?.kind === 'github' || session.repoFullName
          ? 'github'
          : null;
    const sessionLocalProjectId =
      session.project?.kind === 'local' ? session.project.localProjectId : null;

    // Use local state with cache sync for draft persistence
    const [userInput, setUserInputState] = useState(
      () => sessionDraftsCache.get(session.id) ?? initialInputText ?? ''
    );
    // The visible draft can move into an in-flight submission immediately while
    // its actual state stays intact until the durable writer accepts it. A
    // rejected send simply reveals the preserved draft again.
    const { submissionPending, beginSubmission } = useComposerSubmission(session.id, textareaRef);
    const expandPromptMentionsRef = useRef<
      (args: MentionPromptExpansionArgs) => ExpandedMentionPrompt
    >(({ text }) => ({ text }));
    // Committed mention ranges, kept for the before-send rewrite. `@path` and
    // `#123` survive into the sent text unchanged, so the range is the only
    // record that the region was ever a mention.
    /**
     * A ref, not state, and the only copy the send path reads.
     *
     * It was state as well, which gave `sendMessage` a second source to close
     * over and get wrong two ways: the closure did not list it as a dependency,
     * so restoring a draft — where the ranges change but the text does not —
     * refreshed nothing and sent the pre-restore ranges; and switching sessions
     * reset the persisted seed without resetting it, so one session's ranges
     * could ride along into another's message. A ref has neither failure: it is
     * current by construction and costs `sendMessage` no re-creation, matching
     * `expandPromptMentionsRef` beside it.
     */
    const mentionRangesRef = useRef<MentionRange[]>([]);
    // Handle into the composer's mention machinery, for mentions that originate
    // outside it (a sidebar session dropped on the conversation).
    const mentionActionsRef = useRef<CombinedMentionTextareaHandle | null>(null);
    const [persistedMentionRanges, setPersistedMentionRanges] = useState<PersistedMentionRange[]>(
      () => getSessionMentionRanges(session.id)
    );
    const handleMentionRangesChange = useCallback(
      (ranges: MentionRange[]) => {
        mentionRangesRef.current = ranges;
        setSessionMentionRanges(session.id, toPersistedMentionRanges(ranges));
      },
      [session.id]
    );

    // Load new session's draft when session changes (during-render state adjustment)
    const [prevSessionId, setPrevSessionId] = useState(session.id);
    if (prevSessionId !== session.id) {
      setPrevSessionId(session.id);
      const cached = sessionDraftsCache.get(session.id) ?? initialInputText ?? '';
      setUserInputState(cached);
      setPendingImages(getSessionImageDrafts(session.id));
      setPendingFiles(getSessionFileDrafts(session.id));
      setPastedTextDrafts(getSessionPastedTextDrafts(session.id));
      setPersistedMentionRanges(getSessionMentionRanges(session.id));
      // Cleared with the rest of the draft: the incoming session's own ranges
      // arrive from its hydrators, and until they do there must be none.
      mentionRangesRef.current = [];
      commentReferencesRef.current = [];
      setCommentReferences([]);
      visualAnnotationReferencesRef.current = [];
      setVisualAnnotationReferences([]);
    }

    useEffect(() => {
      onCommentReferencesChange?.(commentReferencesRef.current.map((item) => item.reference));
      onVisualAnnotationReferencesChange?.(
        visualAnnotationReferencesRef.current.map((item) => item.reference)
      );
    }, [onCommentReferencesChange, onVisualAnnotationReferencesChange, session.id]);

    // Update both state and cache - use session.id from props (safe: callbacks
    // are re-created when session.id changes, so stale closures from a previous
    // session cannot write into the new session's cache entry)
    const setUserInput = useCallback(
      (value: string) => {
        setUserInputState(value);
        onInputValueChange?.(value);
        setSessionChatInputTextDraft(session.id, value);
      },
      [onInputValueChange, session.id]
    );

    const clearInput = useCallback(() => {
      setUserInput('');
    }, [setUserInput]);

    const clearPendingImages = useCallback(() => {
      const images = getSessionImageDrafts(session.id);
      sessionImageDraftsCache.delete(session.id);
      revokeImagePreviewUrls(images);
      if (activeSessionIdRef.current === session.id) {
        setPendingImages([]);
      }
    }, [session.id]);

    const updatePendingImagesForSession = useCallback(
      (
        targetSessionId: SessionId,
        updater: (images: readonly PendingImage[]) => PendingImage[]
      ) => {
        const next = setSessionImageDrafts(
          targetSessionId,
          updater(getSessionImageDrafts(targetSessionId))
        );
        if (activeSessionIdRef.current === targetSessionId) {
          setPendingImages(next);
        }
        return next;
      },
      []
    );

    const clearPendingFiles = useCallback(() => {
      const files = getSessionFileDrafts(session.id);
      sessionFileDraftsCache.delete(session.id);
      abortPendingFileUploads(files);
      if (activeSessionIdRef.current === session.id) {
        setPendingFiles([]);
      }
    }, [session.id]);

    const updatePendingFilesForSession = useCallback(
      (targetSessionId: SessionId, updater: (files: readonly PendingFile[]) => PendingFile[]) => {
        const next = setSessionFileDrafts(
          targetSessionId,
          updater(getSessionFileDrafts(targetSessionId))
        );
        if (activeSessionIdRef.current === targetSessionId) {
          setPendingFiles(next);
        }
        return next;
      },
      []
    );

    const updatePendingFile = useCallback(
      (
        targetSessionId: SessionId,
        localId: string,
        updater: (file: PendingFile) => PendingFile
      ) => {
        updatePendingFilesForSession(targetSessionId, (prev) =>
          prev.map((file) => (file.localId === localId ? updater(file) : file))
        );
      },
      [updatePendingFilesForSession]
    );

    const updatePastedTextDraftsForSession = useCallback(
      (
        targetSessionId: SessionId,
        updater: (drafts: readonly PastedTextDraft[]) => PastedTextDraft[]
      ) => {
        const next = setSessionPastedTextDrafts(
          targetSessionId,
          updater(getSessionPastedTextDrafts(targetSessionId))
        );
        if (activeSessionIdRef.current === targetSessionId) {
          setPastedTextDrafts(next);
        }
        return next;
      },
      []
    );
    const setInputText = useCallback(
      (value: string) => {
        if (isArchived) {
          return;
        }
        setUserInput(value);
        updatePastedTextDraftsForSession(session.id, () => []);
      },
      [isArchived, session.id, setUserInput, updatePastedTextDraftsForSession]
    );

    const updatePendingImage = useCallback(
      (
        targetSessionId: SessionId,
        localId: string,
        updater: (image: PendingImage) => PendingImage
      ) => {
        updatePendingImagesForSession(targetSessionId, (prev) =>
          prev.map((image) => (image.localId === localId ? updater(image) : image))
        );
      },
      [updatePendingImagesForSession]
    );

    const startUpload = useCallback(
      async (targetSessionId: SessionId, localId: string, file: File) => {
        if (!workspaceId || !authToken) {
          capturePostHogEvent(postHog, 'session/image_upload_failed', {
            channel: 'web',
            entrypoint: 'session_chat',
            actor: 'user',
            workspace_id: workspaceId ?? null,
            session_id: targetSessionId,
            image_count: 1,
            total_size_bytes: file.size,
            project_kind: sessionProjectKind,
            local_project_id: sessionLocalProjectId,
            failure_reason: 'missing_auth',
            reason_code: toImageUploadReason('missing_auth'),
            http_status: null,
          });
          updatePendingImage(targetSessionId, localId, (image) => ({
            ...image,
            status: 'failed',
            progress: 0,
            error: imageUploadMissingAuthLabel,
          }));
          return;
        }

        updatePendingImage(targetSessionId, localId, (image) => ({
          ...image,
          status: 'uploading',
          progress: 0,
          error: undefined,
        }));
        capturePostHogEvent(postHog, 'session/image_upload_requested', {
          channel: 'web',
          entrypoint: 'session_chat',
          actor: 'user',
          workspace_id: workspaceId,
          session_id: targetSessionId,
          image_count: 1,
          total_size_bytes: file.size,
          project_kind: sessionProjectKind,
          local_project_id: sessionLocalProjectId,
        });

        // Local-only upload timing (performance.now); not compared across clients.
        const uploadStartedAtMs = getPerformanceNowMs();

        try {
          const uploaded = await uploadSessionImage({
            workspaceId,
            sessionId: targetSessionId,
            token: authToken,
            file,
            onProgress: (progress) => {
              updatePendingImage(targetSessionId, localId, (image) => ({ ...image, progress }));
            },
          });
          updatePendingImage(targetSessionId, localId, (image) => ({
            ...image,
            status: 'uploaded',
            progress: 100,
            uploaded,
            error: undefined,
          }));
          capturePostHogEvent(postHog, 'session/image_upload_succeeded', {
            channel: 'web',
            entrypoint: 'session_chat',
            actor: 'user',
            workspace_id: workspaceId,
            session_id: targetSessionId,
            image_count: 1,
            total_size_bytes: file.size,
            project_kind: sessionProjectKind,
            local_project_id: sessionLocalProjectId,
            mime_type: uploaded.mimeType,
            upload_duration_ms: getDurationSinceMs(uploadStartedAtMs),
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : imageUploadFailedLabel;
          const reasonCode = toImageUploadReason(classifyImageUploadReason(error));
          if (
            canSendFileLocally &&
            session.machineId &&
            getSessionFileDrafts(targetSessionId).length < SESSION_FILE_MAX_COUNT
          ) {
            try {
              const outcome = await sendSessionFileToLocalRuntime({
                workspaceId,
                sessionId: targetSessionId,
                machineId: session.machineId,
                file,
              });
              const localFile = outcome?.ok ? outcome.files[0] : undefined;
              if (localFile) {
                updatePendingImagesForSession(targetSessionId, (prev) => {
                  const removed = prev.find((image) => image.localId === localId);
                  if (removed) {
                    URL.revokeObjectURL(removed.previewUrl);
                  }
                  return prev.filter((image) => image.localId !== localId);
                });
                updatePendingFilesForSession(targetSessionId, (prev) => [
                  ...prev,
                  {
                    localId: createLocalFileId(),
                    file,
                    status: 'uploaded',
                    progress: 100,
                    uploaded: localFile,
                  },
                ]);
                toast.info(
                  t(
                    'sessions.imageStoredAsLocalFile',
                    'Image upload is offline; added as a pending file attachment.'
                  )
                );
                capturePostHogEvent(postHog, 'session/image_upload_failed', {
                  channel: 'web',
                  entrypoint: 'session_chat',
                  actor: 'user',
                  workspace_id: workspaceId,
                  session_id: targetSessionId,
                  image_count: 1,
                  total_size_bytes: file.size,
                  project_kind: sessionProjectKind,
                  local_project_id: sessionLocalProjectId,
                  failure_reason: reasonCode,
                  reason_code: reasonCode,
                  http_status: parseUploadHttpStatus(error),
                  error_name: error instanceof Error ? error.name : typeof error,
                  upload_duration_ms: getDurationSinceMs(uploadStartedAtMs),
                  local_file_fallback: true,
                });
                return;
              }
            } catch {
              // Keep the original image upload failure visible.
            }
          }
          updatePendingImage(targetSessionId, localId, (image) => ({
            ...image,
            status: 'failed',
            progress: 0,
            error: errorMessage,
          }));
          capturePostHogEvent(postHog, 'session/image_upload_failed', {
            channel: 'web',
            entrypoint: 'session_chat',
            actor: 'user',
            workspace_id: workspaceId,
            session_id: targetSessionId,
            image_count: 1,
            total_size_bytes: file.size,
            project_kind: sessionProjectKind,
            local_project_id: sessionLocalProjectId,
            failure_reason: reasonCode,
            reason_code: reasonCode,
            http_status: parseUploadHttpStatus(error),
            error_name: error instanceof Error ? error.name : typeof error,
            upload_duration_ms: getDurationSinceMs(uploadStartedAtMs),
          });
        }
      },
      [
        authToken,
        canSendFileLocally,
        imageUploadFailedLabel,
        imageUploadMissingAuthLabel,
        postHog,
        session.machineId,
        sessionLocalProjectId,
        sessionProjectKind,
        updatePendingImage,
        updatePendingFilesForSession,
        updatePendingImagesForSession,
        t,
        workspaceId,
      ]
    );

    const startFileUpload = useCallback(
      async (targetSessionId: SessionId, localId: string, file: File) => {
        if (!workspaceId || !authToken) {
          updatePendingFile(targetSessionId, localId, (entry) => ({
            ...entry,
            status: 'failed',
            progress: 0,
            error: fileUploadMissingAuthLabel,
          }));
          return;
        }

        // Desktop local-transport fast path: hand bytes straight to the local CLI
        // (zero relay round trip). The CLI stores the blob and returns a
        // transport:'local' block, which we drop into `uploaded` exactly like a
        // cloud upload — the block then rides the outgoing message via
        // toFileInputBlock. No progress bar: the handoff completes in one step.
        // On any failure we fall through to the cloud path below.
        if (canSendFileLocally && session.machineId) {
          try {
            const outcome = await sendSessionFileToLocalRuntime({
              workspaceId,
              sessionId: targetSessionId,
              machineId: session.machineId,
              file,
            });
            if (outcome?.ok && outcome.files[0]) {
              updatePendingFile(targetSessionId, localId, (entry) => ({
                ...entry,
                status: 'uploaded',
                progress: 100,
                uploaded: outcome.files[0],
                error: undefined,
                abort: undefined,
              }));
              return;
            }
          } catch {
            // Local handoff threw; fall back to the cloud upload path.
          }
        }

        const abort = new AbortController();
        updatePendingFile(targetSessionId, localId, (entry) => ({
          ...entry,
          status: 'preparing',
          progress: 0,
          error: undefined,
          abort,
        }));

        try {
          // Compute the integrity hash + text-previewability once before upload;
          // both ride along to the server and the latter pre-fills the block.
          const [sha256, textPreview] = await Promise.all([
            computeSha256Hex(file, {
              signal: abort.signal,
              onProgress: (progress) => {
                updatePendingFile(targetSessionId, localId, (entry) => ({
                  ...entry,
                  status: progress.phase,
                  progress: progress.percent,
                }));
              },
            }),
            computeTextPreviewable(file),
          ]);
          const uploaded = await uploadSessionFile({
            workspaceId,
            sessionId: targetSessionId,
            token: authToken,
            file,
            sha256,
            textPreview,
            signal: abort.signal,
            onProgress: (progress: SessionFileUploadProgress) => {
              updatePendingFile(targetSessionId, localId, (entry) => ({
                ...entry,
                status: progress.phase,
                progress: progress.percent,
              }));
            },
          });
          updatePendingFile(targetSessionId, localId, (entry) => ({
            ...entry,
            status: 'uploaded',
            progress: 100,
            uploaded,
            error: undefined,
            abort: undefined,
          }));
        } catch (error) {
          if (isUploadAbortedError(error)) {
            // Removal/clearing aborts in-flight uploads; the entry is already
            // gone, so leave state untouched.
            return;
          }
          const errorMessage = error instanceof Error ? error.message : fileUploadFailedLabel;
          updatePendingFile(targetSessionId, localId, (entry) => ({
            ...entry,
            status: 'failed',
            progress: 0,
            error: errorMessage,
            abort: undefined,
          }));
        }
      },
      [
        authToken,
        canSendFileLocally,
        fileUploadFailedLabel,
        fileUploadMissingAuthLabel,
        session.machineId,
        updatePendingFile,
        workspaceId,
      ]
    );

    /** Enqueue a batch of non-image (or oversize-image) files as attachments. */
    const enqueueFileAttachments = useCallback(
      (files: File[]) => {
        if (isArchived || files.length === 0) {
          return;
        }
        const issues: string[] = [];
        const nextEntries: PendingFile[] = [];
        let currentCount = getSessionFileDrafts(session.id).length;
        for (const file of files) {
          if (currentCount >= SESSION_FILE_MAX_COUNT) {
            issues.push(
              t('sessions.fileCountLimit', 'At most {{count}} files are allowed', {
                count: SESSION_FILE_MAX_COUNT,
              })
            );
            continue;
          }
          const validationError = validateSessionFile(file);
          if (validationError) {
            issues.push(
              validationError === 'empty'
                ? t('sessions.fileEmpty', 'File is empty: {{name}}', { name: file.name })
                : t('sessions.fileTooLarge', 'File must be \u2264 {{max}}MB: {{name}}', {
                    max: SESSION_FILE_MAX_SIZE_MB,
                    name: file.name,
                  })
            );
            continue;
          }
          nextEntries.push({
            localId: createLocalFileId(),
            file,
            status: 'preparing',
            progress: 0,
          });
          currentCount += 1;
        }
        if (issues.length > 0) {
          toast.error(issues[0]!);
        }
        if (nextEntries.length === 0) {
          return;
        }
        updatePendingFilesForSession(session.id, (prev) => [...prev, ...nextEntries]);
        for (const entry of nextEntries) {
          void startFileUpload(session.id, entry.localId, entry.file);
        }
      },
      [isArchived, session.id, startFileUpload, t, updatePendingFilesForSession]
    );

    const handleAddFiles = useCallback(
      (files: File[], source: 'file_input' | 'electron_picker' | 'paste' | 'drop') => {
        if (isArchived) {
          return;
        }
        if (files.length === 0) {
          return;
        }

        const nextEntries: PendingImage[] = [];
        // Oversize images (>5 MiB) auto-degrade to file attachments rather than
        // being rejected (decision #2); they're collected and routed below.
        const oversizeImageFiles: File[] = [];
        const issues: string[] = [];
        let invalidCount = 0;
        let currentCount = pendingImages.length;

        for (const file of files) {
          if (currentCount >= SESSION_IMAGE_MAX_COUNT) {
            issues.push(imageCountLimitLabel);
            continue;
          }

          const isImage = file.type.startsWith('image/');
          if (isImage && file.size > SESSION_IMAGE_MAX_SIZE_BYTES) {
            oversizeImageFiles.push(file);
            continue;
          }

          const validationError = validateSessionImageFile(file);
          if (validationError) {
            invalidCount += 1;
            issues.push(validationError);
            continue;
          }

          const entry: PendingImage = {
            localId: createLocalImageId(),
            previewUrl: URL.createObjectURL(file),
            file,
            status: 'uploading',
            progress: 0,
          };
          nextEntries.push(entry);
          currentCount += 1;
        }

        if (oversizeImageFiles.length > 0) {
          toast.info(
            t(
              'sessions.imageDegradedToFile',
              '{{count}} large image(s) were added as file attachments',
              { count: oversizeImageFiles.length }
            )
          );
          enqueueFileAttachments(oversizeImageFiles);
        }

        if (nextEntries.length === 0) {
          capturePostHogEvent(postHog, 'session/image_files_selected', {
            entrypoint: 'session_chat',
            source,
            workspace_id: workspaceId ?? null,
            session_id: session.id,
            project_kind: sessionProjectKind,
            local_project_id: sessionLocalProjectId,
            requested_count: files.length,
            accepted_count: 0,
            invalid_count: invalidCount,
            skipped_by_limit: issues.includes(imageCountLimitLabel),
            pending_image_count_before: pendingImages.length,
          });
          showImageSelectionIssues(issues);
          return;
        }

        showImageSelectionIssues(issues);

        capturePostHogEvent(postHog, 'session/image_files_selected', {
          entrypoint: 'session_chat',
          source,
          workspace_id: workspaceId ?? null,
          session_id: session.id,
          project_kind: sessionProjectKind,
          local_project_id: sessionLocalProjectId,
          requested_count: files.length,
          accepted_count: nextEntries.length,
          invalid_count: invalidCount,
          skipped_by_limit: issues.includes(imageCountLimitLabel),
          pending_image_count_before: pendingImages.length,
        });
        updatePendingImagesForSession(session.id, (prev) => [...prev, ...nextEntries]);
        for (const entry of nextEntries) {
          void startUpload(session.id, entry.localId, entry.file);
        }
      },
      [
        enqueueFileAttachments,
        imageCountLimitLabel,
        isArchived,
        pendingImages.length,
        postHog,
        session.id,
        sessionLocalProjectId,
        sessionProjectKind,
        showImageSelectionIssues,
        startUpload,
        t,
        updatePendingImagesForSession,
        workspaceId,
      ]
    );

    const handleRemoveImage = useCallback(
      (localId: string) => {
        if (isArchived) {
          return;
        }
        const target = getSessionImageDrafts(session.id).find((item) => item.localId === localId);
        if (target) {
          capturePostHogEvent(postHog, 'session/image_draft_removed', {
            entrypoint: 'session_chat',
            workspace_id: workspaceId ?? null,
            session_id: session.id,
            project_kind: sessionProjectKind,
            local_project_id: sessionLocalProjectId,
            status: target.status,
          });
        }
        updatePendingImagesForSession(session.id, (prev) => {
          if (target) {
            revokeImagePreviewUrls([target]);
          }
          return prev.filter((item) => item.localId !== localId);
        });
      },
      [
        isArchived,
        postHog,
        session.id,
        sessionLocalProjectId,
        sessionProjectKind,
        updatePendingImagesForSession,
        workspaceId,
      ]
    );

    const handleRetryImage = useCallback(
      (localId: string) => {
        if (isArchived) {
          return;
        }
        const target = pendingImages.find((image) => image.localId === localId);
        if (!target) {
          return;
        }
        capturePostHogEvent(postHog, 'session/image_upload_retry_requested', {
          entrypoint: 'session_chat',
          workspace_id: workspaceId ?? null,
          session_id: session.id,
          project_kind: sessionProjectKind,
          local_project_id: sessionLocalProjectId,
          total_size_bytes: target.file.size,
        });
        void startUpload(session.id, localId, target.file);
      },
      [
        isArchived,
        pendingImages,
        postHog,
        session.id,
        sessionLocalProjectId,
        sessionProjectKind,
        startUpload,
        workspaceId,
      ]
    );

    const handleAttachmentInputChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        if (files.length > 0) {
          const { images: selectedImages, attachments: selectedAttachments } =
            splitImageAndFileAttachments(files);
          const images = disableImageUpload ? [] : selectedImages;
          const attachments = disableImageUpload ? files : selectedAttachments;
          if (images.length > 0) {
            handleAddFiles(images, 'file_input');
          }
          if (attachments.length > 0) {
            enqueueFileAttachments(attachments);
          }
        }
        event.target.value = '';
      },
      [disableImageUpload, enqueueFileAttachments, handleAddFiles]
    );

    const handleAttachmentAddClick = useCallback(() => {
      if (isArchived) {
        return;
      }
      attachmentInputRef.current?.click();
    }, [isArchived]);

    const handleRemoveFile = useCallback(
      (localId: string) => {
        if (isArchived) {
          return;
        }
        updatePendingFilesForSession(session.id, (prev) => {
          const target = prev.find((file) => file.localId === localId);
          target?.abort?.abort();
          return prev.filter((file) => file.localId !== localId);
        });
      },
      [isArchived, session.id, updatePendingFilesForSession]
    );

    const handleRetryFile = useCallback(
      (localId: string) => {
        if (isArchived) {
          return;
        }
        const target = getSessionFileDrafts(session.id).find((file) => file.localId === localId);
        if (!target) {
          return;
        }
        void startFileUpload(session.id, localId, target.file);
      },
      [isArchived, session.id, startFileUpload]
    );

    const insertLargePastedTextAtSelection = useCallback(
      (text: string) => {
        if (isArchived) {
          return false;
        }
        const normalizedText = normalizePastedTextDraft(text).trim();
        if (!normalizedText) {
          return false;
        }

        const currentValue = textareaRef.current?.value ?? userInput;
        const selectionStart = textareaRef.current?.selectionStart ?? null;
        const selectionEnd = textareaRef.current?.selectionEnd ?? null;
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

        setUserInput(result.nextValue);
        updatePastedTextDraftsForSession(session.id, (prev) =>
          getPastedTextDraftsAfterInsertion({
            drafts: prev,
            draft: result.draft,
            editStart: result.draft.start,
            editEnd,
          })
        );

        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(result.draft.end, result.draft.end);
        });

        return true;
      },
      [
        isArchived,
        numberFormatter,
        session.id,
        setUserInput,
        t,
        updatePastedTextDraftsForSession,
        userInput,
      ]
    );
    const handlePaste = useCallback(
      (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (isArchived) {
          return;
        }
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
          .filter((item): item is File => item !== null);

        if (pastedFiles.length === 0) {
          return;
        }

        event.preventDefault();
        // Images route through the image path (which auto-degrades oversize
        // ones); everything else is a file attachment.
        const { images: pastedImages, attachments: pastedAttachments } =
          splitImageAndFileAttachments(pastedFiles);
        const images = disableImageUpload ? [] : pastedImages;
        const attachments = disableImageUpload ? pastedFiles : pastedAttachments;
        if (images.length > 0) {
          handleAddFiles(images, 'paste');
        }
        if (attachments.length > 0) {
          enqueueFileAttachments(attachments);
        }
      },
      [
        disableImageUpload,
        enqueueFileAttachments,
        handleAddFiles,
        insertLargePastedTextAtSelection,
        isArchived,
      ]
    );
    const handleImageDrop = useCallback(
      (files: File[]) => {
        if (isArchived) {
          return;
        }
        const { images: droppedImages, attachments: droppedAttachments } =
          splitImageAndFileAttachments(files);
        const images = disableImageUpload ? [] : droppedImages;
        const attachments = disableImageUpload ? files : droppedAttachments;
        if (images.length > 0) {
          handleAddFiles(images, 'drop');
        }
        if (attachments.length > 0) {
          enqueueFileAttachments(attachments);
        }
      },
      [disableImageUpload, enqueueFileAttachments, handleAddFiles, isArchived]
    );

    const insertSessionMention = useCallback(
      (sessionId: string) => {
        if (isArchived) {
          return false;
        }
        return mentionActionsRef.current?.insertSessionMention(sessionId) ?? false;
      },
      [isArchived]
    );

    useImperativeHandle(
      ref,
      () => ({
        setInputText,
        focusInput: () => {
          textareaRef.current?.focus();
        },
        addCommentReference,
        toggleCommentReference,
        addVisualAnnotationReference,
        toggleVisualAnnotationReference,
        handleImageDrop,
        insertSessionMention,
        getAgentRoleSelection: (runConfigOverrides) =>
          resolveTurnAgentRoleForRunConfig({
            turnSelection: agentRoleTurnSelectionRef.current,
            role: selectedAgentRoleRef.current,
            current: agentRoleRunConfigRef.current,
            overrides: runConfigOverrides,
          }),
      }),
      [
        setInputText,
        addCommentReference,
        toggleCommentReference,
        addVisualAnnotationReference,
        toggleVisualAnnotationReference,
        handleImageDrop,
        insertSessionMention,
      ]
    );

    const handleInputChange = useCallback(
      (nextValue: string) => {
        if (isArchived) {
          return;
        }
        setUserInput(nextValue);
      },
      [isArchived, setUserInput]
    );
    const handlePastedTextDraftsChange = useCallback(
      (drafts: PastedTextDraft[]) => {
        updatePastedTextDraftsForSession(session.id, () =>
          arePastedTextDraftsEqual(pastedTextDrafts, drafts) ? pastedTextDrafts : drafts
        );
      },
      [pastedTextDrafts, session.id, updatePastedTextDraftsForSession]
    );

    const sendMessage = useCallback(async () => {
      if (freeTurnLimitNotice && freeTurnLimitNotice.current >= freeTurnLimitNotice.limit) {
        capturePostHogEvent(postHog, 'session/input_blocked', {
          reason: 'free_session_turn_limit_reached',
          entrypoint: 'session_chat',
          project_kind: sessionProjectKind,
          workspace_id: workspaceId ?? null,
          session_id: session.id,
        });
        return;
      }
      if (isArchived) {
        capturePostHogEvent(postHog, 'session/input_blocked', {
          reason: 'session_archived',
          entrypoint: 'session_chat',
          project_kind: sessionProjectKind,
          has_pending_images: pendingImages.length > 0,
          workspace_id: workspaceId ?? null,
          session_id: session.id,
        });
        return;
      }
      if (durableAgentRoleReady === false) {
        return;
      }
      if (isMachineRemoved) {
        capturePostHogEvent(postHog, 'session/input_blocked', {
          reason: 'machine_removed',
          entrypoint: 'session_chat',
          project_kind: sessionProjectKind,
          has_pending_images: pendingImages.length > 0,
          workspace_id: workspaceId ?? null,
          session_id: session.id,
        });
        return;
      }
      if (isExternalHistoryRefreshing) {
        capturePostHogEvent(postHog, 'session/input_blocked', {
          reason: 'external_history_syncing',
          entrypoint: 'session_chat',
          project_kind: sessionProjectKind,
          has_pending_images: pendingImages.length > 0,
          workspace_id: workspaceId ?? null,
          session_id: session.id,
        });
        return;
      }
      const currentValue = textareaRef.current?.value ?? userInput;
      // One pass: pasted placeholders, `$skill`, `@session:`, and the mentions
      // that need no rewrite all resolve against the same original text, and
      // the spans record where each landed.
      const expandedPrompt = expandPromptMentionsRef.current({
        text: currentValue,
        mentions: mentionRangesRef.current,
        pastedTextDrafts,
      });
      const trimmedPrompt = expandedPrompt.text.trim();
      // The trim moves every character left; re-anchor before the offsets ship.
      const trimmedSpans = reanchorMessageTextSpansForTrim(
        expandedPrompt.text,
        trimmedPrompt,
        expandedPrompt.spans
      );
      const textBlocks: SessionInputBlock[] = trimmedPrompt
        ? [
            {
              type: 'text',
              text: trimmedPrompt,
              ...(trimmedSpans ? { spans: trimmedSpans } : {}),
            },
          ]
        : [];
      const uploadedImages = pendingImages
        .filter((image): image is PendingImage & { uploaded: SessionImagePayload } => {
          return image.status === 'uploaded' && !!image.uploaded;
        })
        .map((image) => toImageInputBlock(image.uploaded));
      const hasBlockingImages = pendingImages.some((image) => image.status !== 'uploaded');
      // A still-uploading file (not failed) blocks send; failed ones are
      // skipped so a single failed attachment doesn't trap the message.
      const hasBlockingFiles = pendingFiles.some((file) => isSessionFileTransferPhase(file.status));
      const uploadedFiles = pendingFiles
        .filter((file): file is PendingFile & { uploaded: SessionFilePayload } => {
          return file.status === 'uploaded' && !!file.uploaded;
        })
        .map((file) => toFileInputBlock(file.uploaded));
      if (hasBlockingImages || hasBlockingFiles) {
        capturePostHogEvent(postHog, 'session/input_blocked', {
          reason: 'image_upload_in_progress',
          entrypoint: 'session_chat',
          project_kind: sessionProjectKind,
          has_pending_images: true,
          workspace_id: workspaceId ?? null,
          session_id: session.id,
        });
        return;
      }
      const commentRefBlocks: SessionInputBlock[] = commentReferencesRef.current.map((item) => ({
        type: 'comment_reference' as const,
        ...item.reference,
      }));
      const visualAnnotationRefBlocks: SessionInputBlock[] =
        visualAnnotationReferencesRef.current.map((item) => ({
          type: 'visual_annotation_reference' as const,
          ...item.reference,
        }));
      const submittedVisualAnnotationReferences = visualAnnotationReferencesRef.current.map(
        (item) => item.reference
      );

      if (
        textBlocks.length === 0 &&
        uploadedImages.length === 0 &&
        uploadedFiles.length === 0 &&
        commentRefBlocks.length === 0 &&
        visualAnnotationRefBlocks.length === 0
      ) {
        capturePostHogEvent(postHog, 'session/input_blocked', {
          reason: 'empty_input',
          entrypoint: 'session_chat',
          project_kind: sessionProjectKind,
          has_pending_images: false,
          workspace_id: workspaceId ?? null,
          session_id: session.id,
        });
        return;
      }

      const inputBlocks: SessionInputBlock[] = [
        ...commentRefBlocks,
        ...visualAnnotationRefBlocks,
        ...uploadedImages,
        ...uploadedFiles,
        ...textBlocks,
      ];
      const submittedDraft = {
        text: sessionDraftsCache.get(session.id),
        images: sessionImageDraftsCache.get(session.id),
        files: sessionFileDraftsCache.get(session.id),
        pastedText: sessionPastedTextDraftsCache.get(session.id),
      };
      const submission = beginSubmission({ dismissKeyboard: usesMobileKeyboardAction });
      if (!submission) return;
      try {
        const accepted = await onSendMessage(inputBlocks, agentRoleTurnSelectionRef.current);
        if (accepted) {
          if (submission.isCurrent()) {
            clearInput();
            clearPendingImages();
            clearPendingFiles();
            updatePastedTextDraftsForSession(session.id, () => []);
            publishCommentReferences([]);
            publishVisualAnnotationReferences([]);
          } else if (
            sessionDraftsCache.get(session.id) === submittedDraft.text &&
            sessionImageDraftsCache.get(session.id) === submittedDraft.images &&
            sessionFileDraftsCache.get(session.id) === submittedDraft.files &&
            sessionPastedTextDraftsCache.get(session.id) === submittedDraft.pastedText
          ) {
            // Acceptance retires the original cached draft even after unmount.
            // A later edit owns a different snapshot and must survive. Never
            // write component state from a retired submission.
            clearSessionChatInputDrafts(session.id);
          }
          if (submittedVisualAnnotationReferences.length > 0) {
            void onVisualAnnotationReferencesSubmitted?.(submittedVisualAnnotationReferences);
          }
        }
      } finally {
        submission.finish();
      }
    }, [
      beginSubmission,
      clearInput,
      clearPendingImages,
      clearPendingFiles,
      freeTurnLimitNotice,
      isArchived,
      durableAgentRoleReady,
      isExternalHistoryRefreshing,
      isMachineRemoved,
      onSendMessage,
      onVisualAnnotationReferencesSubmitted,
      pendingFiles,
      pendingImages,
      pastedTextDrafts,
      publishCommentReferences,
      publishVisualAnnotationReferences,
      postHog,
      session.id,
      sessionProjectKind,
      updatePastedTextDraftsForSession,
      userInput,
      usesMobileKeyboardAction,
      workspaceId,
    ]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== 'Enter' || isImeComposingKeyboardEvent(e)) {
          return;
        }
        if (
          !shouldSubmitOnEnterForMobileKeyboardAction({
            action: mobileKeyboardAction,
            isMobile: usesMobileKeyboardAction,
            shiftKey: e.shiftKey,
          })
        ) {
          return;
        }
        e.preventDefault();
        void sendMessage();
      },
      [mobileKeyboardAction, sendMessage, usesMobileKeyboardAction]
    );

    const hasDraft =
      userInput.trim().length > 0 ||
      pendingImages.length > 0 ||
      pendingFiles.length > 0 ||
      commentReferences.length > 0 ||
      visualAnnotationReferences.length > 0;
    const hasBlockingImages = pendingImages.some((image) => image.status !== 'uploaded');
    const hasUploadedImages = pendingImages.some((image) => image.status === 'uploaded');
    const hasBlockingFiles = pendingFiles.some((file) => isSessionFileTransferPhase(file.status));
    const hasUploadedFiles = pendingFiles.some((file) => file.status === 'uploaded');
    const hasSendableContent =
      userInput.trim().length > 0 ||
      hasUploadedImages ||
      hasUploadedFiles ||
      commentReferences.length > 0 ||
      visualAnnotationReferences.length > 0;
    const showStopButton = canStopAgent && !hasDraft && !isArchived;
    const isSendActionDisabled =
      submissionPending ||
      hasBlockingImages ||
      hasBlockingFiles ||
      isMachineRemoved ||
      isArchived ||
      isExternalHistoryRefreshing ||
      durableAgentRoleReady === false ||
      Boolean(freeTurnLimitNotice && freeTurnLimitNotice.current >= freeTurnLimitNotice.limit);
    const attachmentAddEnabled = !isArchived;
    const sessionLocalFileSource = useMemo(
      () =>
        resolveSessionLocalFileSource(session, {
          isElectronRenderer: typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true,
          localMachineId,
          workspaceId: effectiveWorkspaceId,
          localProjectRootPath: sessionLocalProjectRootPath,
        }),
      [effectiveWorkspaceId, localMachineId, session, sessionLocalProjectRootPath]
    );
    const repoFullName = useMemo(() => resolveSessionRepoFullName(session), [session]);
    const codeCollabRequestedRole = useCodeCollabRequestedRole();
    // Code Collab files live in the worktree owned by the top-level (parent)
    // session; child-session tabs share that same workspace. Look the space up
    // under the parent id so @ mentions read the owner-session v2 file tree.
    // Mirrors resolveSessionLocalFileSource and the session-detail file-tree
    // provider, which both key on the parent.
    const codeCollabSessionId = session.parentSessionId ?? session.id;
    const shouldEnableCodeCollabMentionProvider =
      Boolean(effectiveWorkspaceId) && userInput.includes('@');
    const codeCollabMentionFiles = useCodeCollabSessionFileProvider({
      workspaceId: effectiveWorkspaceId,
      sessionId: codeCollabSessionId,
      enabled: shouldEnableCodeCollabMentionProvider,
      requestedRole: codeCollabRequestedRole,
      machineId: session.machineId,
      requestedByUserId: currentUser?.id ?? session.userId,
      githubRepoFullName: repoFullName || null,
      debugLabel: 'session-chat-input:mention-provider',
    });
    const codeCollabMentionFilesPending =
      codeCollabMentionFiles.status === 'checking' || codeCollabMentionFiles.status === 'loading';
    const mentionSource = useMemo<MentionProjectSource | undefined>(() => {
      if (codeCollabMentionFiles.provider || codeCollabMentionFilesPending) {
        return {
          kind: 'provider',
          provider: codeCollabMentionFiles.provider,
          providerPending: codeCollabMentionFilesPending,
          providerMessage: codeCollabMentionFiles.message,
          localProject:
            session.project?.kind === 'local'
              ? {
                  machineId: session.machineId,
                  localProjectId: session.project.localProjectId,
                }
              : undefined,
          githubRepoFullName: repoFullName || undefined,
          isPublic: isRepoPublic,
        };
      }

      const localProject =
        session.project?.kind === 'local' && effectiveWorkspaceId
          ? {
              workspaceId: effectiveWorkspaceId,
              localProjectId: session.project.localProjectId,
            }
          : null;

      if (localProject && sessionLocalFileSource?.kind === 'session-worktree') {
        return {
          kind: 'local',
          machineId: session.machineId,
          workspaceId: localProject.workspaceId,
          localProjectId: localProject.localProjectId,
          githubRepoFullName: repoFullName || undefined,
          localWorktree: {
            machineId: session.machineId,
            repoKey: sessionLocalFileSource.repoKey,
            sessionId: sessionLocalFileSource.sessionId,
          },
        };
      }

      if (sessionLocalFileSource?.kind === 'local-project') {
        return {
          kind: 'local',
          machineId: session.machineId,
          workspaceId: sessionLocalFileSource.workspaceId,
          localProjectId: sessionLocalFileSource.localProjectId,
          githubRepoFullName: repoFullName || undefined,
        };
      }

      if (repoFullName) {
        return {
          kind: 'github',
          repoFullName,
          isPublic: isRepoPublic,
          localWorktree:
            sessionLocalFileSource?.kind === 'session-worktree'
              ? {
                  machineId: session.machineId,
                  repoKey: sessionLocalFileSource.repoKey,
                  sessionId: sessionLocalFileSource.sessionId,
                }
              : undefined,
        };
      }

      return undefined;
    }, [
      codeCollabMentionFiles.message,
      codeCollabMentionFiles.provider,
      codeCollabMentionFilesPending,
      isRepoPublic,
      repoFullName,
      effectiveWorkspaceId,
      session.machineId,
      session.project,
      sessionLocalFileSource,
    ]);
    const skillAgent = useMemo(
      () =>
        !isArchived && session.cliType && session.agentType
          ? {
              cliType: session.cliType,
              agentType: session.agentType,
              machineId: session.machineId,
            }
          : undefined,
      [isArchived, session.agentType, session.cliType, session.machineId]
    );
    const expandPromptMentions = useMentionPromptExpansion({
      source: isArchived ? undefined : mentionSource,
      skillAgent,
      promptValue: userInput,
    });
    expandPromptMentionsRef.current = expandPromptMentions;

    const tone = isDark ? 'dark' : 'light';
    // For non-archived sessions, ChatComposer auto-resolves the placeholder from
    // mentionSource + availableCommands; we only override when archived.
    const promptPlaceholder = isArchived ? t('sessions.archivedInputDisabled') : undefined;
    const imageItems = useMemo<ChatComposerImageItem[]>(
      () =>
        pendingImages.map((image) => ({
          id: image.localId,
          name: image.file.name,
          previewUrl: image.previewUrl,
          status: image.status,
          progress: image.progress,
          error: image.error,
        })),
      [pendingImages]
    );
    const fileItems = useMemo<ChatComposerFileItem[]>(
      () =>
        pendingFiles.map((file) => ({
          id: file.localId,
          name: file.file.name,
          sizeLabel: formatFileSize(file.file.size),
          status: file.status,
          progress: file.progress,
          error: file.error,
        })),
      [pendingFiles]
    );
    /* Mobile consolidates every run knob (model / reasoning / permission
       mode / agent / Plan / Fast) into ONE compact button that opens the
       run-config sheet — the footer just holds that button next to the +
       menu. Same control is used by the mobile new-chat sheet. */
    const mobileAgentSelection =
      session.agentConfigId && session.machineId
        ? { agentId: session.agentConfigId, machineId: session.machineId }
        : null;
    /* Existing Sessions use their exact machine/provider, run-config-only Role control.
       A not-yet-created child-tab draft supplies its own complete new-Session
       control instead. The row is NOT gated on `isEmptyConversation`: these
       values stay changeable every turn in an existing conversation too. */
    const [agentRoleEditor, setAgentRoleEditor] = useState<AgentRoleEditorState | null>(null);
    const { roles: accessibleAgentRoles } = useWorkspaceAgentRoles();
    const sessionAgentRole = useSessionAgentRole({
      sessionId: session.id,
      provenanceRoleId: session.agentRoleId,
      provenanceRoleRevision: session.agentRoleRevision,
      durableRoleId: durableAgentRoleId,
      durableRoleRevision: durableAgentRoleRevision,
      durableSourceTurnKey: durableAgentRoleSourceTurnKey,
      durableKnownSourceTurnKeys: durableAgentRoleKnownTurnKeys,
      durableRoleReady: durableAgentRoleReady,
      machineId: session.machineId,
      agentConfigId: session.agentConfigId,
      modelOptions,
      selectedModelId,
      onModelChange,
      modeOptions,
      selectedModeId,
      onModeChange,
      configOptionSelectors: configOptionSelectors ?? [],
      configOptionValues,
      runConfigHasUserEdits,
      onConfigOptionChange,
    });
    const effectiveAgentRoleControl = agentRoleControl ?? sessionAgentRole;
    const selectedAgentRoleItem = effectiveAgentRoleControl.selectedRoleId
      ? effectiveAgentRoleControl.items.find(
          (item) => item.role.id === effectiveAgentRoleControl.selectedRoleId
        )
      : undefined;
    const selectedAgentRoleItemId = selectedAgentRoleItem?.role.id;
    const selectedAgentRoleItemRevision = selectedAgentRoleItem?.role.revision;
    const agentRoleTurnSelection = useMemo<SessionTurnAgentRoleSelection>(
      () =>
        agentRoleControl
          ? selectedAgentRoleItemId && selectedAgentRoleItemRevision !== undefined
            ? {
                agentRoleId: selectedAgentRoleItemId,
                agentRoleRevision: selectedAgentRoleItemRevision,
              }
            : null
          : sessionAgentRole.turnSelection,
      [
        agentRoleControl,
        selectedAgentRoleItemId,
        selectedAgentRoleItemRevision,
        sessionAgentRole.turnSelection,
      ]
    );
    useLayoutEffect(() => {
      agentRoleTurnSelectionRef.current = agentRoleTurnSelection;
      selectedAgentRoleRef.current = selectedAgentRoleItem?.role;
      agentRoleRunConfigRef.current = {
        modeId: selectedModeId,
        modelId: selectedModelId,
        configOptionValues: configOptionValues ?? {},
      };
    }, [
      agentRoleTurnSelection,
      configOptionValues,
      selectedAgentRoleItem?.role,
      selectedModeId,
      selectedModelId,
    ]);
    const agentRolesProp = useMemo(
      () => ({
        items: effectiveAgentRoleControl.items,
        selectedRoleId: effectiveAgentRoleControl.selectedRoleId,
        onSelect: effectiveAgentRoleControl.onSelect,
        onCreate: () =>
          setAgentRoleEditor(
            openAgentRoleEditorForCreate(
              buildAgentRoleFormValueFromRunConfig({
                machineId: session.machineId,
                agentConfigId: session.agentConfigId,
                modeId: selectedModeId,
                modelId: modelOptions.length > 0 ? selectedModelId : null,
                configOptionValues,
              })
            )
          ),
      }),
      [
        configOptionValues,
        modelOptions.length,
        selectedModelId,
        selectedModeId,
        session.agentConfigId,
        session.machineId,
        effectiveAgentRoleControl,
      ]
    );
    const selectedAgentRolePinsPermissionMode = useMemo(() => {
      if (!effectiveAgentRoleControl.selectedRoleId) return false;
      const selectedRole = effectiveAgentRoleControl.items.find(
        (item) => item.role.id === effectiveAgentRoleControl.selectedRoleId
      )?.role;
      if (!selectedRole) return false;
      const { source } = resolvePermissionModeFace({
        modeOptions,
        selectedModeId,
        configOptionSelectors,
        configOptionValues,
      });
      return doesAgentRolePinPermissionMode(selectedRole, source);
    }, [
      configOptionSelectors,
      configOptionValues,
      modeOptions,
      selectedModeId,
      effectiveAgentRoleControl.items,
      effectiveAgentRoleControl.selectedRoleId,
    ]);
    const mobileFooterSelectorNode = isMobile ? (
      <MobileSessionRunConfig
        agentSelection={mobileAgentSelection}
        allowedMachineIds={session.machineId ? [session.machineId] : []}
        agentLocked={!isEmptyConversation}
        onAgentConfigChange={onAgentConfigChange}
        modelOptions={modelOptions}
        selectedModelId={selectedModelId}
        onModelChange={onModelChange}
        modeOptions={modeOptions}
        selectedModeId={selectedModeId}
        onModeChange={onModeChange}
        configOptionSelectors={configOptionSelectors}
        configOptionValues={configOptionValues}
        onConfigOptionChange={onConfigOptionChange}
        fallbackAgent={{ cliType: session.cliType, agentType: session.agentType }}
        agentRoles={agentRolesProp}
      />
    ) : null;
    const desktopAgentMachineIds = useMemo(
      () => (session.machineId ? [session.machineId] : undefined),
      [session.machineId]
    );
    /* Desktop mirrors the mobile consolidation with TWO buttons: one
       run-config dropdown (agent/model/reasoning submenus + Plan/Fast
       toggles) and a standalone permission-mode button showing the full
       mode name. The old bottom bar (machine chip + workdir + mode
       selectors) is gone — machine/workdir identity moved to the header
       "…" menu, so the composer is a single footer row. */
    const desktopFooterSelectorNode = !isMobile ? (
      <>
        <DesktopRunConfigMenu
          agentSelection={
            session.agentConfigId && session.machineId
              ? { agentId: session.agentConfigId, machineId: session.machineId }
              : null
          }
          allowedMachineIds={desktopAgentMachineIds}
          agentLocked={!isEmptyConversation}
          fallbackAgent={{ cliType: session.cliType, agentType: session.agentType }}
          onAgentConfigChange={onAgentConfigChange}
          modelOptions={modelOptions}
          selectedModelId={selectedModelId}
          onModelChange={onModelChange}
          configOptionSelectors={configOptionSelectors}
          configOptionValues={configOptionValues}
          onConfigOptionChange={onConfigOptionChange}
          modeOptions={modeOptions}
          selectedModeId={selectedModeId}
          agentRoles={agentRolesProp}
        />
        {selectedAgentRolePinsPermissionMode ? null : (
          <DesktopPermissionModeButton
            modeOptions={modeOptions}
            selectedModeId={selectedModeId}
            onModeChange={onModeChange}
            configOptionSelectors={configOptionSelectors}
            configOptionValues={configOptionValues}
            onConfigOptionChange={onConfigOptionChange}
          />
        )}
      </>
    ) : null;
    const selectedModelLabel = modelOptions.find(
      (option) => option.value === selectedModelId
    )?.label;
    const footerSelectorNode = (
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
        {/* Mobile: run-config button is w-full inside this flex-1 slot so the
            model label can shrink. Desktop: two trigger buttons sit natural-
            width with gap (fragment children of this flex row). */}
        <div
          className={
            isMobile
              ? 'min-w-0 flex-1 overflow-hidden'
              : 'flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden'
          }
        >
          {mobileFooterSelectorNode ?? desktopFooterSelectorNode}
        </div>
        <SessionUsagePopover
          contextWindowUsage={session.contextWindowUsage}
          rateLimits={rateLimits}
          agentType={session.agentType}
          modelId={selectedModelId}
          modelLabel={selectedModelLabel}
          isContextCompacting={isContextCompacting}
          showCodexResetForecast={showCodexResetForecast}
          className={isMobile ? 'h-8 shrink-0' : 'shrink-0'}
        />
      </div>
    );
    const bottomBarNode = null;
    const externalHistorySyncNode =
      isExternalHistoryRefreshing && externalHistorySyncLabel ? (
        <div className="mb-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span className="truncate">{externalHistorySyncLabel}</span>
        </div>
      ) : null;
    const freeTurnLimitNoticeNode = freeTurnLimitNotice ? (
      <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-950 shadow-xs dark:text-amber-100">
        <span>
          {t('sessions.freeTurnLimitNotice', {
            current: numberFormatter.format(freeTurnLimitNotice.current),
            limit: numberFormatter.format(freeTurnLimitNotice.limit),
          })}
        </span>
        {freeTurnLimitNotice.onUpgrade ? (
          <button
            type="button"
            className="font-semibold text-amber-700 underline underline-offset-2 hover:text-amber-800 dark:text-amber-200 dark:hover:text-amber-100"
            onClick={freeTurnLimitNotice.onUpgrade}
          >
            {t('sessions.freeTurnLimitUpgrade')}
          </button>
        ) : null}
      </div>
    ) : null;
    /* Keep desktop actions compact while preserving the mobile touch target. */
    const primaryActionSizeClassName = isMobile ? 'h-8 w-8' : 'h-7 w-7';
    const primaryActionNode = showStopButton ? (
      <Button
        onClick={() => {
          void onStop();
        }}
        variant="ghost"
        size="icon"
        aria-label={t('sessions.stop')}
        className={cn(
          primaryActionSizeClassName,
          'rounded-full shadow-xs transition-all',
          'bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px]'
        )}
      >
        <span
          className={cn('rounded-[3px] bg-current', isMobile ? 'h-3 w-3' : 'h-2.5 w-2.5')}
          aria-hidden="true"
        />
      </Button>
    ) : (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={() => void sendMessage()}
        disabled={!hasSendableContent || isSendActionDisabled}
        aria-label={
          isExternalHistoryRefreshing && externalHistorySyncLabel
            ? externalHistorySyncLabel
            : t('sessions.send')
        }
        className={cn(
          primaryActionSizeClassName,
          'rounded-full shadow-xs transition-all',
          'bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px]'
        )}
      >
        {submissionPending || hasBlockingImages || isExternalHistoryRefreshing ? (
          <Loader2 className={isMobile ? 'h-5 w-5 animate-spin' : 'h-4 w-4 animate-spin'} />
        ) : (
          <ArrowUp className={isMobile ? 'h-5 w-5' : 'h-4 w-4'} />
        )}
      </Button>
    );

    /* Mobile no longer inlines run-config pickers into the composer
       footer — that footer now holds a single `MobileSessionRunConfig`
       button that opens the run-config sheet (which owns its own picker
       coordinator). So the composer renders the same on both platforms. */
    const composerNode = (
      <ChatComposer
        tone={tone}
        variant="session"
        mentionSource={isArchived ? undefined : mentionSource}
        availableCommands={isArchived ? undefined : availableCommands}
        commandsEnabled={commandsEnabled}
        skillAgent={skillAgent}
        currentSessionId={session.id}
        promptRef={textareaRef}
        promptValue={submissionPending ? '' : userInput}
        onPromptChange={handleInputChange}
        onPromptKeyDown={handleKeyDown}
        onPromptPaste={handlePaste}
        onImageDrop={!submissionPending && attachmentAddEnabled ? handleImageDrop : undefined}
        // The dropzone accepts files AND images, so it must NOT inherit the
        // image-only disable (which trips at 8 pending images). Per-type count
        // limits are enforced inside handleImageDrop's handlers. Drops are only
        // blocked when the session is archived or the machine was removed;
        // a merely offline machine still accepts input (deferred execution).
        imageDropDisabled={submissionPending || isArchived || isMachineRemoved}
        promptPlaceholder={promptPlaceholder}
        promptDisabled={submissionPending || isArchived}
        promptRows={2}
        promptEnterKeyHint={promptEnterKeyHint}
        commentReferenceItems={submissionPending ? [] : commentReferences}
        onCommentReferenceRemove={
          submissionPending || isArchived ? undefined : removeCommentReference
        }
        onCommentReferenceClick={onNavigateToComment}
        revealCommentReferenceRemoveOnClick={isMobile}
        visualAnnotationReferenceItems={submissionPending ? [] : visualAnnotationReferences}
        onVisualAnnotationReferenceRemove={
          submissionPending || isArchived ? undefined : removeVisualAnnotationReference
        }
        pastedTextDrafts={submissionPending ? [] : pastedTextDrafts}
        onPastedTextDraftsChange={submissionPending ? undefined : handlePastedTextDraftsChange}
        onMentionRangesChange={handleMentionRangesChange}
        mentionActionsRef={mentionActionsRef}
        persistedMentions={persistedMentionRanges}
        // This composer switches sessions in place, so the draft's identity has
        // to travel with its text — otherwise the previous session's ranges stay
        // committed over the incoming draft.
        draftKey={session.id}
        imageItems={submissionPending ? [] : imageItems}
        attachmentAddDisabled={
          submissionPending ||
          isArchived ||
          isMachineRemoved ||
          (pendingFiles.length >= SESSION_FILE_MAX_COUNT &&
            (disableImageUpload || pendingImages.length >= SESSION_IMAGE_MAX_COUNT))
        }
        onAttachmentAddClick={attachmentAddEnabled ? handleAttachmentAddClick : undefined}
        onImageRemove={submissionPending || isArchived ? undefined : handleRemoveImage}
        onImageRetry={submissionPending || isArchived ? undefined : handleRetryImage}
        fileItems={submissionPending ? [] : fileItems}
        mcp={mcp}
        onFileRemove={submissionPending || isArchived ? undefined : handleRemoveFile}
        onFileRetry={submissionPending || isArchived ? undefined : handleRetryFile}
        footerSelector={footerSelectorNode}
        bottomBar={bottomBarNode}
        primaryAction={primaryActionNode}
        autoResize
        maxRows={11}
        skipNextViewportResizeAutoScrollRef={skipNextViewportResizeAutoScrollRef}
        focusOnContainerClick
      />
    );

    return (
      <div
        className={getSessionChatInputAreaShellClassName({
          protectFromEdgeBackZone: isMobile,
        })}
      >
        {/* The Role editor is a Dialog, so it is hosted OUT here rather than
            inside the run-config menu or the mobile drawer, where it would
            unmount with them the moment it opened. Mounted only while OPEN:
            it reads machine visibility, and the composer must stay renderable
            in hosts that do not provide that context. */}
        {agentRoleEditor ? (
          <AgentRoleEditorDialog
            editor={agentRoleEditor}
            accessibleRoles={accessibleAgentRoles}
            onChange={setAgentRoleEditor}
            onClose={() => setAgentRoleEditor(null)}
            onSaved={onAgentRoleSaved}
            source="session_composer"
          />
        ) : null}
        <ConversationColumn>
          <div aria-hidden="true" className="h-1" />
          {queueDisplay ? <div className="pb-2">{queueDisplay}</div> : null}
          {externalHistorySyncNode}
          {freeTurnLimitNoticeNode}
          {attachmentAddEnabled ? (
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleAttachmentInputChange}
            />
          ) : null}
          {composerNode}
        </ConversationColumn>
      </div>
    );
  })
);

SessionChatInputArea.displayName = 'SessionChatInputArea';
