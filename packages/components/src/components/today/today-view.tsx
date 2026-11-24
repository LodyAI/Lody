import { duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import * as stylex from '@stylexjs/stylex';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Copy,
  Maximize2,
  MessageSquarePlus,
  MoreHorizontal,
  PictureInPicture2,
  Pin,
  Square,
  SquareCheck,
  Trash2,
  Type,
} from 'lucide-react';
import { formatKeyBinding, isMac } from '@/lib/commands';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { todayFullWidthAtom } from '@/atoms/sidebar-state';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  TODAY_MENTION_CHAR,
  buildTodayLink,
  getSessionRoomId,
  getTodayDocId,
  parseTodayDate,
  readTodayText,
  type SessionId,
  type TodayDate,
  type TodayRichText,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Popover } from '@lody/ui/popover';
import { Toggle } from '@lody/ui/toggle';
import { Tooltip } from '@lody/ui/tooltip';
import { userAtom } from '@/atoms';
import { navigationSidebarVisibleAtom, showNavigationSidebarAtom } from '@/atoms/layout-state';
import { isElectronRenderer, isMacOSElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { openTodayWindow } from '@/lib/desktop-window';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { isNativeAppShell } from '@/lib/native-platform';
import { withClassName } from '@/lib/stylex';
import {
  WINDOW_DRAG_EXEMPT_CLASS,
  useMacTrafficLightRowPadClass,
  useWindowDragRegionClass,
  useWindowsCaptionPadClass,
  useWindowsCaptionRowPadClass,
} from '@/ui/window-drag-region';
import { SidebarHistoryControls } from '../sidebar-history-controls';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { runtimeAtom } from '@/atoms/runtime';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useWorkspaceMembers } from '@/hooks/use-workspace-members';
import { UserAvatar } from '../user-avatar';
import { writeTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/lib/toast';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { openSessionDeepLink } from '@/lib/session-deep-link';
import {
  hasAcceptableSessionMentionTransfer,
  readSessionMentionDragSessionId,
  registerSessionMentionPointerTarget,
} from '@/lib/session-mention-drag';
import { useTodayEditor } from './editor/today-editor-context';
import { TodayEditorContext } from './editor/today-editor-context';
import { TodayEditorController } from './editor/today-editor-controller';
import { TodayLiveSessionPicker } from './today-mention-picker';
import { TodayMembersContext } from './today-members';
import { TodayDaySection } from './today-day-section';
import { TodayMoreAtEndContext, todayOutline, todaySurfaceMarker } from './outline.stylex';
import { TodayConvertDialog } from './today-convert-dialog';
import { TodaySelectionBar } from './today-selection-bar';
import { TodayMentionStatusMenuHost } from './today-mention-status-menu';
import { buildConvertPrompt, todayMentionMarkdown } from './editor/block-selection';
import type { TodayPageStore } from '@/lib/today/today-page-store';
import type { TodayNodeId } from '@lody/shared';
import { buildDayStream, localTodayDate, todayDateToLocalDate } from './today-stream';
import { TodayBreadcrumb, type TodayCrumb } from './today-breadcrumb';
import { useTodayClock } from './use-today-clock';

/**
 * What a Today surface shows: a member's stream around `date`, or with
 * `focus` only that day (`'day'`) or one node of it (its id).
 */
export type TodayViewTarget = { member?: string; date?: string; focus?: string };

/** Opens a conversation a mention points at; the host decides where it shows. */
export type TodayOpenSession = (target: { sessionId: SessionId; workspaceId: string }) => void;

/** Default max width of the Today page's text column, in px. */
export const TODAY_READABLE_WIDTH = 720;

const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  },
  toolbar: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
    paddingInline: space[4],
  },
  /* Page or pinned column, the toolbar is the window-top row: the session tab
     bar's 44px, so its controls line up with every other page's header. */
  windowRowToolbar: { boxSizing: 'border-box', height: '2.75rem' },
  // Clears the macOS traffic lights while the navigation sidebar is hidden.
  toolbarBesideTrafficLights: { paddingLeft: '96px' },
  // The card's rim puts the row 1px below the 4px frame step the macOS row
  // padding assumes; without this the controls centre at y=24, a pixel under
  // the traffic lights and the sidebar header's controls at y=23.
  toolbarOnTrafficLightLine: { marginTop: -1 },
  controls: { display: 'flex', alignItems: 'center', gap: space[1] },
  pinIcon: {
    transform: 'rotate(0deg)',
    transitionProperty: {
      default: 'transform',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  pinUnpinned: {
    transform: 'rotate(45deg)',
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: text.subheadlineSize,
    color: colors.secondaryLabel,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  scroller: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    // The fold toggles hang left of the text: keep a full gutter beside them too.
    paddingInlineStart: `calc(${space[6]} + ${todayOutline.foldOverhang})`,
    paddingInlineEnd: space[6],
    paddingBottom: space[8],
    boxShadow: { ':focus-visible': 'none' },
  },
  // The pinned column is narrow: a tighter end gutter.
  scrollerPinned: { paddingInlineEnd: space[4] },
  // Pinned with the sidebar hidden, the column is the window's leftmost
  // surface and lines up with the macOS close button (x 16–30): the bullet
  // dots centre on its right edge (x=30), which puts the fold toggles' centre
  // on its left edge (x=16). The text column starts at the dot's left edge
  // (30 - 3); the card's content edge starts 5px in (4px of window ground plus
  // the rim, as laid out).
  scrollerAtWindowEdge: {
    paddingInlineStart: 'calc(30px - 3px - 5px)',
  },
  // The readable column (Obsidian 700px, Notion ~708px, AFFiNE ~752px of
  // text): centred, shrinking with the window inside the scroller's gutters.
  // The scroller stays full width, so its scrollbar, drops and clicks beside
  // the column keep working.
  column: { maxWidth: TODAY_READABLE_WIDTH, marginInline: 'auto' },
  back: {
    position: 'absolute',
    insetInline: 0,
    bottom: space[4],
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  backButton: { pointerEvents: 'auto' },
  calendar: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    padding: space[2],
    width: 252,
  },
  calendarHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: text.subheadlineSize,
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 },
  weekday: { fontSize: text.captionSize, color: colors.tertiaryLabel, textAlign: 'center' },
  day: {
    position: 'relative',
    height: 30,
    borderRadius: radius.small,
    borderWidth: 0,
    background: 'none',
    color: colors.label,
    fontSize: text.footnoteSize,
    cursor: 'pointer',
    ':hover': { backgroundColor: colors.hoverFill },
  },
  dayOutside: { color: colors.tertiaryLabel },
  dayToday: { color: colors.accent, fontWeight: 600 },
  dayMark: {
    position: 'absolute',
    bottom: 3,
    left: '50%',
    width: 4,
    height: 4,
    marginLeft: -2,
    borderRadius: radius.full,
    backgroundColor: colors.secondaryLabel,
  },
});

