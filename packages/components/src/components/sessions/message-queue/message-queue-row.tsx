import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, GripVertical, Pencil, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MessageQueueItem, SessionId } from '@lody/shared';
import { normalizeSessionInputBlocks } from '@lody/shared';
import { Tooltip } from '@lody/ui/tooltip';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { QueuedImagePreview, type QueuedImageBlock } from './queued-image-preview';
import { queueSurface } from './surface';
import { shouldShowQueuedItemSteer } from './queued-message-steer';
import { getEditableTaskText } from './use-message-queue-editing';
import { themeColors } from '../../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeRadius,
  themeShadow,
  themeSpace,
} from '../../../style/theme-scale.stylex';

const MAX_INLINE_IMAGES = 3;

/** The queue's own muted ink, at the two steps the rows use. */
const MUTED_FOREGROUND_60 = 'hsl(var(--muted-foreground) / 0.6)';
const MUTED_FOREGROUND_70 = 'hsl(var(--muted-foreground) / 0.7)';

/** Tailwind's `transition-colors`, as the property it actually sets. */
const transitionColors = stylex.create({
  colors: {
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
});

/**
 * The queue's shared row look. The pending row (a send still uploading) is the
 * same row, so it reads these too.
 */
export const queueRowStyles = stylex.create({
  row: {
    position: 'relative',
    gap: themeSpace[2],
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1.5],
  },
  rowDragging: {
    zIndex: 10,
    backgroundColor: 'hsl(var(--muted) / 0.4)',
    opacity: 0.9,
    boxShadow: themeShadow.sm,
  },
  rowEditing: { backgroundColor: 'hsl(var(--background) / 0.6)' },
  /** The index sits on the task text's first line: its box is exactly that
   *  line box (`text-xs leading-snug` = 0.75rem × 1.375). */
  leadingBox: {
    display: 'flex',
    height: 'calc(0.75rem * 1.375)',
    width: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leadingIndex: {
    fontSize: '10px',
    fontWeight: themeFontWeight.medium,
    fontVariantNumeric: 'tabular-nums',
  },
  leadingIndexMuted: { color: MUTED_FOREGROUND_60 },
  leadingButton: {
    borderRadius: '0.25rem',
    cursor: { default: 'grab', ':active': 'grabbing' },
    backgroundColor: { default: null, ':hover': themeColors.hover },
    // The old Tailwind `focus-visible:ring-*` painted nothing — the app forces
    // Tailwind's own ring transparent — but it still declared a `box-shadow`,
    // and a utility-layer shadow beats the base layer's inset focus ring. So
    // the handle showed NO focus indicator at all. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  leadingButtonInk: {
    color: { default: MUTED_FOREGROUND_60, ':hover': themeColors.foreground },
  },
  indexGlyph: { display: 'block' },
  gripGlyph: { display: 'none', height: themeSpace[3], width: themeSpace[3] },
  editorBody: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  editorShell: {
    borderRadius: themeRadius.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: 'hsl(var(--border) / 0.6)', ':focus-within': themeColors.ring },
    backgroundColor: 'hsl(var(--background) / 0.8)',
    // The wrapper is never focused itself — its textarea is — so this ring is
    // a real one, not the focus-scoped ring the app's base layer erases.
    boxShadow: { default: null, ':focus-within': '0 0 0 2px hsl(var(--ring) / 0.2)' },
  },
  editorInput: {
    display: 'block',
    width: '100%',
    resize: 'none',
    borderColor: 'transparent',
    backgroundColor: 'transparent',
    paddingInline: themeSpace[2],
    paddingTop: themeSpace[1],
    fontSize: themeFontSize.xs,
    lineHeight: '1.375',
    color: themeColors.foreground,
    // The shell owns the focus ring; the base layer's inset shadow would draw
    // another rectangle on the textarea.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  editorFooter: {
    display: 'flex',
    justifyContent: 'flex-end',
    paddingInline: themeSpace[1],
    paddingBottom: themeSpace[1],
  },
  editorImages: {
    marginTop: themeSpace[1],
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: themeSpace[1],
  },
  overflowCount: { fontSize: '10px', color: MUTED_FOREGROUND_70 },
  rowBody: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'flex-start',
    gap: themeSpace[1.5],
  },
  rowImages: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[0.5],
    paddingTop: '1px',
  },
  rowOverflow: {
    marginLeft: themeSpace[0.5],
    fontSize: '10px',
    color: MUTED_FOREGROUND_70,
    fontVariantNumeric: 'tabular-nums',
  },
  rowText: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    fontSize: themeFontSize.xs,
    lineHeight: '1.375',
    color: 'hsl(var(--foreground) / 0.8)',
  },
  rowActions: { display: 'flex', flexShrink: 0, alignItems: 'center' },
  actionButton: {
    display: 'flex',
    height: themeSpace[5],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '0.25rem',
    paddingInline: themeSpace[1.5],
    // Same as the drag handle above: the old Tailwind `focus-visible:ring-*`
    // erased the base layer's inset focus ring, so the button showed NO focus
    // indicator. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  actionInk: {
    fontSize: '11px',
    fontWeight: themeFontWeight.medium,
    backgroundColor: { default: null, ':hover': themeColors.hover },
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
  },
  iconButton: {
    display: 'flex',
    height: themeSpace[5],
    width: themeSpace[5],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '0.25rem',
    // Same as the drag handle above: the old Tailwind `focus-visible:ring-*`
    // erased the base layer's inset focus ring, so the button showed NO focus
    // indicator. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  iconInk: {
    backgroundColor: { default: null, ':hover': themeColors.hover },
    color: { default: MUTED_FOREGROUND_60, ':hover': themeColors.foreground },
    pointerEvents: { default: 'auto', ':disabled': 'none' },
    opacity: { default: 1, ':disabled': 0.5 },
  },
  iconInkDestructive: {
    color: { default: MUTED_FOREGROUND_60, ':hover': themeColors.destructive },
  },
  actionGlyph: { height: themeSpace[3], width: themeSpace[3] },
});

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

  const rowProps = stylex.props(
    queueSurface.row,
    queueRowStyles.row,
    transitionColors.colors,
    sortable.isDragging && queueRowStyles.rowDragging,
    isEditing && queueRowStyles.rowEditing
  );

  return (
    <div
      ref={sortable.setNodeRef}
      {...rowProps}
      style={style}
      className={clsx(
        rowProps.className,
        // The group's own marker: the index swaps for the grip on row hover.
        'group/row',
        // Dividers go between rows only. (`divide-y` on the list also lined the
        // last row, because dnd-kit appends hidden nodes after it, and that
        // line doubled the composer's top border into a shadow-like band.)
        '[&+&]:border-t [&+&]:border-border/30'
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
        {...stylex.props(
          queueRowStyles.leadingBox,
          queueRowStyles.leadingIndex,
          queueRowStyles.leadingIndexMuted
        )}
      >
        {index + 1}
      </div>
    );
  }

  const indexProps = stylex.props(queueRowStyles.indexGlyph);
  const gripProps = stylex.props(queueRowStyles.gripGlyph);

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={300}
        render={
          <button
            type="button"
            ref={sortable.setActivatorNodeRef}
            {...stylex.props(
              queueRowStyles.leadingBox,
              queueRowStyles.leadingIndex,
              transitionColors.colors,
              queueRowStyles.leadingButton,
              queueRowStyles.leadingButtonInk
            )}
            aria-label={label}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            {/* The group's hover states live in Tailwind: StyleX has no
                group selector, so the swap is still the group's. */}
            <span
              {...indexProps}
              className={clsx(
                indexProps.className,
                'group-hover/row:hidden group-focus-within/row:hidden'
              )}
            >
              {index + 1}
            </span>
            <GripVertical
              {...gripProps}
              className={clsx(
                gripProps.className,
                'group-hover/row:block group-focus-within/row:block'
              )}
            />
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
      <div {...stylex.props(queueRowStyles.editorBody)}>
        <div {...stylex.props(queueRowStyles.editorShell, transitionColors.colors)}>
          <textarea
            // The synced editing flag can arrive before startEdit resolves; attach when enabled.
            ref={isPending ? null : focusEditorAtEnd}
            value={editValue}
            rows={3}
            {...stylex.props(queueRowStyles.editorInput)}
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
            {...stylex.props(queueRowStyles.editorFooter)}
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
          <div {...stylex.props(queueRowStyles.editorImages)}>
            {inlineImages.map((image, i) => (
              <QueuedImagePreview
                key={`${image.imageId}-${i}`}
                sessionId={sessionId}
                image={image}
                size={20}
              />
            ))}
            {overflowImageCount > 0 ? (
              <span {...stylex.props(queueRowStyles.overflowCount)}>+{overflowImageCount}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div {...stylex.props(queueRowStyles.rowBody)}>
      {inlineImages.length > 0 ? (
        <div {...stylex.props(queueRowStyles.rowImages)}>
          {inlineImages.map((image, i) => (
            <QueuedImagePreview
              key={`${image.imageId}-${i}`}
              sessionId={sessionId}
              image={image}
              size={18}
            />
          ))}
          {overflowImageCount > 0 ? (
            <span {...stylex.props(queueRowStyles.rowOverflow)}>+{overflowImageCount}</span>
          ) : null}
        </div>
      ) : null}
      <div
        {...stylex.props(queueSurface.text, queueRowStyles.rowText)}
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

  return (
    <div {...stylex.props(queueSurface.actions, queueRowStyles.rowActions)}>
      {shouldShowQueuedItemSteer({ showSteerAction, isFirst, nativeSteerAvailable }) ? (
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
      {...stylex.props(
        queueSurface.action,
        queueRowStyles.actionButton,
        transitionColors.colors,
        queueRowStyles.actionInk
      )}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

export function IconAction({
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
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={300}
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            {...stylex.props(
              queueSurface.action,
              queueRowStyles.iconButton,
              transitionColors.colors,
              queueRowStyles.iconInk,
              destructive && queueRowStyles.iconInkDestructive
            )}
            onClick={onClick}
          >
            <Icon {...stylex.props(queueRowStyles.actionGlyph)} />
          </button>
        }
      />
      <Tooltip.Content side="top">{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}
