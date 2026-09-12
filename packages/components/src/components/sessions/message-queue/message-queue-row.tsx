import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, GripVertical, Pencil, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MessageQueueItem, SessionId } from '@lody/shared';
import { normalizeSessionInputBlocks } from '@lody/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { QueuedImagePreview, type QueuedImageBlock } from './queued-image-preview';
import { getEditableTaskText } from './use-message-queue-editing';

const MAX_INLINE_IMAGES = 3;

export type MessageQueueRowProps = {
  sessionId: SessionId;
  item: MessageQueueItem;
  index: number;
  isFirst: boolean;
  showSteerAction: boolean;
  canReorder: boolean;
  isEditing: boolean;
  editValue: string;
  isPending: boolean;
  onEditValueChange: (value: string) => void;
  onStartEdit: (item: MessageQueueItem) => void;
  onCancelEdit: (item: MessageQueueItem) => void;
  onSaveEdit: (item: MessageQueueItem) => void;
  onRemove: (cid: string) => void | Promise<void>;
  onSteer: (item: MessageQueueItem) => void | Promise<void>;
};

type EditCommitProps = {
  imageBlocks: QueuedImageBlock[];
  onCommitEdit: () => void;
};

export function MessageQueueRow(props: MessageQueueRowProps) {
  const { item, canReorder, isEditing, isPending, editValue, onCancelEdit, onSaveEdit } = props;
  const sortable = useSortable({ id: item.$cid, disabled: !canReorder || isEditing });
  const constrainedTransform = sortable.transform
    ? { ...sortable.transform, x: 0, scaleX: 1, scaleY: 1 }
    : null;
  const style = {
    transform: CSS.Transform.toString(constrainedTransform),
    transition: sortable.transition,
  };

  const imageBlocks = useMemo(
    () =>
      normalizeSessionInputBlocks(item.acpSessionConfig?.inputBlocks, '').filter(
        (block): block is QueuedImageBlock => block.type === 'image'
      ),
    [item.acpSessionConfig?.inputBlocks]
  );

  // Every commit path — Enter, the confirm button, clicking away — funnels through here.
  // The guard keeps the blur that follows a keyboard/button commit (React disables the
  // textarea while the write is pending, which blurs it) from writing a second time.
  const hasCommittedRef = useRef(false);
  const commitEdit = useCallback(() => {
    if (hasCommittedRef.current) return;
    const original = getEditableTaskText(item).trim();
    const current = editValue.trim();
    hasCommittedRef.current = true;
    if (current === original) {
      // Nothing changed: just clear isEditing without writing.
      onCancelEdit(item);
      return;
    }
    if (current.length === 0 && imageBlocks.length === 0) {
      // Don't let a commit wipe the queued message to an empty prompt; revert instead.
      onCancelEdit(item);
      return;
    }
    onSaveEdit(item);
  }, [editValue, imageBlocks.length, item, onCancelEdit, onSaveEdit]);

  // A failed write leaves the row in edit mode; re-arm so the user can commit again.
  useEffect(() => {
    if (isEditing && !isPending) {
      hasCommittedRef.current = false;
    }
  }, [isEditing, isPending]);

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        'group/row relative flex items-start gap-2 px-2 py-1.5',
        'transition-colors',
        sortable.isDragging && 'z-10 bg-muted/40 opacity-90 shadow-sm',
        isEditing && 'bg-background/60'
      )}
    >
      <LeadingHandle {...props} sortable={sortable} />
      <RowBody {...props} imageBlocks={imageBlocks} onCommitEdit={commitEdit} />
      <RowActions {...props} />
    </div>
  );
}

