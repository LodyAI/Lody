import { control } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
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
import { QueuedImagePreview, type QueuedImageBlock } from './queued-image-preview';
import { QUEUE_LINE, queueSurface } from './surface';
import { shouldShowQueuedItemSteer } from './queued-message-steer';
import { getEditableTaskText } from './use-message-queue-editing';
import {
  themeFontSize,
  themeFontWeight,
  themeRadius,
  themeShadow,
  themeSpace,
} from '../../../style/theme-scale.stylex';

const MAX_INLINE_IMAGES = 3;

/** The queue's own muted ink, at the two steps the rows use. */
const MUTED_FOREGROUND_60 =
  'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 60%, transparent)';
const MUTED_FOREGROUND_70 =
  'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 70%, transparent)';

/** Tailwind's `transition-colors`, as the property it actually sets. */
const transitionColors = stylex.create({
  colors: {
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
});

/**
 * The queue's shared row look. The pending row (a send still uploading) is the
 * same row, so it reads these too.
 */
export const queueRowStyles = stylex.create({
  divider: {
    borderTopWidth: {
      default: null,
      ':is([data-message-queue-row] + [data-message-queue-row])': '1px',
    },
    borderTopStyle: {
      default: null,
      ':is([data-message-queue-row] + [data-message-queue-row])': 'solid',
    },
    borderTopColor: {
      default: null,
      ':is([data-message-queue-row] + [data-message-queue-row])':
        'color-mix(in oklab, hsl(var(--border) / 1) 30%, transparent)',
    },
  },
  row: {
    position: 'relative',
    gap: themeSpace[2],
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1.5],
  },
  roomyPosition: { position: 'relative' },
  rowDragging: {
    zIndex: 10,
    backgroundColor: 'hsl(var(--composer))',
    opacity: 0.95,
    boxShadow: themeShadow.md,
  },
  rowEditing: {
    backgroundColor: 'color-mix(in oklab, hsl(var(--background) / 1) 60%, transparent)',
  },
  /** The index sits on the task text's first line: its box is exactly that
   *  line box (`text-xs leading-snug` = 0.75rem × 1.375). */
  leadingHeight: (height: string) => ({ height }),
  leadingBox: {
    display: 'flex',
    width: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leadingIndex: {
    transform: 'translateY(1px)',
    fontSize: '11px',
    fontWeight: themeFontWeight.medium,
    fontVariantNumeric: 'tabular-nums',
  },
  leadingIndexMuted: { color: MUTED_FOREGROUND_70 },
  leadingButton: {
    borderRadius: '0.25rem',
    cursor: { default: 'grab', ':active': 'grabbing' },
    backgroundColor: {
      default: null,
      '@media (hover: hover)': { ':hover': 'hsl(var(--hover) / 1)' },
    },
    // The old Tailwind `focus-visible:ring-*` painted nothing — the app forces
    // Tailwind's own ring transparent — but it still declared a `box-shadow`,
    // and a utility-layer shadow beats the base layer's inset focus ring. So
    // the handle showed NO focus indicator at all. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  leadingButtonInk: {
    color: {
      default: MUTED_FOREGROUND_70,
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground) / 1)' },
    },
  },
  indexGlyph: {
    display: {
      default: 'block',
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-message-queue-row]):hover')]: 'none',
      },
      [stylex.when.ancestor(':is([data-message-queue-row]):focus-within')]: 'none',
    },
  },
  gripGlyph: {
    display: {
      default: 'none',
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-message-queue-row]):hover')]: 'block',
      },
      [stylex.when.ancestor(':is([data-message-queue-row]):focus-within')]: 'block',
    },
    height: themeSpace[3],
    width: themeSpace[3],
  },
  footerBody: { minWidth: 'calc(var(--spacing) * 0)', flex: 1 },
  editorBody: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  editorShell: {
    borderRadius: themeRadius.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
      ':focus-within': 'hsl(var(--ring) / 1)',
    },
    backgroundColor: 'hsl(var(--composer))',
    // The wrapper is never focused itself — its textarea is — so this ring is
    // a real one, not the focus-scoped ring the app's base layer erases.
    boxShadow: {
      default: null,
      ':focus-within': '0 0 0 2px color-mix(in oklab, hsl(var(--ring) / 1) 20%, transparent)',
    },
  },
  editorInput: {
    display: 'block',
    width: '100%',
    resize: 'none',
    borderColor: 'transparent',
    backgroundColor: 'transparent',
    paddingInline: themeSpace[2],
    paddingTop: themeSpace[1.5],
    color: 'hsl(var(--foreground) / 1)',
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
    backgroundColor: {
      default: null,
      '@media (hover: hover)': { ':hover': 'hsl(var(--hover) / 1)' },
    },
    color: {
      default: 'hsl(var(--muted-foreground) / 1)',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground) / 1)' },
    },
  },
  iconButton: {
    display: 'flex',
    height: '22px',
    width: '22px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '5px',
    // Same as the drag handle above: the old Tailwind `focus-visible:ring-*`
    // erased the base layer's inset focus ring, so the button showed NO focus
    // indicator. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  iconInk: {
    backgroundColor: {
      default: null,
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground) / 0.07)' },
    },
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground) / 1)' },
    },
    pointerEvents: { default: 'auto', ':disabled': 'none' },
    opacity: { default: 1, ':disabled': control.disabledOpacity },
  },
  iconInkDestructive: {
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@media (hover: hover)': { ':hover': 'hsl(var(--destructive) / 1)' },
    },
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
  onMoveToTop?: () => void | Promise<void>;
  footer?: ReactNode;
  footerPosition?: 'below' | 'start' | 'end' | 'inline';
  roomy?: boolean | 'airy';
  /** The sheet is too narrow for inline actions: fold them into More. */
  compact?: boolean;
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
    stylex.defaultMarker(),
    queueSurface.row,
    props.roomy && queueRowStyles.roomyPosition,
    props.roomy && queueSurface.roomyRow,
    props.roomy === 'airy' && queueSurface.airyRow,
    transitionColors.colors,
    sortable.isDragging && queueRowStyles.rowDragging,
    isEditing && queueSurface.editingRow
  );

  return (
    <div
      ref={sortable.setNodeRef}
      data-message-queue-row=""
      {...rowProps}
      style={style}
      className={clsx(
        rowProps.className,
        // Keep the CSS hook; the StyleX marker limits the swap to this row.
        'group/row'
        // Dividers go between rows only. (`divide-y` on the list also lined the
        // last row, because dnd-kit appends hidden nodes after it, and that
        // line doubled the composer's top border into a shadow-like band.)
      )}
    >
      {props.roomy ? (
        <span {...stylex.props(queueSurface.leading)}>
          <LeadingHandle {...props} sortable={sortable} />
        </span>
      ) : (
        <LeadingHandle {...props} sortable={sortable} />
      )}
      {props.footerPosition === 'start' && !isEditing ? (
        <div {...stylex.props(queueSurface.inlineMeta)}>{props.footer}</div>
      ) : null}
      {props.footer && (!props.footerPosition || props.footerPosition === 'below') ? (
        <div {...stylex.props(queueRowStyles.footerBody)}>
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
        {...stylex.props(
          queueRowStyles.leadingBox,
          queueRowStyles.leadingHeight(roomy ? type.bodyLeading : QUEUE_LINE),
          queueRowStyles.leadingIndex,
          queueRowStyles.leadingIndexMuted
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
            {...stylex.props(
              queueRowStyles.leadingBox,
              queueRowStyles.leadingHeight(roomy ? type.bodyLeading : QUEUE_LINE),
              queueRowStyles.leadingIndex,
              transitionColors.colors,
              queueRowStyles.leadingButton,
              queueRowStyles.leadingButtonInk
            )}
            aria-label={label}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <span {...stylex.props(queueRowStyles.indexGlyph)}>{index + 1}</span>
            <GripVertical {...stylex.props(queueRowStyles.gripGlyph)} />
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
      <div {...stylex.props(queueRowStyles.editorBody, props.roomy && queueSurface.editor)}>
        <div {...stylex.props(queueRowStyles.editorShell, transitionColors.colors)}>
          <textarea
            // The synced editing flag can arrive before startEdit resolves; attach when enabled.
            ref={isPending ? null : focusEditorAtEnd}
            value={editValue}
            rows={3}
            {...stylex.props(queueRowStyles.editorInput, queueSurface.editorText)}
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
    <div {...stylex.props(queueRowStyles.rowBody, props.roomy && queueSurface.roomyBody)}>
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
        {...stylex.props(
          queueSurface.text,
          queueRowStyles.rowText,
          props.roomy && queueSurface.roomyBody
        )}
        style={{
          display: '-webkit-box',
          // A narrow sheet keeps every row to one line, like the phone layout.
          WebkitLineClamp: props.footerPosition === 'inline' || props.compact ? 1 : 2,
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

  // Phones, and any sheet too narrow for inline actions, fold every action into More.
  if ((mobile && props.roomy) || props.compact) {
    return (
      <div {...stylex.props(queueSurface.actions, props.roomy && queueSurface.roomyActions)}>
        <Menu.Root>
          <Menu.Trigger render={<MoreTrigger fine={!props.roomy} />} />
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

  return (
    <div
      {...stylex.props(
        queueSurface.actions,
        queueRowStyles.rowActions,
        props.roomy && queueSurface.roomyActions
      )}
    >
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
  );
}

/**
 * A row's More button; its menu carries every row action. Touch rows get a real
 * 40 × 36 px box; `fine` is the compact desktop trigger for a narrow sheet.
 */
export function MoreTrigger({ fine, ...props }: ComponentProps<'button'> & { fine?: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t('common.more', 'More')}
      {...props}
      {...stylex.props(queueSurface.more, fine && queueSurface.compactMore)}
    >
      <MoreHorizontal size={fine ? 14 : 16} strokeWidth={1.75} aria-hidden="true" />
    </button>
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
            {...stylex.props(
              queueSurface.action,
              queueRowStyles.iconButton,
              roomy && queueSurface.roomyAction,
              transitionColors.colors,
              queueRowStyles.iconInk,
              destructive && queueRowStyles.iconInkDestructive
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
