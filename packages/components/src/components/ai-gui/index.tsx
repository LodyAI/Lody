import { forwardRef, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  SessionFilePayload,
  SessionHistoryParsed,
  SessionId,
  SessionInputBlock,
  WorkspaceId,
} from '@lody/shared';
import { DEFAULT_CONVERSATION_FONT_SIZE, type ConversationFontSize } from '@/atoms/settings';
import { getSavedAnchorTurnId } from '@/lib/conversation-scroll/saved-state';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { AgentActivityTone } from './view';
import {
  MessageRowView,
  SessionChatStreamView,
  type AssistantMessageAction,
  type CapacityRetryControl,
  type MessageFileDiffEntriesByTurn,
  type SessionChatStreamHandle,
  type UserMessageEditMentionContext,
  type UserMessageEditSubmission,
} from './view';
import { reanchorMessageTextSpansForTrim } from '@lody/shared';
import { useMentionPromptExpansion } from '@/components/mentions/mention-expansion';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { useMcpAppHost } from '@/hooks/use-mcp-app-host';
import { isElectronRenderer } from '@/lib/electron';
import { createMcpAppHost, McpAppHostContext } from './mcp-app/mcp-app-host';
import { useConversationStreamItems } from '@/hooks/use-conversation-stream-items';
import { useConversationVersion } from '@/hooks/use-conversation-view';
import { findLastIndex, type ConversationView } from '@/lib/conversation-view';
import { useCloudQuery } from '@lody/platform/react';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import type {
  SessionForkDestination,
  SessionForkWorktreeAvailability,
} from '@/components/sessions/session-fork-destination-menu';

export type {
  AssistantMessageAction,
  CapacityRetryControl,
  ChatStreamItem,
  EmptySessionItem,
  GoalCommand,
  MessageFileDiffEntriesByTurn,
  PlaceholderSessionItem,
  SessionChatStreamHandle,
  SessionChatStreamViewProps,
  SessionChatUser,
  SessionMessageItem,
  UserMessageEditMentionContext,
  UserMessageEditSubmission,
  VisibleTurnRange,
} from './view';

export { MessageRowView, SessionChatStreamView } from './view';
export { MarkdownRenderer, type MarkdownRendererSize } from './markdown-renderer';

export interface SessionChatStreamProps {
  sessionId: SessionId;
  workspaceId?: WorkspaceId | null;
  /** Shows sender names and desktop profile cards in multi-member workspaces. */
  showSenderIdentity?: boolean;
  view: ConversationView | null;
  /** The stream is on screen; false for a mounted surface under `display: none`. */
  isVisible?: boolean;
  sessionCreatedAt?: string;
  dividerLabel?: string;
  className?: string;
  /** Scrolls as the first conversation row (for example, Session provenance). */
  leadingContent?: ReactNode;
  /** Scrolls after history as a local, not-yet-committed user message. */
  trailingContent?: ReactNode;
  emptyState?: ReactNode;
  onAtBottomChange?: (atBottom: boolean) => void;
  showScrollToLatest?: boolean;
  agentActivityLabel?: string | null;
  agentActivityTone?: AgentActivityTone;
  /** The status is live work (not waiting on the user): shimmer it. */
  agentActivityShimmer?: boolean;
  onFileDiffClick?: (turnId: string, filePath: string) => void;
  onFilePathClick?: (filePath: string) => void;
  /** Routes HTML attachment clicks to a live file or Browser surface. */
  onOpenHtmlFile?: (file: SessionFilePayload) => boolean;
  messageFileDiffEntriesByTurn?: MessageFileDiffEntriesByTurn;
  assistantActions?: AssistantMessageAction[];
  assistantActionsMessageId?: string | null;
  onCopyContext?: (messageId: string) => void;
  onForkLastAssistant?: (turnId: string, destination?: SessionForkDestination) => void;
  forkWorktreeAvailability?: SessionForkWorktreeAvailability;
  onForkWorktreeMenuOpen?: () => void;
  onEditLastUser?: (
    message: SessionHistoryParsed,
    edit: UserMessageEditSubmission
  ) => Promise<boolean>;
  /** Composer-equivalent mention wiring for the edit-and-resend editor; leave
   *  unset on surfaces without a mention source (the editor degrades to plain
   *  text, and mentions hydrate off the visible tokens only when it is set). */
  editMentionContext?: UserMessageEditMentionContext;
  /** Resends an undelivered (missing-history-acked) user turn's content as a
   * NEW message; the row's "Not delivered" label opens the confirmation dialog. */
  onResendUndelivered?: (userTurnId: string, inputBlocks: SessionInputBlock[]) => Promise<boolean>;
  /** Bounded continuation control for the latest provider-capacity failure. */
  capacityRetry?: CapacityRetryControl;
  forkingAssistantMessageId?: string | null;
  /** Opens another session from an in-conversation link (e.g. a fork's origin). */
  onNavigateSession?: (target: SessionNavigationTarget) => void;
  onLastCompletedAssistantMessageIdChange?: (messageId: string | null) => void;
  conversationFontSize?: ConversationFontSize;
  /** Full-page overlay that keeps the conversation outline independent of composer height. */
  outlineOverlayRoot?: HTMLElement | null;
  suppressStickyAutoScrollRef?: React.RefObject<boolean>;
}

