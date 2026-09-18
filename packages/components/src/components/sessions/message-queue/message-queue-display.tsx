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
import { TooltipProvider } from '@/ui/tooltip';
import { cn } from '@/lib/utils';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import {
  NO_SCROLL_EDGE_OVERFLOW,
  buildScrollEdgeFadeMask,
  readScrollEdgeOverflow,
  scrollEdgeOverflowEquals,
} from '@/lib/scroll-edge-fade';
import { MessageQueueRow } from './message-queue-row';
import { useMessageQueueEditing } from './use-message-queue-editing';

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
  const [overflow, setOverflow] = useState(NO_SCROLL_EDGE_OVERFLOW);

  const editing = useMessageQueueEditing(items, { onEditStart, onEditCancel, onEditSave });

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
  }, [editing.editingCid, items, updateOverflow]);

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

  if (items.length === 0) {
    return null;
  }

  const fadeMask = buildScrollEdgeFadeMask(overflow, FADE_PX);

  // Single rounded shell with header row; rows below use divide-y to feel like one continuous list
  // rather than a stack of independent cards. Bottom corners stay square so it visually attaches
  // to the chat composer below.
  return (
    <TooltipProvider>
      <div
        className={cn(
          'overflow-hidden rounded-md rounded-b-none border border-b-0 border-border/50',
          'bg-muted/40',
          className
        )}
      >
        <div className="flex items-center justify-between px-2.5 py-1 text-[11px] text-muted-foreground">
          <span className="font-medium">
            {t('sessions.messageQueue.upNext', 'Up next')}
            <span className="ml-1.5 text-muted-foreground/60">
              {t('sessions.messageQueue.queuedCount', {
                count: items.length,
                defaultValue: '{{count}} queued',
              })}
            </span>
          </span>
        </div>

        <div
          ref={scrollRef}
          className="divide-y divide-border/30 overflow-y-auto border-t border-border/30"
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
        </div>
      </div>
    </TooltipProvider>
  );
}
