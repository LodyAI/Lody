import { control, radius as sharedRadius, text as type } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { cn } from '@/lib/utils';
import { useCallback, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CircleAlert,
  GripVertical,
  Info,
  Pencil,
  X,
  MoreHorizontal,
  Trash2,
  ArrowUpToLine,
  Send,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MessageQueueItem, SessionId, SessionInputBlock } from '@lody/shared';
import { MessageTextWithChips } from '@/components/mentions/message-text-chips';
import { normalizeSessionInputBlocks } from '@lody/shared';
import { Menu } from '@lody/ui/menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { Popover } from '@lody/ui/popover';
import { Tooltip } from '@lody/ui/tooltip';
import { SessionSendProgressRing } from '@/components/sidebar-row-shared';
import { QueuedImagePreview, type QueuedImageBlock } from './queued-image-preview';
import { QUEUE_LINE, queuePreviewStyle, queueSurface } from './surface';
import { shouldShowQueuedItemSteer } from './queued-message-steer';
import { QueuedMessageDetails, type QueuedRunConfigSummary } from './queued-message-details';
import { themeFontWeight, themeShadow, themeSpace } from '../../../style/theme-scale.stylex';

const MAX_INLINE_IMAGES = 3;

/** The queue's own muted index ink. */
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
  // This device is editing the row in the composer, or saving that edit.
  rowHeld: { opacity: 0.55 },
  // A quiet text control: the dimmed row already says it is held.
  heldLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1],
    flexShrink: 0,
    height: '20px',
    paddingInline: themeSpace[1],
    borderRadius: '0.25rem',
    borderWidth: 0,
    fontSize: '11px',
    fontWeight: themeFontWeight.medium,
    whiteSpace: 'nowrap',
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground) / 0.06)' },
    },
    color: colors.accent,
    cursor: 'pointer',
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  // Why a saved edit did not land, kept to one quiet line; details carry the rest.
  heldFailure: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1],
    minWidth: 0,
    marginTop: '1px',
    fontSize: '11.5px',
    lineHeight: '16px',
    color: colors.destructive,
  },
  heldFailureText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  heldGlyph: { color: colors.accent },
  heldStatus: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1],
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground) / 1)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  sender: { display: 'flex', flexShrink: 0, alignItems: 'center', paddingTop: '2px' },
  roomySender: { paddingTop: 0 },
  configTag: {
    display: 'inline-block',
    maxWidth: '40%',
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    verticalAlign: 'top',
    marginInlineEnd: themeSpace[1.5],
    paddingInline: themeSpace[1.5],
    borderRadius: '0.25rem',
    fontSize: '11px',
    lineHeight: '18px',
    marginTop: '3px',
    fontWeight: themeFontWeight.medium,
    backgroundColor: 'hsl(var(--foreground) / 0.06)',
    color: 'hsl(var(--muted-foreground) / 1)',
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
    borderRadius: sharedRadius.mini,
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

/** A saved edit whose new attachments are still preparing before it replaces the row. */
export type QueuedRowPendingEdit = {
  /** Upload progress, 0-100, when known. */
  progress: number | null;
  error?: string;
  busy: boolean;
  onRetry: () => void;
  onCancel: () => void;
};

export type MessageQueueRowProps = {
  sessionId: SessionId;
  item: MessageQueueItem;
  index: number;
  isFirst: boolean;
  showSteerAction: boolean;
  nativeSteerAvailable: boolean;
  sendWhileIdle?: boolean;
  canReorder: boolean;
  /** This device is editing the row in the composer. */
  isEditing: boolean;
  /** Another row of this queue is being edited; only one edit runs at a time. */
  editBlocked?: boolean;
  pendingEdit?: QueuedRowPendingEdit;
  onStartEdit: (item: MessageQueueItem) => void;
  /** The held row's "Editing" label returns to the composer. */
  onFocusEdit?: (item: MessageQueueItem) => void;
  onRemove: (cid: string) => void | Promise<void>;
  onSteer: (item: MessageQueueItem) => void | Promise<void>;
  onMoveToTop?: () => void | Promise<void>;
  footer?: ReactNode;
  footerPosition?: 'below' | 'start' | 'end' | 'inline';
  roomy?: boolean | 'airy';
  /** The sheet is too narrow for inline actions: fold them into More. */
  compact?: boolean;
  senderAvatar?: ReactNode;
  runConfig?: QueuedRunConfigSummary;
};

export function MessageQueueRow(props: MessageQueueRowProps) {
  const { item, canReorder, isEditing, pendingEdit } = props;
  const held = isEditing || pendingEdit !== undefined;
  const sortable = useSortable({ id: item.$cid, disabled: !canReorder || held });
  const constrainedTransform = sortable.transform
    ? { ...sortable.transform, x: 0, scaleX: 1, scaleY: 1 }
    : null;
  const style = {
    transform: CSS.Transform.toString(constrainedTransform),
    transition: sortable.transition,
  };
  const { setNodeRef } = sortable;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef]
  );

  const inputBlocks = useMemo(
    () => normalizeSessionInputBlocks(item.acpSessionConfig?.inputBlocks, ''),
    [item.acpSessionConfig?.inputBlocks]
  );
  const imageBlocks = inputBlocks.filter(
    (block): block is QueuedImageBlock => block.type === 'image'
  );

  const rowProps = stylex.props(
    stylex.defaultMarker(),
    queueSurface.row,
    props.roomy && queueRowStyles.roomyPosition,
    props.roomy && queueSurface.roomyRow,
    props.roomy === 'airy' && queueSurface.airyRow,
    transitionColors.colors,
    sortable.isDragging && queueRowStyles.rowDragging
  );

  return (
    <div
      ref={setRowRef}
      data-message-queue-row=""
      data-queue-row-state={isEditing ? 'editing' : pendingEdit ? 'saving' : 'idle'}
      {...rowProps}
      style={style}
      className={cn(
        rowProps.className,
        // Keep the CSS hook; the StyleX marker limits the swap to this row.
        'group/row'
      )}
    >
      {props.roomy ? (
        <span {...stylex.props(queueSurface.leading)}>
          <LeadingHandle {...props} held={held} sortable={sortable} />
        </span>
      ) : (
        <LeadingHandle {...props} held={held} sortable={sortable} />
      )}
      {props.footerPosition === 'start' ? (
        <div {...stylex.props(queueSurface.inlineMeta)}>{props.footer}</div>
      ) : null}
      {props.footer && (!props.footerPosition || props.footerPosition === 'below') ? (
        <div {...stylex.props(queueRowStyles.footerBody)}>
          <RowBody {...props} imageBlocks={imageBlocks} />
          {props.footer}
        </div>
      ) : (
        <RowBody {...props} imageBlocks={imageBlocks} />
      )}
      {props.footerPosition === 'end' ? (
        <div {...stylex.props(queueSurface.inlineMeta)}>{props.footer}</div>
      ) : null}
      <RowActions {...props} held={held} onOpenDetails={() => setDetailsOpen(true)} />
      <Popover.Root open={detailsOpen} onOpenChange={setDetailsOpen}>
        <Popover.Content
          anchor={rowRef}
          side="top"
          align="end"
          width={340}
          maxWidth="calc(100vw - 24px)"
        >
          <QueuedMessageDetails
            sessionId={props.sessionId}
            item={item}
            summary={props.runConfig}
            senderAvatar={props.senderAvatar}
            editDisabled={held || props.editBlocked}
            onEdit={() => {
              setDetailsOpen(false);
              props.onStartEdit(item);
            }}
          />
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}

