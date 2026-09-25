import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CalendarClock,
  ChevronRight,
  CloudOff,
  ExternalLink,
  History,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { getServerNow, type ScheduleRegistryRow, type ScheduleRuntimeRow } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { ContextMenu } from '@lody/ui/context-menu';
import { Input } from '@lody/ui/input';
import { Skeleton } from '@lody/ui/skeleton';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  describeDestination,
  describeStatus,
  describeTrigger,
  formatInstant,
  formatUpcoming,
  triggerTimeZone,
  type ScheduleStatus,
} from './schedule-format';

export function matchingScheduleRuntime(row: ScheduleRegistryRow, runtimes: ScheduleRuntimeRow[]) {
  return runtimes.find(
    (runtime) =>
      runtime.scheduleId === row.scheduleId &&
      runtime.machineId === row.machineId &&
      runtime.activationId === row.activationId &&
      runtime.observedDefinitionFingerprint === row.definitionFingerprint
  );
}

export type ScheduleRowContext = {
  machine: string;
  agent: string;
  /** `null` for a chat-only schedule that is not bound to any project. */
  project: string | null;
  presence: 'online' | 'offline' | 'unknown';
  canToggle: boolean;
  /** Owner on a machine that can run schedules. A paused schedule can still run. */
  canRun?: boolean;
  /** Owner only; deleting is always possible, even when the machine is gone. */
  canDelete?: boolean;
};

/** Pixel widths of the resizable columns; "Runs with" takes the rest. */
export type ScheduleColumnWidths = { name: number; frequency: number; next: number };
const DEFAULT_COLUMN_WIDTHS: ScheduleColumnWidths = { name: 300, frequency: 200, next: 200 };
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 720;
const clampWidth = (value: number) =>
  Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, value)));

/**
 * Only states that are not the happy path get a pill. An enabled schedule with
 * a next run already says so by having a next run.
 */
function StatusPill({ status }: { status: ScheduleStatus }) {
  if (status.tone === 'active') return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full border-[0.5px] px-1.5 py-px text-[0.85em] font-normal leading-tight',
        status.tone === 'attention' && 'border-status-warning/40 text-status-warning',
        status.tone === 'progress' && 'border-status-info/40 text-status-info',
        status.tone === 'muted' && 'border-border text-muted-foreground'
      )}
    >
      {status.label}
    </span>
  );
}

/**
 * One column template for the header and every row.
 *
 * The actions column is a fixed width rather than `auto`: sized by its content
 * it varied per row, which redistributed the `fr` columns and left Frequency
 * and Next run visibly unaligned down the list.
 */
const listGridClass =
  'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 sm:grid-cols-[var(--schedule-col-name)_var(--schedule-col-frequency)_var(--schedule-col-next)_minmax(0,1fr)_5.75rem]';

/**
 * The resizable tracks shrink before they overflow: `minmax(min, width)` keeps a
 * dragged width in a wide window and still fits a narrow panel.
 */
const columnVars = (widths: ScheduleColumnWidths) =>
  ({
    '--schedule-col-name': `minmax(${MIN_COLUMN_WIDTH}px,${widths.name}px)`,
    '--schedule-col-frequency': `minmax(${MIN_COLUMN_WIDTH}px,${widths.frequency}px)`,
    '--schedule-col-next': `minmax(${MIN_COLUMN_WIDTH}px,${widths.next}px)`,
  }) as CSSProperties;

const cell = {
  name: 'col-start-1 row-start-1',
  frequency: 'col-span-2 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1',
  next: 'col-span-2 row-start-3 sm:col-span-1 sm:col-start-3 sm:row-start-1',
  target: 'col-span-2 row-start-4 sm:col-span-1 sm:col-start-4 sm:row-start-1',
  actions: 'col-start-2 row-start-1 sm:col-start-5 sm:row-start-1',
} as const;

