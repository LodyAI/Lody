import { space } from '@lody/ui/tokens/scales.stylex';
import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { Dialog } from '@/ui/dialog';
import { getServerNow, instantToZonedLocalInput, zonedLocalInputToInstant } from '@lody/shared';
import { formatInstant } from './schedule-format';

const styles = stylex.create({
  fields: { display: 'flex', flexDirection: 'column', gap: space[3] },
  shortcuts: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
  popover: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space[2],
    padding: space[3],
  },
  hint: { color: colors.secondaryLabel, fontSize: '0.85em', margin: 0 },
  error: { color: colors.label, fontSize: '0.85em', margin: 0 },
});

export function ScheduledMessageTimeFields({
  at,
  onChange,
  timeZone,
  disabled = false,
  now = getServerNow(),
}: {
  at: string | null;
  onChange: (at: string) => void;
  timeZone: string;
  disabled?: boolean;
  now?: number;
}) {
  const { t, i18n } = useTranslation();
  const [typed, setTyped] = useState<string | null>(null);
  const local = typed ?? instantToZonedLocalInput(at ? Date.parse(at) : now + 3600_000, timeZone);
  const choose = (ms: number) => {
    setTyped(null);
    onChange(new Date(ms).toISOString());
  };
  const invalid = !at || Date.parse(at) <= now || !Number.isFinite(Date.parse(at));
  return (
    <div {...stylex.props(styles.fields)}>
      <div {...stylex.props(styles.shortcuts)}>
        <Button
          variant="secondary"
          size="small"
          disabled={disabled}
          onClick={() => choose(now + 1800_000)}
        >
          {t('scheduledMessage.in30Minutes')}
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={disabled}
          onClick={() => choose(now + 3600_000)}
        >
          {t('scheduledMessage.inOneHour')}
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={disabled}
          onClick={() => choose(now + 5 * 3600_000)}
        >
          {t('scheduledMessage.inFiveHours')}
        </Button>
      </div>
      <label {...stylex.props(styles.fields)}>
        {t('scheduledMessage.dateAndTime')}
        <Input
          type="datetime-local"
          className="[&::-webkit-calendar-picker-indicator]:hidden"
          value={local}
          disabled={disabled}
          aria-invalid={invalid}
          onBlur={() => {
            if (at && Number.isFinite(Date.parse(at))) setTyped(null);
          }}
          onChange={(event) => {
            setTyped(event.target.value);
            const instant = zonedLocalInputToInstant(event.target.value, timeZone);
            onChange(instant === null ? '' : new Date(instant).toISOString());
          }}
        />
      </label>
      <p {...stylex.props(styles.hint)}>
        {timeZone}
        {at && !invalid ? ` · ${formatInstant(Date.parse(at), timeZone, i18n.language)}` : ''}
      </p>
      {invalid ? (
        <p role="alert" {...stylex.props(styles.error)}>
          {t('scheduledMessage.futureTime')}
        </p>
      ) : null}
      <p {...stylex.props(styles.hint)}>{t('scheduledMessage.machineHint')}</p>
    </div>
  );
}

export function ScheduledMessageTimeDialog({
  at,
  timeZone,
  onApply,
  onClose,
  finalFocus,
  onRemoveTime,
  now = getServerNow(),
}: {
  at: string | null;
  timeZone: string;
  onApply: (at: string) => void;
  onClose: () => void;
  finalFocus?: RefObject<HTMLTextAreaElement | null> | false;
  onRemoveTime?: () => void;
  now?: number;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(at ?? new Date(now + 3600_000).toISOString());
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content width={380} finalFocus={finalFocus}>
        <Dialog.Header>
          <Dialog.Title>{t('scheduledMessage.title')}</Dialog.Title>
        </Dialog.Header>
        <ScheduledMessageTimeFields at={value} timeZone={timeZone} onChange={setValue} now={now} />
        <Dialog.Footer>
          {onRemoveTime ? (
            <Button variant="ghost" onClick={onRemoveTime}>
              {t('scheduledMessage.removeTime')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!Number.isFinite(Date.parse(value)) || Date.parse(value) <= now}
            onClick={() => onApply(value)}
          >
            {t('scheduledMessage.apply')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
