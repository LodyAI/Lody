import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type {
  SessionDoc,
  SessionFilePayload,
  SessionHistory,
  SessionHistoryParsed,
  SessionId,
  SessionInputBlock,
  WorkspaceId,
} from '@lody/shared';
import { DEFAULT_CONVERSATION_FONT_SIZE, type ConversationFontSize } from '@/atoms/settings';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { AgentActivityTone } from '@/components/shared';
import {
  MessageRowView,
  SessionChatStreamView,
  type AssistantMessageAction,
  type CapacityRetryControl,
  type MessageFileDiffEntriesByTurn,
  type SessionChatStreamHandle,
} from './view';
import { buildChatStreamItems, type BuildChatStreamItemsCache } from './build-chat-stream-items';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { useCloudQuery } from '@lody/platform/react';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import type {
  SessionForkDestination,
  SessionForkWorktreeAvailability,
} from '@/components/sessions/session-fork-destination-menu';

const emptyHistory = [] as SessionDoc['history'];
const CHAT_STREAM_ITEMS_CACHE_LIMIT = 20;
const chatStreamItemsCacheBySessionId = new Map<SessionId, BuildChatStreamItemsCache>();

function getChatStreamItemsCache(sessionId: SessionId): BuildChatStreamItemsCache | undefined {
  return chatStreamItemsCacheBySessionId.get(sessionId);
}

function setChatStreamItemsCache(sessionId: SessionId, cache: BuildChatStreamItemsCache): void {
  chatStreamItemsCacheBySessionId.delete(sessionId);
  chatStreamItemsCacheBySessionId.set(sessionId, cache);
  while (chatStreamItemsCacheBySessionId.size > CHAT_STREAM_ITEMS_CACHE_LIMIT) {
    const oldestSessionId = chatStreamItemsCacheBySessionId.keys().next().value;
    if (oldestSessionId === undefined) break;
    chatStreamItemsCacheBySessionId.delete(oldestSessionId);
  }
}

export type {
  AssistantMessageAction,
  CapacityRetryControl,
  ChatStreamItem,
  EmptySessionItem,
  GoalCommand,
  MessageFileDiffEntriesByTurn,
  SessionChatStreamHandle,
  SessionChatStreamViewProps,
  SessionChatUser,
  SessionMessageItem,
} from './view';

export { MessageRowView, SessionChatStreamView } from './view';
export { MarkdownRenderer, type MarkdownRendererSize } from './markdown-renderer';

export interface SessionChatStreamProps {
  sessionId: SessionId;
  workspaceId?: WorkspaceId | null;
  sessionDoc: SessionDoc;
  sessionCreatedAt?: string;
  dividerLabel?: string;
  className?: string;
  /** Scrolls as the first conversation row (for example, Session provenance). */
  leadingContent?: ReactNode;
  emptyState?: ReactNode;
  onAtBottomChange?: (atBottom: boolean) => void;
  showScrollToLatest?: boolean;
  agentActivityLabel?: string | null;
  agentActivityTone?: AgentActivityTone;
  onFileDiffClick?: (turnId: string, filePath: string) => void;
  onFilePathClick?: (filePath: string) => void;
  /** Routes HTML attachment clicks to a live file or Browser surface. */
  onOpenHtmlFile?: (file: SessionFilePayload) => boolean;
  /** Whether an HTML attachment can be routed to a live file or Browser surface. */
  canOpenHtmlFile?: (file: SessionFilePayload) => boolean;
  messageFileDiffEntriesByTurn?: MessageFileDiffEntriesByTurn;
  assistantActions?: AssistantMessageAction[];
  assistantActionsMessageId?: string | null;
  onForkLastAssistant?: (turnId: string, destination?: SessionForkDestination) => void;
  forkWorktreeAvailability?: SessionForkWorktreeAvailability;
  onForkWorktreeMenuOpen?: () => void;
  onEditLastUser?: (message: SessionHistoryParsed, text: string) => Promise<boolean>;
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
  /** Skips one auto-follow caused by the session composer changing height. */
  skipNextViewportResizeAutoScrollRef?: MutableRefObject<boolean>;
  /** Full-page overlay that keeps the conversation outline independent of composer height. */
  outlineOverlayRoot?: HTMLElement | null;
  suppressStickyAutoScrollRef?: React.RefObject<boolean>;
}

const MessageRowConnected = memo(function MessageRowConnected({
  message,
  sessionId,
  workspaceId,
  onNavigateSession,
  onEditLastUser,
  onResendUndelivered,
  capacityRetry,
  conversationFontSize,
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
  workspaceId?: WorkspaceId | null;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
  onEditLastUser?: (message: SessionHistoryParsed, text: string) => Promise<boolean>;
  /** Resends an undelivered (missing-history-acked) user turn's content as a
   * NEW message; the row's "Not delivered" label opens the confirmation dialog. */
  onResendUndelivered?: (userTurnId: string, inputBlocks: SessionInputBlock[]) => Promise<boolean>;
  capacityRetry?: CapacityRetryControl;
  conversationFontSize: ConversationFontSize;
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
      onNavigateSession={onNavigateSession}
      onEdit={onEditLastUser}
      onResendUndelivered={onResendUndelivered}
      capacityRetry={capacityRetry}
      conversationFontSize={conversationFontSize}
    />
  );
});

