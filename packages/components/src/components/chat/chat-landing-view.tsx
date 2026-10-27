import { useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { currentWorkspaceIdAtom } from '@/atoms';
import { readPastedSessionLink } from '@/lib/session-deep-link';
import type { ClipboardEvent, KeyboardEvent, ReactNode, Ref } from 'react';
import { usePostHog } from '@posthog/react';
import type { Mention as MentionRange } from '@/ui/mention/index';
import type { CombinedMentionTextareaHandle } from '@/components/mentions/combined-mention-textarea';
import type { PersistedMentionRange } from '@/components/mentions/mention-persistence';

import type { AcpCommandSummary, AgentConfigCliType } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';
import { useSessionMentionDropZone } from '@/hooks/use-session-mention-drag';
import { Button } from '@lody/ui/button';
import {
  ChatComposer,
  type ChatComposerFileItem,
  type ChatComposerImageItem,
} from '@/components/chat/chat-composer';
import type { AttachmentAddMenuMcp } from '@/components/chat/attachment-add-menu';
import { ErrorBoundary } from '@/components/error-boundary';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import { ArrowUp, Settings } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import type { PastedTextDraft } from '@/lib/pasted-text-draft';
import { getDroppedFileLocalPath, toPathMentionInsertion } from '@/lib/dropped-local-path';
import { isPlainLinkPasteShortcut, parseAppSessionUrl } from '@/lib/session-app-url';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { MobileChatLandingScreen } from '@/components/mobile/mobile-chat-landing-screen';
import { NoMachineHint, type NoMachineHintVariant } from './no-machine-hint';
import { WebChatLandingScreen } from './web-chat-landing-screen';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  /* The hint button. */
  hintButton: {
    display: 'flex',
    width: 'fit-content',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: themeColors.border,
    backgroundColor: {
      default: 'hsl(var(--background) / 0.7)',
      ':hover': 'hsl(var(--muted) / 0.6)',
    },
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[1.5],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.foreground,
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },

  /* The no-agent-config hint. */
  hint: {
    marginTop: themeSpace[4],
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[3],
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: 'hsl(var(--background) / 0.6)',
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
    color: themeColors.mutedForeground,
  },
  hintGlyph: {
    marginTop: '0.5px',
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    opacity: 0.7,
  },
  hintBody: { display: 'flex', flexGrow: 1, flexDirection: 'column', gap: themeSpace[2] },
  hintText: { fontSize: themeFontSize.sm, lineHeight: themeLineHeight.sm },

  /* The composer glyphs. */
  glyph16: { width: themeSpace[4], height: themeSpace[4] },

  /* The composer fallback, when it fails to render. */
  fallback: {
    width: '100%',
    borderRadius: themeRadius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: 'hsl(var(--background) / 0.8)',
    padding: themeSpace[4],
  },
  fallbackTitle: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.semibold,
    color: themeColors.foreground,
  },
  fallbackDetail: {
    marginTop: themeSpace[1],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  fallbackPrompt: {
    marginTop: themeSpace[3],
    width: '100%',
    resize: 'none',
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--input-border) / 0.7)',
    backgroundColor: themeColors.inputField,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.inputForeground,
    '::placeholder': { color: themeColors.inputPlaceholder },
    /* The Tailwind `focus-visible:ring-2` this textarea used to carry declared
       a full box-shadow in the utilities layer, which erased the global inset
       focus ring. It painted no ring of its own — the app forces Tailwind rings
       transparent — so the textarea showed NO focus indicator. Keep that: no
       resting shadow, and no focus shadow. */
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  fallbackStatus: {
    marginTop: themeSpace[2],
    paddingInline: themeSpace[1],
    fontSize: themeFontSize.xs,
    lineHeight: '1.375',
  },
  fallbackStatusMuted: { color: themeColors.mutedForeground },
  fallbackStatusError: { color: themeColors.destructive },
  fallbackActions: {
    marginTop: themeSpace[3],
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  fallbackSelectors: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: themeSpace[1],
  },
  fallbackActionsEnd: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  retryButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: themeColors.inputBorder,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    color: { default: themeColors.foreground, ':hover': themeColors.hoverForeground },
    backgroundColor: { default: themeColors.background, ':hover': themeColors.hover },
  },
});

