import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Check, Plus, Rocket, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Toggle } from '@lody/ui/toggle';
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
  { key: 'fixCi', labelKey: 'sessions.autoDelivery.option.fixCi', label: 'Fix CI' },
  {
    key: 'resolveConflicts',
    labelKey: 'sessions.autoDelivery.option.resolveConflicts',
    label: 'Fix conflicts',
  },
  { key: 'merge', labelKey: 'sessions.autoDelivery.option.merge', label: 'Merge' },
] as const satisfies ReadonlyArray<{
  key: keyof AutoDeliverOptions;
  labelKey: string;
  label: string;
}>;

const styles = stylex.create({
  options: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: space[1],
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
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  stalled: {
    color: colors.warning,
  },
});

/** The three steps a user can hand to Auto delivery, as one row of pills. */
export function AutoDeliveryOptionsFields({
  value,
  onChange,
  disabled,
  size = 'small',
}: {
  value: AutoDeliverOptions;
  onChange: (value: AutoDeliverOptions) => void;
  disabled?: boolean;
  /** `mini` where the pills sit under a menu row rather than in a dialog. */
  size?: 'mini' | 'small';
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.options)}>
      {OPTION_ROWS.map((row) => (
        <Toggle
          key={row.key}
          size={size}
          shape="pill"
          data-auto-delivery-option={row.key}
          pressed={value[row.key]}
          disabled={disabled}
          onPressedChange={(pressed) => onChange({ ...value, [row.key]: pressed })}
        >
          {/* The glyph says what a press does: add the step, or show it is on. */}
          {value[row.key] ? (
            <Check size={12} strokeWidth={2.25} aria-hidden="true" />
          ) : (
            <Plus size={12} strokeWidth={2.25} aria-hidden="true" />
          )}
          {t(row.labelKey, row.label)}
        </Toggle>
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
          <Dialog.Title>{t('sessions.autoDelivery.title', 'Auto delivery')}</Dialog.Title>
          <Dialog.Description>
            {t(
              'sessions.autoDelivery.description',
              'The agent keeps this PR moving. Turns off after the merge.'
            )}
          </Dialog.Description>
        </Dialog.Header>
        <AutoDeliveryOptionsFields value={options} onChange={setOptions} disabled={busy} />
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost" />}>
            {t('common.cancel', 'Cancel')}
          </Dialog.Close>
          <Button disabled={busy} onClick={() => onStart(options)}>
            {t('sessions.autoDelivery.start', 'Start')}
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

/**
 * A quiet in-conversation line while Auto delivery is on. Its action sits right after
 * the text; once the PR merged, the line can be dismissed instead.
 */
export function SessionAutoDeliveryNote({
  status,
  onTurnOff,
  onDismiss,
  busy,
}: {
  status: SessionAutoDelivery;
  onTurnOff?: () => void;
  /** Clears a finished status for every device; offered only after the merge. */
  onDismiss?: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const stalled = status.state === 'stalled';
  const merged = status.state === 'merged';
  return (
    <div
      {...stylex.props(styles.note, stalled && styles.stalled)}
      data-auto-delivery-state={status.state}
      role="status"
    >
      <Rocket size={14} strokeWidth={1.8} {...stylex.props(styles.noteIcon)} aria-hidden="true" />
      <span {...stylex.props(styles.noteText)}>
        {t('sessions.autoDelivery.title', 'Auto delivery')} · {autoDeliveryStatusLabel(status, t)}
      </span>
      {merged ? (
        onDismiss ? (
          <Button
            size="small"
            variant="ghost"
            icon
            disabled={busy}
            onClick={onDismiss}
            aria-label={t('common.dismiss', 'Dismiss')}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        ) : null
      ) : onTurnOff ? (
        <Button size="small" variant="ghost" disabled={busy} onClick={onTurnOff}>
          {t('sessions.autoDelivery.turnOff', 'Turn off')}
        </Button>
      ) : null}
    </div>
  );
}