/**
 * The Today day stream for one member. Behavior: specs/today-outline.md.
 * Navigation is the host's: the full page writes the route search, the pinned
 * column keeps its own state.
 */
export function TodayView(props: {
  target: TodayViewTarget;
  onNavigate: (target: TodayViewTarget) => void;
  /**
   * Rendered as the pinned column (vs the full page). In the standalone window
   * it is instead whether the window stays above all others.
   */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Rendered as the desktop's standalone Today window. */
  standalone?: boolean;
  onOpenSession?: TodayOpenSession;
}) {
  const { t, i18n } = useTranslation();
  const scope = useResolvedWorkspaceScope();
  const activeRuntime = useAtomValue(runtimeAtom);
  const runtime =
    scope.enabled && activeRuntime && scope.workspaceId === activeRuntime.workspaceId
      ? activeRuntime
      : null;
  const self = useAtomValue(userAtom)?.id ?? null;
  const userId = props.target.member ?? self;
  const today = useTodayClock();
  const sidebarVisible = useAtomValue(navigationSidebarVisibleAtom);
  const anchor = props.target.date ? (parseTodayDate(props.target.date) ?? undefined) : undefined;
  const [registered, setRegistered] = useState<readonly TodayDate[]>([]);
  const [fullWidth, setFullWidth] = useAtom(todayFullWidthAtom);
  const [empty, setEmpty] = useState<ReadonlySet<TodayDate>>(new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const { members, isMultiMember } = useWorkspaceMembers();
  const membersById = useMemo(
    () => new Map(members.map((member) => [member.userId, member] as const)),
    [members]
  );
  const latest = useRef({ membersById, target: props.target, onNavigate: props.onNavigate, self });
  latest.current = { membersById, target: props.target, onNavigate: props.onNavigate, self };
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const standalone = props.standalone ?? false;
  const pinnedColumn = !standalone && (props.pinned ?? false);
  const openSession = useRef<TodayOpenSession>(openSessionDeepLink);
  openSession.current = props.onOpenSession ?? openSessionDeepLink;

  useEffect(() => {
    setRegistered([]);
    setEmpty(new Set());
    if (!runtime || !userId) return undefined;
    return runtime.todayPages.observeDates(userId, setRegistered);
  }, [runtime, userId]);

  const onEmptyChange = useCallback((date: TodayDate, isEmpty: boolean) => {
    setEmpty((previous) => {
      if (previous.has(date) === isEmpty) return previous;
      const next = new Set(previous);
      if (isEmpty) next.add(date);
      else next.delete(date);
      return next;
    });
  }, []);
  const focus = props.target.focus;
  const focusDate = focus ? (anchor ?? today) : null;
  const zoomRoot = focus && focus !== 'day' ? (focus as TodayNodeId) : null;
  const days = useMemo(
    () => (focusDate ? [focusDate] : buildDayStream({ today, anchor, registered, empty })),
    [anchor, empty, focusDate, registered, today]
  );
  const cache = runtime?.todayPages ?? null;
  const jotai = useStore();
  const [controller, setController] = useState<TodayEditorController | null>(null);
  useEffect(() => {
    if (!cache) return undefined;
    const created = new TodayEditorController(cache);
    const workspaceId = runtime?.workspaceId ?? null;
    created.workspaceId = workspaceId;
    created.mentionText = (mention) =>
      todayMentionMarkdown(mention, {
        workspaceId,
        title:
          mention.kind === 'session'
            ? jotai.get(sessionMetaAtomFamily(getSessionRoomId(mention.id as SessionId)))?.title
            : mention.kind === 'member'
              ? latest.current.membersById.get(mention.id)?.name
              : null,
      });
    created.onOpenMember = (memberId) => {
      const { target, onNavigate, self: me } = latest.current;
      onNavigate({ date: target.date, member: memberId === me ? undefined : memberId });
    };
    created.onOpenSession = (sessionId) => {
      if (workspaceId) openSession.current({ sessionId: sessionId as SessionId, workspaceId });
    };
    setController(created);
    return () => {
      created.dispose();
      setController(null);
    };
  }, [cache, jotai]);
  const memberName =
    userId && userId !== self
      ? members.find((member) => member.userId === userId)?.name
      : undefined;
  useEffect(
    () => controller?.setFocus(focusDate ? { date: focusDate, rootId: zoomRoot } : null),
    [controller, focusDate, zoomRoot]
  );

  const streamReturn = useRef<{ target: TodayViewTarget; anchor: TodayScrollAnchor | null } | null>(
    null
  );
  const dateParam = (date: TodayDate) => (date === today ? undefined : date);
  const enterFocus = (next: TodayViewTarget) => {
    if (!props.target.focus) {
      streamReturn.current = {
        target: props.target,
        anchor: captureScrollAnchor(controller?.getSurface() ?? null),
      };
    }
    props.onNavigate(next);
  };
  const leaveFocus = () =>
    props.onNavigate(streamReturn.current?.target ?? { member: props.target.member });
  const focusPage = () =>
    focusDate && userId ? cache?.peek(getTodayDocId(userId, focusDate)) : undefined;
  const nav = {
    zoom: (store: TodayPageStore, nodeId: TodayNodeId) =>
      enterFocus({ member: props.target.member, date: dateParam(store.date), focus: nodeId }),
    zoomOut: () => {
      if (!focusDate) return;
      if (!zoomRoot) return leaveFocus();
      const parent = focusPage()?.outline.getNode(zoomRoot)?.parentId;
      props.onNavigate({ ...props.target, focus: parent ?? 'day' });
    },
    openDay: (date: TodayDate) =>
      enterFocus({ member: props.target.member, date: dateParam(date), focus: 'day' }),
  };
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => {
    if (!controller) return undefined;
    controller.onZoom = (store, nodeId) => navRef.current.zoom(store, nodeId);
    controller.onZoomOut = () => navRef.current.zoomOut();
    return () => {
      controller.onZoom = null;
      controller.onZoomOut = null;
    };
  }, [controller]);
  useLayoutEffect(() => {
    if (focusDate || !streamReturn.current) return undefined;
    const { anchor } = streamReturn.current;
    streamReturn.current = null;
    return restoreScrollAnchor(controller?.getSurface() ?? null, anchor);
  }, [controller, focusDate]);

  if (!runtime || !userId) return null;
  const toolbarSurface: TodayToolbarSurface = standalone
    ? 'standalone'
    : pinnedColumn
      ? 'pinned'
      : 'page';
  const openWindowLabel = t('today.openWindow', 'Open in new window');
  // Keep Toggle aria-label static to match aria-pressed; the tooltip states the next action.
  const pinControlLabel = standalone
    ? t('today.pinWindow', 'Keep on top')
    : t('today.pin', 'Pin to sidebar');
  const pinTooltip = standalone
    ? props.pinned
      ? t('today.unpinWindow', 'Stop keeping on top')
      : pinControlLabel
    : props.pinned
      ? t('today.unpin', 'Unpin')
      : pinControlLabel;
  const moreLabel = t('today.more', 'More');
  return (
    <TodayEditorContext.Provider value={controller}>
      <TodayMembersContext.Provider value={membersById}>
        <div {...stylex.props(styles.root)} data-testid="today-view">
          <TodayToolbar
            surface={toolbarSurface}
            title={
              focusDate ? (
                <TodayFocusCrumbs
                  page={focusPage}
                  date={focusDate}
                  zoomRoot={zoomRoot}
                  rootLabel={
                    memberName
                      ? t('today.memberTitle', '{{name}}’s Today', { name: memberName })
                      : t('today.nav', 'Today')
                  }
                  onStream={leaveFocus}
                  onFocus={(next) => props.onNavigate({ ...props.target, focus: next })}
                />
              ) : memberName ? (
                t('today.memberTitle', '{{name}}’s Today', { name: memberName })
              ) : null
            }
            interactiveTitle={!!focusDate}
          >
            <Tooltip.Provider delay={400}>
              <TodayCalendar
                today={today}
                selected={anchor ?? today}
                registered={registered}
                language={i18n.language}
                onPick={(date) =>
                  props.onNavigate({ ...props.target, date: date === today ? undefined : date })
                }
              />
              {!standalone && workspaceSlug && isElectronRenderer() ? (
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={
                      <Button
                        variant="ghost"
                        size="small"
                        icon
                        aria-label={openWindowLabel}
                        onClick={() =>
                          openTodayWindow({
                            workspace: workspaceSlug,
                            member: props.target.member,
                            date: props.target.date,
                          })
                        }
                      >
                        <PictureInPicture2 size={16} strokeWidth={1.5} />
                      </Button>
                    }
                  />
                  <Tooltip.Content side="bottom">{openWindowLabel}</Tooltip.Content>
                </Tooltip.Root>
              ) : null}
              {props.onTogglePin ? (
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={
                      <Toggle
                        size="small"
                        icon
                        pressed={props.pinned ?? false}
                        aria-label={pinControlLabel}
                        onPressedChange={() => props.onTogglePin?.()}
                      >
                        <Pin
                          size={16}
                          strokeWidth={1.5}
                          fill="none"
                          {...stylex.props(styles.pinIcon, !props.pinned && styles.pinUnpinned)}
                        />
                      </Toggle>
                    }
                  />
                  <Tooltip.Content side="bottom">{pinTooltip}</Tooltip.Content>
                </Tooltip.Root>
              ) : null}
              <Menu.Root open={moreOpen} onOpenChange={setMoreOpen}>
                <Tooltip.Root disabled={moreOpen}>
                  <Tooltip.Trigger
                    render={
                      <Menu.Trigger
                        render={
                          <Button variant="ghost" size="small" icon aria-label={moreLabel}>
                            <MoreHorizontal size={16} strokeWidth={1.5} />
                          </Button>
                        }
                      />
                    }
                  />
                  <Tooltip.Content side="bottom">{moreLabel}</Tooltip.Content>
                </Tooltip.Root>
                <Menu.Content>
                  {isMultiMember ? (
                    <Menu.Submenu>
                      <Menu.SubmenuTrigger>
                        {t('today.viewMember', "View a member's Today")}
                      </Menu.SubmenuTrigger>
                      <Menu.Content>
                        {members.map((member) => (
                          <Menu.Item
                            key={member.userId}
                            icon={
                              <UserAvatar user={{ id: member.userId, ...member }} size="mini" />
                            }
                            onClick={() =>
                              props.onNavigate({
                                date: props.target.date,
                                member: member.userId === self ? undefined : member.userId,
                              })
                            }
                          >
                            {member.name}
                          </Menu.Item>
                        ))}
                      </Menu.Content>
                    </Menu.Submenu>
                  ) : null}
                  {pinnedColumn || standalone ? null : (
                    <Menu.CheckboxItem
                      checked={fullWidth}
                      indicatorSide="end"
                      onCheckedChange={(checked) => setFullWidth(checked)}
                    >
                      {t('today.fullWidth', 'Full width')}
                    </Menu.CheckboxItem>
                  )}
                  <Menu.Item
                    onClick={() => {
                      void writeTextToClipboard(
                        buildTodayLink(runtime.workspaceId, userId, anchor ?? today)
                      ).then((copied) => {
                        if (copied) toast.success(t('today.linkCopied', 'Link copied'));
                      });
                    }}
                  >
                    {t('today.copyLink', 'Copy link')}
                  </Menu.Item>
                </Menu.Content>
              </Menu.Root>
            </Tooltip.Provider>
          </TodayToolbar>
          <TodayOutlineSurface
            controller={controller}
            fullWidth={pinnedColumn || standalone || fullWidth}
            placement={
              standalone
                ? 'pinned'
                : pinnedColumn
                  ? sidebarVisible
                    ? 'pinned'
                    : 'pinnedAtWindowEdge'
                  : 'page'
            }
          >
            {days.map((date, index) => (
              <TodayDaySection
                key={`${userId}:${date}`}
                cache={runtime.todayPages}
                userId={userId}
                date={date}
                today={today}
                isTop={index === 0}
                onEmptyChange={onEmptyChange}
                zoomRoot={zoomRoot}
                onOpenDay={focusDate ? undefined : nav.openDay}
              />
            ))}
          </TodayOutlineSurface>
          <TodayLiveSessionPicker />
          <TodayNodeActions pinned={pinnedColumn} />
          <TodayMentionStatusMenuHost />
          {anchor && anchor !== today && !focusDate ? (
            <div {...stylex.props(styles.back)}>
              <span {...stylex.props(styles.backButton)}>
                <Button
                  variant="secondary"
                  size="small"
                  shape="pill"
                  onClick={() => props.onNavigate({ ...props.target, date: undefined })}
                >
                  {t('today.backToToday', 'Back to today')}
                </Button>
              </span>
            </div>
          ) : null}
        </div>
      </TodayMembersContext.Provider>
    </TodayEditorContext.Provider>
  );
}

