import * as stylex from '@stylexjs/stylex';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
import { ChevronDown } from 'lucide-react';
import { Collapsible } from '@lody/ui/collapsible';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { duration, ease, space, text } from '@lody/ui/tokens/scales.stylex';
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
import { ScheduledQueueRow, type ScheduledQueueItem } from './scheduled-queue-row';
import { PendingQueueRow } from './pending-queue-row';
import { useMessageQueueEditing } from './use-message-queue-editing';
import { queueSurface } from './surface';
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
  renderItemFooter?: (item: MessageQueueItem) => ReactNode;
  /** Dedicated reservations, kept out of the executable mq list. */
  scheduledItems?: readonly ScheduledQueueItem[];
  onOpenScheduled?: (item: ScheduledQueueItem) => void;
  onEditScheduledTime?: (item: ScheduledQueueItem) => void;
  onCancelScheduled?: (item: ScheduledQueueItem) => void;
  footerPosition?: 'below' | 'start' | 'end' | 'inline';
  roomy?: boolean | 'airy';
  title?: string;
  className?: string;
};

const FADE_PX = 20;
const TOUCH = '@media (pointer: coarse), (max-width: 600px)';
const styles = stylex.create({
  joinedSheet: { paddingBottom: space[4], marginBottom: `calc(-1 * ${space[4]})` },
  // The header's chevron sits in the rows' 16 px gutter, so the disclosure,
  // the indices and the Scheduled label share one left edge.
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minHeight: { default: 30, [TOUCH]: 40 },
    paddingInline: `calc(${space[1]} + ${space[1.5]})`,
    backgroundColor: 'transparent',
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    textAlign: 'start',
    cursor: 'pointer',
    boxShadow: { default: 'none', ':focus-visible': `inset 0 0 0 2px ${colors.accent}` },
  },
  roomyHeader: { fontSize: text.subheadlineSize },
  chevron: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: 16, // the rows' gutter
    transitionProperty: 'transform',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
    transform: 'rotate(-90deg)',
  },
  chevronOpen: { transform: 'none' },
  title: { fontWeight: 500, color: colors.label, opacity: 0.86 },
  count: { color: colors.secondaryLabel, fontVariantNumeric: 'tabular-nums' },
  status: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: space[2],
    marginInlineStart: 'auto',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  failed: { color: colors.destructive },
});

