import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from 'react';
import { ClipboardPaste, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AcpCommandSummary } from '@lody/shared';
import { AttachmentAddMenu, type AttachmentAddMenuMcp } from './attachment-add-menu';
import { CommentReferenceChip, type CommentReferenceChipItem } from './comment-reference-chip';
import {
  VisualAnnotationReferenceChip,
  type VisualAnnotationReferenceChipItem,
} from './visual-annotation-reference-chip';
import { cn } from '@/lib/utils';
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
  getPastedTextClipboardTextForSelection,
  getPastedTextLineCount,
  updatePastedTextDraftContent,
  type PastedTextDraft,
} from '@/lib/pasted-text-draft';
import type { Mention as MentionRange } from '@/ui/mention/index';
import type { PersistedMentionRange } from '@/components/mentions/mention-persistence';
import { toIntlLocale } from '@/lib/intl-locale';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button, type ButtonProps } from '@/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogContentWithoutClose,
  DialogDescription,
  DialogTitle,
} from '@/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';
import { Textarea, type TextareaProps } from '@/ui/textarea';
import { getFilesFromDataTransfer, hasFileTransfer } from '@/lib/file-drop';
import {
  getChatComposerPromptPlaceholderKey,
  getChatComposerMobilePromptPlaceholderKey,
} from '@/lib/chat-composer-placeholder';
import { Kbd } from '@/components/commands/kbd';
import { commands, formatKeyBinding } from '@/lib/commands';

type ChatComposerTone = 'light' | 'dark';
type ChatComposerVariant = 'landing' | 'session' | 'dialog';
type ChatComposerStatusTone = 'error' | 'warning' | 'info';

export interface ChatComposerAction {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  variant?: ButtonProps['variant'];
  className?: string;
}

export interface ChatComposerImageItem {
  id: string;
  name: string;
  previewUrl: string;
  status: 'uploading' | 'uploaded' | 'failed';
  progress: number;
  error?: string;
}

export interface ChatComposerFileItem {
  id: string;
  name: string;
  /** Human-readable size (e.g. "2.4 MB"); rendered as the chip subtitle. */
  sizeLabel: string;
  status: 'preparing' | 'uploading' | 'verifying' | 'uploaded' | 'failed';
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
  imageDropDisabled?: boolean;
  onImageDrop?: (files: File[]) => void;
  onImageRemove?: (id: string) => void;
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
  /**
   * Marks the next viewport resize as caused by this composer's height change,
   * so a parent conversation can preserve the reader's scroll position.
   */
  skipNextViewportResizeAutoScrollRef?: MutableRefObject<boolean>;
  /** Focus the textarea when clicking the container background. */
  focusOnContainerClick?: boolean;
}

