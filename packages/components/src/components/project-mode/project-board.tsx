import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { toast } from '@/lib/toast';
import {
  getServerNow,
  LODY_PRESENCE_TTL_MS,
  type SessionId,
  type SessionPullRequestView,
  type SessionStatus,
} from '@lody/shared';
import { useRouter } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  MessageSquare,
  Play,
  Sparkles,
  Users,
} from 'lucide-react';
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
  findProjectCoordinatorSession,
  PROJECT_BOARD_BUCKETS,
  type CoordinatorProjectKey,
  type ProjectBoard as ProjectBoardData,
  type ProjectBoardBucket,
  type ProjectBoardRow,
  type ProjectBoardSessionMember,
} from './project-board-model';
import { ProjectBoardPrStack } from './project-board-pr-stack';

const WARNING_SOFT = `color-mix(in oklab, transparent, ${colors.warning} 13%)`;
const WARNING_BORDER = `color-mix(in oklab, transparent, ${colors.warning} 38%)`;
const ACCENT_SOFT = `color-mix(in oklab, transparent, ${colors.accent} 12%)`;
const ACCENT_BORDER = `color-mix(in oklab, transparent, ${colors.accent} 36%)`;
const SUCCESS_SOFT = `color-mix(in oklab, transparent, ${colors.success} 13%)`;

const styles = stylex.create({
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    minWidth: 0,
    height: '100%',
    overflowY: 'auto',
    paddingBlock: space[3],
    paddingInline: space[3],
    backgroundColor: colors.secondaryBackground,
  },
  title: {
    margin: 0,
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  filterBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1],
  },
  filterPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 26,
    paddingInline: space[2],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: radius.full,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, color',
    transitionDuration: '120ms',
  },
  filterPillActive: {
    borderColor: ACCENT_BORDER,
    backgroundColor: ACCENT_SOFT,
    color: colors.accent,
    fontWeight: 600,
  },
  filterPillWarn: {
    borderColor: WARNING_BORDER,
    backgroundColor: WARNING_SOFT,
    color: colors.warning,
    fontWeight: 600,
  },
  filterCount: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: 11,
    opacity: 0.85,
  },
  section: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  headingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minHeight: 26,
  },
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
  count: { fontWeight: 400, color: colors.secondaryLabel, fontVariantNumeric: 'tabular-nums' },
  cardStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    minWidth: 0,
  },
  taskCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    minWidth: 0,
    paddingBlock: space[3],
    paddingInline: space[3],
    borderRadius: radius.large,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: '140ms',
  },
  taskCardNeedsYou: {
    borderColor: WARNING_BORDER,
  },
  taskCardWorking: {
    borderColor: ACCENT_BORDER,
  },
  taskCardAccepted: {
    opacity: 0.82,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    minWidth: 0,
  },
  statusMark: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 20,
    flexShrink: 0,
  },
  iconWarn: { color: colors.warning },
  iconAccent: { color: colors.accent },
  iconSuccess: { color: colors.success },
  headerMain: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
    flexGrow: 1,
  },
  titleLine: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[1.5],
    minWidth: 0,
  },
  titleTrigger: {
    display: 'inline',
    minWidth: 0,
    flexGrow: 1,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.label,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    textAlign: 'start',
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    wordBreak: 'break-word',
  },
  titleStatic: {
    minWidth: 0,
    flexGrow: 1,
    color: colors.label,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    wordBreak: 'break-word',
  },
  taskNumberBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 18,
    paddingInline: 5,
    borderRadius: radius.small,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
    fontSize: 11,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
    marginTop: 1,
  },
  metaLine: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  stageTag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    paddingBlock: 1,
    paddingInline: 6,
    borderRadius: radius.full,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
    fontSize: 11,
    fontWeight: 500,
  },
  stageTagWarn: {
    backgroundColor: WARNING_SOFT,
    color: colors.warning,
  },
  stageTagAccent: {
    backgroundColor: ACCENT_SOFT,
    color: colors.accent,
  },
  stageTagSuccess: {
    backgroundColor: SUCCESS_SOFT,
    color: colors.success,
  },
  expandBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.tertiaryLabel,
    cursor: 'pointer',
    flexShrink: 0,
  },
  pendingCallout: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[1.5],
    paddingBlock: space[1.5],
    paddingInline: space[2],
    borderRadius: radius.medium,
    backgroundColor: WARNING_SOFT,
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  pendingIcon: {
    color: colors.warning,
    flexShrink: 0,
    marginTop: 2,
  },
  progressText: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  progressTextExpanded: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  cardFooter: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minWidth: 0,
  },
  footerSignals: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    flex: '1 1 auto',
  },
  footerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
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
  expandedSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingTop: space[2],
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  summaryBlock: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  memberList: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    minWidth: 0,
  },
  memberRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minWidth: 0,
    paddingBlock: space[1],
    paddingInline: space[2],
    borderRadius: radius.medium,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
  },
  memberLink: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    flexGrow: 1,
    minWidth: 0,
    color: colors.label,
    textDecoration: 'none',
  },
  memberTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.label,
  },
  rolePill: {
    flexShrink: 0,
    paddingBlock: 1,
    paddingInline: 5,
    borderRadius: radius.small,
    backgroundColor: colors.elevatedBackground,
    color: colors.secondaryLabel,
    fontSize: 11,
  },
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

