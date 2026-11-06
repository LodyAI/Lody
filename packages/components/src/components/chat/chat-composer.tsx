import { useWorkspaceFeature } from '@/hooks/use-workspace-feature';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import {
  ClipboardPaste,
  RefreshCw,
  X,
  Pencil,
  TriangleAlert,
  CircleAlert,
  Info,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AcpCommandSummary } from '@lody/shared';
import { AttachmentAddMenu, type AttachmentAddMenuMcp } from './attachment-add-menu';
import { ComposerImagePeek } from './composer-image-peek';
import { measureTextareaScrollHeight } from './textarea-measurement';
import { CommentReferenceChip, type CommentReferenceChipItem } from './comment-reference-chip';
import {
  VisualAnnotationReferenceChip,
  type VisualAnnotationReferenceChipItem,
} from './visual-annotation-reference-chip';
import { composerSurfaceStyles } from './composer-surface';
import {
  CombinedMentionTextarea,
  type CombinedMentionTextareaHandle,
} from '@/components/mentions/combined-mention-textarea';
import {
  getComposerMentionChip,
  wrapPastedTextChipLabel,
} from '@/components/mentions/mention-chips';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import type { SkillMentionAgent } from '@/components/mentions/mention-skill-source';
import {
  arePastedTextDraftsEqual,
  getPastedTextCharacterCount,
  getPastedTextLineCount,
  updatePastedTextDraftContent,
  type PastedTextDraft,
} from '@/lib/pasted-text-draft';
import { getExpandedClipboardTextForSelection } from '@/lib/composer-clipboard';
import { useMentionPromptExpansion } from '@/components/mentions/mention-expansion';
import type { Mention as MentionRange } from '@/ui/mention/index';
import type { PersistedMentionRange } from '@/components/mentions/mention-persistence';
import { toIntlLocale } from '@/lib/intl-locale';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button, type ButtonProps } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { dialog as dialogTokens } from '@lody/ui/dialog/dialog.tokens.stylex';
import { Drawer } from '@lody/ui/drawer';
import { Textarea, type TextareaProps } from '@lody/ui/textarea';
import { hasFileTransfer, readDroppedTransfer } from '@/lib/file-drop';
import {
  COMPOSER_COMPACT_PLACEHOLDER_MAX_PX,
  getChatComposerCompactPlaceholder,
  getChatComposerPromptPlaceholderKey,
  getChatComposerMobilePromptPlaceholderKey,
} from '@/lib/chat-composer-placeholder';
import { Kbd } from '@/components/commands/kbd';
import { commands, formatKeyBinding } from '@/lib/commands';
import * as stylex from '@stylexjs/stylex';
import { text as textScale, space, duration, ease, radius } from '@lody/ui/tokens/scales.stylex';
import { colors, shadow, media } from '@lody/ui/tokens/colors.stylex';
import { card } from '@lody/ui/card/card.tokens.stylex';
import { field } from '@lody/ui/field/field.tokens.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../style/theme-scale.stylex';

const typography = stylex.create({
  imageMarkup: { position: 'absolute', insetInlineStart: space[1], bottom: space[1] },
  prompt: { fontSize: textScale.bodySize, lineHeight: textScale.bodyLeading },
  helper: { fontSize: textScale.footnoteSize, lineHeight: textScale.footnoteLeading },
  code: { fontSize: textScale.subheadlineSize, lineHeight: textScale.subheadlineLeading },
  caption: { fontSize: textScale.captionSize, lineHeight: textScale.captionLeading },
});