export type TodayToolbarSurface = 'page' | 'pinned' | 'standalone';

/**
 * The Today toolbar. Full-page and standalone-window rows sit at the window top
 * under its drag strip (so controls must be drag-exempt), and when the sidebar
 * is hidden the main window's leftmost Today surface carries sidebar navigation.
 * A pinned sidebar column is never window-drag chrome.
 */
export function TodayToolbar(props: {
  surface?: TodayToolbarSurface;
  title: ReactNode;
  /** The title holds controls (the focus view's breadcrumb): they must take clicks. */
  interactiveTitle?: boolean;
  children: ReactNode;
}) {
  const sidebarVisible = useAtomValue(navigationSidebarVisibleAtom);
  const showSidebar = useSetAtom(showNavigationSidebarAtom);
  const fullscreen = useElectronFullscreen();
  const dragClass = useWindowDragRegionClass();
  const captionPadClass = useWindowsCaptionPadClass();
  const captionRowPadClass = useWindowsCaptionRowPadClass();
  const trafficLightRowPadClass = useMacTrafficLightRowPadClass({
    insideWorkspaceFrame: true,
    includeDesktopWeb: true,
  });
  const surface = props.surface ?? 'page';
  const hasDragChrome = surface !== 'pinned';
  const standalone = surface === 'standalone';
  // All surfaces line up in the window-top row; only full-page and standalone
  // window headers participate in window drag and caption padding.
  const exemptClassName = hasDragChrome && dragClass ? WINDOW_DRAG_EXEMPT_CLASS : undefined;
  const besideTrafficLights =
    (standalone || !sidebarVisible) &&
    !isNativeAppShell() &&
    isMacOSElectronRenderer() &&
    !fullscreen;
  const chromeClassName = (
    hasDragChrome
      ? [dragClass, captionPadClass, captionRowPadClass, trafficLightRowPadClass]
      : [captionRowPadClass, trafficLightRowPadClass]
  )
    .filter(Boolean)
    .join(' ');
  return (
    <div
      {...withClassName(
        stylex.props(
          styles.toolbar,
          styles.windowRowToolbar,
          besideTrafficLights && styles.toolbarBesideTrafficLights,
          trafficLightRowPadClass !== undefined && styles.toolbarOnTrafficLightLine
        ),
        chromeClassName
      )}
      data-testid="today-toolbar"
    >
      {/* With the sidebar hidden, Today (page or pinned column) is the window's
          leftmost surface and carries the sidebar toggle and Back/Forward. */}
      {!sidebarVisible && !standalone ? (
        <SidebarHistoryControls onToggleSidebar={showSidebar} className={exemptClassName} />
      ) : null}
      <span
        {...withClassName(
          stylex.props(styles.title),
          props.interactiveTitle ? exemptClassName : undefined
        )}
      >
        {props.title}
      </span>
      <div {...withClassName(stylex.props(styles.controls), exemptClassName)}>{props.children}</div>
    </div>
  );
}

