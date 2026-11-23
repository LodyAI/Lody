import { corner as uiCorner, duration as uiMotion, radius as uiRadius, text as uiText } from '@lody/ui/tokens/scales.stylex';
import { colors as uiColors, shadow as uiShadow } from '@lody/ui/tokens/colors.stylex';
import { sidebarSectionHeaderMarker } from './sidebar-section-markers.stylex';
import { themeSpace as appSpace } from '../style/theme-scale.stylex';
import * as stylex from '@stylexjs/stylex';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { dndPointerPoint } from '@/lib/dnd-pointer';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { CSS as DndCss } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, FolderPlus, MoreHorizontal, Pencil, SquarePen, Trash2 } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { PIN_SECTION_NAME_MAX_LENGTH } from '@lody/shared';
import { createPortal } from 'react-dom';
import { Dialog } from '@/ui/dialog';
import {
  PINNED_DROP_FLIGHT_MS,
  PINNED_DROP_WAIT_MS,
  endPinnedDropSettle,
  getPinnedDropSettle,
  beginPinnedDropSettle,
  setPinnedPointerDrag,
  setPinnedPointerTarget,
  subscribePinnedDropSettle,
  type PinnedPointerTarget,
} from '@/lib/pinned-drop-settle';
import {
  armSessionMentionDrag,
  clearSessionMentionDrag,
  dropSessionMentionAtPoint,
} from '@/lib/session-mention-drag';
import {
  DEFAULT_PIN_SECTION_KEY,
  FOCUS_SECTION_DND_KEY,
  moveRowIntoSection,
  parsePinnedDndId,
  pinSectionDndId,
  pinSectionKey,
  sameRowOrder,
  type PinnedRowOrder,
} from './pinned-rows-dnd';
import { Menu } from '@/ui/menu';
import { Tooltip } from '@lody/ui/tooltip';
import { toast } from '@/lib/toast';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import {
  pinnedDropIndexAt,
  SidebarUpdatedSessionList,
  type SidebarPinSectionMenu,
  type SidebarUpdatedSessionListProps,
} from './sidebar-updated-session-list';
import type { SidebarUpdatedItem } from './sidebar-updated-session-list';

/** One pin section in display order; `id: null` is the default "Pinned" section. */
export type SidebarPinnedSection = {
  id: string | null;
  name: string;
  items: SidebarUpdatedItem[];
};

export type SidebarPinSectionActions = {
  /** A conversation dragged to `toIndex` of a section's pinned rows. */
  onDropItem: (itemId: string, sectionId: string | null, toIndex: number) => void;
  /** A user section dragged to `toIndex` among the user sections. */
  onMoveSection: (sectionId: string, toIndex: number) => void;
  onCreateSection: (name: string, moveItemId?: string) => void | Promise<void>;
  onRenameSection: (sectionId: string, name: string) => void | Promise<void>;
  onDeleteSection: (sectionId: string) => void;
  onNewChat?: (sectionId: string) => void;
};

type SharedListProps = Omit<
  SidebarUpdatedSessionListProps,
  | 'items'
  | 'labels'
  | 'grouping'
  | 'collapsedBuckets'
  | 'onToggleBucket'
  | 'toggleBucketLabel'
  | 'headerAction'
  | 'headerMenu'
  | 'pinSectionMenu'
  | 'pinSectionId'
  | 'onDropPinnedSession'
  | 'renderHeader'
  | 'footer'
>;

export type SidebarPinnedSectionsProps = {
  sections: readonly SidebarPinnedSection[];
  /**
   * Rows the current sidebar scope hides from each section, keyed by
   * `pinSectionKey(section.id)`. An expanded section with hidden rows shows a
   * quiet "N hidden in this view" line so a filtered-out section does not
   * look like an empty one.
   */
  hiddenCounts?: Readonly<Record<string, number>>;
  defaultLabel: string;
  defaultCollapsed: boolean;
  onToggleDefault?: () => void;
  collapsedSectionIds?: Readonly<Record<string, boolean>>;
  onToggleSection?: (sectionId: string) => void;
  /**
   * Sections hidden on this device, keyed by `pinSectionKey(section.id)`. A
   * hidden section can be restored from the visibility menu on the Pinned header.
   */
  hiddenSectionKeys?: Readonly<Record<string, boolean>>;
  /** Absent when hiding is unavailable; the header menu then offers no "Hide". */
  onSetSectionHidden?: (sectionKey: string, hidden: boolean) => void;
  /** The sidebar filter, rendered on the first header. */
  headerAction?: ReactNode;
  /** Absent when this viewer cannot manage pin sections. */
  actions?: SidebarPinSectionActions;
  /** Status view: a pinned row released over Focus is unpinned into Focus at `toIndex`. */
  onDropIntoFocus?: (sessionId: string, toIndex: number) => void;
  listProps: SharedListProps;
  emptyTitle: string;
  emptyDescription: string;
  className?: string;
};

