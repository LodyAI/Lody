import * as stylex from '@stylexjs/stylex';
import { CalendarDays, ChevronLeft, ChevronRight, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { todayFullWidthAtom } from '@/atoms/sidebar-state';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildTodayLink,
  getSessionRoomId,
  parseTodayDate,
  readTodayText,
  TODAY_MENTION_CHAR,
  type SessionId,
  type TodayDate,
  type TodayRichText,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Popover } from '@lody/ui/popover';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
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
import { writeTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/lib/toast';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { openSessionDeepLink } from '@/lib/session-deep-link';
import {
  hasAcceptableSessionMentionTransfer,
  readSessionMentionDragSessionId,
  registerSessionMentionPointerTarget,
} from '@/lib/session-mention-drag';
import {
  selectSessionMentionCandidates,
  useSessionMentionItems,
  type SessionMentionItem,
} from '@/components/mentions/mention-session-source';
import { useTodayEditor } from './editor/today-editor-context';
import { TodayEditorContext } from './editor/today-editor-context';
import { TodayEditorController } from './editor/today-editor-controller';
import { TodayDaySection } from './today-day-section';
import { todayOutline } from './outline.stylex';
import { TodayConvertDialog } from './today-convert-dialog';
import { TodayMentionStatusMenuHost } from './today-mention-status-menu';
import { buildConvertPrompt, todayMentionMarkdown } from './editor/block-selection';
import type { TodayPageStore } from '@/lib/today/today-page-store';
import type { TodayNodeId } from '@lody/shared';
import { buildDayStream, localTodayDate, todayDateToLocalDate } from './today-stream';
import { useTodayClock } from './use-today-clock';

export type TodayViewTarget = { member?: string; date?: string };

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
  const { members, isMultiMember } = useWorkspaceMembers();
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
  const days = useMemo(
    () => buildDayStream({ today, anchor, registered, empty }),
    [anchor, empty, registered, today]
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
            : null,
      });
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

  if (!runtime || !userId) return null;
  return (
    <TodayEditorContext.Provider value={controller}>
      <div {...stylex.props(styles.root)} data-testid="today-view">
        <TodayToolbar
          pinned={pinnedColumn}
          standalone={standalone}
          title={
            memberName ? t('today.memberTitle', '{{name}}’s Today', { name: memberName }) : null
          }
        >
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
            <Button
              variant="ghost"
              size="small"
              icon
              aria-label={t('today.openWindow', 'Open Today in a new window')}
              onClick={() => openTodayWindow({ workspace: workspaceSlug, ...props.target })}
            >
              <OpenWindowIcon />
            </Button>
          ) : null}
          {props.onTogglePin ? (
            <Button
              variant="ghost"
              size="small"
              icon
              aria-pressed={props.pinned ?? false}
              aria-label={
                standalone
                  ? props.pinned
                    ? t('today.unpinWindow', 'Stop keeping on top')
                    : t('today.pinWindow', 'Keep on top of other windows')
                  : props.pinned
                    ? t('today.unpin', 'Unpin Today')
                    : t('today.pin', 'Pin Today beside the sidebar')
              }
              onClick={props.onTogglePin}
            >
              {props.pinned ? (
                <PinOff size={16} strokeWidth={1.5} />
              ) : (
                <Pin size={16} strokeWidth={1.5} />
              )}
            </Button>
          ) : null}
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button variant="ghost" size="small" icon aria-label={t('today.more', 'More')}>
                  <MoreHorizontal size={16} strokeWidth={1.5} />
                </Button>
              }
            />
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
            />
          ))}
        </TodayOutlineSurface>
        <TodayLiveSessionPicker />
        <TodayNodeActions pinned={pinnedColumn} />
        <TodayMentionStatusMenuHost />
        {anchor && anchor !== today ? (
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
    </TodayEditorContext.Provider>
  );
}

/**
 * The Today toolbar. The full page's row is the window top: it sits under the
 * workspace's window drag strip, so its controls are drag-exempt or Electron
 * swallows their clicks, and while the navigation sidebar is hidden it carries
 * the sidebar's toggle and Back/Forward, which would otherwise be unreachable.
 * The pinned column is not at the window top and needs none of this.
 */
