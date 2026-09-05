import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock3, Pause, Play, Plus, ShieldAlert } from 'lucide-react';
import {
  getServerNow,
  previewSchedule,
  validateScheduleTrigger,
  type ScheduleRegistryRow,
  type ScheduleRuntimeRow,
  type ScheduleTrigger,
} from '@lody/shared';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';

export function matchingScheduleRuntime(row: ScheduleRegistryRow, runtimes: ScheduleRuntimeRow[]) {
  return runtimes.find(
    (runtime) =>
      runtime.scheduleId === row.scheduleId &&
      runtime.machineId === row.machineId &&
      runtime.activationId === row.activationId &&
      runtime.observedDefinitionFingerprint === row.definitionFingerprint
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
}: {
  rows: ScheduleRegistryRow[];
  runtimes: ScheduleRuntimeRow[];
  ready: boolean;
  error?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onToggle?: (row: ScheduleRegistryRow) => void;
  contextForRow?: (row: ScheduleRegistryRow) => {
    machine: string;
    agent: string;
    project: string;
    presence: 'online' | 'offline' | 'unknown';
    canToggle: boolean;
  };
  onOpenSession?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const filtered = rows.filter((row) => row.title.toLowerCase().includes(query.toLowerCase()));
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b px-5 py-4">
        <Clock3 className="size-4" />
        <h1 className="flex-1 font-medium">{t('schedules.title', 'Schedules')}</h1>
        <Button size="sm" onClick={onNew}>
          <Plus className="size-4" />
          {t('schedules.new', 'New schedule')}
        </Button>
      </header>
      <div className="px-5 py-3">
        <Input
          aria-label={t('schedules.search', 'Search schedules')}
          placeholder={t('schedules.search', 'Search schedules')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5">
        {!ready ? (
          <p className="py-8 text-sm text-muted-foreground">
            {t('schedules.loading', 'Loading schedules…')}
          </p>
        ) : error ? (
          <p role="alert">{t('schedules.loadError', 'Schedules could not be loaded.')}</p>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center">
            <p>{t('schedules.empty', 'No schedules yet')}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                'schedules.emptyHelp',
                'Choose a prompt and a time. Your machine will start a new chat for each run.'
              )}
            </p>
          </div>
        ) : (
          filtered.map((row) => {
            const runtime = matchingScheduleRuntime(row, runtimes);
            const context = contextForRow?.(row);
            return (
              <div key={row.scheduleId} className="flex min-h-14 items-center gap-3 border-b py-2">
                <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(row.scheduleId)}>
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{row.title}</span>
                    {row.elevatedPermissions ? (
                      <ShieldAlert
                        className="size-4 shrink-0 text-status-warning"
                        aria-label={t('schedules.elevated', 'Elevated permissions')}
                      />
                    ) : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {!row.enabled
                      ? t('schedules.paused', 'Paused')
                      : runtime?.queueState
                        ? t(`schedules.state.${runtime.queueState}`, runtime.queueState)
                        : t('schedules.enabled', 'Enabled')}
                    {' · '}
                    {t(
                      `schedules.presence.${context?.presence ?? 'unknown'}`,
                      context?.presence ?? 'unknown'
                    )}
                    {row.enabled ? (
                      <>
                        {' '}
                        ·{' '}
                        {runtime?.nextScheduledAt != null
                          ? t('schedules.nextAt', 'Next: {{time}}', {
                              time:
                                new Date(runtime.nextScheduledAt).toLocaleString(undefined, {
                                  timeZone:
                                    row.trigger.kind === 'cron' ? row.trigger.timeZone : undefined,
                                }) +
                                ' ' +
                                (row.trigger.kind === 'cron'
                                  ? row.trigger.timeZone
                                  : Intl.DateTimeFormat().resolvedOptions().timeZone),
                            })
                          : t(
                              'schedules.awaitingMachine',
                              'Waiting for the machine to check the schedule'
                            )}
                      </>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {context?.machine ?? row.machineId} · {context?.agent ?? row.agentConfigId} ·{' '}
                    {context?.project ?? row.projectKey}
                  </span>
                </button>
                {runtime?.lastDispatch && onOpenSession ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenSession(runtime.lastDispatch!.sessionId)}
                  >
                    {t('schedules.lastRun', 'Last run')}
                  </Button>
                ) : null}
                {onToggle && context?.canToggle !== false ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onToggle(row)}
                    aria-label={
                      row.enabled ? t('schedules.pause', 'Pause') : t('schedules.resume', 'Resume')
                    }
                  >
                    {row.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                  </Button>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

export type ScheduleFormValue = {
  title: string;
  prompt: string;
  trigger: ScheduleTrigger;
  misfire: 'skip' | 'run_once';
  overlap: 'skip' | 'queue_one';
};
const localInput = (value: string): string => {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function ScheduleForm({
  initial,
  selectors,
  disabled,
  saving,
  error,
  onSave,
}: {
  initial: ScheduleFormValue;
  selectors: ReactNode;
  disabled?: boolean;
  saving: boolean;
  error?: string;
  onSave: (value: ScheduleFormValue) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const [consent, setConsent] = useState(false);
  const preview = useMemo(() => {
    try {
      return { times: previewSchedule(validateScheduleTrigger(value.trigger), 0, getServerNow()) };
    } catch {
      return { times: [], error: t('schedules.invalidTime', 'Check the time rule and time zone.') };
    }
  }, [value.trigger, t]);
  const trigger = value.trigger;
  const previewZone =
    trigger.kind === 'cron' ? trigger.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fieldClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';
  return (
    <form
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (consent && !preview.error) onSave(value);
      }}
    >
      <label className="space-y-2 text-sm">
        {t('schedules.name', 'Name')}
        <Input
          required
          maxLength={200}
          value={value.title}
          onChange={(e) => setValue({ ...value, title: e.target.value })}
        />
      </label>
      <label className="space-y-2 text-sm">
        {t('schedules.prompt', 'What should the Agent do?')}
        <Textarea
          required
          rows={6}
          value={value.prompt}
          onChange={(e) => setValue({ ...value, prompt: e.target.value })}
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm">
          {t('schedules.frequency', 'Frequency')}
          <select
            className={fieldClass}
            value={trigger.kind}
            onChange={(e) => {
              const kind = e.target.value;
              setValue({
                ...value,
                trigger:
                  kind === 'cron'
                    ? {
                        kind,
                        expression: '0 9 * * *',
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                      }
                    : kind === 'once'
                      ? { kind, at: new Date(getServerNow() + 3_600_000).toISOString() }
                      : {
                          kind: 'interval',
                          everyMs: 3_600_000,
                          anchorAt: new Date(getServerNow()).toISOString(),
                        },
              });
            }}
          >
            <option value="once">{t('schedules.once', 'Once')}</option>
            <option value="interval">{t('schedules.interval', 'Every interval')}</option>
            <option value="cron">{t('schedules.cron', 'Cron')}</option>
          </select>
        </label>
        {trigger.kind === 'interval' ? (
          <label className="space-y-2 text-sm">
            {t('schedules.minutes', 'Interval in minutes')}
            <Input
              type="number"
              min={1}
              step={1}
              required
              value={trigger.everyMs / 60_000}
              onChange={(e) =>
                setValue({
                  ...value,
                  trigger: { ...trigger, everyMs: Number(e.target.value) * 60_000 },
                })
              }
            />
          </label>
        ) : null}
        {trigger.kind === 'cron' ? (
          <>
            <label className="space-y-2 text-sm">
              {t('schedules.expression', 'Five-field cron expression')}
              <Input
                required
                value={trigger.expression}
                onChange={(e) =>
                  setValue({ ...value, trigger: { ...trigger, expression: e.target.value } })
                }
              />
            </label>
            <label className="space-y-2 text-sm">
              {t('schedules.timeZone', 'Time zone')}
              <Input
                required
                placeholder="Asia/Shanghai"
                value={trigger.timeZone}
                onChange={(e) =>
                  setValue({ ...value, trigger: { ...trigger, timeZone: e.target.value } })
                }
              />
            </label>
          </>
        ) : (
          <label className="space-y-2 text-sm">
            {t('schedules.startLocal', 'Start time (this device’s time zone)')}
            <Input
              type="datetime-local"
              required
              value={localInput(trigger.kind === 'once' ? trigger.at : trigger.anchorAt)}
              onChange={(e) => {
                if (!e.target.value) return;
                const at = new Date(e.target.value).toISOString();
                setValue({
                  ...value,
                  trigger:
                    trigger.kind === 'once' ? { ...trigger, at } : { ...trigger, anchorAt: at },
                });
              }}
            />
          </label>
        )}
      </div>
      <div className="text-sm">
        <p className="mb-2 font-medium">
          {t('schedules.preview', 'Next planned runs')} · {previewZone}
        </p>
        {preview.error ? (
          <p role="alert">{preview.error}</p>
        ) : preview.times.length ? (
          <ol className="space-y-1 text-muted-foreground">
            {preview.times.map((at) => (
              <li key={at}>{new Date(at).toLocaleString(undefined, { timeZone: previewZone })}</li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">
            {t('schedules.noFuture', 'No future run under this rule.')}
          </p>
        )}
      </div>
      {selectors}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm">
          {t('schedules.misfire', 'When the machine misses a run')}
          <select
            className={fieldClass}
            value={value.misfire}
            onChange={(e) =>
              setValue({ ...value, misfire: e.target.value as ScheduleFormValue['misfire'] })
            }
          >
            <option value="skip">{t('schedules.skipMissed', 'Skip old runs')}</option>
            <option value="run_once">
              {t('schedules.runLatest', 'Run the latest missed time once')}
            </option>
          </select>
        </label>
        <label className="space-y-2 text-sm">
          {t('schedules.overlap', 'When a previous run is still active')}
          <select
            className={fieldClass}
            value={value.overlap}
            onChange={(e) =>
              setValue({ ...value, overlap: e.target.value as ScheduleFormValue['overlap'] })
            }
          >
            <option value="skip">{t('schedules.skipOverlap', 'Skip the new run')}</option>
            <option value="queue_one">
              {t('schedules.queueLatest', 'Keep only the latest waiting run')}
            </option>
          </select>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'schedules.machineHelp',
          'The selected machine must be awake and its Lody daemon running. Saving or pausing takes effect on other devices after they sync.'
        )}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          className="mt-1"
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        {t(
          'schedules.consent',
          'Allow this prompt to run automatically with the selected Agent, Project and permission mode.'
        )}
      </label>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={disabled || saving || !consent || !!preview.error}>
        {saving ? t('schedules.saving', 'Saving…') : t('schedules.save', 'Save schedule')}
      </Button>
    </form>
  );
}
