import { memo, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { GitPullRequest, MessagesSquare, Plus } from 'lucide-react';
import type { SessionId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { projectHubCoordinatorsAtom } from '@/atoms/project-hub';
import { sessionSendStatesAtom } from '@/atoms/session-send-status';
import { AppThemeShell } from '@/components/app-theme-shell';
import { ChatLanding } from '@/components/chat/chat-landing';
import type { SessionListRow } from '@/components/session-list';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import SessionDetail from '@/components/sessions/session-detail';
import { SessionRowStatusIndicator } from '@/components/sidebar-row-shared';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  classifyProjectHubRow,
  PROJECT_HUB_BUCKETS,
  type ProjectHubBucket,
  useWorkspaceSessionRows,
} from '@/hooks/use-project-session-rows';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import type { SessionSendState } from '@/lib/session-send-status';
import { withClassName } from '@/lib/stylex';
import {
  WINDOW_DRAG_EXEMPT_CLASS,
  useWindowDragRegionClass,
  useWindowsCaptionPadClass,
  useWindowsCaptionRowPadClass,
} from '@/ui/window-drag-region';

const styles = stylex.create({
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    backgroundColor: colors.background,
  },
  landing: { height: '100%', minHeight: 0 },
  // The Threads panel, in the conversation page's side panel shell (same
  // hairline, same 44px header as its tab bar).
  panel: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'hsl(var(--border) / 0.7)',
    backgroundColor: colors.secondaryBackground,
  },
  panelStacked: { borderLeftWidth: 0 },
  panelHeader: {
    boxSizing: 'border-box',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
    height: '44px',
    paddingInlineStart: space[4],
    paddingInlineEnd: space[2],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border) / 0.5)',
  },
  panelTitle: {
    fontSize: text.subheadlineSize,
    fontWeight: 600,
    color: colors.label,
    marginInlineEnd: 'auto',
  },
  panelBody: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingTop: space[3],
    paddingInline: space[3],
    paddingBottom: space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
  },
  group: { display: 'flex', flexDirection: 'column', gap: space[1.5] },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    paddingInline: space[1],
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    fontWeight: 600,
  },
  groupHeaderNeedsYou: { color: 'hsl(var(--primary))' },
  groupCount: { fontWeight: 400, color: colors.tertiaryLabel },
  card: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: colors.raisedBackground,
    boxShadow: shadow.raised,
    overflow: 'hidden',
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    width: '100%',
    textAlign: 'start',
    paddingInline: space[3],
    paddingBlock: space[2],
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.label,
    cursor: 'pointer',
  },
  rowRuled: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  rowLine: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  rowTitle: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  rowMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.secondaryLabel,
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  },
  pr: { display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 },
  prMerged: { color: 'hsl(var(--primary))' },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[2],
    marginBlock: 'auto',
    paddingInline: space[4],
    paddingBottom: space[8],
    textAlign: 'center',
  },
  emptyIcon: {
    width: '40px',
    height: '40px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: colors.trayBackground,
    color: colors.secondaryLabel,
  },
  emptyTitle: {
    fontSize: text.subheadlineSize,
    fontWeight: 600,
    color: colors.label,
  },
  emptyBody: {
    maxWidth: '260px',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
});

const noop = () => {};

/** Short relative time in the product language ("3 min ago", "3 分钟前"). */
function useRelativeTime() {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const format = new Intl.RelativeTimeFormat(toIntlLocaleOrEn(i18n.resolvedLanguage), {
      numeric: 'auto',
      style: 'short',
    });
    return (value: Date | number | string) => {
      const ms = new Date(value).getTime();
      if (!Number.isFinite(ms)) return '';
      const minutes = Math.round((ms - Date.now()) / 60_000);
      if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
      const hours = Math.round(minutes / 60);
      if (Math.abs(hours) < 24) return format.format(hours, 'hour');
      return format.format(Math.round(hours / 24), 'day');
    };
  }, [i18n.resolvedLanguage]);
}

/**
 * A project's page. The project's coordinator ("main conversation") is an
 * ordinary Session in the project, shown with the conversation page itself;
 * its side panel is replaced by Threads, the project's other Sessions. Before
 * the coordinator exists, the conversation column is the new-chat composer
 * scoped to the project, and its first message creates the coordinator.
 *
 * Prototype: which Session is the coordinator is remembered on this device.
 */