export function TodayToolbar(props: {
  pinned: boolean;
  /** The standalone Today window's top row: window chrome without sidebar controls. */
  standalone?: boolean;
  title: ReactNode;
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
  const page = !props.pinned;
  // Both forms sit in a page card's window-top row and line up with its
  // controls; only the page is window chrome (drag region, caption buttons).
  const exemptClassName = page && dragClass ? WINDOW_DRAG_EXEMPT_CLASS : undefined;
  const besideTrafficLights =
    (props.standalone || !sidebarVisible) &&
    !isNativeAppShell() &&
    isMacOSElectronRenderer() &&
    !fullscreen;
  const chromeClassName = (
    page
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
      {!sidebarVisible && !props.standalone ? (
        <SidebarHistoryControls onToggleSidebar={showSidebar} className={exemptClassName} />
      ) : null}
      <span {...stylex.props(styles.title)}>{props.title}</span>
      <div {...withClassName(stylex.props(styles.controls), exemptClassName)}>{props.children}</div>
    </div>
  );
}

/** Two stacked windows, the front one lower left: opens Today on its own. */
function OpenWindowIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x={3} y={7} width={14} height={14} rx={2} />
      <path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" />
    </svg>
  );
}

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
      <div {...stylex.props(!props.fullWidth && styles.column)}>{props.children}</div>
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
    transitionDuration: '120ms',
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

const pickerStyles = stylex.create({
  menu: {
    position: 'fixed',
    zIndex: 50,
    minWidth: 260,
    maxWidth: 420,
    padding: space[1],
    borderRadius: radius.medium,
    backgroundColor: colors.raisedBackground,
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.16)',
    display: 'flex',
    flexDirection: 'column',
  },
  item: {
    textAlign: 'start',
    borderWidth: 0,
    background: 'none',
    color: colors.label,
    padding: `${space[1]} ${space[2]}`,
    borderRadius: radius.small,
    fontSize: text.subheadlineSize,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  highlighted: { backgroundColor: colors.hoverFill },
  disabled: { color: colors.tertiaryLabel, cursor: 'default' },
  empty: { padding: space[2], fontSize: text.footnoteSize, color: colors.tertiaryLabel },
});

/**
 * The live picker: the workspace's conversation list is subscribed only while
 * `@` is open, so session-list ticks never re-render the whole Today surface.
 */
function TodayLiveSessionPicker() {
  const controller = useTodayEditor();
  if (!controller?.getPicker()) return null;
  return <TodayWorkspaceSessionPicker />;
}

function TodayWorkspaceSessionPicker() {
  return <TodaySessionPicker items={useSessionMentionItems()} />;
}

/** The `@` conversation picker, below the editing caret. Items come from the host. */
export function TodaySessionPicker(props: { items: readonly SessionMentionItem[] }) {
  const { t } = useTranslation();
  const controller = useTodayEditor();
  const { items } = props;
  const picker = controller?.getPicker() ?? null;
  const root = controller?.getEditorRoot() ?? null;
  // Keyed on the query alone: arrowing through the list replaces `picker`.
  const query = picker?.query ?? null;
  const candidates = useMemo(() => {
    if (query === null) return [];
    return query
      ? selectSessionMentionCandidates(items, query, 8)
      : [...items].sort((a, b) => b.activityAt - a.activityAt).slice(0, 8);
  }, [items, query]);
  if (controller) controller.pickerItems = candidates.map((item) => item.sessionId);
  if (!controller || !picker || !root) return null;
  // Under the `@`: the caret's line when the browser can measure it, else the node.
  const selection = window.getSelection();
  const caret =
    selection?.rangeCount && root.contains(selection.anchorNode)
      ? selection.getRangeAt(0).getBoundingClientRect()
      : null;
  const rect = caret && caret.height > 0 ? caret : root.getBoundingClientRect();
  return (
    <div
      {...stylex.props(pickerStyles.menu)}
      style={{ left: rect.left, top: rect.bottom + 4 }}
      role="listbox"
      aria-label={t('today.pickSession', 'Conversations')}
    >
      {candidates.length === 0 ? (
        <span {...stylex.props(pickerStyles.empty)}>
          {t('today.noSessions', 'No matching conversations')}
        </span>
      ) : (
        candidates.map((item, index) => (
          <button
            type="button"
            key={item.sessionId}
            role="option"
            aria-selected={index === picker.index}
            {...stylex.props(pickerStyles.item, index === picker.index && pickerStyles.highlighted)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => controller.acceptPicker(item.sessionId)}
          >
            {item.title || t('today.untitledSession', 'Untitled conversation')}
          </button>
        ))
      )}
    </div>
  );
}