const SessionChatStreamImpl = forwardRef<SessionChatStreamHandle, SessionChatStreamProps>(
  (
    {
      sessionId,
      workspaceId,
      sessionDoc,
      sessionCreatedAt: _sessionCreatedAt,
      dividerLabel: _dividerLabel,
      className,
      leadingContent,
      emptyState,
      onAtBottomChange,
      showScrollToLatest = true,
      agentActivityLabel = null,
      agentActivityTone = 'primary',
      onFileDiffClick,
      onFilePathClick,
      onOpenHtmlFile,
      canOpenHtmlFile,
      messageFileDiffEntriesByTurn,
      assistantActions,
      assistantActionsMessageId,
      onForkLastAssistant,
      forkWorktreeAvailability,
      onForkWorktreeMenuOpen,
      forkingAssistantMessageId,
      onNavigateSession,
      onEditLastUser,
      onResendUndelivered,
      capacityRetry,
      onLastCompletedAssistantMessageIdChange,
      conversationFontSize = DEFAULT_CONVERSATION_FONT_SIZE,
      skipNextViewportResizeAutoScrollRef,
      suppressStickyAutoScrollRef,
      outlineOverlayRoot,
    },
    ref
  ) => {
    const sessionHistory = (sessionDoc.history as SessionHistory[]) ?? emptyHistory;
    const chatStreamItemsCacheRef = useRef<BuildChatStreamItemsCache | undefined>(undefined);
    if (chatStreamItemsCacheRef.current === undefined) {
      chatStreamItemsCacheRef.current = getChatStreamItemsCache(sessionId);
    }
    const { items, lastAssistantMessageId, lastCompletedAssistantMessageId, cache } = useMemo(
      () => buildChatStreamItems(sessionHistory, sessionId, chatStreamItemsCacheRef.current),
      [sessionHistory, sessionId]
    );
    chatStreamItemsCacheRef.current = cache;
    useEffect(() => {
      setChatStreamItemsCache(sessionId, cache);
    }, [cache, sessionId]);
    useEffect(() => {
      onLastCompletedAssistantMessageIdChange?.(lastCompletedAssistantMessageId);
    }, [lastCompletedAssistantMessageId, onLastCompletedAssistantMessageIdChange]);

    const stableOnFileDiffClick = useStableCallback((turnId: string, filePath: string) => {
      onFileDiffClick?.(turnId, filePath);
    });
    const stableOnFilePathClick = useStableCallback((filePath: string) => {
      onFilePathClick?.(filePath);
    });
    const stableOnNavigateSession = useStableCallback((target: SessionNavigationTarget) => {
      onNavigateSession?.(target);
    });
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
      for (let index = sessionHistory.length - 1; index >= 0; index -= 1) {
        if (sessionHistory[index]?.role === 'user') return sessionHistory[index]?.id ?? null;
      }
      return null;
    }, [sessionHistory]);

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
            onNavigateSession={hasNavigateSession ? stableOnNavigateSession : undefined}
            onEditLastUser={message.id === lastUserMessageId ? onEditLastUser : undefined}
            onResendUndelivered={onResendUndelivered}
            capacityRetry={message.id === capacityRetry?.noticeId ? capacityRetry : undefined}
            conversationFontSize={conversationFontSize}
          />
        );
      },
      [
        conversationFontSize,
        hasNavigateSession,
        lastUserMessageId,
        onEditLastUser,
        onResendUndelivered,
        capacityRetry,
        stableOnNavigateSession,
        workspaceId,
      ]
    );

    return (
      <SessionChatStreamView
        ref={ref}
        items={items}
        sessionId={sessionId}
        className={className}
        leadingContent={leadingContent}
        emptyState={emptyState}
        onAtBottomChange={onAtBottomChange}
        showScrollToLatest={showScrollToLatest}
        renderMessageRow={renderMessageRow}
        onFileDiffClick={hasFileDiffClick ? stableOnFileDiffClick : undefined}
        onFilePathClick={hasFilePathClick ? stableOnFilePathClick : undefined}
        onOpenHtmlFile={onOpenHtmlFile}
        canOpenHtmlFile={canOpenHtmlFile}
        lastAssistantMessageId={lastAssistantMessageId}
        lastCompletedAssistantMessageId={lastCompletedAssistantMessageId}
        messageFileDiffEntriesByTurn={messageFileDiffEntriesByTurn}
        assistantActions={assistantActions}
        assistantActionsMessageId={assistantActionsMessageId}
        onForkLastAssistant={hasForkLastAssistant ? stableOnForkLastAssistant : undefined}
        forkWorktreeAvailability={forkWorktreeAvailability}
        onForkWorktreeMenuOpen={onForkWorktreeMenuOpen}
        forkingAssistantMessageId={forkingAssistantMessageId}
        agentActivityLabel={agentActivityLabel}
        agentActivityTone={agentActivityTone}
        conversationFontSize={conversationFontSize}
        skipNextViewportResizeAutoScrollRef={skipNextViewportResizeAutoScrollRef}
        suppressStickyAutoScrollRef={suppressStickyAutoScrollRef}
        outlineOverlayRoot={outlineOverlayRoot}
      />
    );
  }
);

export const SessionChatStream = memo(SessionChatStreamImpl);
SessionChatStream.displayName = 'SessionChatStream';

export default SessionChatStream;
