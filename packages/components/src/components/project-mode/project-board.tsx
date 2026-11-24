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
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
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
import { useSessionDoc } from '@/hooks/use-session-doc';
import {
  buildProjectBoard,
  coordinatorProjectKeyId,
  findProjectCoordinatorSession,
  hasMultiplePullRequestRepos,
  PROJECT_BOARD_BUCKETS,
  resolveOwnerSessionForPullRequest,
  type CoordinatorProjectKey,
  type ProjectBoard as ProjectBoardData,
  type ProjectBoardBucket,
  type ProjectBoardRow,
  type ProjectBoardSessionMember,
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
  groupWrapper: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    boxShadow: { default: 'none', ':not(:first-child)': `inset 0 0.5px 0 ${colors.separator}` },
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
  groupHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingInlineEnd: space[3],
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
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
  groupHeaderButton: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    flexGrow: 1,
    minWidth: 0,
    paddingBlock: space[3],
    paddingInlineStart: space[3],
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.label,
    textAlign: 'start',
    cursor: 'pointer',
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
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  prStack: {
    display: 'inline-flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space[1],
    flexShrink: 0,
  },
  externalRefPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    paddingBlock: 2,
    paddingInline: space[1.5],
    borderRadius: radius.full,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    textDecoration: 'none',
    flexShrink: 0,
  },
  memberList: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: space[1.5],
  },
  memberRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingInlineStart: space[6],
    paddingInlineEnd: space[3],
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
  },
  memberLink: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    flexGrow: 1,
    minWidth: 0,
    paddingBlock: space[1.5],
    paddingInlineStart: space[2],
    color: colors.label,
    textDecoration: 'none',
  },
  memberTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.label,
  },
  rolePill: {
    flexShrink: 0,
    paddingBlock: 1,
    paddingInline: space[1.5],
    borderRadius: radius.small,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
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

const EMPTY_SESSION_ID = '' as SessionId;

/** `T3` for a coordinator task; manual conversations have no number. */
export const formatTaskNumber = (taskNumber: number | null): string | null =>
  taskNumber === null ? null : `T${taskNumber}`;

/**
 * Accepting records the time on each member conversation's metadata, then
 * archives the conversations: an accepted work item is finished, so its
 * conversations and worktrees are released like any archived conversation.
 */
export function useAcceptCoordinatorTasks(): (sessionIds: readonly string[]) => void {
  const { updateSessionMetadata, archiveSession } = useSessionActions();
  const { t } = useTranslation();
  return useCallback(
    (sessionIds) => {
      const acceptedAt = getServerNow();
      const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
      if (uniqueIds.length === 0) return;
      void Promise.all(
        uniqueIds.map(async (id) => {
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

  const resolvedCoordinatorSessionId = useMemo(
    () =>
      coordinatorSessionId ??
      (project
        ? (findProjectCoordinatorSession(allActiveSessions, project, currentUserId)?.id ?? null)
        : null),
    [allActiveSessions, coordinatorSessionId, currentUserId, project]
  );

  const { doc: coordinatorDoc } = useSessionDoc(
    (resolvedCoordinatorSessionId as SessionId | null) ?? EMPTY_SESSION_ID,
    {
      enabled: Boolean(resolvedCoordinatorSessionId),
      syncEnabled: false,
    }
  );

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
        coordinatorSessionId: resolvedCoordinatorSessionId,
        currentUserId,
        liveSessionStatuses,
        sendStates,
        workItems: resolvedCoordinatorSessionId ? coordinatorDoc.workItems : undefined,
        numberingSessions: allSessionsIncludingArchived,
        includeArchived,
      }),
    [
      allSessionsIncludingArchived,
      childSessionsByParent,
      coordinatorDoc.workItems,
      currentUserId,
      includeArchived,
      liveSessionStatuses,
      project,
      resolvedCoordinatorSessionId,
      sendStates,
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
 * Every work item of a coordinator, archived (accepted) ones included, indexed
 * by both `workItemId` and every member `session.id` so history strips, threads,
 * and cards resolve any member reference to its owning `T<n>` group.
 */
export function useCoordinatorTasksData(
  coordinatorSessionId: string | null,
  project: CoordinatorProjectKey | null
): ReadonlyMap<string, ProjectBoardRow> {
  const board = useProjectBoardDataInternal(coordinatorSessionId, project, true);
  return useMemo(() => {
    const tasks = new Map<string, ProjectBoardRow>();
    for (const rows of Object.values(board)) {
      for (const row of rows) {
        tasks.set(row.workItemId, row);
        for (const member of row.members) {
          tasks.set(member.session.id, row);
        }
      }
    }
    return tasks;
  }, [board]);
}

export function ProjectBoard({
  coordinatorSessionId,
  project,
  onOpenSession,
  onOpenPr,
  hideTitle = false,
}: {
  coordinatorSessionId: string | null;
  project: CoordinatorProjectKey | null;
  onOpenSession?: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
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
                  onClick={() =>
                    onAcceptTasks(
                      rows.flatMap((row) => row.members.map((member) => member.session.id))
                    )
                  }
                >
                  {t('projectMode.board.acceptAll', 'Accept all')}
                </Button>
              ) : null}
            </div>
            {collapsed ? null : rows.length > 0 ? (
              <div {...stylex.props(styles.card)}>
                {rows.map((row) =>
                  row.members.length > 1 ? (
                    <ProjectBoardGroupRow
                      key={row.workItemId}
                      row={row}
                      getSessionHref={getSessionHref}
                      onOpen={onOpenSession}
                      onOpenPr={onOpenPr}
                      onAccept={onAcceptTasks}
                    />
                  ) : (
                    <ProjectBoardRowLink
                      key={row.workItemId}
                      row={row}
                      href={getSessionHref(row.session.id)}
                      onOpen={onOpenSession}
                      onOpenPr={onOpenPr}
                      onAccept={onAcceptTasks}
                    />
                  )
                )}
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

function RowPullRequestList({
  row,
  onOpenPr,
}: {
  row: ProjectBoardRow;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
}) {
  if (row.pullRequests.length === 0 && row.externalRefs.length === 0) return null;
  const showRepo = hasMultiplePullRequestRepos(row.pullRequests);
  return (
    <div {...stylex.props(styles.prStack)}>
      {row.externalRefs.map((ref) => (
        <a
          key={ref.uri}
          href={ref.uri}
          target="_blank"
          rel="noreferrer"
          title={`${ref.kind}: ${ref.label ?? ref.uri}`}
          {...stylex.props(styles.externalRefPill)}
        >
          <span>{ref.label ?? ref.kind}</span>
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      ))}
      {row.pullRequests.map((pr) => (
        <ProjectBoardPrMenu
          key={pr.url}
          sessionId={resolveOwnerSessionForPullRequest(row, pr.url)}
          pr={pr}
          showRepoPrefix={showRepo}
          onOpenPr={onOpenPr}
        />
      ))}
    </div>
  );
}

const ProjectBoardGroupRow = memo(function ProjectBoardGroupRow({
  row,
  getSessionHref,
  onOpen,
  onOpenPr,
  onAccept,
}: {
  row: ProjectBoardRow;
  getSessionHref: (sessionId: string) => string;
  onOpen: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  onAccept?: (sessionIds: readonly string[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(row.bucket !== 'accepted');
  const title =
    row.workItemTitle?.trim() ||
    row.session.title?.trim() ||
    t('sessions.untitled', 'Untitled session');
  const updated = new Date(row.latestMessageAt).toLocaleString(toIntlLocaleOrEn(i18n.language), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const taskLabel = formatTaskNumber(row.taskNumber);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div {...stylex.props(styles.groupWrapper)} data-project-board-work-item-id={row.workItemId}>
      <div {...stylex.props(styles.groupHeaderRow)}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          {...stylex.props(styles.groupHeaderButton)}
        >
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
            <span {...stylex.props(styles.rowMeta)}>
              <Chevron size={12} aria-hidden="true" />
              <span>
                {t('projectMode.board.memberCount', '{{count}} sessions', {
                  count: row.members.length,
                })}
              </span>
              {row.collaborationMode === 'direct' ? (
                <>
                  <span>·</span>
                  <span>{t('projectMode.board.directMode', 'Direct')}</span>
                </>
              ) : null}
              <span>·</span>
              <span>{updated}</span>
            </span>
          </span>
        </button>
        <RowPullRequestList row={row} onOpenPr={onOpenPr} />
        {row.bucket === 'review' && onAccept ? (
          <Button
            size="small"
            variant="secondary"
            onClick={() => onAccept(row.members.map((member) => member.session.id))}
          >
            {t('projectMode.board.accept', 'Accept')}
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div {...stylex.props(styles.memberList)}>
          {row.members.map((member) => (
            <ProjectBoardMemberRow
              key={member.session.id}
              member={member}
              href={getSessionHref(member.session.id)}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
});

const ProjectBoardMemberRow = memo(function ProjectBoardMemberRow({
  member,
  href,
  onOpen,
}: {
  member: ProjectBoardSessionMember;
  href: string;
  onOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onOpen(member.session.id);
  };
  const title = member.session.title?.trim() || t('sessions.untitled', 'Untitled session');
  return (
    <div {...stylex.props(styles.memberRow)} data-project-board-session-id={member.session.id}>
      <a href={href} onClick={handleClick} {...stylex.props(styles.memberLink)}>
        <span {...stylex.props(styles.mark)}>
          <SessionRowStatusIndicator
            isWaitingPermission={member.bucket === 'needsYou' && member.sendState !== 'failed'}
            isWorking={member.isWorking}
            hasUnreadMessages={member.bucket !== 'accepted' && member.hasUnreadMessages}
            sendState={member.sendState}
          />
        </span>
        {member.role ? <span {...stylex.props(styles.rolePill)}>{member.role}</span> : null}
        <span {...stylex.props(styles.memberTitle)}>{title}</span>
      </a>
    </div>
  );
});

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
  const title =
    row.workItemTitle?.trim() ||
    row.session.title?.trim() ||
    t('sessions.untitled', 'Untitled session');
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
        {row.collaborationMode === 'direct' ? (
          <Badge tone="neutral">{t('projectMode.board.directMode', 'Direct')}</Badge>
        ) : null}
        {row.createdManually ? (
          <Badge tone="neutral">{t('projectMode.board.createdManually', 'Created manually')}</Badge>
        ) : null}
      </a>
      <RowPullRequestList row={row} onOpenPr={onOpenPr} />
      {row.bucket === 'review' && onAccept ? (
        <Button size="small" variant="secondary" onClick={() => onAccept([row.session.id])}>
          {t('projectMode.board.accept', 'Accept')}
        </Button>
      ) : null}
    </div>
  );
});