const MessageRowConnected = memo(function MessageRowConnected({
  message,
  sessionId,
  workspaceId,
  showSenderIdentity,
  onNavigateSession,
  onEditLastUser,
  onResendUndelivered,
  capacityRetry,
  conversationFontSize,
  editMentionContext,
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
  workspaceId?: WorkspaceId | null;
  showSenderIdentity: boolean;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
  onEditLastUser?: (
    message: SessionHistoryParsed,
    edit: UserMessageEditSubmission
  ) => Promise<boolean>;
  /** Resends an undelivered (missing-history-acked) user turn's content as a
   * NEW message; the row's "Not delivered" label opens the confirmation dialog. */
  onResendUndelivered?: (userTurnId: string, inputBlocks: SessionInputBlock[]) => Promise<boolean>;
  capacityRetry?: CapacityRetryControl;
  conversationFontSize: ConversationFontSize;
  editMentionContext?: UserMessageEditMentionContext;
}) {
  const userInfo = useCloudQuery(
    cloudOperations.auth.getUserById,
    message.userId && workspaceId ? { userId: message.userId, workspaceId } : 'skip'
  );

  return (
    <MessageRowView
      message={message}
      sessionId={sessionId}
      user={userInfo}
      showSenderIdentity={showSenderIdentity}
      onNavigateSession={onNavigateSession}
      onEdit={onEditLastUser}
      onResendUndelivered={onResendUndelivered}
      capacityRetry={capacityRetry}
      conversationFontSize={conversationFontSize}
      editMentionContext={editMentionContext}
    />
  );
});

