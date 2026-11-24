import * as stylex from '@stylexjs/stylex';
import {
  getSessionRoomId,
  type CoordinatorReplyRef,
  type GitHubMergeMethod,
  type SessionId,
  type SessionPullRequestView,
} from '@lody/shared';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { useAtomValue } from 'jotai';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import {
  formatTaskNumber,
  useAcceptCoordinatorTasks,
  useCoordinatorTasksData,
} from './project-board';
import { ProjectBoardPrStack } from './project-board-pr-stack';
import type {
  CoordinatorProjectKey,
  ProjectBoardBucket,
  ProjectBoardRow,
} from './project-board-model';
import {
  useCoordinatorActionExecutor,
  type CoordinatorBubbleActionExecutionRequest,
  type CoordinatorCardDismissRequest,
  type CoordinatorCardFeedbackRequest,
} from './use-coordinator-action-executor';
import type { CoordinatorPreviewChildAttentionItem } from './coordinator-child-attention-cards';

/**
 * Project mode: the coordinator's conversation shows people what changed, not
 * the machinery. Receipts and creation cards collapse into one "changes" line
 * whose task states come from the tasks themselves (including accepted/archived
 * tasks, so their titles, numbers and Accepted state stay intact).
 *
 * Presentation only: history, model input and receipts are untouched, so the
 * full rows are one click away and copy/export still see everything.
 */
type CoordinatorConversationValue = {
  tasks: ReadonlyMap<string, ProjectBoardRow>;
  openTask: (sessionId: string) => void;
  openPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  acceptTasks?: (sessionIds: readonly string[]) => void;
  openExternalLink?: (href: string, label?: string) => boolean;
  replyCountByRootId?: ReadonlyMap<string, number>;
  activeThreadRootId?: string | null;
  onReplyToBubble?: (reply: CoordinatorReplyRef) => void;
  onOpenThread?: (threadRootId: string, previewHint?: string) => void;
  preferredMergeMethod?: GitHubMergeMethod;
  supportedActionCommands?: ReadonlySet<string>;
  onExecuteBubbleAction?: (req: CoordinatorBubbleActionExecutionRequest) => Promise<void> | void;
  onSubmitCardFeedback?: (req: CoordinatorCardFeedbackRequest) => Promise<boolean> | boolean;
  onDismissBubbleCard?: (req: CoordinatorCardDismissRequest) => Promise<void> | void;
  previewChildAttention?: readonly CoordinatorPreviewChildAttentionItem[];
};

const CoordinatorConversationContext = createContext<CoordinatorConversationValue | null>(null);

/** `null` outside a project coordinator's own conversation. */
export const useCoordinatorConversation = (): CoordinatorConversationValue | null =>
  useContext(CoordinatorConversationContext);

const noopAsyncFalse = async () => false;
const noopVoid = () => {};