/**
 * A node's menu, from its "⋯" button or a right-click on its bullet: the
 * selection bar's actions for that one node, plus zooming into it.
 */
function TodayNodeMenu(props: {
  store: TodayPageStore;
  nodeId: TodayNodeId;
  anchor: HTMLElement | { x: number; y: number };
  controller: TodayEditorController;
  onConvert: () => void;
  onClose: (keepSelection: boolean) => void;
}) {
  const { t } = useTranslation();
  const { store, nodeId, controller, anchor } = props;
  const node = store.outline.getNode(nodeId);
  const positioned = useMemo(
    () =>
      anchor instanceof HTMLElement
        ? anchor
        : {
            getBoundingClientRect: () => new DOMRect(anchor.x, anchor.y, 0, 0),
          },
    [anchor]
  );
  if (!node) return null;
  const canConvert = node.text.replaceAll(TODAY_MENTION_CHAR, '').trim().length > 0;
  const todo =
    node.todo === undefined
      ? { icon: <Square size={16} />, label: t('today.todo.make', 'Turn into to-do') }
      : node.todo === 'todo'
        ? { icon: <SquareCheck size={16} />, label: t('today.todo.markDone', 'Mark as done') }
        : { icon: <Type size={16} />, label: t('today.todo.clear', 'Back to plain text') };
  const isMacPlatform = isMac();
  return (
    <Menu.Root open onOpenChange={(open) => !open && props.onClose(false)}>
      <Menu.Content anchor={positioned} side="bottom" align="start">
        <Menu.Item
          icon={<Maximize2 size={16} />}
          shortcut={isMacPlatform ? '⌥→' : 'Alt+→'}
          onClick={() => {
            props.onClose(false);
            controller.onZoom?.(store, nodeId);
          }}
        >
          {t('today.zoomIn', 'Zoom in')}
        </Menu.Item>
        <Menu.Item
          icon={todo.icon}
          shortcut={formatKeyBinding('Mod+Enter')}
          onClick={() => {
            store.undo.structural(() => store.outline.cycleTodo([nodeId]));
            props.onClose(false);
          }}
        >
          {todo.label}
        </Menu.Item>
        <Menu.Item
          icon={<MessageSquarePlus size={16} />}
          disabled={!canConvert}
          onClick={() => {
            props.onClose(true);
            props.onConvert();
          }}
        >
          {t('today.convertToTask', 'Convert to task')}
        </Menu.Item>
        <Menu.Separator />
        <Menu.Item
          icon={<Copy size={16} />}
          shortcut={formatKeyBinding('Mod+C')}
          onClick={() => {
            controller.copySelection();
            props.onClose(false);
          }}
        >
          {t('common.copy', 'Copy')}
        </Menu.Item>
        <Menu.Item
          icon={<Trash2 size={16} />}
          tone="destructive"
          onClick={() => {
            controller.deleteSelection();
            props.onClose(true);
          }}
        >
          {t('common.delete', 'Delete')}
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

/** Where the stream was: the top visible row and its offset (plus the raw scroll, as a fallback). */
export type TodayScrollAnchor = { nodeId: string | null; offset: number; scrollTop: number };

export function captureScrollAnchor(surface: HTMLElement | null): TodayScrollAnchor | null {
  if (!surface) return null;
  const top = surface.getBoundingClientRect().top;
  for (const row of surface.querySelectorAll<HTMLElement>('[data-today-node]')) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top) {
      return {
        nodeId: row.dataset.todayNode ?? null,
        offset: rect.top - top,
        scrollTop: surface.scrollTop,
      };
    }
  }
  return { nodeId: null, offset: 0, scrollTop: surface.scrollTop };
}

