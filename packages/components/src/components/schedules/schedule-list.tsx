import { Fragment, useState, type ComponentType, type ReactNode } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import {
  ArrowUpDown,
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  CloudOff,
  ExternalLink,
  Folder,
  History,
  Info,
  ListFilter,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import { getServerNow, type ScheduleRegistryRow, type ScheduleRuntimeRow } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { ContextMenu } from '@lody/ui/context-menu';
import { Input } from '@lody/ui/input';
import { Menu } from '@lody/ui/menu';
import { Popover } from '@lody/ui/popover';
import { Skeleton } from '@lody/ui/skeleton';
import { Tooltip } from '@lody/ui/tooltip';
import { navigationSidebarVisibleAtom, showNavigationSidebarAtom } from '@/atoms/layout-state';
import { useIsMobile } from '@/hooks/use-mobile';
import { isMacOSElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { isNativeAppShell } from '@/lib/native-platform';
import { withClassName } from '@/lib/stylex';
import { cn } from '@/lib/utils';
import {
  WINDOW_DRAG_EXEMPT_CLASS,
  useMacTrafficLightRowPadClass,
  useWindowDragRegionClass,
  useWindowsCaptionPadClass,
  useWindowsCaptionRowPadClass,
} from '@/ui/window-drag-region';
import {
  describeScheduleState,
  describeTrigger,
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

/** `matchingScheduleRuntime` for many rows: one pass over the runtimes. */
export function indexScheduleRuntimes(runtimes: ScheduleRuntimeRow[]) {
  const key = (id: string, machine: string, activation: string, fingerprint: string) =>
    `${id}\u0000${machine}\u0000${activation}\u0000${fingerprint}`;
  const byKey = new Map<string, ScheduleRuntimeRow>();
  for (const runtime of runtimes) {
    const k = key(
      runtime.scheduleId,
      runtime.machineId,
      runtime.activationId,
      runtime.observedDefinitionFingerprint
    );
    if (!byKey.has(k)) byKey.set(k, runtime);
  }
  return (row: ScheduleRegistryRow) =>
    byKey.get(key(row.scheduleId, row.machineId, row.activationId, row.definitionFingerprint));
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
  /**
   * The chat runs go into, for a schedule that posts into one chat. No
   * `sessionId` while its own chat has not been created by a first run.
   */
  chat?: { title: string; sessionId?: string };
};

export type ScheduleListProjectFilter =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'project'; name: string };
export type ScheduleListStatusFilter = 'all' | ScheduleStatus['group'];
export type ScheduleListSort = 'next' | 'recent' | 'name' | 'created';

const styles = stylex.create({
  page: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    minHeight: 0,
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    boxSizing: 'border-box',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    columnGap: '8px',
    height: '52px',
    paddingLeft: { default: '16px', '@media (min-width: 640px)': '24px' },
    paddingRight: { default: '16px', '@media (min-width: 640px)': '24px' },
  },
  // The phone route is edge-to-edge. Grow the row so the title stays under the
  // status bar; the home tab already sits under its own header.
  headerSafeArea: {
    height: 'calc(52px + var(--safe-area-top, 0px))',
    paddingTop: 'var(--safe-area-top, 0px)',
  },
  // The show-sidebar button's -4px lands its left edge at 96px, matching Chat
  // Landing and clearing the traffic lights by 24px.
  headerBesideTrafficLights: { paddingLeft: '100px' },
  sidebarToggle: { marginInlineStart: '-4px' },
  glyph: { width: '16px', height: '16px' },
  icon14: { width: '14px', height: '14px', flexShrink: 0 },
  mutedIcon: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground))',
  },
  pageTitle: {
    marginRight: 'auto',
    flexShrink: 0,
    whiteSpace: 'nowrap',
    fontSize: '1.15em',
    fontWeight: 600,
    color: 'hsl(var(--foreground))',
  },
  search: {
    width: { default: '160px', '@media (min-width: 640px)': '224px' },
    minWidth: 0,
    flexShrink: 1,
  },
  newButtonLabel: { display: { default: 'none', '@media (min-width: 640px)': 'inline' } },
  shrinkless: { flexShrink: 0 },
  scroller: {
    minHeight: 0,
    flex: '1 1 0%',
    overflow: 'auto',
    paddingLeft: { default: '12px', '@media (min-width: 640px)': '24px' },
    paddingRight: { default: '12px', '@media (min-width: 640px)': '24px' },
    paddingBottom: '32px',
  },
  filters: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '6px',
    paddingTop: '2px',
    paddingBottom: '4px',
    overflowX: 'auto',
    scrollbarWidth: 'none',
  },
  spacer: { flex: '1 1 0%' },
  section: { marginTop: '18px' },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '2px',
    minHeight: '28px',
    paddingLeft: '4px',
    paddingBottom: '6px',
    fontSize: '0.9em',
  },
  sectionTitle: { fontWeight: 500, color: 'hsl(var(--foreground))' },
  sectionCount: {
    marginLeft: '6px',
    color: 'hsl(var(--muted-foreground))',
    fontVariantNumeric: 'tabular-nums',
  },
  infoText: {
    margin: 0,
    maxWidth: '300px',
    fontSize: '0.9em',
    lineHeight: 1.55,
    color: 'hsl(var(--muted-foreground))',
  },
  infoTitle: {
    display: 'block',
    marginBottom: '2px',
    fontWeight: 500,
    color: 'hsl(var(--foreground))',
  },
  card: {
    overflow: 'hidden',
    borderRadius: '12px',
    backgroundColor: 'hsl(var(--popover))',
    boxShadow: '0 1px 2px hsl(0 0% 0% / 0.06), 0 0 0 1px hsl(var(--border) / 0.7)',
  },
  grid: {
    display: 'grid',
    alignItems: 'center',
    columnGap: '16px',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      '@media (min-width: 640px)': 'minmax(0, 1fr) minmax(0, 220px) 168px 64px',
    },
  },
  columns: {
    display: { default: 'none', '@media (min-width: 640px)': 'grid' },
    paddingLeft: '16px',
    paddingRight: '10px',
    paddingTop: '8px',
    paddingBottom: '6px',
    fontSize: '0.8em',
    color: 'hsl(var(--muted-foreground))',
  },
  alignEnd: { textAlign: 'right' },
  row: {
    position: 'relative',
    minHeight: '58px',
    paddingLeft: '16px',
    paddingRight: { default: '14px', '@media (min-width: 640px)': '10px' },
    paddingTop: '8px',
    paddingBottom: '8px',
    fontSize: '0.95em',
    // The column header is always the first child (hidden on a phone), so the
    // first row rules above itself only where that header shows.
    borderTopWidth: {
      default: '0.5px',
      ':nth-child(2)': { default: 0, '@media (min-width: 640px)': '0.5px' },
    },
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border))',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    backgroundColor: { default: 'transparent', ':hover': 'hsl(var(--foreground) / 0.04)' },
  },
  rowSelected: { backgroundColor: 'hsl(var(--foreground) / 0.07)' },
  openButton: {
    minWidth: 0,
    textAlign: 'left',
    outlineStyle: { ':focus-visible': 'none' },
  },
  // Row-wide hit target: the whole row opens it; controls stay above it.
  rowHitTarget: {
    position: 'absolute',
    inset: 0,
    borderRadius: 'inherit',
    outlineStyle: { default: 'none', [stylex.when.ancestor(':focus-visible')]: 'solid' },
    outlineWidth: '2px',
    outlineOffset: '-2px',
    outlineColor: 'hsl(var(--ring))',
  },
  name: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 500,
    color: 'hsl(var(--foreground))',
  },
  nameEnded: { color: 'hsl(var(--muted-foreground))', fontWeight: 400 },
  summary: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    marginTop: '1px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: '0.88em',
    color: 'hsl(var(--muted-foreground))',
  },
  summaryPart: { overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1, minWidth: 0 },
  wideOnly: { display: { default: 'none', '@media (min-width: 640px)': 'contents' } },
  narrowOnly: { display: { default: 'contents', '@media (min-width: 640px)': 'none' } },
  separator: { paddingLeft: '5px', paddingRight: '5px', opacity: 0.55, flexShrink: 0 },
  offline: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: '4px',
    flexShrink: 0,
    color: 'hsl(var(--status-warning))',
  },
  destination: {
    position: 'relative',
    display: { default: 'none', '@media (min-width: 640px)': 'flex' },
    minWidth: 0,
    alignItems: 'center',
    columnGap: '6px',
    fontSize: '0.88em',
    color: 'hsl(var(--muted-foreground))',
  },
  truncate: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // Pull the ghost button's padding back so its icon lines up with the others.
  chatButton: { maxWidth: '100%', minWidth: 0, marginInlineStart: '-8px' },
  status: {
    display: 'flex',
    minWidth: 0,
    // A long reason must not squeeze the name on a phone.
    maxWidth: { default: '45vw', '@media (min-width: 640px)': 'none' },
    overflow: 'hidden',
    flexDirection: 'column',
    alignItems: 'flex-end',
    textAlign: 'right',
  },
  statusMain: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: '5px',
    whiteSpace: 'nowrap',
    fontSize: '0.92em',
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--foreground))',
  },
  statusMuted: { color: 'hsl(var(--muted-foreground))' },
  statusProgress: { color: 'hsl(var(--status-info))' },
  statusAttention: { color: 'hsl(var(--status-warning))' },
  statusDetail: {
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.82em',
    color: 'hsl(var(--muted-foreground))',
  },
  actions: {
    position: 'relative',
    display: { default: 'none', '@media (min-width: 640px)': 'flex' },
    alignItems: 'center',
    justifyContent: 'flex-end',
    columnGap: '2px',
  },
  // Hidden until the row is hovered or focused, only where hover exists.
  hoverAction: {
    opacity: {
      default: 1,
      '@media (hover: hover)': {
        default: 0,
        [stylex.when.ancestor(':hover')]: 1,
        [stylex.when.ancestor(':focus-within')]: 1,
      },
    },
  },
  error: {
    paddingTop: '24px',
    paddingBottom: '8px',
    fontSize: '1em',
    color: 'hsl(var(--destructive))',
  },
  skeletonRow: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '12px',
    padding: '16px',
  },
  skeletonTrailing: { marginLeft: 'auto' },
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
  sectionEmpty: {
    margin: 0,
    padding: '16px',
    fontSize: '0.9em',
    color: 'hsl(var(--muted-foreground))',
  },
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
});