const styles = stylex.create({
  textarea: {
    color: { default: colors.label, '::placeholder': field.placeholder },
    fontWeight: 400,
    letterSpacing: 'normal',
  },
  textareaLanding: {
    minHeight: { default: '120px', '@media (min-width: 640px)': '140px' },
    paddingInline: 'calc(var(--spacing) * 0)',
    paddingBlock: 'calc(var(--spacing) * 0)',
  },
  textareaSession: {
    paddingInline: 'calc(var(--spacing) * 1)',
    paddingBlock: 'calc(var(--spacing) * 0)',
  },
  textareaMobile: { minHeight: '24px' },
  textareaDesktop: { minHeight: '48px' },
  textareaDialog: {
    width: '100%',
    minHeight: '120px',
    borderRadius: 'var(--radius-2xl)',
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBlock: 'calc(var(--spacing) * 3)',
  },
  textareaHint: { paddingRight: 'calc(var(--spacing) * 16)' },
  secondaryAction: { width: 'auto', userSelect: 'none', flexShrink: 0 },
  /* The composer's own frame. */
  root: { display: 'flex', width: '100%', flexDirection: 'column' },
  rootDialog: { gap: themeSpace[3] },
  rootLanding: { gap: themeSpace[12] },
  rootSession: { gap: themeSpace[2] },
  title: { textAlign: 'center' },
  titleText: {
    userSelect: 'none',
    fontSize: textScale.titleSize,
    lineHeight: textScale.titleLeading,
    fontWeight: 600,
  },
  column: { display: 'flex', flexDirection: 'column' },
  columnLanding: { gap: themeSpace[2] },
  columnSession: { gap: themeSpace[1] },
  topSelector: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1],
  },

  /* The landing composer box. */
  landingBox: {
    containerType: 'inline-size',
    containerName: 'composer-box',
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[4],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[4],
    paddingBottom: themeSpace[3],
    position: 'relative',
  },
  /* The dialog composer box, which has no container of its own. */
  dialogBox: { display: 'flex', width: '100%', flexDirection: 'column' },
  mentionSurface: { '--mention-chip-surface': card.background, '--mention-chip-overlay': 'none' },
  fieldFocus: {
    boxShadow: {
      default: card.shadow,
      ':has(textarea:focus)': `0 0 0 2px ${colors.accent}, ${card.shadow}`,
    },
  },
  boxDropping: { boxShadow: `0 0 0 2px ${colors.accent}, ${card.shadow}` },
  /* The attachment strips. */
  referenceStrip: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: themeSpace[2],
    paddingBottom: themeSpace[1],
  },
  attachmentStrip: {
    display: 'flex',
    gap: themeSpace[2],
    overflowX: 'auto',
    paddingBottom: themeSpace[1],
  },
  imageCard: {
    position: 'relative',
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: radius.medium,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
  },
  imageCardMobile: { width: '104px', height: '104px' },
  imageCardDesktop: { width: themeSpace[20], height: themeSpace[20] },
  imageCardFailed: { boxShadow: `0 0 0 2px ${colors.destructive}, ${shadow.inset}` },
  imageButton: { width: '100%', height: '100%' },
  imagePreview: { width: '100%', height: '100%', objectFit: 'cover' },
  imageBadge: { color: colors.secondaryLabel },
  imageProgress: {
    position: 'absolute',
    inset: 0,
    backgroundColor: media.scrim,
    transitionProperty: 'clip-path',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  imageScrim: { position: 'absolute', inset: 0, backgroundColor: media.scrim },
  imageCorner: { position: 'absolute', top: themeSpace[1], right: themeSpace[1] },
  imageProgressBar: {
    position: 'absolute',
    insetInline: 0,
    bottom: 0,
    backgroundColor: media.scrim,
    paddingInline: themeSpace[1],
    paddingBlock: themeSpace[0.5],
    textAlign: 'center',
    color: media.label,
  },
  imageFailure: {
    position: 'absolute',
    insetInline: 0,
    bottom: 0,
    width: '100%',
    borderRadius: 0,
  },
  fileCard: {
    position: 'relative',
    display: 'flex',
    flexShrink: 0,
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: radius.medium,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    padding: themeSpace[2],
  },
  fileCardMobile: { width: '104px', height: '104px' },
  fileCardDesktop: { width: themeSpace[20], minHeight: themeSpace[20] },
  fileCardFailed: { boxShadow: `0 0 0 2px ${colors.destructive}, ${shadow.inset}` },
  fileType: {
    maxWidth: '64%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: themeFontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: '0.025em',
  },
  fileTypeFailed: { color: colors.destructive },
  fileTypeResting: { color: colors.secondaryLabel },
  fileName: {
    marginTop: themeSpace[1],
    overflowWrap: 'break-word',
    textAlign: 'left',
    fontWeight: themeFontWeight.medium,
    color: colors.label,
  },
  fileNameMobile: {
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 3,
  },
  fileNameDesktop: {
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
  },
  fileRetry: { marginTop: 'auto', width: 'fit-content', maxWidth: '100%' },
  fileStatus: {
    marginTop: 'auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    paddingTop: themeSpace[1],
    color: colors.secondaryLabel,
  },
  fileProgressTrack: {
    position: 'absolute',
    insetInline: 0,
    bottom: 0,
    height: themeSpace[1],
    backgroundColor: colors.gray4,
  },
  fileProgressFill: {
    height: '100%',
    backgroundColor: colors.accent,
    transitionProperty: 'width',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },

  /* The footers. */
  footer: {
    display: 'flex',
    userSelect: 'none',
    alignItems: 'center',
    columnGap: themeSpace[1.5],
  },
  footerLanding: { paddingTop: themeSpace[2] },
  footerSession: { paddingTop: themeSpace[0.5] },
  footerFace: {
    containerType: 'inline-size',
    containerName: 'composer-face',
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexWrap: 'nowrap',
    alignItems: 'center',
    columnGap: themeSpace[1.5],
    overflow: 'hidden',
  },
  footerActions: {
    marginLeft: 'auto',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[2],
  },
  bottomBar: { userSelect: 'none', paddingInline: themeSpace[4], paddingTop: themeSpace[1] },

  /* The focus hint, hidden once the box takes focus. */
  focusHint: {
    pointerEvents: 'none',
    position: 'absolute',
    top: themeSpace[3],
    right: themeSpace[3],
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    // Match every original .group ancestor, including one outside this composer.
    color: colors.tertiaryLabel,
    opacity: { default: 1, ':where(.group:focus-within *)': 0 },
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },

  /* The composer's status line. */
  status: { display: 'flex', alignItems: 'start', gap: space[1.5], paddingInline: themeSpace[1] },
  statusMark: { width: space[4], height: space[4], flexShrink: 0 },
  statusWarning: { color: colors.warning },
  statusError: { color: colors.destructive },
  statusMuted: { color: colors.secondaryLabel },

  /* The dialog composer's own rows. */
  dialogRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[3],
    '@media (min-width: 640px)': {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
    },
  },
  dialogSelectors: {
    display: 'flex',
    width: '100%',
    flexWrap: 'wrap',
    userSelect: 'none',
    alignItems: 'flex-end',
    gap: themeSpace[2],
  },
  dialogActions: {
    display: 'flex',
    width: '100%',
    flexDirection: 'column',
    userSelect: 'none',
    gap: themeSpace[2],
    '@media (min-width: 640px)': {
      marginLeft: 'auto',
      width: 'auto',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
  },

  /* The pasted-text editor and its frame. */
  pastedEditor: {
    display: 'block',
    minHeight: 0,
    width: '100%',
    flex: '1 1 0%',
    resize: 'none',
    overflow: 'auto',
  },
  pastedEditorMobile: { paddingInline: themeSpace[4], paddingBlock: themeSpace[3] },
  pastedEditorDesktop: { height: '100%' },
  pastedDrawer: {
    display: 'flex',
    height: '85dvh',
    minHeight: 0,
    flexDirection: 'column',
  },
  pastedDrawerGrabber: {
    display: 'flex',
    flexShrink: 0,
    justifyContent: 'center',
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[1],
  },
  pastedDrawerHandle: {
    height: themeSpace[1],
    width: themeSpace[9],
    borderRadius: themeRadius.full,
    backgroundColor: colors.gray2,
  },
  pastedDrawerHeader: {
    display: 'flex',
    flexShrink: 0,
    flexDirection: 'column',
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[2],
    paddingRight: themeSpace[2],
    paddingLeft: themeSpace[4],
  },
  pastedDrawerTitleRow: { display: 'flex', alignItems: 'center', gap: themeSpace[3] },
  pastedTitle: { display: 'flex', alignItems: 'center', gap: themeSpace[2] },
  pastedDrawerTitle: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  pastedSummary: {
    fontVariantNumeric: 'tabular-nums',
  },
  pastedDrawerSummary: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    paddingRight: themeSpace[2],
  },
  pastedDrawerContent: {
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
    paddingBlockStart: 0,
    paddingBlockEnd: 0,
    paddingInlineStart: 0,
    paddingInlineEnd: 0,
    [dialogTokens.gap]: 'calc(var(--spacing) * 0)',
  },
  pastedDialogContent: {
    maxHeight: '85vh',
    display: 'flex',
    height: '85vh',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  pastedDialogHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[3],
    paddingInline: themeSpace[5],
    paddingBlock: themeSpace[3],
  },
  pastedDialogTitleRow: { display: 'flex', alignItems: 'center', gap: themeSpace[3] },
  pastedDialogBody: {
    display: 'flex',
    minHeight: 0,
    flexGrow: 1,
    paddingInline: themeSpace[5],
    paddingBlock: themeSpace[4],
  },
  glyph14: { width: themeSpace[3.5], height: themeSpace[3.5], flexShrink: 0 },
  glyph16: { width: themeSpace[4], height: themeSpace[4] },
  glyph12: { width: themeSpace[3], height: themeSpace[3] },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  glyphMuted: { color: colors.secondaryLabel },
});

type ChatComposerTone = 'light' | 'dark';
type ChatComposerVariant = 'landing' | 'session' | 'dialog';
type ChatComposerStatusTone = 'error' | 'warning' | 'info';

