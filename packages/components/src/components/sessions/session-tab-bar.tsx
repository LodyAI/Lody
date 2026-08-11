import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Loader2, X, History, Undo2, Pin, FileDiff } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getSessionLaunchConfigLegacyFields,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { focusLayerAtom } from '@/atoms/focus-layer';
import { getAgentMetaByIdAtomFamily } from '@/atoms/agents';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { ScrollArea } from '@/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { AgentIcon } from '@/components/icons/agent-icon';
import { FileIcon } from '@/components/icons/file-icons';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type DraftSessionTab, getDraftTabLabel } from '@/lib/session-draft-tabs';
import { TAB_PILL_ACTIVE_CLASS, TAB_PILL_INACTIVE_CLASS } from '@/components/shared/tab-pill-strip';
import { AdaptiveTabStrip, AdaptiveTabStripItem } from './adaptive-tab-strip';

/** A viewer tab item (file or diff) displayed in the tab bar. */
export interface ViewerTabItem {
  id: string;
  type: 'file' | 'diff';
  label: string;
  filePath?: string;
  dirty?: boolean;
  saving?: boolean;
  conflict?: boolean;
}

type SessionTabBarVariant = 'mixed' | 'session' | 'viewer';
type MaybePromiseVoid = void | Promise<void>;

interface SessionTabBarProps {
  variant?: SessionTabBarVariant;
  parentSession: SessionMeta;
  childSessions: SessionMeta[];
  draftTabs: DraftSessionTab[];
  archivedChildSessions: SessionMeta[];
  activeTabSessionId: string;
  onTabSelect: (tabId: string) => MaybePromiseVoid;
  onNewTab: () => MaybePromiseVoid;
  onTabRename?: (sessionId: SessionId, title: string) => MaybePromiseVoid;
  onTabClose?: (tabId: string) => MaybePromiseVoid;
  onTabRestore?: (sessionId: SessionId) => MaybePromiseVoid;
  /** Unified tab order (session + viewer tab IDs). Called when any tabs are reordered via DnD. */
  onTabReorder?: (orderedTabIds: string[]) => void;
  /** Persisted unified tab order — determines display order of all sortable tabs. */
  tabOrder?: string[];
  /** Viewer tabs (file/diff) to display alongside session tabs */
  viewerTabs?: ViewerTabItem[];
  /** Currently active viewer tab id, or null if a session tab is active */
  activeViewerTabId?: string | null;
  /** Called when a viewer tab is selected */
  onViewerTabSelect?: (tabId: string) => MaybePromiseVoid;
  /** Called when a viewer tab is closed */
  onViewerTabClose?: (tabId: string) => MaybePromiseVoid;
  /** Optional element rendered at the far right of the tab bar. */
  rightSlot?: React.ReactNode;
  /** Optional element rendered before the tab list (e.g. sidebar expand). */
  leftSlot?: React.ReactNode;
  /** Extra classes on the bar root (e.g. macOS traffic-light inset). */
  className?: string;
}

/* One canvas: `bg-background` runs unbroken from this bar down through the
   message list, and the tabs sit ON it without breaking it. The ACTIVE tab is
   the heaviest thing in the row — it wears the app's floating-panel material
   (`bg-sidebar` + `border-sidebar-border` + the same drop shadow as the side
   panel and terminal dock), so "the one in a box" reads as the current page.
   Inactive tabs get a flat borderless wash and dimmed text; they must stay
   lighter-weight than the active tab, since chrome is what the eye scores as
   selected among siblings.

   Keep the surface ladder ordered — canvas → inactive → active — measured, not
   assumed. `bg-sidebar` gives light that ladder for free (canvas 241 → active
   229), but DARK needs the override: Vesper's sideBar is #161616, a mere 6
   above the #101010 canvas and BELOW the inactive wash (26), so the active pill
   rendered as a dent and only its border kept it legible. Hence the `dark:`
   pair, which lands canvas 16 → inactive 26 → active 42, border 70.
   `--tab-active`/`--tab-inactive` are useless here: both collapse onto
   `--background` in dark, which is what forced the original `/[0.22]` vs
   `/[0.12]` tints — a 10% gap that rendered as one gray.
   `border-transparent` on the base keeps every state on the same box model, so
   switching tabs never shifts a label by a pixel. */