type RowHandlers = {
  onOpen: () => void;
  onToggle?: () => void;
  onRun?: () => void;
  onDelete?: () => void;
  onOpenSession?: (id: string) => void;
};

type Entry = {
  row: ScheduleRegistryRow;
  runtime?: ScheduleRuntimeRow;
  context?: ScheduleRowContext;
  status: ScheduleStatus;
};

const STATUS_ICONS = {
  due: Clock,
  paused: Pause,
  attention: CircleAlert,
  sent: Check,
  cancelled: Square,
} as const;

export function ScheduleStatusText({
  status,
  inline = false,
}: {
  status: ScheduleStatus;
  inline?: boolean;
}) {
  const Icon = status.icon ? STATUS_ICONS[status.icon] : null;
  const main = (
    <span
      {...stylex.props(
        styles.statusMain,
        status.tone === 'muted' && styles.statusMuted,
        status.tone === 'progress' && styles.statusProgress,
        status.tone === 'attention' && styles.statusAttention
      )}
    >
      {Icon ? <Icon {...stylex.props(styles.icon14)} aria-hidden="true" /> : null}
      {status.label}
    </span>
  );
  if (inline)
    return (
      <span>
        {main}
        {status.detail ? (
          <span {...stylex.props(styles.statusMuted)}> · {status.detail}</span>
        ) : null}
      </span>
    );
  return (
    <div {...stylex.props(styles.status)}>
      {main}
      {status.detail ? <span {...stylex.props(styles.statusDetail)}>{status.detail}</span> : null}
    </div>
  );
}

