import * as stylex from '@stylexjs/stylex';
import {
  createCoordinatorReplyRef,
  formatCoordinatorAnchorId,
  getSessionRoomId,
  parseCoordinatorAnchorId,
  parseThreadRootsScalar,
  resolveSessionPrimaryPullRequest,
  type CoordinatorReplyRef,
  type SessionHistoryParsed,
  type SessionId,
  type SessionPullRequestView,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { useAtomValue } from 'jotai';
import { ArrowUp } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import {
  conversationFontSizeAtom,
  DEFAULT_CONVERSATION_FONT_SIZE,
  type ConversationFontSize,
} from '@/atoms/settings';
import { parseHistoryItemsForRender } from '@/components/ai-gui/build-chat-stream-items';
import {
  MessageRowView,
  SessionChatStreamView,
  type AgentActivityTone,
  type ChatStreamItem,
} from '@/components/ai-gui/view';
import { ChatComposer } from '@/components/chat/chat-composer';
import {
  SessionConversationPage,
  SessionConversationPageBody,
} from '@/components/sessions/session-conversation-page';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { useConversationVersion } from '@/hooks/use-conversation-view';
import type { ConversationView } from '@/lib/conversation-view';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { useResolvedTheme } from '@/theme-provider';
import type { ComposerInputElement } from '@/ui/mention/composer-input';
import {
  CoordinatorConversationPreviewProvider,
  type CoordinatorConversationValue,
} from './coordinator-conversation';
import { CoordinatorComposerReplyBanner } from './coordinator-reply-ui';
import {
  collectThreadLinkedSessionIds,
  filterThreadStreamItems,
  resolveAssistantCausalTurnId,
  type CoordinatorThreadDirectoryIndex,
} from './coordinator-thread-model';
import { formatTaskNumber, useCoordinatorTasksData } from './project-board';
import type {
  CoordinatorProjectKey,
  ProjectBoardBucket,
  ProjectBoardRow,
} from './project-board-model';
import { ProjectBoardPrMenu } from './project-board-pr-menu';

const STATE_LABELS: Record<ProjectBoardBucket, [key: string, fallback: string]> = {
  needsYou: ['projectMode.board.needsYou', 'Needs you'],
  working: ['projectMode.board.working', 'In progress'],
  review: ['projectMode.board.review', 'To review'],
  accepted: ['projectMode.board.accepted', 'Accepted'],
};

const styles = stylex.create({
  linkedHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    paddingBlock: space[2],
    paddingInline: space[3],
    borderBottomWidth: '0.5px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
    backgroundColor: colors.background,
    flexShrink: 0,
  },
  linkedLabel: {
    flexShrink: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    marginInlineEnd: space[1],
  },
  linkedItemGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    maxWidth: '100%',
  },
  taskChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    maxWidth: 260,
    minWidth: 0,
    paddingBlock: 2,
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
  },
  taskNumber: {
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
  },
  taskTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  state: {
    flexShrink: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  stateneedsYou: { color: colors.warning },
  stateworking: { color: colors.accent },
  statereview: { color: colors.label },
  stateaccepted: { color: colors.success },
  composerContainer: {
    paddingBlockEnd: space[3],
    paddingBlockStart: space[1],
    backgroundColor: colors.background,
    flexShrink: 0,
  },
  sendIcon: {
    width: 14,
    height: 14,
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingBlock: space[6],
    color: colors.secondaryLabel,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
});

function ThreadLinkedTaskItem({
  sessionId,
  task,
  onOpenTask,
  onOpenPr,
}: {
  sessionId: SessionId;
  task: ProjectBoardRow | undefined;
  onOpenTask: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
}) {
  const { t } = useTranslation();
  const meta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const title =
    task?.session.title?.trim() ||
    meta?.title?.trim() ||
    t('sessions.untitled', 'Untitled session');
  const number = formatTaskNumber(task?.taskNumber ?? null);
  const bucket = task?.bucket ?? (meta?.isArchived ? 'accepted' : undefined);
  const pr =
    task?.pullRequest ?? (meta ? resolveSessionPrimaryPullRequest(meta) : null);

  return (
    <div {...stylex.props(styles.linkedItemGroup)} data-coordinator-thread-linked-task="">
      <button
        type="button"
        title={title}
        onClick={() => onOpenTask(sessionId)}
        {...stylex.props(styles.taskChip)}
      >
        {number ? <span {...stylex.props(styles.taskNumber)}>{number}</span> : null}
        <span {...stylex.props(styles.taskTitle)}>{title}</span>
        {bucket ? (
          <span {...stylex.props(styles.state, styles[`state${bucket}`])}>
            {t(STATE_LABELS[bucket][0], STATE_LABELS[bucket][1])}
          </span>
        ) : null}
      </button>
      {pr ? (
        <ProjectBoardPrMenu sessionId={sessionId} pr={pr} onOpenPr={onOpenPr} />
      ) : null}
    </div>
  );
}