type NameDialogTarget =
  | { kind: 'create'; moveItemId?: string }
  | { kind: 'rename'; sectionId: string; initialName: string };

/**
 * The pinned area: the default section, then the user's sections in their
 * stored order. Each section is one manually ordered list with its own fold.
 */
export const SidebarPinnedSections = memo(function SidebarPinnedSections({
  sections,
  hiddenCounts,
  defaultLabel,
  defaultCollapsed,
  onToggleDefault,
  collapsedSectionIds,
  onToggleSection,
  hiddenSectionKeys,
  onSetSectionHidden,
  headerAction,
  actions,
  onDropIntoFocus,
  listProps,
  emptyTitle,
  emptyDescription,
  className,
}: SidebarPinnedSectionsProps) {
  const { t } = useTranslation();
  const [nameDialog, setNameDialog] = useState<NameDialogTarget | null>(null);

  // Section ids and names only: `sections` is rebuilt on every session update,
  // and anything handed to memoized rows must not change with it.
  const sectionHeadsKey = sections
    .map((section) => `${section.id ?? ''}\u0000${section.name}`)
    .join('\u0001');
  const sectionHeads = useMemo(
    () => sections.map(({ id, name }) => ({ id, name })),
    [sectionHeadsKey]
  );
  const menuSections = useMemo(
    () =>
      sectionHeads.map((section) => ({
        id: section.id,
        name: section.id === null ? defaultLabel : section.name,
      })),
    [defaultLabel, sectionHeads]
  );
  const menuLabels = useMemo(
    () => ({
      moveToSection: t('sidebar.pinSections.moveToSection', 'Move to Section'),
      newSection: t('sidebar.pinSections.newSection', 'New Section…'),
    }),
    [t]
  );
  const onDropItem = actions?.onDropItem;
  const hiddenSectionKeysRef = useLatestRef(hiddenSectionKeys);
  // "Move to Section" puts the conversation at the top of that section, and
  // shows that section again if it was hidden so the conversation stays in view.
  const moveToSectionTop = useCallback(
    (itemId: string, sectionId: string | null) => {
      const key = pinSectionKey(sectionId);
      if (hiddenSectionKeysRef.current?.[key]) onSetSectionHidden?.(key, false);
      onDropItem?.(itemId, sectionId, 0);
    },
    [hiddenSectionKeysRef, onDropItem, onSetSectionHidden]
  );
  const openCreate = useCallback((itemId: string) => {
    setNameDialog({ kind: 'create', moveItemId: itemId });
  }, []);
  // One stable menu object per section keeps memoized rows from re-rendering.
  const menuBySection = useMemo(() => {
    const menus = new Map<string | null, SidebarPinSectionMenu>();
    if (!onDropItem) return menus;
    for (const section of sectionHeads) {
      menus.set(section.id, {
        sections: menuSections,
        currentSectionId: section.id,
        onMove: moveToSectionTop,
        onCreate: openCreate,
        labels: menuLabels,
      });
    }
    return menus;
  }, [menuLabels, menuSections, moveToSectionTop, onDropItem, openCreate, sectionHeads]);

  const dropBySection = useMemo(() => {
    const handlers = new Map<string | null, (sessionId: string, toIndex: number) => void>();
    if (!onDropItem || listProps.isMobile) return handlers;
    for (const section of sectionHeads) {
      handlers.set(section.id, (sessionId, toIndex) => onDropItem(sessionId, section.id, toIndex));
    }
    return handlers;
  }, [listProps.isMobile, onDropItem, sectionHeads]);

  // ---- Drag and drop (dnd-kit): rows within and across sections, and sections.
  const canDragRows = Boolean(onDropItem) && !listProps.isMobile;
  const onMoveSection = actions?.onMoveSection;
  const canSortSections = Boolean(onMoveSection) && !listProps.isMobile;

  const propsOrder = useMemo<PinnedRowOrder>(
    () =>
      Object.fromEntries(
        sections.map((section) => [
          pinSectionKey(section.id),
          section.items.filter((item) => item.isPinned).map((item) => item.id),
        ])
      ),
    [sections]
  );
  const rowsById = useMemo(() => {
    const items = new Map<string, SidebarUpdatedItem>();
    const carried = new Map<string, SidebarUpdatedItem[]>();
    for (const section of sections) for (const item of section.items) items.set(item.id, item);
    const pinnedOwnerOf = (item: SidebarUpdatedItem): string | null => {
      const seen = new Set<string>();
      let cursor: SidebarUpdatedItem | undefined = item;
      while (cursor && !cursor.isPinned && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        cursor = cursor.openedByRowSessionId ? items.get(cursor.openedByRowSessionId) : undefined;
      }
      return cursor?.isPinned ? cursor.id : null;
    };
    for (const item of items.values()) {
      if (item.isPinned) continue;
      const owner = pinnedOwnerOf(item);
      if (owner) carried.set(owner, [...(carried.get(owner) ?? []), item]);
    }
    return { items, carried };
  }, [sections]);
  // After a drop the sidebar shows the result until the written order is read
  // back, so neither a row nor a section snaps back to where it came from.
  const [pendingOrder, setPendingOrder] = usePendingUntil(propsOrder, sameRowOrder);
  const rowOrder = pendingOrder ?? propsOrder;
  const itemsBySection = useMemo(() => {
    const bySection = new Map<string, SidebarUpdatedItem[]>();
    for (const [key, ids] of Object.entries(rowOrder)) {
      bySection.set(
        key,
        ids.flatMap((id) => {
          const item = rowsById.items.get(id);
          return item ? [item, ...(rowsById.carried.get(id) ?? [])] : [];
        })
      );
    }
    return bySection;
  }, [rowOrder, rowsById]);
  const itemsOf = (sectionId: string | null): SidebarUpdatedItem[] =>
    itemsBySection.get(pinSectionKey(sectionId)) ?? EMPTY_ITEMS;

  const propsSectionIds = useMemo(
    () => sectionHeads.flatMap((section) => (section.id === null ? [] : [section.id])),
    [sectionHeads]
  );
  const [pendingSectionIds, setPendingSectionIds] = usePendingUntil(propsSectionIds, sameIds);
  const userSectionIds = pendingSectionIds ?? propsSectionIds;

  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [activeGhost, setActiveGhost] = useState<HTMLElement | null>(null);
  const rowOrderRef = useLatestRef(rowOrder);
  const allowFocusTarget = typeof onDropIntoFocus === 'function';

  // Pointer only: rows and section headers hold their own Enter/Space.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // The real pointer, not dnd-kit's delta (which folds in its own adjustments).
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const stopPointerTracking = useRef<(() => void) | null>(null);
  const pointerOf = (event: DragEndEvent | DragMoveEvent) =>
    pointerRef.current ?? dndPointerPoint(event);

  const endPointerDrag = useCallback(() => {
    stopPointerTracking.current?.();
    stopPointerTracking.current = null;
    pointerRef.current = null;
    setActiveRow(null);
    setActiveGhost(null);
    setPinnedPointerTarget(null);
    clearSessionMentionDrag();
    setPinnedPointerDrag(false);
  }, []);

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    setPinnedPointerDrag(true);
    const track = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('pointermove', track, true);
    stopPointerTracking.current = () => window.removeEventListener('pointermove', track, true);
    const target = parsePinnedDndId(active.id);
    if (target?.kind !== 'row') return;
    setActiveRow(target.id);
    // The overlay is a copy of the slot as it looked when it was picked up.
    const slot = Array.from(document.querySelectorAll('[data-pin-node]')).find(
      (node) => node.getAttribute('data-pin-node') === target.id
    );
    const ghost = slot ? (slot.cloneNode(true) as HTMLElement) : null;
    if (ghost) {
      // The copy keeps the row's look, not its drag state.
      ghost.style.transform = '';
      ghost.style.transition = '';
      ghost.style.opacity = '';
      ghost.style.pointerEvents = 'none';
    }
    setActiveGhost(ghost);
    // The row's slot closes and conversation surfaces light up, as for a native drag.
    armSessionMentionDrag(target.id);
  }, []);

  // Aim the drag at the section under the pointer: its rows open a gap there.
  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const dragged = parsePinnedDndId(event.active.id);
      if (dragged?.kind !== 'row') return;
      const point = pointerOf(event);
      setPinnedPointerTarget(
        point ? pinnedPointerTargetAt(point, dragged.id, allowFocusTarget) : null
      );
    },
    [allowFocusTarget]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const dragged = parsePinnedDndId(event.active.id);
      if (dragged?.kind === 'section') {
        const target = parsePinnedDndId(event.over?.id);
        endPointerDrag();
        if (!onMoveSection || target?.kind !== 'section' || target.id === dragged.id) return;
        const from = userSectionIds.indexOf(dragged.id);
        const to = userSectionIds.indexOf(target.id);
        if (from < 0 || to < 0) return;
        setPendingSectionIds(arrayMove(userSectionIds, from, to));
        onMoveSection(dragged.id, to);
        return;
      }
      if (dragged?.kind !== 'row') {
        endPointerDrag();
        return;
      }
      const point = pointerOf(event);
      // Released over a conversation or the new-chat composer: a mention, not a move.
      if (point && dropSessionMentionAtPoint(point.x, point.y, dragged.id)) {
        endPointerDrag();
        return;
      }
      const lifted = event.active.rect.current.translated;
      const order = rowOrderRef.current;
      // Released outside the pinned area, nothing moves: the copy flies home.
      const target =
        (point ? pinnedPointerTargetAt(point, dragged.id, allowFocusTarget) : null) ??
        homeTargetOf(order, dragged.id);
      if (!target || !lifted) {
        endPointerDrag();
        return;
      }
      const settle = {
        sessionId: dragged.id,
        toSectionId: target.sectionId,
        toIndex: target.index,
        from: { left: lifted.left, top: lifted.top, width: lifted.width, height: lifted.height },
        ghost: activeGhost,
        fromBackground: liftedBackground(),
        fromShadow: uiShadow.popover,
      };
      if (target.sectionId === FOCUS_SECTION_DND_KEY) {
        beginPinnedDropSettle(settle);
        setPendingOrder(
          Object.fromEntries(
            Object.entries(order).map(([key, ids]) => [key, ids.filter((id) => id !== dragged.id)])
          )
        );
        endPointerDrag();
        onDropIntoFocus?.(dragged.id, target.index);
        return;
      }
      const sectionKey = pinSectionKey(target.sectionId);
      const next = moveRowIntoSection(order, dragged.id, sectionKey, target.index);
      // The lifted copy flies from where it was released into the row's new slot.
      beginPinnedDropSettle(settle);
      setPendingOrder(next);
      endPointerDrag();
      if (!sameRowOrder(next, propsOrder)) {
        onDropItem?.(dragged.id, target.sectionId, target.index);
      }
    },
    [
      activeGhost,
      allowFocusTarget,
      endPointerDrag,
      onDropIntoFocus,
      onDropItem,
      onMoveSection,
      propsOrder,
      rowOrderRef,
      setPendingOrder,
      setPendingSectionIds,
      userSectionIds,
    ]
  );

  const handleDragCancel = useCallback(() => {
    endPointerDrag();
  }, [endPointerDrag]);

  const hasUserSections = sections.some((section) => section.id !== null);
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const orderedSections = [
    ...sections.filter((section) => section.id === null),
    ...userSectionIds.flatMap((id) => {
      const section = sectionById.get(id);
      return section ? [section] : [];
    }),
  ];
  const presentSections = orderedSections.filter(
    (section) =>
      section.id !== null ||
      onSetSectionHidden ||
      itemsOf(section.id).length > 0 ||
      !hasUserSections
  );
  const isHidden = (section: SidebarPinnedSection) =>
    hiddenSectionKeys?.[pinSectionKey(section.id)] === true;
  const visibleSections = presentSections.filter(
    (section) => section.id === null || !isHidden(section)
  );
  const visibilityEntries = onSetSectionHidden
    ? presentSections.map((section) => ({
        key: pinSectionKey(section.id),
        name: section.id === null ? defaultLabel : section.name,
        visible: !isHidden(section),
      }))
    : [];
  const onNewChat = listProps.isMobile ? undefined : actions?.onNewChat;
  const sectionMenuFor = (section: SidebarPinnedSection) => {
    if (!actions && !onSetSectionHidden) return null;
    const sectionId = section.id;
    return (
      <PinSectionHeaderMenu
        label={t('sidebar.pinSections.sectionActions', 'Section actions')}
        revealOnHover={!listProps.isMobile}
        onNewChat={onNewChat && sectionId !== null ? () => onNewChat(sectionId) : undefined}
        onNewSection={actions ? () => setNameDialog({ kind: 'create' }) : undefined}
        onHide={
          sectionId !== null && onSetSectionHidden
            ? () => onSetSectionHidden(pinSectionKey(sectionId), true)
            : undefined
        }
        onRename={
          actions && sectionId
            ? () => setNameDialog({ kind: 'rename', sectionId, initialName: section.name })
            : undefined
        }
        onDelete={actions && sectionId ? () => actions.onDeleteSection(sectionId) : undefined}
        visibility={sectionId === null ? visibilityEntries : undefined}
        onSetVisible={(key, visible) => onSetSectionHidden?.(key, !visible)}
      />
    );
  };

  return (
    <div className={className}>
      <DndContext
        sensors={sensors}
        collisionDetection={pinnedCollisionDetection}
        // The sidebar viewport owns edge scrolling (`useSessionDragAutoScroll`);
        // two scrollers on one container would double the speed.
        autoScroll={false}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={visibleSections.flatMap((section) =>
            section.id === null ? [] : [pinSectionDndId(section.id)]
          )}
          strategy={verticalListSortingStrategy}
        >
          {visibleSections.map((section, index) => {
            const sectionId = section.id;
            const isDefault = sectionId === null;
            const sectionKey = pinSectionKey(sectionId);
            const sectionItems = itemsOf(sectionId);
            // Keep the Pinned menu mounted when its own checkbox hides the default list.
            const headerOnly =
              isDefault && (isHidden(section) || (hasUserSections && sectionItems.length === 0));
            const items = headerOnly ? EMPTY_ITEMS : sectionItems;
            const collapsed =
              headerOnly ||
              (isDefault ? defaultCollapsed : Boolean(collapsedSectionIds?.[sectionId]));
            const label = isDefault ? defaultLabel : section.name;
            const menu = sectionMenuFor(section);
            const action = index === 0 ? headerAction : undefined;
            const hiddenCount = collapsed ? 0 : (hiddenCounts?.[sectionKey] ?? 0);
            const list = (renderHeader?: (header: ReactElement) => ReactNode) => (
              <SidebarUpdatedSessionList
                {...listProps}
                renderHeader={renderHeader}
                onDropPinnedSession={headerOnly ? undefined : dropBySection.get(sectionId)}
                // Same gap between sections as between the sidebar's other groups.
                className={
                  // Padding, not margin: the space between sections stays part of a
                  // drop target, so a drag crossing it never shows "no drop".
                  stylex.props(index < visibleSections.length - 1 && (collapsed ? pinStyles.foldedGap : pinStyles.sectionGap)).className
                }
                items={items}
                grouping="manual"
                pinSectionId={headerOnly ? undefined : sectionId}
                pinSectionMenu={menuBySection.get(sectionId)}
                showPinnedIcon={false}
                labels={{ heading: label, emptyTitle, emptyDescription }}
                collapsedBuckets={collapsed ? COLLAPSED : undefined}
                onToggleBucket={
                  headerOnly
                    ? undefined
                    : isDefault
                      ? onToggleDefault
                      : sectionId && onToggleSection
                        ? () => onToggleSection(sectionId)
                        : undefined
                }
                toggleBucketLabel={label}
                headerMenu={menu}
                headerAction={action}
                footer={
                  hiddenCount > 0 ? (
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        render={
                          <div
                            data-pin-section-hidden-count=""
                            aria-label={t(
                              'sidebar.pinSections.hiddenByScopeHint',
                              'Filtered out by the current view — show all tasks to see them'
                            )}
                            // The row grid: px-2 padding + the 14px leading
                            // slot + gap-2 puts this line on the title edge.
                            {...stylex.props(sectionStyles.hiddenRowsHint)}
                          >
                            <span {...stylex.props(sectionStyles.leadingSpacer)} aria-hidden="true" />
                            <span {...stylex.props(sectionStyles.truncatedLabel)}>
                              {t('sidebar.pinSections.hiddenByScope', '{{count}} sessions hidden', {
                                count: hiddenCount,
                              })}
                            </span>
                          </div>
                        }
                      />
                      <Tooltip.Content>
                        {t(
                          'sidebar.pinSections.hiddenByScopeHint',
                          'Filtered out by the current view — show all tasks to see them'
                        )}
                      </Tooltip.Content>
                    </Tooltip.Root>
                  ) : null
                }
              />
            );
            return sectionId === null || !canSortSections ? (
              <Fragment key={sectionKey}>{list()}</Fragment>
            ) : (
              <SortablePinSection key={sectionId} id={sectionId}>
                {list}
              </SortablePinSection>
            );
          })}
        </SortableContext>
        {canDragRows && typeof document !== 'undefined'
          ? createPortal(
              <DragOverlay dropAnimation={null} zIndex={60}>
                {activeRow ? <PinnedRowGhost source={activeGhost} /> : null}
              </DragOverlay>,
              document.body
            )
          : null}
      </DndContext>
      {listProps.isMobile ? null : <PinnedDropFlight />}
      {actions ? (
        <PinSectionNameDialog
          target={nameDialog}
          onClose={() => setNameDialog(null)}
          onSubmit={async (name) => {
            if (!nameDialog) return;
            if (nameDialog.kind === 'create') {
              await actions.onCreateSection(name, nameDialog.moveItemId);
            } else {
              await actions.onRenameSection(nameDialog.sectionId, name);
            }
          }}
        />
      ) : null}
    </div>
  );
});

