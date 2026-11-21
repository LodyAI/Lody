import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { toast } from '@/lib/toast';
import {
  findFreshSessionPresenceState,
  getServerNow,
  type SessionId,
  type SessionPullRequestView,
  type SessionStatus,
} from '@lody/shared';
import { useRouter } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import { sessionSendStatesAtom } from '@/atoms/session-send-status';
import { allSessionsIncludingArchivedAtom } from '@/atoms/doc-meta';
import { SessionRowStatusIndicator } from '@/components/sidebar-row-shared';
import { buildChildSessionsByParent } from '@/components/sessions/session-list-rows';
import { useMySessionScope, useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { useSessionActions } from '@/hooks/use-session-actions';
import {
  buildProjectBoard,
  coordinatorProjectKeyId,
  findProjectCoordinatorSession,
  PROJECT_BOARD_BUCKETS,
  type CoordinatorProjectKey,
  type ProjectBoard as ProjectBoardData,
  type ProjectBoardBucket,
  type ProjectBoardRow,
} from './project-board-model';
import { ProjectBoardPrMenu } from './project-board-pr-menu';

const styles = stylex.create({
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    minWidth: 0,
    height: '100%',
    overflowY: 'auto',
    paddingBlock: space[4],
    paddingInline: space[4],
    backgroundColor: colors.secondaryBackground,
  },
  title: {
    margin: 0,
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  section: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  headingWrap: { display: 'flex', minWidth: 0, flexGrow: 1, margin: 0 },
  headingButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    flexGrow: 1,
    paddingBlock: space[1],
    paddingInline: space[1],
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
    textAlign: 'start',
    cursor: 'pointer',
  },
  headingChevron: { flexShrink: 0, color: colors.secondaryLabel },
  count: { fontWeight: 400, color: colors.secondaryLabel },
  card: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingInlineEnd: space[3],
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    boxShadow: { default: 'none', ':not(:first-child)': `inset 0 0.5px 0 ${colors.separator}` },
  },
  rowLink: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    flexGrow: 1,
    minWidth: 0,
    paddingBlock: space[3],
    paddingInlineStart: space[3],
    color: colors.label,
    textDecoration: 'none',
  },
  taskNumber: {
    marginInlineEnd: space[1.5],
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
  },
  headingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minHeight: 28,
  },
  rowText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flexGrow: 1 },
  rowTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
  },
  rowMeta: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  mark: { display: 'flex', width: '14px', flexShrink: 0, justifyContent: 'center' },
  empty: {
    margin: 0,
    paddingInline: space[1],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
});

const BUCKET_LABELS: Record<ProjectBoardBucket, [key: string, fallback: string]> = {
  needsYou: ['projectMode.board.needsYou', 'Needs you'],
  working: ['projectMode.board.working', 'In progress'],
  review: ['projectMode.board.review', 'To review'],
  accepted: ['projectMode.board.accepted', 'Accepted'],
};

const DEFAULT_COLLAPSED_BUCKETS: Record<ProjectBoardBucket, boolean> = {
  needsYou: false,
  working: false,
  review: false,
  accepted: true,
};

/** `T3` for a coordinator task; manual conversations have no number. */
export const formatTaskNumber = (taskNumber: number | null): string | null =>
  taskNumber === null ? null : `T${taskNumber}`;

/**
 * Accepting records the time on the task's own metadata, then archives the
 * task (the owner's choice): an accepted task is finished, so its conversation
 * and worktree are released like any archived conversation.
 */
export function useAcceptCoordinatorTasks(): (sessionIds: readonly string[]) => void {
  const { updateSessionMetadata, archiveSession } = useSessionActions();
  const { t } = useTranslation();
  return useCallback(
    (sessionIds) => {
      const acceptedAt = getServerNow();
      void Promise.all(
        sessionIds.map(async (id) => {
          await updateSessionMetadata(id as SessionId, { coordinatorTaskAcceptedAt: acceptedAt });
          await archiveSession(id as SessionId);
        })
      ).catch(() => {
        toast.error(t('projectMode.board.acceptFailed', 'Could not accept the task'));
      });
    },
    [archiveSession, t, updateSessionMetadata]
  );
}