/**
 * Put the stream back where it was. Days above may have grown or shrunk
 * meanwhile, so after the raw offset the anchor row is lined up again once it
 * mounts (the stream's pages open over a few frames).
 */
export function restoreScrollAnchor(surface: HTMLElement | null, anchor: TodayScrollAnchor | null) {
  if (!surface || !anchor) return undefined;
  surface.scrollTop = anchor.scrollTop;
  let frames = 0;
  let handle = 0;
  const align = () => {
    const row = anchor.nodeId
      ? surface.querySelector<HTMLElement>(`[data-today-node="${CSS.escape(anchor.nodeId)}"]`)
      : null;
    if (row) {
      surface.scrollTop +=
        row.getBoundingClientRect().top - surface.getBoundingClientRect().top - anchor.offset;
      return;
    }
    frames += 1;
    if (frames < 30) handle = requestAnimationFrame(align);
  };
  align();
  return () => cancelAnimationFrame(handle);
}

/** The focus view's breadcrumb: back to the stream, the day, and the zoomed node's ancestors. */
export function TodayFocusCrumbs(props: {
  /** The focused day's page, once a section has opened it. */
  page: () => TodayPageStore | undefined;
  date: TodayDate;
  zoomRoot: TodayNodeId | null;
  rootLabel: string;
  onStream: () => void;
  onFocus: (focus: string) => void;
}) {
  const { t } = useTranslation();
  const { zoomRoot } = props;
  useTodayEditor();
  const page = props.page();
  useSyncExternalStore(page?.subscribe ?? noopSubscribe, page?.getSnapshot ?? noSnapshot);
  const label = (nodeId: TodayNodeId) => {
    const text = page?.outline.getNode(nodeId)?.text.replaceAll(TODAY_MENTION_CHAR, '').trim();
    return text || t('today.untitledNode', 'Untitled');
  };
  const ancestors: TodayNodeId[] = [];
  for (
    let parent = zoomRoot ? (page?.outline.getNode(zoomRoot)?.parentId ?? null) : null;
    parent;
    parent = page?.outline.getNode(parent)?.parentId ?? null
  ) {
    ancestors.unshift(parent);
  }
  const crumbs: TodayCrumb[] = [
    { key: 'stream', label: props.rootLabel, onSelect: props.onStream },
    {
      key: 'day',
      label: props.date,
      onSelect: zoomRoot ? () => props.onFocus('day') : undefined,
    },
    ...ancestors.map((id) => ({ key: id, label: label(id), onSelect: () => props.onFocus(id) })),
    ...(zoomRoot ? [{ key: zoomRoot, label: label(zoomRoot) }] : []),
  ];
  return <TodayBreadcrumb crumbs={crumbs} />;
}

