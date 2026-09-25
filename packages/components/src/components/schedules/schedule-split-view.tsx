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
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { History, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Drawer } from '@lody/ui/drawer';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import { WINDOW_DRAG_EXEMPT_CLASS, useWindowDragRegionClass } from '@/ui/window-drag-region';

/** Default width of the list while a schedule is open beside it. */
export const SCHEDULE_LIST_DEFAULT_WIDTH = 560;
const MIN_LIST_WIDTH = 280;
/** The editor's form needs about this much before its rows wrap badly. */
const MIN_DETAIL_WIDTH = 440;

const ease = [0.32, 0.72, 0, 1] as const;

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
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
 * With nothing open the list is the page. Opening a schedule slides it in from
 * the trailing edge like a sidebar while the list gives up the room; closing
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
    <div ref={containerRef} className="relative flex h-full min-h-0 overflow-hidden">
      <motion.div
        className="h-full min-w-0 shrink-0 overflow-hidden"
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
            className="absolute inset-y-0 right-0 flex min-w-0 flex-col border-l-[0.5px] border-border bg-background shadow-[-8px_0_24px_-16px_rgba(0,0,0,0.25)]"
            style={{ left: width }}
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
        'group/split absolute inset-y-0 -left-1.5 z-30 flex w-3 cursor-col-resize touch-none select-none justify-center focus-visible:outline-hidden',
        WINDOW_DRAG_EXEMPT_CLASS
      )}
    >
      <span className="h-full w-px bg-transparent transition-colors group-hover/split:bg-ring/60 group-focus-visible/split:bg-ring group-active/split:bg-ring" />
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
 * icon actions on the trailing side, run history last. A new schedule has
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
    onHistory: () => void;
  };
}) {
  const { t } = useTranslation();
  // In Electron the window's drag strip lies over the top 44px; the toolbar
  // joins the drag region above it and its buttons opt out, or none is clickable.
  const windowDrag = useWindowDragRegionClass();
  return (
    <Tooltip.Provider>
      <div
        className={cn(
          'flex h-11 shrink-0 items-center gap-0.5 border-b-[0.5px] border-border px-2',
          windowDrag
        )}
      >
        <ToolbarButton label={t('schedules.close', 'Close')} onClick={onClose}>
          <X className="size-full" />
        </ToolbarButton>
        {paused ? (
          <span className="ml-1.5 rounded-full border-[0.5px] border-border px-2 py-px text-[0.75em] text-muted-foreground">
            {t('schedules.paused', 'Paused')}
          </span>
        ) : null}
        {actions ? (
          <div className="ml-auto flex items-center gap-0.5">
            <ToolbarButton
              label={
                actions.enabled ? t('schedules.pause', 'Pause') : t('schedules.resume', 'Resume')
              }
              disabled={!actions.canToggle}
              onClick={actions.onToggle}
            >
              {actions.enabled ? (
                <Pause className="size-full" />
              ) : (
                <RotateCcw className="size-full" />
              )}
            </ToolbarButton>
            <ToolbarButton
              label={t('schedules.runNow', 'Run now')}
              disabled={!actions.canRun}
              onClick={actions.onRun}
            >
              <Play className="size-full" />
            </ToolbarButton>
            <ToolbarButton
              label={t('schedules.delete', 'Delete')}
              tone="destructive"
              disabled={!actions.canDelete}
              onClick={actions.onDelete}
            >
              <Trash2 className="size-full" />
            </ToolbarButton>
            <ToolbarButton
              label={t('schedules.history', 'Run history')}
              onClick={actions.onHistory}
            >
              <History className="size-full" />
            </ToolbarButton>
          </div>
        ) : null}
      </div>
    </Tooltip.Provider>
  );
}

/** Run history in a drawer from the trailing edge, off the editor's page. */
export function ScheduleHistoryDrawer({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Drawer.Root side="end" open={open} onOpenChange={onOpenChange}>
      <Drawer.Content
        side="end"
        closeLabel={t('schedules.close', 'Close')}
        className="flex w-[min(24rem,100vw)] flex-col p-0"
      >
        <Drawer.Header className="shrink-0 px-4 py-3">
          <Drawer.Title>{t('schedules.history', 'Run history')}</Drawer.Title>
        </Drawer.Header>
        <div data-settings-surface="" className="min-h-0 flex-1 overflow-auto px-3 pb-4">
          {children}
        </div>
      </Drawer.Content>
    </Drawer.Root>
  );
}