export type ChatLandingTone = 'light' | 'dark';

export type ChatLandingHintType = 'no-machine' | 'no-agent-config' | null;

export interface ChatLandingViewProps {
  /** Color tone for the landing page */
  tone: ChatLandingTone;
  /** Whether the view is in mobile mode */
  isMobile?: boolean;
  /** Scope root for desktop keyboard navigation (web layout only) — wraps the config
   *  controls + composer so arrow/Esc nav stays out of the sidebar and page chrome. */
  navRootRef?: Ref<HTMLDivElement>;
  /** Mention source for @ / # input enhancement */
  mentionSource?: MentionProjectSource;
  /** Available slash commands for / mention */
  availableCommands?: AcpCommandSummary[];
  /** Selected ACP provider — filters the `$` skill mention to its skill dirs.
     `machineId` (the selected agent's machine) lets the `$` menu surface that
     machine's global skills in non-local chats. */
  skillAgent?: { cliType: AgentConfigCliType; agentType: string; machineId?: string };
  /** Page title displayed above the composer */
  title: string;
  /** Current prompt value */
  promptValue: string;
  /** Callback when prompt changes */
  onPromptChange: (value: string) => void;
  /** Callback for prompt keydown events */
  onPromptKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Callback for prompt paste events */
  onPromptPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Callback when files are dropped onto the composer */
  onImageDrop?: (files: File[]) => void;
  /** Placeholder text for the prompt textarea */
  promptPlaceholder?: string;
  compactPlaceholderName?: string | null;
  /** Mobile keyboard action hint for the prompt textarea */
  promptEnterKeyHint?: 'send' | 'enter';
  /** Ref for the prompt textarea */
  promptRef?: Ref<HTMLTextAreaElement>;
  /** Inline pasted text drafts rendered as protected tokens inside the textarea */
  pastedTextDrafts?: PastedTextDraft[];
  /** Callback when pasted text draft ranges change */
  onPastedTextDraftsChange?: (drafts: PastedTextDraft[]) => void;
  onMentionRangesChange?: (ranges: MentionRange[]) => void;
  persistedMentions?: readonly PersistedMentionRange[];
  /** Pending image drafts shown above the textarea */
  imageItems?: ChatComposerImageItem[];
  /** Whether the unified attachment picker should be disabled */
  attachmentAddDisabled?: boolean;
  /** Callback when the unified attachment picker is clicked */
  onAttachmentAddClick?: () => void;
  /** Callback when a pending image is removed */
  onImageRemove?: (id: string) => void;
  /** Callback when retrying a failed image upload */
  onImageRetry?: (id: string) => void;
  /** Pending file (non-image) drafts shown above the textarea */
  fileItems?: ChatComposerFileItem[];
  /** Callback when a pending file is removed */
  onFileRemove?: (id: string) => void;
  /** Callback when retrying a failed file upload */
  onFileRetry?: (id: string) => void;
  /** Per-turn MCP selection, rendered inside the composer's "+" menu. */
  mcp?: AttachmentAddMenuMcp;
  /** @deprecated Use topSelector and footerSelector instead */
  selector?: ReactNode;
  /** Selector node displayed above the textarea (e.g., repo, branch) */
  topSelector?: ReactNode;
  /** Selector node displayed inside the input footer (e.g., model, mode) */
  footerSelector?: ReactNode;
  /** Node displayed below the input box (e.g., machine, agent) */
  bottomBar?: ReactNode;
  /** Persistent notice rendered above the composer (e.g. free-plan limits). */
  composerNotice?: ReactNode;
  /** Inline composer status, used for validation and local context errors. */
  composerStatusMessage?: ReactNode;
  composerStatusTone?: 'error' | 'warning' | 'info';
  /** Context switch (Local Projects / GitHub Worktrees) shown below the title */
  contextSwitch?: ReactNode;
  /** Shown under the desktop greeting; the mobile landing ignores it. */
  ambient?: ReactNode;
  /** Whether the submit button is disabled */
  submitDisabled?: boolean;
  /** Draft is handed off for durable acceptance but remains restorable on failure. */
  submissionPending?: boolean;
  /** Callback when submit button is clicked */
  onSubmit?: () => void;
  /** Label for submit button when submitting */
  submitLabel?: string;
  /** Label for submit button when idle */
  submittingLabel?: string;
  /** Hint type to display around the composer area */
  hintType?: ChatLandingHintType;
  /**
   * Which flavour of the no-machine hint to show. `download-client` (the
   * default) tells web/mobile users to download the desktop client; in the
   * Electron client we instead reassure that the local daemon is still coming
   * up (`daemon-starting`).
   */
  noMachineVariant?: NoMachineHintVariant;
  /** No-machine hint message shown to web/mobile users without a client. */
  hintDownloadClientTitle?: string;
  hintDownloadClientMessage?: string;
  /** Label for the download-client button. */
  hintDownloadClientLabel?: string;
  /** No-machine hint message shown in the Electron client while the daemon boots. */
  hintDaemonStartingTitle?: string;
  hintDaemonStartingMessage?: string;
  /** Label for the report-bug button in the daemon-starting hint. */
  hintReportBugLabel?: string;
  /** Hint message for no agent config */
  hintNoAgentConfigMessage?: string;
  /** Label for go to settings button */
  hintGoToSettingsLabel?: string;
  /** Discord help message shown in the no-machine hint */
  hintDiscordMessage?: string;
  /** Discord link label */
  hintDiscordLabel?: string;
  /** Callback when the download-client button is clicked */
  onDownloadClient?: () => void;
  /** Callback when the report-bug button (daemon-starting hint) is clicked */
  onReportBug?: () => void;
  /** Callback when go to agent settings button is clicked */
  onGoToAgentSettings?: () => void;
  /** Callback when mobile drawer open button is clicked */
  onOpenMobileDrawer?: () => void;
  /**
   * Floating top-left action shown only on desktop. Used to expand the left
   * sidebar when it is collapsed; rendered as an absolute overlay so the
   * desktop layout stays header-less.
   */
  leftSidebarExpandSlot?: ReactNode;
  /** Error boundary reset keys */
  resetKeys?: unknown[];
  /** Labels for error boundary fallback */
  errorLabels?: {
    somethingWentWrong?: string;
    composerCrashed?: string;
    tryAgain?: string;
    unavailable?: string;
  };
}

