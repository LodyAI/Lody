import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Timer } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Dialog } from '@/ui/dialog';
import { formatSnoozeCountdown } from '@/lib/sidebar-status-group';
import { cn } from '@/lib/utils';

export type CustomSnoozeDialogTarget = {
  sessionId: string;
  title: string;
};

function toLocalDateTimeInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultCustomSnoozeMs(now: Date): number {
  const target = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  target.setSeconds(0, 0);
  const rem = target.getMinutes() % 15;
  if (rem !== 0) target.setMinutes(target.getMinutes() + (15 - rem));
  return target.getTime();
}

export function CustomSnoozeDialog({
  target,
  now,
  onClose,
  onConfirm,
}: {
  target: CustomSnoozeDialogTarget | null;
  now: Date;
  onClose: () => void;
  onConfirm: (sessionId: string, snoozedUntil: number) => void;
}) {
  const { t } = useTranslation();
  const safeNow = now instanceof Date ? now : new Date();
  const [openFor, setOpenFor] = useState<CustomSnoozeDialogTarget | null>(null);
  const [value, setValue] = useState(() =>
    toLocalDateTimeInputValue(defaultCustomSnoozeMs(safeNow))
  );

  if (target !== openFor) {
    setOpenFor(target);
    if (target) {
      setValue(toLocalDateTimeInputValue(defaultCustomSnoozeMs(safeNow)));
    }
  }

  const nowMs = safeNow.getTime();
  const parsedMs = useMemo(() => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }, [value]);

  const isValid = parsedMs !== null && parsedMs > nowMs;
  const previewCountdown = isValid ? formatSnoozeCountdown(parsedMs, nowMs) : null;

  const quickOffsets = useMemo(
    () => [
      { label: t('sidebar.status.snooze.quick1h', '1h'), ms: nowMs + 60 * 60 * 1000 },
      { label: t('sidebar.status.snooze.quick4h', '4h'), ms: nowMs + 4 * 60 * 60 * 1000 },
      { label: t('sidebar.status.snooze.quick2d', '2d'), ms: nowMs + 2 * 24 * 60 * 60 * 1000 },
      { label: t('sidebar.status.snooze.quick1w', '1w'), ms: nowMs + 7 * 24 * 60 * 60 * 1000 },
    ],
    [nowMs, t]
  );

  const handleSubmit = () => {
    if (!target || !isValid || parsedMs === null) return;
    onConfirm(target.sessionId, parsedMs);
    onClose();
  };

  return (
    <Dialog.Root
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content className="max-w-sm gap-0 overflow-hidden p-0 sm:p-0">
        <Dialog.Header className="border-b border-border/70 px-4 py-4 pr-12 text-left sm:px-5 sm:pr-12">
          <Dialog.Title className="text-base">
            {t('sidebar.status.snooze.customTitle', 'Snooze until…')}
          </Dialog.Title>
          {target?.title ? (
            <Dialog.Description className="truncate text-xs text-muted-foreground">
              {target.title}
            </Dialog.Description>
          ) : null}
        </Dialog.Header>

        <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center gap-1.5">
            {quickOffsets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-xs font-medium tabular-nums text-foreground/85 transition-colors',
                  'hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40'
                )}
                onClick={() => setValue(toLocalDateTimeInputValue(preset.ms))}
              >
                <Timer className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                <span>{preset.label}</span>
              </button>
            ))}
          </div>

          <Input
            type="datetime-local"
            value={value}
            min={toLocalDateTimeInputValue(nowMs + 60_000)}
            aria-label={t('sidebar.status.snooze.pickDateTime', 'Return to Focus at')}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSubmit();
              }
            }}
          />

          {previewCountdown ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Timer className="h-3.5 w-3.5 text-amber-500/80 dark:text-amber-400/80" />
              <span>
                {t('sidebar.status.snooze.returnsIn', 'Returns to Focus in {{countdown}}', {
                  countdown: previewCountdown,
                })}
              </span>
            </div>
          ) : (
            <div className="text-xs text-destructive">
              {t('sidebar.status.snooze.mustBeFuture', 'Choose a time in the future.')}
            </div>
          )}
        </div>

        <Dialog.Footer className="border-t border-border/70 bg-muted/30 px-4 py-3 sm:px-5">
          <Button variant="secondary" size="small" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button size="small" onClick={handleSubmit} disabled={!isValid}>
            {t('sidebar.status.snooze.confirm', 'Snooze')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
