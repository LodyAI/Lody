import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
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
import { WINDOW_DRAG_EXEMPT_CLASS, useWindowDragRegionClass } from '@/ui/window-drag-region';
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
  timeZone?: string;
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
const DEFAULT_COLUMN_WIDTHS: ScheduleColumnWidths = { name: 300, frequency: 150, next: 140 };
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 720;
const clampWidth = (value: number) =>
  Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, value)));

const DARK =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  statusPill: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    whiteSpace: 'nowrap',
    borderWidth: '0.5px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border))',
    borderRadius: '9999px',
    paddingLeft: '6px',
    paddingRight: '6px',
    paddingTop: '1px',
    paddingBottom: '1px',
    fontSize: '0.85em',
    fontWeight: 400,
    lineHeight: 1.25,
    color: 'hsl(var(--muted-foreground))',
  },
  statusAttention: {
    borderColor: 'hsl(var(--status-warning) / 0.4)',
    color: 'hsl(var(--status-warning))',
  },
  statusProgress: {
    borderColor: 'hsl(var(--status-info) / 0.4)',
    color: 'hsl(var(--status-info))',
  },
  listGrid: {
    display: 'grid',
    columnGap: '12px',
  },
  cellName: { gridColumnStart: 1, gridRowStart: 1 },
  cellFrequency: {
    gridColumnEnd: {
      default: 'span 2',
      '@media (min-width: 640px)': 3,
    },
    gridRowStart: {
      default: 2,
      '@media (min-width: 640px)': 1,
    },
    gridColumnStart: {
      default: null,
      '@media (min-width: 640px)': 2,
    },
  },
  cellNext: {
    gridColumnEnd: {
      default: 'span 2',
      '@media (min-width: 640px)': 4,
    },
    gridRowStart: {
      default: 3,
      '@media (min-width: 640px)': 1,
    },
    gridColumnStart: {
      default: null,
      '@media (min-width: 640px)': 3,
    },
  },
  cellTarget: {
    gridColumnEnd: {
      default: 'span 2',
      '@media (min-width: 640px)': 5,
    },
    gridRowStart: {
      default: 4,
      '@media (min-width: 640px)': 1,
    },
    gridColumnStart: {
      default: null,
      '@media (min-width: 640px)': 4,
    },
  },
  cellActions: {
    gridColumnStart: {
      default: 2,
      '@media (min-width: 640px)': 5,
    },
    gridRowStart: {
      default: 1,
      '@media (min-width: 640px)': 1,
    },
  },
  row: {
    position: 'relative',
    alignItems: 'flex-start',
    rowGap: {
      default: '2px',
      '@media (min-width: 640px)': 0,
    },
    borderBottomWidth: '0.5px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border))',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '10px',
    paddingBottom: '10px',
    fontSize: '0.9em',
    lineHeight: '20px',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  rowHover: { backgroundColor: { default: 'transparent', ':hover': 'hsl(var(--hover))' } },
  rowSelected: {
    backgroundColor: {
      default: 'hsl(var(--foreground) / 0.06)',
      [DARK]: 'hsl(0 0% 100% / 0.08)',
    },
  },
  openButton: {
    minWidth: 0,
    textAlign: 'left',
    outlineStyle: {
      ':focus-visible': { default: 'none', '@media (forced-colors: active)': 'solid' },
    },
    outlineWidth: { ':focus-visible': { '@media (forced-colors: active)': '2px' } },
    outlineColor: { ':focus-visible': { '@media (forced-colors: active)': 'transparent' } },
    outlineOffset: { ':focus-visible': { '@media (forced-colors: active)': '2px' } },
  },
  rowHitTarget: { position: 'absolute', inset: 0 },
  titleLine: { display: 'flex', minWidth: 0, alignItems: 'center', columnGap: '8px' },
  titleText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 400,
  },
  mobileOnly: {
    display: {
      default: null,
      '@media (min-width: 640px)': 'none',
    },
  },
  desktopOnly: {
    display: {
      default: 'none',
      '@media (min-width: 640px)': 'inline',
    },
  },
  frequency: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'hsl(var(--muted-foreground))',
  },
  nextCell: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    columnGap: '8px',
    color: 'hsl(var(--muted-foreground))',
  },
  upcoming: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'hsl(var(--foreground) / 0.8)',
  },
  truncate: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  firstPill: { marginLeft: { default: null, ':first-child': '-6px' } },
  target: {
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    justifyContent: 'center',
    rowGap: '1px',
  },
  targetLine: { display: 'flex', minWidth: 0, alignItems: 'center', columnGap: '6px' },
  mutedText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'hsl(var(--muted-foreground))',
  },
  offlineIcon: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
    color: 'hsl(var(--status-warning))',
  },
  icon14: { width: '14px', height: '14px', flexShrink: 0 },
  mutedIcon: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground))',
  },
  machineLine: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.85em',
    lineHeight: '16px',
    color: 'hsl(var(--muted-foreground) / 0.7)',
  },
  separator: { paddingLeft: '4px', paddingRight: '4px', opacity: 0.5 },
  actions: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    columnGap: '2px',
    marginTop: '-4px',
    marginBottom: '-4px',
  },
  actionIcon: { width: '100%', height: '100%' },
  actionButton: { flexShrink: 0 },
  chevron: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground) / 0.5)',
  },
  list: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    minHeight: 0,
    flexDirection: 'column',
    overflow: 'hidden',
  },
  listHeader: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    columnGap: '8px',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '12px',
    paddingBottom: '12px',
  },
  pageTitle: {
    marginRight: 'auto',
    flexShrink: 0,
    whiteSpace: 'nowrap',
    fontSize: '1em',
    fontWeight: 400,
    color: 'hsl(var(--foreground))',
  },
  search: {
    width: {
      default: '160px',
      '@media (min-width: 640px)': '224px',
    },
    minWidth: 0,
    flexShrink: 1,
  },
  newButtonLabel: {
    display: {
      default: 'none',
      '@media (min-width: 640px)': 'inline',
    },
  },
  tableScroller: { height: '100%', minHeight: 0, flex: '1 1 0%', overflow: 'auto' },
  tableMinimum: (minimum: string) => ({
    minWidth: {
      default: null,
      '@media (min-width: 640px)': minimum,
    },
  }),
  headerRow: {
    position: 'sticky',
    top: 0,
    zIndex: 20,
    display: {
      default: 'none',
      '@media (min-width: 640px)': 'grid',
    },
    borderBottomWidth: '0.5px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border))',
    backgroundColor: 'hsl(var(--background))',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '6px',
    paddingBottom: '6px',
    fontSize: '0.75em',
    fontWeight: 400,
    color: 'hsl(var(--muted-foreground))',
  },
  headerCell: { position: 'relative', minWidth: 0 },
  headerLabel: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  skeletonRow: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '12px',
    borderBottomWidth: '0.5px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border))',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '12px',
    paddingBottom: '12px',
    marginBlockEnd: { default: '1px', ':last-child': 0 },
  },
  error: {
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '32px',
    paddingBottom: '32px',
    fontSize: '1em',
    color: 'hsl(var(--destructive))',
  },
  empty: {
    display: 'flex',
    maxWidth: '384px',
    flexDirection: 'column',
    alignItems: 'center',
    rowGap: '8px',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingLeft: '24px',
    paddingRight: '24px',
    paddingTop: '64px',
    paddingBottom: '64px',
    textAlign: 'center',
  },
  emptyIcon: { width: '20px', height: '20px', color: 'hsl(var(--muted-foreground))' },
  emptyTitle: { fontSize: '1em', fontWeight: 400 },
  emptyHelp: { fontSize: '0.9em', color: 'hsl(var(--muted-foreground))' },
  emptyAction: { marginTop: '8px' },
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  skeletonTrailing: { marginLeft: 'auto' },
  resizeHandle: {
    position: 'absolute',
    top: '-6px',
    bottom: '-6px',
    right: '-9px',
    zIndex: 10,
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
      [stylex.when.ancestor(':hover')]: 'hsl(var(--border))',
      [stylex.when.ancestor(':focus-visible')]: 'hsl(var(--ring))',
      [stylex.when.ancestor(':active')]: 'hsl(var(--ring))',
    },
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  columnTracks: (name: number, frequency: number, next: number) => ({
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      '@media (min-width: 640px)': `minmax(${MIN_COLUMN_WIDTH}px,${name}px) minmax(${MIN_COLUMN_WIDTH}px,${frequency}px) minmax(${MIN_COLUMN_WIDTH}px,${next}px) minmax(0, 1fr) 5.75rem`,
    },
  }),
});

