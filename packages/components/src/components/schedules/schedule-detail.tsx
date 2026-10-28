import { Fragment, type ComponentType, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  MessageSquare,
  MoreHorizontal,
  Play,
  X,
} from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Spinner } from '@lody/ui/spinner';
import { Switch } from '@lody/ui/switch';
import { Tabs } from '@lody/ui/tabs';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import { Dialog } from '@/ui/dialog';
import { WINDOW_DRAG_EXEMPT_CLASS, useWindowDragRegionClass } from '@/ui/window-drag-region';
import { ScheduleStatusText } from './schedule-list';
import type { ScheduleStatus } from './schedule-format';
import { scheduleCardProps } from './schedule-property-row';

const styles = stylex.create({
  header: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'flex-start',
    columnGap: '6px',
    paddingTop: '14px',
    paddingLeft: '20px',
    paddingRight: '12px',
  },
  mobileHeader: {
    paddingTop: '8px',
    paddingLeft: '8px',
    paddingRight: '8px',
  },
  heading: { minWidth: 0, flex: '1 1 0%', paddingTop: '2px' },
  kind: { fontSize: '0.8em', color: 'hsl(var(--muted-foreground))' },
  title: {
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '1.1em',
    fontWeight: 600,
    color: 'hsl(var(--foreground))',
  },
  status: { marginTop: '2px', fontSize: '0.9em' },
  controls: { display: 'flex', flexShrink: 0, alignItems: 'center', columnGap: '4px' },
  switchLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: '8px',
    marginRight: '4px',
    fontSize: '0.9em',
    color: 'hsl(var(--muted-foreground))',
  },
  icon14: { width: '14px', height: '14px', flexShrink: 0 },
  icon16: { width: '16px', height: '16px' },
  runs: { display: 'flex', flexDirection: 'column', rowGap: '10px' },
  caption: {
    margin: 0,
    paddingLeft: '4px',
    fontSize: '0.85em',
    color: 'hsl(var(--muted-foreground))',
  },
  chatCard: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '10px',
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: '14px',
    paddingRight: '10px',
    fontSize: '0.92em',
  },
  chatText: {
    minWidth: 0,
    flex: '1 1 0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  strong: { fontWeight: 500 },
  run: {
    display: 'grid',
    width: '100%',
    gridTemplateColumns: '16px minmax(0, 1fr) auto 14px',
    alignItems: 'center',
    columnGap: '10px',
    minHeight: '42px',
    paddingLeft: '14px',
    paddingRight: '12px',
    textAlign: 'left',
    fontSize: '0.92em',
    backgroundColor: { default: 'transparent', ':hover': 'hsl(var(--foreground) / 0.04)' },
  },
  runTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  runMeta: {
    whiteSpace: 'nowrap',
    fontSize: '0.9em',
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--muted-foreground))',
  },
  muted: { color: 'hsl(var(--muted-foreground))' },
  ok: { color: 'hsl(var(--status-success))' },
  warn: { color: 'hsl(var(--status-warning))' },
  empty: { margin: 0, padding: '14px', fontSize: '0.92em', color: 'hsl(var(--muted-foreground))' },
  // The modal panel lays out its own header, tabs and scrolling body.
  modal: { display: 'flex', flexDirection: 'column', padding: 0, rowGap: 0, overflow: 'hidden' },
  page: {
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    height: '100%',
    minHeight: 0,
    // The phone page owns its top edge; desktop insets belong to the shell.
    paddingTop: 'var(--safe-area-top, 0px)',
    backgroundColor: 'hsl(var(--background))',
  },
  tabs: {
    flexShrink: 0,
    paddingTop: '10px',
    paddingLeft: { default: '16px', '@media (min-width: 640px)': '20px' },
    paddingRight: '20px',
    paddingBottom: '2px',
    borderBottomWidth: '0.5px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border))',
  },
  headRule: {
    flexShrink: 0,
    marginTop: '12px',
    borderBottomWidth: '0.5px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border))',
  },
  // The page grey under white cards; the form's sticky footer shares it.
  body: {
    minHeight: 0,
    flex: '1 1 0%',
    overflow: 'auto',
    backgroundColor: 'hsl(var(--background))',
  },
  historyPane: {
    width: '100%',
    maxWidth: '42rem',
    boxSizing: 'border-box',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingLeft: { default: '16px', '@media (min-width: 640px)': '24px' },
    paddingRight: { default: '16px', '@media (min-width: 640px)': '24px' },
    paddingTop: '20px',
    paddingBottom: '24px',
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

export type ScheduleDetailTab = 'settings' | 'history';

/**
 * The open schedule's frame: its header, the Settings / Run history tabs (a
 * scheduled message has none), and the scrolling body. One frame for the
 * desktop modal and the phone page.
 */
export function ScheduleDetailFrame({
  header,
  tab,
  onTabChange,
  children,
}: {
  header: ReactNode;
  /** Omitted: no tabs, as for a scheduled message or a new schedule. */
  tab?: ScheduleDetailTab;
  onTabChange?: (tab: ScheduleDetailTab) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      {header}
      {tab ? (
        <div {...stylex.props(styles.tabs)}>
          <Tabs.Root
            value={tab}
            onValueChange={(next) => {
              if (next === 'settings' || next === 'history') onTabChange?.(next);
            }}
          >
            <Tabs.List size="small">
              <Tabs.Tab value="settings">{t('schedules.tab.settings', 'Settings')}</Tabs.Tab>
              <Tabs.Tab value="history">{t('schedules.history', 'Run history')}</Tabs.Tab>
            </Tabs.List>
          </Tabs.Root>
        </div>
      ) : (
        <div {...stylex.props(styles.headRule)} />
      )}
      <div data-settings-surface="" {...stylex.props(styles.body)}>
        {tab === 'history' ? <div {...stylex.props(styles.historyPane)}>{children}</div> : children}
      </div>
    </>
  );
}

/** Desktop: the open schedule is a modal over the list. Escape, the close
 *  button and the backdrop all return to the list. */
export function ScheduleDetailModal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Dialog.Content
        width={720}
        closeButton={false}
        className={stylex.props(styles.modal).className}
        // Inline, because the panel's own padding and gap come from the package's
        // class and would otherwise win the cascade over this one.
        style={{ padding: 0, rowGap: 0 }}
      >
        <Dialog.Title {...stylex.props(styles.visuallyHidden)}>{title}</Dialog.Title>
        {children}
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** Phone: the open schedule is a pushed page. */
export function ScheduleDetailPage({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.page)}>{children}</div>;
}

