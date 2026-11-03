import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  PanelLeft,
  Plus,
  SendHorizontal,
} from 'lucide-react';
import type { SessionId, WorkspaceProject } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { navigationSidebarVisibleAtom, showNavigationSidebarAtom } from '@/atoms/layout-state';
import { sidebarCollapsedAtom } from '@/atoms/sidebar-state';
import { sessionSendStatesAtom } from '@/atoms/session-send-status';
import type { SessionSendState } from '@/lib/session-send-status';
import type { SessionListRow } from '@/components/session-list';
import { SessionRowStatusIndicator } from '@/components/sidebar-row-shared';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  classifyProjectHubRow,
  PROJECT_HUB_BUCKETS,
  type ProjectHubBucket,
  useWorkspaceSessionRows,
} from '@/hooks/use-project-session-rows';
import { useWorkspaceProjects } from '@/hooks/use-workspace-projects';
import { isMacOSElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { isNativeAppShell } from '@/lib/native-platform';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { withClassName } from '@/lib/stylex';
import {
  WINDOW_DRAG_EXEMPT_CLASS,
  useMacTrafficLightRowPadClass,
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
  header: {
    boxSizing: 'border-box',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    columnGap: space[2],
    height: '52px',
    paddingInline: space[4],
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  headerBesideTrafficLights: { paddingLeft: '100px' },
  glyph: { width: '16px', height: '16px' },
  title: {
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
    color: colors.label,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  subtitle: {
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
    whiteSpace: 'nowrap',
  },
  badge: {
    marginInlineStart: 'auto',
    paddingInline: space[2],
    paddingBlock: 2,
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.trayBackground,
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    whiteSpace: 'nowrap',
  },
  body: {
    display: 'flex',
    flexGrow: 1,
    minHeight: 0,
  },
  bodyStacked: { flexDirection: 'column', overflowY: 'auto' },
  // Left: the coordinator conversation.
  main: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
  },
  feed: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingInline: space[6],
    paddingBlock: space[6],
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
  },
  feedInner: {
    width: '100%',
    maxWidth: '720px',
    marginInline: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
  },
  message: {
    display: 'flex',
    gap: space[3],
    alignItems: 'flex-start',
  },
  avatar: {
    flexShrink: 0,
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: colors.trayBackground,
    color: colors.label,
  },
  bubble: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    minWidth: 0,
    color: colors.label,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
  },
  author: {
    fontSize: text.footnoteSize,
    fontWeight: 600,
    color: colors.secondaryLabel,
  },
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    textAlign: 'start',
    paddingInline: space[3],
    paddingBlock: space[2],
    borderWidth: 0,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: { default: colors.raisedBackground, ':hover': colors.hoverFill },
    boxShadow: shadow.raised,
    color: colors.label,
    cursor: 'pointer',
  },
  noticeText: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  noticeMeta: { color: colors.secondaryLabel, fontSize: text.footnoteSize, flexShrink: 0 },
  composerWrap: {
    flexShrink: 0,
    paddingInline: space[6],
    paddingBottom: space[4],
  },
  composer: {
    maxWidth: '720px',
    marginInline: 'auto',
    display: 'flex',
    alignItems: 'flex-end',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
  },
  composerInput: {
    flexGrow: 1,
    minHeight: '44px',
    resize: 'none',
    borderWidth: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
  },
  composerHint: {
    maxWidth: '720px',
    marginInline: 'auto',
    paddingTop: space[1.5],
    fontSize: text.captionSize,
    color: colors.tertiaryLabel,
  },
  // Right: the sub-conversation board.
  panel: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: '360px',
    minHeight: 0,
    borderLeftWidth: 1,
    borderLeftStyle: 'solid',
    borderLeftColor: colors.separator,
    backgroundColor: colors.secondaryBackground,
  },
  panelStacked: {
    width: '100%',
    borderLeftWidth: 0,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[4],
    paddingTop: space[3],
    paddingBottom: space[2],
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
    borderWidth: 0,
    backgroundColor: 'transparent',
    cursor: 'pointer',
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
  },
  pr: { display: 'inline-flex', alignItems: 'center', gap: 2 },
  prMerged: { color: 'hsl(var(--primary))' },
  bubbleGrow: { flexGrow: 1 },
  emptyBoard: {
    paddingInline: space[2],
    paddingBlock: space[6],
    textAlign: 'center',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  missing: {
    margin: 'auto',
    padding: space[6],
    color: colors.secondaryLabel,
  },
});

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

