import { colors as uiColors } from '@lody/ui/tokens/colors.stylex';
import { text as uiText } from '@lody/ui/tokens/scales.stylex';
import { themeSpace as appSpace } from '../style/theme-scale.stylex';
import * as stylex from '@stylexjs/stylex';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Timer } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Dialog } from '@/ui/dialog';
import { formatSnoozeCountdown } from '@lody/shared';

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
      <Dialog.Content xstyle={themeStyles.glyph}>
        <Dialog.Header xstyle={themeStyles.copy}>
          <Dialog.Title>
            {t('sidebar.status.snooze.customTitle', 'Snooze until…')}
          </Dialog.Title>
          {target?.title ? (
            <Dialog.Description xstyle={themeStyles.hint}>
              {target.title}
            </Dialog.Description>
          ) : null}
        </Dialog.Header>

        <div {...stylex.props(themeStyles.column)}>
          <div {...stylex.props(themeStyles.row)}>
            {quickOffsets.map((preset) => (
              <Button
                key={preset.label}
                type="button" variant="secondary" size="small"
                onClick={() => setValue(toLocalDateTimeInputValue(preset.ms))}
              >
                <Timer {...stylex.props(themeStyles.hint2)} aria-hidden="true" />
                <span>{preset.label}</span>
              </Button>
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
            <div {...stylex.props(themeStyles.row2)}>
              <Timer {...stylex.props(themeStyles.copy3)} />
              <span>
                {t('sidebar.status.snooze.returnsIn', 'Returns to Focus in {{countdown}}', {
                  countdown: previewCountdown,
                })}
              </span>
            </div>
          ) : (
            <div {...stylex.props(themeStyles.copy4)}>
              {t('sidebar.status.snooze.mustBeFuture', 'Choose a time in the future.')}
            </div>
          )}
        </div>

        <Dialog.Footer xstyle={themeStyles.panel}>
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

const themeStyles = stylex.create({
  glyph: { maxWidth: '24rem', gap: 0, overflow: 'hidden', padding: { 'default': 0, '@media (min-width: 640px)': 0 } },
  copy: { paddingInline: { 'default': appSpace[4], '@media (min-width: 640px)': appSpace[5] }, paddingBlock: appSpace[4], paddingRight: { 'default': appSpace[12], '@media (min-width: 640px)': appSpace[12] }, textAlign: 'start' },
  copy2: { fontSize: uiText.bodySize, lineHeight: uiText.bodyLeading },
  hint: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: uiText.footnoteSize, lineHeight: uiText.footnoteLeading, color: uiColors.secondaryLabel },
  column: { display: 'flex', flexDirection: 'column', gap: appSpace[3], paddingInline: { 'default': appSpace[4], '@media (min-width: 640px)': appSpace[5] }, paddingBlock: appSpace[4] },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: appSpace[1.5] },
  hint2: { height: appSpace[3], width: appSpace[3], color: uiColors.secondaryLabel },
  row2: { display: 'flex', alignItems: 'center', gap: appSpace[1.5], fontSize: uiText.footnoteSize, lineHeight: uiText.footnoteLeading, color: uiColors.secondaryLabel },
  copy3: { height: appSpace[3.5], width: appSpace[3.5], color: uiColors.warning },
  copy4: { fontSize: uiText.footnoteSize, lineHeight: uiText.footnoteLeading, color: uiColors.destructive },
  panel: { backgroundColor: uiColors.secondaryBackground, paddingInline: { 'default': appSpace[4], '@media (min-width: 640px)': appSpace[5] }, paddingBlock: appSpace[3] },
});