export function ProjectHubWorkspace({
  workspaceName,
  projectId,
}: {
  workspaceName: string;
  projectId: string;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { rows, loading } = useWorkspaceSessionRows();
  const sendStates = useAtomValue(sessionSendStatesAtom);
  const [coordinators, setCoordinators] = useAtom(projectHubCoordinatorsAtom);
  const [startedHere, setStartedHere] = useState<string | null>(null);

  const storedCoordinatorId = coordinators[projectId] ?? null;
  const projectRows = useMemo(
    () =>
      rows
        .filter((row) => row.projectGroup?.id === projectId)
        .map((row) => {
          const sendState = sendStates[row.sessionId];
          return sendState ? { ...row, sendState } : row;
        }),
    [projectId, rows, sendStates]
  );
  // A remembered coordinator that is no longer listed (archived, deleted)
  // stops being one once the list has loaded; one started on this page is
  // trusted until its row arrives.
  const coordinatorId =
    storedCoordinatorId &&
    (loading ||
      startedHere === storedCoordinatorId ||
      projectRows.some((row) => row.sessionId === storedCoordinatorId))
      ? storedCoordinatorId
      : null;
  const threads = useMemo(
    () => projectRows.filter((row) => row.sessionId !== coordinatorId),
    [coordinatorId, projectRows]
  );

  const openSession = (sessionId: string) =>
    void navigate({
      to: '/$workspaceName/sessions/$sessionId',
      params: { workspaceName, sessionId: sessionId as SessionId },
    });
  const startThread = () =>
    void navigate({
      to: '/$workspaceName/chat',
      params: { workspaceName },
      search: { context: 'group' as const, group: projectId },
    });
  const handleCoordinatorStarted = (sessionId: SessionId) => {
    setStartedHere(sessionId);
    setCoordinators((prev) => ({ ...prev, [projectId]: sessionId }));
  };

  const threadsPanel = (
    <ThreadsPanel
      rows={threads}
      stacked={isMobile}
      onOpenSession={openSession}
      onNew={startThread}
    />
  );

  if (isMobile) {
    return (
      <div {...stylex.props(styles.page)} data-testid="project-hub">
        {threadsPanel}
      </div>
    );
  }
  if (coordinatorId) {
    return (
      <AppThemeShell>
        <SessionDetail
          key={coordinatorId}
          sessionId={coordinatorId as SessionId}
          sidePanelOverride={threadsPanel}
        />
      </AppThemeShell>
    );
  }
  return (
    <div {...stylex.props(styles.page)} data-testid="project-hub">
      <DesktopSessionDetailLayout
        defaultSizes={{ main: 70, sidebar: 30 }}
        topBar={null}
        chatSurfaces={
          <div
            {...stylex.props(styles.landing)}
            aria-label={t('projectHub.coordinator.name', 'Project coordinator')}
          >
            <ChatLanding
              workspaceSlug={workspaceName}
              preSelectedContext="group"
              preSelectedGroup={projectId}
              onSessionStarted={handleCoordinatorStarted}
            />
          </div>
        }
        terminalDock={null}
        secondaryPanel={threadsPanel}
        sidebarOpen
        onSidebarCollapse={noop}
        deleteConfirmDialog={null}
      />
    </div>
  );
}


const ThreadRow = memo(function ThreadRow({
  row,
  ruled,
  onOpen,
}: {
  row: SessionListRow & { sendState?: SessionSendState };
  ruled: boolean;
  onOpen: (sessionId: string) => void;
}) {
  const relative = useRelativeTime();
  const pr = row.prNumber ?? null;
  return (
    <button
      type="button"
      data-session-id={row.sessionId}
      onClick={() => onOpen(row.sessionId)}
      {...stylex.props(styles.row, ruled && styles.rowRuled)}
    >
      <span {...stylex.props(styles.rowLine)}>
        <span {...stylex.props(styles.rowTitle)}>{row.title}</span>
        <SessionRowStatusIndicator
          isWaitingPermission={row.isWaitingPermission}
          isWorking={row.isWorking}
          hasUnreadMessages={row.hasUnreadMessages}
          sendState={row.sendState ?? null}
        />
      </span>
      <span {...stylex.props(styles.rowMeta)}>
        {pr ? (
          <span {...stylex.props(styles.pr, row.prStatus === 'merged' && styles.prMerged)}>
            <GitPullRequest className="h-3 w-3" strokeWidth={1.75} />#{pr}
          </span>
        ) : null}
        {row.branchName ? <span>{row.branchName}</span> : null}
        <span>{relative(row.latestMessageAt)}</span>
      </span>
    </button>
  );
});

/**
 * Threads: every Session the project runs besides its coordinator, always
 * shown in full, most urgent first — what needs the user, then what is
 * running, what finished unread, and what is idle; newest first within each.
 */
export function ThreadsPanel({
  rows,
  stacked = false,
  onOpenSession,
  onNew,
}: {
  rows: (SessionListRow & { sendState?: SessionSendState })[];
  stacked?: boolean;
  onOpenSession: (sessionId: string) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const windowDrag = useWindowDragRegionClass();
  const windowsCaptionPadClass = useWindowsCaptionPadClass();
  const windowsCaptionRowPadClass = useWindowsCaptionRowPadClass({ bottomBorder: true });
  // The panel header sits at the window's top edge like the side panel tab
  // bar: it drags the window and clears the Windows caption buttons.
  const headerChrome = stacked
    ? ''
    : [windowDrag, windowsCaptionPadClass, windowsCaptionRowPadClass].filter(Boolean).join(' ');
  const grouped = useMemo(() => {
    const result: Record<ProjectHubBucket, SessionListRow[]> = {
      needsYou: [],
      running: [],
      done: [],
      idle: [],
    };
    for (const row of rows) result[classifyProjectHubRow(row)].push(row);
    for (const bucket of PROJECT_HUB_BUCKETS) {
      result[bucket].sort(
        (left, right) =>
          new Date(right.latestMessageAt).getTime() - new Date(left.latestMessageAt).getTime()
      );
    }
    return result;
  }, [rows]);
  const labels: Record<ProjectHubBucket, string> = {
    needsYou: t('projectHub.bucket.needsYou', 'Needs you'),
    running: t('projectHub.bucket.running', 'Running'),
    done: t('projectHub.bucket.done', 'Finished'),
    idle: t('projectHub.bucket.idle', 'Idle'),
  };
  const title = t('projectHub.board.title', 'Threads');
  const newLabel = t('projectHub.board.new', 'New thread');
  return (
    <aside
      {...stylex.props(styles.panel, stacked && styles.panelStacked)}
      aria-label={title}
      data-testid="project-hub-threads"
    >
      <div {...withClassName(stylex.props(styles.panelHeader), headerChrome)}>
        <span {...stylex.props(styles.panelTitle)}>{title}</span>
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon
          aria-label={newLabel}
          onClick={onNew}
          className={WINDOW_DRAG_EXEMPT_CLASS}
        >
          <Plus className="h-4 w-4" strokeWidth={1.5} />
        </Button>
      </div>
      <div {...stylex.props(styles.panelBody)}>
        {rows.length === 0 ? (
          <div {...stylex.props(styles.empty)}>
            <span {...stylex.props(styles.emptyIcon)}>
              <MessagesSquare className="h-5 w-5" strokeWidth={1.5} />
            </span>
            <span {...stylex.props(styles.emptyTitle)}>
              {t('projectHub.board.emptyTitle', 'No threads yet')}
            </span>
            <span {...stylex.props(styles.emptyBody)}>
              {t(
                'projectHub.board.empty',
                'Tell the main conversation what to do; it starts threads to carry out the work. Threads that need you are listed first.'
              )}
            </span>
            <Button type="button" variant="secondary" size="small" onClick={onNew}>
              {newLabel}
            </Button>
          </div>
        ) : (
          PROJECT_HUB_BUCKETS.map((bucket) => {
            const bucketRows = grouped[bucket];
            if (bucketRows.length === 0) return null;
            return (
              <section key={bucket} {...stylex.props(styles.group)} data-bucket={bucket}>
                <h3
                  {...stylex.props(
                    styles.groupHeader,
                    bucket === 'needsYou' && styles.groupHeaderNeedsYou
                  )}
                >
                  {labels[bucket]}
                  <span {...stylex.props(styles.groupCount)}>{bucketRows.length}</span>
                </h3>
                <div {...stylex.props(styles.card)}>
                  {bucketRows.map((row, index) => (
                    <ThreadRow
                      key={row.sessionId}
                      row={row}
                      ruled={index > 0}
                      onOpen={onOpenSession}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}