export function MessageQueueDisplay({
  sessionId,
  items: sourceItems,
  onRemove,
  onReorder,
  onEditStart,
  onEditCancel,
  onEditSave,
  onSteer,
  showSteerAction = false,
  nativeSteerAvailable = false,
  renderItemFooter,
  scheduledItems: dedicatedScheduledItems = [],
  onOpenScheduled,
  onEditScheduledTime,
  onCancelScheduled,
  footerPosition = 'below',
  roomy = false,
  title,
  className,
}: MessageQueueDisplayProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(true);
  const [overflow, setOverflow] = useState(NO_SCROLL_EDGE_OVERFLOW);

  const items = sourceItems;
  const ordinaryItems = sourceItems;
  const dedicatedScheduled = useMemo(
    () => [...dedicatedScheduledItems].sort((a, b) => a.at - b.at),
    [dedicatedScheduledItems]
  );
  const editing = useMessageQueueEditing(items, { onEditStart, onEditCancel, onEditSave });
  const pending = usePendingQueueRecords(sessionId, items);
  const pendingActions = usePendingQueueActions();
  const rowCount = items.length + pending.length + dedicatedScheduled.length;
  const failedCount = pending.filter((record) => Boolean(record.error)).length;
  const onlyScheduled = items.length + pending.length === 0 && dedicatedScheduled.length > 0;
  const scheduledFailedCount = dedicatedScheduled.filter((item) => item.state === 'failed').length;
  const preparingCount = pending.length - failedCount;

  const itemIds = useMemo(() => ordinaryItems.map((item) => item.$cid), [ordinaryItems]);
  const canReorder = ordinaryItems.length > 1;

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
  }, [
    dedicatedScheduled.length,
    editing.editingCid,
    expanded,
    items,
    pending.length,
    updateOverflow,
  ]);

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
      if (activeCid === overCid || !itemIds.includes(activeCid) || !itemIds.includes(overCid))
        return;
      void onReorder(activeCid, overCid);
    },
    [onReorder, itemIds]
  );

  if (rowCount === 0) {
    return null;
  }

  const renderRow = (item: MessageQueueItem, index: number) => {
    const isEditing = editing.editingCid === item.$cid;
    return (
      <MessageQueueRow
        key={item.$cid}
        sessionId={sessionId}
        item={item}
        footer={renderItemFooter?.(item)}
        footerPosition={footerPosition}
        roomy={roomy}
        onMoveToTop={index > 0 ? () => onReorder(item.$cid, items[0]!.$cid) : undefined}
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
  };

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
          roomy && stylex.props(styles.joinedSheet).className,
          className
        )}
      >
        <Collapsible.Trigger
          {...stylex.props(styles.header, roomy && styles.roomyHeader)}
          data-message-queue-toggle=""
          onPointerDown={(event) => {
            if (event.button === 0) event.currentTarget.focus();
          }}
          onClick={(event) => event.currentTarget.focus()}
        >
          <span {...stylex.props(styles.chevron, expanded && styles.chevronOpen)}>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span {...stylex.props(styles.title)}>
            {title ??
              (onlyScheduled
                ? t('sessions.messageQueue.scheduledTitle', 'Scheduled')
                : t('sessions.messageQueue.upNext', 'Up next'))}
          </span>
          {!title && !onlyScheduled && (
            <span {...stylex.props(styles.count)}>
              {[
                items.length + pending.length > 0
                  ? t('sessions.messageQueue.queuedCount', {
                      count: items.length + pending.length,
                      defaultValue: '{{count}} queued',
                    })
                  : null,
                dedicatedScheduled.length > 0
                  ? t('sessions.messageQueue.scheduledCount', {
                      count: dedicatedScheduled.length,
                      defaultValue: '{{count}} scheduled',
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
          {!expanded && (pending.length > 0 || scheduledFailedCount > 0) ? (
            <span role="status" {...stylex.props(styles.status)}>
              {failedCount > 0 ? (
                <span {...stylex.props(styles.failed)}>
                  {t('sessions.messageQueue.failedCount', { count: failedCount })}
                </span>
              ) : null}
              {preparingCount > 0 ? (
                <span>{t('sessions.messageQueue.preparingCount', { count: preparingCount })}</span>
              ) : null}
              {scheduledFailedCount > 0 ? (
                <span {...stylex.props(styles.failed)}>
                  {t('sessions.messageQueue.scheduledFailedCount', {
                    count: scheduledFailedCount,
                    defaultValue: '{{count}} scheduled not sent',
                  })}
                </span>
              ) : null}
            </span>
          ) : null}
        </Collapsible.Trigger>

        <Collapsible.Panel keepMounted>
          <div
            ref={scrollRef}
            className={cn(stylex.props(queueSurface.list).className, 'overflow-y-auto')}
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
                {ordinaryItems.map(renderRow)}
              </SortableContext>
              {/* Local rows stay outside the sortable list: they are not queue items
              yet, and the real item is appended at exactly this position. */}
              {pending.map((record, index) => (
                <PendingQueueRow
                  key={record.id}
                  record={record}
                  index={ordinaryItems.length + index}
                  busy={pendingActions.busyId === record.id}
                  onRetry={() => void pendingActions.run(record, 'retry')}
                  onCancel={() => void pendingActions.run(record, 'cancel')}
                />
              ))}
              {!onlyScheduled && dedicatedScheduled.length > 0 ? (
                <div {...stylex.props(queueSurface.sectionLabel)}>
                  {t('sessions.messageQueue.scheduledTitle', 'Scheduled')}
                </div>
              ) : null}
              {dedicatedScheduled.map((item) => (
                <ScheduledQueueRow
                  key={item.scheduleId}
                  item={item}
                  onOpen={onOpenScheduled}
                  onEditTime={onEditScheduledTime}
                  onCancel={onCancelScheduled}
                />
              ))}
            </DndContext>
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </Tooltip.Provider>
  );
}