export function ProjectHubWorkspace({
  workspaceName,
  projectId,
}: {
  workspaceName: string;
  projectId: string;
}) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { projects } = useWorkspaceProjects();
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const { rows } = useWorkspaceSessionRows();
  const sendStates = useAtomValue(sessionSendStatesAtom);
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

  // Entering a project hands the whole window to it: the navigation sidebar
  // folds once per project entered, and the header's toggle brings it back.
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const collapsedForProject = useRef<string | null>(null);
  useEffect(() => {
    if (isMobile || collapsedForProject.current === projectId) return;
    collapsedForProject.current = projectId;
    setSidebarCollapsed(true);
  }, [isMobile, projectId, setSidebarCollapsed]);

  const openSession = (sessionId: string) =>
    void navigate({
      to: '/$workspaceName/sessions/$sessionId',
      params: { workspaceName, sessionId: sessionId as SessionId },
    });
  const startSubConversation = () =>
    void navigate({
      to: '/$workspaceName/chat',
      params: { workspaceName },
      search: { context: 'group' as const, group: projectId },
    });

  return (
    <ProjectHubView
      project={project}
      rows={projectRows}
      stacked={isMobile}
      onOpenSession={openSession}
      onNewSubConversation={startSubConversation}
    />
  );
}

/** The hub without data wiring: what the route renders and Storybook shows. */
export function ProjectHubView({
  project,
  rows,
  stacked = false,
  onOpenSession,
  onNewSubConversation,
}: {
  project: WorkspaceProject | null;
  rows: SessionListRow[];
  stacked?: boolean;
  onOpenSession: (sessionId: string) => void;
  onNewSubConversation: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.page)} data-testid="project-hub">
      <ProjectHubHeader project={project} rowCount={rows.length} />
      {project ? (
        <div {...stylex.props(styles.body, stacked && styles.bodyStacked)}>
          <CoordinatorPane project={project} rows={rows} onOpenSession={onOpenSession} />
          <SubConversationBoard
            rows={rows}
            stacked={stacked}
            onOpenSession={onOpenSession}
            onNew={onNewSubConversation}
          />
        </div>
      ) : (
        <p {...stylex.props(styles.missing)}>
          {t('projectHub.missing', 'This project no longer exists or is still syncing.')}
        </p>
      )}
    </div>
  );
}