const COLLAPSED = { all: true } as const;

const EMPTY_ITEMS: SidebarUpdatedItem[] = [];
const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/**
 * A value shown in place of `actual` until `actual` catches up with it (the
 * write was read back) or the drop's wait runs out.
 */
function usePendingUntil<T>(
  actual: T,
  equals: (left: T, right: T) => boolean
): [T | null, (next: T) => void] {
  const [pending, setPending] = useState<T | null>(null);
  useEffect(() => {
    if (pending !== null && equals(pending, actual)) setPending(null);
  }, [actual, equals, pending]);
  useEffect(() => {
    if (pending === null) return undefined;
    const timer = setTimeout(() => setPending(null), PINNED_DROP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  return [pending, setPending];
}

/** Sections meet sections; rows aim by pointer position (`pinnedPointerTargetAt`). */
const pinnedCollisionDetection: CollisionDetection = (args) =>
  closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => parsePinnedDndId(container.id)?.kind === 'section'
    ),
  });

/**
 * The pin section (or Focus, when `allowFocusTarget` is true) under `point` and
 * the drop index there. Found by geometry: during a drag the sections ignore
 * the pointer (hover is held off).
 */
function pinnedPointerTargetAt(
  point: { x: number; y: number },
  draggedId: string,
  allowFocusTarget: boolean
): PinnedPointerTarget | null {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-pin-section]'))) {
    const box = element.getBoundingClientRect();
    if (point.x < box.left || point.x >= box.right || point.y < box.top || point.y >= box.bottom) {
      continue;
    }
    const attr = element.getAttribute('data-pin-section');
    if (attr === FOCUS_SECTION_DND_KEY && !allowFocusTarget) continue;
    const sectionId = attr === DEFAULT_PIN_SECTION_KEY ? null : attr;
    const rows = element.querySelector<HTMLElement>('[data-pin-rows]');
    return { sectionId, index: pinnedDropIndexAt(rows, point.y, draggedId) };
  }
  return null;
}