export interface ChatComposerAction {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  variant?: ButtonProps['variant'];
  xstyle?: stylex.StyleXStyles;
  className?: string;
}

export interface ChatComposerImageItem {
  id: string;
  name: string;
  previewUrl: string;
  status: 'draft' | 'uploading' | 'uploaded' | 'failed';
  progress: number;
  error?: string;
}

export interface ChatComposerFileItem {
  id: string;
  name: string;
  /** Human-readable size (e.g. "2.4 MB"); rendered as the chip subtitle. */
  sizeLabel: string;
  status: 'draft' | 'preparing' | 'uploading' | 'verifying' | 'uploaded' | 'failed';
  progress: number;
  error?: string;
}

export interface ChatComposerProps {
  title?: ReactNode;
  tone?: ChatComposerTone;
  variant?: ChatComposerVariant;
  mentionSource?: MentionProjectSource;
  availableCommands?: AcpCommandSummary[];
  /** False while this retained composer is not the active command surface. */
  commandsEnabled?: boolean;
  /** Selected ACP provider — filters the `$` skill mention to that provider's
     skill directories. `machineId` is the machine the chat runs on; it lets the
     `$` menu surface that machine's global skills even for GitHub / plain-agent
     chats (not just local-project chats). */
  skillAgent?: SkillMentionAgent;
  /** Dropped from the `@session:` category — a session never references itself. */
  currentSessionId?: string | null;
  promptId?: string;
  promptValue: string;
  onPromptChange: (value: string) => void;
  onPromptKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPromptPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  promptPlaceholder?: string;
  /** Agent or role name for the compact-width placeholder ("Work with {{name}}"). */
  compactPlaceholderName?: string | null;
  promptDisabled?: boolean;
  promptRows?: number;
  promptEnterKeyHint?: TextareaProps['enterKeyHint'];
  promptRef?: Ref<HTMLTextAreaElement>;
  pastedTextDrafts?: PastedTextDraft[];
  onPastedTextDraftsChange?: (drafts: PastedTextDraft[]) => void;
  /**
   * Every committed mention range. The send path needs these to record which
   * regions of the sent text were mentions; see `useMentionPromptExpansion`.
   */
  onMentionRangesChange?: (ranges: MentionRange[]) => void;
  /** Ranges stored with the draft, restored when the composer remounts. */
  persistedMentions?: readonly PersistedMentionRange[];
  /** Identity of the draft `promptValue` belongs to; see `draftKey` there. */
  draftKey?: string;
  /**
   * Handle for writing a mention from outside the composer — the page-level
   * drop target of a dragged sidebar session. See `CombinedMentionTextarea`.
   */
  mentionActionsRef?: Ref<CombinedMentionTextareaHandle>;
  imageItems?: ChatComposerImageItem[];
  attachmentAddDisabled?: boolean;
  onAttachmentAddClick?: () => void;
  onScheduleSend?: () => void;
  scheduleDisabledReason?: string;
  imageDropDisabled?: boolean;
  onImageDrop?: (files: File[]) => void;
  /**
   * Folders in the same drop. They are never attachments: the owner turns
   * each into a `@path` mention (see `lib/dropped-local-path.ts`).
   */
  onDirectoryDrop?: (directories: File[]) => void;
  onImageRemove?: (id: string) => void;
  onImageAnnotate?: (id: string) => void;
  onImageRetry?: (id: string) => void;
  /** Pending file attachments (non-image), rendered as a chip strip. */
  fileItems?: ChatComposerFileItem[];
  onFileRemove?: (id: string) => void;
  onFileRetry?: (id: string) => void;
  /** Per-turn MCP selection, rendered as a second level of the "+" menu. */
  mcp?: AttachmentAddMenuMcp;
  /** Comment reference items attached to this message */
  commentReferenceItems?: CommentReferenceChipItem[];
  /** Remove a comment reference by localId */
  onCommentReferenceRemove?: (localId: string) => void;
  /** Called when a comment reference chip is clicked */
  onCommentReferenceClick?: (reference: import('@lody/shared').CommentReferencePayload) => void;
  /** When true, first chip click reveals its remove action before navigation. */
  revealCommentReferenceRemoveOnClick?: boolean;
  /** Visual annotation reference items attached to this message */
  visualAnnotationReferenceItems?: VisualAnnotationReferenceChipItem[];
  /** Remove a visual annotation reference by localId */
  onVisualAnnotationReferenceRemove?: (localId: string) => void;
  /** @deprecated Use footerSelector instead */
  selector?: ReactNode;
  /** Selector node displayed above the textarea (e.g., repo, agent) */
  topSelector?: ReactNode;
  /** Selector node displayed inside the input footer (e.g., model, mode) */
  footerSelector?: ReactNode;
  /** Node displayed below the input box (e.g., machine, agent) */
  bottomBar?: ReactNode;
  /** Inline status shown near the composer instead of interrupting with a toast. */
  statusMessage?: ReactNode;
  statusTone?: ChatComposerStatusTone;
  primaryAction: ReactNode;
  secondaryAction?: ChatComposerAction;
  className?: string;
  /** Enable auto-resize based on content. When enabled, the textarea grows up to maxRows. */
  autoResize?: boolean;
  /** Maximum number of rows when autoResize is enabled (default: 12) */
  maxRows?: number;
  /** Focus the textarea when clicking the container background. */
  focusOnContainerClick?: boolean;
}

export function getChatComposerTextareaStyles({
  variant,
  isMobile = false,
}: {
  tone: ChatComposerTone;
  variant: ChatComposerVariant;
  isMobile?: boolean;
}): stylex.StyleXStyles {
  return [
    typography.prompt,
    styles.textarea,
    variant === 'landing'
      ? styles.textareaLanding
      : [styles.textareaSession, isMobile ? styles.textareaMobile : styles.textareaDesktop],
  ];
}

/**
 * Short uppercase type badge for a file attachment card (e.g. "EPUB", "PDF").
 * Derived from the filename extension; falls back to "FILE" when there is no
 * usable extension, and caps overly long extensions so the badge stays compact.
 */
function getFileTypeLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return 'FILE';
  }
  const ext = name.slice(dot + 1).toUpperCase();
  return ext.length > 5 ? ext.slice(0, 5) : ext;
}

