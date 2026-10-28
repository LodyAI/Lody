import * as stylex from '@stylexjs/stylex';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Check,
  GripVertical,
  Pencil,
  X,
  MoreHorizontal,
  Trash2,
  ArrowUpToLine,
  Send,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MessageQueueItem, SessionId } from '@lody/shared';
import { normalizeSessionInputBlocks } from '@lody/shared';
import { Menu } from '@lody/ui/menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { Tooltip } from '@lody/ui/tooltip';
import { text as type } from '@lody/ui/tokens/scales.stylex';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { QueuedImagePreview, type QueuedImageBlock } from './queued-image-preview';
import { QUEUE_LINE, queueSurface } from './surface';
import { shouldShowQueuedItemSteer } from './queued-message-steer';
import { getEditableTaskText } from './use-message-queue-editing';

const MAX_INLINE_IMAGES = 3;

export type MessageQueueRowProps = {
  sessionId: SessionId;
  item: MessageQueueItem;
  index: number;
  isFirst: boolean;
  showSteerAction: boolean;
  nativeSteerAvailable: boolean;
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
  onMoveToTop?: () => void | Promise<void>;
  footer?: ReactNode;
  footerPosition?: 'below' | 'start' | 'end' | 'inline';
  roomy?: boolean | 'airy';
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
        'group/row',
        stylex.props(
          queueSurface.row,
          props.roomy && queueSurface.roomyRow,
          props.roomy === 'airy' && queueSurface.airyRow,
          isEditing && queueSurface.editingRow
        ).className,
        sortable.isDragging && 'z-10 bg-[hsl(var(--composer))] opacity-95 shadow-md'
      )}
    >
      <LeadingHandle {...props} sortable={sortable} />
      {props.footerPosition === 'start' && !isEditing ? (
        <div {...stylex.props(queueSurface.inlineMeta)}>{props.footer}</div>
      ) : null}
      {props.footer && (!props.footerPosition || props.footerPosition === 'below') ? (
        <div className="min-w-0 flex-1">
          <RowBody {...props} imageBlocks={imageBlocks} onCommitEdit={commitEdit} />
          {props.footer}
        </div>
      ) : (
        <RowBody {...props} imageBlocks={imageBlocks} onCommitEdit={commitEdit} />
      )}
      {props.footerPosition === 'end' && !isEditing ? (
        <div {...stylex.props(queueSurface.inlineMeta)}>{props.footer}</div>
      ) : null}
      <RowActions {...props} />
    </div>
  );
}

/* The index sits on the task text's first line: its box is exactly that line
   box (`QUEUE_LINE`), so both share one center. */
const LEADING_HANDLE_BOX_CLASS = 'flex w-4 shrink-0 items-center justify-center';
const LEADING_HANDLE_BOX_STYLE = { height: QUEUE_LINE };
const ROOMY_LEADING_HANDLE_BOX_STYLE = { height: type.bodyLeading };