/** Where a row sits now: its section and its index among the section's other rows. */
function homeTargetOf(order: PinnedRowOrder, rowId: string): PinnedPointerTarget | null {
  for (const [key, ids] of Object.entries(order)) {
    const index = ids.indexOf(rowId);
    if (index >= 0) return { sectionId: key === DEFAULT_PIN_SECTION_KEY ? null : key, index };
  }
  return null;
}

/** The lifted copy's fill, so the landing eases from it to the row's own. */
function liftedBackground(): string | null {
  const overlay = document.querySelector('[data-pin-drag-overlay]');
  return overlay ? getComputedStyle(overlay).backgroundColor : null;
}

/** The lifted row that follows the pointer: a copy of the slot, raised. */
function PinnedRowGhost({ source }: { source: HTMLElement | null }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (bodyRef.current && source) bodyRef.current.replaceChildren(source);
  }, [source]);
  return (
    <div
      ref={bodyRef}
      data-pin-drag-overlay=""
      {...stylex.props(sectionStyles.dragSurface)}
      style={{ boxShadow: uiShadow.popover, cursor: 'grabbing' }}
    />
  );
}

const readNoSettle = () => null;

/**
 * The landing of a dropped conversation: a copy of the row travels from where
 * the drag image was released into its slot, its fill easing from the dragged
 * look to the row's resting one, while the real row waits invisible beneath.
 */
