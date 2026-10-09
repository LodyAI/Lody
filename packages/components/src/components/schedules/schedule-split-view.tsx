import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import { WINDOW_DRAG_EXEMPT_CLASS, useWindowDragRegionClass } from '@/ui/window-drag-region';

/** Default width of the list while a schedule is open: the schedule gets the rest. */
export const SCHEDULE_LIST_DEFAULT_WIDTH = 380;
const MIN_LIST_WIDTH = 280;
/** The editor's form needs about this much before its rows wrap badly. */
const MIN_DETAIL_WIDTH = 440;

const ease = [0.32, 0.72, 0, 1] as const;

const styles = stylex.create({
  layout: { display: 'flex', minHeight: 0, flex: '1 1 0%', overflow: 'hidden' },
  list: { height: '100%', minWidth: 0, flexShrink: 0, overflow: 'hidden' },
  detail: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    borderLeftWidth: '0.5px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'hsl(var(--border))',
    backgroundColor: 'hsl(var(--background))',
    boxShadow: '-8px 0 24px -16px rgba(0,0,0,0.25)',
  },
  detailOffset: (left: number) => ({ left }),
  resizeHandle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '-6px',
    zIndex: 30,
    display: 'flex',
    width: '12px',
    cursor: 'col-resize',
    touchAction: 'none',
    userSelect: 'none',
    justifyContent: 'center',
    outlineStyle: {
      ':focus-visible': { default: 'none', '@media (forced-colors: active)': 'solid' },
    },
    outlineWidth: { ':focus-visible': { '@media (forced-colors: active)': '2px' } },
    outlineColor: { ':focus-visible': { '@media (forced-colors: active)': 'transparent' } },
    outlineOffset: { ':focus-visible': { '@media (forced-colors: active)': '2px' } },
  },
  resizeLine: {
    height: '100%',
    width: '1px',
    backgroundColor: {
      default: 'transparent',
      [stylex.when.ancestor(':hover')]: 'hsl(var(--ring) / 0.6)',
      [stylex.when.ancestor(':focus-visible')]: 'hsl(var(--ring))',
      [stylex.when.ancestor(':active')]: 'hsl(var(--ring))',
    },
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  toolbar: {
    display: 'flex',
    height: '44px',
    flexShrink: 0,
    alignItems: 'center',
    columnGap: '2px',
    borderBottomWidth: '0.5px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border))',
    paddingLeft: '8px',
    paddingRight: '8px',
  },
  paused: {
    marginLeft: '6px',
    borderWidth: '0.5px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border))',
    borderRadius: '9999px',
    paddingLeft: '8px',
    paddingRight: '8px',
    paddingTop: '1px',
    paddingBottom: '1px',
    fontSize: '0.75em',
    color: 'hsl(var(--muted-foreground))',
  },
  actions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', columnGap: '2px' },
  icon: { width: '100%', height: '100%' },
});

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The list and one schedule on the same level, never stacked.
 *
 * The table sits under the list's header, which never moves. Opening a
 * schedule slides it in from the trailing edge like a sidebar, full height
 * over the header's trailing end, while the table gives up the room; closing
 * reverses both. The boundary between them is a drag handle, and the list
 * keeps its full table (scrolling sideways) at any width.
 *
 * It animates only because the route keeps it mounted: `/schedules` is a
 * layout route and opening a schedule changes a param, not the component.
 */