/** What the row's menus offer, in one order for the ⋯ menu and the context menu. */
/** One schedule action, as the row's menus and the open schedule's ⋯ menu show it. */
export type ScheduleAction = {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

function useRowActions(entry: Entry, handlers: RowHandlers) {
  const { t } = useTranslation();
  const { row, runtime, context } = entry;
  const actions: ScheduleAction[] = [
    {
      key: 'open',
      label: t('schedules.open', 'Open'),
      icon: ExternalLink,
      onClick: handlers.onOpen,
    },
  ];
  if (!row.scheduledMessage && handlers.onRun && context?.canRun !== false)
    actions.push({
      key: 'run',
      label: t('schedules.runNow', 'Run now'),
      icon: Play,
      onClick: handlers.onRun,
    });
  if (
    !row.scheduledMessage &&
    row.trigger.kind !== 'manual' &&
    handlers.onToggle &&
    context?.canToggle !== false
  )
    actions.push({
      key: 'toggle',
      label: row.enabled ? t('schedules.pause', 'Pause') : t('schedules.resume', 'Resume'),
      icon: row.enabled ? Pause : RotateCcw,
      onClick: handlers.onToggle,
    });
  const chatId = context?.chat?.sessionId;
  if (chatId && handlers.onOpenSession)
    actions.push({
      key: 'chat',
      label: t('schedules.openChat', 'Open chat “{{title}}”', { title: context.chat!.title }),
      icon: MessageSquare,
      onClick: () => handlers.onOpenSession!(chatId),
    });
  const last = runtime?.lastDispatch?.sessionId;
  if (last && !chatId && handlers.onOpenSession)
    actions.push({
      key: 'last',
      label: t('schedules.lastRun', 'Last run'),
      icon: History,
      onClick: () => handlers.onOpenSession!(last),
    });
  if (handlers.onDelete && context?.canDelete !== false)
    actions.push({
      key: 'delete',
      label: t('schedules.delete', 'Delete'),
      icon: Trash2,
      onClick: handlers.onDelete,
      destructive: true,
    });
  return actions;
}

/** Destructive actions sit after a separator. */
export function ScheduleMenuItems({
  actions,
  Item,
  Separator,
}: {
  actions: ScheduleAction[];
  Item: typeof Menu.Item | typeof ContextMenu.Item;
  Separator: typeof Menu.Separator | typeof ContextMenu.Separator;
}) {
  return (
    <>
      {actions.map((action) => (
        <Fragment key={action.key}>
          {action.destructive ? <Separator /> : null}
          <Item
            icon={action.icon}
            tone={action.destructive ? 'destructive' : undefined}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </Item>
        </Fragment>
      ))}
    </>
  );
}

function Destination({
  entry,
  onOpenSession,
}: {
  entry: Entry;
  onOpenSession?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { row, context } = entry;
  if (row.destination.kind === 'new_session')
    return (
      <span {...stylex.props(styles.destination)}>
        <Folder {...stylex.props(styles.icon14)} aria-hidden="true" />
        <span {...stylex.props(styles.truncate)}>
          {t('schedules.destination.newSession', 'New chat each run')} ·{' '}
          {context?.project ?? (row.projectKey || t('schedules.chatOnly', 'Chat only'))}
        </span>
      </span>
    );
  const chat = context?.chat;
  if (chat?.sessionId && onOpenSession)
    return (
      <span {...stylex.props(styles.destination)}>
        <Button
          variant="ghost"
          size="small"
          className={stylex.props(styles.chatButton).className}
          title={t('schedules.openChat', 'Open chat “{{title}}”', { title: chat.title })}
          onClick={() => onOpenSession(chat.sessionId!)}
        >
          <MessageSquare {...stylex.props(styles.icon14)} aria-hidden="true" />
          <span {...stylex.props(styles.truncate)}>{chat.title}</span>
          <ArrowUpRight {...stylex.props(styles.mutedIcon)} aria-hidden="true" />
        </Button>
      </span>
    );
  return (
    <span {...stylex.props(styles.destination)}>
      <MessageSquare {...stylex.props(styles.icon14)} aria-hidden="true" />
      <span {...stylex.props(styles.truncate)}>
        {chat?.title ??
          (row.destination.kind === 'own_session'
            ? t('schedules.destination.ownSession', 'One chat for this task')
            : t('schedules.destination.existingSession', 'An existing chat'))}
        {row.destination.kind === 'own_session' && !chat?.sessionId
          ? ` · ${t('schedules.destination.notCreatedYet', 'Not created yet')}`
          : ''}
      </span>
    </span>
  );
}

function ScheduleListRow({
  entry,
  selected,
  ...handlers
}: RowHandlers & { entry: Entry; selected?: boolean }) {
  const { t, i18n } = useTranslation();
  const { row, context, status } = entry;
  const actions = useRowActions(entry, handlers);
  const zone = triggerTimeZone(row.trigger, context?.timeZone);
  const offline = context ? context.presence === 'offline' : false;
  const frequency = describeTrigger(row.trigger, t, i18n.language, zone);
  // The one action worth a button: delete a finished message, run a manual
  // task, pause or resume a timed one.
  const primaryKey = row.scheduledMessage
    ? status.group === 'ended'
      ? 'delete'
      : undefined
    : row.trigger.kind === 'manual'
      ? 'run'
      : 'toggle';
  const primary = actions.find((action) => action.key === primaryKey);
  const rowElement = (
    <div
      data-schedule-row=""
      aria-current={selected ? 'true' : undefined}
      {...stylex.props(styles.grid, styles.row, selected && styles.rowSelected)}
    >
      <button type="button" onClick={handlers.onOpen} {...stylex.props(styles.openButton)}>
        <span {...stylex.props(styles.rowHitTarget)} aria-hidden="true" />
        <span {...stylex.props(styles.name, status.group === 'ended' && styles.nameEnded)}>
          {row.title}
        </span>
        <span {...stylex.props(styles.summary)}>
          <span {...stylex.props(styles.summaryPart)}>{frequency}</span>
          {context?.chat ? (
            <span {...stylex.props(styles.narrowOnly)}>
              <span {...stylex.props(styles.separator)}>·</span>
              <span {...stylex.props(styles.summaryPart)}>{context.chat.title}</span>
            </span>
          ) : null}
          <span {...stylex.props(styles.wideOnly)}>
            <span {...stylex.props(styles.separator)}>·</span>
            <span {...stylex.props(styles.summaryPart)}>{context?.agent ?? row.agentConfigId}</span>
            <span {...stylex.props(styles.separator)}>·</span>
            {offline ? (
              <span
                {...stylex.props(styles.offline)}
                title={t(
                  'schedules.machineOfflineHint',
                  'The target machine is not connected right now.'
                )}
              >
                <CloudOff {...stylex.props(styles.icon14)} aria-hidden="true" />
                {t('schedules.machineOffline', '{{machine}} offline', {
                  machine: context?.machine ?? row.machineId,
                })}
              </span>
            ) : (
              <span {...stylex.props(styles.summaryPart)}>{context?.machine ?? row.machineId}</span>
            )}
          </span>
        </span>
      </button>
      <Destination entry={entry} onOpenSession={handlers.onOpenSession} />
      <ScheduleStatusText status={status} />
      <div {...stylex.props(styles.actions)}>
        {primary ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Button
                  variant="ghost"
                  size="small"
                  icon
                  className={stylex.props(styles.hoverAction).className}
                  onClick={primary.onClick}
                  aria-label={primary.label}
                >
                  <primary.icon {...stylex.props(styles.icon14)} />
                </Button>
              }
            />
            <Tooltip.Content>{primary.label}</Tooltip.Content>
          </Tooltip.Root>
        ) : null}
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                variant="ghost"
                size="small"
                icon
                aria-label={t('schedules.more', 'More actions')}
              />
            }
          >
            <MoreHorizontal {...stylex.props(styles.icon14)} />
          </Menu.Trigger>
          <Menu.Content align="end">
            <ScheduleMenuItems actions={actions} Item={Menu.Item} Separator={Menu.Separator} />
          </Menu.Content>
        </Menu.Root>
      </div>
    </div>
  );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={rowElement} />
      <ContextMenu.Content>
        <ScheduleMenuItems
          actions={actions}
          Item={ContextMenu.Item}
          Separator={ContextMenu.Separator}
        />
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