type BucketFilter = 'all' | ProjectBoardBucket;

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

  const liveStatuses = useMemo(() => {
    const map = new Map<string, SessionStatus>();
    const bestUpdatedAt = new Map<string, number>();
    for (const entry of Object.values(presenceStates)) {
      if (entry.kind !== 'session' || presenceNowMs - entry.updatedAt > LODY_PRESENCE_TTL_MS) {
        continue;
      }
      const prev = bestUpdatedAt.get(entry.sessionId);
      if (prev === undefined || entry.updatedAt > prev) {
        bestUpdatedAt.set(entry.sessionId, entry.updatedAt);
        map.set(entry.sessionId, entry.status);
      }
    }
    return map;
  }, [presenceNowMs, presenceStates]);

  const acceptedChildSessions = useMemo(
    () =>
      allSessionsIncludingArchived.filter(
        (session) =>
          session.isArchived === true &&
          (includeArchived || typeof session.coordinatorTaskAcceptedAt === 'number')
      ),
    [allSessionsIncludingArchived, includeArchived]
  );

  const boardSessions = useMemo(
    () =>
      acceptedChildSessions.length === 0
        ? allActiveSessions
        : [...allActiveSessions, ...acceptedChildSessions],
    [acceptedChildSessions, allActiveSessions]
  );

  const childSessionsByParent = useMemo(
    () => buildChildSessionsByParent(boardSessions),
    [boardSessions]
  );

  return useMemo(
    () =>
      buildProjectBoard({
        sessions: boardSessions,
        childSessionsByParent,
        project,
        coordinatorSessionId: resolvedCoordinatorSessionId,
        currentUserId,
        liveSessionStatuses: liveStatuses,
        sendStates,
        workItems: resolvedCoordinatorSessionId ? coordinatorDoc.workItems : undefined,
        numberingSessions: allSessionsIncludingArchived,
        includeArchived,
      }),
    [
      allSessionsIncludingArchived,
      boardSessions,
      childSessionsByParent,
      coordinatorDoc.workItems,
      currentUserId,
      includeArchived,
      liveStatuses,
      project,
      resolvedCoordinatorSessionId,
      sendStates,
    ]
  );
}

/** Board rows for a project, including accepted tasks so the Accepted section can list them. */
export function useProjectBoardData(
  coordinatorSessionId: string | null,
  project: CoordinatorProjectKey | null
): ProjectBoardData {
  return useProjectBoardDataInternal(coordinatorSessionId, project, false);
}

/**
 * Every task this coordinator opened, keyed by both `workItemId` and each member
 * `sessionId` (including accepted/archived ones), so conversation chips and
 * action cards share the board's exact numbers, titles, and states.
 */
export function useCoordinatorTasksData(
  coordinatorSessionId: string | null,
  project: CoordinatorProjectKey | null
): ReadonlyMap<string, ProjectBoardRow> {
  const board = useProjectBoardDataInternal(coordinatorSessionId, project, true);
  return useMemo(() => {
    const tasks = new Map<string, ProjectBoardRow>();
    for (const bucket of PROJECT_BOARD_BUCKETS) {
      for (const row of board[bucket]) {
        tasks.set(row.workItemId, row);
        for (const member of row.members) {
          tasks.set(member.session.id, row);
        }
      }
    }
    return tasks;
  }, [board]);
}