/**
 * Only states that are not the happy path get a pill. An enabled schedule with
 * a next run already says so by having a next run.
 */
function StatusPill({ status }: { status: ScheduleStatus }) {
  if (status.tone === 'active') return null;
  return (
    <span
      {...stylex.props(
        styles.statusPill,
        status.tone === 'attention' && styles.statusAttention,
        status.tone === 'progress' && styles.statusProgress
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
/**
 * The resizable tracks shrink before they overflow: `minmax(min, width)` keeps a
 * dragged width in a wide window and still fits a narrow panel.
 */
const cell = {
  name: styles.cellName,
  frequency: styles.cellFrequency,
  next: styles.cellNext,
  target: styles.cellTarget,
  actions: styles.cellActions,
} as const;

function ScheduleListRow({
  row,
  runtime,
  context,
  widths,
  now,
  onOpen,
  onToggle,
  onRun,
  onDelete,
  onOpenSession,
  selected,
}: {
  row: ScheduleRegistryRow;
  runtime?: ScheduleRuntimeRow;
  /** The schedule open beside the list. */
  selected?: boolean;
  context?: ScheduleRowContext;
  widths: ScheduleColumnWidths;
  now: number;
  onOpen: () => void;
  onToggle?: () => void;
  onRun?: () => void;
  onDelete?: () => void;
  onOpenSession?: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const zone = triggerTimeZone(row.trigger, context?.timeZone);
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
  const rowStyle = stylex.props(
    styles.listGrid,
    styles.columnTracks(widths.name, widths.frequency, widths.next),
    styles.row,
    selected ? styles.rowSelected : styles.rowHover
  );
  const rowElement = (
    <div
      data-schedule-row=""
      aria-current={selected ? 'true' : undefined}
      className={cn(rowStyle.className, 'group')}
      style={rowStyle.style}
    >
      <button type="button" onClick={onOpen} {...stylex.props(cell.name, styles.openButton)}>
        {/* Row-wide hit target: the whole row opens the schedule, while the
            action buttons stay above it and keep their own clicks. */}
        <span {...stylex.props(styles.rowHitTarget)} aria-hidden="true" />
        <span {...stylex.props(styles.titleLine)}>
          <span {...stylex.props(styles.titleText)}>{row.title}</span>
          <span {...stylex.props(styles.mobileOnly)}>
            <StatusPill status={status} />
          </span>
        </span>
      </button>

      <div {...stylex.props(cell.frequency, styles.frequency)}>
        {describeTrigger(row.trigger, t, i18n.language, zone)}
      </div>

      <div {...stylex.props(cell.next, styles.nextCell)}>
        {next != null ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <span {...stylex.props(styles.upcoming)}>
                  {formatUpcoming(next, zone, now, i18n.language)}
                </span>
              }
            />
            <Tooltip.Content>
              {formatInstant(next, zone, i18n.language)} · {zone}
            </Tooltip.Content>
          </Tooltip.Root>
        ) : manual ? (
          <span {...stylex.props(styles.truncate)}>
            {t('schedules.trigger.onDemand', 'On demand')}
          </span>
        ) : row.enabled ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <span {...stylex.props(styles.truncate)}>
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
        <span {...stylex.props(styles.desktopOnly, styles.firstPill)}>
          <StatusPill status={status} />
        </span>
      </div>

      <div {...stylex.props(cell.target, styles.target)}>
        <span {...stylex.props(styles.targetLine)}>
          <span {...stylex.props(styles.mutedText)}>{context?.agent ?? row.agentConfigId}</span>
          {offline ? (
            <Tooltip.Root>
              <Tooltip.Trigger render={<CloudOff {...stylex.props(styles.offlineIcon)} />} />
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
          {...stylex.props(styles.machineLine)}
          title={`${context?.machine ?? row.machineId} · ${project}`}
        >
          {context?.machine ?? row.machineId}
          <span {...stylex.props(styles.separator)}>·</span>
          {project}
        </span>
      </div>

      {/* 28px buttons centred on the 20px first line. */}
      <div {...stylex.props(cell.actions, styles.actions)}>
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
                  <History {...stylex.props(styles.actionIcon)} />
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
                  className={stylex.props(styles.actionButton).className}
                  onClick={onRun}
                  aria-label={t('schedules.runNow', 'Run now')}
                >
                  <Play {...stylex.props(styles.actionIcon)} />
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
            className={stylex.props(styles.actionButton).className}
            onClick={onToggle}
            aria-label={toggleLabel}
          >
            {row.enabled ? (
              <Pause {...stylex.props(styles.actionIcon)} />
            ) : (
              <RotateCcw {...stylex.props(styles.actionIcon)} />
            )}
          </Button>
        ) : null}
        <ChevronRight {...stylex.props(styles.chevron)} aria-hidden="true" />
      </div>
    </div>
  );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={rowElement} />
      <ContextMenu.Content>
        <ContextMenu.Item icon={ExternalLink} onClick={onOpen}>
          {t('schedules.open', 'Open')}
        </ContextMenu.Item>
        {canRun ? (
          <ContextMenu.Item icon={Play} onClick={onRun}>
            {t('schedules.runNow', 'Run now')}
          </ContextMenu.Item>
        ) : null}
        {canToggle ? (
          <ContextMenu.Item icon={row.enabled ? Pause : RotateCcw} onClick={onToggle}>
            {toggleLabel}
          </ContextMenu.Item>
        ) : null}
        {lastSessionId && onOpenSession ? (
          <ContextMenu.Item icon={History} onClick={() => onOpenSession(lastSessionId)}>
            {t('schedules.lastRun', 'Last run')}
          </ContextMenu.Item>
        ) : null}
        {canDelete ? (
          <>
            <ContextMenu.Separator />
            <ContextMenu.Item tone="destructive" icon={Trash2} onClick={onDelete}>
              {t('schedules.delete', 'Delete')}
            </ContextMenu.Item>
          </>
        ) : null}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

const BLANK_CLICK_EXCLUDE =
  'button, a, input, textarea, select, label, [role="separator"], [role="tab"], [data-schedule-row], [data-schedule-detail]';

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
  selectedId,
  renderBody,
  onBlankClick,
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
  /** Wraps the table under the header — the split view places the open
   *  schedule beside it there, so the header never moves. */
  renderBody?: (table: ReactNode) => ReactNode;
  /** A click on the page's empty space (the open schedule does not count). */
  onBlankClick?: () => void;
  /** The schedule open beside the list, highlighted. */
  selectedId?: string;
  /** Injected so stories and tests render a fixed "next run" column. */
  now?: number;
}) {
  const { t } = useTranslation();
  const windowDrag = useWindowDragRegionClass();
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
      {/* A click on nothing in particular — not a row, a control or the open
          schedule — closes the schedule. Close and Escape stay the keyboard path. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <section
        // Positioning context for the open schedule, which covers the header.
        {...stylex.props(styles.list)}
        onClick={(event) => {
          const target = event.target as Element;
          // Popups portal out of this DOM; their clicks must not count.
          if (!onBlankClick || !event.currentTarget.contains(target)) return;
          if (target.closest(BLANK_CLICK_EXCLUDE)) return;
          onBlankClick();
        }}
      >
        {/* Joins the Electron window's drag strip, which would otherwise swallow
            clicks on the search and New button under it. */}
        <header className={cn(stylex.props(styles.listHeader).className, windowDrag)}>
          <h1 {...stylex.props(styles.pageTitle)}>{t('schedules.title', 'Schedules')}</h1>
          <Input
            size="small"
            leading={<Search {...stylex.props(styles.mutedIcon)} aria-hidden="true" />}
            aria-label={t('schedules.search', 'Search schedules')}
            placeholder={t('schedules.search', 'Search schedules')}
            className={cn(stylex.props(styles.search).className, WINDOW_DRAG_EXEMPT_CLASS)}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            variant="primary"
            size="small"
            className={cn(stylex.props(styles.actionButton).className, WINDOW_DRAG_EXEMPT_CLASS)}
            onClick={onNew}
            // The label is the only text and it is hidden on narrow screens.
            aria-label={t('schedules.new', 'New schedule')}
          >
            <Plus {...stylex.props(styles.icon14)} />
            <span {...stylex.props(styles.newButtonLabel)}>
              {t('schedules.new', 'New schedule')}
            </span>
          </Button>
        </header>

        {(renderBody ?? ((table: ReactNode) => table))(
          // Header and rows scroll together, sideways too when the columns do
          // not fit the pane: each column keeps its width instead of squeezing.
          <div {...stylex.props(styles.tableScroller)}>
            <div
              {...stylex.props(
                styles.tableMinimum(
                  `${widths.name + widths.frequency + widths.next + 200 + 92 + 48 + 32}px`
                )
              )}
            >
              {ready && !error && filtered.length > 0 ? (
                <div
                  {...stylex.props(
                    styles.listGrid,
                    styles.columnTracks(widths.name, widths.frequency, widths.next),
                    styles.headerRow
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
                    <span key={key} {...stylex.props(styles.headerCell)}>
                      <span {...stylex.props(styles.headerLabel)}>{label}</span>
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
              {!ready ? (
                <div aria-busy="true">
                  <span {...stylex.props(styles.visuallyHidden)}>
                    {t('schedules.loading', 'Loading schedules…')}
                  </span>
                  {[0, 1, 2].map((index) => (
                    <div key={index} {...stylex.props(styles.skeletonRow)}>
                      <Skeleton shape="line" width={192} />
                      <Skeleton
                        shape="line"
                        width={96}
                        className={stylex.props(styles.skeletonTrailing).className}
                      />
                      <Skeleton shape="line" width={80} />
                    </div>
                  ))}
                </div>
              ) : error ? (
                <p {...stylex.props(styles.error)} role="alert">
                  {t('schedules.loadError', 'Schedules could not be loaded.')}
                </p>
              ) : filtered.length === 0 ? (
                <div {...stylex.props(styles.empty)}>
                  <CalendarClock {...stylex.props(styles.emptyIcon)} aria-hidden="true" />
                  <p {...stylex.props(styles.emptyTitle)}>
                    {query
                      ? t('schedules.noMatches', 'No schedules match your search')
                      : t('schedules.empty', 'No schedules yet')}
                  </p>
                  {query ? null : (
                    <>
                      <p {...stylex.props(styles.emptyHelp)}>
                        {t(
                          'schedules.emptyHelp',
                          'Choose a prompt and a time. Your machine will start a new chat for each run.'
                        )}
                      </p>
                      <Button
                        variant="secondary"
                        size="small"
                        className={stylex.props(styles.emptyAction).className}
                        onClick={onNew}
                      >
                        <Plus {...stylex.props(styles.icon14)} />
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
                    widths={widths}
                    onOpen={() => onOpen(row.scheduleId)}
                    onToggle={onToggle ? () => onToggle(row) : undefined}
                    onRun={onRun ? () => onRun(row) : undefined}
                    onDelete={onDelete ? () => onDelete(row) : undefined}
                    onOpenSession={onOpenSession}
                    selected={row.scheduleId === selectedId}
                  />
                ))
              )}
            </div>
          </div>
        )}
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
      {...stylex.props(stylex.defaultMarker(), styles.resizeHandle)}
    >
      <span {...stylex.props(styles.resizeLine)} />
    </div>
  );
}