export function ChatComposer({
  title,
  tone = 'light',
  variant = 'landing',
  mentionSource,
  availableCommands,
  commandsEnabled = true,
  skillAgent,
  currentSessionId,
  promptId,
  promptValue,
  onPromptChange,
  onPromptKeyDown,
  onPromptPaste,
  promptPlaceholder,
  compactPlaceholderName,
  promptDisabled = false,
  promptRows = 3,
  promptEnterKeyHint,
  promptRef,
  pastedTextDrafts = [],
  onPastedTextDraftsChange,
  onMentionRangesChange,
  persistedMentions,
  draftKey,
  mentionActionsRef,
  imageItems = [],
  attachmentAddDisabled = false,
  onAttachmentAddClick,
  onScheduleSend,
  scheduleDisabledReason,
  imageDropDisabled = attachmentAddDisabled,
  onImageDrop,
  onDirectoryDrop,
  onImageRemove,
  onImageAnnotate,
  onImageRetry,
  fileItems = [],
  onFileRemove,
  onFileRetry,
  mcp,
  commentReferenceItems = [],
  onCommentReferenceRemove,
  onCommentReferenceClick,
  revealCommentReferenceRemoveOnClick = false,
  visualAnnotationReferenceItems = [],
  onVisualAnnotationReferenceRemove,
  selector,
  topSelector,
  footerSelector,
  bottomBar,
  statusMessage,
  statusTone = 'info',
  primaryAction,
  secondaryAction,
  className,
  autoResize = false,
  maxRows = 12,
  focusOnContainerClick = false,
}: ChatComposerProps) {
  const { t, i18n } = useTranslation();
  const shortcutsAllowed = useWorkspaceFeature('shortcuts');
  const shortcutsEnabled = variant !== 'dialog' && shortcutsAllowed;
  const intlLocale = useMemo(
    () => toIntlLocale(i18n.resolvedLanguage ?? i18n.language),
    [i18n.language, i18n.resolvedLanguage]
  );
  const isMobile = useIsMobile();
  const isDialog = variant === 'dialog';
  const isLanding = variant === 'landing';
  // Mobile session composer starts at a single line to save vertical space
  // (desktop keeps its 2-line default); it still auto-grows as the user types.
  const singleLineMobile = isMobile && variant === 'session';
  const effectivePromptRows = singleLineMobile ? 1 : promptRows;
  // Desktop-only ⌘L discovery hint in the empty composer. Requires a fine pointer
  // AND non-mobile layout so phone frames / narrow viewports never show a
  // keyboard shortcut that doesn't exist on touch. Hidden once focused or typing.
  const focusHintSupported = useMemo(
    () =>
      !isMobile &&
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(pointer: fine)').matches,
    [isMobile]
  );
  const [previewPastedTextDraftId, setPreviewPastedTextDraftId] = useState<string | null>(null);
  const [previewPastedTextEditorValue, setPreviewPastedTextEditorValue] = useState('');
  const imageDragDepthRef = useRef(0);
  const [isImageDropActive, setIsImageDropActive] = useState(false);
  const retryUploadLabel = t('sessions.retryUpload', 'Retry upload');
  const removeImageLabel = t('sessions.removeImage', 'Remove image');
  const removeAttachmentLabel = t('sessions.removeAttachment', 'Remove attachment');
  const uploadFailedLabel = t('sessions.uploadFailed', 'Upload failed');
  const uploadFailedShortLabel = t('sessions.uploadFailedShort', 'Failed');
  const imagePreviewLabel = t('sessions.imagePreview', 'Image preview');
  const pastedTextDialogTitle = t('composer.pastedTextTitle', 'Pasted text');
  const pastedTextEditorLabel = t('composer.pastedTextEditorLabel', 'Edit pasted text');
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const [useCompactPlaceholder, setUseCompactPlaceholder] = useState(false);
  useLayoutEffect(() => {
    const box = composerBoxRef.current;
    if (!box) return undefined;
    const update = (width: number) => {
      setUseCompactPlaceholder(width <= COMPOSER_COMPACT_PLACEHOLDER_MAX_PX);
    };
    // No synchronous measurement here: a layout-effect read forces style and
    // layout of the whole just-committed tree (a full conversation on a session
    // switch). ResizeObserver delivers the first size before that frame paints.
    if (typeof ResizeObserver === 'undefined') {
      update(box.getBoundingClientRect().width);
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      update(width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const compactPromptPlaceholder = (() => {
    const compact = getChatComposerCompactPlaceholder({ name: compactPlaceholderName });
    return compact.name ? t(compact.key, { name: compact.name }) : t(compact.key);
  })();
  const resolvedPromptPlaceholder = useCompactPlaceholder
    ? compactPromptPlaceholder
    : (promptPlaceholder ??
      (isMobile
        ? t(getChatComposerMobilePromptPlaceholderKey({ mentionSource, skillAgent }))
        : t(
            getChatComposerPromptPlaceholderKey({
              mentionSource,
              availableCommands,
              skillAgent,
            })
          )));
  const numberFormatter = useMemo(() => new Intl.NumberFormat(intlLocale), [intlLocale]);
  const previewPastedTextDraft =
    pastedTextDrafts.find((item) => item.id === previewPastedTextDraftId) ?? null;
  const formatPastedTextInlineLabel = useCallback(
    (text: string) =>
      wrapPastedTextChipLabel(
        t('composer.pastedTextInlineLabel', '[Pasted {{charCount}} chars]', {
          charCount: numberFormatter.format(getPastedTextCharacterCount(text)),
        })
      ),
    [numberFormatter, t]
  );
  const pastedTextMentions = useMemo<MentionRange[]>(
    () =>
      pastedTextDrafts.map((draft) => ({
        value: draft.id,
        start: draft.start,
        end: draft.end,
        kind: 'pasted_text' as const,
      })),
    [pastedTextDrafts]
  );
  // Live ranges for copy expansion. Send still owns its copy via the parent
  // callback; we mirror here so Cmd/Ctrl+C can expand without waiting on send.
  const [mentionRanges, setMentionRanges] = useState<MentionRange[]>([]);
  const handleMentionRangesChange = useCallback(
    (ranges: MentionRange[]) => {
      setMentionRanges(ranges);
      onMentionRangesChange?.(ranges);
    },
    [onMentionRangesChange]
  );
  const { getRewrites: getMentionPromptRewrites } = useMentionPromptExpansion({
    source: mentionSource,
    skillAgent,
    promptValue,
    currentSessionId,
  });
  // Drop stale ranges when the draft identity changes (session swap / remount).
  useEffect(() => {
    setMentionRanges([]);
  }, [draftKey]);
  const handlePastedTextMentionsChange = useCallback(
    (nextMentions: MentionRange[]) => {
      if (promptDisabled) return;
      if (!onPastedTextDraftsChange) return;

      const nextDrafts = nextMentions
        .filter((mention) => mention.kind === 'pasted_text')
        .map((mention) => {
          const currentDraft = pastedTextDrafts.find((draft) => draft.id === mention.value);
          if (!currentDraft) {
            return null;
          }

          return {
            ...currentDraft,
            start: mention.start,
            end: mention.end,
            displayText: currentDraft.displayText,
          } satisfies PastedTextDraft;
        })
        .filter((draft): draft is PastedTextDraft => draft !== null);

      if (!arePastedTextDraftsEqual(pastedTextDrafts, nextDrafts)) {
        onPastedTextDraftsChange(nextDrafts);
      }
    },
    [onPastedTextDraftsChange, pastedTextDrafts, promptDisabled]
  );
  const handleMentionClick = useCallback(
    (mention: MentionRange) => {
      if (mention.kind !== 'pasted_text') return;
      const draft = pastedTextDrafts.find((item) => item.id === mention.value);
      setPreviewPastedTextEditorValue(draft?.text ?? '');
      setPreviewPastedTextDraftId(mention.value);
    },
    [pastedTextDrafts]
  );
  const handlePastedTextDraftTextChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      if (promptDisabled) return;
      if (!previewPastedTextDraft || !onPastedTextDraftsChange) return;

      const text = event.currentTarget.value;
      setPreviewPastedTextEditorValue(text);
      const displayText = formatPastedTextInlineLabel(text);
      const result = updatePastedTextDraftContent({
        currentValue: promptValue,
        drafts: pastedTextDrafts,
        draftId: previewPastedTextDraft.id,
        text,
        displayText,
      });

      if (!result) return;

      onPromptChange(result.nextValue);
      onPastedTextDraftsChange(result.nextDrafts);
    },
    [
      formatPastedTextInlineLabel,
      onPastedTextDraftsChange,
      onPromptChange,
      pastedTextDrafts,
      previewPastedTextDraft,
      promptDisabled,
      promptValue,
    ]
  );
  const handlePromptCopy = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const input = event.currentTarget;
      // Expand session/skill/role/pasted mentions to the agent-facing plain
      // text — same rewrites as send. Native copy stays when nothing expands.
      const clipboardText = getExpandedClipboardTextForSelection({
        value: promptValue,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        rewrites: getMentionPromptRewrites({
          text: promptValue,
          mentions: mentionRanges,
          pastedTextDrafts,
        }),
      });

      if (clipboardText === null) {
        return;
      }

      event.preventDefault();
      event.clipboardData.setData('text/plain', clipboardText);
    },
    [getMentionPromptRewrites, mentionRanges, pastedTextDrafts, promptValue]
  );

  const canHandleImageDrop = Boolean(onImageDrop) && !imageDropDisabled && !promptDisabled;
  const resetImageDragState = useCallback(() => {
    imageDragDepthRef.current = 0;
    setIsImageDropActive(false);
  }, []);
  useEffect(() => {
    if (!canHandleImageDrop) {
      resetImageDragState();
    }
  }, [canHandleImageDrop, resetImageDragState]);
  const handleImageDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canHandleImageDrop || !hasFileTransfer(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      imageDragDepthRef.current += 1;
      setIsImageDropActive(true);
    },
    [canHandleImageDrop]
  );
  const handleImageDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canHandleImageDrop || !hasFileTransfer(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    },
    [canHandleImageDrop]
  );
  const handleImageDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canHandleImageDrop || !hasFileTransfer(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      imageDragDepthRef.current = Math.max(0, imageDragDepthRef.current - 1);
      if (imageDragDepthRef.current === 0) {
        setIsImageDropActive(false);
      }
    },
    [canHandleImageDrop]
  );
  const handleImageDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canHandleImageDrop || !hasFileTransfer(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      resetImageDragState();
      const { files, directories } = readDroppedTransfer(event.dataTransfer);
      if (files.length > 0) {
        onImageDrop?.(files);
      }
      if (directories.length > 0) {
        onDirectoryDrop?.(directories);
      }
    },
    [canHandleImageDrop, onDirectoryDrop, onImageDrop, resetImageDragState]
  );

  // Auto-resize effect: adjust textarea height based on content
  useEffect(() => {
    if (!autoResize) return;

    // Get the textarea element from the ref
    const textarea =
      promptRef && typeof promptRef === 'object' && 'current' in promptRef
        ? promptRef.current
        : null;
    if (!textarea) return;

    // Calculate line height and max height
    const computedStyle = getComputedStyle(textarea);
    const lineHeight = parseInt(computedStyle.lineHeight || '24', 10) || 24;
    const paddingTop = parseInt(computedStyle.paddingTop || '0', 10);
    const paddingBottom = parseInt(computedStyle.paddingBottom || '0', 10);
    const minHeight = lineHeight * effectivePromptRows + paddingTop + paddingBottom;
    const maxHeight = lineHeight * maxRows + paddingTop + paddingBottom;

    // When empty, the height is simply minHeight — and must be: Chromium includes
    // the wrapped placeholder text in an empty textarea's scrollHeight, so a long
    // placeholder would grow the box past minHeight and then visibly shrink on
    // the first keystroke. Skipping measurement also avoids constructing a
    // mirror and forcing layout while an empty composer mounts on session switch.
    const hasValue = (promptValue ?? '').length > 0;
    if (!hasValue) {
      textarea.style.height = `${minHeight}px`;
      textarea.style.overflowY = 'hidden';
      return;
    }

    // Measure outside the flex layout. A temporary height:auto on the live
    // textarea expands the conversation viewport and can clamp its scrollTop.
    const scrollHeight = measureTextareaScrollHeight(textarea, computedStyle);
    const newHeight = Math.max(minHeight, Math.min(scrollHeight, maxHeight));

    textarea.style.height = `${newHeight}px`;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [autoResize, promptValue, promptRef, effectivePromptRows, maxRows]);

  const boxTextareaStyles = getChatComposerTextareaStyles({ tone, variant, isMobile });
  const mentionContainerClassName = !isLanding
    ? stylex.props(
        styles.dialogBox,
        composerSurfaceStyles.composerElevation,
        styles.mentionSurface,
        styles.fieldFocus
      ).className
    : undefined;
  const dialogTextareaStyles: stylex.StyleXStyles = [
    typography.prompt,
    styles.textarea,
    styles.textareaDialog,
  ];
  const secondaryButtonStyles: stylex.StyleXStyles = [styles.secondaryAction];
  const secondaryButtonSize = isDialog ? 'large' : isLanding ? 'mini' : 'small';

  const boxStyle = isLanding
    ? stylex.props(
        styles.landingBox,
        styles.mentionSurface,
        composerSurfaceStyles.composerElevation,
        styles.fieldFocus,
        isImageDropActive && styles.boxDropping
      )
    : stylex.props(
        composerSurfaceStyles.sessionSurface,
        styles.mentionSurface,
        composerSurfaceStyles.composerElevation,
        styles.fieldFocus,
        isImageDropActive && styles.boxDropping
      );
  const boxClassName = [
    // `group` is the focus hint's anchor: it fades when the box takes focus.
    'group',
    boxStyle.className,
  ]
    .filter(Boolean)
    .join(' ');

  const composerHasAttachments =
    imageItems.length > 0 ||
    fileItems.length > 0 ||
    commentReferenceItems.length > 0 ||
    visualAnnotationReferenceItems.length > 0;
  const focusHintBinding = commands.getKeybindingsFor('session.focusInput')[0];
  // Only when the box is idle: desktop, has a focus binding, and nothing entered/attached
  // yet (so the chip never collides with text or thumbnails). focus-within hides it too.
  const showFocusHint =
    focusHintSupported && Boolean(focusHintBinding) && !promptValue && !composerHasAttachments;
  const statusStyle = stylex.props(typography.helper, styles.status, styles.statusMuted);
  const StatusGlyph =
    statusTone === 'warning' ? TriangleAlert : statusTone === 'error' ? CircleAlert : Info;
  const statusMarkStyle = stylex.props(
    styles.statusMark,
    statusTone === 'warning'
      ? styles.statusWarning
      : statusTone === 'error'
        ? styles.statusError
        : styles.statusMuted
  );

  const rootStyle = stylex.props(
    styles.root,
    isDialog ? styles.rootDialog : isLanding ? styles.rootLanding : styles.rootSession
  );

  return (
    <>
      <div
        className={[rootStyle.className, className].filter(Boolean).join(' ')}
        style={rootStyle.style}
      >
        {title ? (
          <div {...stylex.props(styles.title)}>
            <h1 {...stylex.props(styles.titleText)}>{title}</h1>
          </div>
        ) : null}

        {!isDialog ? (
          <div
            {...stylex.props(
              styles.column,
              isLanding ? styles.columnLanding : styles.columnSession
            )}
          >
            {/* Top selector (repo, branch) - shown outside and above the input box */}
            {topSelector ? <div {...stylex.props(styles.topSelector)}>{topSelector}</div> : null}
            <div
              ref={composerBoxRef}
              data-mention-frame=""
              /* The box's own landmark: the composer's classes are StyleX, so a
                 test (and a reader) cannot find it by a utility class any
                 more. */
              data-lody-composer-box=""
              className={boxClassName}
              style={boxStyle.style}
              onDragEnter={canHandleImageDrop ? handleImageDragEnter : undefined}
              onDragOver={canHandleImageDrop ? handleImageDragOver : undefined}
              onDragLeave={canHandleImageDrop ? handleImageDragLeave : undefined}
              onDrop={canHandleImageDrop ? handleImageDrop : undefined}
              onDragEnd={canHandleImageDrop ? resetImageDragState : undefined}
              onClick={
                focusOnContainerClick && !promptDisabled
                  ? (event) => {
                      const target = event.target as HTMLElement | null;
                      if (!target) return;
                      if (
                        !event.currentTarget.contains(target) ||
                        target.closest(
                          'button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="option"], [data-comment-ref], [data-visual-annotation-ref]'
                        )
                      ) {
                        return;
                      }
                      const textarea =
                        promptRef && typeof promptRef === 'object' && 'current' in promptRef
                          ? promptRef.current
                          : null;
                      textarea?.focus();
                    }
                  : undefined
              }
            >
              {commentReferenceItems.length > 0 ? (
                <div {...stylex.props(styles.referenceStrip)}>
                  {commentReferenceItems.map((item) => (
                    <CommentReferenceChip
                      key={item.localId}
                      item={item}
                      onRemove={onCommentReferenceRemove}
                      onClick={onCommentReferenceClick}
                      revealRemoveOnClick={revealCommentReferenceRemoveOnClick}
                    />
                  ))}
                </div>
              ) : null}
              {visualAnnotationReferenceItems.length > 0 ? (
                <div {...stylex.props(styles.referenceStrip)}>
                  {visualAnnotationReferenceItems.map((item) => (
                    <VisualAnnotationReferenceChip
                      key={item.localId}
                      item={item}
                      onRemove={onVisualAnnotationReferenceRemove}
                      revealRemoveOnClick={revealCommentReferenceRemoveOnClick}
                    />
                  ))}
                </div>
              ) : null}
              {imageItems.length > 0 || fileItems.length > 0 ? (
                // Unified horizontal, scrollable attachment strip: image thumbnails
                // and file cards share the same square-card shape and scroll
                // sideways together (cards step up in size on mobile for touch).
                <div
                  className={['input-scrollbar', stylex.props(styles.attachmentStrip).className]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {imageItems.map((image) => (
                    <div
                      key={image.id}
                      title={
                        image.status === 'failed' ? image.error || uploadFailedLabel : undefined
                      }
                      {...stylex.props(
                        styles.imageCard,
                        isMobile ? styles.imageCardMobile : styles.imageCardDesktop,
                        image.status === 'failed' && styles.imageCardFailed
                      )}
                    >
                      <ComposerImagePeek
                        src={image.previewUrl}
                        name={image.name}
                        alt={imagePreviewLabel}
                        trigger={
                          <button
                            type="button"
                            {...stylex.props(styles.imageButton)}
                            aria-label={image.name}
                          >
                            <img
                              src={image.previewUrl}
                              alt={image.name}
                              {...stylex.props(styles.imagePreview)}
                            />
                            {image.status === 'draft' ? (
                              <span
                                className={[
                                  stylex.props(styles.imageBadge).className,
                                  stylex.props(typography.caption).className,
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                              >
                                {t('sessions.attachmentDraft')}
                              </span>
                            ) : image.status === 'uploading' ? (
                              <div
                                {...stylex.props(styles.imageProgress)}
                                style={{
                                  clipPath: `inset(${Math.max(0, Math.min(100, image.progress))}% 0 0 0)`,
                                }}
                              />
                            ) : null}
                            {image.status === 'failed' ? (
                              <div {...stylex.props(styles.imageScrim)} />
                            ) : null}
                          </button>
                        }
                      />
                      <div {...stylex.props(styles.imageCorner)}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="mini"
                          icon

                          onClick={() => onImageRemove?.(image.id)}
                          aria-label={removeImageLabel}
                        >
                          <X className={stylex.props(styles.glyph12).className} />
                        </Button>
                      </div>
                      {image.status === 'draft' ? (
                        <span
                          className={[
                            stylex.props(styles.imageBadge).className,
                            stylex.props(typography.caption).className,
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {t('sessions.attachmentDraft')}
                        </span>
                      ) : image.status === 'uploading' ? (
                        <div
                          className={[
                            stylex.props(styles.imageProgressBar).className,
                            stylex.props(typography.caption).className,
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {image.progress}%
                        </div>
                      ) : null}
                      {onImageAnnotate && image.status !== 'uploading' ? (
                        <div {...stylex.props(typography.imageMarkup)}>
                          <Button
                            size="mini"
                            icon
                            variant="secondary"
                            onClick={() => onImageAnnotate(image.id)}
                            aria-label={t(
                              'sessions.fileViewer.selection.markupNamedImage',
                              'Mark up {{name}}',
                              { name: image.name }
                            )}
                          >
                            <Pencil size={14} aria-hidden />
                          </Button>
                        </div>
                      ) : null}
                      {image.status === 'failed' ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="mini"
                          onClick={() => onImageRetry?.(image.id)}
                          aria-label={retryUploadLabel}
                          xstyle={[styles.imageFailure, typography.caption]}
                        >
                          <RefreshCw className={stylex.props(styles.glyph12).className} />
                          <span {...stylex.props(styles.truncate)}>{uploadFailedShortLabel}</span>
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  {fileItems.map((file) => (
                    <div
                      key={file.id}
                      title={file.status === 'failed' ? file.error || uploadFailedLabel : undefined}
                      {...stylex.props(
                        styles.fileCard,
                        isMobile ? styles.fileCardMobile : styles.fileCardDesktop,
                        file.status === 'failed' && styles.fileCardFailed
                      )}
                    >
                      <span
                        className={[
                          stylex.props(styles.fileType).className,
                          stylex.props(
                            file.status === 'failed'
                              ? styles.fileTypeFailed
                              : styles.fileTypeResting
                          ).className,
                          stylex.props(isMobile ? typography.helper : typography.caption).className,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {getFileTypeLabel(file.name)}
                      </span>
                      <span
                        className={[
                          stylex.props(styles.fileName).className,
                          stylex.props(isMobile ? styles.fileNameMobile : styles.fileNameDesktop)
                            .className,
                          stylex.props(typography.helper).className,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {file.name}
                      </span>
                      {file.status === 'failed' ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="mini"
                          onClick={() => onFileRetry?.(file.id)}
                          aria-label={retryUploadLabel}
                          xstyle={[styles.fileRetry, typography.caption]}
                        >
                          <RefreshCw className={stylex.props(styles.glyph12).className} />
                          <span {...stylex.props(styles.truncate)}>{uploadFailedShortLabel}</span>
                        </Button>
                      ) : (
                        <span
                          className={[
                            stylex.props(styles.fileStatus).className,
                            stylex.props(typography.caption).className,
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {file.status === 'draft'
                            ? t('sessions.attachmentDraft')
                            : file.status === 'preparing'
                              ? t('sessions.filePreparing', 'Preparing… {{progress}}%', {
                                  progress: file.progress,
                                })
                              : file.status === 'uploading'
                                ? `${file.progress}%`
                                : file.status === 'verifying'
                                  ? t('sessions.fileVerifying', 'Verifying…')
                                  : file.sizeLabel}
                        </span>
                      )}
                      {file.status === 'draft' ? (
                        t('sessions.attachmentDraft')
                      ) : file.status === 'preparing' ||
                        file.status === 'uploading' ||
                        file.status === 'verifying' ? (
                        <div {...stylex.props(styles.fileProgressTrack)}>
                          <div
                            {...stylex.props(styles.fileProgressFill)}
                            style={{
                              width: `${Math.max(0, Math.min(100, file.progress))}%`,
                            }}
                          />
                        </div>
                      ) : null}
                      <div {...stylex.props(styles.imageCorner)}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="mini"
                          icon

                          onClick={() => onFileRemove?.(file.id)}
                          aria-label={removeAttachmentLabel}
                        >
                          <X className={stylex.props(styles.glyph12).className} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <CombinedMentionTextarea
                enablePromptShortcuts={shortcutsEnabled}
                menuSide="top"
                id={promptId}
                ref={promptRef}
                mentionSource={mentionSource}
                availableCommands={availableCommands}
                commandsEnabled={commandsEnabled}
                skillAgent={skillAgent}
                currentSessionId={currentSessionId}
                value={promptValue}
                onValueChange={onPromptChange}
                externalMentions={pastedTextMentions}
                onExternalMentionsChange={handlePastedTextMentionsChange}
                onMentionClick={handleMentionClick}
                getMentionChip={getComposerMentionChip}
                onMentionRangesChange={handleMentionRangesChange}
                persistedMentions={persistedMentions}
                draftKey={draftKey}
                mentionActionsRef={mentionActionsRef}
                onKeyDown={onPromptKeyDown}
                onPaste={onPromptPaste}
                onCopy={handlePromptCopy}
                disabled={promptDisabled}
                rows={effectivePromptRows}
                enterKeyHint={promptEnterKeyHint}
                placeholder={resolvedPromptPlaceholder}
                // While the ⌘L focus hint is shown the box is empty, so the (long)
                // placeholder would otherwise run under the top-right ⌘L chip. Reserve
                // room for it so the placeholder wraps before the chip; the padding is
                // dropped once the user types (showFocusHint → false → full width).
                className="input-scrollbar"
                appearance="bare"
                focusRing={false}
                xstyle={[boxTextareaStyles, showFocusHint && styles.textareaHint]}
                data-keyboard-nav="composer"
              />

              {showFocusHint ? (
                <div
                  {...stylex.props(styles.focusHint)}
                  title={t('chat.composer.focusHint', {
                    defaultValue: 'Press {{shortcut}} to focus',
                    shortcut: formatKeyBinding(focusHintBinding!),
                  })}
                  aria-hidden="true"
                >
                  <Kbd binding={focusHintBinding!} />
                </div>
              ) : null}

              {statusMessage ? (
                <div
                  role={statusTone === 'error' ? 'alert' : 'status'}
                  aria-live={statusTone === 'error' ? 'assertive' : 'polite'}
                  className={statusStyle.className}
                >
                  <StatusGlyph {...statusMarkStyle} aria-hidden="true" />
                  <span>{statusMessage}</span>
                </div>
              ) : null}

              <div
                {...stylex.props(
                  styles.footer,
                  isLanding ? styles.footerLanding : styles.footerSession
                )}
              >
                {/* Single bottom-left "+" attachment entry (replaces the old
                    image + paperclip icons). Hidden when neither add callback
                    is provided. */}
                <AttachmentAddMenu
                  isMobile={isMobile}
                  isLanding={isLanding}
                  disabled={promptDisabled}
                  onAddAttachment={onAttachmentAddClick}
                  attachmentDisabled={attachmentAddDisabled}
                  mcp={mcp}
                  onScheduleSend={onScheduleSend}
                  scheduleDisabledReason={scheduleDisabledReason}
                />

                {/* Single row only: long model names must shrink/truncate inside
                    the run-config face rather than wrapping config chips onto a
                    second line (especially on mobile). */}
                <div {...stylex.props(styles.footerFace)}>{footerSelector ?? selector}</div>

                <div {...stylex.props(styles.footerActions)}>
                  {secondaryAction ? (
                    <Button
                      type="button"
                      variant={secondaryAction.variant ?? 'secondary'}
                      size={secondaryButtonSize}
                      onClick={() => {
                        void secondaryAction.onClick();
                      }}
                      disabled={secondaryAction.disabled}
                      className={secondaryAction.className}
                      xstyle={[secondaryButtonStyles, secondaryAction.xstyle]}
                    >
                      {secondaryAction.label}
                    </Button>
                  ) : null}
                  {primaryAction}
                </div>
              </div>
            </div>
            {bottomBar ? <div {...stylex.props(styles.bottomBar)}>{bottomBar}</div> : null}
          </div>
        ) : (
          <>
            <CombinedMentionTextarea
              enablePromptShortcuts={shortcutsEnabled}
              id={promptId}
              ref={promptRef}
              mentionSource={mentionSource}
              availableCommands={availableCommands}
              commandsEnabled={commandsEnabled}
              skillAgent={skillAgent}
              currentSessionId={currentSessionId}
              value={promptValue}
              onValueChange={onPromptChange}
              externalMentions={pastedTextMentions}
              onExternalMentionsChange={handlePastedTextMentionsChange}
              onMentionClick={handleMentionClick}
              getMentionChip={getComposerMentionChip}
              onMentionRangesChange={handleMentionRangesChange}
              persistedMentions={persistedMentions}
              draftKey={draftKey}
              mentionActionsRef={mentionActionsRef}
              onKeyDown={onPromptKeyDown}
              onPaste={onPromptPaste}
              onCopy={handlePromptCopy}
              disabled={promptDisabled}
              rows={effectivePromptRows}
              enterKeyHint={promptEnterKeyHint}
              placeholder={resolvedPromptPlaceholder}
              containerClassName={mentionContainerClassName}
              className="input-scrollbar"
              appearance="bare"
              focusRing={false}
              xstyle={dialogTextareaStyles}
              data-keyboard-nav="composer"
            />

            {statusMessage ? (
              <div
                role={statusTone === 'error' ? 'alert' : 'status'}
                aria-live={statusTone === 'error' ? 'assertive' : 'polite'}
                className={statusStyle.className}
              >
                <StatusGlyph {...statusMarkStyle} aria-hidden="true" />
                <span>{statusMessage}</span>
              </div>
            ) : null}

            <div {...stylex.props(styles.dialogRow)}>
              <div {...stylex.props(styles.dialogSelectors)}>{selector}</div>

              <div {...stylex.props(styles.dialogActions)}>
                {secondaryAction ? (
                  <Button
                    type="button"
                    variant={secondaryAction.variant ?? 'secondary'}
                    size={secondaryButtonSize}
                    onClick={() => {
                      void secondaryAction.onClick();
                    }}
                    disabled={secondaryAction.disabled}
                    className={secondaryAction.className}
                    xstyle={[secondaryButtonStyles, secondaryAction.xstyle]}
                  >
                    {secondaryAction.label}
                  </Button>
                ) : null}
                {primaryAction}
              </div>
            </div>
          </>
        )}
      </div>
      {(() => {
        const handlePastedTextOpenChange = (open: boolean) => {
          if (!open) {
            setPreviewPastedTextDraftId(null);
            setPreviewPastedTextEditorValue('');
          }
        };
        const summaryText = previewPastedTextDraft
          ? t('composer.pastedTextSummary', '{{charCount}} chars · {{lineCount}} lines', {
              charCount: numberFormatter.format(
                getPastedTextCharacterCount(previewPastedTextEditorValue)
              ),
              lineCount: numberFormatter.format(
                getPastedTextLineCount(previewPastedTextEditorValue)
              ),
            })
          : '';

        // The pasted text is still composer content, so its editor reads exactly
        // like the prompt: same face, weight, size and leading. `@lody/ui`'s
        // Textarea is a form control (medium weight, control tracking), which is
        // why this is a plain textarea, as the prompt itself is.
        const pastedTextEditor = (layout: stylex.StyleXStyles) => (
          <Textarea
            aria-label={pastedTextEditorLabel}
            value={previewPastedTextEditorValue}
            onChange={handlePastedTextDraftTextChange}
            readOnly={!onPastedTextDraftsChange}
            spellCheck={false}
            className={[
              'input-scrollbar',
              stylex.props(styles.pastedEditor, typography.prompt, layout).className,
            ]
              .filter(Boolean)
              .join(' ')}
          />
        );

        if (isMobile) {
          return (
            <Drawer.Root
              side="bottom"
              open={previewPastedTextDraft !== null}
              onOpenChange={handlePastedTextOpenChange}
            >
              <Drawer.Content side="bottom" closeButton={false} xstyle={styles.pastedDrawerContent}>
                {previewPastedTextDraft ? (
                  // Base UI wraps the children in a block box, so the column
                  // that lets the editor fill the sheet has to be ours, with a
                  // definite height for `flex-1` to divide.
                  <div {...stylex.props(styles.pastedDrawer)}>
                    <div {...stylex.props(styles.pastedDrawerGrabber)}>
                      <div {...stylex.props(styles.pastedDrawerHandle)} />
                    </div>
                    {/* The close shares the title's row so it centres on that
                        first line; the summary sits on its own line beneath. */}
                    <div {...stylex.props(styles.pastedDrawerHeader)}>
                      <div {...stylex.props(styles.pastedDrawerTitleRow)}>
                        <Drawer.Title
                          className={
                            stylex.props(styles.pastedTitle, styles.pastedDrawerTitle).className
                          }
                        >
                          <ClipboardPaste {...stylex.props(styles.glyph14, styles.glyphMuted)} />
                          {pastedTextDialogTitle}
                        </Drawer.Title>
                        <Drawer.Close
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="small"
                              icon
                              aria-label={t('common.close', 'Close')}
                            />
                          }
                        >
                          <X className={stylex.props(styles.glyph16).className} />
                        </Drawer.Close>
                      </div>
                      <Drawer.Description
                        className={
                          stylex.props(styles.pastedSummary, styles.pastedDrawerSummary).className
                        }
                      >
                        {summaryText}
                      </Drawer.Description>
                    </div>
                    {pastedTextEditor(styles.pastedEditorMobile)}
                  </div>
                ) : null}
              </Drawer.Content>
            </Drawer.Root>
          );
        }

        return (
          <Dialog.Root
            open={previewPastedTextDraft !== null}
            onOpenChange={handlePastedTextOpenChange}
          >
            <Dialog.Content
              closeButton={false}
              width="48rem"
              padding="none"
              gap="none"
              xstyle={styles.pastedDialogContent}
            >
              {previewPastedTextDraft ? (
                <>
                  <div {...stylex.props(styles.pastedDialogHeader)}>
                    <Dialog.Title className={stylex.props(styles.pastedTitle).className}>
                      <ClipboardPaste {...stylex.props(styles.glyph14, styles.glyphMuted)} />
                      {pastedTextDialogTitle}
                    </Dialog.Title>
                    <div {...stylex.props(styles.pastedDialogTitleRow)}>
                      <Dialog.Description className={stylex.props(styles.pastedSummary).className}>
                        {summaryText}
                      </Dialog.Description>
                      <Dialog.Close aria-label={t('common.close', 'Close')}>
                        <X className={stylex.props(styles.glyph16).className} />
                      </Dialog.Close>
                    </div>
                  </div>
                  <div {...stylex.props(styles.pastedDialogBody)}>
                    {pastedTextEditor(styles.pastedEditorDesktop)}
                  </div>
                </>
              ) : null}
            </Dialog.Content>
          </Dialog.Root>
        );
      })()}
    </>
  );
}