/** Right-side Task Card board for a project coordinator. */
export function ProjectBoard({
  coordinatorSessionId,
  project,
  onOpenSession,
  onOpenPr,
  onSendCoordinatorPrompt,
  onPrefillCoordinatorPrompt,
  hideTitle = false,
}: {
  coordinatorSessionId: string | null;
  project: CoordinatorProjectKey | null;
  onOpenSession?: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  onSendCoordinatorPrompt?: (prompt: string) => void;
  onPrefillCoordinatorPrompt?: (prompt: string) => void;
  hideTitle?: boolean;
}) {
  const router = useRouter();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const board = useProjectBoardData(coordinatorSessionId, project);
  const acceptTasks = useAcceptCoordinatorTasks();

  const handleOpen = useCallback(
    (sessionId: string) => {
      if (onOpenSession) {
        onOpenSession(sessionId);
        return;
      }
      if (!workspaceSlug) return;
      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId },
      });
    },
    [onOpenSession, router, workspaceSlug]
  );

  const getSessionHref = useCallback(
    (sessionId: string) =>
      router.buildLocation({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug ?? '', sessionId },
      }).href,
    [router, workspaceSlug]
  );

  return (
    <ProjectBoardView
      board={board}
      getSessionHref={getSessionHref}
      onOpenSession={handleOpen}
      onOpenPr={onOpenPr}
      onAcceptTasks={acceptTasks}
      onSendCoordinatorPrompt={onSendCoordinatorPrompt}
      onPrefillCoordinatorPrompt={onPrefillCoordinatorPrompt}
      hideTitle={hideTitle}
    />
  );
}

