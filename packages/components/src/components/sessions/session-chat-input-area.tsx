import { snapshotAgentRole } from '@lody/shared';
import { useSessionMentionSource } from '@/hooks/use-session-mention-source';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import {
  snapshotAttachmentDrafts,
  type SessionAttachmentDraft,
} from '@/lib/session-attachment-draft';
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
} from 'react';
import { useAtomValue } from 'jotai';
import { ArrowUp } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
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
import { useRunConfigFace } from '@/components/mobile/mobile-run-config-button';
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
import { getCommandKeybindings, useCommand } from '@/lib/commands';
import { usePostHog } from '@posthog/react';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { captureAgentRoleMentionsApplied } from '@/lib/agent-role-analytics';
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
import { ConversationColumn } from '@/components/shared/conversation-column';
import { useIsMobile } from '@/hooks/use-mobile';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import {
  currentWorkspaceIdAtom,
  mobileKeyboardActionAtom,
  queuedMessageBehaviorAtom,
  type QueuedMessageBehavior,
} from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms';
import { getDroppedFileLocalPath, toPathMentionInsertion } from '@/lib/dropped-local-path';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { toast } from '@/lib/toast';
import { validateSessionImageFile } from '@/lib/session-image-upload';
import {
  SESSION_FILE_MAX_SIZE_MB,
  validateSessionFile,
  type SessionFileTransferPhase,
} from '@/lib/session-file-upload';
import { formatFileSize } from '@/lib/session-file-presentation';
import { SESSION_FILE_MAX_COUNT, SESSION_IMAGE_MAX_SIZE_BYTES } from '@lody/shared';
import type { SessionFilePayload } from '@lody/shared';
import {
  arePastedTextDraftsEqual,
  createPastedTextFile,
  getPastedTextCharacterCount,
  getPastedTextDraftsAfterInsertion,
  insertPastedTextDraft,
  isPastedTextTooLarge,
  normalizePastedTextDraft,
  shouldCapturePastedTextDraft,
  type PastedTextDraft,
} from '@/lib/pasted-text-draft';
import { wrapPastedTextChipLabel } from '@/components/mentions/mention-chips';
import { toIntlLocale } from '@/lib/intl-locale';
import type { AgentSelection } from '@/components/shared/agent-selector';
import { isNativeAppShell } from '@/lib/native-platform';
import {
  resolveMobileKeyboardEnterKeyHint,
  shouldSubmitOnEnterForMobileKeyboardAction,
} from '@/lib/mobile-keyboard-action';
import { selectPastedClipboardFiles, splitImageAndFileAttachments } from '@/lib/file-drop';
import { isPlainLinkPasteShortcut, parseAppSessionUrl } from '@/lib/session-app-url';
import { SessionUsagePopover } from './session-usage-popover';
import type { MachineRateLimits } from '@/lib/session-usage';

const sessionDraftsCache = new Map<SessionId, string>();

