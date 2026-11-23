import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  Ellipsis,
  FileDiff,
  Files,
  GitBranch,
  GitPullRequest,
  MonitorPlay,
  PanelRight,
  Plus,
  SquareTerminal,
  X,
} from 'lucide-react';
import { Button } from './button';
import { AgentIcon, WorktreeIcon } from './icons';
import { REPLICA_PR_STATUS_TEXT, ReplicaPrIcon } from './sidebar';
import type { ReplicaAgent, ReplicaLocale, ReplicaPrStatus } from './types';
import { cn } from './utils';

/* Display-only replicas of the desktop session shell (`sessions/`): the merged
   top row (`SessionTabBar variant="session"` + toolbar), the resizable
   chat/right-panel split (`DesktopSessionDetailLayout`), the right panel's tab
   strip (`SessionSidePanelTabBar`) and the composer info bar (`SessionInfoBar`). */

const SHELL_COPY: Record<
  ReplicaLocale,
  {
    newTab: string;
    sessionTabs: string;
    openInEditor: string;
    moreActions: string;
    showPanel: string;
    hidePanel: string;
    addPanel: string;
    closeTab: (label: string) => string;
    browser: string;
    allChanges: string;
  }
> = {
  en: {
    newTab: 'New tab',
    sessionTabs: 'Session tabs',
    openInEditor: 'Open in editor',
    moreActions: 'More actions',
    showPanel: 'Show sidebar',
    hidePanel: 'Hide sidebar',
    addPanel: 'Add panel',
    closeTab: (label) => `Close ${label}`,
    browser: 'Browser',
    allChanges: 'All Changes',
  },
  zh: {
    newTab: '新标签页',
    sessionTabs: '会话标签页',
    openInEditor: '在编辑器中打开',
    moreActions: '更多操作',
    showPanel: '显示侧边栏',
    hidePanel: '隐藏侧边栏',
    addPanel: '添加面板',
    closeTab: (label) => `关闭 ${label}`,
    browser: '浏览器',
    allChanges: '全部变更',
  },
};

// Shared by the session tabs and the right-panel tabs (`TAB_PILL_*_CLASS`).
const TAB_PILL_ACTIVE_CLASS = 'bg-foreground/[0.08] text-tab-active-foreground';
const TAB_PILL_INACTIVE_CLASS = 'bg-foreground/[0.035] text-tab-inactive-foreground';
const TAB_BAR_ACTION_CLASS =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors';

// ---- Session tab bar ---------------------------------------------------------

export type ReplicaSessionTab = { id: string; title: string; agent: ReplicaAgent };

