import * as stylex from '@stylexjs/stylex';
import { getSessionRoomId, type CoordinatorReplyRef, type SessionId } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { useAtomValue } from 'jotai';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { formatTaskNumber, useCoordinatorTasksData } from './project-board';
import type {
  CoordinatorProjectKey,
  ProjectBoardBucket,
  ProjectBoardRow,
} from './project-board-model';

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
  openExternalLink?: (href: string, label?: string) => boolean;
  replyCountByRootId?: ReadonlyMap<string, number>;
  activeThreadRootId?: string | null;
  onReplyToBubble?: (reply: CoordinatorReplyRef) => void;
  onOpenThread?: (threadRootId: string, previewHint?: string) => void;
};

const CoordinatorConversationContext = createContext<CoordinatorConversationValue | null>(null);

/** `null` outside a project coordinator's own conversation. */
export const useCoordinatorConversation = (): CoordinatorConversationValue | null =>
  useContext(CoordinatorConversationContext);

export function CoordinatorConversationProvider({
  coordinatorSessionId,
  project,
  onOpenTask,
  onOpenExternalLink,
  replyCountByRootId,
  activeThreadRootId = null,
  onReplyToBubble,
  onOpenThread,
  children,
}: {
  coordinatorSessionId: string;
  project: CoordinatorProjectKey | null;
  onOpenTask: (sessionId: string) => void;
  onOpenExternalLink?: (href: string, label?: string) => boolean;
  replyCountByRootId?: ReadonlyMap<string, number>;
  activeThreadRootId?: string | null;
  onReplyToBubble?: (reply: CoordinatorReplyRef) => void;
  onOpenThread?: (threadRootId: string, previewHint?: string) => void;
  children: ReactNode;
}) {
  const tasks = useCoordinatorTasksData(coordinatorSessionId, project);
  const value = useMemo<CoordinatorConversationValue>(
    () => ({
      tasks,
      openTask: onOpenTask,
      openExternalLink: onOpenExternalLink,
      replyCountByRootId,
      activeThreadRootId,
      onReplyToBubble,
      onOpenThread,
    }),
    [
      activeThreadRootId,
      onOpenExternalLink,
      onOpenTask,
      onOpenThread,
      onReplyToBubble,
      replyCountByRootId,
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
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    maxWidth: 320,
    minWidth: 0,
    paddingBlock: 2,
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    cursor: 'pointer',
  },
  chipNumber: { fontVariantNumeric: 'tabular-nums', color: colors.secondaryLabel },
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

function CoordinatorTaskChip({
  sessionId,
  task,
  fallbackTitle,
  onOpen,
}: {
  sessionId: string;
  task: ProjectBoardRow | undefined;
  fallbackTitle: string | undefined;
  onOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const meta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId as SessionId)));
  const title =
    task?.session.title?.trim() ||
    meta?.title?.trim() ||
    fallbackTitle?.trim() ||
    t('sessions.untitled', 'Untitled session');
  const number = formatTaskNumber(task?.taskNumber ?? null);
  const bucket = task?.bucket ?? (meta?.isArchived ? 'accepted' : undefined);
  return (
    <button
      type="button"
      title={title}
      onClick={() => onOpen(sessionId)}
      {...stylex.props(styles.chip)}
    >
      {number ? <span {...stylex.props(styles.chipNumber)}>{number}</span> : null}
      <span {...stylex.props(styles.chipTitle)}>{title}</span>
      {bucket ? <TaskState bucket={bucket} /> : null}
    </button>
  );
}

/**
 * One line in place of a receipt or creation row: the tasks it touched, each
 * with its state now. The original row opens beneath on request.
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
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div {...stylex.props(styles.strip)} data-coordinator-change-strip="">
      <div {...stylex.props(styles.stripHead)}>
        <span {...stylex.props(styles.stripLabel)}>
          {t('projectMode.changes.label', 'Changes')}
        </span>
        {sessionIds.map((id) => (
          <CoordinatorTaskChip
            key={id}
            sessionId={id}
            task={coordinator.tasks.get(id)}
            fallbackTitle={fallbackTitles.get(id)}
            onOpen={coordinator.openTask}
          />
        ))}
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
      {expanded ? details : null}
    </div>
  );
}