export function CoordinatorConversationProvider({
  coordinatorSessionId,
  project,
  onOpenTask,
  onOpenPr,
  onOpenExternalLink,
  replyCountByRootId,
  activeThreadRootId = null,
  onReplyToBubble,
  onOpenThread,
  onSendCoordinatorPrompt,
  onPrefillCoordinatorPrompt,
  onPrefillChildSession,
  children,
}: {
  coordinatorSessionId: string;
  project: CoordinatorProjectKey | null;
  onOpenTask: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  onOpenExternalLink?: (href: string, label?: string) => boolean;
  replyCountByRootId?: ReadonlyMap<string, number>;
  activeThreadRootId?: string | null;
  onReplyToBubble?: (reply: CoordinatorReplyRef) => void;
  onOpenThread?: (threadRootId: string, previewHint?: string) => void;
  onSendCoordinatorPrompt?: (prompt: string, replyTo: CoordinatorReplyRef) => Promise<boolean>;
  onPrefillCoordinatorPrompt?: (
    prompt: string,
    replyTo: CoordinatorReplyRef,
    activeThreadRootId?: string | null
  ) => void;
  onPrefillChildSession?: (sessionId: SessionId, prompt: string) => void;
  children: ReactNode;
}) {
  const tasks = useCoordinatorTasksData(coordinatorSessionId, project);
  const acceptTasks = useAcceptCoordinatorTasks();
  const {
    executeBubbleAction,
    submitCardFeedback,
    dismissCard,
    supportedCommands,
    preferredMergeMethod,
  } = useCoordinatorActionExecutor({
    coordinatorSessionId: coordinatorSessionId as SessionId,
    tasks,
    onOpenTask,
    onOpenPr: onOpenPr ?? noopVoid,
    onOpenExternalLink,
    onSendCoordinatorPrompt: onSendCoordinatorPrompt ?? noopAsyncFalse,
    onPrefillCoordinatorPrompt: onPrefillCoordinatorPrompt ?? noopVoid,
    onPrefillChildSession: onPrefillChildSession ?? noopVoid,
  });
  const value = useMemo<CoordinatorConversationValue>(
    () => ({
      tasks,
      openTask: onOpenTask,
      openPr: onOpenPr,
      acceptTasks,
      openExternalLink: onOpenExternalLink,
      replyCountByRootId,
      activeThreadRootId,
      onReplyToBubble,
      onOpenThread,
      preferredMergeMethod,
      supportedActionCommands: supportedCommands,
      onExecuteBubbleAction: executeBubbleAction,
      onSubmitCardFeedback: submitCardFeedback,
      onDismissBubbleCard: dismissCard,
    }),
    [
      acceptTasks,
      activeThreadRootId,
      dismissCard,
      executeBubbleAction,
      onOpenExternalLink,
      onOpenPr,
      onOpenTask,
      onOpenThread,
      onReplyToBubble,
      preferredMergeMethod,
      replyCountByRootId,
      submitCardFeedback,
      supportedCommands,
      tasks,
    ]
  );
  return (
    <CoordinatorConversationContext.Provider value={value}>
      {children}
    </CoordinatorConversationContext.Provider>
  );
}

export type { CoordinatorConversationValue };

/** Supplies the value directly, for stories that render without a workspace. */
export function CoordinatorConversationPreviewProvider({
  value,
  children,
}: {
  value: CoordinatorConversationValue;
  children: ReactNode;
}) {
  return (
    <CoordinatorConversationContext.Provider value={value}>
      {children}
    </CoordinatorConversationContext.Provider>
  );
}

const STATE_LABELS: Record<ProjectBoardBucket, [key: string, fallback: string]> = {
  needsYou: ['projectMode.board.needsYou', 'Needs you'],
  working: ['projectMode.board.working', 'In progress'],
  review: ['projectMode.board.review', 'To review'],
  accepted: ['projectMode.board.accepted', 'Accepted'],
};

const styles = stylex.create({
  strip: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    minWidth: 0,
  },
  stripHead: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
  },
  stripLabel: { flexShrink: 0 },
  inlineCardList: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    minWidth: 0,
  },
  inlineCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    paddingBlock: space[2],
    paddingInline: space[3],
    borderRadius: radius.large,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    minWidth: 0,
  },
  inlineCardTop: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minWidth: 0,
  },
  inlineCardTitleBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    flex: '1 1 180px',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    textAlign: 'start',
    cursor: 'pointer',
  },
  inlineCardRight: {
    display: 'inline-flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    flexShrink: 0,
  },
  inlineCardNote: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chipNumber: {
    display: 'inline-flex',
    alignItems: 'center',
    paddingInline: 5,
    height: 18,
    borderRadius: radius.small,
    backgroundColor: colors.wellBackground,
    fontSize: 11,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
    flexShrink: 0,
  },
  chipTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  state: { flexShrink: 0, fontSize: text.footnoteSize, lineHeight: text.footnoteLeading },
  stateneedsYou: { color: colors.warning },
  stateworking: { color: colors.accent },
  statereview: { color: colors.label },
  stateaccepted: { color: colors.success },
  disclosure: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.tertiaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
  },
});

function TaskState({ bucket }: { bucket: ProjectBoardBucket }) {
  const { t } = useTranslation();
  const [key, fallback] = STATE_LABELS[bucket];
  return <span {...stylex.props(styles.state, styles[`state${bucket}`])}>{t(key, fallback)}</span>;
}