function ScheduleListRow({
  row,
  runtime,
  context,
  now,
  onOpen,
  onToggle,
  onRun,
  onDelete,
  onOpenSession,
  compact,
  selected,
}: {
  row: ScheduleRegistryRow;
  runtime?: ScheduleRuntimeRow;
  /** Beside an open schedule: the name and a status pill, nothing else. */
  compact?: boolean;
  selected?: boolean;
  context?: ScheduleRowContext;
  now: number;
  onOpen: () => void;
  onToggle?: () => void;
  onRun?: () => void;
  onDelete?: () => void;
  onOpenSession?: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const zone = triggerTimeZone(row.trigger);
  const status = describeStatus(t, row.enabled, runtime?.queueState);
  const next = row.enabled ? runtime?.nextScheduledAt : undefined;
  // A run that is appended to a chat has that chat's workspace, so the
  // destination is the more useful fact than a project it does not have.
  const project =
    row.destination.kind !== 'new_session'
      ? describeDestination(row.destination, t)
      : (context?.project ?? (row.projectKey || null) ?? t('schedules.chatOnly', 'Chat only'));
  const manual = row.trigger.kind === 'manual';
  const offline = context ? context.presence !== 'online' : false;
  const canToggle = !!onToggle && context?.canToggle !== false;
  const canRun = !!onRun && context?.canRun !== false;
  const canDelete = !!onDelete && context?.canDelete !== false;
  const lastSessionId = runtime?.lastDispatch?.sessionId;
  const toggleLabel = row.enabled ? t('schedules.pause', 'Pause') : t('schedules.resume', 'Resume');
  const rowElement = compact ? (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[0.9em] leading-5 transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
        selected ? 'bg-foreground/[0.07] text-foreground dark:bg-white/[0.09]' : 'hover:bg-hover',
        !row.enabled && !selected && 'text-muted-foreground'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      <StatusPill status={status} />
    </button>
  ) : (
    <div
      className={cn(
        listGridClass,
        // Cells align to their FIRST line, not their middle: the Runs-with cell has
        // a second line (machine · project), and centring every cell made its
        // first line sit above the name and frequency beside it.
        'group relative items-start gap-y-0.5 border-b-[0.5px] border-border px-4 py-2.5 text-[0.9em] leading-5 transition-colors hover:bg-hover sm:gap-y-0'
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className={cn(cell.name, 'min-w-0 text-left focus-visible:outline-hidden')}
      >
        {/* Row-wide hit target: the whole row opens the schedule, while the
            action buttons stay above it and keep their own clicks. */}
        <span className="absolute inset-0" aria-hidden="true" />
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-normal">{row.title}</span>
          <span className="sm:hidden">
            <StatusPill status={status} />
          </span>
        </span>
      </button>

      <div className={cn(cell.frequency, 'min-w-0 truncate text-muted-foreground')}>
        {describeTrigger(row.trigger, t, i18n.language)}
      </div>

      <div className={cn(cell.next, 'flex min-w-0 items-center gap-2 text-muted-foreground')}>
        {next != null ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <span className="truncate text-foreground/80">
                  {formatUpcoming(next, zone, now, i18n.language)}
                </span>
              }
            />
            <Tooltip.Content>
              {formatInstant(next, zone, i18n.language)} · {zone}
            </Tooltip.Content>
          </Tooltip.Root>
        ) : manual ? (
          <span className="truncate">{t('schedules.trigger.onDemand', 'On demand')}</span>
        ) : row.enabled ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <span className="truncate">
                  {t('schedules.notScheduledYet', 'Not scheduled yet')}
                </span>
              }
            />
            <Tooltip.Content>
              {t('schedules.awaitingMachine', 'Waiting for the machine to check the schedule')}
            </Tooltip.Content>
          </Tooltip.Root>
        ) : null}
        {/* A pill that starts the cell pulls its text back onto the column line. */}
        <span className="hidden first:-ml-1.5 sm:inline">
          <StatusPill status={status} />
        </span>
      </div>

      <div className={cn(cell.target, 'flex min-w-0 flex-col justify-center gap-px')}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-muted-foreground">
            {context?.agent ?? row.agentConfigId}
          </span>
          {offline ? (
            <Tooltip.Root>
              <Tooltip.Trigger
                render={<CloudOff className="size-3.5 shrink-0 text-status-warning" />}
              />
              <Tooltip.Content>
                {t(
                  'schedules.machineOfflineHint',
                  'The target machine is not connected right now.'
                )}
              </Tooltip.Content>
            </Tooltip.Root>
          ) : null}
        </span>
        {/* The machine is what separates two same-named Agents, and two
            chat-only schedules that would otherwise read identically. */}
        <span
          className="truncate text-[0.85em] leading-4 text-muted-foreground/70"
          title={`${context?.machine ?? row.machineId} · ${project}`}
        >
          {context?.machine ?? row.machineId}
          <span className="px-1 opacity-50">·</span>
          {project}
        </span>
      </div>

      {/* 28px buttons centred on the 20px first line. */}
      <div className={cn(cell.actions, 'relative -my-1 flex items-center justify-end gap-0.5')}>
        {runtime?.lastDispatch && onOpenSession ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Button
                  variant="ghost"
                  size="small"
                  icon
                  // Visible by default; only a device that actually has hover is
                  // allowed to hide it until the row is hovered or focused.
                  className="shrink-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
                  onClick={() => onOpenSession(runtime.lastDispatch!.sessionId)}
                  aria-label={t('schedules.lastRun', 'Last run')}
                >
                  <History className="size-full" />
                </Button>
              }
            />
            <Tooltip.Content>{t('schedules.lastRun', 'Last run')}</Tooltip.Content>
          </Tooltip.Root>
        ) : null}
        {/* A manual task's main action is running it; a timed one's is pausing.
            The other stays one right-click away. */}
        {manual && canRun ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Button
                  variant="ghost"
                  size="small"
                  icon
                  className="shrink-0"
                  onClick={onRun}
                  aria-label={t('schedules.runNow', 'Run now')}
                >
                  <Play className="size-full" />
                </Button>
              }
            />
            <Tooltip.Content>{t('schedules.runNow', 'Run now')}</Tooltip.Content>
          </Tooltip.Root>
        ) : !manual && canToggle ? (
          <Button
            variant="ghost"
            size="small"
            icon
            className="shrink-0"
            onClick={onToggle}
            aria-label={toggleLabel}
          >
            {row.enabled ? <Pause className="size-full" /> : <RotateCcw className="size-full" />}
          </Button>
        ) : null}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
      </div>
    </div>
  );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={rowElement} />
      <ContextMenu.Content>
        <ContextMenu.Item icon={<ExternalLink />} onClick={onOpen}>
          {t('schedules.open', 'Open')}
        </ContextMenu.Item>
        {canRun ? (
          <ContextMenu.Item icon={<Play />} onClick={onRun}>
            {t('schedules.runNow', 'Run now')}
          </ContextMenu.Item>
        ) : null}
        {canToggle ? (
          <ContextMenu.Item icon={row.enabled ? <Pause /> : <RotateCcw />} onClick={onToggle}>
            {toggleLabel}
          </ContextMenu.Item>
        ) : null}
        {lastSessionId && onOpenSession ? (
          <ContextMenu.Item icon={<History />} onClick={() => onOpenSession(lastSessionId)}>
            {t('schedules.lastRun', 'Last run')}
          </ContextMenu.Item>
        ) : null}
        {canDelete ? (
          <>
            <ContextMenu.Separator />
            <ContextMenu.Item tone="destructive" icon={<Trash2 />} onClick={onDelete}>
              {t('schedules.delete', 'Delete')}
            </ContextMenu.Item>
          </>
        ) : null}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