export function ScheduleSplitView({
  open,
  list,
  detail,
  listWidth = SCHEDULE_LIST_DEFAULT_WIDTH,
  onListWidthChange,
}: {
  open: boolean;
  list: ReactNode;
  detail: ReactNode;
  /** The list's width while a schedule is open, as the person last dragged it. */
  listWidth?: number;
  onListWidthChange?: (width: number) => void;
}) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const [containerRef, containerWidth] = useElementWidth<HTMLDivElement>();
  const [localWidth, setLocalWidth] = useState(listWidth);
  const [dragging, setDragging] = useState(false);
  useEffect(() => setLocalWidth(listWidth), [listWidth]);
  const maxWidth = Math.max(
    MIN_LIST_WIDTH,
    (containerWidth ?? Number.POSITIVE_INFINITY) - MIN_DETAIL_WIDTH
  );
  const clamp = (value: number) => Math.round(Math.min(maxWidth, Math.max(MIN_LIST_WIDTH, value)));
  const width = clamp(localWidth);
  const commit = (value: number) => {
    const next = clamp(value);
    setLocalWidth(next);
    onListWidthChange?.(next);
  };
  const transition = reduce || dragging ? { duration: 0 } : { duration: 0.3, ease };
  return (
    // Not `relative`: the panel is placed against the page (the list view's
    // section), so it rises over the header while the header itself stays put.
    <div ref={containerRef} {...stylex.props(styles.layout)}>
      <motion.div
        {...stylex.props(styles.list)}
        initial={false}
        animate={{ width: open ? width : '100%' }}
        transition={transition}
      >
        {list}
      </motion.div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.section
            key="detail"
            data-schedule-detail=""
            {...stylex.props(styles.detail, styles.detailOffset(width))}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={transition}
          >
            <SplitResizeHandle
              label={t('schedules.resizeList', 'Resize list')}
              value={width}
              min={MIN_LIST_WIDTH}
              max={maxWidth}
              onDragChange={setDragging}
              onChange={(value) => setLocalWidth(clamp(value))}
              onCommit={commit}
              onReset={() => commit(SCHEDULE_LIST_DEFAULT_WIDTH)}
            />
            {detail}
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * The boundary between list and schedule. Dragging is live and saved on
 * release; arrow keys step 16px; double-click restores the default.
 */
function SplitResizeHandle({
  label,
  value,
  min,
  max,
  onChange,
  onCommit,
  onReset,
  onDragChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  onReset: () => void;
  onDragChange: (dragging: boolean) => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; last: number }>(
    null
  );
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: value,
      last: value,
    };
    onDragChange(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.last = active.startWidth + event.clientX - active.startX;
    onChange(active.last);
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onDragChange(false);
    onCommit(active.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
    if (!step) return;
    event.preventDefault();
    onCommit(value + step);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={cn(
        stylex.props(stylex.defaultMarker(), styles.resizeHandle).className,
        WINDOW_DRAG_EXEMPT_CLASS
      )}
    >
      <span {...stylex.props(styles.resizeLine)} />
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  tone,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'destructive';
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            variant="ghost"
            size="small"
            icon
            tone={tone}
            disabled={disabled}
            className={WINDOW_DRAG_EXEMPT_CLASS}
            aria-label={label}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}

/**
 * The open schedule's header: close on the leading side, a compact row of
 * icon actions on the trailing side. A new schedule has
 * nothing to act on yet, so it shows only the close button.
 */
export function ScheduleDetailToolbar({
  onClose,
  paused,
  actions,
}: {
  onClose: () => void;
  paused?: boolean;
  actions?: {
    enabled: boolean;
    canToggle: boolean;
    canRun: boolean;
    canDelete: boolean;
    onToggle: () => void;
    onRun: () => void;
    onDelete: () => void;
  };
}) {
  const { t } = useTranslation();
  // On mobile the toolbar is the page's top edge, where Electron's window drag
  // strip lies; joining the drag region with its buttons exempt keeps them clickable.
  const windowDrag = useWindowDragRegionClass();
  return (
    <Tooltip.Provider>
      <div className={cn(stylex.props(styles.toolbar).className, windowDrag)}>
        <ToolbarButton label={t('schedules.close', 'Close')} onClick={onClose}>
          <X {...stylex.props(styles.icon)} />
        </ToolbarButton>
        {paused ? (
          <span {...stylex.props(styles.paused)}>{t('schedules.paused', 'Paused')}</span>
        ) : null}
        {actions ? (
          <div {...stylex.props(styles.actions)}>
            <ToolbarButton
              label={
                actions.enabled ? t('schedules.pause', 'Pause') : t('schedules.resume', 'Resume')
              }
              disabled={!actions.canToggle}
              onClick={actions.onToggle}
            >
              {actions.enabled ? (
                <Pause {...stylex.props(styles.icon)} />
              ) : (
                <RotateCcw {...stylex.props(styles.icon)} />
              )}
            </ToolbarButton>
            <ToolbarButton
              label={t('schedules.runNow', 'Run now')}
              disabled={!actions.canRun}
              onClick={actions.onRun}
            >
              <Play {...stylex.props(styles.icon)} />
            </ToolbarButton>
            <ToolbarButton
              label={t('schedules.delete', 'Delete')}
              tone="destructive"
              disabled={!actions.canDelete}
              onClick={actions.onDelete}
            >
              <Trash2 {...stylex.props(styles.icon)} />
            </ToolbarButton>
          </div>
        ) : null}
      </div>
    </Tooltip.Provider>
  );
}