function CoordinatorInlineTaskCard({
  sessionId,
  task,
  fallbackTitle,
  onOpen,
  onOpenPr,
  onAcceptTasks,
}: {
  sessionId: string;
  task: ProjectBoardRow | undefined;
  fallbackTitle: string | undefined;
  onOpen: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  onAcceptTasks?: (sessionIds: readonly string[]) => void;
}) {
  const { t } = useTranslation();
  const meta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId as SessionId)));
  const title =
    task?.workItemTitle?.trim() ||
    task?.session?.title?.trim() ||
    meta?.title?.trim() ||
    fallbackTitle?.trim() ||
    t('sessions.untitled', 'Untitled session');
  const number = formatTaskNumber(task?.taskNumber ?? null);
  const bucket = task?.bucket ?? (meta?.isArchived ? 'accepted' : undefined);
  const note = task?.pendingAction || task?.progressNote || task?.summary || null;

  return (
    <div
      {...stylex.props(styles.inlineCard)}
      data-coordinator-inline-task-card={task?.workItemId ?? sessionId}
    >
      <div {...stylex.props(styles.inlineCardTop)}>
        <button
          type="button"
          title={title}
          onClick={() => onOpen(sessionId)}
          {...stylex.props(styles.inlineCardTitleBtn)}
        >
          {number ? <span {...stylex.props(styles.chipNumber)}>{number}</span> : null}
          <span {...stylex.props(styles.chipTitle)}>{title}</span>
        </button>
        <div {...stylex.props(styles.inlineCardRight)}>
          {task && task.pullRequests.length > 0 ? (
            <ProjectBoardPrStack row={task} onOpenPr={onOpenPr} />
          ) : null}
          {bucket ? <TaskState bucket={bucket} /> : null}
          {task && bucket === 'review' && task.members.length > 0 && onAcceptTasks ? (
            <Button
              size="small"
              variant="secondary"
              onClick={() => onAcceptTasks(task.members.map((m) => m.session.id))}
            >
              {t('projectMode.board.accept', 'Accept')}
            </Button>
          ) : null}
        </div>
      </div>
      {note ? <p {...stylex.props(styles.inlineCardNote)}>{note}</p> : null}
    </div>
  );
}

/**
 * Live compact task cards in place of raw receipt/creation rows inside the
 * coordinator conversation, sharing the exact Project Store state with the
 * right-side Task Card board.
 */
export function CoordinatorTaskChangeStrip({
  sessionIds,
  fallbackTitles,
  details,
}: {
  sessionIds: readonly string[];
  /** Titles carried by the row, for tasks not on the board (archived, someone else's). */
  fallbackTitles: ReadonlyMap<string, string>;
  details: ReactNode;
}) {
  const { t } = useTranslation();
  const coordinator = useCoordinatorConversation();
  const [expanded, setExpanded] = useState(false);
  if (!coordinator) return <>{details}</>;
  const dedupedSessionIds = useMemo(() => {
    const out: string[] = [];
    const seenWorkItems = new Set<string>();
    for (const id of sessionIds) {
      const task = coordinator.tasks.get(id);
      const groupKey = task?.workItemId ?? id;
      if (seenWorkItems.has(groupKey)) continue;
      seenWorkItems.add(groupKey);
      out.push(id);
    }
    return out;
  }, [coordinator.tasks, sessionIds]);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div {...stylex.props(styles.strip)} data-coordinator-change-strip="">
      <div {...stylex.props(styles.stripHead)}>
        <span {...stylex.props(styles.stripLabel)}>
          {t('projectMode.changes.label', 'Changes')}
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          {...stylex.props(styles.disclosure)}
        >
          {t('projectMode.changes.details', 'Details')}
          <Chevron size={12} aria-hidden="true" />
        </button>
      </div>
      <div {...stylex.props(styles.inlineCardList)}>
        {dedupedSessionIds.map((id) => (
          <CoordinatorInlineTaskCard
            key={id}
            sessionId={id}
            task={coordinator.tasks.get(id)}
            fallbackTitle={fallbackTitles.get(id)}
            onOpen={coordinator.openTask}
            onOpenPr={coordinator.openPr}
            onAcceptTasks={coordinator.acceptTasks}
          />
        ))}
      </div>
      {expanded ? details : null}
    </div>
  );
}