function SectionInfo({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={150}
        render={
          <Button
            variant="ghost"
            size="small"
            icon
            aria-label={t('schedules.whatIs', 'What are {{title}}?', { title })}
          />
        }
      >
        <Info {...stylex.props(styles.mutedIcon)} />
      </Popover.Trigger>
      <Popover.Content align="start">
        <p {...stylex.props(styles.infoText)}>
          <strong {...stylex.props(styles.infoTitle)}>
            {t('schedules.whatIs', 'What are {{title}}?', { title })}
          </strong>
          {children}
        </p>
      </Popover.Content>
    </Popover.Root>
  );
}

function FilterMenu<T extends string>({
  icon,
  value,
  options,
  onChange,
  active,
  label,
}: {
  icon: ReactNode;
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  active: boolean;
  label: string;
}) {
  const current = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant={active ? 'secondary' : 'ghost'}
            size="small"
            aria-label={`${label}: ${current.label}`}
            className={stylex.props(styles.shrinkless).className}
          />
        }
      >
        {icon}
        {current.label}
        <ChevronDown {...stylex.props(styles.mutedIcon)} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Content align="start">
        <Menu.RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {options.map((option) => (
            <Menu.RadioItem
              key={option.value}
              value={option.value}
              endContent={option.count != null ? String(option.count) : undefined}
            >
              {option.label}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  );
}

const projectKey = (filter: ScheduleListProjectFilter) =>
  filter.kind === 'project' ? `project:${filter.name}` : filter.kind;

export function ScheduleListView({
  rows,
  runtimes,
  ready,
  error,
  retrying,
  onRetry,
  onOpen,
  onNew,
  onToggle,
  onRun,
  onDelete,
  onClearEnded,
  contextForRow,
  onOpenSession,
  selectedId,
  insetSafeArea = false,
  hideHeader = false,
  query: controlledQuery,
  initialFilters,
  now = getServerNow(),
}: {
  rows: ScheduleRegistryRow[];
  runtimes: ScheduleRuntimeRow[];
  ready: boolean;
  error?: string;
  retrying?: boolean;
  onRetry?: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onToggle?: (row: ScheduleRegistryRow) => void;
  onRun?: (row: ScheduleRegistryRow) => void;
  onDelete?: (row: ScheduleRegistryRow) => void;
  /** Deletes every finished scheduled message the person owns, after confirming. */
  onClearEnded?: (rows: ScheduleRegistryRow[]) => void;
  contextForRow?: (row: ScheduleRegistryRow) => ScheduleRowContext;
  onOpenSession?: (id: string) => void;
  /** Phone page that draws under the status bar. The home tab leaves this off. */
  insetSafeArea?: boolean;
  /** Home tab draws search and the new button in its own header. */
  hideHeader?: boolean;
  /** When set, the home search text filters this list. */
  query?: string;
  /** Stories and tests start from a given filter. */
  initialFilters?: {
    project?: ScheduleListProjectFilter;
    status?: ScheduleListStatusFilter;
    sort?: ScheduleListSort;
  };
  /** The schedule open over the list, highlighted. */
  selectedId?: string;
  /** Injected so stories and tests render fixed times. */
  now?: number;
}) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const isLeftSidebarHidden = !useAtomValue(navigationSidebarVisibleAtom);
  const showNavigationSidebar = useSetAtom(showNavigationSidebarAtom);
  const isElectronFullscreen = useElectronFullscreen();
  const windowDrag = useWindowDragRegionClass();
  const windowsCaptionPadClass = useWindowsCaptionPadClass();
  const macTrafficLightRowPadClass = useMacTrafficLightRowPadClass({ insideWorkspaceFrame: true });
  const windowsCaptionRowPadClass = useWindowsCaptionRowPadClass();
  const hasMacOSTitlebarInset =
    !isNativeAppShell() && isMacOSElectronRenderer() && !isElectronFullscreen;
  const showSidebarToggle = !isMobile && isLeftSidebarHidden;
  const besideTrafficLights = showSidebarToggle && hasMacOSTitlebarInset;
  const headerChromeClassName = [
    windowDrag,
    windowsCaptionPadClass,
    windowsCaptionRowPadClass,
    macTrafficLightRowPadClass,
  ]
    .filter(Boolean)
    .join(' ');
  const [localQuery, setLocalQuery] = useState('');
  const query = (controlledQuery ?? localQuery).trim().toLowerCase();
  const [project, setProject] = useState<ScheduleListProjectFilter>(
    initialFilters?.project ?? { kind: 'all' }
  );
  const [statusFilter, setStatusFilter] = useState<ScheduleListStatusFilter>(
    initialFilters?.status ?? 'all'
  );
  const [sort, setSort] = useState<ScheduleListSort>(initialFilters?.sort ?? 'next');

  const runtimeOf = indexScheduleRuntimes(runtimes);
  const entries: Entry[] = rows.map((row) => {
    const runtime = runtimeOf(row);
    const context = contextForRow?.(row);
    return {
      row,
      runtime,
      context,
      status: describeScheduleState(t, row, runtime, {
        timeZone: triggerTimeZone(row.trigger, context?.timeZone),
        now,
        locale: i18n.language,
      }),
    };
  });
  const projectOf = (entry: Entry) => entry.context?.project ?? (entry.row.projectKey || null);
  const matchesProject = (entry: Entry, filter: ScheduleListProjectFilter) =>
    filter.kind === 'all' ||
    (filter.kind === 'none' ? projectOf(entry) === null : projectOf(entry) === filter.name);
  const matchesStatus = (entry: Entry, filter: ScheduleListStatusFilter) =>
    filter === 'all' || entry.status.group === filter;
  const projectNames = [
    ...new Set(entries.map(projectOf).filter((name): name is string => !!name)),
  ].sort();
  const compare = {
    next: (a: Entry, b: Entry) =>
      (a.runtime?.nextScheduledAt ?? Number.POSITIVE_INFINITY) -
      (b.runtime?.nextScheduledAt ?? Number.POSITIVE_INFINITY),
    recent: (a: Entry, b: Entry) =>
      (b.runtime?.lastDispatch?.dispatchedAt ?? 0) - (a.runtime?.lastDispatch?.dispatchedAt ?? 0),
    name: (a: Entry, b: Entry) =>
      a.row.title.localeCompare(b.row.title, i18n.language.replace('_', '-')),
    created: (a: Entry, b: Entry) => b.row.createdAt - a.row.createdAt,
  }[sort];
  const visible = entries
    .filter(
      (entry) =>
        entry.row.title.toLowerCase().includes(query) &&
        matchesProject(entry, project) &&
        matchesStatus(entry, statusFilter)
    )
    .sort((a, b) => compare(a, b) || a.row.title.localeCompare(b.row.title));
  const filtering = project.kind !== 'all' || statusFilter !== 'all';

  const projectOptions = [
    {
      value: 'all',
      label: t('schedules.filter.allProjects', 'All projects'),
      count: entries.length,
    },
    ...projectNames.map((name) => ({
      value: `project:${name}`,
      label: name,
      count: entries.filter((entry) => projectOf(entry) === name).length,
    })),
    {
      value: 'none',
      label: t('schedules.filter.noProject', 'No project (chat only)'),
      count: entries.filter((entry) => projectOf(entry) === null).length,
    },
  ];
  const statusOptions = (
    [
      ['all', t('schedules.filter.allStatuses', 'All statuses')],
      ['running', t('schedules.filter.running', 'Active')],
      ['paused', t('schedules.paused', 'Paused')],
      ['attention', t('schedules.state.blocked', 'Needs attention')],
      ['ended', t('schedules.filter.ended', 'Finished')],
    ] as const
  ).map(([value, label]) => ({
    value,
    label,
    count: entries.filter((entry) => matchesStatus(entry, value)).length,
  }));
  const sortOptions = (
    [
      ['next', t('schedules.sort.next', 'Next run')],
      ['recent', t('schedules.sort.recent', 'Last run')],
      ['name', t('schedules.sort.name', 'Name')],
      ['created', t('schedules.sort.created', 'Newest')],
    ] as const
  ).map(([value, label]) => ({ value, label }));

  const sections: {
    key: 'tasks' | 'messages';
    title: string;
    info?: string;
    entries: Entry[];
    total: number;
  }[] = [
    {
      key: 'tasks',
      title: t('schedules.section.tasks', 'Scheduled tasks'),
      // Tasks are the page's own subject; only the one-off messages need a word.
      info: undefined,
      entries: visible.filter((entry) => !entry.row.scheduledMessage),
      total: entries.filter((entry) => !entry.row.scheduledMessage).length,
    },
    {
      key: 'messages',
      title: t('schedules.section.messages', 'Scheduled messages'),
      info: t(
        'schedules.section.messagesInfo',
        'A message written in a chat with “Schedule send…”, sent to that chat once at the chosen time.'
      ),
      entries: visible.filter((entry) => entry.row.scheduledMessage),
      total: entries.filter((entry) => entry.row.scheduledMessage).length,
    },
  ];

  return (
    <Tooltip.Provider>
      <section {...stylex.props(styles.page)}>
        {hideHeader ? null : (
          // Joins the Electron window's drag strip, which would otherwise
          // swallow clicks on the search and New button under it.
          <header
            {...withClassName(
              stylex.props(
                styles.header,
                insetSafeArea && styles.headerSafeArea,
                besideTrafficLights && styles.headerBesideTrafficLights
              ),
              headerChromeClassName
            )}
            data-safe-area-inset={insetSafeArea ? '' : undefined}
            data-beside-traffic-lights={besideTrafficLights ? '' : undefined}
          >
            {showSidebarToggle ? (
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon
                onClick={() => showNavigationSidebar()}
                aria-label={t('sessions.leftSidebar.show', 'Show navigation sidebar')}
                className={cn(
                  stylex.props(styles.sidebarToggle).className,
                  WINDOW_DRAG_EXEMPT_CLASS
                )}
              >
                <PanelLeft {...stylex.props(styles.glyph)} />
              </Button>
            ) : null}
            <h1 {...stylex.props(styles.pageTitle)}>{t('schedules.title', 'Schedules')}</h1>
            <Input
              size="small"
              leading={<Search {...stylex.props(styles.mutedIcon)} aria-hidden="true" />}
              aria-label={t('schedules.search', 'Search schedules')}
              placeholder={t('schedules.search', 'Search schedules')}
              className={cn(stylex.props(styles.search).className, WINDOW_DRAG_EXEMPT_CLASS)}
              value={localQuery}
              onChange={(event) => setLocalQuery(event.target.value)}
            />
            <Button
              variant="primary"
              size="small"
              className={cn(stylex.props(styles.shrinkless).className, WINDOW_DRAG_EXEMPT_CLASS)}
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
        )}

        <div {...stylex.props(styles.scroller)}>
          {error ? (
            <div {...stylex.props(styles.error)} role="alert">
              <p>
                {rows.length > 0
                  ? t('schedules.syncError', 'Schedules could not be synced. Showing saved tasks.')
                  : t('schedules.loadError', 'Schedules could not be loaded.')}
              </p>
              {onRetry ? (
                <Button variant="secondary" size="small" disabled={retrying} onClick={onRetry}>
                  {retrying ? t('schedules.retrying', 'Retrying…') : t('schedules.retry', 'Retry')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {!ready ? (
            <div aria-busy="true" {...stylex.props(styles.section, styles.card)}>
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
                </div>
              ))}
            </div>
          ) : error && rows.length === 0 ? null : rows.length === 0 ? (
            <div {...stylex.props(styles.empty)}>
              <CalendarClock {...stylex.props(styles.emptyIcon)} aria-hidden="true" />
              <p {...stylex.props(styles.emptyTitle)}>{t('schedules.empty', 'No schedules yet')}</p>
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
            </div>
          ) : (
            <>
              <div
                {...stylex.props(styles.filters)}
                role="toolbar"
                aria-label={t('schedules.filter.label', 'Filter and sort')}
              >
                <FilterMenu
                  label={t('schedules.filter.project', 'Project')}
                  icon={<Folder {...stylex.props(styles.mutedIcon)} aria-hidden="true" />}
                  value={projectKey(project)}
                  options={projectOptions}
                  active={project.kind !== 'all'}
                  onChange={(value) =>
                    setProject(
                      value === 'all' || value === 'none'
                        ? { kind: value }
                        : { kind: 'project', name: value.slice('project:'.length) }
                    )
                  }
                />
                <FilterMenu
                  label={t('schedules.filter.status', 'Status')}
                  icon={<ListFilter {...stylex.props(styles.mutedIcon)} aria-hidden="true" />}
                  value={statusFilter}
                  options={statusOptions}
                  active={statusFilter !== 'all'}
                  onChange={setStatusFilter}
                />
                {filtering ? (
                  <Button
                    variant="ghost"
                    size="small"
                    className={stylex.props(styles.shrinkless).className}
                    onClick={() => {
                      setProject({ kind: 'all' });
                      setStatusFilter('all');
                    }}
                  >
                    {t('schedules.filter.clear', 'Clear filters')}
                  </Button>
                ) : null}
                <span {...stylex.props(styles.spacer)} />
                <FilterMenu
                  label={t('schedules.sort.label', 'Sort')}
                  icon={<ArrowUpDown {...stylex.props(styles.mutedIcon)} aria-hidden="true" />}
                  value={sort}
                  options={sortOptions}
                  active={false}
                  onChange={setSort}
                />
              </div>
              {sections
                .filter((section) => section.total > 0)
                .map((section) => {
                  const ended = section.entries.filter(
                    (entry) =>
                      entry.status.group === 'ended' &&
                      entry.row.scheduledMessage &&
                      entry.context?.canDelete !== false
                  );
                  return (
                    <div key={section.key} {...stylex.props(styles.section)}>
                      <div {...stylex.props(styles.sectionHead)}>
                        <h2 {...stylex.props(styles.sectionTitle)}>{section.title}</h2>
                        <span {...stylex.props(styles.sectionCount)}>{section.entries.length}</span>
                        {section.info ? (
                          <SectionInfo title={section.title}>{section.info}</SectionInfo>
                        ) : null}
                        <span {...stylex.props(styles.spacer)} />
                        {section.key === 'messages' && ended.length > 0 && onClearEnded ? (
                          <Button
                            variant="ghost"
                            size="small"
                            onClick={() => onClearEnded(ended.map((entry) => entry.row))}
                          >
                            {t('schedules.clearEnded', 'Clear finished ({{count}})', {
                              count: ended.length,
                            })}
                          </Button>
                        ) : null}
                      </div>
                      <div {...stylex.props(styles.card)}>
                        {section.entries.length === 0 ? (
                          <p {...stylex.props(styles.sectionEmpty)}>
                            {query
                              ? t('schedules.noMatches', 'No schedules match your search')
                              : t(
                                  'schedules.filter.noMatches',
                                  'Nothing here matches the filters.'
                                )}
                          </p>
                        ) : (
                          <>
                            <div {...stylex.props(styles.grid, styles.columns)} aria-hidden="true">
                              <span>{t('schedules.column.name', 'Name')}</span>
                              <span>
                                {section.key === 'tasks'
                                  ? t('schedules.column.results', 'Results go to')
                                  : t('schedules.column.sendsTo', 'Sends to')}
                              </span>
                              <span {...stylex.props(styles.alignEnd)}>
                                {t('schedules.column.status', 'Status')}
                              </span>
                              <span />
                            </div>
                            {section.entries.map((entry) => (
                              <ScheduleListRow
                                key={entry.row.scheduleId}
                                entry={entry}
                                selected={entry.row.scheduleId === selectedId}
                                onOpen={() => onOpen(entry.row.scheduleId)}
                                onToggle={onToggle ? () => onToggle(entry.row) : undefined}
                                onRun={onRun ? () => onRun(entry.row) : undefined}
                                onDelete={onDelete ? () => onDelete(entry.row) : undefined}
                                onOpenSession={onOpenSession}
                              />
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
            </>
          )}
        </div>
      </section>
    </Tooltip.Provider>
  );
}