function LeadingHandle({
  index,
  roomy,
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
        style={roomy ? ROOMY_LEADING_HANDLE_BOX_STYLE : LEADING_HANDLE_BOX_STYLE}
        className={cn(
          LEADING_HANDLE_BOX_CLASS,
          'translate-y-px text-[11px] font-medium tabular-nums text-muted-foreground/70'
        )}
      >
        {index + 1}
      </div>
    );
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={300}
        render={
          <button
            type="button"
            ref={sortable.setActivatorNodeRef}
            style={roomy ? ROOMY_LEADING_HANDLE_BOX_STYLE : LEADING_HANDLE_BOX_STYLE}
            className={cn(
              LEADING_HANDLE_BOX_CLASS,
              'rounded',
              'translate-y-px text-[11px] font-medium tabular-nums text-muted-foreground/70',
              'cursor-grab transition-colors active:cursor-grabbing',
              'hover:bg-hover hover:text-foreground',
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
        }
      />
      <Tooltip.Content side="top">{label}</Tooltip.Content>
    </Tooltip.Root>
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusEditorAtEnd = useCallback((textarea: HTMLTextAreaElement | null) => {
    textareaRef.current = textarea;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.scrollTop = textarea.scrollHeight;
  }, []);

  if (isEditing) {
    // Enter, the confirm button, and clicking away all commit; Shift+Enter inserts a
    // newline. Esc blurs, which commits too — there is no separate "discard changes"
    // affordance by design.
    return (
      <div
        className={cn('min-w-0 flex-1', props.roomy && stylex.props(queueSurface.editor).className)}
      >
        <div
          className={cn(
            'rounded-md border border-border/60 bg-[hsl(var(--composer))] transition-colors',
            'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20'
          )}
        >
          <textarea
            // The synced editing flag can arrive before startEdit resolves; attach when enabled.
            ref={isPending ? null : focusEditorAtEnd}
            value={editValue}
            rows={3}
            className={cn(
              'block w-full resize-none border-transparent bg-transparent',
              'px-2 pt-1.5 text-foreground',
              stylex.props(queueSurface.editorText).className,
              // The shell owns the focus ring; the base layer's inset shadow
              // would draw another rectangle on the textarea.
              'outline-none focus-visible:outline-hidden focus-visible:shadow-none'
            )}
            disabled={isPending}
            aria-label={t('sessions.messageQueue.editMessage', 'Edit queued message')}
            onChange={(event) => onEditValueChange(event.currentTarget.value)}
            onBlur={(event) => {
              // Folding is display-only: moving to its header must not save or
              // discard this draft. The panel remains mounted while hidden.
              if (
                event.relatedTarget instanceof Element &&
                event.relatedTarget.closest('[data-message-queue-toggle]')
              )
                return;
              onCommitEdit();
            }}
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
          {/* Keep footer presses from blur-saving before focus or confirmation. */}
          <div
            className="flex justify-end px-1 pb-1"
            onMouseDown={(event) => {
              event.preventDefault();
              if (event.button === 0 && event.target === event.currentTarget)
                focusEditorAtEnd(textareaRef.current);
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
    <div
      className={cn(
        'flex flex-1 items-start gap-1.5',
        !props.roomy && 'min-w-0',
        props.roomy && stylex.props(queueSurface.roomyBody).className
      )}
    >
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
        className={cn(
          'min-w-0 flex-1 overflow-hidden',
          stylex.props(queueSurface.text, props.roomy && queueSurface.roomyText).className
        )}
        style={{
          display: '-webkit-box',
          WebkitLineClamp: props.footerPosition === 'inline' ? 1 : 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {props.footerPosition === 'inline' && props.footer ? <>{props.footer} </> : null}
        {item.task}
      </div>
    </div>
  );
}

function RowActions(props: MessageQueueRowProps) {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const {
    item,
    isFirst,
    showSteerAction,
    nativeSteerAvailable,
    isEditing,
    onStartEdit,
    onRemove,
    onSteer,
  } = props;

  // In edit mode the textarea owns the row: it carries its own confirm button, so we
  // render no row-level actions that would compete for the click mid-edit.
  if (isEditing) {
    return null;
  }

  if (mobile && props.roomy) {
    return (
      <div {...stylex.props(queueSurface.roomyActions)}>
        <Menu.Root>
          <Menu.Trigger render={<MoreTrigger />} />
          <Menu.Content align="end" width="compact">
            {shouldShowQueuedItemSteer({ showSteerAction, isFirst, nativeSteerAvailable }) ? (
              <Menu.Item icon={Send} onClick={() => void onSteer(item)}>
                {t('sessions.messageQueue.guideAction', 'Steer')}
              </Menu.Item>
            ) : null}
            {props.onMoveToTop ? (
              <Menu.Item
                icon={ArrowUpToLine}
                disabled={isFirst}
                onClick={() => {
                  void props.onMoveToTop?.();
                }}
              >
                {t('sessions.messageQueue.moveToTop', 'Move to top')}
              </Menu.Item>
            ) : null}
            <Menu.Item icon={Pencil} onClick={() => onStartEdit(item)}>
              {t('common.edit', 'Edit')}
            </Menu.Item>
            <Menu.Item
              icon={Trash2}
              tone="destructive"
              onClick={() => {
                void onRemove(item.$cid);
              }}
            >
              {t('common.delete', 'Delete')}
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      </div>
    );
  }

  // Edit and remove surface on hover or focus; Steer stays visible because it
  // is the one action that changes what the agent is doing right now.
  return (
    <div {...stylex.props(queueSurface.actions, props.roomy && queueSurface.roomyActions)}>
      <div className={cn(stylex.props(queueSurface.actions).className, ROW_REVEAL_CLASS)}>
        <IconAction
          roomy={props.roomy}
          icon={Pencil}
          label={t('sessions.messageQueue.editMessage', 'Edit queued message')}
          onClick={() => onStartEdit(item)}
        />
        <IconAction
          roomy={props.roomy}
          icon={X}
          label={t('sessions.messageQueue.remove', 'Remove from queue')}
          destructive
          onClick={() => {
            void onRemove(item.$cid);
          }}
        />
      </div>
      {shouldShowQueuedItemSteer({ showSteerAction, isFirst, nativeSteerAvailable }) ? (
        <button
          type="button"
          aria-label={t(
            'sessions.messageQueue.guide',
            'Steer the active response with this message'
          )}
          {...stylex.props(queueSurface.steer)}
          onClick={() => {
            void onSteer(item);
          }}
        >
          {t('sessions.messageQueue.guideAction', 'Steer')}
        </button>
      ) : null}
    </div>
  );
}

/** The touch row's 44 px More button; its menu carries every row action. */
export function MoreTrigger(props: ComponentProps<'button'>) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t('common.more', 'More')}
      {...props}
      {...stylex.props(queueSurface.more)}
    >
      <MoreHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

/** Desktop row actions surface on the row's hover or focus; touch keeps them. */
export const ROW_REVEAL_CLASS = cn(
  'opacity-0 transition-opacity duration-100',
  'group-hover/row:opacity-100 group-focus-within/row:opacity-100',
  '[@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100'
);

export function TextAction({
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
        stylex.props(queueSurface.action).className,
        'text-[11px] font-medium text-muted-foreground transition-colors',
        'hover:bg-hover hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
      )}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

export function IconAction({
  icon: Icon,
  roomy,
  label,
  destructive,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  roomy?: boolean | 'airy';
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={300}
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            className={cn(
              'flex size-[22px] items-center justify-center rounded-[5px]',
              stylex.props(queueSurface.action, roomy && queueSurface.roomyAction).className,
              'text-muted-foreground transition-colors',
              'hover:bg-[hsl(var(--foreground)/0.07)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              'disabled:pointer-events-none disabled:opacity-50',
              destructive && 'hover:text-destructive'
            )}
            onClick={onClick}
          >
            <Icon size={roomy ? 16 : 14} strokeWidth={1.5} />
          </button>
        }
      />
      <Tooltip.Content side="top">{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}
