import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useTranslation } from 'react-i18next';
import type { MessageQueueItem, SessionId } from '@lody/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Collapsible } from '@lody/ui/collapsible';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import {
  NO_SCROLL_EDGE_OVERFLOW,
  buildScrollEdgeFadeMask,
  readScrollEdgeOverflow,
  scrollEdgeOverflowEquals,
} from '@/lib/scroll-edge-fade';
import { MessageQueueRow } from './message-queue-row';
import { PendingQueueRow } from './pending-queue-row';
import { useMessageQueueEditing } from './use-message-queue-editing';
import { usePendingQueueActions, usePendingQueueRecords } from './use-pending-queue-records';

export type MessageQueueDisplayProps = {
  sessionId: SessionId;
  items: MessageQueueItem[];
  onRemove: (cid: string) => void | Promise<void>;
  onReorder: (activeCid: string, overCid: string) => void | Promise<void>;
  onEditStart: (item: MessageQueueItem) => void | Promise<void>;
  onEditCancel: (item: MessageQueueItem) => void | Promise<void>;
  onEditSave: (item: MessageQueueItem, task: string) => void | Promise<void>;
  onSteer: (item: MessageQueueItem) => void | Promise<void>;
  showSteerAction?: boolean;
  /** Native acknowledged steer: lets every queued row steer, not just the first. */
  nativeSteerAvailable?: boolean;
  className?: string;
};

const FADE_PX = 20;
const styles = stylex.create({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    width: '100%',
    minHeight: { default: 24, '@media (pointer: coarse), (max-width: 600px)': 44 },
    paddingBlock: space[1],
    paddingInline: space[2],
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    textAlign: 'start',
    cursor: 'pointer',
    boxShadow: { default: 'none', ':focus-visible': `inset 0 0 0 2px ${colors.accent}` },
  },
  title: { fontWeight: 500 },
  count: { marginInlineStart: space[1.5] },
  status: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: space[2],
    paddingInline: space[2],
    paddingBottom: space[1],
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
  },
  failed: { color: colors.destructive },
});

export function MessageQueueDisplay({
  sessionId,
  items,
  onRemove,
  onReorder,
  onEditStart,
  onEditCancel,
  onEditSave,
  onSteer,
  showSteerAction = false,
  nativeSteerAvailable = false,
  className,
}: MessageQueueDisplayProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(true);
  const [overflow, setOverflow] = useState(NO_SCROLL_EDGE_OVERFLOW);

  const editing = useMessageQueueEditing(items, { onEditStart, onEditCancel, onEditSave });
  const pending = usePendingQueueRecords(sessionId, items);
  const pendingActions = usePendingQueueActions();
  const rowCount = items.length + pending.length;
  const failedCount = pending.filter((record) => Boolean(record.error)).length;
  const preparingCount = pending.length - failedCount;

  const itemIds = useMemo(() => items.map((item) => item.$cid), [items]);
  const canReorder = items.length > 1;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = readScrollEdgeOverflow(el);
    setOverflow((current) => (scrollEdgeOverflowEquals(current, next) ? current : next));
  }, []);

  useLayoutEffect(() => {
    updateOverflow();
  }, [editing.editingCid, expanded, items, pending.length, updateOverflow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const handler = () => updateOverflow();
    el.addEventListener('scroll', handler, { passive: true });
    const cleanupResizeObserver = observeResizeOnAnimationFrame(el, handler);
    return () => {
      el.removeEventListener('scroll', handler);
      cleanupResizeObserver();
    };
  }, [updateOverflow]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over?.id;
      if (!overId) return;
      const activeCid = String(event.active.id);
      const overCid = String(overId);
      if (activeCid === overCid) return;
      void onReorder(activeCid, overCid);
    },
    [onReorder]
  );

  if (rowCount === 0) {
    return null;
  }

  const fadeMask = buildScrollEdgeFadeMask(overflow, FADE_PX);

  // A sheet tucked onto the surface below it (the info bar, or the composer when
  // there is no bar): rounded top, square open bottom, and the composer's own
  // fill and hairline so the stack reads as one piece rather than a gray slab.
  // Rows use divide-y so the list feels continuous rather than stacked cards.
  return (
    <Tooltip.Provider>
      <Collapsible.Root
        open={expanded}
        onOpenChange={setExpanded}
        className={cn(
          'overflow-hidden rounded-t-lg rounded-b-none border-[0.5px] border-b-0',
          'border-foreground/[0.10] bg-[hsl(var(--composer))] dark:border-input-border/45 dark:bg-input/70',
          className
        )}
      >
        <Collapsible.Trigger
          {...stylex.props(styles.header)}
          data-message-queue-toggle=""
          onPointerDown={(event) => {
            if (event.button === 0) event.currentTarget.focus();
          }}
          onClick={(event) => event.currentTarget.focus()}
        >
          {expanded ? (
            <ChevronDown size={12} aria-hidden="true" />
          ) : (
            <ChevronRight size={12} aria-hidden="true" />
          )}
          <span {...stylex.props(styles.title)}>
            {t('sessions.messageQueue.upNext', 'Up next')}
            <span {...stylex.props(styles.count)}>
              {t('sessions.messageQueue.queuedCount', {
                count: rowCount,
                defaultValue: '{{count}} queued',
              })}
            </span>
          </span>
        </Collapsible.Trigger>
        {!expanded && pending.length > 0 ? (
          <div role="status" {...stylex.props(styles.status)}>
            {failedCount > 0 ? (
              <span {...stylex.props(styles.failed)}>
                {t('sessions.messageQueue.failedCount', { count: failedCount })}
              </span>
            ) : null}
            {preparingCount > 0 ? (
              <span>{t('sessions.messageQueue.preparingCount', { count: preparingCount })}</span>
            ) : null}
          </div>
        ) : null}

        <Collapsible.Panel keepMounted>
          <div
            ref={scrollRef}
            className="overflow-y-auto border-t border-border/30"
            style={{
              maxHeight: 'min(25vh, 240px)',
              maskImage: fadeMask,
              WebkitMaskImage: fadeMask,
            }}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
                {items.map((item, index) => {
                  const isEditing = editing.editingCid === item.$cid;
                  return (
                    <MessageQueueRow
                      key={item.$cid}
                      sessionId={sessionId}
                      item={item}
                      index={index}
                      isFirst={index === 0}
                      showSteerAction={showSteerAction}
                      nativeSteerAvailable={nativeSteerAvailable}
                      canReorder={canReorder}
                      isEditing={isEditing}
                      editValue={isEditing ? editing.editValue : ''}
                      isPending={editing.pendingCid === item.$cid}
                      onEditValueChange={editing.setEditValue}
                      onStartEdit={(nextItem) => {
                        void editing.startEdit(nextItem);
                      }}
                      onCancelEdit={(nextItem) => {
                        void editing.cancelEdit(nextItem);
                      }}
                      onSaveEdit={(nextItem) => {
                        void editing.saveEdit(nextItem);
                      }}
                      onRemove={onRemove}
                      onSteer={onSteer}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
            {/* Local rows stay outside the sortable list: they are not queue items
              yet, and the real item is appended at exactly this position. */}
            {pending.map((record, index) => (
              <PendingQueueRow
                key={record.id}
                record={record}
                index={items.length + index}
                divided={items.length + index > 0}
                busy={pendingActions.busyId === record.id}
                onRetry={() => void pendingActions.run(record, 'retry')}
                onCancel={() => void pendingActions.run(record, 'cancel')}
              />
            ))}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </Tooltip.Provider>
  );
}