function useProjectBoardDataInternal(
  coordinatorSessionId: string | null,
  project: CoordinatorProjectKey | null,
  includeArchived: boolean
): ProjectBoardData {
  const { allActiveSessions } = useVisibleSessionMetas();
  const { currentUserId } = useMySessionScope();
  const presenceStates = useAtomValue(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue(lodyPresenceNowMsAtom);
  const sendStates = useAtomValue(sessionSendStatesAtom);
  const allSessionsIncludingArchived = useAtomValue(allSessionsIncludingArchivedAtom);

  const liveRef = useRef<Map<string, SessionStatus> | null>(null);
  const liveSessionStatuses = useMemo(() => {
    const next = new Map<string, SessionStatus>();
    for (const session of allActiveSessions) {
      const status = findFreshSessionPresenceState(
        presenceStates,
        session.id,
        presenceNowMs
      )?.status;
      if (status) next.set(session.id, status);
    }
    const previous = liveRef.current;
    if (
      previous &&
      previous.size === next.size &&
      [...next].every(([id, status]) => previous.get(id)?.type === status.type)
    ) {
      return previous;
    }
    liveRef.current = next;
    return next;
  }, [allActiveSessions, presenceNowMs, presenceStates]);

  const childSessionsByParent = useMemo(
    () => buildChildSessionsByParent(allSessionsIncludingArchived),
    [allSessionsIncludingArchived]
  );
  const board = useMemo(
    () =>
      buildProjectBoard({
        sessions: allSessionsIncludingArchived,
        childSessionsByParent,
        project,
        coordinatorSessionId:
          coordinatorSessionId ??
          (project
            ? (findProjectCoordinatorSession(allActiveSessions, project, currentUserId)?.id ?? null)
            : null),
        currentUserId,
        liveSessionStatuses,
        sendStates,
        numberingSessions: allSessionsIncludingArchived,
        includeArchived,
      }),
    [
      allActiveSessions,
      childSessionsByParent,
      coordinatorSessionId,
      currentUserId,
      includeArchived,
      liveSessionStatuses,
      project,
      sendStates,
      allSessionsIncludingArchived,
    ]
  );

  return board;
}

/**
 * Tasks for the project's right-hand board, including accepted (archived) tasks
 * so the `Accepted` group retains them while collapsed by default.
 */
export function useProjectBoardData(
  coordinatorSessionId: string | null,
  project: CoordinatorProjectKey | null
): ProjectBoardData {
  return useProjectBoardDataInternal(coordinatorSessionId, project, false);
}

/**
 * Every task of a coordinator, archived (accepted) ones included, so history
 * change strips in the coordinator conversation keep titles, numbers and state.
 */
export function useCoordinatorTasksData(
  coordinatorSessionId: string | null,
  project: CoordinatorProjectKey | null
): ReadonlyMap<string, ProjectBoardRow> {
  const board = useProjectBoardDataInternal(coordinatorSessionId, project, true);
  return useMemo(() => {
    const tasks = new Map<string, ProjectBoardRow>();
    for (const rows of Object.values(board)) {
      for (const row of rows) tasks.set(row.session.id, row);
    }
    return tasks;
  }, [board]);
}

/**
 * The right-hand column of a project: every conversation its coordinator
 * opened, plus the project's other conversations, by what they need from the
 * user. A leaf of the page, so the presence clock re-renders only this column.
 */
export function ProjectBoard({
  coordinatorSessionId,
  project,
  onOpenSession,
  onOpenPr,
  hideTitle = false,
}: {
  coordinatorSessionId: string | null;
  project: CoordinatorProjectKey | null;
  /** Opens a row in place (the coordinator's right panel); defaults to the conversation's page. */
  onOpenSession?: (sessionId: string) => void;
  /** Opens a row's associated PR as a right-panel tab; falls back to opening the PR URL. */
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  /** Inside the side panel the tab already names the board. */
  hideTitle?: boolean;
}) {
  const board = useProjectBoardData(coordinatorSessionId, project);

  const router = useRouter();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const getSessionHref = useCallback(
    (sessionId: string) =>
      router.buildLocation({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug ?? '', sessionId },
      }).href,
    [router, workspaceSlug]
  );
  const openSession = useCallback(
    (sessionId: string) => {
      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug ?? '', sessionId },
      });
    },
    [router, workspaceSlug]
  );
  const acceptTasks = useAcceptCoordinatorTasks();
  const boardKey = coordinatorSessionId ?? (project ? coordinatorProjectKeyId(project) : 'board');
  return (
    <ProjectBoardView
      key={boardKey}
      board={board}
      getSessionHref={getSessionHref}
      onOpenSession={onOpenSession ?? openSession}
      onOpenPr={onOpenPr}
      onAcceptTasks={acceptTasks}
      hideTitle={hideTitle}
    />
  );
}

