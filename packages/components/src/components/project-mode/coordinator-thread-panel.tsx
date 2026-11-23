import * as stylex from '@stylexjs/stylex';
import {
  createCoordinatorReplyRef,
  formatCoordinatorAnchorId,
  getSessionRoomId,
  parseCoordinatorAnchorId,
  parseThreadRootsScalar,
  type CoordinatorReplyRef,
  type GitHubMergeMethod,
  type SessionHistoryParsed,
  type SessionId,
  type SessionPullRequestView,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { composerActionButtonTheme } from '@/components/chat/composer-action-button.stylex';
import { useAtomValue } from 'jotai';
import { ArrowUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import {
  readCoordinatorThreadDraft,
  writeCoordinatorThreadDraft,
} from './coordinator-composer-draft';
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
import {
  hasMultiplePullRequestRepos,
  resolveOrderedSessionPullRequests,
  resolveOwnerSessionForPullRequest,
  type CoordinatorProjectKey,
  type ProjectBoardBucket,
  type ProjectBoardRow,
} from './project-board-model';
import { ProjectBoardPrMenu } from './project-board-pr-menu';
import {
  useCoordinatorActionExecutor,
  type CoordinatorBubbleActionExecutionRequest,
  type CoordinatorCardDismissRequest,
} from './use-coordinator-action-executor';

const STATE_LABELS: Record<ProjectBoardBucket, [key: string, fallback: string]> = {
  needsYou: ['projectMode.board.needsYou', 'Needs you'],
  working: ['projectMode.board.working', 'In progress'],
  review: ['projectMode.board.review', 'To review'],
  accepted: ['projectMode.board.accepted', 'Accepted'],
};

const styles = stylex.create({
  fullHeight: {
    height: '100%',
  },
  primaryAction: {
    boxShadow: {
      default: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      ':focus-visible': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      ':active': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    },
    transitionProperty: 'all',
    transitionDuration: 'var(--default-transition-duration, 150ms)',
    transitionTimingFunction:
      'var(--default-transition-timing-function, cubic-bezier(0.4, 0, 0.2, 1))',
    translate: { default: null, ':active': '0 1px' },
  },
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
    task?.workItemTitle?.trim() ||
    task?.session.title?.trim() ||
    meta?.title?.trim() ||
    t('sessions.untitled', 'Untitled session');
  const number = formatTaskNumber(task?.taskNumber ?? null);
  const bucket = task?.bucket ?? (meta?.isArchived ? 'accepted' : undefined);
  const prs =
    task?.pullRequests && task.pullRequests.length > 0
      ? task.pullRequests
      : meta
        ? resolveOrderedSessionPullRequests(meta)
        : [];
  const showRepo = hasMultiplePullRequestRepos(prs);

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
      {prs.map((pr) => (
        <ProjectBoardPrMenu
          key={pr.url}
          sessionId={task ? resolveOwnerSessionForPullRequest(task, pr.url) : sessionId}
          pr={pr}
          showRepoPrefix={showRepo}
          onOpenPr={onOpenPr}
        />
      ))}
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
  preferredMergeMethod?: GitHubMergeMethod;
  supportedActionCommands?: ReadonlySet<string>;
  onExecuteBubbleAction?: (req: CoordinatorBubbleActionExecutionRequest) => Promise<void> | void;
  onDismissBubbleCard?: (req: CoordinatorCardDismissRequest) => Promise<void> | void;
  prefillBridgeRef?: React.MutableRefObject<
    ((prompt: string, replyTo: CoordinatorReplyRef) => void) | null
  >;
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
  preferredMergeMethod,
  supportedActionCommands,
  onExecuteBubbleAction,
  onDismissBubbleCard,
  prefillBridgeRef,
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
  }, [
    canonicalRootId,
    coordinatorSessionId,
    conversationView,
    fallbackItems,
    targetTurnIds,
    viewVersion,
  ]);

  const threadMessages = useMemo(
    () => filteredItems.flatMap((item) => (item.type === 'message' ? [item.message] : [])),
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

  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const threadMemoryScope = `${coordinatorSessionId}:${canonicalRootId}`;
  const threadStorageScope = workspaceId ? `${workspaceId}:${threadMemoryScope}` : null;
  const [subReplyTarget, setSubReplyTargetState] = useState<CoordinatorReplyRef | null>(
    () =>
      readCoordinatorThreadDraft(workspaceId, coordinatorSessionId, canonicalRootId).subReplyTarget
  );
  const [promptValue, setPromptValueState] = useState(
    () => readCoordinatorThreadDraft(workspaceId, coordinatorSessionId, canonicalRootId).prompt
  );
  const [activeThreadScope, setActiveThreadScope] = useState(threadMemoryScope);
  const [hydratedThreadStorageScope, setHydratedThreadStorageScope] = useState<string | null>(
    threadStorageScope
  );
  if (activeThreadScope !== threadMemoryScope) {
    const nextDraft = readCoordinatorThreadDraft(
      workspaceId,
      coordinatorSessionId,
      canonicalRootId
    );
    setActiveThreadScope(threadMemoryScope);
    setHydratedThreadStorageScope(threadStorageScope);
    setSubReplyTargetState(nextDraft.subReplyTarget);
    setPromptValueState(nextDraft.prompt);
  } else if (threadStorageScope && hydratedThreadStorageScope !== threadStorageScope) {
    setHydratedThreadStorageScope(threadStorageScope);
    if (!promptValue && !subReplyTarget) {
      const restoredDraft = readCoordinatorThreadDraft(
        workspaceId,
        coordinatorSessionId,
        canonicalRootId
      );
      if (restoredDraft.prompt || restoredDraft.subReplyTarget) {
        setSubReplyTargetState(restoredDraft.subReplyTarget);
        setPromptValueState(restoredDraft.prompt);
      }
    }
  }
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<ComposerInputElement | null>(null);

  const setPromptValue = useCallback(
    (nextPrompt: string) => {
      setPromptValueState(nextPrompt);
      writeCoordinatorThreadDraft(workspaceId, coordinatorSessionId, canonicalRootId, {
        prompt: nextPrompt,
        subReplyTarget,
      });
    },
    [canonicalRootId, coordinatorSessionId, subReplyTarget, workspaceId]
  );

  const setSubReplyTarget = useCallback(
    (nextTarget: CoordinatorReplyRef | null) => {
      setSubReplyTargetState(nextTarget);
      writeCoordinatorThreadDraft(workspaceId, coordinatorSessionId, canonicalRootId, {
        prompt: promptValue,
        subReplyTarget: nextTarget,
      });
    },
    [canonicalRootId, coordinatorSessionId, promptValue, workspaceId]
  );

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
    [canonicalRootId, setSubReplyTarget]
  );

  useEffect(() => {
    if (!prefillBridgeRef) return undefined;
    prefillBridgeRef.current = (prompt: string, reply: CoordinatorReplyRef) => {
      const nextTarget: CoordinatorReplyRef = {
        ...reply,
        threadRootId: canonicalRootId,
      };
      setSubReplyTargetState(nextTarget);
      setPromptValueState(prompt);
      writeCoordinatorThreadDraft(workspaceId, coordinatorSessionId, canonicalRootId, {
        prompt,
        subReplyTarget: nextTarget,
      });
      requestAnimationFrame(() => {
        promptRef.current?.focus();
      });
    };
    return () => {
      prefillBridgeRef.current = null;
    };
  }, [canonicalRootId, coordinatorSessionId, prefillBridgeRef, workspaceId]);

  const effectiveReplyRef = subReplyTarget ?? defaultRootReplyRef;
  const canSend = Boolean(
    onSendReply && effectiveReplyRef && promptValue.trim().length > 0 && !submitting
  );

  const handleSend = useCallback(async () => {
    const trimmed = promptValue.trim();
    if (!trimmed || !onSendReply || !effectiveReplyRef || submitting) return;
    setSubmitting(true);
    try {
      const ok = await onSendReply(trimmed, effectiveReplyRef);
      if (ok !== false) {
        setPromptValueState('');
        setSubReplyTargetState(null);
        writeCoordinatorThreadDraft(workspaceId, coordinatorSessionId, canonicalRootId, {
          prompt: '',
          subReplyTarget: null,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    canonicalRootId,
    coordinatorSessionId,
    effectiveReplyRef,
    onSendReply,
    promptValue,
    submitting,
    workspaceId,
  ]);

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
      preferredMergeMethod,
      supportedActionCommands,
      onExecuteBubbleAction,
      onDismissBubbleCard,
    }),
    [
      canonicalRootId,
      handleReplyInsideThread,
      onDismissBubbleCard,
      onExecuteBubbleAction,
      onOpenExternalLink,
      onOpenTask,
      onSendReply,
      preferredMergeMethod,
      supportedActionCommands,
      tasks,
    ]
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
        className={stylex.props(styles.fullHeight).className}
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
                className={stylex.props(styles.fullHeight).className}
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
                <div
                  {...stylex.props(styles.composerContainer)}
                  data-coordinator-thread-composer=""
                >
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
                          variant="solid"
                          size="small"
                          shape="pill"
                          disabled={!canSend}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void handleSend()}
                          aria-label={t('sessions.send', 'Send')}
                          className={stylex.props(composerActionButtonTheme).className}
                          xstyle={styles.primaryAction}
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

const noopThreadVoid = () => {};

/**
 * Leaf wrapper that subscribes to project-board presence & font-size atoms locally
 * so presence ticks never re-render `SessionDetail`.
 */
export function ConnectedCoordinatorThreadPanel({
  coordinatorSessionId,
  project,
  conversationFontSize,
  onOpenTask,
  onOpenPr,
  onOpenExternalLink,
  onSendReply,
  onPrefillChildSession,
  ...rest
}: Omit<
  CoordinatorThreadPanelProps,
  | 'tasks'
  | 'preferredMergeMethod'
  | 'supportedActionCommands'
  | 'onExecuteBubbleAction'
  | 'onDismissBubbleCard'
> & {
  project: CoordinatorProjectKey | null;
  onPrefillChildSession?: (sessionId: SessionId, prompt: string) => void;
}) {
  const tasks = useCoordinatorTasksData(coordinatorSessionId, project);
  const atomFontSize = useAtomValue(conversationFontSizeAtom);
  const prefillBridgeRef = useRef<((prompt: string, replyTo: CoordinatorReplyRef) => void) | null>(
    null
  );
  const sendCoordinatorPrompt = useCallback(
    async (prompt: string, replyTo: CoordinatorReplyRef) => {
      if (!onSendReply) return false;
      return Boolean(await onSendReply(prompt, replyTo));
    },
    [onSendReply]
  );
  const prefillCoordinatorPrompt = useCallback((prompt: string, replyTo: CoordinatorReplyRef) => {
    prefillBridgeRef.current?.(prompt, replyTo);
  }, []);
  const { executeBubbleAction, dismissCard, supportedCommands, preferredMergeMethod } =
    useCoordinatorActionExecutor({
      coordinatorSessionId,
      tasks,
      onOpenTask,
      onOpenPr: onOpenPr ?? noopThreadVoid,
      onOpenExternalLink,
      onSendCoordinatorPrompt: sendCoordinatorPrompt,
      onPrefillCoordinatorPrompt: prefillCoordinatorPrompt,
      onPrefillChildSession: onPrefillChildSession ?? noopThreadVoid,
    });

  return (
    <CoordinatorThreadPanel
      coordinatorSessionId={coordinatorSessionId}
      tasks={tasks}
      conversationFontSize={conversationFontSize ?? atomFontSize}
      onOpenTask={onOpenTask}
      onOpenPr={onOpenPr}
      onOpenExternalLink={onOpenExternalLink}
      onSendReply={onSendReply}
      preferredMergeMethod={preferredMergeMethod}
      supportedActionCommands={supportedCommands}
      onExecuteBubbleAction={executeBubbleAction}
      onDismissBubbleCard={dismissCard}
      prefillBridgeRef={prefillBridgeRef}
      {...rest}
    />
  );
}