function PinnedDropFlight() {
  const settle = useSyncExternalStore(subscribePinnedDropSettle, getPinnedDropSettle, readNoSettle);
  const flying = settle?.phase === 'flying' && settle.to ? settle : null;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [landed, setLanded] = useState(false);

  useLayoutEffect(() => {
    if (!flying) return undefined;
    setLanded(false);
    const body = bodyRef.current;
    if (body && flying.ghost) {
      const ghost = flying.ghost.cloneNode(true) as HTMLElement;
      // The wrapper owns the fill, so the copy's own background cannot jump.
      ghost.style.background = 'transparent';
      ghost.style.pointerEvents = 'none';
      body.replaceChildren(ghost);
    }
    // Start from the release point, then move on the next frame.
    const frame = requestAnimationFrame(() => setLanded(true));
    const fallback = setTimeout(endPinnedDropSettle, PINNED_DROP_FLIGHT_MS + 200);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
    };
  }, [flying]);

  if (!flying || !flying.to || typeof document === 'undefined') return null;
  const { from, to } = flying;
  const transition = `transform ${PINNED_DROP_FLIGHT_MS}ms ease-out, background-color ${PINNED_DROP_FLIGHT_MS}ms ease-out, box-shadow ${PINNED_DROP_FLIGHT_MS}ms ease-out`;
  return createPortal(
    <div
      aria-hidden="true"
      data-pin-drop-flight=""
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget) endPinnedDropSettle();
      }}
      style={{
        position: 'fixed',
        left: to.left,
        top: to.top,
        width: to.width,
        height: to.height,
        zIndex: 60,
        pointerEvents: 'none',
        overflow: 'hidden',
        borderRadius: flying.radius,
        transform: landed ? 'none' : `translate(${from.left - to.left}px, ${from.top - to.top}px)`,
        backgroundColor: (landed ? flying.toBackground : flying.fromBackground) ?? undefined,
        boxShadow: flying.fromShadow ? (landed ? 'none' : flying.fromShadow) : undefined,
        transition: landed ? transition : 'none',
      }}
    >
      <div ref={bodyRef} />
    </div>,
    document.body
  );
}

