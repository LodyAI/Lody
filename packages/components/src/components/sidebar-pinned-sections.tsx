import {
  Fragment,
  memo,
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { PIN_SECTION_NAME_MAX_LENGTH } from '@lody/shared';
import { Dialog } from '@/ui/dialog';
import { Menu } from '@/ui/menu';
import { toast } from '@/lib/toast';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import {
  SidebarUpdatedSessionList,
  type SidebarPinSectionMenu,
  type SidebarUpdatedSessionListProps,
} from './sidebar-updated-session-list';
import type { SidebarUpdatedItem } from './sidebar-updated-task-list';

/** One pin section in display order; `id: null` is the default "Pinned" section. */
export type SidebarPinnedSection = {
  id: string | null;
  name: string;
  items: SidebarUpdatedItem[];
};

export type SidebarPinSectionActions = {
  onMoveItem: (itemId: string, sectionId: string | null) => void;
  /** A conversation dragged to `toIndex` of a section's pinned rows. */
  onDropItem: (itemId: string, sectionId: string | null, toIndex: number) => void;
  /** A user section dragged to `toIndex` among the user sections. */
  onMoveSection: (sectionId: string, toIndex: number) => void;
  onCreateSection: (name: string, moveItemId?: string) => void | Promise<void>;
  onRenameSection: (sectionId: string, name: string) => void | Promise<void>;
  onDeleteSection: (sectionId: string) => void;
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
  | 'pinSectionMenu'
  | 'pinSectionId'
  | 'onDropPinnedSession'
  | 'renderHeader'
>;

export type SidebarPinnedSectionsProps = {
  sections: readonly SidebarPinnedSection[];
  defaultLabel: string;
  defaultCollapsed: boolean;
  onToggleDefault?: () => void;
  collapsedSectionIds?: Readonly<Record<string, boolean>>;
  onToggleSection?: (sectionId: string) => void;
  /** Rendered on the first visible section header (the sidebar filter). */
  headerAction?: ReactNode;
  /** Absent when this viewer cannot manage pin sections. */
  actions?: SidebarPinSectionActions;
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
  defaultLabel,
  defaultCollapsed,
  onToggleDefault,
  collapsedSectionIds,
  onToggleSection,
  headerAction,
  actions,
  listProps,
  emptyTitle,
  emptyDescription,
  className,
}: SidebarPinnedSectionsProps) {
  const { t } = useTranslation();
  const [nameDialog, setNameDialog] = useState<NameDialogTarget | null>(null);

  const menuSections = useMemo(
    () =>
      sections.map((section) => ({
        id: section.id,
        name: section.id === null ? defaultLabel : section.name,
      })),
    [defaultLabel, sections]
  );
  const menuLabels = useMemo(
    () => ({
      moveToSection: t('sidebar.pinSections.moveToSection', 'Move to Section'),
      newSection: t('sidebar.pinSections.newSection', 'New Section…'),
    }),
    [t]
  );
  const onMoveItem = actions?.onMoveItem;
  const openCreate = useCallback((itemId: string) => {
    setNameDialog({ kind: 'create', moveItemId: itemId });
  }, []);
  // One stable menu object per section keeps memoized rows from re-rendering.
  const menuBySection = useMemo(() => {
    const menus = new Map<string | null, SidebarPinSectionMenu>();
    if (!onMoveItem) return menus;
    for (const section of sections) {
      menus.set(section.id, {
        sections: menuSections,
        currentSectionId: section.id,
        onMove: onMoveItem,
        onCreate: openCreate,
        labels: menuLabels,
      });
    }
    return menus;
  }, [menuLabels, menuSections, onMoveItem, openCreate, sections]);

  const onDropItem = actions?.onDropItem;
  const dropBySection = useMemo(() => {
    const handlers = new Map<string | null, (sessionId: string, toIndex: number) => void>();
    if (!onDropItem || listProps.isMobile) return handlers;
    for (const section of sections) {
      handlers.set(section.id, (sessionId, toIndex) => onDropItem(sessionId, section.id, toIndex));
    }
    return handlers;
  }, [listProps.isMobile, onDropItem, sections]);

  const userSectionIds = useMemo(
    () => sections.flatMap((section) => (section.id === null ? [] : [section.id])),
    [sections]
  );
  // Pointer only: the handle is the whole header, whose collapse toggle and
  // menu button own Enter and Space. A keyboard sensor would take those keys.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onMoveSection = actions?.onMoveSection;
  const handleSectionDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;
      if (!onMoveSection || !overId || activeId === overId) return;
      const toIndex = userSectionIds.indexOf(overId);
      if (toIndex < 0) return;
      onMoveSection(activeId, toIndex);
    },
    [onMoveSection, userSectionIds]
  );
  const canSortSections = Boolean(onMoveSection) && !listProps.isMobile;

  const hasUserSections = sections.some((section) => section.id !== null);
  const visibleSections = sections.filter(
    // An empty default section only matters as a heading when nothing else is pinned.
    (section) => section.id !== null || section.items.length > 0 || !hasUserSections
  );

  return (
    <div className={className}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleSectionDragEnd}
      >
        <SortableContext items={userSectionIds} strategy={verticalListSortingStrategy}>
          {visibleSections.map((section, index) => {
            const isDefault = section.id === null;
            const sectionId = section.id;
            const collapsed = isDefault
              ? defaultCollapsed
              : Boolean(sectionId && collapsedSectionIds?.[sectionId]);
            const label = isDefault ? defaultLabel : section.name;
            const sectionMenu =
              !isDefault && actions && sectionId ? (
                <PinSectionHeaderMenu
                  label={t('sidebar.pinSections.sectionActions', 'Section actions')}
                  renameLabel={t('sidebar.pinSections.rename', 'Rename Section')}
                  deleteLabel={t('sidebar.pinSections.delete', 'Delete Section')}
                  onRename={() =>
                    setNameDialog({ kind: 'rename', sectionId, initialName: section.name })
                  }
                  onDelete={() => actions.onDeleteSection(sectionId)}
                />
              ) : null;
            const firstAction = index === 0 ? headerAction : null;
            const action =
              firstAction && sectionMenu ? (
                <span className="flex items-center">
                  {sectionMenu}
                  {firstAction}
                </span>
              ) : (
                (sectionMenu ?? firstAction ?? undefined)
              );
            const list = (renderHeader?: (header: ReactElement) => ReactNode) => (
              <SidebarUpdatedSessionList
                {...listProps}
                renderHeader={renderHeader}
                onDropPinnedSession={dropBySection.get(sectionId)}
                // Same gap between sections as between the sidebar's other groups.
                className={
                  index < visibleSections.length - 1 ? (collapsed ? 'mb-1' : 'mb-4') : undefined
                }
                items={section.items}
                grouping="manual"
                pinSectionId={sectionId}
                pinSectionMenu={menuBySection.get(sectionId)}
                showPinnedIcon={false}
                labels={{ heading: label, emptyTitle, emptyDescription }}
                collapsedBuckets={collapsed ? COLLAPSED : undefined}
                onToggleBucket={
                  isDefault
                    ? onToggleDefault
                    : sectionId && onToggleSection
                      ? () => onToggleSection(sectionId)
                      : undefined
                }
                toggleBucketLabel={label}
                headerAction={action}
              />
            );
            return sectionId === null || !canSortSections ? (
              <Fragment key={sectionId ?? '__default__'}>{list()}</Fragment>
            ) : (
              <SortablePinSection key={sectionId} id={sectionId}>
                {list}
              </SortablePinSection>
            );
          })}
        </SortableContext>
      </DndContext>
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