export function ScheduleListView({
  rows,
  runtimes,
  ready,
  error,
  onOpen,
  onNew,
  onToggle,
  onRun,
  onDelete,
  contextForRow,
  onOpenSession,
  columnWidths: controlledWidths,
  onColumnWidthsChange,
  compact = false,
  selectedId,
  now = getServerNow(),
}: {
  rows: ScheduleRegistryRow[];
  runtimes: ScheduleRuntimeRow[];
  ready: boolean;
  error?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onToggle?: (row: ScheduleRegistryRow) => void;
  onRun?: (row: ScheduleRegistryRow) => void;
  onDelete?: (row: ScheduleRegistryRow) => void;
  contextForRow?: (row: ScheduleRegistryRow) => ScheduleRowContext;
  /** Persisted by the container; uncontrolled (defaults) when omitted. */
  columnWidths?: ScheduleColumnWidths;
  onColumnWidthsChange?: (next: ScheduleColumnWidths) => void;
  onOpenSession?: (id: string) => void;
  /** A schedule is open beside the list: show names only. */
  compact?: boolean;
  /** The open schedule, highlighted in the compact list. */
  selectedId?: string;
  /** Injected so stories and tests render a fixed "next run" column. */
  now?: number;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [localWidths, setLocalWidths] = useState(DEFAULT_COLUMN_WIDTHS);
  const widths = controlledWidths ?? localWidths;
  const resize = (key: keyof ScheduleColumnWidths, value: number) => {
    const next = { ...widths, [key]: clampWidth(value) };
    setLocalWidths(next);
    onColumnWidthsChange?.(next);
  };
  const filtered = rows.filter((row) =>
    row.title.toLowerCase().includes(query.trim().toLowerCase())
  );
  return (
    // Own the tooltip context rather than depending on an ancestor: the row
    // tooltips carry the exact next-run instant and the offline reason, which
    // must not be what makes this list crash where it is mounted.
    <Tooltip.Provider>
      <section className="flex h-full min-h-0 flex-col" style={columnVars(widths)}>
        <header className="flex shrink-0 items-center gap-2 px-4 py-3">
          <h1 className="mr-auto text-[1em] font-normal text-foreground">
            {t('schedules.title', 'Schedules')}
          </h1>
          {compact ? null : (
            <Input
              size="small"
              leading={<Search className="size-3.5 text-muted-foreground" aria-hidden="true" />}
              aria-label={t('schedules.search', 'Search schedules')}
              placeholder={t('schedules.search', 'Search schedules')}
              className="w-40 sm:w-56"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <Button
            variant={compact ? 'ghost' : 'primary'}
            size="small"
            icon={compact}
            className="shrink-0"
            onClick={onNew}
            // The label is the only text and it is hidden on narrow screens.
            aria-label={t('schedules.new', 'New schedule')}
          >
            <Plus className={compact ? 'size-full' : 'size-3.5'} />
            {compact ? null : (
              <span className="hidden sm:inline">{t('schedules.new', 'New schedule')}</span>
            )}
          </Button>
        </header>

        {!compact && ready && !error && filtered.length > 0 ? (
          <div
            className={cn(
              listGridClass,
              'hidden shrink-0 border-b-[0.5px] border-border px-4 py-1.5 text-[0.75em] font-normal text-muted-foreground sm:grid'
            )}
          >
            {(
              [
                ['name', t('schedules.column.name', 'Name')],
                ['frequency', t('schedules.column.frequency', 'Frequency')],
                ['next', t('schedules.column.next', 'Next run')],
              ] as const
            ).map(([key, label]) => (
              // The cell must not clip: the handle hangs into the column gap.
              <span key={key} className="relative min-w-0">
                <span className="block truncate">{label}</span>
                <ColumnResizeHandle
                  label={t('schedules.resizeColumn', 'Resize {{column}}', { column: label })}
                  value={widths[key]}
                  onChange={(value) => resize(key, value)}
                  onReset={() => resize(key, DEFAULT_COLUMN_WIDTHS[key])}
                />
              </span>
            ))}
            <span>{t('schedules.column.target', 'Runs with')}</span>
            <span />
          </div>
        ) : null}

        <div className={cn('min-h-0 flex-1 overflow-auto', compact && 'px-2 pb-2')}>
          {!ready ? (
            <div className="space-y-px" aria-busy="true">
              <span className="sr-only">{t('schedules.loading', 'Loading schedules…')}</span>
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 border-b-[0.5px] border-border px-4 py-3"
                >
                  <Skeleton shape="line" width={192} />
                  <Skeleton shape="line" width={96} className="ml-auto" />
                  <Skeleton shape="line" width={80} />
                </div>
              ))}
            </div>
          ) : error ? (
            <p className="px-4 py-8 text-[1em] text-destructive" role="alert">
              {t('schedules.loadError', 'Schedules could not be loaded.')}
            </p>
          ) : filtered.length === 0 ? (
            <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-6 py-16 text-center">
              <CalendarClock className="size-5 text-muted-foreground" aria-hidden="true" />
              <p className="text-[1em] font-normal">
                {query
                  ? t('schedules.noMatches', 'No schedules match your search')
                  : t('schedules.empty', 'No schedules yet')}
              </p>
              {query ? null : (
                <>
                  <p className="text-[0.9em] text-muted-foreground">
                    {t(
                      'schedules.emptyHelp',
                      'Choose a prompt and a time. Your machine will start a new chat for each run.'
                    )}
                  </p>
                  <Button variant="secondary" size="small" className="mt-2" onClick={onNew}>
                    <Plus className="size-3.5" />
                    {t('schedules.new', 'New schedule')}
                  </Button>
                </>
              )}
            </div>
          ) : (
            filtered.map((row) => (
              <ScheduleListRow
                key={row.scheduleId}
                row={row}
                now={now}
                runtime={matchingScheduleRuntime(row, runtimes)}
                context={contextForRow?.(row)}
                onOpen={() => onOpen(row.scheduleId)}
                onToggle={onToggle ? () => onToggle(row) : undefined}
                onRun={onRun ? () => onRun(row) : undefined}
                onDelete={onDelete ? () => onDelete(row) : undefined}
                onOpenSession={onOpenSession}
                compact={compact}
                selected={row.scheduleId === selectedId}
              />
            ))
          )}
        </div>
      </section>
    </Tooltip.Provider>
  );
}

/**
 * Drag handle on a header column's right edge, centred in the column gap.
 *
 * Pointer capture keeps the drag alive outside the header; arrow keys step by
 * 16px for keyboard users; double-click restores the default width.
 */
function ColumnResizeHandle({
  label,
  value,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: value };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    onChange(active.startWidth + event.clientX - active.startX);
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
    if (!step) return;
    event.preventDefault();
    onChange(value + step);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className="group/resize absolute -bottom-1.5 -right-[9px] -top-1.5 z-10 flex w-3 cursor-col-resize touch-none select-none justify-center focus-visible:outline-hidden"
    >
      <span className="h-full w-px bg-transparent transition-colors group-hover/resize:bg-border group-focus-visible/resize:bg-ring group-active/resize:bg-ring" />
    </div>
  );
}