/**
 * A user section that can be dragged by its header. Only the header carries
 * the pointer listeners: its rows are separate draggables (`DraggablePinnedRowSlot`).
 */
function SortablePinSection({
  id,
  children,
}: {
  id: string;
  children: (renderHeader: (header: ReactElement) => ReactNode) => ReactNode;
}) {
  // No `attributes`: the header already holds its own buttons, and a second
  // focusable button role around them would only add a dead tab stop.
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: pinSectionDndId(id) });
  const renderHeader = useCallback(
    (header: ReactElement) => (
      <div ref={setActivatorNodeRef} {...listeners} data-pin-section-handle="">
        {header}
      </div>
    ),
    [listeners, setActivatorNodeRef]
  );
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: DndCss.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      {children(renderHeader)}
    </div>
  );
}

function PinSectionHeaderMenu({
  label,
  revealOnHover,
  onNewChat,
  onNewSection,
  onHide,
  onRename,
  onDelete,
  visibility,
  onSetVisible,
}: {
  label: string;
  /** Pointer surfaces show the ⋯ only while its header row is hovered, focused or open. */
  revealOnHover: boolean;
  onNewChat?: () => void;
  /** Absent for viewers who cannot manage sections. */
  onNewSection?: () => void;
  onHide?: () => void;
  /** Absent for the default section, which cannot be renamed or deleted. */
  onRename?: () => void;
  onDelete?: () => void;
  /** Every section with whether it is shown on this device; each row toggles it. */
  visibility?: readonly { key: string; name: string; visible: boolean }[];
  onSetVisible: (sectionKey: string, visible: boolean) => void;
}) {
  const { t } = useTranslation();
  const entries = visibility ?? [];
  const hasHiddenSections = entries.some((entry) => !entry.visible);
  return (
    <Menu.Root>
      <span
        {...stylex.props(pinStyles.menuHost, revealOnHover && pinStyles.menuReveal)}
      >
        <Menu.Trigger
          render={
            <Button type="button" variant="ghost" size="mini" icon aria-label={label}>
              <MoreHorizontal {...stylex.props(sectionStyles.menuGlyph)} strokeWidth={1.5} />
            </Button>
          }
        />
      </span>
      <Menu.Content align="end" xstyle={sectionStyles.sectionMenu}>
        {onNewChat ? (
          <>
            <Menu.Item icon={SquarePen} onClick={onNewChat}>
              {t('sidebar.pinSections.newChat', 'New Chat in This Section')}
            </Menu.Item>
            <Menu.Separator />
          </>
        ) : null}
        {onNewSection ? (
          <Menu.Item icon={FolderPlus} onClick={onNewSection}>
            {t('sidebar.pinSections.newSection', 'New Section…')}
          </Menu.Item>
        ) : null}
        {onHide ? (
          <Menu.Item icon={EyeOff} onClick={onHide}>
            {t('sidebar.pinSections.hide', 'Hide Section')}
          </Menu.Item>
        ) : null}
        {onRename ? (
          <Menu.Item icon={Pencil} onClick={onRename}>
            {t('sidebar.pinSections.rename', 'Rename Section')}
          </Menu.Item>
        ) : null}
        {onDelete ? (
          <Menu.Item icon={Trash2} onClick={onDelete}>
            {t('sidebar.pinSections.delete', 'Delete Section')}
          </Menu.Item>
        ) : null}
        {entries.length > 0 ? (
          <>
            {onNewSection || onHide || onRename || onDelete ? <Menu.Separator /> : null}
            <Menu.Submenu>
              <Menu.SubmenuTrigger icon={Eye}>
                {t('sidebar.pinSections.visibleSections', 'Visible Sections')}
              </Menu.SubmenuTrigger>
              <Menu.Content xstyle={sectionStyles.visibilityMenu}>
                {entries.map((entry) => (
                  <Menu.CheckboxItem
                    key={entry.key}
                    checked={entry.visible}
                    closeOnClick={false}
                    indicator="checkbox"
                    onCheckedChange={(checked) => onSetVisible(entry.key, checked)}
                  >
                    {entry.name}
                  </Menu.CheckboxItem>
                ))}
                {hasHiddenSections && entries.length > 1 ? (
                  <>
                    <Menu.Separator />
                    <Menu.Item
                      onClick={() => {
                        for (const entry of entries) {
                          if (!entry.visible) onSetVisible(entry.key, true);
                        }
                      }}
                    >
                      {t('sidebar.pinSections.showAll', 'Show All')}
                    </Menu.Item>
                  </>
                ) : null}
              </Menu.Content>
            </Menu.Submenu>
          </>
        ) : null}
      </Menu.Content>
    </Menu.Root>
  );
}