/**
 * Landing-wide drop target for a session dragged out of the sidebar.
 *
 * Owned here rather than in `chat-landing.tsx` because nothing outside this
 * layout needs it: the handle goes straight into the composer it renders, and
 * the drop writes a mention into that composer's draft. Mobile gets the handle
 * but no drop target — touch has no HTML5 drag.
 */
function useSessionMentionDrop(enabled: boolean) {
  const mentionActionsRef = useRef<CombinedMentionTextareaHandle | null>(null);
  const { dropZone, overlayActive } = useSessionMentionDropZone({
    enabled,
    onDropSessionId: useCallback((sessionId: string) => {
      mentionActionsRef.current?.insertSessionMention(sessionId);
    }, []),
  });
  return {
    mentionActionsRef,
    dropZone,
    overlayActive,
  };
}

export function ChatLandingView({
  tone,
  isMobile = false,
  navRootRef,
  mentionSource,
  availableCommands,
  skillAgent,
  title,
  promptValue,
  onPromptChange,
  onPromptKeyDown,
  onPromptPaste,
  onImageDrop,
  promptPlaceholder,
  compactPlaceholderName,
  promptEnterKeyHint = 'send',
  promptRef,
  pastedTextDrafts = [],
  onPastedTextDraftsChange,
  onMentionRangesChange,
  persistedMentions,
  imageItems = [],
  attachmentAddDisabled = false,
  onAttachmentAddClick,
  onImageRemove,
  onImageRetry,
  fileItems = [],
  onFileRemove,
  onFileRetry,
  mcp,
  selector,
  topSelector,
  footerSelector,
  bottomBar,
  composerNotice,
  composerStatusMessage,
  composerStatusTone = 'info',
  contextSwitch,
  ambient,
  submitDisabled = false,
  submissionPending = false,
  onSubmit,
  submitLabel = 'Send',
  submittingLabel = 'Sending...',
  hintType = null,
  noMachineVariant = 'download-client',
  hintDownloadClientTitle = "Nothing's plugged in yet",
  hintDownloadClientMessage = 'Your agents run on the desktop client. Install and open it, and your machine will show up here.',
  hintDownloadClientLabel = 'Download the client',
  hintDaemonStartingTitle = 'Plugging in…',
  hintDaemonStartingMessage = "The local daemon doesn't seem to have finished starting yet. If you run into trouble, report a bug and we'll take a look.",
  hintReportBugLabel = 'Report a Bug',
  hintNoAgentConfigMessage = 'No agent configured. Go to settings to create one:',
  hintGoToSettingsLabel = 'Go to Settings',
  hintDiscordMessage = 'Have questions? Join our Discord community for help.',
  hintDiscordLabel = 'Discord',
  onDownloadClient,
  onReportBug,
  onGoToAgentSettings,
  onOpenMobileDrawer,
  leftSidebarExpandSlot,
  resetKeys = [],
  errorLabels = {},
}: ChatLandingViewProps) {
  const postHog = usePostHog();
  const { mentionActionsRef, dropZone, overlayActive } = useSessionMentionDrop(
    !isMobile && !submissionPending
  );
  // A folder is not an attachment — it becomes a `@path` mention, through the
  // same handle the session drop uses, so it lands in this composer's draft.
  const handleDirectoryDrop = useCallback(
    (directories: File[]) => {
      const insertions = directories.flatMap((directory) => {
        const localPath = getDroppedFileLocalPath(directory);
        return localPath ? [toPathMentionInsertion(localPath, 'dir')] : [];
      });
      mentionActionsRef.current?.insertPathMentions(insertions);
    },
    [mentionActionsRef]
  );
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const handlePromptPasteWithSessionUrl = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const text = event.clipboardData.getData('text/plain');
      // Cmd/Ctrl+Shift+V keeps a conversation URL as a plain link.
      const sessionUrl = text
        ? (readPastedSessionLink(text, workspaceId) ?? parseAppSessionUrl(text))
        : null;
      if (sessionUrl) {
        if (isPlainLinkPasteShortcut(event)) {
          capturePostHogEvent(postHog, 'mention/session_link_pasted', {
            converted: false,
            surface: 'chat_landing',
          });
        } else {
          const target = event.currentTarget;
          const at = target.selectionStart ?? target.value.length;
          const replaceEnd = target.selectionEnd ?? at;
          if (
            mentionActionsRef.current?.insertSessionMention(sessionUrl.sessionId, {
              at,
              replaceEnd,
            })
          ) {
            capturePostHogEvent(postHog, 'mention/session_link_pasted', {
              converted: true,
              surface: 'chat_landing',
            });
            event.preventDefault();
            return;
          }
        }
      }
      onPromptPaste?.(event);
    },
    [mentionActionsRef, onPromptPaste, postHog, workspaceId]
  );

  const {
    somethingWentWrong = 'Something went wrong',
    composerCrashed = 'The chat composer failed to render. Your draft is preserved below.',
    tryAgain = 'Try again',
  } = errorLabels;

  // `group` stays a plain class: the hint button is the group anchor.
  const hintButtonClassName = ['group', stylex.props(styles.hintButton).className]
    .filter(Boolean)
    .join(' ');

  // No-agent-config hint shown in scrollable area (not as overlay)
  const agentConfigHintNode =
    hintType === 'no-agent-config' ? (
      <div {...stylex.props(styles.hint)}>
        <Settings {...stylex.props(styles.hintGlyph)} />
        <div {...stylex.props(styles.hintBody)}>
          <p {...stylex.props(styles.hintText)}>{hintNoAgentConfigMessage}</p>
          <button type="button" onClick={onGoToAgentSettings} className={hintButtonClassName}>
            <span>{hintGoToSettingsLabel}</span>
          </button>
        </div>
      </div>
    ) : null;

  // No-machine hint shown below composer (does not block input). Its copy and
  // primary action depend on where the app is running: web/mobile users need to
  // download the desktop client, while the Electron client already bundles the
  // daemon and just needs a moment for it to finish starting.
  const isDaemonStartingHint = noMachineVariant === 'daemon-starting';
  const noMachineHintNode =
    hintType === 'no-machine' ? (
      <NoMachineHint
        variant={noMachineVariant}
        title={isDaemonStartingHint ? hintDaemonStartingTitle : hintDownloadClientTitle}
        message={isDaemonStartingHint ? hintDaemonStartingMessage : hintDownloadClientMessage}
        downloadLabel={hintDownloadClientLabel}
        reportBugLabel={hintReportBugLabel}
        discordMessage={hintDiscordMessage}
        discordLabel={hintDiscordLabel}
        onDownloadClient={onDownloadClient}
        onReportBug={onReportBug}
      />
    ) : null;

  const primaryActionNode = (
    <ErrorBoundary name="ChatLandingPrimaryAction" variant="inline" resetKeys={resetKeys}>
      <Button
        type="button"
        variant="primary"
        size="medium"
        shape="pill"
        icon
        onClick={onSubmit}
        disabled={submitDisabled}
        aria-label={submissionPending ? submittingLabel : submitLabel}
      >
        {submissionPending ? (
          <Spinner className="h-4 w-4" />
        ) : (
          <ArrowUp {...stylex.props(styles.glyph16)} />
        )}
      </Button>
    </ErrorBoundary>
  );

  // The amber tone is a hard-coded pair, and its dark step needs the `.dark`
  // ancestor StyleX cannot select, so that one stays a Tailwind class.
  const composerStatusStyle =
    composerStatusTone === 'warning'
      ? stylex.props(styles.fallbackStatus)
      : stylex.props(
          styles.fallbackStatus,
          composerStatusTone === 'error' ? styles.fallbackStatusError : styles.fallbackStatusMuted
        );
  const composerStatusClassName =
    composerStatusTone === 'warning'
      ? ['text-amber-600 dark:text-amber-400', composerStatusStyle.className]
          .filter(Boolean)
          .join(' ')
      : composerStatusStyle.className;

  const fallbackRender = ({ resetErrorBoundary }: { resetErrorBoundary: () => void }) => (
    <div {...stylex.props(styles.fallback)}>
      <div {...stylex.props(styles.fallbackTitle)}>{somethingWentWrong}</div>
      <div {...stylex.props(styles.fallbackDetail)}>{composerCrashed}</div>
      <textarea
        id={isMobile ? 'chat-prompt-mobile' : 'chat-prompt'}
        ref={promptRef}
        value={submissionPending ? '' : promptValue}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={onPromptKeyDown}
        onPaste={handlePromptPasteWithSessionUrl}
        rows={isMobile ? 3 : 4}
        enterKeyHint={promptEnterKeyHint}
        placeholder={promptPlaceholder}
        disabled={submissionPending}
        // `input-scrollbar` is the global scrollbar class of the app.
        className={['input-scrollbar', stylex.props(styles.fallbackPrompt).className]
          .filter(Boolean)
          .join(' ')}
      />
      {composerStatusMessage ? (
        <div
          role={composerStatusTone === 'error' ? 'alert' : 'status'}
          aria-live={composerStatusTone === 'error' ? 'assertive' : 'polite'}
          className={composerStatusClassName}
          style={composerStatusStyle.style}
        >
          {composerStatusMessage}
        </div>
      ) : null}{' '}
      <div {...stylex.props(styles.fallbackActions)}>
        <div {...stylex.props(styles.fallbackSelectors)}>{selector ?? footerSelector}</div>
        <div {...stylex.props(styles.fallbackActionsEnd)}>
          {primaryActionNode}
          <button type="button" {...stylex.props(styles.retryButton)} onClick={resetErrorBoundary}>
            {tryAgain}
          </button>
        </div>
      </div>
    </div>
  );

  const composerNode = (
    <ErrorBoundary
      name="ChatLandingComposer"
      variant="section"
      resetKeys={resetKeys}
      fallbackRender={fallbackRender}
    >
      {composerNotice}
      <ChatComposer
        tone={tone}
        variant={isMobile ? 'landing' : 'session'}
        mentionSource={mentionSource}
        availableCommands={availableCommands}
        skillAgent={skillAgent}
        promptId={isMobile ? 'chat-prompt-mobile' : 'chat-prompt'}
        promptRef={promptRef}
        promptValue={submissionPending ? '' : promptValue}
        onPromptChange={onPromptChange}
        onPromptKeyDown={onPromptKeyDown}
        onPromptPaste={handlePromptPasteWithSessionUrl}
        onImageDrop={submissionPending ? undefined : onImageDrop}
        onDirectoryDrop={submissionPending ? undefined : handleDirectoryDrop}
        imageDropDisabled={submissionPending}
        promptPlaceholder={promptPlaceholder}
        compactPlaceholderName={compactPlaceholderName}
        promptDisabled={submissionPending}
        promptRows={2}
        promptEnterKeyHint={promptEnterKeyHint}
        pastedTextDrafts={submissionPending ? [] : pastedTextDrafts}
        onPastedTextDraftsChange={submissionPending ? undefined : onPastedTextDraftsChange}
        onMentionRangesChange={onMentionRangesChange}
        mentionActionsRef={mentionActionsRef}
        persistedMentions={persistedMentions}
        imageItems={submissionPending ? [] : imageItems}
        attachmentAddDisabled={submissionPending || attachmentAddDisabled}
        onAttachmentAddClick={onAttachmentAddClick}
        onImageRemove={submissionPending ? undefined : onImageRemove}
        onImageRetry={submissionPending ? undefined : onImageRetry}
        fileItems={submissionPending ? [] : fileItems}
        onFileRemove={submissionPending ? undefined : onFileRemove}
        onFileRetry={submissionPending ? undefined : onFileRetry}
        mcp={mcp}
        topSelector={topSelector}
        footerSelector={footerSelector ?? selector}
        bottomBar={bottomBar}
        statusMessage={composerStatusMessage}
        statusTone={composerStatusTone}
        primaryAction={primaryActionNode}
        autoResize
        maxRows={isMobile ? 10 : 11}
      />
    </ErrorBoundary>
  );

  if (isMobile) {
    return (
      <MobileChatLandingScreen
        title={title}
        contextSwitch={contextSwitch}
        composer={composerNode}
        noMachineHint={noMachineHintNode}
        agentConfigHint={agentConfigHintNode}
        onOpenMobileDrawer={onOpenMobileDrawer}
      />
    );
  }

  return (
    <WebChatLandingScreen
      title={title}
      dropActive={overlayActive}
      dropKind="session-mention"
      dropHandlers={dropZone.handlers}
      navRootRef={navRootRef}
      contextSwitch={contextSwitch}
      ambient={ambient}
      composer={composerNode}
      noMachineHint={noMachineHintNode}
      agentConfigHint={agentConfigHintNode}
      leftSidebarExpandSlot={leftSidebarExpandSlot}
    />
  );
}