export type ScheduleDetailAction = {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

/**
 * The open schedule's head: what kind of thing it is, its name and status in
 * words, the one control that changes whether it runs (an enable switch, or Run
 * for a manual task), a ⋯ menu for the rest, and close. On a phone the leading
 * button goes back to the list instead.
 */
export function ScheduleDetailHeader({
  kind,
  title,
  status,
  enabled,
  run,
  actions,
  onClose,
  mobile = false,
}: {
  kind: 'task' | 'message';
  title: string;
  status?: ScheduleStatus;
  enabled?: { value: boolean; disabled?: boolean; onChange: () => void };
  run?: { disabled?: boolean; onRun: () => void };
  actions: ScheduleDetailAction[];
  onClose: () => void;
  mobile?: boolean;
}) {
  const { t } = useTranslation();
  // On a phone this is the page's top edge, where Electron's drag strip lies.
  const windowDrag = useWindowDragRegionClass();
  const close = (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            variant="ghost"
            size="small"
            icon
            onClick={onClose}
            className={WINDOW_DRAG_EXEMPT_CLASS}
            aria-label={mobile ? t('schedules.back', 'Back') : t('schedules.close', 'Close')}
          >
            {mobile ? (
              <ChevronLeft {...stylex.props(styles.icon16)} />
            ) : (
              <X {...stylex.props(styles.icon16)} />
            )}
          </Button>
        }
      />
      <Tooltip.Content>
        {mobile ? t('schedules.back', 'Back') : t('schedules.close', 'Close')}
      </Tooltip.Content>
    </Tooltip.Root>
  );
  return (
    <Tooltip.Provider>
      <div
        className={cn(
          stylex.props(styles.header, mobile && styles.mobileHeader).className,
          mobile && windowDrag
        )}
      >
        {mobile ? close : null}
        <div {...stylex.props(styles.heading)}>
          <div {...stylex.props(styles.kind)}>
            {kind === 'task'
              ? t('schedules.section.task', 'Scheduled task')
              : t('schedules.section.message', 'Scheduled message')}
          </div>
          <h2 {...stylex.props(styles.title)}>{title}</h2>
          {status ? (
            <div {...stylex.props(styles.status)}>
              <ScheduleStatusText status={status} inline />
            </div>
          ) : null}
        </div>
        <div {...stylex.props(styles.controls)}>
          {enabled ? (
            // The label is the state, beside the switch that changes it.
            // eslint-disable-next-line jsx-a11y/label-has-associated-control -- Switch renders the button
            <label
              className={cn(stylex.props(styles.switchLabel).className, WINDOW_DRAG_EXEMPT_CLASS)}
            >
              {enabled.value ? t('schedules.enabled', 'Enabled') : t('schedules.paused', 'Paused')}
              <Switch
                checked={enabled.value}
                disabled={enabled.disabled}
                onCheckedChange={() => enabled.onChange()}
              />
            </label>
          ) : null}
          {run ? (
            <Button
              variant="secondary"
              size="small"
              disabled={run.disabled}
              onClick={run.onRun}
              className={WINDOW_DRAG_EXEMPT_CLASS}
            >
              <Play {...stylex.props(styles.icon14)} />
              {t('schedules.runNow', 'Run now')}
            </Button>
          ) : null}
          {actions.length ? (
            <Menu.Root>
              <Menu.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="small"
                    icon
                    className={WINDOW_DRAG_EXEMPT_CLASS}
                    aria-label={t('schedules.more', 'More actions')}
                  />
                }
              >
                <MoreHorizontal {...stylex.props(styles.icon16)} />
              </Menu.Trigger>
              <Menu.Content align="end">
                {actions.map((action) => (
                  <Fragment key={action.key}>
                    {action.destructive ? <Menu.Separator /> : null}
                    <Menu.Item
                      icon={action.icon}
                      tone={action.destructive ? 'destructive' : undefined}
                      disabled={action.disabled}
                      onClick={action.onClick}
                    >
                      {action.label}
                    </Menu.Item>
                  </Fragment>
                ))}
              </Menu.Content>
            </Menu.Root>
          ) : null}
          {mobile ? null : close}
        </div>
      </div>
    </Tooltip.Provider>
  );
}