function PinSectionNameDialog({
  target,
  onClose,
  onSubmit,
}: {
  target: NameDialogTarget | null;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const initialName = target?.kind === 'rename' ? target.initialName : '';
  const [draft, setDraft] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [openFor, setOpenFor] = useState<NameDialogTarget | null>(null);
  if (target !== openFor) {
    // Reset the field whenever the dialog opens for a new target.
    setOpenFor(target);
    setDraft(initialName);
    setSaving(false);
  }
  const name = draft.trim();
  const submit = async () => {
    if (!name || saving) return;
    try {
      setSaving(true);
      await onSubmit(name);
      onClose();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Content xstyle={sectionStyles.nameDialog}>
        <Dialog.Header xstyle={sectionStyles.nameDialogHeader}>
          <Dialog.Title>
            {target?.kind === 'rename'
              ? t('sidebar.pinSections.renameTitle', 'Rename Section')
              : t('sidebar.pinSections.createTitle', 'New Section')}
          </Dialog.Title>
        </Dialog.Header>
        <div {...stylex.props(sectionStyles.nameDialogBody)}>
          <Input
            autoFocus
            value={draft}
            disabled={saving}
            maxLength={PIN_SECTION_NAME_MAX_LENGTH}
            placeholder={t('sidebar.pinSections.namePlaceholder', 'Section name')}
            aria-label={t('sidebar.pinSections.namePlaceholder', 'Section name')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isImeComposingKeyboardEvent(event)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        <Dialog.Footer xstyle={sectionStyles.nameDialogFooter}>
          <Button variant="secondary" size="small" onClick={onClose} disabled={saving}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button size="small" onClick={() => void submit()} disabled={saving || !name}>
            {t('common.save', 'Save')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

const sectionStyles = stylex.create({
  hiddenRowsHint: { display: 'flex', cursor: 'default', userSelect: 'none', alignItems: 'center', gap: appSpace[2], paddingInline: appSpace[2], paddingBottom: appSpace[0.5], paddingTop: appSpace[1], fontSize: uiText.footnoteSize, lineHeight: uiText.footnoteLeading, color: uiColors.secondaryLabel },
  leadingSpacer: { width: appSpace[3.5], flexShrink: 0 },
  truncatedLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dragSurface: { overflow: 'hidden', borderRadius: uiRadius.small, cornerShape: uiCorner.shape, boxShadow: uiShadow.card, backgroundColor: uiColors.elevatedBackground },
  menuGlyph: { height: appSpace[3.5], width: appSpace[3.5] },
  sectionMenu: { minWidth: '160px' },
  visibilityMenu: { minWidth: '200px' },
  nameDialog: { maxWidth: '24rem', gap: 0, overflow: 'hidden', padding: { 'default': 0, '@media (min-width: 640px)': 0 } },
  nameDialogHeader: { paddingInline: { 'default': appSpace[4], '@media (min-width: 640px)': appSpace[5] }, paddingBlock: appSpace[4], paddingRight: { 'default': appSpace[12], '@media (min-width: 640px)': appSpace[12] }, textAlign: 'start' },
  nameDialogTitle: { fontSize: uiText.bodySize, lineHeight: uiText.bodyLeading },
  nameDialogBody: { paddingInline: { 'default': appSpace[4], '@media (min-width: 640px)': appSpace[5] }, paddingBlock: appSpace[4] },
  nameDialogFooter: { backgroundColor: uiColors.secondaryBackground, paddingInline: { 'default': appSpace[4], '@media (min-width: 640px)': appSpace[5] }, paddingBlock: appSpace[3] },
});

const pinStyles = stylex.create({
  menuHost: { display: 'inline-flex' },
  menuReveal: {
    opacity: { default: 0, [stylex.when.ancestor(':hover', sidebarSectionHeaderMarker)]: 1, ':has(:focus-visible, [data-popup-open])': 1 },
    pointerEvents: { default: 'none', [stylex.when.ancestor(':hover', sidebarSectionHeaderMarker)]: 'auto', ':has(:focus-visible, [data-popup-open])': 'auto' },
    transitionProperty: 'opacity', transitionDuration: uiMotion.fast,
  },
  foldedGap: { paddingBottom: appSpace[1] },
  sectionGap: { paddingBottom: appSpace[4] },
});
