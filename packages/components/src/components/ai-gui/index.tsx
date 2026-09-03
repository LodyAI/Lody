import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type {
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
import {
  buildChatStreamItems,
  buildChatStreamItemsFromView,
  type BuildChatStreamItemsCache,
} from './build-chat-stream-items';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { useConversationViewSelector } from '@/hooks/use-conversation-view-selector';
import { useTurnRange } from '@/hooks/use-turn-range';
import type { ConversationView } from '@/lib/conversation-view';
import {
  computeHydrationRange,
  isSameTurnRange,
  type TurnRange,
} from '@/lib/conversation-view/hydration-range';
import { useSessionSearch } from '@/components/sessions/session-search-context';
import { useCloudQuery } from '@lody/platform/react';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import type {
  SessionForkDestination,
  SessionForkWorktreeAvailability,
} from '@/components/sessions/session-fork-destination-menu';

const emptyHistory: readonly SessionHistory[] = [];
const EMPTY_TURN_RANGE: TurnRange = { from: 0, to: 0 };

const readTurnCount = (view: ConversationView): number => view.turnCount;

const findLastUserTurnId = (view: ConversationView): string | null => {
  for (let index = view.turnCount - 1; index >= 0; index -= 1) {
    const row = view.index(index);
    if (row?.role === 'user') return row.id ?? null;
  }
  return null;
};
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
  /**
   * Windowed history reader for the session. The stream renders through it:
   * placeholders from index rows, message rows for the hydrated window
   * around the viewport. `null` is the full-Mirror rollback path, which
   * renders `fallbackHistory` instead.
   */
  conversationView: ConversationView | null;
  /** The full history array for the rollback path. Not read while a view is present. */
  fallbackHistory?: readonly SessionHistory[];
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
      conversationView,
      fallbackHistory,
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
    // The rollback array is only consulted without a view, so the bridge's
    // lazy `history` getter is never touched on the view path.
    const sessionHistory = conversationView ? emptyHistory : (fallbackHistory ?? emptyHistory);
    const chatStreamItemsCacheRef = useRef<BuildChatStreamItemsCache | undefined>(undefined);
    if (chatStreamItemsCacheRef.current === undefined) {
      chatStreamItemsCacheRef.current = getChatStreamItemsCache(sessionId);
    }

    // ---- Hydration window ----------------------------------------------------
    // The view reports which turns intersect the viewport; the stream keeps
    // that window plus two screens on each side hydrated and retained. An
    // active in-conversation search hydrates everything instead, because
    // search navigation needs every matched turn's rows to exist. That is a
    // temporary bridge until the search index reads through the view.
    const search = useSessionSearch();
    const searchActive = Boolean(search?.isOpen && search.query);
    const turnCount = useConversationViewSelector(conversationView, readTurnCount, 0);
    const [visibleTurnRange, setVisibleTurnRange] = useState<TurnRange | null>(null);
    const hydrationRange = useMemo<TurnRange>(() => {
      if (!conversationView) return EMPTY_TURN_RANGE;
      if (searchActive) return { from: 0, to: turnCount };
      return computeHydrationRange(visibleTurnRange, turnCount);
    }, [conversationView, searchActive, turnCount, visibleTurnRange]);
    const viewRevision = useTurnRange(conversationView, hydrationRange.from, hydrationRange.to);
    // Hover hydration (outline previews) does not bump the view's version.
    const [hoverHydrationRevision, setHoverHydrationRevision] = useState(0);
    const handleVisibleTurnRangeChange = useCallback((from: number, to: number) => {
      setVisibleTurnRange((previous) =>
        isSameTurnRange(previous, { from, to }) ? previous : { from, to }
      );
    }, []);
    const handleOutlineHoverTurn = useCallback(
      (turnIndex: number) => {
        if (!conversationView || conversationView.isHydrated(turnIndex)) return;
        void conversationView.ensureRange(turnIndex, turnIndex + 1).then(() => {
          setHoverHydrationRevision((revision) => revision + 1);
        });
      },
      [conversationView]
    );

    const { items, lastAssistantMessageId, lastCompletedAssistantMessageId, cache } = useMemo(
      () =>
        conversationView
          ? buildChatStreamItemsFromView(
              conversationView,
              sessionId,
              chatStreamItemsCacheRef.current
            )
          : buildChatStreamItems(sessionHistory, sessionId, chatStreamItemsCacheRef.current),
      // The revisions are the view's change signals; the builder reads the
      // view directly.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [conversationView, hoverHydrationRevision, sessionHistory, sessionId, viewRevision]
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
    const fallbackLastUserMessageId = useMemo(() => {
      if (conversationView) return null;
      for (let index = sessionHistory.length - 1; index >= 0; index -= 1) {
        if (sessionHistory[index]?.role === 'user') return sessionHistory[index]?.id ?? null;
      }
      return null;
    }, [conversationView, sessionHistory]);
    // Index rows carry `role` and `id`, so this never hydrates a turn.
    const lastUserMessageId = useConversationViewSelector(
      conversationView,
      findLastUserTurnId,
      fallbackLastUserMessageId
    );

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
        onVisibleTurnRangeChange={conversationView ? handleVisibleTurnRangeChange : undefined}
        onOutlineHoverTurn={conversationView ? handleOutlineHoverTurn : undefined}
      />
    );
  }
);

export const SessionChatStream = memo(SessionChatStreamImpl);
SessionChatStream.displayName = 'SessionChatStream';

export default SessionChatStream;
