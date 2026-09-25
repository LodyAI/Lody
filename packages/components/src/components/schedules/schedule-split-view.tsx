import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { History, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Drawer } from '@lody/ui/drawer';
import { Tooltip } from '@lody/ui/tooltip';

/** Width of the list once a schedule is open beside it: names only. */
export const SCHEDULE_LIST_COMPACT_WIDTH = 260;

const ease = [0.22, 1, 0.36, 1] as const;

/**
 * The list and one schedule on the same level, never stacked.
 *
 * With nothing open the list is the page. Opening a schedule narrows the list
 * to its names and slides the schedule in from the trailing edge, like a
 * sidebar; closing reverses both. The detail is laid over the space the list
 * gives up, so the two move together instead of one waiting for the other.
 */
export function ScheduleSplitView({
  open,
  list,
  detail,
}: {
  open: boolean;
  /** Rendered compact (`true`) while a schedule is open. */
  list: (compact: boolean) => ReactNode;
  detail: ReactNode;
}) {
  const reduce = useReducedMotion();
  const transition = reduce ? { duration: 0 } : { duration: 0.28, ease };
  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <motion.div
        className="h-full min-w-0 shrink-0 overflow-hidden"
        initial={false}
        animate={{ width: open ? SCHEDULE_LIST_COMPACT_WIDTH : '100%' }}
        transition={transition}
      >
        {list(open)}
      </motion.div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.section
            key="detail"
            className="absolute inset-y-0 right-0 flex min-w-0 flex-col border-l-[0.5px] border-border bg-background"
            style={{ left: SCHEDULE_LIST_COMPACT_WIDTH }}
            initial={{ x: '40%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '40%', opacity: 0 }}
            transition={transition}
          >
            {detail}
          </motion.section>
        ) : null}
      </AnimatePresence>
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
  return (
    <Tooltip.Provider>
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-b-[0.5px] border-border px-2">
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
