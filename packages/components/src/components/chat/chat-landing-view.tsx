import { useCallback, useRef } from 'react';
import type { ClipboardEvent, KeyboardEvent, ReactNode, Ref } from 'react';
import type { Mention as MentionRange } from '@/ui/mention/index';
import type { CombinedMentionTextareaHandle } from '@/components/mentions/combined-mention-textarea';
import type { PersistedMentionRange } from '@/components/mentions/mention-persistence';

import type { AcpCommandSummary, AgentConfigCliType } from '@lody/shared';
import { cn } from '@/lib/utils';
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
import { ArrowUp, Bug, Download, ExternalLink, Loader2, Settings } from 'lucide-react';
import type { PastedTextDraft } from '@/lib/pasted-text-draft';
import { MobileChatLandingScreen } from '@/components/mobile/mobile-chat-landing-screen';
import { WebChatLandingScreen } from './web-chat-landing-screen';

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
  noMachineVariant?: 'download-client' | 'daemon-starting';
  /** No-machine hint message shown to web/mobile users without a client. */
  hintDownloadClientMessage?: string;
  /** Label for the download-client button. */
  hintDownloadClientLabel?: string;
  /** No-machine hint message shown in the Electron client while the daemon boots. */
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
  submitDisabled = false,
  submissionPending = false,
  onSubmit,
  submitLabel = 'Send',
  submittingLabel = 'Sending...',
  hintType = null,
  noMachineVariant = 'download-client',
  hintDownloadClientMessage = "It looks like the desktop client isn't running yet. Download it to get started:",
  hintDownloadClientLabel = 'Download the client',
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
  const isDark = tone === 'dark';
  const { mentionActionsRef, dropZone, overlayActive } = useSessionMentionDrop(
    !isMobile && !submissionPending
  );

  const {
    somethingWentWrong = 'Something went wrong',
    composerCrashed = 'The chat composer failed to render. Your draft is preserved below.',
    tryAgain = 'Try again',
  } = errorLabels;

  const hintButtonClassName = cn(
    'group flex w-fit items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors',
    'border-border bg-background/70 text-foreground hover:bg-muted/60'
  );

  const primaryActionButtonClassName = cn(
    'h-8 w-8 rounded-full shadow-xs transition-all',
    'bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px] focus-visible:ring-ring focus-visible:ring-offset-background'
  );

  // No-agent-config hint shown in scrollable area (not as overlay)
  const agentConfigHintNode =
    hintType === 'no-agent-config' ? (
      <div
        className={cn(
          'mt-4 flex items-start gap-3 rounded-lg border px-4 py-3',
          'border-border/60 bg-background/60 text-muted-foreground'
        )}
      >
        <Settings className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />
        <div className="flex flex-1 flex-col gap-2">
          <p className="text-sm">{hintNoAgentConfigMessage}</p>
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
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border px-4 py-3',
          'border-border/60 bg-background/60 text-muted-foreground'
        )}
      >
        {isDaemonStartingHint ? (
          <Loader2
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 animate-spin opacity-70',
              'text-muted-foreground'
            )}
          />
        ) : (
          <Download className={cn('mt-0.5 h-4 w-4 shrink-0 opacity-70', 'text-muted-foreground')} />
        )}
        <div className="flex flex-1 flex-col gap-2">
          <p className="text-sm">
            {isDaemonStartingHint ? hintDaemonStartingMessage : hintDownloadClientMessage}
          </p>
          {isDaemonStartingHint ? (
            <button type="button" onClick={onReportBug} className={hintButtonClassName}>
              <Bug className="h-3.5 w-3.5 opacity-70" />
              <span>{hintReportBugLabel}</span>
            </button>
          ) : (
            <button type="button" onClick={onDownloadClient} className={hintButtonClassName}>
              <span>{hintDownloadClientLabel}</span>
              <ExternalLink className="h-3.5 w-3.5 opacity-50 transition-opacity group-hover:opacity-100" />
            </button>
          )}
          <p
            className={cn(
              'text-xs',
              isDark ? 'text-muted-foreground/80' : 'text-muted-foreground/90'
            )}
          >
            {hintDiscordMessage}{' '}
            <a
              href="https://discord.gg/E8mZtMu38s"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground/70 underline transition-colors hover:text-foreground/90"
            >
              {hintDiscordLabel}
            </a>
          </p>
        </div>
      </div>
    ) : null;

  const primaryActionNode = (
    <ErrorBoundary name="ChatLandingPrimaryAction" variant="inline" resetKeys={resetKeys}>
      <Button
        type="button"
        variant="ghost"
        size="mini"
        icon
        onClick={onSubmit}
        disabled={submitDisabled}
        aria-label={submissionPending ? submittingLabel : submitLabel}
        className={cn(primaryActionButtonClassName, isMobile ? '' : '')}
      >
        {submissionPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ArrowUp className="h-4 w-4" />
        )}
      </Button>
    </ErrorBoundary>
  );

  const fallbackRender = ({ resetErrorBoundary }: { resetErrorBoundary: () => void }) => (
    <div className="w-full rounded-xl border border-border/60 bg-background/80 p-4">
      <div className="text-sm font-semibold text-foreground">{somethingWentWrong}</div>
      <div className="mt-1 text-xs text-muted-foreground">{composerCrashed}</div>
      <textarea
        id={isMobile ? 'chat-prompt-mobile' : 'chat-prompt'}
        ref={promptRef}
        value={submissionPending ? '' : promptValue}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={onPromptKeyDown}
        onPaste={onPromptPaste}
        rows={isMobile ? 3 : 4}
        enterKeyHint={promptEnterKeyHint}
        placeholder={promptPlaceholder}
        disabled={submissionPending}
        className={cn(
          'input-scrollbar mt-3 w-full resize-none rounded-lg border border-input-border/70 bg-input-field px-3 py-2 text-sm text-input-foreground placeholder:text-input-placeholder focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring'
        )}
      />
      {composerStatusMessage ? (
        <div
          role={composerStatusTone === 'error' ? 'alert' : 'status'}
          aria-live={composerStatusTone === 'error' ? 'assertive' : 'polite'}
          className={cn(
            'mt-2 px-1 text-xs leading-snug',
            composerStatusTone === 'error'
              ? 'text-destructive'
              : composerStatusTone === 'warning'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground'
          )}
        >
          {composerStatusMessage}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1">{selector ?? footerSelector}</div>
        <div className="ml-auto flex items-center gap-2">
          {primaryActionNode}
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md border border-input-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-hover hover:text-hover-foreground"
            onClick={resetErrorBoundary}
          >
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
        onPromptPaste={onPromptPaste}
        onImageDrop={submissionPending ? undefined : onImageDrop}
        imageDropDisabled={submissionPending}
        promptPlaceholder={promptPlaceholder}
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
      composer={composerNode}
      noMachineHint={noMachineHintNode}
      agentConfigHint={agentConfigHintNode}
      leftSidebarExpandSlot={leftSidebarExpandSlot}
    />
  );
}
