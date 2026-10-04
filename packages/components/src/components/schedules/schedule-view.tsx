import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
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
import { formatUpcoming, triggerTimeZone } from './schedule-format';
import { PropertyRow, scheduleCardProps } from './schedule-property-row';
import { FieldIssueMark } from './schedule-field-issue-mark';
import type { ScheduleSaveIssue } from './schedule-save-blockers';
import { ScheduleRecurrenceEditor } from './schedule-recurrence-editor';

const WIDE = '@media (min-width: 40rem)';
const DARK =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';
const COLOR_MIX = '@supports (color: color-mix(in lab, red, red))';

const styles = stylex.create({
  form: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 5)',
    width: '100%',
    maxWidth: '42rem',
    marginInline: 'auto',
    paddingInline: { default: 'calc(var(--spacing) * 4)', [WIDE]: 'calc(var(--spacing) * 6)' },
    paddingBlock: 'calc(var(--spacing) * 5)',
  },
  composer: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 2)',
  },
  composerBox: {
    display: 'flex',
    flexDirection: 'column',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: 'hsl(var(--foreground) / 1)',
      [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--foreground) / 1) 8%, transparent)',
      ':focus-within': {
        default: 'hsl(var(--foreground) / 1)',
        [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--foreground) / 1) 16%, transparent)',
      },
      [DARK]: {
        default: 'color-mix(in srgb, #fff 8%, transparent)',
        [COLOR_MIX]: 'color-mix(in oklab, var(--color-white) 8%, transparent)',
        ':focus-within': {
          default: 'color-mix(in srgb, #fff 16%, transparent)',
          [COLOR_MIX]: 'color-mix(in oklab, var(--color-white) 16%, transparent)',
        },
      },
    },
    borderRadius: 'var(--radius-xl)',
    backgroundColor: {
      default: 'hsl(var(--card) / 1)',
      [DARK]: {
        default: 'hsl(var(--foreground) / 1)',
        [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--foreground) / 1) 3%, transparent)',
      },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2.5)',
  },
  titleInput: {
    minWidth: 0,
    flex: '1',
    backgroundColor: 'transparent',
    fontSize: '1.2em',
    fontWeight: 600,
    outlineStyle: { default: 'none', '@media (forced-colors: active)': 'solid' },
    outlineWidth: { default: null, '@media (forced-colors: active)': '2px' },
    outlineColor: { default: null, '@media (forced-colors: active)': 'transparent' },
    outlineOffset: { default: null, '@media (forced-colors: active)': '2px' },
    color: {
      default: 'hsl(var(--foreground) / 1)',
      '::placeholder': {
        default: 'hsl(var(--muted-foreground) / 1)',
        [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 60%, transparent)',
      },
    },
    boxShadow: {
      default: null,
      ':focus-visible':
        'var(--tw-inset-shadow, 0 0 #0000), var(--tw-inset-ring-shadow, 0 0 #0000), var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), 0 0 #0000',
    },
  },
  separator: {
    marginInline: 'calc(var(--spacing) * 3)',
    borderTopWidth: '0.5px',
    borderTopStyle: 'solid',
    borderColor: {
      default: 'hsl(var(--foreground) / 1)',
      [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--foreground) / 1) 10%, transparent)',
      [DARK]: {
        default: 'color-mix(in srgb, #fff 10%, transparent)',
        [COLOR_MIX]: 'color-mix(in oklab, var(--color-white) 10%, transparent)',
      },
    },
  },
  promptWrap: {
    position: 'relative',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingTop: 'calc(var(--spacing) * 2.5)',
    paddingBottom: 'calc(var(--spacing) * 1)',
  },
  prompt: {
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 'calc(4lh)',
    maxHeight: 'calc(6lh)',
    resize: 'none',
    overflowY: 'auto',
    backgroundColor: 'transparent',
    padding: 0,
    fontSize: '0.95em',
    lineHeight: 1.625,
    fieldSizing: 'content',
    outlineStyle: { default: 'none', '@media (forced-colors: active)': 'solid' },
    outlineWidth: { default: null, '@media (forced-colors: active)': '2px' },
    outlineColor: { default: null, '@media (forced-colors: active)': 'transparent' },
    outlineOffset: { default: null, '@media (forced-colors: active)': '2px' },
    color: {
      default: 'hsl(var(--foreground) / 1)',
      '::placeholder': {
        default: 'hsl(var(--muted-foreground) / 1)',
        [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 60%, transparent)',
      },
    },
    boxShadow: {
      default: null,
      ':focus-visible':
        'var(--tw-inset-shadow, 0 0 #0000), var(--tw-inset-ring-shadow, 0 0 #0000), var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), 0 0 #0000',
    },
  },
  promptIssueSpace: { paddingRight: 'calc(var(--spacing) * 6)' },
  promptIssue: {
    position: 'absolute',
    top: 'calc(var(--spacing) * 3)',
    right: 'calc(var(--spacing) * 3)',
  },
  agentBar: {
    containerName: 'composer-face',
    containerType: 'inline-size',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 'calc(var(--spacing) * 1.5)',
    paddingInline: 'calc(var(--spacing) * 1.5)',
    paddingBottom: 'calc(var(--spacing) * 1.5)',
  },
  contextBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    paddingInline: 'calc(var(--spacing) * 1)',
  },
  contextNote: {
    margin: 0,
    paddingInline: 'calc(var(--spacing) * 1.5)',
    fontSize: '0.8em',
    lineHeight: 1.375,
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  manualHelp: {
    display: 'flex',
    minHeight: 'calc(var(--spacing) * 11)',
    alignItems: 'center',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontSize: '0.9em',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  nextRuns: {
    display: 'flex',
    minHeight: 'calc(var(--spacing) * 11)',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 'calc(var(--spacing) * 2)',
    rowGap: 'calc(var(--spacing) * 0.5)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontSize: '0.85em',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  nextRunsWarning: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    color: 'hsl(var(--status-warning) / 1)',
  },
  nextRunsValue: { color: 'hsl(var(--foreground) / 1)' },
  footer: {
    display: 'flex',
    flexDirection: { default: 'column', [WIDE]: 'row' },
    alignItems: { default: 'normal', [WIDE]: 'center' },
    justifyContent: { default: 'normal', [WIDE]: 'space-between' },
    gap: 'calc(var(--spacing) * 2)',
    borderTopWidth: '0.5px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 1)',
    paddingTop: 'calc(var(--spacing) * 4)',
  },
  footerNote: { minWidth: 0, flex: '1', paddingInline: 'calc(var(--spacing) * 3)' },
  footerMessage: { margin: 0, fontSize: '0.85em', color: 'hsl(var(--destructive) / 1)' },
  footerIssues: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'calc(var(--spacing) * 1.5)',
    margin: 0,
    fontSize: '0.85em',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  warningIcon: {
    marginTop: 'calc(var(--spacing) * 0.5)',
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    color: 'hsl(var(--status-warning) / 1)',
  },
  upcomingIcon: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
  },
  footerHint: { margin: 0, fontSize: '0.85em', color: 'hsl(var(--muted-foreground) / 1)' },
  saveButton: { flexShrink: 0, alignSelf: { default: 'flex-end', [WIDE]: 'auto' } },
});

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
  const zone = triggerTimeZone(resolved.trigger ?? initial.trigger, timeZone);
  const noteId = useId();

  return (
    // Own the tooltip context: every problem mark explains itself in one.
    <Tooltip.Provider>
      <form
        // Light themes lift the grouped cards to the popover fill, like settings.
        data-settings-surface=""
        noValidate
        {...stylex.props(styles.form)}
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
        <div {...stylex.props(styles.composer)}>
          <div {...stylex.props(styles.composerBox)}>
            <div {...stylex.props(styles.titleRow)}>
              <input
                ref={titleRef}
                required
                maxLength={200}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- a new schedule starts at its name
                autoFocus={autoFocus}
                aria-label={t('schedules.name', 'Name')}
                aria-invalid={attempted && titleMissing ? true : undefined}
                placeholder={t('schedules.namePlaceholder', 'Name this scheduled task')}
                {...stylex.props(styles.titleInput)}
                value={value.title}
                onChange={(event) => setValue({ ...value, title: event.target.value })}
              />
              {attempted && titleMissing ? (
                <FieldIssueMark messages={[t('schedules.requireName', 'Enter a schedule name.')]} />
              ) : null}
            </div>
            <div {...stylex.props(styles.separator)} />
            <div {...stylex.props(styles.promptWrap)}>
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
                {...stylex.props(
                  styles.prompt,
                  attempted && promptMissing && styles.promptIssueSpace
                )}
                value={value.prompt}
                onChange={(event) => setValue({ ...value, prompt: event.target.value })}
              />
              {attempted && promptMissing ? (
                // Floats in the corner so it never narrows the text.
                <FieldIssueMark
                  className={stylex.props(styles.promptIssue).className}
                  messages={[t('schedules.requirePrompt', 'Describe what the Agent should do.')]}
                />
              ) : null}
            </div>
            {agentBar ? (
              // The composer face: the same controls and the same container
              // query that drops their labels in a narrow panel.
              <div {...stylex.props(styles.agentBar)}>{agentBar({ revealMissing: attempted })}</div>
            ) : null}
          </div>
          {contextBar ? (
            <div {...stylex.props(styles.contextBar)}>
              {contextBar({ revealMissing: attempted })}
            </div>
          ) : null}
          {contextNote ? <p {...stylex.props(styles.contextNote)}>{contextNote}</p> : null}
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
            <p {...stylex.props(styles.manualHelp)}>
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
              <div {...stylex.props(styles.nextRuns)} aria-live="polite" aria-atomic="true">
                {resolved.error ? (
                  <span {...stylex.props(styles.nextRunsWarning)} role="alert">
                    <AlertCircle {...stylex.props(styles.upcomingIcon)} aria-hidden="true" />
                    {resolved.error}
                  </span>
                ) : resolved.times?.length ? (
                  <>
                    <span>{t('schedules.nextRuns', 'Next runs')}</span>
                    <span {...stylex.props(styles.nextRunsValue)}>
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

        <div {...stylex.props(styles.footer)}>
          <div id={noteId} aria-live="polite" {...stylex.props(styles.footerNote)}>
            {error ? (
              <p {...stylex.props(styles.footerMessage)} role="alert">
                {error}
              </p>
            ) : formIssues.length ? (
              <p {...stylex.props(styles.footerIssues)}>
                <AlertCircle {...stylex.props(styles.warningIcon)} aria-hidden="true" />
                <span>{formIssues.map((issue) => issue.message).join(' ')}</span>
              </p>
            ) : attempted && blocked ? (
              <p {...stylex.props(styles.footerHint)}>
                {t('schedules.fixMarked', 'Fix the marked items to save.')}
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            variant="primary"
            size="small"
            {...stylex.props(styles.saveButton)}
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