export function ReplicaSessionTabBar({
  tabs,
  activeTabId,
  rightSlot,
  locale = 'en',
}: {
  tabs: ReplicaSessionTab[];
  activeTabId: string;
  rightSlot?: ReactNode;
  locale?: ReplicaLocale;
}) {
  const copy = SHELL_COPY[locale];
  // A lone tab spans the whole row, so it drops the active fill.
  const solo = tabs.length === 1;
  return (
    <div className="@container/session-page flex h-11 min-w-0 items-center bg-background">
      <div
        className={cn('min-w-0 flex-1 overflow-hidden', tabs.length > 1 && '@container')}
        data-adaptive-tab-strip-viewport=""
      >
        <div
          role="tablist"
          aria-label={copy.sessionTabs}
          className="flex h-11 max-h-full w-full items-center"
          style={{ boxSizing: 'border-box', paddingLeft: 8, paddingRight: 8 }}
        >
          {tabs.map((tab, index) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={cn(
                  'min-w-0 overflow-hidden',
                  active && !solo && '@[366px]:min-w-(--tab-active-min-width)'
                )}
                style={{
                  flex: '1 1 0',
                  marginRight: index === tabs.length - 1 ? 0 : 6,
                  ...(active ? { ['--tab-active-min-width' as string]: '180px' } : null),
                }}
              >
                <div
                  role="tab"
                  aria-selected={active}
                  aria-label={tab.title}
                  className={cn(
                    'group relative flex h-8 w-full min-w-0 cursor-default items-center gap-1.5 overflow-hidden rounded-md border border-transparent px-3 text-[0.9em] transition-colors',
                    solo
                      ? 'text-tab-active-foreground'
                      : active
                        ? TAB_PILL_ACTIVE_CLASS
                        : TAB_PILL_INACTIVE_CLASS
                  )}
                >
                  <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center">
                    <AgentIcon agent={tab.agent} className="h-3 w-3 opacity-60" />
                  </span>
                  <span className="truncate">{tab.title}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          tabIndex={-1}
          className={TAB_BAR_ACTION_CLASS}
          aria-label={copy.newTab}
        >
          <Plus className="h-4 w-4" />
        </button>
        {rightSlot}
      </div>
    </div>
  );
}

// ---- Toolbar + panel toggle ----------------------------------------------------

/** `session-detail.tsx`'s `sidebarToggleButton`; also the right panel tab bar's end slot. */
export function ReplicaPanelToggle({
  locale,
  panelOpen,
}: {
  locale: ReplicaLocale;
  panelOpen: boolean;
}) {
  const copy = SHELL_COPY[locale];
  return (
    <Button
      variant="ghost"
      size="icon"
      tabIndex={-1}
      data-demo="toggle-panel"
      aria-label={panelOpen ? copy.hidePanel : copy.showPanel}
      className={cn('h-7 w-7 shrink-0 text-muted-foreground', !panelOpen && 'mr-[9px]')}
    >
      <PanelRight className="h-4 w-4" />
    </Button>
  );
}

/** Right-side controls of the merged top row (`headerVariant="toolbar"`). */
export function ReplicaSessionToolbar({
  locale,
  panelOpen,
}: {
  locale: ReplicaLocale;
  panelOpen: boolean;
}) {
  const copy = SHELL_COPY[locale];
  return (
    <div className="flex h-full shrink-0 items-center gap-1 pl-1 pr-2">
      <Button
        variant="ghost"
        size="icon"
        tabIndex={-1}
        className="h-7 w-7 shrink-0 text-muted-foreground"
        aria-label={copy.openInEditor}
      >
        <SquareTerminal className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        tabIndex={-1}
        className="h-7 w-7 shrink-0 text-muted-foreground"
        aria-label={copy.moreActions}
      >
        <Ellipsis className="h-4 w-4" />
      </Button>
      {panelOpen ? null : <ReplicaPanelToggle locale={locale} panelOpen={false} />}
    </div>
  );
}

// ---- Resizable chat / right-panel split ---------------------------------------

const PANEL_MIN_WIDTH_PX = 280;
const CHAT_MIN_WIDTH_PX = 280;
const PANEL_MIN_PERCENT = 10;
const CHAT_MIN_PERCENT = 15;
// react-resizable-panels' fine-pointer hit margin around the handle.
const HANDLE_HIT_MARGIN_PX = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * `DesktopSessionDetailLayout` without react-resizable-panels. The ghost demo
 * drags the handle with synthetic events: `pointerdown` on the handle, then
 * bubbling `pointermove`/`pointerup` on `document.body`, so the drag listens on
 * `window`. Sizes are percentages of the group, like the library's, and the
 * layout is not persisted (the landing remounts it per demo).
 */
export function ReplicaSessionLayout({
  topBar,
  chat,
  panel,
  panelOpen,
  defaultPanelPercent = 25,
}: {
  topBar: ReactNode;
  chat: ReactNode;
  /** Right-panel content (tab bar + body); wrapped in the bordered panel column here. */
  panel: ReactNode;
  panelOpen: boolean;
  defaultPanelPercent?: number;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const [panelPercent, setPanelPercent] = useState(defaultPanelPercent);
  const percentRef = useRef(panelPercent);
  percentRef.current = panelPercent;
  const openRef = useRef(panelOpen);
  openRef.current = panelOpen;
  const [handleState, setHandleState] = useState<'inactive' | 'hover' | 'drag'>('inactive');

  useEffect(() => {
    const handle = handleRef.current;
    const group = groupRef.current;
    if (!handle || !group) return undefined;
    let drag: { startX: number; startPercent: number; groupWidth: number } | null = null;

    const isOverHandle = (event: PointerEvent) => {
      const rect = handle.getBoundingClientRect();
      return (
        event.clientX >= rect.left - HANDLE_HIT_MARGIN_PX &&
        event.clientX <= rect.right + HANDLE_HIT_MARGIN_PX &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    };
    // Only the ghost's synthetic events paint hover: the real pointer never
    // reaches the inert frame, and skipping it avoids a layout read per mousemove.
    const syncHover = (event: PointerEvent) => {
      if (event.isTrusted) return;
      setHandleState(openRef.current && isOverHandle(event) ? 'hover' : 'inactive');
    };
    const onHandleDown = (event: PointerEvent) => {
      if (!openRef.current || !event.isPrimary || (event.buttons & 1) === 0) return;
      event.preventDefault();
      event.stopPropagation();
      // Screen-space width: the landing stage is CSS-scaled, and clientX deltas
      // are in the same scaled space.
      drag = {
        startX: event.clientX,
        startPercent: percentRef.current,
        groupWidth: group.getBoundingClientRect().width || 1,
      };
      setHandleState('drag');
    };
    const onMove = (event: PointerEvent) => {
      if (!drag) {
        syncHover(event);
        return;
      }
      // Pixel minimums are layout px, so they convert against the unscaled width.
      const layoutWidth = group.offsetWidth || 1;
      const min = Math.max(PANEL_MIN_PERCENT, (PANEL_MIN_WIDTH_PX / layoutWidth) * 100);
      const max = 100 - Math.max(CHAT_MIN_PERCENT, (CHAT_MIN_WIDTH_PX / layoutWidth) * 100);
      const delta = ((event.clientX - drag.startX) / drag.groupWidth) * 100;
      const next = clamp(drag.startPercent - delta, min, Math.max(min, max));
      percentRef.current = next;
      setPanelPercent(next);
    };
    const onUp = (event: PointerEvent) => {
      drag = null;
      syncHover(event);
    };
    const onDown = (event: PointerEvent) => {
      if (!drag) syncHover(event);
    };

    handle.addEventListener('pointerdown', onHandleDown);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      handle.removeEventListener('pointerdown', onHandleDown);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  useEffect(() => {
    if (!panelOpen) setHandleState('inactive');
  }, [panelOpen]);

  const isDragging = handleState === 'drag';
  const size = panelOpen ? panelPercent : 0;

  return (
    <div className="relative h-full w-full">
      <div
        ref={groupRef}
        data-slot="resizable-panel-group"
        data-panel-group-direction="horizontal"
        className="flex h-full w-full"
      >
        <div
          data-slot="resizable-panel"
          className="min-w-[280px] overflow-hidden"
          style={{ flex: `${100 - size} 1 0px` }}
        >
          <div className="group/close-scope flex h-full flex-col bg-background">
            {topBar}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-hidden">{chat}</div>
            </div>
          </div>
        </div>

        <div
          ref={handleRef}
          data-slot="resizable-handle"
          data-panel-group-direction="horizontal"
          data-resize-handle-state={handleState}
          aria-hidden="true"
          className={cn(
            'relative flex w-px items-center justify-center bg-transparent transition-opacity',
            'after:absolute after:inset-y-0 after:left-0 after:w-[2px] after:translate-x-0',
            'after:transition-colors after:duration-150',
            'data-[resize-handle-state=hover]:after:bg-sidebar-ring/50',
            'data-[resize-handle-state=hover]:after:delay-150',
            'data-[resize-handle-state=drag]:after:bg-sidebar-ring/70',
            panelOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
          style={{ transitionDuration: '220ms' }}
        />

        <div
          data-slot="resizable-panel"
          className={cn(
            'overflow-hidden bg-background motion-reduce:transition-none',
            !isDragging && 'transition-[flex-grow,min-width]'
          )}
          style={{
            flex: `${size} 1 0px`,
            minWidth: panelOpen ? PANEL_MIN_WIDTH_PX : 0,
            transitionDuration: isDragging ? '0ms' : '220ms',
            transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        >
          <div
            aria-hidden={!panelOpen}
            className={cn(
              'h-full transition-transform duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
              !panelOpen && 'pointer-events-none invisible translate-x-full'
            )}
          >
            <div className="group/close-scope flex h-full min-w-0 flex-col overflow-hidden border-l border-border/70 bg-background">
              {panel}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Right-panel tab strip -----------------------------------------------------

export type ReplicaSidePanelTab = {
  id: string;
  label: string;
  kind: 'files' | 'changes' | 'pr' | 'browser' | 'diff';
  closeable?: boolean;
};

function SidePanelTabIcon({ kind }: { kind: ReplicaSidePanelTab['kind'] }) {
  switch (kind) {
    case 'files':
      return <Files className="h-3.5 w-3.5 opacity-70" />;
    case 'changes':
    case 'diff':
      return <FileDiff className="h-3.5 w-3.5 opacity-70" />;
    case 'pr':
      return <GitPullRequest className="h-3.5 w-3.5 opacity-70" />;
    case 'browser':
      return <MonitorPlay className="h-3.5 w-3.5 opacity-70" />;
    default:
      return null;
  }
}

export function ReplicaSidePanelTabBar({
  tabs,
  activeTabId,
  endSlot,
  locale,
}: {
  tabs: ReplicaSidePanelTab[];
  activeTabId: string | null;
  endSlot?: ReactNode;
  locale: ReplicaLocale;
}) {
  const copy = SHELL_COPY[locale];
  return (
    <div className="@container/side-tabs flex h-11 min-w-0 items-center gap-1 border-b border-border/50 bg-background px-2">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div role="tablist" className="flex h-10 w-max min-w-full items-center gap-1.5">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                className={cn(
                  'group relative flex h-7 max-w-[180px] shrink-0 cursor-default items-center gap-1.5 rounded-md text-[0.9em] transition-colors @max-[420px]/side-tabs:max-w-[175px]',
                  tab.closeable ? 'px-3' : 'px-2',
                  active ? TAB_PILL_ACTIVE_CLASS : TAB_PILL_INACTIVE_CLASS
                )}
              >
                <span className="shrink-0">
                  <SidePanelTabIcon kind={tab.kind} />
                </span>
                <span
                  className={cn('truncate', tab.closeable && tab.kind === 'diff' && 'font-mono')}
                >
                  {tab.label}
                </span>
                {tab.closeable ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={copy.closeTab(tab.label)}
                    className={cn(
                      'ml-auto shrink-0 rounded-sm p-0.5 transition-[opacity,background-color,color]',
                      active ? 'opacity-100' : 'opacity-0'
                    )}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {/* The landing keeps every core panel pinned open, so "+" has nothing to add. */}
      <button
        type="button"
        disabled
        aria-label={copy.addPanel}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors disabled:cursor-default disabled:opacity-35"
      >
        <Plus className="h-4 w-4" />
      </button>
      {endSlot ? <div className="flex shrink-0 items-center">{endSlot}</div> : null}
    </div>
  );
}

// ---- Composer info bar --------------------------------------------------------

export type ReplicaInfoBarAction = { id: string; label: string };

const CHIP_BUTTON_CLASS =
  'flex h-6 shrink-0 select-none items-center gap-1 rounded-md px-1 text-xs transition-colors';

function InfoBarActions({
  actions,
  moreActionsLabel,
}: {
  actions: ReplicaInfoBarAction[];
  moreActionsLabel: string;
}) {
  const [primary, ...overflow] = actions;
  if (!primary) return null;
  return (
    <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-foreground/[0.08] bg-foreground/[0.03] dark:border-transparent dark:bg-muted-foreground/[0.08]">
      <button
        type="button"
        tabIndex={-1}
        title={primary.label}
        className="flex shrink-0 select-none items-center px-1.5 py-0.5 text-xs font-medium text-muted-foreground outline-none transition-colors dark:text-muted-foreground/80"
      >
        <span className="truncate">{primary.label}</span>
      </button>
      {overflow.length > 0 ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={moreActionsLabel}
          title={moreActionsLabel}
          className="relative flex w-5 shrink-0 items-center justify-center self-stretch text-muted-foreground/75 outline-none transition-colors before:absolute before:left-0 before:h-3 before:w-px before:bg-foreground/10 dark:before:bg-muted-foreground/15"
        >
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export type ReplicaSessionInfoBarProps = {
  projectName: string | null;
  /** `chat` sessions carry no project identity; `local` + `worktree` shows the worktree glyph. */
  projectKind: 'github' | 'local' | 'chat';
  branch: string | null;
  worktree: boolean;
  pr: { number: number; status: ReplicaPrStatus } | null;
  diffStat: { add: number; del: number } | null;
  actions: ReplicaInfoBarAction[];
  /** Emerald Browser chip (a dev server reported a preview candidate). */
  showBrowserAction: boolean;
  locale: ReplicaLocale;
  /** `mobile` = `MobileSessionView`'s bar: lifted over the drawer's edge-back strip, no PR/diff controls. */
  variant: 'desktop' | 'mobile';
};

/**
 * `SessionInfoBar` with only the context item staged (the landing never has a
 * status/goal/schedule item): `[Browser?] │ [PR|location] project · branch ±diff [actions]`.
 */
export function ReplicaSessionInfoBar({
  projectName,
  projectKind,
  branch,
  worktree,
  pr,
  diffStat,
  actions,
  showBrowserAction,
  locale,
  variant,
}: ReplicaSessionInfoBarProps) {
  const copy = SHELL_COPY[locale];
  const isDesktop = variant === 'desktop';
  const project = projectKind === 'chat' ? null : projectName;
  // Mobile drops the branch (`MobileSessionView` passes `branch={null}`).
  const trimmedBranch = isDesktop ? branch?.trim() || '' : '';
  const hasDiff = diffStat != null && diffStat.add + diffStat.del > 0;
  const hasContext = !!pr || !!project || !!trimmedBranch || hasDiff || actions.length > 0;

  // No items and no standalone action: the bar hides and keeps a 4px gap.
  if (!hasContext && !showBrowserAction) {
    return <div aria-hidden="true" className="h-1 w-full shrink-0" />;
  }

  const locationGlyph =
    projectKind === 'local' && worktree ? (
      <span className="flex h-6 shrink-0 select-none items-center px-1 text-muted-foreground">
        <WorktreeIcon className="h-3.5 w-3.5 shrink-0" />
      </span>
    ) : null;

  const prFace = pr ? (
    <>
      <ReplicaPrIcon status={pr.status} />
      <span className="hidden shrink-0 tabular-nums @[420px]:inline">#{pr.number}</span>
    </>
  ) : null;
  const prControl = pr ? (
    isDesktop ? (
      <button
        type="button"
        tabIndex={-1}
        className={cn(
          'flex h-6 shrink-0 select-none items-center gap-1 rounded-md px-1 text-xs font-semibold transition-colors',
          REPLICA_PR_STATUS_TEXT[pr.status]
        )}
      >
        {prFace}
      </button>
    ) : (
      <span
        className={cn(
          'flex h-6 shrink-0 items-center gap-1 px-1 font-semibold',
          REPLICA_PR_STATUS_TEXT[pr.status]
        )}
      >
        {prFace}
      </span>
    )
  ) : null;

  const iconBadge = prControl ?? locationGlyph ?? (
    <span className="flex h-6 shrink-0 select-none items-center gap-1 px-1 text-xs text-muted-foreground">
      <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </span>
  );

  const summary = (
    <span className="flex min-w-0 items-center gap-2 font-normal">
      {project ? (
        <span className="min-w-0 shrink-[2] truncate text-muted-foreground">{project}</span>
      ) : null}
      {trimmedBranch ? (
        <button
          type="button"
          tabIndex={-1}
          className="-mx-1 flex h-6 min-w-0 shrink items-center rounded-md px-1 text-foreground/85 transition-colors"
        >
          <span className="truncate">{trimmedBranch}</span>
        </button>
      ) : null}
      {hasDiff ? (
        <button
          type="button"
          tabIndex={-1}
          disabled={!isDesktop}
          aria-label={copy.allChanges}
          className="-mx-1 flex h-6 shrink-0 items-center gap-1 rounded-md px-1 tabular-nums transition-colors disabled:pointer-events-none"
        >
          <span className="text-code-added">+{diffStat.add}</span>
          <span className="text-code-removed">−{diffStat.del}</span>
        </button>
      ) : null}
    </span>
  );

  return (
    <div className={cn('w-full shrink-0 bg-background pb-2', !isDesktop && 'relative z-40')}>
      <div className="mx-auto w-full max-w-[46rem] px-[14px] sm:px-[18px]">
        <div className="@container flex h-8 w-full min-w-0 select-none items-center gap-1.5 rounded-lg border-[0.5px] border-foreground/[0.10] bg-[hsl(var(--composer))] px-2.5 text-xs shadow-[0_0.5px_1px_1px_rgba(0,0,0,0.04)] dark:border-input-border/45 dark:bg-input/70 dark:shadow-none">
          {showBrowserAction ? (
            // The ghost demo targets `button[aria-label="Browser"]` in every locale.
            <button
              type="button"
              tabIndex={-1}
              aria-label="Browser"
              title={copy.browser}
              className={cn(CHIP_BUTTON_CLASS, 'text-emerald-600 dark:text-emerald-400')}
            >
              <MonitorPlay className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </button>
          ) : null}
          {hasContext && showBrowserAction ? (
            <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-muted-foreground/25" />
          ) : null}
          {hasContext ? (
            <div className="flex min-w-0 flex-1 items-center">
              <div className="flex min-w-0 flex-1 items-center gap-1">
                {iconBadge}
                {pr ? locationGlyph : null}
                <span className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
                </span>
                {actions.length ? (
                  <InfoBarActions actions={actions} moreActionsLabel={copy.moreActions} />
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
