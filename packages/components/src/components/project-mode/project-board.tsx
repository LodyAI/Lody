import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Badge } from '@lody/ui/badge';
import { findFreshSessionPresenceState, type SessionStatus } from '@lody/shared';
import { useRouter } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { memo, useCallback, useMemo, useRef, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import { sessionSendStatesAtom } from '@/atoms/session-send-status';
import { SessionRowStatusIndicator } from '@/components/sidebar-row-shared';
import { buildChildSessionsByParent } from '@/components/sessions/session-list-rows';
import { useMySessionScope, useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import {
  buildProjectBoard,
  PROJECT_BOARD_BUCKETS,
  type CoordinatorProjectKey,
  type ProjectBoard as ProjectBoardData,
  type ProjectBoardBucket,
  type ProjectBoardRow,
} from './project-board-model';

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
  heading: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[2],
    margin: 0,
    paddingInline: space[1],
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
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
    gap: space[3],
    minWidth: 0,
    paddingBlock: space[3],
    paddingInline: space[3],
    color: colors.label,
    textDecoration: 'none',
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    // Ruled rows: the separator sits between rows, never around the card.
    boxShadow: { default: 'none', ':not(:first-child)': `inset 0 0.5px 0 ${colors.separator}` },
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
  unread: ['projectMode.board.unread', 'Unread'],
  done: ['projectMode.board.done', 'Done'],
};

/**
 * The right-hand column of a project: every conversation its coordinator
 * opened, plus the project's other conversations, by what they need from the
 * user. A leaf of the page, so the presence clock re-renders only this column.
 */
export function ProjectBoard({
  coordinatorSessionId,
  project,
}: {
  coordinatorSessionId: string | null;
  project: CoordinatorProjectKey | null;
}) {
  const { allActiveSessions } = useVisibleSessionMetas();
  const { currentUserId } = useMySessionScope();
  const presenceStates = useAtomValue(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue(lodyPresenceNowMsAtom);
  const sendStates = useAtomValue(sessionSendStatesAtom);

  // Rebuilt on each presence tick; keep the previous map while no status changed.
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
    () => buildChildSessionsByParent(allActiveSessions),
    [allActiveSessions]
  );
  const board = useMemo(
    () =>
      buildProjectBoard({
        sessions: allActiveSessions,
        childSessionsByParent,
        project,
        coordinatorSessionId,
        currentUserId,
        liveSessionStatuses,
        sendStates,
      }),
    [
      allActiveSessions,
      childSessionsByParent,
      coordinatorSessionId,
      currentUserId,
      liveSessionStatuses,
      project,
      sendStates,
    ]
  );

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
  return (
    <ProjectBoardView board={board} getSessionHref={getSessionHref} onOpenSession={openSession} />
  );
}

/** The board's presentation, without data or routing. */
export function ProjectBoardView({
  board,
  getSessionHref,
  onOpenSession,
}: {
  board: ProjectBoardData;
  getSessionHref: (sessionId: string) => string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <aside {...stylex.props(styles.column)} data-testid="project-board">
      <h2 {...stylex.props(styles.title)}>{t('projectMode.board.title', 'All conversations')}</h2>
      {PROJECT_BOARD_BUCKETS.map((bucket) => {
        const rows = board[bucket];
        // "In progress" is not one of the three columns the user watches; it shows only when busy.
        if (bucket === 'working' && rows.length === 0) return null;
        const [key, fallback] = BUCKET_LABELS[bucket];
        return (
          <section
            key={bucket}
            {...stylex.props(styles.section)}
            data-project-board-bucket={bucket}
          >
            <h3 {...stylex.props(styles.heading)}>
              {t(key, fallback)}
              {rows.length > 0 ? <span {...stylex.props(styles.count)}>{rows.length}</span> : null}
            </h3>
            {rows.length > 0 ? (
              <div {...stylex.props(styles.card)}>
                {rows.map((row) => (
                  <ProjectBoardRowLink
                    key={row.session.id}
                    row={row}
                    href={getSessionHref(row.session.id)}
                    onOpen={onOpenSession}
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
}: {
  row: ProjectBoardRow;
  href: string;
  onOpen: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Modified clicks keep the browser's own behaviour (new tab or window).
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
  return (
    <a
      href={href}
      onClick={handleClick}
      {...stylex.props(styles.row)}
      data-project-board-session-id={row.session.id}
    >
      <span {...stylex.props(styles.mark)}>
        <SessionRowStatusIndicator
          // A pending question waits on the user exactly like a permission request.
          isWaitingPermission={row.bucket === 'needsYou' && row.sendState !== 'failed'}
          isWorking={row.isWorking}
          hasUnreadMessages={row.hasUnreadMessages}
          sendState={row.sendState}
        />
      </span>
      <span {...stylex.props(styles.rowText)}>
        <span {...stylex.props(styles.rowTitle)}>{title}</span>
        <span {...stylex.props(styles.rowMeta)}>{updated}</span>
      </span>
      {row.createdManually ? (
        <Badge tone="neutral">{t('projectMode.board.createdManually', 'Created manually')}</Badge>
      ) : null}
    </a>
  );
});