function readMessagePlainText(message: SessionHistoryParsed): string {
  const parts: string[] = [];
  for (const item of message.items) {
    if (item.type === 'text' && item.text.trim()) {
      parts.push(item.text.trim());
    }
  }
  if (parts.length > 0) return parts.join('\n');
  const prompt = message.inputConfig?.prompt?.trim();
  return prompt ?? '';
}

export interface CoordinatorThreadPanelProps {
  coordinatorSessionId: SessionId;
  threadRootId: string;
  previewHint?: string;
  conversationView?: ConversationView | null;
  threadIndex?: CoordinatorThreadDirectoryIndex;
  /** Used in Storybook or static previews without a backing `ConversationView`. */
  fallbackItems?: readonly ChatStreamItem[];
  tasks: ReadonlyMap<string, ProjectBoardRow>;
  onOpenTask: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  onOpenExternalLink?: (href: string, label?: string) => boolean;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
  onSendReply?: (prompt: string, replyTo: CoordinatorReplyRef) => Promise<boolean> | boolean;
  agentActivityLabel?: string | null;
  agentActivityTone?: AgentActivityTone;
  conversationFontSize?: ConversationFontSize;
  isVisible?: boolean;
}

export function CoordinatorThreadPanel({
  coordinatorSessionId,
  threadRootId,
  previewHint,
  conversationView = null,
  threadIndex,
  fallbackItems,
  tasks,
  onOpenTask,
  onOpenPr,
  onOpenExternalLink,
  onNavigateSession,
  onSendReply,
  agentActivityLabel = null,
  agentActivityTone = 'primary',
  conversationFontSize = DEFAULT_CONVERSATION_FONT_SIZE,
  isVisible = true,
}: CoordinatorThreadPanelProps) {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const composerTone = resolvedTheme === 'dark' ? 'dark' : 'light';
  const rootAnchor = useMemo(() => parseCoordinatorAnchorId(threadRootId), [threadRootId]);
  const canonicalRootId = useMemo(
    () => (rootAnchor ? formatCoordinatorAnchorId(rootAnchor) : threadRootId),
    [rootAnchor, threadRootId]
  );

  const viewVersion = useConversationVersion(conversationView);
  const structureVersion = conversationView?.structureVersion ?? 0;

  const targetTurnIds = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    const push = (id: string | undefined) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      list.push(id);
    };
    if (rootAnchor) {
      if (rootAnchor.kind === 'coordinator_bubble') {
        const rootIdx = conversationView?.indexOf(rootAnchor.turnId) ?? -1;
        const rootRow = rootIdx >= 0 ? conversationView?.index(rootIdx) : undefined;
        const causalId = resolveAssistantCausalTurnId(rootAnchor.turnId, rootRow?.userTurnId);
        if (causalId) push(causalId);
        push(rootAnchor.turnId);
      } else {
        push(rootAnchor.turnId);
        push(`assistant:${rootAnchor.turnId}`);
      }
    }
    for (const id of threadIndex?.turnIdsByRootId.get(canonicalRootId) ?? []) {
      push(id);
    }
    if (conversationView) {
      for (let i = 0; i < conversationView.turnCount; i += 1) {
        const row = conversationView.index(i);
        if (!row?.id) continue;
        if (
          rootAnchor?.kind === 'user_turn' &&
          row.role === 'assistant' &&
          resolveAssistantCausalTurnId(row.id, row.userTurnId) === rootAnchor.turnId
        ) {
          push(row.id);
        }
        if (parseThreadRootsScalar(row.threadRoots).includes(canonicalRootId)) {
          push(row.id);
        }
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonicalRootId, conversationView, rootAnchor, structureVersion, threadIndex, viewVersion]);

  const targetTurnIdsKey = targetTurnIds.join('\n');

  useEffect(() => {
    if (!conversationView || targetTurnIds.length === 0) return undefined;
    const leases: Array<{ release(): void }> = [];
    for (const turnId of targetTurnIds) {
      const idx = conversationView.indexOf(turnId);
      if (idx >= 0) {
        leases.push(conversationView.acquireRange(idx, idx + 1));
      } else if (conversationView.hasMoreOlder && conversationView.acquireDirectory) {
        leases.push(conversationView.acquireDirectory(turnId));
      }
    }
    return () => {
      for (const lease of leases) lease.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationView, structureVersion, targetTurnIdsKey]);

  const filteredItems = useMemo<ChatStreamItem[]>(() => {
    if (!conversationView) {
      if (!fallbackItems) return [];
      return filterThreadStreamItems(fallbackItems, canonicalRootId).map((item, idx) => ({
        ...item,
        turnIndex: idx,
      }));
    }

    const indices: number[] = [];
    const seenIndices = new Set<number>();
    for (const turnId of targetTurnIds) {
      const idx = conversationView.indexOf(turnId);
      if (idx >= 0 && !seenIndices.has(idx)) {
        seenIndices.add(idx);
        indices.push(idx);
      }
    }
    indices.sort((a, b) => a - b);

    const rawItems: ChatStreamItem[] = [];
    for (const idx of indices) {
      const entry = conversationView.turn(idx);
      if (!entry) continue;
      const message: SessionHistoryParsed = {
        ...entry,
        items: parseHistoryItemsForRender(entry.items),
        read: entry.read ?? false,
      };
      rawItems.push({
        type: 'message',
        sessionId: coordinatorSessionId,
        message,
        turnIndex: idx,
      });
    }

    return filterThreadStreamItems(rawItems, canonicalRootId).map((item, idx) => ({
      ...item,
      turnIndex: idx,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonicalRootId, coordinatorSessionId, conversationView, fallbackItems, targetTurnIds, viewVersion]);

  const threadMessages = useMemo(
    () =>
      filteredItems.flatMap((item) => (item.type === 'message' ? [item.message] : [])),
    [filteredItems]
  );

  const linkedSessionIds = useMemo(
    () => collectThreadLinkedSessionIds(threadMessages),
    [threadMessages]
  );

  const defaultRootReplyRef = useMemo<CoordinatorReplyRef | null>(() => {
    if (!rootAnchor) return null;
    const rootMsg = threadMessages.find((msg) => msg.id === rootAnchor.turnId);
    let previewSource = previewHint ?? '';
    if (rootMsg) {
      if (rootAnchor.kind === 'coordinator_bubble') {
        const bubble = rootMsg.items.find(
          (entry) => entry.type === 'coordinator_message' && entry.id === rootAnchor.bubbleId
        );
        if (bubble && bubble.type === 'coordinator_message') {
          previewSource = bubble.body;
        }
      } else {
        const text = readMessagePlainText(rootMsg);
        if (text) previewSource = text;
      }
    }
    return createCoordinatorReplyRef({
      target: rootAnchor,
      existingThreadRootId: canonicalRootId,
      author: rootAnchor.kind === 'coordinator_bubble' ? 'coordinator' : 'user',
      text: previewSource,
    });
  }, [canonicalRootId, previewHint, rootAnchor, threadMessages]);

  const [subReplyTarget, setSubReplyTarget] = useState<CoordinatorReplyRef | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<ComposerInputElement | null>(null);

  useEffect(() => {
    setSubReplyTarget(null);
    setPromptValue('');
  }, [canonicalRootId]);

  const handleReplyInsideThread = useCallback(
    (reply: CoordinatorReplyRef) => {
      setSubReplyTarget({
        ...reply,
        threadRootId: canonicalRootId,
      });
      requestAnimationFrame(() => {
        promptRef.current?.focus();
      });
    },
    [canonicalRootId]
  );

  const effectiveReplyRef = subReplyTarget ?? defaultRootReplyRef;
  const canSend = Boolean(onSendReply && effectiveReplyRef && promptValue.trim().length > 0 && !submitting);

  const handleSend = useCallback(async () => {
    const trimmed = promptValue.trim();
    if (!trimmed || !onSendReply || !effectiveReplyRef || submitting) return;
    setSubmitting(true);
    try {
      const ok = await onSendReply(trimmed, effectiveReplyRef);
      if (ok !== false) {
        setPromptValue('');
        setSubReplyTarget(null);
      }
    } finally {
      setSubmitting(false);
    }
  }, [effectiveReplyRef, onSendReply, promptValue, submitting]);

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<ComposerInputElement>) => {
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !isImeComposingKeyboardEvent(event)
      ) {
        event.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  const threadIsActivelyWorking = useMemo(() => {
    const lastMsg = threadMessages.at(-1);
    if (!lastMsg) return false;
    if (lastMsg.role === 'assistant') {
      return lastMsg.finished !== true && typeof lastMsg.endedAt !== 'number';
    }
    if (lastMsg.role === 'user') {
      if (!conversationView) return Boolean(agentActivityLabel);
      const lastGlobalRow =
        conversationView.turnCount > 0
          ? conversationView.index(conversationView.turnCount - 1)
          : undefined;
      return Boolean(agentActivityLabel && lastGlobalRow?.id === lastMsg.id);
    }
    return false;
  }, [agentActivityLabel, conversationView, threadMessages]);

  const threadActivityLabel = threadIsActivelyWorking ? agentActivityLabel : null;

  const nestedConversationValue = useMemo<CoordinatorConversationValue>(
    () => ({
      tasks,
      openTask: onOpenTask,
      openExternalLink: onOpenExternalLink,
      activeThreadRootId: canonicalRootId,
      onReplyToBubble: onSendReply ? handleReplyInsideThread : undefined,
    }),
    [canonicalRootId, handleReplyInsideThread, onOpenExternalLink, onOpenTask, onSendReply, tasks]
  );

  const threadStreamSessionId = `${coordinatorSessionId}#thread:${canonicalRootId}` as SessionId;

  const emptyStateNode = useMemo(
    () => (
      <div {...stylex.props(styles.emptyState)}>
        <Spinner size="small" />
        <span>{t('projectMode.thread.empty', 'Loading thread…')}</span>
      </div>
    ),
    [t]
  );

  return (
    <CoordinatorConversationPreviewProvider value={nestedConversationValue}>
      <SessionConversationPage
        className="h-full"
        subHeaderSlot={
          linkedSessionIds.length > 0 ? (
            <div {...stylex.props(styles.linkedHeader)} data-coordinator-thread-linked-bar="">
              <span {...stylex.props(styles.linkedLabel)}>
                {t('projectMode.thread.linkedTasks', 'Linked conversations')}
              </span>
              {linkedSessionIds.map((id) => (
                <ThreadLinkedTaskItem
                  key={id}
                  sessionId={id}
                  task={tasks.get(id)}
                  onOpenTask={onOpenTask}
                  onOpenPr={onOpenPr}
                />
              ))}
            </div>
          ) : null
        }
        bodySlot={
          <SessionConversationPageBody
            streamSlot={
              <SessionChatStreamView
                sessionId={threadStreamSessionId}
                items={filteredItems}
                emptyState={emptyStateNode}
                isVisible={isVisible}
                agentActivityLabel={threadActivityLabel}
                agentActivityTone={agentActivityTone}
                agentActivityShimmer={agentActivityTone !== 'warning'}
                conversationFontSize={conversationFontSize}
                className="h-full"
                renderMessageRow={({ message }) => (
                  <MessageRowView
                    message={message}
                    sessionId={coordinatorSessionId}
                    onNavigateSession={onNavigateSession}
                    conversationFontSize={conversationFontSize}
                  />
                )}
              />
            }
            composerSlot={
              onSendReply ? (
                <div {...stylex.props(styles.composerContainer)} data-coordinator-thread-composer="">
                  <ConversationColumn>
                    <ChatComposer
                      tone={composerTone}
                      variant="session"
                      currentSessionId={coordinatorSessionId}
                      promptRef={promptRef}
                      promptValue={promptValue}
                      onPromptChange={setPromptValue}
                      onPromptKeyDown={handleComposerKeyDown}
                      promptPlaceholder={t(
                        'projectMode.thread.composerPlaceholder',
                        'Reply in thread…'
                      )}
                      promptDisabled={submitting}
                      promptRows={1}
                      autoResize
                      maxRows={8}
                      replyBanner={
                        subReplyTarget ? (
                          <CoordinatorComposerReplyBanner
                            reply={subReplyTarget}
                            onClear={() => setSubReplyTarget(null)}
                          />
                        ) : undefined
                      }
                      primaryAction={
                        <Button
                          type="button"
                          icon
                          variant="ghost"
                          size="small"
                          shape="pill"
                          disabled={!canSend}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void handleSend()}
                          aria-label={t('sessions.send', 'Send')}
                          className="shadow-xs transition-all bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px]"
                        >
                          {submitting ? (
                            <Spinner size="small" />
                          ) : (
                            <ArrowUp {...stylex.props(styles.sendIcon)} />
                          )}
                        </Button>
                      }
                    />
                  </ConversationColumn>
                </div>
              ) : null
            }
          />
        }
      />
    </CoordinatorConversationPreviewProvider>
  );
}

/**
 * Leaf wrapper that subscribes to project-board presence & font-size atoms locally
 * so presence ticks never re-render `SessionDetail`.
 */
export function ConnectedCoordinatorThreadPanel({
  coordinatorSessionId,
  project,
  conversationFontSize,
  ...rest
}: Omit<CoordinatorThreadPanelProps, 'tasks'> & {
  project: CoordinatorProjectKey | null;
}) {
  const tasks = useCoordinatorTasksData(coordinatorSessionId, project);
  const atomFontSize = useAtomValue(conversationFontSizeAtom);
  return (
    <CoordinatorThreadPanel
      coordinatorSessionId={coordinatorSessionId}
      tasks={tasks}
      conversationFontSize={conversationFontSize ?? atomFontSize}
      {...rest}
    />
  );
}

