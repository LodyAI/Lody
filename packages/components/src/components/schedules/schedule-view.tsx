import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CalendarClock,
  ChevronRight,
  CloudOff,
  History,
  Pause,
  Play,
  Plus,
  Search,
} from 'lucide-react';
import {
  applyScheduleRecurrence,
  defaultScheduleRecurrence,
  getDeviceTimeZone,
  getServerNow,
  previewSchedule,
  triggerToRecurrence,
  withScheduleRecurrenceTimeZone,
  type ScheduleRecurrence,
  type ScheduleRegistryRow,
  type ScheduleRuntimeRow,
  type ScheduleTrigger,
} from '@lody/shared';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Skeleton } from '@/ui/skeleton';
import { Textarea } from '@/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
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
import { ScheduleSection } from './schedule-property-row';
import { FieldIssueMark } from './schedule-run-bar';
import type { ScheduleSaveIssue } from './schedule-save-blockers';
import { ScheduleRecurrenceEditor } from './schedule-recurrence-editor';

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
};

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
  'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1.05fr)_minmax(0,1.1fr)_minmax(0,1.15fr)_5.75rem]';

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
  onOpenSession,
}: {
  row: ScheduleRegistryRow;
  runtime?: ScheduleRuntimeRow;
  context?: ScheduleRowContext;
  now: number;
  onOpen: () => void;
  onToggle?: () => void;
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
  return (
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
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="truncate text-foreground/80">
                {formatUpcoming(next, zone, now, i18n.language)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {formatInstant(next, zone, i18n.language)} · {zone}
            </TooltipContent>
          </Tooltip>
        ) : manual ? (
          <span className="truncate">{t('schedules.trigger.onDemand', 'On demand')}</span>
        ) : row.enabled ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="truncate">
                {t('schedules.notScheduledYet', 'Not scheduled yet')}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t('schedules.awaitingMachine', 'Waiting for the machine to check the schedule')}
            </TooltipContent>
          </Tooltip>
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
            <Tooltip>
              <TooltipTrigger asChild>
                <CloudOff className="size-3.5 shrink-0 text-status-warning" />
              </TooltipTrigger>
              <TooltipContent>
                {t(
                  'schedules.machineOfflineHint',
                  'The target machine is not connected right now.'
                )}
              </TooltipContent>
            </Tooltip>
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                // Visible by default; only a device that actually has hover is
                // allowed to hide it until the row is hovered or focused.
                className="size-7 shrink-0 text-muted-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
                onClick={() => onOpenSession(runtime.lastDispatch!.sessionId)}
                aria-label={t('schedules.lastRun', 'Last run')}
              >
                <History className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('schedules.lastRun', 'Last run')}</TooltipContent>
          </Tooltip>
        ) : null}
        {onToggle && context?.canToggle !== false ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={onToggle}
            aria-label={
              row.enabled ? t('schedules.pause', 'Pause') : t('schedules.resume', 'Resume')
            }
          >
            {row.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </Button>
        ) : null}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
      </div>
    </div>
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
  contextForRow,
  onOpenSession,
  now = getServerNow(),
}: {
  rows: ScheduleRegistryRow[];
  runtimes: ScheduleRuntimeRow[];
  ready: boolean;
  error?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onToggle?: (row: ScheduleRegistryRow) => void;
  contextForRow?: (row: ScheduleRegistryRow) => ScheduleRowContext;
  onOpenSession?: (id: string) => void;
  /** Injected so stories and tests render a fixed "next run" column. */
  now?: number;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const filtered = rows.filter((row) =>
    row.title.toLowerCase().includes(query.trim().toLowerCase())
  );
  return (
    // Own the tooltip context rather than depending on an ancestor: the row
    // tooltips carry the exact next-run instant and the offline reason, which
    // must not be what makes this list crash where it is mounted.
    <TooltipProvider>
      <section className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-2 px-4 py-3">
          <h1 className="mr-auto text-[1em] font-normal text-foreground">
            {t('schedules.title', 'Schedules')}
          </h1>
          <div className="relative w-40 sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t('schedules.search', 'Search schedules')}
              placeholder={t('schedules.search', 'Search schedules')}
              className="h-8 pl-8 text-[0.9em] font-normal"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Button
            size="sm"
            className="h-8 shrink-0"
            onClick={onNew}
            // The label is the only text and it is hidden on narrow screens.
            aria-label={t('schedules.new', 'New schedule')}
          >
            <Plus className="size-3.5" />
            <span className="hidden sm:inline">{t('schedules.new', 'New schedule')}</span>
          </Button>
        </header>

        {ready && !error && filtered.length > 0 ? (
          <div
            className={cn(
              listGridClass,
              'hidden shrink-0 border-b-[0.5px] border-border px-4 py-1.5 text-[0.75em] font-normal text-muted-foreground sm:grid'
            )}
          >
            <span>{t('schedules.column.name', 'Name')}</span>
            <span>{t('schedules.column.frequency', 'Frequency')}</span>
            <span>{t('schedules.column.next', 'Next run')}</span>
            <span>{t('schedules.column.target', 'Runs with')}</span>
            <span />
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {!ready ? (
            <div className="space-y-px" aria-busy="true">
              <span className="sr-only">{t('schedules.loading', 'Loading schedules…')}</span>
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 border-b-[0.5px] border-border px-4 py-3"
                >
                  <Skeleton className="h-3.5 w-48" />
                  <Skeleton className="ml-auto h-3.5 w-24" />
                  <Skeleton className="h-3.5 w-20" />
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
                  <Button size="sm" variant="outline" className="mt-2 h-8" onClick={onNew}>
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
                onOpenSession={onOpenSession}
              />
            ))
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}

export type ScheduleFormValue = {
  title: string;
  prompt: string;
  trigger: ScheduleTrigger;
  misfire: 'skip' | 'run_once';
  overlap: 'skip' | 'queue_one';
};

type TriggerMode = 'timed' | 'manual';

/** State the run bar needs to decide which problem marks to show. */
export type ScheduleRunBarState = {
  /** The person tried to save, so unfinished choices are marked too. */
  revealMissing: boolean;
};

/**
 * The schedule editor.
 *
 * Laid out like the composer, because it is one: a box holding the name, the
 * prompt and, along its bottom edge, the run bar — where it runs, with which
 * Agent, in which project. The time rule follows in its own card. Title and
 * prompt carry their guidance in the placeholder, and the accessible name
 * stays on the field.
 *
 * Nothing is listed at the bottom. Each problem is an exclamation mark next to
 * the control that fixes it; a missing value is marked once the person tries
 * to save, a real conflict at once. Only a reason that belongs to no control
 * (read-only, workspace still loading) sits beside Save.
 *
 * Wall times are read on the target machine's clock (`timeZone`); there is no
 * zone picker.
 */
export function ScheduleForm({
  initial,
  timeZone = getDeviceTimeZone(),
  clockName,
  runBar,
  runNote,
  issues = [],
  saving,
  error,
  autoFocus,
  revealIssues = false,
  now = getServerNow(),
  onSave,
}: {
  initial: ScheduleFormValue;
  /** IANA zone of the machine that runs the schedule. */
  timeZone?: string;
  /** That machine's name, for "Next runs … (MacBook Pro time)". */
  clockName?: string;
  /** Destination / Agent / Project pills, owned by the workspace container. */
  runBar?: (state: ScheduleRunBarState) => ReactNode;
  /** One muted line under the box: what the current run choice means. */
  runNote?: ReactNode;
  issues?: readonly ScheduleSaveIssue[];
  saving: boolean;
  error?: string;
  /** Focus the name when the editor opens (a new schedule). */
  autoFocus?: boolean;
  /** Start with unfinished choices marked, as after a save attempt. */
  revealIssues?: boolean;
  /** Injected so previews and tests are deterministic. */
  now?: number;
  onSave: (value: ScheduleFormValue) => void;
}) {
  const { t, i18n } = useTranslation();
  const [value, setValue] = useState(initial);
  const [attempted, setAttempted] = useState(revealIssues);
  const titleRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<TriggerMode>(
    initial.trigger.kind === 'manual' ? 'manual' : 'timed'
  );
  // The last timed rule survives a round trip through "manual", so switching
  // back does not reset a carefully chosen time.
  const [recurrence, setRecurrence] = useState<ScheduleRecurrence>(() =>
    initial.trigger.kind === 'manual'
      ? defaultScheduleRecurrence(timeZone)
      : triggerToRecurrence(initial.trigger)
  );
  // The rule always runs on the target machine's clock.
  const onMachineClock = withScheduleRecurrenceTimeZone(recurrence, timeZone);

  // Reuse the stored trigger verbatim while the rule is untouched, so opening
  // and saving an existing schedule cannot rewrite its expression.
  const resolved = useMemo(() => {
    if (mode === 'manual') return { trigger: { kind: 'manual' } as ScheduleTrigger, times: [] };
    try {
      const trigger = applyScheduleRecurrence(onMachineClock, now, initial.trigger);
      return { trigger, times: previewSchedule(trigger, 0, now) };
    } catch {
      return {
        error:
          onMachineClock.kind === 'weekly' && onMachineClock.weekdays.length === 0
            ? t('schedules.requireWeekday', 'Choose at least one day of the week.')
            : onMachineClock.kind === 'monthly' && onMachineClock.days.length === 0
              ? t('schedules.requireMonthDay', 'Choose at least one day of the month.')
              : t('schedules.invalidTime', 'Check the time rule and time zone.'),
      };
    }
  }, [initial.trigger, mode, now, onMachineClock, t]);

  const titleMissing = !value.title.trim();
  const promptMissing = !value.prompt.trim();
  const formIssues = issues.filter((issue) => issue.field === 'form');
  const blocked = titleMissing || promptMissing || !!resolved.error || issues.length > 0;
  const zone = triggerTimeZone(resolved.trigger ?? initial.trigger);
  const noteId = useId();

  return (
    // Own the tooltip context: every problem mark explains itself in one.
    <TooltipProvider>
      <form
        // Light themes lift the grouped cards to the popover fill, like settings.
        data-settings-surface=""
        noValidate
        className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-5 sm:px-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          if (blocked) {
            setAttempted(true);
            if (titleMissing) titleRef.current?.focus();
            else if (promptMissing) promptRef.current?.focus();
            return;
          }
          if (resolved.trigger) onSave({ ...value, trigger: resolved.trigger });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <div
            className={cn(
              'flex flex-col rounded-xl border border-foreground/[0.08] bg-card transition-colors',
              'focus-within:border-foreground/[0.16] dark:border-white/[0.08] dark:bg-foreground/[0.03] dark:focus-within:border-white/[0.16]'
            )}
          >
            <div className="flex items-center gap-2 px-3 pt-2.5">
              <input
                ref={titleRef}
                required
                maxLength={200}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- a new schedule starts at its name
                autoFocus={autoFocus}
                aria-label={t('schedules.name', 'Name')}
                aria-invalid={attempted && titleMissing ? true : undefined}
                placeholder={t('schedules.namePlaceholder', 'Name this scheduled task')}
                className="min-w-0 flex-1 bg-transparent text-[1.05em] font-normal text-foreground outline-hidden placeholder:text-muted-foreground/60 focus-visible:shadow-none"
                value={value.title}
                onChange={(event) => setValue({ ...value, title: event.target.value })}
              />
              {attempted && titleMissing ? (
                <FieldIssueMark messages={[t('schedules.requireName', 'Enter a schedule name.')]} />
              ) : null}
            </div>
            <div className="flex items-start gap-2 px-3 pb-1 pt-1.5">
              <Textarea
                ref={promptRef}
                required
                rows={3}
                aria-label={t('schedules.prompt', 'What should the Agent do?')}
                aria-invalid={attempted && promptMissing ? true : undefined}
                placeholder={t(
                  'schedules.promptPlaceholder',
                  'What should the agent do on every run? For example: review yesterday’s commits and summarise anything that looks risky.'
                )}
                className="min-h-20 flex-1 resize-y rounded-none border-0 bg-transparent p-0 text-[0.95em] leading-relaxed text-foreground shadow-none placeholder:text-muted-foreground/60 focus-visible:shadow-none focus-visible:ring-0 dark:bg-transparent"
                value={value.prompt}
                onChange={(event) => setValue({ ...value, prompt: event.target.value })}
              />
              {attempted && promptMissing ? (
                <FieldIssueMark
                  className="mt-0.5"
                  messages={[t('schedules.requirePrompt', 'Describe what the Agent should do.')]}
                />
              ) : null}
            </div>
            {runBar ? (
              <div className="flex flex-wrap items-center gap-0.5 px-1.5 pb-1.5">
                {runBar({ revealMissing: attempted })}
              </div>
            ) : null}
          </div>
          {runNote ? (
            <p className="px-3 text-[0.8em] leading-snug text-muted-foreground">{runNote}</p>
          ) : null}
        </div>

        <ScheduleSection
          title={t('schedules.trigger.label', 'Trigger')}
          action={
            <div
              role="radiogroup"
              aria-label={t('schedules.trigger.label', 'Trigger')}
              className="flex rounded-md bg-foreground/[0.05] p-0.5 dark:bg-white/[0.06]"
            >
              {(['timed', 'manual'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={mode === option}
                  onClick={() => setMode(option)}
                  className={cn(
                    'rounded-[5px] px-2 py-0.5 text-[0.8em] font-normal transition-colors',
                    mode === option
                      ? 'bg-background text-foreground shadow-[0_0_0_0.5px_hsl(var(--border)),0_1px_1px_rgba(0,0,0,0.04)] dark:bg-white/[0.12] dark:shadow-none'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {option === 'timed'
                    ? t('schedules.trigger.timed', 'On a schedule')
                    : t('schedules.trigger.manual', 'Manual')}
                </button>
              ))}
            </div>
          }
        >
          {mode === 'manual' ? (
            <p className="flex min-h-11 items-center px-3 py-2 text-[0.9em] text-muted-foreground">
              {t(
                'schedules.trigger.manualHelp',
                'Runs only when you press Run. Keep the prompt and target ready for whenever you need it.'
              )}
            </p>
          ) : (
            <>
              <ScheduleRecurrenceEditor
                value={onMachineClock}
                onChange={setRecurrence}
                now={now}
                timeZone={timeZone}
              />
              <div
                className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-[0.85em] text-muted-foreground"
                aria-live="polite"
                aria-atomic="true"
              >
                {resolved.error ? (
                  <span className="flex items-center gap-1.5 text-status-warning" role="alert">
                    <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
                    {resolved.error}
                  </span>
                ) : resolved.times?.length ? (
                  <>
                    <span>{t('schedules.nextRuns', 'Next runs')}</span>
                    <span className="text-foreground">
                      {resolved.times
                        .slice(0, 3)
                        .map((at) => formatUpcoming(at, zone, now, i18n.language))
                        .join(' · ')}
                    </span>
                    <span title={zone}>
                      {clockName
                        ? t('schedules.machineClock', '{{machine}} time', { machine: clockName })
                        : zone}
                    </span>
                  </>
                ) : (
                  t('schedules.noFuture', 'No future run under this rule.')
                )}
              </div>
            </>
          )}
        </ScheduleSection>

        <div className="flex flex-col gap-2 border-t-[0.5px] border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div id={noteId} aria-live="polite" className="min-w-0 flex-1 px-3">
            {error ? (
              <p className="text-[0.85em] text-destructive" role="alert">
                {error}
              </p>
            ) : formIssues.length ? (
              <p className="flex items-start gap-1.5 text-[0.85em] text-muted-foreground">
                <AlertCircle
                  className="mt-0.5 size-3.5 shrink-0 text-status-warning"
                  aria-hidden="true"
                />
                <span>{formIssues.map((issue) => issue.message).join(' ')}</span>
              </p>
            ) : attempted && blocked ? (
              <p className="text-[0.85em] text-muted-foreground">
                {t('schedules.fixMarked', 'Fix the marked items to save.')}
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            size="sm"
            className="h-8 shrink-0 self-end sm:self-auto"
            disabled={saving || formIssues.length > 0}
            aria-describedby={noteId}
          >
            {saving ? t('schedules.saving', 'Saving…') : t('schedules.save', 'Save schedule')}
          </Button>
        </div>
      </form>
    </TooltipProvider>
  );
}

/** Default form value for a brand new schedule: run every day at 09:00. */
export function newScheduleFormValue(now = getServerNow()): ScheduleFormValue {
  return {
    title: '',
    prompt: '',
    trigger: applyScheduleRecurrence(defaultScheduleRecurrence(), now),
    misfire: 'run_once',
    overlap: 'queue_one',
  };
}
