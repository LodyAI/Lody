import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Rocket } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { Dialog } from '@lody/ui/dialog';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type { SessionAutoDelivery } from '@lody/shared';
import type { AutoDeliverOptions } from '@lody/shared/automations';

/** Fix CI and conflicts on, merge off: merging stays the user's explicit choice. */
export const DEFAULT_AUTO_DELIVER_OPTIONS: AutoDeliverOptions = {
  fixCi: true,
  resolveConflicts: true,
  merge: false,
};

const OPTION_ROWS = [
  { key: 'fixCi', labelKey: 'sessions.autoDelivery.option.fixCi', label: '自动修复 CI' },
  {
    key: 'resolveConflicts',
    labelKey: 'sessions.autoDelivery.option.resolveConflicts',
    label: '自动解决冲突',
  },
  { key: 'merge', labelKey: 'sessions.autoDelivery.option.merge', label: 'CI 通过后合入' },
] as const satisfies ReadonlyArray<{
  key: keyof AutoDeliverOptions;
  labelKey: string;
  label: string;
}>;

const styles = stylex.create({
  options: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
  },
  note: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingBlock: space[1.5],
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  noteIcon: {
    flexShrink: 0,
    color: colors.tertiaryLabel,
  },
  noteText: {
    minWidth: 0,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  stalled: {
    color: colors.warning,
  },
});

/** The three steps a user can hand to Auto delivery. */
export function AutoDeliveryOptionsFields({
  value,
  onChange,
  disabled,
}: {
  value: AutoDeliverOptions;
  onChange: (value: AutoDeliverOptions) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.options)}>
      {OPTION_ROWS.map((row) => (
        <label key={row.key} {...stylex.props(styles.option)} data-auto-delivery-option={row.key}>
          <Checkbox
            checked={value[row.key]}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ ...value, [row.key]: checked === true })}
          />
          {t(row.labelKey, row.label)}
        </label>
      ))}
    </div>
  );
}

/** Opened from the Info Bar: choose the steps, then start. */
export function AutoDeliveryDialog({
  open,
  onOpenChange,
  onStart,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (options: AutoDeliverOptions) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const [options, setOptions] = useState(DEFAULT_AUTO_DELIVER_OPTIONS);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content width="24rem">
        <Dialog.Header>
          <Dialog.Title>{t('sessions.autoDelivery.title', '自动交付')}</Dialog.Title>
          <Dialog.Description>
            {t(
              'sessions.autoDelivery.description',
              'Lody 会在需要时让 agent 开 PR、修 CI、解冲突，并按你的选择合入。只对这个会话当前的 PR 生效，合入后自动关闭。'
            )}
          </Dialog.Description>
        </Dialog.Header>
        <AutoDeliveryOptionsFields value={options} onChange={setOptions} disabled={busy} />
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost" />}>
            {t('common.cancel', 'Cancel')}
          </Dialog.Close>
          <Button disabled={busy} onClick={() => onStart(options)}>
            {t('sessions.autoDelivery.start', '开始')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export function autoDeliveryStatusLabel(status: SessionAutoDelivery, t: TFunction): string {
  switch (status.state) {
    case 'pr':
      return t('sessions.autoDelivery.state.pr', '等待创建 PR');
    case 'ci':
      return t('sessions.autoDelivery.state.ci', '等待 CI');
    case 'fix':
      return t('sessions.autoDelivery.state.fix', {
        defaultValue: '修复 CI 中（第 {{attempt}} 次）',
        attempt: status.attempt ?? 1,
      });
    case 'conflict':
      return t('sessions.autoDelivery.state.conflict', {
        defaultValue: '解决冲突中（第 {{attempt}} 次）',
        attempt: status.attempt ?? 1,
      });
    case 'merge':
      return t('sessions.autoDelivery.state.merge', '合入中');
    case 'ready':
      return t('sessions.autoDelivery.state.ready', 'CI 已通过，等你合入');
    case 'merged':
      return t('sessions.autoDelivery.state.merged', '已合入');
    case 'stalled':
      return t('sessions.autoDelivery.state.stalled', {
        defaultValue: '停住了，等你：{{reason}}',
        reason: t(`sessions.autoDelivery.reason.${status.reason ?? 'request_failed'}`, {
          defaultValue: status.reason ?? '',
        }),
      });
  }
}

/** A quiet in-conversation line while Auto delivery is on, with a way to turn it off. */
export function SessionAutoDeliveryNote({
  status,
  onTurnOff,
  busy,
}: {
  status: SessionAutoDelivery;
  onTurnOff?: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const stalled = status.state === 'stalled';
  return (
    <div
      {...stylex.props(styles.note, stalled && styles.stalled)}
      data-auto-delivery-state={status.state}
      role="status"
    >
      <Rocket size={14} strokeWidth={1.8} {...stylex.props(styles.noteIcon)} aria-hidden="true" />
      <span {...stylex.props(styles.noteText)}>
        {t('sessions.autoDelivery.title', '自动交付')} · {autoDeliveryStatusLabel(status, t)}
      </span>
      {onTurnOff && status.state !== 'merged' ? (
        <Button size="small" variant="ghost" disabled={busy} onClick={onTurnOff}>
          {t('sessions.autoDelivery.turnOff', '关闭')}
        </Button>
      ) : null}
    </div>
  );
}