export function getChatComposerTextareaClassName({
  variant,
  isMobile = false,
}: {
  tone: ChatComposerTone;
  variant: ChatComposerVariant;
  isMobile?: boolean;
}) {
  const isLanding = variant === 'landing';

  return cn(
    'input-scrollbar resize-none text-sm leading-6 transition-shadow',
    isLanding
      ? 'min-h-[120px] border-transparent bg-transparent px-0 py-0 sm:min-h-[140px]'
      : cn(
          'border-transparent bg-transparent px-1 py-0',
          // Mobile session composer floors at a single line; desktop keeps two.
          isMobile ? 'min-h-[24px]' : 'min-h-[48px]'
        ),
    'focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0',
    'text-input-foreground placeholder:text-input-placeholder'
  );
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
  imageDropDisabled = attachmentAddDisabled,
  onImageDrop,
  onImageRemove,
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
  skipNextViewportResizeAutoScrollRef,
  focusOnContainerClick = false,
}: ChatComposerProps) {
  const { t, i18n } = useTranslation();
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
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
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
  const resolvedPromptPlaceholder =
    promptPlaceholder ??
    (isMobile
      ? t(getChatComposerMobilePromptPlaceholderKey({ mentionSource, skillAgent }))
      : t(
          getChatComposerPromptPlaceholderKey({
            mentionSource,
            availableCommands,
            skillAgent,
          })
        ));
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
      const clipboardText = getPastedTextClipboardTextForSelection({
        value: promptValue,
        drafts: pastedTextDrafts,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
      });

      if (clipboardText === null) {
        return;
      }

      event.preventDefault();
      event.clipboardData.setData('text/plain', clipboardText);
    },
    [pastedTextDrafts, promptValue]
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
      const files = getFilesFromDataTransfer(event.dataTransfer);
      if (files.length > 0) {
        onImageDrop?.(files);
      }
    },
    [canHandleImageDrop, onImageDrop, resetImageDragState]
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

    const previousHeight = textarea.style.height;

    // Reset height to auto to get accurate scrollHeight
    textarea.style.height = 'auto';

    // Calculate new height, clamped between min and max.
    // When empty, ignore scrollHeight: Chromium includes the wrapped placeholder
    // text in an empty textarea's scrollHeight, so a long placeholder would grow
    // the box past minHeight and then visibly shrink on the first keystroke.
    const hasValue = (promptValue ?? '').length > 0;
    const scrollHeight = textarea.scrollHeight;
    const newHeight = hasValue ? Math.max(minHeight, Math.min(scrollHeight, maxHeight)) : minHeight;

    const nextHeight = `${newHeight}px`;
    if (previousHeight && previousHeight !== nextHeight && skipNextViewportResizeAutoScrollRef) {
      skipNextViewportResizeAutoScrollRef.current = true;
    }
    textarea.style.height = nextHeight;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [
    autoResize,
    promptValue,
    promptRef,
    effectivePromptRows,
    maxRows,
    skipNextViewportResizeAutoScrollRef,
  ]);

  const boxTextareaClassName = getChatComposerTextareaClassName({ tone, variant, isMobile });

  /**
   * The colour a mention decoration paints to hide the textarea's own glyphs
   * before redrawing them in the mention colour. It has to equal whatever this
   * composer paints behind the textarea, or the "invisible" cover shows up as a
   * rectangle — which is exactly what `--input` did here, since this surface is
   * deliberately `bg-background` rather than the muddy `bg-input`.
   *
   * KEEP IN SYNC with the `bg-*` classes below. CSS cannot read an ancestor's
   * background, so this is a copy, and a copy can drift.
   */
  const mentionSurfaceClassName =
    '[--mention-chip-surface:hsl(var(--background))] dark:[--mention-chip-surface:color-mix(in_srgb,hsl(var(--input))_90%,hsl(var(--background)))]';

  // Linear-like light surface: white canvas + hairline border + soft lift.
  // Avoid heavy bg-input fills that read as muddy gray on cool-white themes.
  const mentionContainerClassName = !isLanding
    ? cn(
        'w-full',
        'focus-within:ring-1 focus-within:ring-offset-0',
        'focus-within:outline-hidden',
        'rounded-2xl border border-foreground/[0.10] bg-background focus-within:ring-ring/30 dark:border-input-border/70 dark:bg-input/90',
        mentionSurfaceClassName
      )
    : undefined;

  const dialogTextareaClassName = cn(
    'input-scrollbar min-h-[120px] resize-none px-4 py-3 text-sm leading-6 transition-shadow sm:min-h-[120px]',
    'w-full rounded-2xl border-transparent bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0',
    'text-input-foreground placeholder:text-input-placeholder'
  );

  const actionBaseClassName = cn(
    'select-none border font-semibold transition-all focus-visible:ring-2 focus-visible:ring-offset-2',
    isDialog
      ? 'h-10 rounded-lg px-5 text-sm'
      : isLanding
        ? 'h-6 rounded-[4px] px-2 text-[11px] leading-tight'
        : 'h-7 rounded-md px-2.5 text-xs'
  );

  const actionWidthClassName = isLanding ? 'w-auto shrink-0' : 'w-auto';

  const landingContainerClassName = cn(
    'flex flex-col gap-4 rounded-xl border px-4 pt-4 pb-3 transition-shadow focus-within:ring-1',
    'border-foreground/[0.10] bg-background shadow-[0_1px_2px_hsl(0_0%_0%/0.04),0_8px_24px_-12px_hsl(0_0%_0%/0.08)] focus-within:ring-ring/30',
    'dark:border-input-border/60 dark:bg-input/90 dark:shadow-[0_22px_70px_-48px_rgba(15,23,42,0.25)] dark:focus-within:ring-ring/40',
    mentionSurfaceClassName
  );

  const sessionContainerClassName = cn(
    'flex flex-col gap-1 rounded-xl border px-2 py-1.5 transition-colors duration-150',
    'border border-foreground/[0.10] bg-background focus-within:border-ring/40',
    'dark:border-input-border/70 dark:bg-input/90',
    mentionSurfaceClassName
  );

  const boxContainerClassName = isLanding ? landingContainerClassName : sessionContainerClassName;
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
  const imageDropClassName = isImageDropActive
    ? 'border-primary/50 bg-primary/[0.04] ring-2 ring-primary/25'
    : undefined;
  const boxFooterClassName = cn(
    'flex select-none items-center gap-x-2',
    isLanding ? 'pt-2' : 'pt-0.5'
  );
  const statusClassName = cn(
    'px-1 text-xs leading-snug',
    statusTone === 'error'
      ? 'text-destructive'
      : statusTone === 'warning'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground'
  );

  const secondaryButtonClassName = cn(
    actionBaseClassName,
    'border-foreground/[0.10] bg-background text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground focus-visible:ring-ring',
    'dark:border-input-border/60 dark:bg-input/60 dark:text-input-foreground dark:hover:bg-muted/60'
  );

  return (
    <>
      <div
        className={cn(
          'flex w-full flex-col',
          isDialog ? 'gap-3' : isLanding ? 'gap-12' : 'gap-2',
          className
        )}
      >
        {title ? (
          <div className="text-center">
            <h1 className="select-none text-2xl leading-tight sm:text-3xl">{title}</h1>
          </div>
        ) : null}

        {!isDialog ? (
          <div className={cn('flex flex-col', isLanding ? 'gap-2' : 'gap-1')}>
            {/* Top selector (repo, branch) - shown outside and above the input box */}
            {topSelector ? (
              <div className="flex w-full min-w-0 select-none items-center gap-1">
                {topSelector}
              </div>
            ) : null}
            <div
              className={cn(boxContainerClassName, imageDropClassName, 'group relative')}
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
                <div className="flex flex-wrap gap-2 pb-1">
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
                <div className="flex flex-wrap gap-2 pb-1">
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
                <div className="input-scrollbar flex gap-2 overflow-x-auto pb-1">
                  {imageItems.map((image) => (
                    <div
                      key={image.id}
                      title={
                        image.status === 'failed' ? image.error || uploadFailedLabel : undefined
                      }
                      className={cn(
                        'relative shrink-0 overflow-hidden rounded-xl border',
                        isMobile ? 'h-[104px] w-[104px]' : 'h-20 w-20',
                        image.status === 'failed' && 'border-destructive/50'
                      )}
                    >
                      <button
                        type="button"
                        className="h-full w-full"
                        onClick={() => setPreviewImageUrl(image.previewUrl)}
                        aria-label={image.name}
                      >
                        <img
                          src={image.previewUrl}
                          alt={image.name}
                          className={cn(
                            'h-full w-full object-cover',
                            image.status !== 'uploaded' && 'grayscale'
                          )}
                        />
                        {image.status === 'uploading' ? (
                          <div
                            className="absolute inset-0 bg-black/45 transition-[clip-path]"
                            style={{
                              clipPath: `inset(${Math.max(0, Math.min(100, image.progress))}% 0 0 0)`,
                            }}
                          />
                        ) : null}
                        {image.status === 'failed' ? (
                          <div className="absolute inset-0 bg-black/45" />
                        ) : null}
                      </button>
                      <div className="absolute right-1 top-1">
                        <Button
                          type="button"
                          variant="secondary"
                          size="icon"
                          className={cn('rounded-full', isMobile ? 'h-6 w-6' : 'h-5 w-5')}
                          onClick={() => onImageRemove?.(image.id)}
                          aria-label={removeImageLabel}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                      {image.status === 'uploading' ? (
                        <div className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-center text-[10px] text-white">
                          {image.progress}%
                        </div>
                      ) : null}
                      {image.status === 'failed' ? (
                        <button
                          type="button"
                          onClick={() => onImageRetry?.(image.id)}
                          aria-label={retryUploadLabel}
                          className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/65 px-1 py-1 text-[10px] font-medium text-white transition hover:bg-black/75"
                        >
                          <RefreshCw className="h-3 w-3 shrink-0" />
                          <span className="truncate">{uploadFailedShortLabel}</span>
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {fileItems.map((file) => (
                    <div
                      key={file.id}
                      title={file.status === 'failed' ? file.error || uploadFailedLabel : undefined}
                      className={cn(
                        'relative flex shrink-0 flex-col overflow-hidden rounded-xl border p-2',
                        isMobile ? 'h-[104px] w-[104px]' : 'h-20 w-20',
                        file.status === 'failed'
                          ? 'border-destructive/45 bg-muted/60'
                          : 'border-border/60 bg-muted/60'
                      )}
                    >
                      <span
                        className={cn(
                          'max-w-[64%] truncate font-semibold uppercase tracking-wide',
                          file.status === 'failed'
                            ? 'text-destructive/80'
                            : 'text-muted-foreground',
                          isMobile ? 'text-xs' : 'text-[10px]'
                        )}
                      >
                        {getFileTypeLabel(file.name)}
                      </span>
                      <span
                        className={cn(
                          'mt-1 break-words text-left font-medium text-input-foreground',
                          isMobile ? 'line-clamp-3 text-sm' : 'line-clamp-2 text-xs'
                        )}
                      >
                        {file.name}
                      </span>
                      {file.status === 'failed' ? (
                        <button
                          type="button"
                          onClick={() => onFileRetry?.(file.id)}
                          aria-label={retryUploadLabel}
                          className="mt-auto flex w-fit items-center gap-1 pt-1 text-[10px] font-medium text-destructive transition hover:text-destructive/80"
                        >
                          <RefreshCw className="h-3 w-3 shrink-0" />
                          <span className="truncate">{uploadFailedShortLabel}</span>
                        </button>
                      ) : (
                        <span className="mt-auto truncate pt-1 text-[10px] text-muted-foreground">
                          {file.status === 'preparing'
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
                      {file.status === 'preparing' ||
                      file.status === 'uploading' ||
                      file.status === 'verifying' ? (
                        <div className="absolute inset-x-0 bottom-0 h-1 bg-muted">
                          <div
                            className="h-full bg-primary transition-[width]"
                            style={{
                              width: `${Math.max(0, Math.min(100, file.progress))}%`,
                            }}
                          />
                        </div>
                      ) : null}
                      <div className="absolute right-1 top-1">
                        <Button
                          type="button"
                          variant="secondary"
                          size="icon"
                          className={cn('rounded-full', isMobile ? 'h-6 w-6' : 'h-5 w-5')}
                          onClick={() => onFileRemove?.(file.id)}
                          aria-label={removeAttachmentLabel}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <CombinedMentionTextarea
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
                onMentionRangesChange={onMentionRangesChange}
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
                className={cn(boxTextareaClassName, showFocusHint && 'pr-16')}
                data-keyboard-nav="composer"
              />

              {showFocusHint ? (
                <div
                  className="pointer-events-none absolute right-3 top-3 z-10 flex items-center opacity-50 transition-opacity duration-150 group-focus-within:opacity-0"
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
                  className={statusClassName}
                >
                  {statusMessage}
                </div>
              ) : null}

              <div className={boxFooterClassName}>
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
                />

                {/* Single row only: long model names must shrink/truncate inside
                    the run-config face rather than wrapping config chips onto a
                    second line (especially on mobile). */}
                <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-x-2 overflow-hidden">
                  {footerSelector ?? selector}
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {secondaryAction ? (
                    <Button
                      type="button"
                      variant={secondaryAction.variant ?? 'ghost'}
                      onClick={() => {
                        void secondaryAction.onClick();
                      }}
                      disabled={secondaryAction.disabled}
                      className={cn(
                        actionWidthClassName,
                        secondaryButtonClassName,
                        secondaryAction.className
                      )}
                    >
                      {secondaryAction.label}
                    </Button>
                  ) : null}
                  {primaryAction}
                </div>
              </div>
            </div>
            {bottomBar ? <div className="select-none px-4 pt-1">{bottomBar}</div> : null}
          </div>
        ) : (
          <>
            <CombinedMentionTextarea
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
              onMentionRangesChange={onMentionRangesChange}
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
              className={dialogTextareaClassName}
              data-keyboard-nav="composer"
            />

            {statusMessage ? (
              <div
                role={statusTone === 'error' ? 'alert' : 'status'}
                aria-live={statusTone === 'error' ? 'assertive' : 'polite'}
                className={statusClassName}
              >
                {statusMessage}
              </div>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex w-full flex-wrap select-none items-end gap-2">{selector}</div>

              <div className="flex w-full flex-col select-none gap-2 sm:ml-auto sm:w-auto sm:flex-row sm:items-center sm:justify-end">
                {secondaryAction ? (
                  <Button
                    type="button"
                    variant={secondaryAction.variant ?? 'ghost'}
                    onClick={() => {
                      void secondaryAction.onClick();
                    }}
                    disabled={secondaryAction.disabled}
                    className={cn(
                      actionWidthClassName,
                      secondaryButtonClassName,
                      secondaryAction.className
                    )}
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
      <Dialog
        open={previewImageUrl !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewImageUrl(null);
          }
        }}
      >
        <DialogContent className="max-w-3xl border-none bg-transparent p-2 shadow-none">
          {previewImageUrl ? (
            <img
              src={previewImageUrl}
              alt={imagePreviewLabel}
              className="max-h-[80vh] w-full rounded-lg object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>
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

        if (isMobile) {
          return (
            <Sheet open={previewPastedTextDraft !== null} onOpenChange={handlePastedTextOpenChange}>
              <SheetContent
                side="bottom"
                className="flex h-[85vh] flex-col gap-0 rounded-t-2xl p-0"
              >
                {previewPastedTextDraft ? (
                  <>
                    <div className="flex shrink-0 justify-center pt-2 pb-1">
                      <div className="h-1 w-9 rounded-full bg-muted-foreground/30" />
                    </div>
                    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
                      <SheetTitle className="flex items-center gap-2 text-sm font-medium">
                        <ClipboardPaste className="h-3.5 w-3.5 text-muted-foreground" />
                        {pastedTextDialogTitle}
                      </SheetTitle>
                      <SheetDescription className="text-xs text-muted-foreground tabular-nums">
                        {summaryText}
                      </SheetDescription>
                    </div>
                    <Textarea
                      aria-label={pastedTextEditorLabel}
                      value={previewPastedTextEditorValue}
                      onChange={handlePastedTextDraftTextChange}
                      readOnly={!onPastedTextDraftsChange}
                      spellCheck={false}
                      autoFocus={false}
                      className="input-scrollbar min-h-0 flex-1 resize-none rounded-none border-0 bg-background px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
                    />
                  </>
                ) : null}
              </SheetContent>
            </Sheet>
          );
        }

        return (
          <Dialog open={previewPastedTextDraft !== null} onOpenChange={handlePastedTextOpenChange}>
            <DialogContentWithoutClose className="flex h-[85vh] max-h-[85vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
              {previewPastedTextDraft ? (
                <>
                  <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
                    <DialogTitle className="flex items-center gap-2 text-sm font-medium">
                      <ClipboardPaste className="h-3.5 w-3.5 text-muted-foreground" />
                      {pastedTextDialogTitle}
                    </DialogTitle>
                    <div className="flex items-center gap-3">
                      <DialogDescription className="text-xs text-muted-foreground tabular-nums">
                        {summaryText}
                      </DialogDescription>
                      <DialogClose
                        className="rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2"
                        aria-label={t('common.close', 'Close')}
                      >
                        <X className="h-4 w-4" />
                      </DialogClose>
                    </div>
                  </div>
                  <div className="flex min-h-0 flex-1 px-5 py-4">
                    <Textarea
                      aria-label={pastedTextEditorLabel}
                      value={previewPastedTextEditorValue}
                      onChange={handlePastedTextDraftTextChange}
                      readOnly={!onPastedTextDraftsChange}
                      spellCheck={false}
                      className="input-scrollbar h-full min-h-0 w-full resize-none overflow-auto rounded-md border-transparent bg-muted/30 px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
                    />
                  </div>
                </>
              ) : null}
            </DialogContentWithoutClose>
          </Dialog>
        );
      })()}
    </>
  );
}