const TAB_ITEM_CLASS =
  'group relative flex h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md border border-transparent px-3 text-[13px] transition-colors cursor-pointer';
// Colors are shared with TabPillStrip / TaskTabBar — same measured surface-
// ladder values, not independently eyeballed copies.
const TAB_ITEM_ACTIVE_CLASS = TAB_PILL_ACTIVE_CLASS;
const TAB_ITEM_INACTIVE_CLASS = TAB_PILL_INACTIVE_CLASS;
const TAB_INLINE_ACTION_CLASS =
  'ml-auto shrink-0 rounded-sm p-0.5 opacity-70 transition-[opacity,background-color,color] hover:bg-muted-foreground/10 hover:text-tab-hover-foreground hover:opacity-100';
const TAB_BAR_ACTION_CLASS =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-hover-foreground';

function getTabLabel(
  session: SessionMeta,
  isParent: boolean,
  defaultTitle: string,
  t?: (key: string, fallback: string) => string
): string {
  if (session.title?.trim()) return session.title.trim();
  if (isParent) return defaultTitle;
  return t?.('sessions.tabs.newTab', 'New Tab') ?? 'New Tab';
}

function formatRelativeTime(
  dateValue: number | string | undefined,
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string
): string {
  if (!dateValue) return '--';
  const date = typeof dateValue === 'number' ? new Date(dateValue) : new Date(dateValue);
  if (!Number.isFinite(date.getTime())) return '--';
  const diffMs = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t('sessions.tabs.justNow', 'just now');
  if (minutes < 60) return t('sessions.tabs.minutesAgo', '{{count}}m ago', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('sessions.tabs.hoursAgo', '{{count}}h ago', { count: hours });
  const days = Math.floor(hours / 24);
  return t('sessions.tabs.daysAgo', '{{count}}d ago', { count: days });
}

/** Shared tab content renderer (used by both parent tab and sortable child tabs). */
function TabContent({
  session,
  defaultTitle,
  isActive,
  isEditing,
  isParent,
  editDraft,
  iconVisibility,
  inputRef,
  onTabSelect,
  onTabRename,
  isL2Focus,
  onTabClose,
  setEditDraft,
  setEditingTabId,
  commitRename,
  cancelRename,
  solo,
  t,
}: {
  session: SessionMeta;
  defaultTitle: string;
  isActive: boolean;
  isEditing: boolean;
  isParent: boolean;
  solo: boolean;
  editDraft: string;
  iconVisibility: string;
  inputRef: React.RefObject<HTMLInputElement>;
  onTabSelect: (tabId: string) => MaybePromiseVoid;
  onTabRename?: (sessionId: SessionId, title: string) => MaybePromiseVoid;
  onTabClose?: (tabId: string) => MaybePromiseVoid;
  setEditDraft: (v: string) => void;
  setEditingTabId: (v: SessionId | null) => void;
  commitRename: () => void;
  cancelRename: () => void;
  isL2Focus: boolean;
  t: (key: string, fallback: string) => string;
}) {
  const liveStatus = useAtomValue(sessionLiveStatusAtomFamily(session.id));
  const isWorking = liveStatus != null;
  const isWaiting = liveStatus?.type === 'requestPermission';
  const label = getTabLabel(session, isParent, defaultTitle, t);
  const showClose = !isParent && onTabClose && !isEditing;
  const tabId = `session-tab-${session.id}`;
  const agentConfig = useAtomValue(getAgentMetaByIdAtomFamily(session.agentConfigId));
  const iconEnv = agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env;

  return (
    <div
      id={tabId}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      aria-label={label}
      className={cn(
        TAB_ITEM_CLASS,
        solo
          ? 'text-tab-active-foreground'
          : isActive
            ? TAB_ITEM_ACTIVE_CLASS
            : TAB_ITEM_INACTIVE_CLASS,
        isActive && isL2Focus && 'ring-2 ring-ring/40 ring-inset'
      )}
      onClick={() => {
        if (!isEditing) void onTabSelect(session.id);
      }}
      onKeyDown={(event) => {
        if (isEditing) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void onTabSelect(session.id);
        }
      }}
      onDoubleClick={() => {
        if (onTabRename) {
          setEditDraft(session.title?.trim() || '');
          setEditingTabId(session.id);
        }
      }}
    >
      <span className="shrink-0">
        {isWorking ? (
          <Loader2 className="h-3 w-3 animate-spin text-tab-active-accent" />
        ) : isWaiting ? (
          <span className="inline-block h-2 w-2 rounded-full bg-status-warning" />
        ) : (
          <AgentIcon
            cliType={session.cliType}
            agentType={session.agentType}
            env={iconEnv}
            className="h-3 w-3 opacity-60"
          />
        )}
      </span>
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editDraft}
          onChange={(e) => setEditDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') cancelRename();
          }}
          className="w-full min-w-0 bg-transparent outline-hidden text-[13px]"
        />
      ) : (
        <span className="truncate">{label}</span>
      )}
      {isParent && !isEditing && !solo && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn(TAB_INLINE_ACTION_CLASS, iconVisibility)}>
              <Pin className="h-3 w-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t('sessions.tabs.mainThread', 'Main thread — cannot be closed')}
          </TooltipContent>
        </Tooltip>
      )}
      {showClose && (
        <button
          type="button"
          className={cn(TAB_INLINE_ACTION_CLASS, iconVisibility)}
          onClick={(e) => {
            e.stopPropagation();
            void onTabClose?.(session.id);
          }}
          aria-label={t('sessions.tabs.closeTab', 'Close tab')}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function SessionAgentIcon({ session, className }: { session: SessionMeta; className?: string }) {
  const agentConfig = useAtomValue(getAgentMetaByIdAtomFamily(session.agentConfigId));
  return (
    <AgentIcon
      cliType={session.cliType}
      agentType={session.agentType}
      env={agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env}
      className={className}
    />
  );
}

function DraftTabContent({
  draft,
  isActive,
  isL2Focus,
  onSelect,
  onClose,
  t,
  solo,
}: {
  draft: DraftSessionTab;
  isActive: boolean;
  isL2Focus: boolean;
  solo: boolean;
  onSelect: (tabId: string) => MaybePromiseVoid;
  onClose?: (tabId: string) => MaybePromiseVoid;
  t: (key: string, fallback: string) => string;
}) {
  const showClose = onClose;
  const closeIconVisibility = isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';
  const label = getDraftTabLabel(draft, t('sessions.tabs.newTab', 'New Tab'));
  const tabId = `draft-tab-${draft.id}`;
  // Drafts carry no env snapshot of their own; resolve the chosen config so the
  // brand icon matches what the created session will show.
  const draftAgentConfig = useAtomValue(getAgentMetaByIdAtomFamily(draft.agentConfigId));

  return (
    <div
      id={tabId}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      aria-label={label}
      className={cn(
        TAB_ITEM_CLASS,
        solo
          ? 'text-tab-active-foreground'
          : isActive
            ? TAB_ITEM_ACTIVE_CLASS
            : TAB_ITEM_INACTIVE_CLASS,
        isActive && isL2Focus && 'ring-2 ring-ring/40 ring-inset'
      )}
      onClick={() => {
        void onSelect(draft.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void onSelect(draft.id);
        }
      }}
    >
      <span className="shrink-0">
        <AgentIcon
          cliType={draft.cliType}
          agentType={draft.agentType}
          brandId={draftAgentConfig?.brandId}
          env={draftAgentConfig?.env}
          className="h-3 w-3 opacity-60"
        />
      </span>
      <span className="truncate">{label}</span>
      {showClose && (
        <button
          type="button"
          className={cn(TAB_INLINE_ACTION_CLASS, closeIconVisibility)}
          onClick={(event) => {
            event.stopPropagation();
            void onClose(draft.id);
          }}
          aria-label={t('sessions.tabs.closeTab', 'Close tab')}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** Viewer tab content renderer (file/diff tabs). */
function ViewerTabContent({
  tab,
  isActive,
  isL2Focus,
  onSelect,
  onClose,
  t,
  solo,
}: {
  tab: ViewerTabItem;
  isActive: boolean;
  isL2Focus: boolean;
  solo: boolean;
  onSelect: (tabId: string) => MaybePromiseVoid;
  onClose?: (tabId: string) => MaybePromiseVoid;
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string;
}) {
  const showClose = onClose;
  const closeIconVisibility = isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';
  const tabId = `viewer-tab-${tab.id}`;
  const saveStateLabel = tab.saving
    ? t('sessions.fileViewer.tabSaving', 'Saving')
    : tab.conflict
      ? t('sessions.fileViewer.tabSaveProblem', 'Save needs attention')
      : tab.dirty
        ? t('sessions.fileViewer.tabUnsaved', 'Unsaved changes')
        : null;

  return (
    <div
      id={tabId}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      aria-label={saveStateLabel ? `${tab.label}, ${saveStateLabel}` : tab.label}
      className={cn(
        TAB_ITEM_CLASS,
        solo
          ? 'text-tab-active-foreground'
          : isActive
            ? TAB_ITEM_ACTIVE_CLASS
            : TAB_ITEM_INACTIVE_CLASS,
        isActive && isL2Focus && 'ring-2 ring-ring/40 ring-inset'
      )}
      onClick={() => {
        void onSelect(tab.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void onSelect(tab.id);
        }
      }}
    >
      <span className="shrink-0">
        {tab.type === 'file' && tab.filePath ? (
          <FileIcon filePath={tab.filePath} className="h-3 w-3" />
        ) : (
          <FileDiff className="h-3 w-3 opacity-60" />
        )}
      </span>
      {saveStateLabel ? (
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            tab.conflict
              ? 'bg-status-danger'
              : tab.saving
                ? 'bg-status-info animate-pulse'
                : 'bg-status-warning'
          )}
          title={saveStateLabel}
          aria-hidden="true"
        />
      ) : null}
      <span className="truncate font-mono">{tab.label}</span>
      {showClose && (
        <button
          type="button"
          className={cn(TAB_INLINE_ACTION_CLASS, closeIconVisibility)}
          onClick={(e) => {
            e.stopPropagation();
            void onClose(tab.id);
          }}
          aria-label={t('sessions.fileViewer.closeTab', 'Close {{fileName}}', {
            fileName: tab.label,
          })}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** Sortable DnD wrapper — used for both session and viewer tabs. */
function SortableDndWrapper({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, y: 0, scaleX: 1, scaleY: 1 } : null
    ),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  };

  return (
    <AdaptiveTabStripItem itemId={id} ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </AdaptiveTabStripItem>
  );
}

/** Union type for items in the unified sortable list. */
type SortableItemData =
  | { kind: 'session'; session: SessionMeta }
  | { kind: 'draft'; draft: DraftSessionTab }
  | { kind: 'viewer'; tab: ViewerTabItem };

export const SessionTabBar = memo(function SessionTabBar({
  variant = 'mixed',
  parentSession,
  childSessions,
  draftTabs,
  archivedChildSessions,
  activeTabSessionId,
  onTabSelect,
  onNewTab,
  onTabRename,
  onTabClose,
  onTabRestore,
  onTabReorder,
  tabOrder,
  viewerTabs,
  activeViewerTabId,
  onViewerTabSelect,
  onViewerTabClose,
  rightSlot,
  leftSlot,
  className,
}: SessionTabBarProps) {
  const { t } = useTranslation();
  const focusLayer = useAtomValue(focusLayerAtom);
  const defaultTitle = t('sessions.untitled', 'Untitled session');
  const showSessionTabs = variant !== 'viewer';
  const showViewerTabs = variant !== 'session';
  const showNewTabButton = variant !== 'viewer';
  const showArchivedTabs = variant !== 'viewer';
  const [editingTabId, setEditingTabId] = useState<SessionId | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null) as React.RefObject<HTMLInputElement>;

  // Build a unified sorted list of the tabs shown in this bar.
  const sortableItems = useMemo(() => {
    const sessionMap = showSessionTabs
      ? new Map<string, SortableItemData>(
          childSessions.map((s) => [s.id, { kind: 'session', session: s }])
        )
      : new Map<string, SortableItemData>();
    const draftMap = showSessionTabs
      ? new Map<string, SortableItemData>(
          draftTabs.map((draft) => [draft.id, { kind: 'draft', draft }])
        )
      : new Map<string, SortableItemData>();
    const viewerMap = showViewerTabs
      ? new Map<string, SortableItemData>(
          (viewerTabs ?? []).map((tab) => [tab.id, { kind: 'viewer', tab }])
        )
      : new Map<string, SortableItemData>();

    const result: { id: string; data: SortableItemData }[] = [];
    const seen = new Set<string>();

    // Items in persisted order first
    if (tabOrder) {
      for (const id of tabOrder) {
        if (seen.has(id)) continue;
        const sessionItem = sessionMap.get(id);
        if (sessionItem) {
          result.push({ id, data: sessionItem });
          seen.add(id);
          continue;
        }
        const draftItem = draftMap.get(id);
        if (draftItem) {
          result.push({ id, data: draftItem });
          seen.add(id);
          continue;
        }
        const viewerItem = viewerMap.get(id);
        if (viewerItem) {
          result.push({ id, data: viewerItem });
          seen.add(id);
        }
      }
    }

    // Then remaining items not yet in the order
    for (const [id, data] of sessionMap) {
      if (!seen.has(id)) result.push({ id, data });
    }
    for (const [id, data] of draftMap) {
      if (!seen.has(id)) result.push({ id, data });
    }
    for (const [id, data] of viewerMap) {
      if (!seen.has(id)) result.push({ id, data });
    }

    return result;
  }, [childSessions, draftTabs, showSessionTabs, showViewerTabs, tabOrder, viewerTabs]);

  const sortableIds = useMemo(() => sortableItems.map((i) => i.id), [sortableItems]);

  // A lone tab spans the whole row, so it drops the active fill — a full-width
  // pill would paint the entire bar and break the one-canvas rule. It also has
  // no sibling to switch to, so it hides the main-thread Pin marker.
  const soloTab = (showSessionTabs ? 1 : 0) + sortableItems.length === 1;

  useEffect(() => {
    if (editingTabId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTabId, inputRef]);

  const commitRename = useCallback(() => {
    if (!editingTabId || !onTabRename) return;
    const trimmed = editDraft.trim();
    if (trimmed) {
      void onTabRename(editingTabId, trimmed);
    }
    setEditingTabId(null);
  }, [editingTabId, editDraft, onTabRename]);

  const cancelRename = useCallback(() => {
    setEditingTabId(null);
  }, []);

  // DnD: require 5px movement before drag starts to avoid interfering with click
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = sortableIds.indexOf(active.id as string);
      const newIndex = sortableIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;
      const newOrder = arrayMove(sortableIds, oldIndex, newIndex);
      onTabReorder?.(newOrder);
    },
    [sortableIds, onTabReorder]
  );

  const iconVisibility = 'opacity-0 group-hover:opacity-100';

  const sharedTabProps = {
    defaultTitle,
    editDraft,
    iconVisibility,
    inputRef,
    onTabSelect,
    onTabRename,
    onTabClose,
    setEditDraft,
    setEditingTabId,
    commitRename,
    cancelRename,
    isL2Focus: focusLayer === 'L2',
    solo: soloTab,
    t: t as (key: string, fallback: string) => string,
  };

  // In mixed mode, an active viewer tab deselects the session tabs.
  const hasActiveViewerTab = variant === 'mixed' && !!activeViewerTabId;
  const visibleTabIds = useMemo(
    () => (showSessionTabs ? [parentSession.id, ...sortableIds] : sortableIds),
    [parentSession.id, showSessionTabs, sortableIds]
  );
  const activeTabId =
    showViewerTabs && activeViewerTabId
      ? activeViewerTabId
      : showSessionTabs
        ? activeTabSessionId
        : null;

  const newTabButton = showNewTabButton ? (
    <button
      type="button"
      className={TAB_BAR_ACTION_CLASS}
      onClick={() => {
        void onNewTab();
      }}
      aria-label={t('sessions.tabs.newTab', 'New tab')}
    >
      <Plus className="h-4 w-4" />
    </button>
  ) : null;

  return (
    <div className={cn('flex min-w-0 items-center bg-background', className)}>
      {leftSlot ? (
        <div className={cn('flex shrink-0 items-center pl-3', soloTab ? 'pr-0' : 'pr-2')}>
          {leftSlot}
        </div>
      ) : null}
      <AdaptiveTabStrip
        itemIds={visibleTabIds}
        activeItemId={activeTabId}
        role="tablist"
        aria-label={t('sessions.tabs.label', 'Session tabs')}
        className="h-11"
        paddingLeft={variant === 'session' ? 4 : 8}
        paddingRight={8}
      >
        {showSessionTabs && (
          <AdaptiveTabStripItem itemId={parentSession.id}>
            <TabContent
              session={parentSession}
              isActive={!hasActiveViewerTab && parentSession.id === activeTabSessionId}
              isEditing={editingTabId === parentSession.id}
              isParent={true}
              {...sharedTabProps}
            />
          </AdaptiveTabStripItem>
        )}
        {/* All sortable tabs (child sessions + viewer tabs) — unified DnD */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
            {sortableItems.map((item) =>
              item.data.kind === 'session' ? (
                <SortableDndWrapper key={item.id} id={item.id}>
                  <TabContent
                    session={item.data.session}
                    isActive={!hasActiveViewerTab && item.data.session.id === activeTabSessionId}
                    isEditing={editingTabId === item.data.session.id}
                    isParent={false}
                    {...sharedTabProps}
                  />
                </SortableDndWrapper>
              ) : item.data.kind === 'draft' ? (
                <SortableDndWrapper key={item.id} id={item.id}>
                  <DraftTabContent
                    draft={item.data.draft}
                    isActive={!hasActiveViewerTab && item.data.draft.id === activeTabSessionId}
                    isL2Focus={focusLayer === 'L2'}
                    solo={soloTab}
                    onSelect={onTabSelect}
                    onClose={onTabClose}
                    t={t as (key: string, fallback: string) => string}
                  />
                </SortableDndWrapper>
              ) : (
                <SortableDndWrapper key={item.id} id={item.id}>
                  <ViewerTabContent
                    tab={item.data.tab}
                    isActive={activeViewerTabId === item.data.tab.id}
                    isL2Focus={focusLayer === 'L2'}
                    solo={soloTab}
                    onSelect={onViewerTabSelect ?? (() => {})}
                    onClose={onViewerTabClose}
                    t={t}
                  />
                </SortableDndWrapper>
              )
            )}
          </SortableContext>
        </DndContext>
      </AdaptiveTabStrip>
      {/* Pinned right cluster: new-tab, then the archived-tabs history (only
          when closed tabs exist), then the caller's toolbar ("…" etc.). */}
      {newTabButton}
      {showArchivedTabs && archivedChildSessions.length > 0 && onTabRestore && (
        <ArchivedTabsPopover archivedSessions={archivedChildSessions} onRestore={onTabRestore} />
      )}
      {rightSlot}
    </div>
  );
});

function ArchivedTabsPopover({
  archivedSessions,
  onRestore,
}: {
  archivedSessions: SessionMeta[];
  onRestore: (sessionId: SessionId) => MaybePromiseVoid;
}) {
  const { t } = useTranslation();
  const sorted = useMemo(
    () => [...archivedSessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [archivedSessions]
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(TAB_BAR_ACTION_CLASS, 'relative')}
              aria-label={t('sessions.tabs.archivedTabs', 'Archived tabs')}
            >
              <History className="h-4 w-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('sessions.tabs.archivedTabs', 'Archived tabs')}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-0" sideOffset={4}>
        <div className="border-b border-border px-3 py-2">
          <p className="text-xs font-medium text-popover-foreground/70">
            {t('sessions.tabs.archivedTabs', 'Archived tabs')}
          </p>
        </div>
        <ScrollArea className="max-h-60">
          <div className="py-1">
            {sorted.map((session) => {
              const label = session.title?.trim() || t('sessions.tabs.newTab', 'New Tab');
              const time = formatRelativeTime(session.lastMessageAt ?? session.createdAt, t);
              return (
                <div
                  key={session.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-hover/60"
                >
                  <span className="shrink-0 text-popover-foreground/65">
                    <SessionAgentIcon session={session} className="h-3 w-3" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="shrink-0 text-popover-foreground/65">{time}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded-xs p-0.5 text-popover-foreground/70 transition-colors hover:bg-hover hover:text-hover-foreground"
                    onClick={() => {
                      void onRestore(session.id);
                    }}
                    aria-label={t('sessions.tabs.restoreTab', 'Restore tab')}
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