/**
 * A user section that can be dragged by its header. Only the header carries
 * the pointer listeners: conversation rows keep their own (HTML5) drag.
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
    useSortable({ id });
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
        transform: CSS.Translate.toString(transform),
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
  renameLabel,
  deleteLabel,
  onRename,
  onDelete,
}: {
  label: string;
  renameLabel: string;
  deleteLabel: string;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button type="button" variant="ghost" size="mini" icon aria-label={label}>
            <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        }
      />
      <Menu.Content align="end" className="min-w-[160px]">
        <Menu.Item icon={Pencil} onClick={onRename}>
          {renameLabel}
        </Menu.Item>
        <Menu.Item icon={Trash2} onClick={onDelete}>
          {deleteLabel}
        </Menu.Item>
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
      <Dialog.Content className="max-w-sm gap-0 overflow-hidden p-0 sm:p-0">
        <Dialog.Header className="border-b border-border/70 px-4 py-4 pr-12 text-left sm:px-5 sm:pr-12">
          <Dialog.Title className="text-base">
            {target?.kind === 'rename'
              ? t('sidebar.pinSections.renameTitle', 'Rename Section')
              : t('sidebar.pinSections.createTitle', 'New Section')}
          </Dialog.Title>
        </Dialog.Header>
        <div className="px-4 py-4 sm:px-5">
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
        <Dialog.Footer className="border-t border-border/70 bg-muted/30 px-4 py-3 sm:px-5">
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