/** Pure presentation of the Task Card board — also mounted by Storybook. */
export function ProjectBoardView({
  board,
  getSessionHref,
  onOpenSession,
  onOpenPr,
  onAcceptTasks,
  onSendCoordinatorPrompt,
  onPrefillCoordinatorPrompt,
  hideTitle = false,
}: {
  board: ProjectBoardData;
  getSessionHref: (sessionId: string) => string;
  onOpenSession: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  /** Marks finished tasks as reviewed; omitted where accepting is not offered. */
  onAcceptTasks?: (sessionIds: readonly string[]) => void;
  onSendCoordinatorPrompt?: (prompt: string) => void;
  onPrefillCoordinatorPrompt?: (prompt: string) => void;
  hideTitle?: boolean;
}) {
  const { t } = useTranslation();
  const [activeFilter, setActiveFilter] = useState<BucketFilter>('all');
  const [collapsedByBucket, setCollapsedByBucket] =
    useState<Record<ProjectBoardBucket, boolean>>(DEFAULT_COLLAPSED_BUCKETS);
  const toggleBucket = useCallback((bucket: ProjectBoardBucket) => {
    setCollapsedByBucket((current) => ({ ...current, [bucket]: !current[bucket] }));
  }, []);

  const totalCount =
    board.needsYou.length + board.working.length + board.review.length + board.accepted.length;
  const visibleBuckets: readonly ProjectBoardBucket[] =
    activeFilter === 'all' ? PROJECT_BOARD_BUCKETS : [activeFilter];

  return (
    <aside {...stylex.props(styles.column)} data-testid="project-board">
      {hideTitle ? null : (
        <h2 {...stylex.props(styles.title)}>
          {t('projectMode.board.taskCardsTitle', 'Task cards')}
        </h2>
      )}

      {totalCount > 0 ? (
        <div {...stylex.props(styles.filterBar)} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeFilter === 'all'}
            onClick={() => setActiveFilter('all')}
            {...stylex.props(styles.filterPill, activeFilter === 'all' && styles.filterPillActive)}
          >
            <span>{t('projectMode.board.filterAll', 'All')}</span>
            <span {...stylex.props(styles.filterCount)}>{totalCount}</span>
          </button>
          {PROJECT_BOARD_BUCKETS.map((bucket) => {
            const count = board[bucket].length;
            if (count === 0 && activeFilter !== bucket) return null;
            const [key, fallback] = BUCKET_LABELS[bucket];
            const isSelected = activeFilter === bucket;
            return (
              <button
                key={bucket}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => setActiveFilter(bucket)}
                {...stylex.props(
                  styles.filterPill,
                  isSelected &&
                    (bucket === 'needsYou' ? styles.filterPillWarn : styles.filterPillActive),
                  !isSelected && bucket === 'needsYou' && count > 0 && styles.filterPillWarn
                )}
              >
                <span>{t(key, fallback)}</span>
                <span {...stylex.props(styles.filterCount)}>{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {visibleBuckets.map((bucket) => {
        const rows = board[bucket];
        if (
          activeFilter === 'all' &&
          (bucket === 'working' || bucket === 'accepted') &&
          rows.length === 0
        ) {
          return null;
        }
        const [key, fallback] = BUCKET_LABELS[bucket];
        const collapsed = activeFilter === 'all' ? collapsedByBucket[bucket] : false;
        const Chevron = collapsed ? ChevronRight : ChevronDown;
        const acceptableSessionIds = rows.flatMap((row) =>
          row.members.map((member) => member.session.id)
        );
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
              {bucket === 'review' && onAcceptTasks && acceptableSessionIds.length > 1 ? (
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => onAcceptTasks(acceptableSessionIds)}
                >
                  {t('projectMode.board.acceptAll', 'Accept all')}
                </Button>
              ) : null}
            </div>
            {collapsed ? null : rows.length > 0 ? (
              <div {...stylex.props(styles.cardStack)}>
                {rows.map((row) => (
                  <ProjectTaskCard
                    key={row.workItemId}
                    row={row}
                    getSessionHref={getSessionHref}
                    onOpenSession={onOpenSession}
                    onOpenPr={onOpenPr}
                    onAcceptTasks={onAcceptTasks}
                    onSendCoordinatorPrompt={onSendCoordinatorPrompt}
                    onPrefillCoordinatorPrompt={onPrefillCoordinatorPrompt}
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

const ProjectTaskCard = memo(function ProjectTaskCard({
  row,
  getSessionHref,
  onOpenSession,
  onOpenPr,
  onAcceptTasks,
  onSendCoordinatorPrompt,
  onPrefillCoordinatorPrompt,
}: {
  row: ProjectBoardRow;
  getSessionHref: (sessionId: string) => string;
  onOpenSession: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
  onAcceptTasks?: (sessionIds: readonly string[]) => void;
  onSendCoordinatorPrompt?: (prompt: string) => void;
  onPrefillCoordinatorPrompt?: (prompt: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const title =
    row.workItemTitle?.trim() ||
    row.session?.title?.trim() ||
    t('sessions.untitled', 'Untitled task');
  const taskTag = formatTaskNumber(row.taskNumber);
  const taskLabel = taskTag ? `${taskTag} ${title}` : title;
  const formattedTime = useFormattedTaskTime(row.latestMessageAt, i18n.language);

  const hasExpandableDetails =
    Boolean(row.summary) ||
    Boolean(row.progressNote) ||
    row.members.length > 1 ||
    row.externalRefs.length > 0;

  const isProposed = row.stage === 'proposed';
  const primarySessionId = row.session?.id ?? null;

  const taskRefLabel = `${taskLabel} [workItemId=${row.workItemId}]`;

  const handleConfirmStart = () => {
    onSendCoordinatorPrompt?.(
      t('projectMode.board.confirmStartPrompt', 'Confirm and start {{task}}.', {
        task: taskRefLabel,
      })
    );
  };

  const handleAdjust = () => {
    onPrefillCoordinatorPrompt?.(
      t('projectMode.board.adjustPromptPrefix', 'About {{task}}: ', {
        task: taskRefLabel,
      })
    );
  };

  const handleCompleteStandalone = () => {
    onSendCoordinatorPrompt?.(
      t('projectMode.board.completeStandalonePrompt', 'Mark {{task}} as done.', {
        task: taskRefLabel,
      })
    );
  };

  const handleOpenPrimary = () => {
    if (primarySessionId) {
      onOpenSession(primarySessionId);
      return;
    }
    setExpanded((prev) => !prev);
  };

  const ExpandChevron = expanded ? ChevronDown : ChevronRight;

  return (
    <article
      data-project-task-card={row.workItemId}
      data-project-board-session-id={primarySessionId ?? undefined}
      {...stylex.props(
        styles.taskCard,
        row.bucket === 'needsYou' && styles.taskCardNeedsYou,
        row.bucket === 'working' && styles.taskCardWorking,
        row.bucket === 'accepted' && styles.taskCardAccepted
      )}
    >
      <div {...stylex.props(styles.cardHeader)}>
        <span {...stylex.props(styles.statusMark)}>
          {row.isStandalone ? (
            row.bucket === 'accepted' ? (
              <CheckCircle2 size={14} aria-hidden="true" {...stylex.props(styles.iconSuccess)} />
            ) : row.bucket === 'needsYou' ? (
              <Sparkles size={14} aria-hidden="true" {...stylex.props(styles.iconWarn)} />
            ) : (
              <Check size={14} aria-hidden="true" {...stylex.props(styles.iconAccent)} />
            )
          ) : (
            <SessionRowStatusIndicator
              isWorking={row.isWorking}
              isWaitingPermission={row.isWaitingPermission}
              hasUnreadMessages={row.hasUnreadMessages}
              sendState={row.sendState}
            />
          )}
        </span>

        <div {...stylex.props(styles.headerMain)}>
          <div {...stylex.props(styles.titleLine)}>
            {taskTag ? <span {...stylex.props(styles.taskNumberBadge)}>{taskTag}</span> : null}
            {primarySessionId ? (
              <button
                type="button"
                onClick={handleOpenPrimary}
                {...stylex.props(styles.titleTrigger)}
              >
                {title}
              </button>
            ) : (
              <span
                onClick={() => setExpanded((prev) => !prev)}
                {...stylex.props(styles.titleStatic)}
              >
                {title}
              </span>
            )}
          </div>

          <div {...stylex.props(styles.metaLine)}>
            {isProposed ? (
              <span {...stylex.props(styles.stageTag, styles.stageTagWarn)}>
                {t('projectMode.board.stageProposed', 'Pending confirmation')}
              </span>
            ) : row.stage === 'blocked' ? (
              <span {...stylex.props(styles.stageTag, styles.stageTagWarn)}>
                {t('projectMode.board.stageBlocked', 'Needs decision')}
              </span>
            ) : null}
            {row.collaborationMode === 'direct' ? (
              <Badge tone="neutral">{t('projectMode.board.directMode', 'Direct')}</Badge>
            ) : null}
            {row.members.length > 1 ? (
              <span {...stylex.props(styles.stageTag)}>
                <Users size={10} aria-hidden="true" />
                {t('projectMode.board.memberCount', '{{count}} sessions', {
                  count: row.members.length,
                })}
              </span>
            ) : null}
            {formattedTime ? <span>{formattedTime}</span> : null}
          </div>
        </div>

        {hasExpandableDetails ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t('projectMode.board.collapseCard', 'Collapse card details')
                : t('projectMode.board.expandCard', 'Expand card details')
            }
            onClick={() => setExpanded((prev) => !prev)}
            {...stylex.props(styles.expandBtn)}
          >
            <ExpandChevron size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {row.pendingAction ? (
        <div {...stylex.props(styles.pendingCallout)}>
          <AlertCircle size={13} aria-hidden="true" {...stylex.props(styles.pendingIcon)} />
          <span>{row.pendingAction}</span>
        </div>
      ) : null}

      {row.progressNote ? (
        <p {...stylex.props(expanded ? styles.progressTextExpanded : styles.progressText)}>
          {row.progressNote}
        </p>
      ) : !expanded && row.summary ? (
        <p {...stylex.props(styles.progressText)}>{row.summary}</p>
      ) : null}

      <div {...stylex.props(styles.cardFooter)}>
        <div {...stylex.props(styles.footerSignals)}>
          <ProjectBoardPrStack row={row} onOpenPr={onOpenPr} />
          {!expanded && row.externalRefs.length > 0
            ? row.externalRefs.slice(0, 2).map((ref) => (
                <a
                  key={ref.uri}
                  href={ref.uri}
                  target="_blank"
                  rel="noreferrer"
                  title={`${ref.kind}: ${ref.label ?? ref.uri}`}
                  {...stylex.props(styles.externalRefPill)}
                >
                  <span>{ref.label ?? ref.kind}</span>
                  <ExternalLink size={10} aria-hidden="true" />
                </a>
              ))
            : null}
        </div>

        <div {...stylex.props(styles.footerActions)}>
          {isProposed && onSendCoordinatorPrompt ? (
            <>
              {onPrefillCoordinatorPrompt ? (
                <Button size="small" variant="ghost" onClick={handleAdjust}>
                  {t('projectMode.board.adjustTask', 'Adjust')}
                </Button>
              ) : null}
              <Button size="small" variant="primary" onClick={handleConfirmStart}>
                <Play size={11} aria-hidden="true" />
                {t('projectMode.board.confirmStart', 'Confirm & start')}
              </Button>
            </>
          ) : null}

          {!isProposed && row.bucket === 'review' ? (
            row.members.length > 0 && onAcceptTasks ? (
              <Button
                size="small"
                variant="secondary"
                onClick={() => onAcceptTasks(row.members.map((member) => member.session.id))}
              >
                {t('projectMode.board.accept', 'Accept')}
              </Button>
            ) : row.isStandalone && onSendCoordinatorPrompt ? (
              <Button size="small" variant="secondary" onClick={handleCompleteStandalone}>
                {t('projectMode.board.markDone', 'Done')}
              </Button>
            ) : null
          ) : null}

          {primarySessionId && row.bucket !== 'review' && !isProposed ? (
            <Button size="small" variant="ghost" onClick={handleOpenPrimary}>
              <MessageSquare size={11} aria-hidden="true" />
              {t('projectMode.board.openConversation', 'Open')}
            </Button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div {...stylex.props(styles.expandedSection)}>
          {row.summary ? <p {...stylex.props(styles.summaryBlock)}>{row.summary}</p> : null}
          {row.externalRefs.length > 0 ? (
            <div {...stylex.props(styles.footerSignals)}>
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
                  <ExternalLink size={10} aria-hidden="true" />
                </a>
              ))}
            </div>
          ) : null}
          {row.members.length > 0 ? (
            <div {...stylex.props(styles.memberList)}>
              {row.members.map((member) => (
                <ProjectBoardMemberRow
                  key={member.session.id}
                  member={member}
                  href={getSessionHref(member.session.id)}
                  onOpen={onOpenSession}
                  onOpenPr={onOpenPr}
                />
              ))}
            </div>
          ) : null}
          {onPrefillCoordinatorPrompt ? (
            <div {...stylex.props(styles.footerActions)}>
              <Button size="small" variant="ghost" onClick={handleAdjust}>
                {t('projectMode.board.askCoordinator', 'Follow up with coordinator')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

const ProjectBoardMemberRow = memo(function ProjectBoardMemberRow({
  member,
  href,
  onOpen,
  onOpenPr,
}: {
  member: ProjectBoardSessionMember;
  href: string;
  onOpen: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
}) {
  const { t } = useTranslation();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onOpen(member.session.id);
  };
  const title = member.session.title?.trim() || t('sessions.untitled', 'Untitled session');
  return (
    <div {...stylex.props(styles.memberRow)} data-project-board-member-id={member.session.id}>
      <a href={href} onClick={handleClick} {...stylex.props(styles.memberLink)}>
        <span {...stylex.props(styles.statusMark)}>
          <SessionRowStatusIndicator
            isWorking={member.isWorking}
            isWaitingPermission={member.isWaitingPermission}
            hasUnreadMessages={member.hasUnreadMessages}
            sendState={member.sendState}
          />
        </span>
        {member.role ? <span {...stylex.props(styles.rolePill)}>{member.role}</span> : null}
        <span {...stylex.props(styles.memberTitle)}>{title}</span>
      </a>
      {member.pullRequests.length > 0 ? (
        <ProjectBoardPrStack
          row={{
            session: member.session,
            members: [member],
            pullRequests: member.pullRequests,
          }}
          onOpenPr={onOpenPr}
        />
      ) : null}
    </div>
  );
});

function useFormattedTaskTime(latestMessageAt: number, language: string): string {
  const nowRef = useRef<number>(0);
  if (nowRef.current === 0) nowRef.current = Date.now();
  return useMemo(() => {
    if (latestMessageAt <= 0) return '';
    const date = new Date(latestMessageAt);
    const sameYear = date.getFullYear() === new Date(nowRef.current).getFullYear();
    return new Intl.DateTimeFormat(toIntlLocaleOrEn(language), {
      ...(sameYear ? {} : { year: 'numeric' }),
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }, [language, latestMessageAt]);
}
