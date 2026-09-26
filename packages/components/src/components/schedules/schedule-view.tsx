import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import {
  applyScheduleRecurrence,
  defaultScheduleRecurrence,
  getDeviceTimeZone,
  getServerNow,
  previewSchedule,
  triggerToRecurrence,
  withScheduleRecurrenceTimeZone,
  type ScheduleRecurrence,
  type ScheduleTrigger,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Tabs } from '@lody/ui/tabs';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatUpcoming, triggerTimeZone } from './schedule-format';
import { PropertyRow, scheduleCardProps } from './schedule-property-row';
import { FieldIssueMark } from './schedule-field-issue-mark';
import type { ScheduleSaveIssue } from './schedule-save-blockers';
import { ScheduleRecurrenceEditor } from './schedule-recurrence-editor';

export {
  ScheduleListView,
  matchingScheduleRuntime,
  type ScheduleColumnWidths,
  type ScheduleRowContext,
} from './schedule-list';

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
 * Agent, in which project. Where runs go and when share one card below. Title and
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
  agentBar,
  contextBar,
  contextNote,
  destination,
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
  /** The composer's Agent controls, along the bottom edge of the prompt box. */
  agentBar?: (state: ScheduleRunBarState) => ReactNode;
  /** Machine / project / worktree pills under the box, as on the chat landing. */
  contextBar?: (state: ScheduleRunBarState) => ReactNode;
  /** One muted line under those pills: what the current choice means. */
  contextNote?: ReactNode;
  /** Where each run's prompt goes: the first rows of the run card. */
  destination?: (state: ScheduleRunBarState) => ReactNode;
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
    <Tooltip.Provider>
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
        <div className="flex flex-col gap-2">
          <div
            className={cn(
              'flex flex-col rounded-xl border border-foreground/[0.08] bg-card transition-colors',
              'focus-within:border-foreground/[0.16] dark:border-white/[0.08] dark:bg-foreground/[0.03] dark:focus-within:border-white/[0.16]'
            )}
          >
            <div className="flex items-center gap-2 px-3 py-2.5">
              <input
                ref={titleRef}
                required
                maxLength={200}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- a new schedule starts at its name
                autoFocus={autoFocus}
                aria-label={t('schedules.name', 'Name')}
                aria-invalid={attempted && titleMissing ? true : undefined}
                placeholder={t('schedules.namePlaceholder', 'Name this scheduled task')}
                className="min-w-0 flex-1 bg-transparent text-[1.2em] font-semibold text-foreground outline-hidden placeholder:text-muted-foreground/60 focus-visible:shadow-none"
                value={value.title}
                onChange={(event) => setValue({ ...value, title: event.target.value })}
              />
              {attempted && titleMissing ? (
                <FieldIssueMark messages={[t('schedules.requireName', 'Enter a schedule name.')]} />
              ) : null}
            </div>
            <div className="mx-3 border-t-[0.5px] border-foreground/[0.10] dark:border-white/[0.10]" />
            <div className="relative px-3 pb-1 pt-2.5">
              {/* A bare field inside the composer-style box, like the title
                  input: the box is the edge, so this is not a styled Textarea. */}
              <textarea
                ref={promptRef}
                required
                rows={4}
                aria-label={t('schedules.prompt', 'What should the Agent do?')}
                aria-invalid={attempted && promptMissing ? true : undefined}
                placeholder={t(
                  'schedules.promptPlaceholder',
                  'What should the agent do on every run? For example: review yesterday’s commits and summarise anything that looks risky.'
                )}
                // Grows with its text from 4 to 6 lines, then scrolls; no
                // resize handle. `field-sizing` is CSS-only (Chromium).
                className={cn(
                  'block min-h-[calc(4lh)] max-h-[calc(6lh)] w-full resize-none overflow-y-auto bg-transparent p-0 text-[0.95em] leading-relaxed text-foreground outline-hidden [field-sizing:content] placeholder:text-muted-foreground/60 focus-visible:shadow-none',
                  attempted && promptMissing && 'pr-6'
                )}
                value={value.prompt}
                onChange={(event) => setValue({ ...value, prompt: event.target.value })}
              />
              {attempted && promptMissing ? (
                // Floats in the corner so it never narrows the text.
                <FieldIssueMark
                  className="absolute right-3 top-3"
                  messages={[t('schedules.requirePrompt', 'Describe what the Agent should do.')]}
                />
              ) : null}
            </div>
            {agentBar ? (
              // The composer face: the same controls and the same container
              // query that drops their labels in a narrow panel.
              <div className="@container/composer-face flex flex-wrap items-center gap-x-1.5 px-1.5 pb-1.5">
                {agentBar({ revealMissing: attempted })}
              </div>
            ) : null}
          </div>
          {contextBar ? (
            <div className="flex flex-wrap items-center gap-1 px-1">
              {contextBar({ revealMissing: attempted })}
            </div>
          ) : null}
          {contextNote ? (
            <p className="px-1.5 text-[0.8em] leading-snug text-muted-foreground">{contextNote}</p>
          ) : null}
        </div>

        {/* One card for how it runs: where each run goes, then when. Timed or
            manual is just another row in it, not a section of its own. */}
        <div {...scheduleCardProps()}>
          {destination?.({ revealMissing: attempted })}
          <PropertyRow label={t('schedules.trigger.label', 'Trigger')}>
            <Tabs.Root
              value={mode}
              onValueChange={(next) => {
                if (next === 'timed' || next === 'manual') setMode(next);
              }}
            >
              <Tabs.List size="small">
                <Tabs.Tab value="timed">{t('schedules.trigger.timed', 'On a schedule')}</Tabs.Tab>
                <Tabs.Tab value="manual">{t('schedules.trigger.manual', 'Manual')}</Tabs.Tab>
              </Tabs.List>
            </Tabs.Root>
          </PropertyRow>
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
        </div>

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
            variant="primary"
            size="small"
            className="shrink-0 self-end sm:self-auto"
            disabled={saving || formIssues.length > 0}
            aria-describedby={noteId}
          >
            {saving ? t('schedules.saving', 'Saving…') : t('schedules.save', 'Save schedule')}
          </Button>
        </div>
      </form>
    </Tooltip.Provider>
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