const noopSubscribe = () => () => {};
const noSnapshot = () => null;

/** The scroll surface: focus, keys and clipboard for block selection. */
export function TodayOutlineSurface(props: {
  controller: TodayEditorController | null;
  /** Span the whole width instead of the readable column (the pinned column is narrow anyway). */
  fullWidth?: boolean;
  /** Where the surface sits: its gutters follow (default `page`). */
  placement?: 'page' | 'pinned' | 'pinnedAtWindowEdge';
  children: React.ReactNode;
}) {
  const { controller } = props;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = surfaceRef.current;
    if (!element || !controller) return undefined;
    // Pinned sidebar rows drag by pointer, not HTML5: they report here.
    return registerSessionMentionPointerTarget(element, {
      accepts: () => true,
      hover: (x, y) => controller.hoverExternal(x, y),
      leave: () => controller.leaveExternal(),
      drop: (sessionId, point) => {
        if (point) controller.dropExternal(sessionId, point.x, point.y);
      },
    });
  }, [controller]);
  return (
    <div
      {...stylex.props(
        todaySurfaceMarker,
        styles.scroller,
        props.placement !== undefined && props.placement !== 'page' && styles.scrollerPinned,
        props.placement === 'pinnedAtWindowEdge' && styles.scrollerAtWindowEdge
      )}
      ref={(element) => {
        surfaceRef.current = element;
        controller?.attachSurface(element);
      }}
      onDragOverCapture={(event) => {
        if (!controller || !hasAcceptableSessionMentionTransfer(event.dataTransfer)) return;
        // Captured so the node editor never inserts the dragged title as text.
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        controller.hoverExternal(event.clientX, event.clientY);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          controller?.leaveExternal();
        }
      }}
      onDropCapture={(event) => {
        if (!controller || !hasAcceptableSessionMentionTransfer(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        const sessionId = readSessionMentionDragSessionId(event.dataTransfer);
        if (sessionId) controller.dropExternal(sessionId, event.clientX, event.clientY);
        else controller.leaveExternal();
      }}
      tabIndex={-1}
      role="tree"
      data-today-scroller=""
      aria-multiselectable
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) controller?.onBlockKey(event.nativeEvent);
      }}
      onCopy={(event) => controller?.onBlockClipboard(event.nativeEvent, false)}
      onCut={(event) => controller?.onBlockClipboard(event.nativeEvent, true)}
      onPaste={(event) => {
        if (event.target === event.currentTarget) controller?.onBlockPaste(event.nativeEvent);
      }}
    >
      <TodayMoreAtEndContext.Provider value={props.placement === 'pinnedAtWindowEdge'}>
        <div {...stylex.props(!props.fullWidth && styles.column)}>{props.children}</div>
      </TodayMoreAtEndContext.Provider>
      <TodayDragLayer />
    </div>
  );
}

