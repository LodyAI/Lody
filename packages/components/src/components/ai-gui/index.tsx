import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type {
  SessionDoc,
  SessionHistory,
  SessionHistoryParsed,
  SessionId,
  WorkspaceId,
} from '@lody/shared';
import type { ConversationFontSize } from '@/atoms/settings';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { AgentActivityTone } from '@/components/shared';
import {
  MessageRowView,
  SessionChatStreamView,
  type AssistantMessageAction,
  type MessageFileDiffEntriesByTurn,
  type SessionChatStreamHandle,
} from './view';
import { buildChatStreamItems, type BuildChatStreamItemsCache } from './build-chat-stream-items';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { useCloudQuery } from '@lody/platform/react';

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
  emptyState?: ReactNode;
  onAtBottomChange?: (atBottom: boolean) => void;
  showScrollToLatest?: boolean;
  agentActivityLabel?: string | null;
  agentActivityTone?: AgentActivityTone;
  onFileDiffClick?: (turnId: string, filePath: string) => void;
  onFilePathClick?: (filePath: string) => void;
  messageFileDiffEntriesByTurn?: MessageFileDiffEntriesByTurn;
  assistantActions?: AssistantMessageAction[];
  assistantActionsMessageId?: string | null;
  onForkLastAssistant?: (turnId: string) => void;
  onEditLastUser?: (message: SessionHistoryParsed, text: string) => Promise<boolean>;
  forkingAssistantMessageId?: string | null;
  /** Opens another session from an in-conversation link (e.g. a fork's origin). */
  onNavigateSession?: (sessionId: SessionId) => void;
  onLastCompletedAssistantMessageIdChange?: (messageId: string | null) => void;
  conversationFontSize?: ConversationFontSize;
  suppressStickyAutoScrollRef?: React.RefObject<boolean>;
}

const MessageRowConnected = memo(function MessageRowConnected({
  message,
  sessionId,
  workspaceId,
  onNavigateSession,
  onEditLastUser,
  conversationFontSize,
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
  workspaceId?: WorkspaceId | null;
  onNavigateSession?: (sessionId: SessionId) => void;
  onEditLastUser?: (message: SessionHistoryParsed, text: string) => Promise<boolean>;
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
      emptyState,
      onAtBottomChange,
      showScrollToLatest = true,
      agentActivityLabel = null,
      agentActivityTone = 'primary',
      onFileDiffClick,
      onFilePathClick,
      messageFileDiffEntriesByTurn,
      assistantActions,
      assistantActionsMessageId,
      onForkLastAssistant,
      forkingAssistantMessageId,
      onNavigateSession,
      onEditLastUser,
      onLastCompletedAssistantMessageIdChange,
      conversationFontSize = 'default',
      suppressStickyAutoScrollRef,
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
    const stableOnNavigateSession = useStableCallback((targetSessionId: SessionId) => {
      onNavigateSession?.(targetSessionId);
    });
    const stableOnForkLastAssistant = useStableCallback((turnId: string) => {
      onForkLastAssistant?.(turnId);
    });
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
            conversationFontSize={conversationFontSize}
          />
        );
      },
      [
        conversationFontSize,
        hasNavigateSession,
        lastUserMessageId,
        onEditLastUser,
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
        emptyState={emptyState}
        onAtBottomChange={onAtBottomChange}
        showScrollToLatest={showScrollToLatest}
        renderMessageRow={renderMessageRow}
        onFileDiffClick={hasFileDiffClick ? stableOnFileDiffClick : undefined}
        onFilePathClick={hasFilePathClick ? stableOnFilePathClick : undefined}
        lastAssistantMessageId={lastAssistantMessageId}
        lastCompletedAssistantMessageId={lastCompletedAssistantMessageId}
        messageFileDiffEntriesByTurn={messageFileDiffEntriesByTurn}
        assistantActions={assistantActions}
        assistantActionsMessageId={assistantActionsMessageId}
        onForkLastAssistant={hasForkLastAssistant ? stableOnForkLastAssistant : undefined}
        forkingAssistantMessageId={forkingAssistantMessageId}
        agentActivityLabel={agentActivityLabel}
        agentActivityTone={agentActivityTone}
        conversationFontSize={conversationFontSize}
        suppressStickyAutoScrollRef={suppressStickyAutoScrollRef}
      />
    );
  }
);

export const SessionChatStream = memo(SessionChatStreamImpl);
SessionChatStream.displayName = 'SessionChatStream';

export default SessionChatStream;