function ProjectHubHeader({
  project,
  rowCount,
}: {
  project: WorkspaceProject | null;
  rowCount: number;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const sidebarHidden = !useAtomValue(navigationSidebarVisibleAtom);
  const showNavigationSidebar = useSetAtom(showNavigationSidebarAtom);
  const isElectronFullscreen = useElectronFullscreen();
  const windowDrag = useWindowDragRegionClass();
  const windowsCaptionPadClass = useWindowsCaptionPadClass();
  const macTrafficLightRowPadClass = useMacTrafficLightRowPadClass({
    insideWorkspaceFrame: true,
    includeDesktopWeb: !isMobile,
  });
  const windowsCaptionRowPadClass = useWindowsCaptionRowPadClass();
  const showSidebarToggle = !isMobile && sidebarHidden;
  const besideTrafficLights =
    showSidebarToggle && !isNativeAppShell() && isMacOSElectronRenderer() && !isElectronFullscreen;
  const chrome = [
    windowDrag,
    windowsCaptionPadClass,
    windowsCaptionRowPadClass,
    macTrafficLightRowPadClass,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <header
      {...withClassName(
        stylex.props(styles.header, besideTrafficLights && styles.headerBesideTrafficLights),
        chrome
      )}
    >
      {showSidebarToggle ? (
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon
          onClick={() => showNavigationSidebar()}
          aria-label={t('sessions.leftSidebar.show', 'Show navigation sidebar')}
          className={WINDOW_DRAG_EXEMPT_CLASS}
        >
          <PanelLeft {...stylex.props(styles.glyph)} />
        </Button>
      ) : null}
      <span {...stylex.props(styles.title)}>{project?.name ?? ''}</span>
      {project ? (
        <span {...stylex.props(styles.subtitle)}>
          {project.members.length > 1
            ? t('projectHub.sidebar.members', '{{count}} repositories', {
                count: project.members.length,
              })
            : t('projectHub.sidebar.single', 'Single repository')}
          {' · '}
          {t('projectHub.sidebar.conversations', { count: rowCount })}
        </span>
      ) : null}
      <span {...stylex.props(styles.badge)}>{t('projectHub.prototype', 'Prototype')}</span>
    </header>
  );
}

/**
 * The project's one assistant. The Harness Agent is not wired yet: this pane
 * shows the shape — its introduction, then the notices it would post when a
 * sub-conversation needs the user or finishes — derived from live rows.
 */
function CoordinatorPane({
  project,
  rows,
  onOpenSession,
}: {
  project: WorkspaceProject;
  rows: SessionListRow[];
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const relative = useRelativeTime();
  const [draft, setDraft] = useState('');
  const notices = useMemo(
    () =>
      rows
        .map((row) => ({ row, bucket: classifyProjectHubRow(row) }))
        .filter(({ bucket }) => bucket === 'needsYou' || bucket === 'done')
        .sort(
          (left, right) =>
            new Date(right.row.latestMessageAt).getTime() -
            new Date(left.row.latestMessageAt).getTime()
        ),
    [rows]
  );
  const coordinatorName = t('projectHub.coordinator.name', 'Project coordinator');
  return (
    <section {...stylex.props(styles.main)} aria-label={coordinatorName}>
      <div {...stylex.props(styles.feed)}>
        <div {...stylex.props(styles.feedInner)}>
          <div {...stylex.props(styles.message)}>
            <span {...stylex.props(styles.avatar)}>
              <Bot className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div {...stylex.props(styles.bubble)}>
              <span {...stylex.props(styles.author)}>{coordinatorName}</span>
              <span>
                {t(
                  'projectHub.coordinator.intro',
                  "I'm the coordinator for {{name}}. Tell me what you need; I'll start sub-conversations to do the work, watch them, and only bring you what needs your attention.",
                  { name: project.name }
                )}
              </span>
            </div>
          </div>
          {notices.map(({ row, bucket }) => (
            <div key={row.sessionId} {...stylex.props(styles.message)}>
              <span {...stylex.props(styles.avatar)}>
                <Bot className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <div {...stylex.props(styles.bubble, styles.bubbleGrow)}>
                <span {...stylex.props(styles.author)}>{coordinatorName}</span>
                <span>
                  {bucket === 'needsYou'
                    ? t('projectHub.coordinator.needsYou', 'A sub-conversation needs your input:')
                    : t('projectHub.coordinator.done', 'A sub-conversation finished its run:')}
                </span>
                <button
                  type="button"
                  onClick={() => onOpenSession(row.sessionId)}
                  {...stylex.props(styles.notice)}
                >
                  <SessionRowStatusIndicator
                    isWaitingPermission={row.isWaitingPermission}
                    isWorking={row.isWorking}
                    hasUnreadMessages={row.hasUnreadMessages}
                  />
                  <span {...stylex.props(styles.noticeText)}>{row.title}</span>
                  <span {...stylex.props(styles.noticeMeta)}>{relative(row.latestMessageAt)}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div {...stylex.props(styles.composerWrap)}>
        <div {...stylex.props(styles.composer)}>
          <textarea
            {...stylex.props(styles.composerInput)}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('projectHub.coordinator.placeholder', 'Ask the coordinator…')}
            aria-label={t('projectHub.coordinator.placeholder', 'Ask the coordinator…')}
            rows={2}
          />
          <Button
            type="button"
            variant="primary"
            size="small"
            icon
            disabled
            aria-label={t('projectHub.coordinator.send', 'Send')}
          >
            <SendHorizontal className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </div>
        <p {...stylex.props(styles.composerHint)}>
          {t(
            'projectHub.coordinator.pending',
            'Prototype: the coordinator agent is not connected yet.'
          )}
        </p>
      </div>
    </section>
  );
}

const SubConversationRow = memo(function SubConversationRow({
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

function SubConversationBoard({
  rows,
  stacked,
  onOpenSession,
  onNew,
}: {
  rows: SessionListRow[];
  stacked: boolean;
  onOpenSession: (sessionId: string) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Partial<Record<ProjectHubBucket, boolean>>>({
    idle: true,
  });
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
  return (
    <aside
      {...stylex.props(styles.panel, stacked && styles.panelStacked)}
      aria-label={t('projectHub.board.title', 'Sub-conversations')}
    >
      <div {...stylex.props(styles.panelHeader)}>
        <span {...stylex.props(styles.panelTitle)}>
          {t('projectHub.board.title', 'Sub-conversations')}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="mini"
          icon
          aria-label={t('projectHub.board.new', 'New sub-conversation')}
          onClick={onNew}
        >
          <Plus className="h-4 w-4" strokeWidth={1.5} />
        </Button>
      </div>
      <div {...stylex.props(styles.panelBody)}>
        {rows.length === 0 ? (
          <p {...stylex.props(styles.emptyBoard)}>
            {t(
              'projectHub.board.empty',
              'No sub-conversations yet. The coordinator will start them as work comes in.'
            )}
          </p>
        ) : (
          PROJECT_HUB_BUCKETS.map((bucket) => {
            const bucketRows = grouped[bucket];
            if (bucketRows.length === 0) return null;
            const isCollapsed = collapsed[bucket] ?? false;
            return (
              <section key={bucket} {...stylex.props(styles.group)} data-bucket={bucket}>
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((prev) => ({ ...prev, [bucket]: !isCollapsed }))}
                  {...stylex.props(
                    styles.groupHeader,
                    bucket === 'needsYou' && styles.groupHeaderNeedsYou
                  )}
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3 w-3" strokeWidth={2} />
                  ) : (
                    <ChevronDown className="h-3 w-3" strokeWidth={2} />
                  )}
                  {labels[bucket]}
                  <span {...stylex.props(styles.groupCount)}>{bucketRows.length}</span>
                </button>
                {isCollapsed ? null : (
                  <div {...stylex.props(styles.card)}>
                    {bucketRows.map((row, index) => (
                      <SubConversationRow
                        key={row.sessionId}
                        row={row}
                        ruled={index > 0}
                        onOpen={onOpenSession}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}