const dragStyles = stylex.create({
  line: {
    position: 'fixed',
    height: 2,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    pointerEvents: 'none',
    zIndex: 40,
  },
  lineDot: {
    position: 'absolute',
    left: -4,
    top: -3,
    width: 8,
    height: 8,
    borderRadius: radius.full,
    borderWidth: 2,
    borderStyle: 'solid',
    borderColor: colors.accent,
    backgroundColor: colors.background,
  },
  blocked: {
    position: 'fixed',
    padding: `${space[1]} ${space[2]}`,
    borderRadius: radius.small,
    backgroundColor: colors.raisedBackground,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    boxShadow: '0 4px 12px rgb(0 0 0 / 0.12)',
    pointerEvents: 'none',
    zIndex: 41,
  },
  ghost: {
    position: 'fixed',
    maxWidth: 280,
    padding: `${space[1]} ${space[2]}`,
    borderRadius: radius.small,
    backgroundColor: colors.raisedBackground,
    color: colors.label,
    fontSize: text.subheadlineSize,
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    zIndex: 42,
  },
  // Released: glide to the landing line (or back home) and fade.
  ghostSettling: {
    opacity: 0,
    transitionProperty: {
      default: 'top, left, opacity',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: duration.fast,
    transitionTimingFunction: 'ease-out',
  },
});

/** The drop line, the "can't move here" note, and the dragged card. */
function TodayDragLayer() {
  const { t } = useTranslation();
  const controller = useTodayEditor();
  const indicator = controller?.getDropIndicator() ?? null;
  const ghost = controller?.getDragGhost() ?? null;
  return (
    <>
      {indicator?.kind === 'line' ? (
        <div
          {...stylex.props(dragStyles.line)}
          style={{ top: indicator.top - 1, left: indicator.left, width: indicator.width }}
        >
          <span {...stylex.props(dragStyles.lineDot)} />
        </div>
      ) : null}
      {indicator?.kind === 'blocked' ? (
        <div
          {...stylex.props(dragStyles.blocked)}
          style={{ top: indicator.y + 16, left: indicator.x + 12 }}
        >
          {t('today.cannotMoveToOtherDay', "Can't move to another date")}
        </div>
      ) : null}
      {ghost ? (
        <div
          {...stylex.props(dragStyles.ghost, ghost.settling && dragStyles.ghostSettling)}
          style={{ top: ghost.y + 8, left: ghost.x + 12 }}
        >
          {ghost.count > 1
            ? t('today.movingNodes', 'Moving {{count}} nodes', { count: ghost.count })
            : ghost.label || '\u00a0'}
        </div>
      ) : null}
    </>
  );
}

export type TodayConvertDialogComponent = ComponentType<{
  open: boolean;
  prompt: string;
  promptWithAncestors?: string | null;
  onAccepted: (sessionId: SessionId) => void;
  onOpenChange: (open: boolean) => void;
}>;

/**
 * The selection bar and "Convert to task". Only an accepted conversation changes
 * the node: unchanged since the dialog opened, the line becomes the mention
 * (children stay, folded); edited meanwhile, the mention is prefixed; a node
 * deleted meanwhile gets a mention node appended to the page instead. The dialog is replaceable so Storybook
 * can stand in for the full new-conversation surface.
 */
export function TodayNodeActions(props: {
  pinned: boolean;
  ConvertDialog?: TodayConvertDialogComponent;
}) {
  const controller = useTodayEditor();
  const ConvertDialog = props.ConvertDialog ?? TodayConvertDialog;
  const [converting, setConverting] = useState<{
    store: TodayPageStore;
    nodeId: TodayNodeId;
    prompt: string;
    promptWithAncestors: string | null;
    /** The node's text when the dialog opened: unchanged, the line becomes the mention. */
    snapshot: TodayRichText;
  } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{
    store: TodayPageStore;
    nodeId: TodayNodeId;
    anchor: HTMLElement | { x: number; y: number };
  } | null>(null);
  useEffect(() => {
    if (!controller) return undefined;
    controller.onNodeMenu = (store, nodeId, anchor) => {
      controller.selectBlocks(store, [nodeId]);
      setNodeMenu({ store, nodeId, anchor });
    };
    return () => {
      controller.onNodeMenu = null;
    };
  }, [controller]);
  const convert = (store: TodayPageStore, nodeId: TodayNodeId) => {
    const [fragment] = store.outline.extract([nodeId]);
    const text = store.outline.getText(nodeId);
    if (!fragment || !text || !controller) return;
    const ancestors: TodayRichText[] = [];
    for (
      let parent = store.outline.getNode(nodeId)?.parentId ?? null;
      parent;
      parent = store.outline.getNode(parent)?.parentId ?? null
    ) {
      const node = store.outline.getNode(parent);
      if (!node) break;
      ancestors.unshift({ text: node.text, mentions: [...node.mentions] });
    }
    setConverting({
      store,
      nodeId,
      prompt: buildConvertPrompt(fragment, controller.mentionText),
      promptWithAncestors:
        ancestors.length > 0
          ? buildConvertPrompt(fragment, controller.mentionText, ancestors)
          : null,
      snapshot: readTodayText(text),
    });
  };
  return (
    <>
      {converting || nodeMenu ? null : <TodaySelectionBar onConvert={convert} />}
      {nodeMenu && controller ? (
        <TodayNodeMenu
          {...nodeMenu}
          controller={controller}
          onConvert={() => convert(nodeMenu.store, nodeMenu.nodeId)}
          onClose={(keepSelection) => {
            setNodeMenu(null);
            if (!keepSelection) controller.clearBlockSelection();
          }}
        />
      ) : null}
      <ConvertDialog
        open={converting !== null}
        prompt={converting?.prompt ?? ''}
        promptWithAncestors={converting?.promptWithAncestors ?? null}
        onOpenChange={(open) => {
          if (!open) {
            setConverting(null);
            controller?.clearBlockSelection();
          }
        }}
        onAccepted={(sessionId) => {
          const target = converting;
          if (!target) return;
          const { store, nodeId, snapshot } = target;
          const mention = { kind: 'session', id: sessionId };
          const converted = store.undo.structural(() =>
            store.outline.convertToMention(nodeId, mention, snapshot)
          );
          if (!converted) {
            store.undo.structural(() =>
              store.outline.insertMentionNode(
                { parentId: null, index: Number.MAX_SAFE_INTEGER },
                mention
              )
            );
          }
          if (props.pinned) controller?.onOpenSession?.(sessionId);
        }}
      />
    </>
  );
}

function TodayCalendar(props: {
  today: TodayDate;
  selected: TodayDate;
  registered: readonly TodayDate[];
  language: string;
  onPick: (date: TodayDate) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => todayDateToLocalDate(props.selected));
  const marked = useMemo(() => new Set(props.registered), [props.registered]);
  const cells = useMemo(() => monthCells(month), [month]);
  const weekdayFormat = new Intl.DateTimeFormat(toIntlLocaleOrEn(props.language), {
    weekday: 'narrow',
  });
  const monthFormat = new Intl.DateTimeFormat(toIntlLocaleOrEn(props.language), {
    year: 'numeric',
    month: 'long',
  });
  const calendarLabel = t('today.calendar', 'Pick a date');
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setMonth(todayDateToLocalDate(props.selected));
      }}
    >
      <Tooltip.Root disabled={open}>
        <Tooltip.Trigger
          render={
            <Popover.Trigger
              render={
                <Button variant="ghost" size="small" icon aria-label={calendarLabel}>
                  <CalendarDays size={16} strokeWidth={1.5} />
                </Button>
              }
            />
          }
        />
        <Tooltip.Content side="bottom">{calendarLabel}</Tooltip.Content>
      </Tooltip.Root>
      <Popover.Content>
        <div {...stylex.props(styles.calendar)}>
          <div {...stylex.props(styles.calendarHead)}>
            <Button
              variant="ghost"
              size="mini"
              icon
              aria-label={t('today.previousMonth', 'Previous month')}
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              <ChevronLeft size={14} />
            </Button>
            <span>{monthFormat.format(month)}</span>
            <Button
              variant="ghost"
              size="mini"
              icon
              aria-label={t('today.nextMonth', 'Next month')}
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              <ChevronRight size={14} />
            </Button>
          </div>
          <div {...stylex.props(styles.grid)}>
            {cells.slice(0, 7).map((cell) => (
              <span key={`w${cell.getDay()}`} {...stylex.props(styles.weekday)}>
                {weekdayFormat.format(cell)}
              </span>
            ))}
            {cells.map((cell) => {
              const date = localTodayDate(cell);
              return (
                <button
                  type="button"
                  key={date}
                  {...stylex.props(
                    styles.day,
                    cell.getMonth() !== month.getMonth() && styles.dayOutside,
                    date === props.today && styles.dayToday
                  )}
                  aria-pressed={date === props.selected}
                  onClick={() => {
                    setOpen(false);
                    props.onPick(date);
                  }}
                >
                  {cell.getDate()}
                  {marked.has(date) ? <span {...stylex.props(styles.dayMark)} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

/** Six Monday-first weeks covering `month`. */
function monthCells(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from(
    { length: 42 },
    (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + index)
  );
}