export type ScheduleRunEntry = {
  id: string;
  title: string;
  /** Already formatted for the reader. */
  when: string;
  state: 'done' | 'running' | 'failed' | 'idle';
  /** Session to open: the run's own chat, or the chat it was appended to. */
  sessionId: string;
};

function RunMark({ state }: { state: ScheduleRunEntry['state'] }) {
  const { t } = useTranslation();
  if (state === 'running')
    return <Spinner size="small" label={t('schedules.sessionState.running', 'Running')} />;
  if (state === 'failed')
    return (
      <CircleAlert
        {...stylex.props(styles.icon14, styles.warn)}
        aria-label={t('schedules.runFailed', 'Failed')}
      />
    );
  if (state === 'done')
    return (
      <Check
        {...stylex.props(styles.icon14, styles.ok)}
        aria-label={t('schedules.runDone', 'Finished')}
      />
    );
  return <span aria-hidden="true" />;
}

/**
 * Every run of a schedule. A schedule that starts a new chat per run lists those
 * chats; one that posts into a chat leads with that chat and lists each run in
 * it, newest first.
 */
export function ScheduleRunList({
  runs,
  loading,
  chat,
  onOpen,
  footer,
}: {
  runs: ScheduleRunEntry[];
  loading?: boolean;
  /** The chat every run goes into; absent for a new chat per run. */
  chat?: { title: string; sessionId?: string };
  onOpen: (sessionId: string) => void;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.runs)}>
      {chat ? (
        <div {...scheduleCardProps()}>
          <div {...stylex.props(styles.chatCard)}>
            <MessageSquare {...stylex.props(styles.icon14, styles.muted)} aria-hidden="true" />
            <span {...stylex.props(styles.chatText)}>
              {t('schedules.history.allInChat', 'Every run goes to')}{' '}
              <span {...stylex.props(styles.strong)}>{chat.title}</span>
            </span>
            {chat.sessionId ? (
              <Button variant="secondary" size="small" onClick={() => onOpen(chat.sessionId!)}>
                {t('schedules.history.openChat', 'Open chat')}
                <ArrowUpRight {...stylex.props(styles.icon14)} />
              </Button>
            ) : (
              <span {...stylex.props(styles.muted)}>
                {t('schedules.destination.notCreatedYet', 'Not created yet')}
              </span>
            )}
          </div>
        </div>
      ) : null}
      {loading ? (
        <p {...stylex.props(styles.caption)}>{t('schedules.history.loading', 'Loading runs…')}</p>
      ) : runs.length === 0 ? (
        <p {...scheduleCardProps(stylex.props(styles.empty).className)}>
          {t('schedules.history.empty', 'No runs yet. Each run will appear here.')}
        </p>
      ) : (
        <>
          <p {...stylex.props(styles.caption)}>
            {chat
              ? t('schedules.history.countInChat', '{{count}} runs in this chat', {
                  count: runs.length,
                })
              : t('schedules.history.countChats', '{{count}} chats', { count: runs.length })}
          </p>
          <div {...scheduleCardProps()}>
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                {...stylex.props(styles.run)}
                onClick={() => onOpen(run.sessionId)}
              >
                <RunMark state={run.state} />
                <span {...stylex.props(styles.runTitle)}>{run.title}</span>
                <span {...stylex.props(styles.runMeta)}>{run.when}</span>
                <ChevronRight {...stylex.props(styles.icon14, styles.muted)} aria-hidden="true" />
              </button>
            ))}
          </div>
        </>
      )}
      {footer}
    </div>
  );
}