/** The board's presentation, without data or routing. */
export function ProjectBoardView({
  board,
  getSessionHref,
  onOpenSession,
  onOpenPr,
  onAcceptTasks,
  hideTitle = false,
}: {
  board: ProjectBoardData;
  getSessionHref: (sessionId: string) => string;
  onOpenSession: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  /** Marks finished tasks as reviewed; omitted where accepting is not offered. */
  onAcceptTasks?: (sessionIds: readonly string[]) => void;
  hideTitle?: boolean;
}) {
  const { t } = useTranslation();
  const [collapsedByBucket, setCollapsedByBucket] =
    useState<Record<ProjectBoardBucket, boolean>>(DEFAULT_COLLAPSED_BUCKETS);
  const toggleBucket = useCallback((bucket: ProjectBoardBucket) => {
    setCollapsedByBucket((current) => ({ ...current, [bucket]: !current[bucket] }));
  }, []);

  return (
    <aside {...stylex.props(styles.column)} data-testid="project-board">
      {hideTitle ? null : (
        <h2 {...stylex.props(styles.title)}>{t('projectMode.board.title', 'All conversations')}</h2>
      )}
      {PROJECT_BOARD_BUCKETS.map((bucket) => {
        const rows = board[bucket];
        if ((bucket === 'working' || bucket === 'accepted') && rows.length === 0) return null;
        const [key, fallback] = BUCKET_LABELS[bucket];
        const collapsed = collapsedByBucket[bucket];
        const Chevron = collapsed ? ChevronRight : ChevronDown;
        return (
          <section
            key={bucket}
            {...stylex.props(styles.section)}
            data-project-board-bucket={bucket}
          >
            <div {...stylex.props(styles.headingRow)}>
              <h3 {...stylex.props(styles.headingWrap)}>
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  data-project-board-bucket-toggle={bucket}
                  onClick={() => toggleBucket(bucket)}
                  {...stylex.props(styles.headingButton)}
                >
                  <Chevron size={14} aria-hidden="true" {...stylex.props(styles.headingChevron)} />
                  <span>{t(key, fallback)}</span>
                  {rows.length > 0 ? (
                    <span {...stylex.props(styles.count)}>{rows.length}</span>
                  ) : null}
                </button>
              </h3>
              {bucket === 'review' && onAcceptTasks && rows.length > 1 ? (
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => onAcceptTasks(rows.map((row) => row.session.id))}
                >
                  {t('projectMode.board.acceptAll', 'Accept all')}
                </Button>
              ) : null}
            </div>
            {collapsed ? null : rows.length > 0 ? (
              <div {...stylex.props(styles.card)}>
                {rows.map((row) => (
                  <ProjectBoardRowLink
                    key={row.session.id}
                    row={row}
                    href={getSessionHref(row.session.id)}
                    onOpen={onOpenSession}
                    onOpenPr={onOpenPr}
                    onAccept={onAcceptTasks}
                  />
                ))}
              </div>
            ) : (
              <p {...stylex.props(styles.empty)}>{t('projectMode.board.empty', 'Nothing here')}</p>
            )}
          </section>
        );
      })}
    </aside>
  );
}

const ProjectBoardRowLink = memo(function ProjectBoardRowLink({
  row,
  href,
  onOpen,
  onOpenPr,
  onAccept,
}: {
  row: ProjectBoardRow;
  href: string;
  onOpen: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  onAccept?: (sessionIds: readonly string[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onOpen(row.session.id);
  };
  const title = row.session.title?.trim() || t('sessions.untitled', 'Untitled session');
  const updated = new Date(row.latestMessageAt).toLocaleString(toIntlLocaleOrEn(i18n.language), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const taskLabel = formatTaskNumber(row.taskNumber);
  return (
    <div {...stylex.props(styles.row)} data-project-board-session-id={row.session.id}>
      <a href={href} onClick={handleClick} {...stylex.props(styles.rowLink)}>
        <span {...stylex.props(styles.mark)}>
          <SessionRowStatusIndicator
            isWaitingPermission={row.bucket === 'needsYou' && row.sendState !== 'failed'}
            isWorking={row.isWorking}
            hasUnreadMessages={row.bucket !== 'accepted' && row.hasUnreadMessages}
            sendState={row.sendState}
          />
        </span>
        <span {...stylex.props(styles.rowText)}>
          <span {...stylex.props(styles.rowTitle)}>
            {taskLabel ? <span {...stylex.props(styles.taskNumber)}>{taskLabel}</span> : null}
            {title}
          </span>
          <span {...stylex.props(styles.rowMeta)}>{updated}</span>
        </span>
        {row.createdManually ? (
          <Badge tone="neutral">{t('projectMode.board.createdManually', 'Created manually')}</Badge>
        ) : null}
      </a>
      {row.pullRequest ? (
        <ProjectBoardPrMenu
          sessionId={row.session.id}
          pr={row.pullRequest}
          onOpenPr={onOpenPr}
        />
      ) : null}
      {row.bucket === 'review' && onAccept ? (
        <Button size="small" variant="secondary" onClick={() => onAccept([row.session.id])}>
          {t('projectMode.board.accept', 'Accept')}
        </Button>
      ) : null}
    </div>
  );
});