export type TodayConvertDialogComponent = ComponentType<{
  open: boolean;
  prompt: string;
  onAccepted: (sessionId: SessionId) => void;
  onOpenChange: (open: boolean) => void;
}>;

/**
 * The bullet menu and "Convert to task". Only an accepted conversation changes
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
  const [nodeMenu, setNodeMenu] = useState<{
    store: TodayPageStore;
    nodeId: TodayNodeId;
    x: number;
    y: number;
  } | null>(null);
  const [converting, setConverting] = useState<{
    store: TodayPageStore;
    nodeId: TodayNodeId;
    prompt: string;
    /** The node's text when the dialog opened: unchanged, the line becomes the mention. */
    snapshot: TodayRichText;
  } | null>(null);
  useEffect(() => {
    if (!controller) return undefined;
    controller.onNodeMenu = (store, nodeId, anchor) => {
      const rect = anchor.getBoundingClientRect();
      // Select the node (its subtree shows selected) so the menu's actions,
      // such as Convert to task, visibly cover everything they will take.
      controller.selectBlocks(store, [nodeId]);
      setNodeMenu({ store, nodeId, x: rect.left, y: rect.bottom + 4 });
    };
    return () => {
      controller.onNodeMenu = null;
    };
  }, [controller]);
  return (
    <>
      {nodeMenu ? (
        <TodayNodeMenu
          {...nodeMenu}
          onClose={() => {
            setNodeMenu(null);
            controller?.clearBlockSelection();
          }}
          onConvert={() => {
            const { store, nodeId } = nodeMenu;
            const [fragment] = store.outline.extract([nodeId]);
            const text = store.outline.getText(nodeId);
            setNodeMenu(null);
            if (!fragment || !text || !controller) return;
            controller.deactivate();
            setConverting({
              store,
              nodeId,
              prompt: buildConvertPrompt(fragment, controller.mentionText),
              snapshot: readTodayText(text),
            });
          }}
        />
      ) : null}
      <ConvertDialog
        open={converting !== null}
        prompt={converting?.prompt ?? ''}
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

/** The bullet menu: actions on one node. */
function TodayNodeMenu(props: {
  store: TodayPageStore;
  nodeId: TodayNodeId;
  x: number;
  y: number;
  onClose: () => void;
  onConvert: () => void;
}) {
  const { t } = useTranslation();
  const node = props.store.outline.getNode(props.nodeId);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof PointerEvent && ref.current?.contains(event.target as Node)) return;
      props.onClose();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
    };
  }, [props]);
  // Offered when the node says something besides its mentions.
  const canConvert = !!node && node.text.replaceAll(TODAY_MENTION_CHAR, '').trim().length > 0;
  return (
    <div
      ref={ref}
      role="menu"
      {...stylex.props(pickerStyles.menu)}
      style={{ left: props.x, top: props.y }}
    >
      <button
        type="button"
        role="menuitem"
        disabled={!canConvert}
        {...stylex.props(pickerStyles.item, !canConvert && pickerStyles.disabled)}
        onClick={props.onConvert}
      >
        {t('today.convertToTask', 'Convert to task')}
      </button>
    </div>
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
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setMonth(todayDateToLocalDate(props.selected));
      }}
    >
      <Popover.Trigger
        render={
          <Button variant="ghost" size="small" icon aria-label={t('today.calendar', 'Pick a date')}>
            <CalendarDays size={16} strokeWidth={1.5} />
          </Button>
        }
      />
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