function LeadingHandle({
  index,
  canReorder,
  isEditing,
  sortable,
}: MessageQueueRowProps & { sortable: ReturnType<typeof useSortable> }) {
  const { t } = useTranslation();
  const label = t('sessions.messageQueue.dragToReorder', 'Drag to reorder');

  if (!canReorder || isEditing) {
    return (
      <div
        aria-hidden="true"
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-medium tabular-nums text-muted-foreground/60"
      >
        {index + 1}
      </div>
    );
  }

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          ref={sortable.setActivatorNodeRef}
          className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded',
            'text-[10px] font-medium tabular-nums text-muted-foreground/60',
            'cursor-grab transition-colors active:cursor-grabbing',
            'hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
          )}
          aria-label={label}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <span className="block group-hover/row:hidden group-focus-within/row:hidden">
            {index + 1}
          </span>
          <GripVertical className="hidden h-3 w-3 group-hover/row:block group-focus-within/row:block" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function RowBody(props: MessageQueueRowProps & EditCommitProps) {
  const { t } = useTranslation();
  const {
    sessionId,
    item,
    isEditing,
    editValue,
    isPending,
    imageBlocks,
    onEditValueChange,
    onCommitEdit,
  } = props;

  const inlineImages = imageBlocks.slice(0, MAX_INLINE_IMAGES);
  const overflowImageCount = Math.max(0, imageBlocks.length - inlineImages.length);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // The synced editing flag can mount a disabled field before startEdit resolves.
  // Reattach when pending changes so focus happens after the field is enabled.
  const focusEditorAtEnd = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      textareaRef.current = textarea;
      if (!textarea || isPending) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.scrollTop = textarea.scrollHeight;
    },
    [isPending]
  );

  if (isEditing) {
    // Enter, the confirm button, and clicking away all commit; Shift+Enter inserts a
    // newline. Esc blurs, which commits too — there is no separate "discard changes"
    // affordance by design.
    return (
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'rounded-md border border-border/60 bg-background/80 transition-colors',
            'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20'
          )}
        >
          <textarea
            ref={focusEditorAtEnd}
            value={editValue}
            rows={3}
            className={cn(
              'block w-full resize-none border-transparent bg-transparent',
              'px-2 pt-1 text-xs leading-snug text-foreground',
              // The base layer paints `box-shadow: inset 0 0 0 1px` on any focused
              // textarea. That used to land exactly on this field's own border; now
              // that the shell owns the border, it would draw a second rectangle
              // inside the box. The composer suppresses it the same way.
              'outline-none focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0'
            )}
            disabled={isPending}
            aria-label={t('sessions.messageQueue.editMessage', 'Edit queued message')}
            onChange={(event) => onEditValueChange(event.currentTarget.value)}
            onBlur={onCommitEdit}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.currentTarget.blur();
                return;
              }
              if (event.key !== 'Enter' || event.shiftKey) return;
              // An IME uses Enter to accept its candidate; that must not commit the edit.
              if (isImeComposingKeyboardEvent(event)) return;
              event.preventDefault();
              onCommitEdit();
            }}
          />
          {/* Keep the entire footer in the editing surface: blank-space presses
              must not blur/save, and the confirm button commits through its click
              instead of racing the blur handler for the same write. */}
          <div
            className="flex justify-end px-1 pb-1"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              if (event.target === event.currentTarget) focusEditorAtEnd(textareaRef.current);
            }}
          >
            <IconAction
              icon={Check}
              label={t('sessions.messageQueue.saveEdit', 'Save changes (Enter)')}
              disabled={isPending}
              onClick={onCommitEdit}
            />
          </div>
        </div>
        {inlineImages.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {inlineImages.map((image, i) => (
              <QueuedImagePreview
                key={`${image.imageId}-${i}`}
                sessionId={sessionId}
                image={image}
                size={20}
              />
            ))}
            {overflowImageCount > 0 ? (
              <span className="text-[10px] text-muted-foreground/70">+{overflowImageCount}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-start gap-1.5">
      {inlineImages.length > 0 ? (
        <div className="flex shrink-0 items-center gap-0.5 pt-px">
          {inlineImages.map((image, i) => (
            <QueuedImagePreview
              key={`${image.imageId}-${i}`}
              sessionId={sessionId}
              image={image}
              size={18}
            />
          ))}
          {overflowImageCount > 0 ? (
            <span className="ml-0.5 text-[10px] text-muted-foreground/70 tabular-nums">
              +{overflowImageCount}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        className="min-w-0 flex-1 overflow-hidden text-xs leading-snug text-foreground/80"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {item.task}
      </div>
    </div>
  );
}

function RowActions(props: MessageQueueRowProps) {
  const { t } = useTranslation();
  const { item, isFirst, showSteerAction, isEditing, onStartEdit, onRemove, onSteer } = props;

  // In edit mode the textarea owns the row: it carries its own confirm button, so we
  // render no row-level actions that would compete for the click mid-edit.
  if (isEditing) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {isFirst && showSteerAction ? (
        <TextAction
          text={t('sessions.messageQueue.guideAction', 'Steer')}
          ariaLabel={t(
            'sessions.messageQueue.guide',
            'Steer the active response with this message'
          )}
          onClick={() => {
            void onSteer(item);
          }}
        />
      ) : null}
      <IconAction
        icon={Pencil}
        label={t('sessions.messageQueue.editMessage', 'Edit queued message')}
        onClick={() => onStartEdit(item)}
      />
      <IconAction
        icon={X}
        label={t('sessions.messageQueue.remove', 'Remove from queue')}
        destructive
        onClick={() => {
          void onRemove(item.$cid);
        }}
      />
    </div>
  );
}

function TextAction({
  text,
  ariaLabel,
  onClick,
}: {
  text: string;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={cn(
        'flex h-5 shrink-0 items-center justify-center rounded px-1.5',
        'text-[11px] font-medium text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
      )}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

function IconAction({
  icon: Icon,
  label,
  destructive,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded',
            'text-muted-foreground/60 transition-colors',
            'hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            'disabled:pointer-events-none disabled:opacity-50',
            destructive && 'hover:text-destructive'
          )}
          onClick={onClick}
        >
          <Icon className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