function LeadingHandle({
  index,
  roomy,
  canReorder,
  held,
  sortable,
}: MessageQueueRowProps & { held: boolean; sortable: ReturnType<typeof useSortable> }) {
  const { t } = useTranslation();
  const label = t('sessions.messageQueue.dragToReorder', 'Drag to reorder');

  if (!canReorder || held) {
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

function RowBody(props: MessageQueueRowProps & { imageBlocks: QueuedImageBlock[] }) {
  const { sessionId, item, imageBlocks, senderAvatar, runConfig } = props;
  const inlineImages = imageBlocks.slice(0, MAX_INLINE_IMAGES);
  const overflowImageCount = Math.max(0, imageBlocks.length - inlineImages.length);
  // The difference tag is a hint; narrow sheets and touch rows leave it to the details.
  const tag = !props.compact && !props.roomy ? runConfig?.differenceTag : null;
  const failure =
    props.pendingEdit && !props.pendingEdit.busy ? props.pendingEdit.error : undefined;
  // The held row's message dims; its failure, status and actions stay at full strength.
  const dim = (props.isEditing || props.pendingEdit !== undefined) && queueRowStyles.rowHeld;

  return (
    <div {...stylex.props(queueRowStyles.rowBody, props.roomy && queueSurface.roomyBody)}>
      {senderAvatar ? (
        <span
          {...stylex.props(queueRowStyles.sender, props.roomy && queueRowStyles.roomySender, dim)}
          title={item.userName}
        >
          {senderAvatar}
        </span>
      ) : null}
      {inlineImages.length > 0 ? (
        <div {...stylex.props(queueRowStyles.rowImages, dim)}>
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
      <div {...stylex.props(queueRowStyles.rowText, props.roomy && queueSurface.roomyBody)}>
        <div
          {...stylex.props(queueSurface.text, props.roomy && queueSurface.roomyBody, dim)}
          style={{
            ...queuePreviewStyle(props.footerPosition === 'inline' || !!props.compact),
          }}
        >
          {tag ? (
            <span {...stylex.props(queueRowStyles.configTag)} data-queue-config-tag="">
              {tag}
            </span>
          ) : null}
          {props.footerPosition === 'inline' && props.footer ? <>{props.footer} </> : null}
          <QueuedRowText item={item} />
        </div>
        {failure ? (
          <div role="alert" title={failure} {...stylex.props(queueRowStyles.heldFailure)}>
            <CircleAlert size={12} strokeWidth={2.25} aria-hidden="true" />
            <span {...stylex.props(queueRowStyles.heldFailureText)}>{failure}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Touch rows and narrow sheets have one 40 x 36 action box: the held state fits
 * there as a glyph, and a failed save keeps its choices in the More menu.
 */
function CompactHeldStatus({ props }: { props: MessageQueueRowProps }) {
  const { t } = useTranslation();
  const { item, pendingEdit } = props;
  const fine = !props.roomy;
  if (pendingEdit?.error && !pendingEdit.busy) {
    return (
      <Menu.Root>
        <Menu.Trigger render={<MoreTrigger fine={fine} />} />
        <Menu.Content align="end" width="compact">
          <Menu.Item icon={Send} onClick={pendingEdit.onRetry}>
            {t('sessions.retryPendingSend')}
          </Menu.Item>
          <Menu.Item icon={Trash2} tone="destructive" onClick={pendingEdit.onCancel}>
            {t('sessions.messageQueue.discardEdit', 'Discard this edit')}
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>
    );
  }
  if (pendingEdit) {
    const label =
      pendingEdit.progress !== null
        ? t('sessions.attachmentUploading', { progress: pendingEdit.progress })
        : t('sessions.messageQueue.savingEdit', 'Saving edit');
    return (
      <span
        role="status"
        aria-label={label}
        {...stylex.props(queueSurface.more, fine && queueSurface.compactMore)}
      >
        <SessionSendProgressRing progress={pendingEdit.progress ?? undefined} />
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={t('sessions.messageQueue.editingInComposer', 'Editing in the composer')}
      {...stylex.props(
        queueSurface.more,
        fine && queueSurface.compactMore,
        queueRowStyles.heldGlyph
      )}
      onClick={() => props.onFocusEdit?.(item)}
    >
      <Pencil size={fine ? 13 : 15} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

/** The row's preview; a single mentioned text shows its mentions as chips. */
function QueuedRowText({ item }: { item: MessageQueueItem }) {
  const text = useMemo(() => {
    const blocks = normalizeSessionInputBlocks(item.acpSessionConfig?.inputBlocks, '');
    const texts = blocks.filter(
      (block): block is Extract<SessionInputBlock, { type: 'text' }> => block.type === 'text'
    );
    const only = texts.length === 1 ? texts[0] : undefined;
    return only?.spans?.length && only.text.trim() === item.task.trim() ? only : undefined;
  }, [item.acpSessionConfig?.inputBlocks, item.task]);
  if (!text) return <>{item.task}</>;
  return <MessageTextWithChips text={text.text} spans={text.spans} />;
}

function HeldStatus({ props }: { props: MessageQueueRowProps }) {
  const { t } = useTranslation();
  const { item, pendingEdit } = props;
  if (pendingEdit) {
    if (pendingEdit.error && !pendingEdit.busy) {
      return (
        <>
          <TextAction
            text={t('sessions.retryPendingSend')}
            ariaLabel={t('sessions.retryPendingSend')}
            onClick={pendingEdit.onRetry}
          />
          <IconAction
            icon={X}
            label={t('sessions.messageQueue.discardEdit', 'Discard this edit')}
            destructive
            onClick={pendingEdit.onCancel}
          />
        </>
      );
    }
    return (
      <>
        <span role="status" {...stylex.props(queueRowStyles.heldStatus)}>
          <SessionSendProgressRing progress={pendingEdit.progress ?? undefined} />
          {pendingEdit.progress !== null
            ? t('sessions.attachmentUploading', { progress: pendingEdit.progress })
            : t('sessions.messageQueue.savingEdit', 'Saving edit')}
        </span>
        <IconAction
          icon={X}
          label={t('sessions.messageQueue.discardEdit', 'Discard this edit')}
          destructive
          disabled={pendingEdit.busy}
          onClick={pendingEdit.onCancel}
        />
      </>
    );
  }
  return (
    <button
      type="button"
      {...stylex.props(queueRowStyles.heldLabel)}
      aria-label={t('sessions.messageQueue.editingInComposer', 'Editing in the composer')}
      onClick={() => props.onFocusEdit?.(item)}
    >
      <Pencil size={11} strokeWidth={2} aria-hidden="true" />
      {t('sessions.messageQueue.editing', 'Editing')}
    </button>
  );
}

function RowActions(props: MessageQueueRowProps & { held: boolean; onOpenDetails: () => void }) {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const {
    item,
    isFirst,
    showSteerAction,
    nativeSteerAvailable,
    held,
    editBlocked,
    onStartEdit,
    onRemove,
    onSteer,
    onOpenDetails,
  } = props;
  const detailsLabel = t('sessions.messageQueue.details.open', 'Message details');

  // A held row keeps its place: it offers its details and its edit status only.
  if (held && ((mobile && props.roomy) || props.compact)) {
    return (
      <div {...stylex.props(queueSurface.actions, props.roomy && queueSurface.roomyActions)}>
        <CompactHeldStatus props={props} />
      </div>
    );
  }
  if (held) {
    return (
      <div
        {...stylex.props(
          queueSurface.actions,
          queueRowStyles.rowActions,
          props.roomy && queueSurface.roomyActions
        )}
      >
        <HeldStatus props={props} />
        <IconAction roomy={props.roomy} icon={Info} label={detailsLabel} onClick={onOpenDetails} />
      </div>
    );
  }

  const steer = shouldShowQueuedItemSteer({
    showSteerAction,
    isFirst,
    nativeSteerAvailable:
      nativeSteerAvailable || props.sendWhileIdle === true || item.paused === true,
  });

  // Phones, and any sheet too narrow for inline actions, fold every action into More.
  if ((mobile && props.roomy) || props.compact) {
    return (
      <div {...stylex.props(queueSurface.actions, props.roomy && queueSurface.roomyActions)}>
        <Menu.Root>
          <Menu.Trigger render={<MoreTrigger fine={!props.roomy} />} />
          <Menu.Content align="end" width="compact">
            {steer ? (
              <Menu.Item icon={Send} onClick={() => void onSteer(item)}>
                {props.sendWhileIdle
                  ? t('sessions.messageQueue.sendAction', 'Send')
                  : t('sessions.messageQueue.guideAction', 'Steer')}
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
            <Menu.Item icon={Info} onClick={onOpenDetails}>
              {detailsLabel}
            </Menu.Item>
            <Menu.Item icon={Pencil} disabled={editBlocked} onClick={() => onStartEdit(item)}>
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
      {steer ? (
        <button
          type="button"
          aria-label={
            props.sendWhileIdle
              ? t('sessions.messageQueue.sendAction', 'Send')
              : t('sessions.messageQueue.guide', 'Steer the active response with this message')
          }
          {...stylex.props(queueSurface.steer)}
          onClick={() => {
            void onSteer(item);
          }}
        >
          {props.sendWhileIdle
            ? t('sessions.messageQueue.sendAction', 'Send')
            : t('sessions.messageQueue.guideAction', 'Steer')}
        </button>
      ) : null}
      <IconAction roomy={props.roomy} icon={Info} label={detailsLabel} onClick={onOpenDetails} />
      <IconAction
        roomy={props.roomy}
        icon={Pencil}
        label={t('sessions.messageQueue.editMessage', 'Edit queued message')}
        disabled={editBlocked}
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