const styles = stylex.create({
  shell: {
    position: 'relative',
    flexShrink: 0,
    paddingTop: 0,
    marginBottom: 'var(--native-keyboard-height, 0px)',
    paddingBottom:
      'calc(0.5rem + max(0px, env(safe-area-inset-bottom, 0px) - var(--native-keyboard-height, 0px)))',
    backgroundColor: colors.background,
    transitionProperty: 'margin-bottom',
    transitionDuration: '250ms',
    transitionTimingFunction: 'var(--ease-out, cubic-bezier(0, 0, 0.2, 1))',
  },
  shellEdgeBackLayer: { zIndex: 40 },
  footerSelectors: {
    display: 'flex',
    minWidth: 0,
    flex: '1 1 0%',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    overflow: 'hidden',
  },
  footerSelectorMobile: { minWidth: 0, flex: '1 1 0%', overflow: 'hidden' },
  footerSelectorDesktop: {
    display: 'flex',
    minWidth: 0,
    flex: '1 1 0%',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    overflow: 'hidden',
  },
  externalSync: {
    display: 'inline-flex',
    maxWidth: '100%',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    marginBottom: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    paddingInline: 'calc(var(--spacing) * 2)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'hsl(var(--muted) / 0.6)',
    color: colors.secondaryLabel,
    fontSize: '0.75rem',
    lineHeight: '1rem',
  },
  freeTurnNotice: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 'calc(var(--spacing) * 1.5)',
    rowGap: 'calc(var(--spacing) * 1)',
    marginBottom: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    paddingInline: 'calc(var(--spacing) * 3)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor:
      'color-mix(in oklab, var(--color-amber-500, oklch(76.9% 0.188 70.08)) 30%, transparent)',
    borderRadius: 'var(--radius-lg)',
    backgroundColor:
      'color-mix(in oklab, var(--color-amber-500, oklch(76.9% 0.188 70.08)) 10%, transparent)',
    color: {
      default: 'var(--color-amber-950, oklch(27.9% 0.077 45.635))',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'var(--color-amber-100, oklch(96.2% 0.059 95.617))',
    },
    fontSize: '0.75rem',
    fontWeight: 500,
    lineHeight: '1rem',
    boxShadow: '0 1px 2px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.05))',
  },
  freeTurnUpgrade: {
    fontWeight: 600,
    color: {
      default: 'var(--color-amber-700, oklch(55.5% 0.163 48.998))',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'var(--color-amber-200, oklch(92.4% 0.12 95.746))',
      '@media (hover: hover)': {
        ':hover': 'var(--color-amber-800, oklch(47.3% 0.137 46.201))',
        ':hover:where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
          'var(--color-amber-100, oklch(96.2% 0.059 95.617))',
      },
    },
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
  },
  stopGlyph: {
    borderRadius: '3px',
    backgroundColor: 'currentColor',
  },
  stopGlyphMobile: { width: 'calc(var(--spacing) * 3)', height: 'calc(var(--spacing) * 3)' },
  stopGlyphDesktop: { width: 'calc(var(--spacing) * 2.5)', height: 'calc(var(--spacing) * 2.5)' },
  sendIconMobile: { width: 'calc(var(--spacing) * 5)', height: 'calc(var(--spacing) * 5)' },
  sendIconDesktop: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  topSpacer: { height: 'calc(var(--spacing) * 1)' },
  hiddenInput: { display: 'none' },
  externalSyncLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

type PendingImage = {
  localId: string;
  previewUrl: string;
  file: File;
  status: 'draft' | 'uploading' | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  uploaded?: SessionImagePayload;
  abort?: AbortController;
};

type PendingFile = {
  localId: string;
  file: File;
  status: 'draft' | SessionFileTransferPhase | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  uploaded?: SessionFilePayload;
  /** Abort controller for the in-flight upload (cleared on terminal state). */
  abort?: AbortController;
};

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

const revokeImagePreviewUrls = (
  images: readonly Pick<PendingImage, 'previewUrl' | 'abort'>[]
): void => {
  for (const image of images) {
    image.abort?.abort();
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
  const shell = stylex.props(
    styles.shell,
    // The native session drawer owns a z-30 transparent left-edge swipe zone.
    // Keep the composer above it so the zone cannot swallow its controls.
    protectFromEdgeBackZone && styles.shellEdgeBackLayer
  );
  return shell.className ?? '';
}

export interface SessionChatInputAreaProps {
  /** Claims a one-shot navigation focus request; absent for ordinary session visits. */
  claimNavigationFocus?: () => boolean;
  session: SessionMeta;
  isVisible?: boolean;
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
  /** Per-turn MCP selection, rendered inside the composer's "+" menu. */
  mcp?: AttachmentAddMenuMcp;
  /**
   * The host owns the gap above the composer (the session page's info bar,
   * which may stack the queue directly on the composer), so skip the spacer.
   */
  hideTopSpacer?: boolean;
  onModeChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
  onSendMessage: (
    inputBlocks: SessionInputBlock[],
    agentRole: SessionTurnAgentRoleSelection,
    options?: SessionSendMessageOptions
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

export type SessionSendMessageOptions = {
  attachments?: SessionAttachmentDraft[];
  /** Replaces the configured busy-send behavior (queue or steer) for this send. */
  submitBehavior?: QueuedMessageBehavior;
};

export type SessionChatInputAreaHandle = {
  setInputText: (text: string) => void;
  focusInput: () => void;
  addCommentReference: (reference: CommentReferencePayload) => boolean;
  toggleCommentReference: (reference: CommentReferencePayload) => boolean;
  addVisualAnnotationReference: (reference: VisualAnnotationReferencePayload) => boolean;
  toggleVisualAnnotationReference: (reference: VisualAnnotationReferencePayload) => boolean;
  handleImageDrop: (files: File[]) => void;
  /** Folders dropped from the OS; each becomes a `@<absolute path>` mention. */
  handleDirectoryDrop: (directories: File[]) => void;
  /**
   * Mention another conversation in this draft. Returns false when nothing was
   * written (archived draft, unknown/own session, already mentioned), so the
   * caller can leave the gesture unacknowledged instead of implying a change.
   */
  insertSessionMention: (
    sessionId: string,
    options?: { at?: number; replaceEnd?: number }
  ) => boolean;
  /** Role identity committed in the currently rendered composer. */
  getAgentRoleSelection: (
    runConfigOverrides?: ComposerRunConfigOverrides
  ) => SessionTurnAgentRoleSelection;
};

export const SessionChatInputArea = memo(
  forwardRef<SessionChatInputAreaHandle, SessionChatInputAreaProps>(function SessionChatInputArea(
    {
      session,
      isVisible = true,
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
      hideTopSpacer = false,
      freeTurnLimitNotice,
      mcp,
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
    const queuedMessageBehavior = useAtomValue(queuedMessageBehaviorAtom);
    const usesMobileKeyboardAction = isMobile || isNativeAppShell();
    const promptEnterKeyHint = resolveMobileKeyboardEnterKeyHint(
      mobileKeyboardAction,
      usesMobileKeyboardAction
    );
    const numberFormatter = useMemo(() => new Intl.NumberFormat(intlLocale), [intlLocale]);
    const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
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
    /** Readable Roles, for attributing accepted `@Role` mentions in analytics. */
    const workspaceAgentRolesRef = useRef<readonly AgentRole[]>([]);
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
            status: 'draft',
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
      },
      [isArchived, session.id, t, updatePendingFilesForSession]
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
            status: 'draft',
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
        updatePendingImage(session.id, localId, (item) => ({
          ...item,
          status: 'draft',
          error: undefined,
        }));
      },
      [
        updatePendingImage,
        isArchived,
        pendingImages,
        postHog,
        session.id,
        sessionLocalProjectId,
        sessionProjectKind,
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
        updatePendingFile(session.id, localId, (item) => ({
          ...item,
          status: 'draft',
          error: undefined,
        }));
      },
      [isArchived, session.id, updatePendingFile]
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
    const attachPastedFiles = useCallback(
      (files: File[]) => {
        // Images route through the image path (which auto-degrades oversize
        // ones); everything else is a file attachment.
        const { images: pastedImages, attachments: pastedAttachments } =
          splitImageAndFileAttachments(files);
        const images = disableImageUpload ? [] : pastedImages;
        const attachments = disableImageUpload ? files : pastedAttachments;
        if (images.length > 0) {
          handleAddFiles(images, 'paste');
        }
        if (attachments.length > 0) {
          enqueueFileAttachments(attachments);
        }
      },
      [disableImageUpload, enqueueFileAttachments, handleAddFiles]
    );
    const insertSessionMention = useCallback(
      (sessionId: string, options?: { at?: number; replaceEnd?: number }) => {
        if (isArchived) {
          return false;
        }
        return mentionActionsRef.current?.insertSessionMention(sessionId, options) ?? false;
      },
      [isArchived]
    );
    const handlePaste = useCallback(
      (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (isArchived) {
          return;
        }
        const text = event.clipboardData.getData('text/plain');

        // Cmd/Ctrl+Shift+V keeps a conversation URL as a plain link.
        const sessionUrl = text ? parseAppSessionUrl(text) : null;
        if (sessionUrl) {
          if (isPlainLinkPasteShortcut(event)) {
            capturePostHogEvent(postHog, 'mention/session_link_pasted', {
              converted: false,
              surface: 'session_chat',
            });
          } else {
            const target = event.currentTarget;
            const at = target.selectionStart ?? target.value.length;
            const replaceEnd = target.selectionEnd ?? at;
            if (insertSessionMention(sessionUrl.sessionId, { at, replaceEnd })) {
              capturePostHogEvent(postHog, 'mention/session_link_pasted', {
                converted: true,
                surface: 'session_chat',
              });
              event.preventDefault();
              return;
            }
          }
        }

        const pastedTextFile =
          text && isPastedTextTooLarge(text) ? createPastedTextFile(text) : null;

        if (pastedTextFile) {
          event.preventDefault();
        } else if (text && shouldCapturePastedTextDraft(text)) {
          event.preventDefault();
          insertLargePastedTextAtSelection(text);
        }

        const clipboardFiles = Array.from(event.clipboardData.items)
          .filter((item) => item.kind === 'file')
          .map((item) => item.getAsFile())
          .filter((item): item is File => item !== null);
        // A Word or PowerPoint copy carries a picture of the selection beside
        // the text, so attaching every clipboard file turned those pastes into
        // a screenshot of themselves.
        const { files: pastedFiles, renderedImages } = selectPastedClipboardFiles({
          text,
          files: clipboardFiles,
        });

        if (renderedImages.length > 0) {
          toast(t('composer.pastedRichTextAsText', 'Pasted as text'), {
            // One id, so pasting repeatedly replaces the hint instead of stacking it.
            id: 'composer-pasted-rich-text-as-text',
            action: {
              label: t('composer.pastedRichTextAttachImage', 'Attach image'),
              onClick: () => attachPastedFiles(renderedImages),
            },
          });
        }

        const filesToAttach = pastedTextFile ? [pastedTextFile, ...pastedFiles] : pastedFiles;
        if (filesToAttach.length > 0) {
          event.preventDefault();
          attachPastedFiles(filesToAttach);
          return;
        }

        if (pastedTextFile) return;
      },
      [
        attachPastedFiles,
        insertLargePastedTextAtSelection,
        insertSessionMention,
        isArchived,
        postHog,
        t,
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
    const handleDirectoryDrop = useCallback(
      (directories: File[]) => {
        if (isArchived) {
          return;
        }
        const insertions = directories.flatMap((directory) => {
          const localPath = getDroppedFileLocalPath(directory);
          return localPath ? [toPathMentionInsertion(localPath, 'dir')] : [];
        });
        mentionActionsRef.current?.insertPathMentions(insertions);
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
        handleDirectoryDrop,
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
        handleDirectoryDrop,
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

    const sendMessage = useCallback(
      async (options?: SessionSendMessageOptions) => {
        if (!isVisible) return;
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
        const attachments = snapshotAttachmentDrafts(pendingImages, pendingFiles);
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
          pendingImages.length === 0 &&
          pendingFiles.length === 0 &&
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

        const submittedDraft = {
          text: sessionDraftsCache.get(session.id),
          images: sessionImageDraftsCache.get(session.id),
          files: sessionFileDraftsCache.get(session.id),
          pastedText: sessionPastedTextDraftsCache.get(session.id),
          comments: commentReferencesRef.current,
          annotations: visualAnnotationReferencesRef.current,
        };
        const submission = beginSubmission({ dismissKeyboard: usesMobileKeyboardAction });
        if (!submission) return;
        try {
          const images = pendingImages;
          const files = pendingFiles;
          const inputBlocks: SessionInputBlock[] = [
            ...commentRefBlocks,
            ...visualAnnotationRefBlocks,
            ...images.flatMap((image) =>
              image.status === 'uploaded' && image.uploaded
                ? [toImageInputBlock(image.uploaded)]
                : []
            ),
            ...files.flatMap((file) =>
              file.status === 'uploaded' && file.uploaded ? [toFileInputBlock(file.uploaded)] : []
            ),
            ...textBlocks,
          ];
          submittedDraft.images = sessionImageDraftsCache.get(session.id);
          submittedDraft.files = sessionFileDraftsCache.get(session.id);
          // Use the committed callback and Role after waiting: routing and run
          // config must come from the same current composer state.
          const accepted = await onSendMessage(inputBlocks, agentRoleTurnSelectionRef.current, {
            ...options,
            attachments,
          });
          if (accepted) {
            captureAgentRoleMentionsApplied(postHog, {
              spans: trimmedSpans,
              roles: workspaceAgentRolesRef.current,
              executionMachineId: session.machineId,
            });
            if (submission.isCurrent()) {
              // External actions can replace a disabled draft while acceptance is pending.
              // Retire only the fields that still belong to this accepted submission.
              if (sessionDraftsCache.get(session.id) === submittedDraft.text) clearInput();
              if (sessionImageDraftsCache.get(session.id) === submittedDraft.images)
                clearPendingImages();
              if (sessionFileDraftsCache.get(session.id) === submittedDraft.files)
                clearPendingFiles();
              if (sessionPastedTextDraftsCache.get(session.id) === submittedDraft.pastedText)
                updatePastedTextDraftsForSession(session.id, () => []);
              if (commentReferencesRef.current === submittedDraft.comments)
                publishCommentReferences([]);
              if (visualAnnotationReferencesRef.current === submittedDraft.annotations)
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
      },
      [
        beginSubmission,
        onSendMessage,
        clearInput,
        clearPendingImages,
        clearPendingFiles,
        freeTurnLimitNotice,
        isArchived,
        durableAgentRoleReady,
        isExternalHistoryRefreshing,
        isMachineRemoved,
        isVisible,
        onVisualAnnotationReferencesSubmitted,
        pendingFiles,
        pendingImages,
        pastedTextDrafts,
        publishCommentReferences,
        publishVisualAnnotationReferences,
        postHog,
        session.id,
        session.machineId,
        sessionProjectKind,
        updatePastedTextDraftsForSession,
        userInput,
        usesMobileKeyboardAction,
        workspaceId,
      ]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // A rebound app shortcut (e.g. Send and Steer on Mod+Enter) already handled it.
        if (e.key !== 'Enter' || e.defaultPrevented || isImeComposingKeyboardEvent(e)) {
          return;
        }
        // Mod+Shift+Enter sends through the opposite busy-send behavior:
        // a queue default steers, a steer default queues.
        if (e.shiftKey && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void sendMessage({
            submitBehavior: queuedMessageBehavior === 'guide' ? 'queue' : 'guide',
          });
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
      [mobileKeyboardAction, queuedMessageBehavior, sendMessage, usesMobileKeyboardAction]
    );

    // Only the focused composer owns the binding, so a user binding such as Mod+Enter
    // keeps its meaning in other text fields and never sends a draft the user can't see.
    // An open mention menu keeps a rebound plain Enter for selecting its item.
    useCommand(
      {
        id: 'session.sendSteer',
        title: t('commands.session.sendSteer', 'Send and Steer'),
        category: 'Session',
        keybindings: getCommandKeybindings('session.sendSteer'),
        when: () => {
          const textarea = textareaRef.current;
          return (
            textarea !== null &&
            document.activeElement === textarea &&
            textarea.getAttribute('aria-expanded') !== 'true'
          );
        },
        run: () => void sendMessage({ submitBehavior: 'guide' }),
      },
      isVisible
    );

    const hasDraft =
      userInput.trim().length > 0 ||
      pendingImages.length > 0 ||
      pendingFiles.length > 0 ||
      commentReferences.length > 0 ||
      visualAnnotationReferences.length > 0;

    const hasUploadedImages = pendingImages.length > 0;
    const hasUploadedFiles = pendingFiles.length > 0;
    const hasSendableContent =
      userInput.trim().length > 0 ||
      hasUploadedImages ||
      hasUploadedFiles ||
      commentReferences.length > 0 ||
      visualAnnotationReferences.length > 0;
    const showStopButton = canStopAgent && !hasDraft && !isArchived;
    const isSendActionDisabled =
      !isVisible ||
      submissionPending ||
      isMachineRemoved ||
      isArchived ||
      isExternalHistoryRefreshing ||
      durableAgentRoleReady === false ||
      Boolean(freeTurnLimitNotice && freeTurnLimitNotice.current >= freeTurnLimitNotice.limit);
    const attachmentAddEnabled = !isArchived;
    const mentionSource = useSessionMentionSource({
      session,
      sessionLocalProjectRootPath,
      isRepoPublic,
      // No index is borrowed until someone could actually type `@`.
      enableCodeCollabProvider: userInput.includes('@'),
      debugLabel: 'session-chat-input:mention-provider',
    });
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
    const { expand: expandPromptMentions } = useMentionPromptExpansion({
      source: isArchived ? undefined : mentionSource,
      skillAgent,
      promptValue: userInput,
      currentSessionId: session.id,
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
    workspaceAgentRolesRef.current = accessibleAgentRoles;
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
    const agentConfigs = useAtomValue(getAllAgentConfigAtom);
    const compactPlaceholderName =
      selectedAgentRoleItem?.role.name ??
      agentConfigs.find((config) => config.id === session.agentConfigId)?.name ??
      null;
    const selectedAgentRoleItemId = selectedAgentRoleItem?.role.id;
    const selectedAgentRoleItemRevision = selectedAgentRoleItem?.role.revision;
    const agentRoleTurnSelection = useMemo<SessionTurnAgentRoleSelection>(
      () =>
        agentRoleControl
          ? selectedAgentRoleItemId && selectedAgentRoleItemRevision !== undefined
            ? {
                agentRoleId: selectedAgentRoleItemId,
                agentRoleRevision: selectedAgentRoleItemRevision,
                memory: selectedAgentRoleItem?.role.runConfig.memory,
                agentRoleSnapshot: selectedAgentRoleItem
                  ? snapshotAgentRole(selectedAgentRoleItem.role)
                  : undefined,
              }
            : null
          : sessionAgentRole.turnSelection,
      [
        agentRoleControl,
        selectedAgentRoleItemId,
        selectedAgentRoleItemRevision,
        selectedAgentRoleItem,
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
        disabled={submissionPending}
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
          disabledReason={
            submissionPending
              ? t('sessions.sendConfigLocked', 'Configuration is locked while sending')
              : undefined
          }
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
            disabled={submissionPending}
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
    const { modelLabel: selectedModelLabel } = useRunConfigFace({
      modelOptions,
      selectedModelId,
      modeOptions,
      selectedModeId,
      configOptionSelectors,
      configOptionValues,
    });
    const footerSelectorNode = (
      <div {...stylex.props(styles.footerSelectors)}>
        {/* Mobile: run-config button is w-full inside this flex-1 slot so the
            model label can shrink. Desktop: two trigger buttons sit natural-
            width with gap (fragment children of this flex row). */}
        <div
          {...stylex.props(isMobile ? styles.footerSelectorMobile : styles.footerSelectorDesktop)}
        >
          {mobileFooterSelectorNode ?? desktopFooterSelectorNode}
        </div>
        <SessionUsagePopover
          contextWindowUsage={session.contextWindowUsage}
          rateLimits={rateLimits}
          agentType={session.agentType}
          agentConfigId={session.agentConfigId}
          modelId={selectedModelId}
          modelLabel={selectedModelLabel}
          isContextCompacting={isContextCompacting}
          showRateLimitWithoutContext
          showCodexResetForecast={showCodexResetForecast}
          className={isMobile ? 'h-8 shrink-0' : 'shrink-0'}
        />
      </div>
    );
    const bottomBarNode = null;
    const externalHistorySyncNode =
      isExternalHistoryRefreshing && externalHistorySyncLabel ? (
        <div {...stylex.props(styles.externalSync)}>
          <Spinner className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span {...stylex.props(styles.externalSyncLabel)}>{externalHistorySyncLabel}</span>
        </div>
      ) : null;
    const freeTurnLimitNoticeNode = freeTurnLimitNotice ? (
      <div {...stylex.props(styles.freeTurnNotice)}>
        <span>
          {t('sessions.freeTurnLimitNotice', {
            current: numberFormatter.format(freeTurnLimitNotice.current),
            limit: numberFormatter.format(freeTurnLimitNotice.limit),
          })}
        </span>
        {freeTurnLimitNotice.onUpgrade ? (
          <button
            type="button"
            {...stylex.props(styles.freeTurnUpgrade)}
            onClick={freeTurnLimitNotice.onUpgrade}
          >
            {t('sessions.freeTurnLimitUpgrade')}
          </button>
        ) : null}
      </div>
    ) : null;
    /* Keep desktop actions compact while preserving the mobile touch target. */
    const primaryActionNode = showStopButton ? (
      <Button
        onClick={() => {
          void onStop();
        }}
        variant="ghost"
        size={isMobile ? 'medium' : 'small'}
        shape="pill"
        icon
        aria-label={t('sessions.stop')}
        className="shadow-xs transition-all bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px]"
      >
        <span
          {...stylex.props(
            styles.stopGlyph,
            isMobile ? styles.stopGlyphMobile : styles.stopGlyphDesktop
          )}
          aria-hidden="true"
        />
      </Button>
    ) : (
      <Button
        type="button"
        icon
        variant="ghost"
        size={isMobile ? 'medium' : 'small'}
        shape="pill"
        onClick={() => {
          void sendMessage();
        }}
        disabled={!hasSendableContent || isSendActionDisabled}
        aria-label={
          isExternalHistoryRefreshing && externalHistorySyncLabel
            ? externalHistorySyncLabel
            : t('sessions.send')
        }
        className="shadow-xs transition-all bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px]"
      >
        {submissionPending || isExternalHistoryRefreshing ? (
          <Spinner size={isMobile ? 'medium' : 'small'} />
        ) : (
          <ArrowUp {...stylex.props(isMobile ? styles.sendIconMobile : styles.sendIconDesktop)} />
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
        onDirectoryDrop={handleDirectoryDrop}
        // The dropzone accepts files AND images, so it must NOT inherit the
        // image-only disable (which trips at 8 pending images). Per-type count
        // limits are enforced inside handleImageDrop's handlers. Drops are only
        // blocked when the session is archived or the machine was removed;
        // a merely offline machine still accepts input (deferred execution).
        imageDropDisabled={submissionPending || isArchived || isMachineRemoved}
        promptPlaceholder={promptPlaceholder}
        compactPlaceholderName={compactPlaceholderName}
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
        focusOnContainerClick
      />
    );

    return (
      <div
        className={getSessionChatInputAreaShellClassName({ protectFromEdgeBackZone: isMobile })}
        onMouseDown={(event) => {
          // Keep the restored shell-owned bottom spacing focusable without
          // stealing focus from selectors, attachments, or the prompt itself.
          if (event.button === 0 && event.target === event.currentTarget) {
            event.preventDefault();
            textareaRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        {/* The Role editor is a Dialog, so it is hosted OUT here rather than
            inside the run-config menu or the mobile drawer, where it would
            unmount with them the moment it opened. Mounted only while OPEN:
            it reads machine visibility, and the composer must stay renderable
            in hosts that do not provide that context. */}
        {agentRoleEditor && !submissionPending ? (
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
          {hideTopSpacer ? null : <div aria-hidden="true" {...stylex.props(styles.topSpacer)} />}
          {externalHistorySyncNode}
          {freeTurnLimitNoticeNode}
          {attachmentAddEnabled ? (
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              {...stylex.props(styles.hiddenInput)}
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