const SessionChatStreamImpl = forwardRef<SessionChatStreamHandle, SessionChatStreamProps>(
  (
    {
      sessionId,
      workspaceId,
      showSenderIdentity = false,
      view,
      sessionCreatedAt: _sessionCreatedAt,
      dividerLabel: _dividerLabel,
      className,
      leadingContent,
      trailingContent,
      emptyState,
      onAtBottomChange,
      showScrollToLatest = true,
      agentActivityLabel = null,
      agentActivityTone = 'primary',
      agentActivityShimmer,
      onFileDiffClick,
      onFilePathClick,
      onOpenHtmlFile,
      messageFileDiffEntriesByTurn,
      assistantActions,
      assistantActionsMessageId,
      onForkLastAssistant,
      onCopyContext,
      forkWorktreeAvailability,
      onForkWorktreeMenuOpen,
      forkingAssistantMessageId,
      onNavigateSession,
      onEditLastUser,
      onResendUndelivered,
      capacityRetry,
      onLastCompletedAssistantMessageIdChange,
      conversationFontSize = DEFAULT_CONVERSATION_FONT_SIZE,
      suppressStickyAutoScrollRef,
      outlineOverlayRoot,
      editMentionContext,
      isVisible = true,
    },
    ref
  ) => {
    const version = useConversationVersion(view);
    const mcpAppActions = useMcpAppHost();
    // Only the Electron main process serves the MCP App sandbox origin.
    const mcpAppHost = useMemo(
      () => (isElectronRenderer() ? createMcpAppHost(sessionId, mcpAppActions) : null),
      [mcpAppActions, sessionId]
    );
    // Read once per mount: the scroll engine restores this session's reading
    // position into this turn, so load it before the first viewport report.
    const [initialFocusTurnId] = useState(() => getSavedAnchorTurnId(sessionId));
    const {
      initialWindowReady,
      items,
      lastAssistantMessageId,
      lastCompletedAssistantMessageId,
      onVisibleTurnRangeChange: handleVisibleTurnRangeChange,
      onOutlinePreviewRound: handleOutlinePreviewRound,
      onRetainedTurnIdsChange,
    } = useConversationStreamItems(view, sessionId, { initialFocusTurnId });
    useEffect(() => {
      onLastCompletedAssistantMessageIdChange?.(lastCompletedAssistantMessageId);
    }, [lastCompletedAssistantMessageId, onLastCompletedAssistantMessageIdChange]);

    /* The edit-and-resend save path needs the same before-send expansion the
       composer's send runs; mounting it here (rather than inside each row)
       keeps the skill/session catalogs single per stream and lets the row's
       `onEdit` receive already-expanded text. */
    const { expand: expandEditMentions } = useMentionPromptExpansion({
      source: editMentionContext?.mentionSource,
      skillAgent: editMentionContext?.skillAgent,
      promptValue: '',
      currentSessionId: sessionId,
    });
    const stableExpandEditMentions = useStableCallback(expandEditMentions);
    const handleEditLastUser = useCallback(
      async (message: SessionHistoryParsed, submission: UserMessageEditSubmission) => {
        if (!onEditLastUser) return false;
        const expanded = stableExpandEditMentions({
          text: submission.text,
          mentions: submission.mentions,
        });
        const trimmedText = expanded.text.trim();
        const trimmedSpans = reanchorMessageTextSpansForTrim(
          expanded.text,
          trimmedText,
          expanded.spans
        );
        return await onEditLastUser(message, {
          text: trimmedText,
          mentions: submission.mentions,
          spans: trimmedSpans,
        });
      },
      [onEditLastUser, stableExpandEditMentions]
    );

    const stableOnFileDiffClick = useStableCallback((turnId: string, filePath: string) => {
      onFileDiffClick?.(turnId, filePath);
    });
    const stableOnFilePathClick = useStableCallback((filePath: string) => {
      onFilePathClick?.(filePath);
    });
    const stableOnNavigateSession = useStableCallback((target: SessionNavigationTarget) => {
      onNavigateSession?.(target);
    });
    const stableOnCopyContext = useStableCallback((messageId: string) =>
      onCopyContext?.(messageId)
    );
    const stableOnForkLastAssistant = useStableCallback(
      (turnId: string, destination?: SessionForkDestination) => {
        onForkLastAssistant?.(turnId, destination);
      }
    );
    const hasFileDiffClick = onFileDiffClick !== undefined;
    const hasFilePathClick = onFilePathClick !== undefined;
    const hasNavigateSession = onNavigateSession !== undefined;
    const hasForkLastAssistant = onForkLastAssistant !== undefined;
    const lastUserMessageId = useMemo(() => {
      if (!view) return null;
      const index = findLastIndex(view, (row) => row.role === 'user');
      return index >= 0 ? (view.index(index)?.id ?? null) : null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, version]);

    const renderMessageRow = useCallback(
      ({
        message,
        sessionId: messageSessionId,
      }: {
        message: SessionHistoryParsed;
        sessionId: SessionId;
      }) => {
        return (
          <MessageRowConnected
            message={message}
            sessionId={messageSessionId}
            workspaceId={workspaceId}
            showSenderIdentity={showSenderIdentity}
            onNavigateSession={hasNavigateSession ? stableOnNavigateSession : undefined}
            onEditLastUser={message.id === lastUserMessageId ? handleEditLastUser : undefined}
            editMentionContext={editMentionContext}
            onResendUndelivered={onResendUndelivered}
            capacityRetry={message.id === capacityRetry?.noticeId ? capacityRetry : undefined}
            conversationFontSize={conversationFontSize}
          />
        );
      },
      [
        conversationFontSize,
        editMentionContext,
        handleEditLastUser,
        hasNavigateSession,
        lastUserMessageId,
        onResendUndelivered,
        capacityRetry,
        stableOnNavigateSession,
        showSenderIdentity,
        workspaceId,
      ]
    );

    const stream = (
      <SessionChatStreamView
        initialWindowReady={initialWindowReady}
        isVisible={isVisible}
        ref={ref}
        items={items}
        sessionId={sessionId}
        className={className}
        leadingContent={leadingContent}
        trailingContent={trailingContent}
        emptyState={emptyState}
        onAtBottomChange={onAtBottomChange}
        showScrollToLatest={showScrollToLatest}
        renderMessageRow={renderMessageRow}
        onFileDiffClick={hasFileDiffClick ? stableOnFileDiffClick : undefined}
        onFilePathClick={hasFilePathClick ? stableOnFilePathClick : undefined}
        onOpenHtmlFile={onOpenHtmlFile}
        lastAssistantMessageId={lastAssistantMessageId}
        lastCompletedAssistantMessageId={lastCompletedAssistantMessageId}
        messageFileDiffEntriesByTurn={messageFileDiffEntriesByTurn}
        assistantActions={assistantActions}
        assistantActionsMessageId={assistantActionsMessageId}
        onCopyContext={onCopyContext ? stableOnCopyContext : undefined}
        onForkLastAssistant={hasForkLastAssistant ? stableOnForkLastAssistant : undefined}
        forkWorktreeAvailability={forkWorktreeAvailability}
        onForkWorktreeMenuOpen={onForkWorktreeMenuOpen}
        forkingAssistantMessageId={forkingAssistantMessageId}
        agentActivityLabel={agentActivityLabel}
        agentActivityTone={agentActivityTone}
        agentActivityShimmer={agentActivityShimmer}
        conversationFontSize={conversationFontSize}
        suppressStickyAutoScrollRef={suppressStickyAutoScrollRef}
        outlineOverlayRoot={outlineOverlayRoot}
        conversationView={view}
        onRetainedTurnIdsChange={onRetainedTurnIdsChange}
        onVisibleTurnRangeChange={handleVisibleTurnRangeChange}
        onOutlinePreviewRound={handleOutlinePreviewRound}
      />
    );
    return <McpAppHostContext.Provider value={mcpAppHost}>{stream}</McpAppHostContext.Provider>;
  }
);

export const SessionChatStream = memo(SessionChatStreamImpl);
SessionChatStream.displayName = 'SessionChatStream';

export default SessionChatStream;
