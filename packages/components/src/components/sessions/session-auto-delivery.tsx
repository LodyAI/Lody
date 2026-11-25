import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  GitMerge,
  GitPullRequestArrow,
  Plus,
  Rocket,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Toggle } from '@lody/ui/toggle';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type { SessionAutoDelivery } from '@lody/shared';
import type { AutoDeliverMergeMethod, AutoDeliverOptions } from '@lody/shared/automations';
import { formatLocalizedRelativeTime } from '@/lib/format-relative-time';
import {
  SessionAutomationNoteFooterSpacer,
  SessionAutomationNoteNudge,
  SessionAutomationNoteRow,
  SessionAutomationNoteShell,
  SessionAutomationTweakRow,
} from './session-continuation-note';
import type { SessionContinuationTone } from './session-continuation';

/** Fix CI, resolve conflicts, and merge on by default (using repository default merge method). */
export const DEFAULT_AUTO_DELIVER_OPTIONS: AutoDeliverOptions = {
  fixCi: true,
  resolveConflicts: true,
  merge: true,
  mergeMethod: 'auto',
};

const OPTION_ROWS = [
  {
    key: 'fixCi',
    icon: Wrench,
    labelKey: 'sessions.autoDelivery.option.fixCi',
    label: 'Fix CI',
  },
  {
    key: 'resolveConflicts',
    icon: GitMerge,
    labelKey: 'sessions.autoDelivery.option.resolveConflicts',
    label: 'Fix conflicts',
  },
  {
    key: 'merge',
    icon: GitPullRequestArrow,
    labelKey: 'sessions.autoDelivery.option.merge',
    label: 'Merge',
  },
] as const satisfies ReadonlyArray<{
  key: 'fixCi' | 'resolveConflicts' | 'merge';
  icon: LucideIcon;
  labelKey: string;
  label: string;
}>;

const MERGE_METHODS = [
  { value: 'auto', labelKey: 'sessions.autoDelivery.mergeMethod.auto', label: 'Default' },
  { value: 'squash', labelKey: 'sessions.autoDelivery.mergeMethod.squash', label: 'Squash' },
  { value: 'merge', labelKey: 'sessions.autoDelivery.mergeMethod.merge', label: 'Merge' },
  { value: 'rebase', labelKey: 'sessions.autoDelivery.mergeMethod.rebase', label: 'Rebase' },
] as const satisfies ReadonlyArray<{
  value: AutoDeliverMergeMethod;
  labelKey: string;
  label: string;
}>;

const styles = stylex.create({
  optionsStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
  },
  options: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: space[1],
  },
  subRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
  },
  subRowIndented: {
    paddingInlineStart: 34,
    paddingBottom: space[1],
  },
  subLabel: {
    color: colors.tertiaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
  dialogRows: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  dialogPrSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    paddingTop: space[1],
  },
  popoverSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
  },
});

function MergeMethodSelector({
  value,
  onChange,
  disabled,
  size = 'mini',
  indented = false,
}: {
  value: AutoDeliverMergeMethod;
  onChange: (method: AutoDeliverMergeMethod) => void;
  disabled?: boolean;
  size?: 'mini' | 'small';
  indented?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.subRow, indented && styles.subRowIndented)}>
      <span {...stylex.props(styles.subLabel)}>
        {t('sessions.autoDelivery.mergeMethod.label', 'Merge method')}
      </span>
      <div {...stylex.props(styles.options)}>
        {MERGE_METHODS.map((method) => (
          <Toggle
            key={method.value}
            size={size}
            shape="pill"
            data-auto-delivery-merge-method={method.value}
            pressed={value === method.value}
            disabled={disabled}
            onPressedChange={(pressed) => {
              if (pressed) onChange(method.value);
            }}
          >
            {t(method.labelKey, method.label)}
          </Toggle>
        ))}
      </div>
    </div>
  );
}

/** The steps and optional merge method a user hands to Auto delivery. */
export function AutoDeliveryOptionsFields({
  value,
  onChange,
  disabled,
  size = 'small',
}: {
  value: AutoDeliverOptions;
  onChange: (value: AutoDeliverOptions) => void;
  disabled?: boolean;
  /** `mini` where the pills sit under a menu row or inside a popover. */
  size?: 'mini' | 'small';
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.optionsStack)}>
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
            {value[row.key] ? (
              <Check size={12} strokeWidth={2.25} aria-hidden="true" />
            ) : (
              <Plus size={12} strokeWidth={2.25} aria-hidden="true" />
            )}
            {t(row.labelKey, row.label)}
          </Toggle>
        ))}
      </div>
      {value.merge ? (
        <MergeMethodSelector
          size="mini"
          value={value.mergeMethod ?? 'auto'}
          disabled={disabled}
          onChange={(mergeMethod) => onChange({ ...value, mergeMethod })}
        />
      ) : null}
    </div>
  );
}

export type AutoDeliveryPullRequestChoice = {
  url: string;
  label: string;
};

/** Opened from the Info Bar: choose steps, merge method, and optional target PRs. */
export function AutoDeliveryDialog({
  open,
  onOpenChange,
  onStart,
  openPullRequests,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (options: AutoDeliverOptions) => void | Promise<boolean | void>;
  openPullRequests?: readonly AutoDeliveryPullRequestChoice[];
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const [options, setOptions] = useState(DEFAULT_AUTO_DELIVER_OPTIONS);
  const [selectedPrUrls, setSelectedPrUrls] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const disabled = busy || submitting;

  const multiPr = (openPullRequests?.length ?? 0) > 1;
  const activePrUrls = multiPr
    ? (selectedPrUrls ?? openPullRequests!.map((pr) => pr.url))
    : undefined;
  const canStart = !disabled && (!multiPr || (activePrUrls?.length ?? 0) > 0);

  const togglePr = (url: string, pressed: boolean) => {
    const base = activePrUrls ?? [];
    const next = pressed
      ? base.includes(url)
        ? base
        : [...base, url]
      : base.filter((item) => item !== url);
    setSelectedPrUrls(next);
  };

  const handleStart = async () => {
    setSubmitting(true);
    try {
      const payload: AutoDeliverOptions =
        multiPr && activePrUrls && activePrUrls.length < openPullRequests!.length
          ? { ...options, prUrls: activePrUrls }
          : options;
      const ok = await onStart(payload);
      if (ok !== false) onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

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
        <div {...stylex.props(styles.dialogRows)}>
          {OPTION_ROWS.map((row) => (
            <div key={row.key}>
              <SessionAutomationTweakRow
                icon={row.icon}
                title={t(row.labelKey, row.label)}
                checked={options[row.key]}
                disabled={disabled}
                onCheckedChange={(checked) => setOptions({ ...options, [row.key]: checked })}
                dataAttributes={{ 'data-auto-delivery-option': row.key }}
              />
              {row.key === 'merge' && options.merge ? (
                <MergeMethodSelector
                  indented
                  size="mini"
                  value={options.mergeMethod ?? 'auto'}
                  disabled={disabled}
                  onChange={(mergeMethod) => setOptions({ ...options, mergeMethod })}
                />
              ) : null}
            </div>
          ))}
          {multiPr && openPullRequests ? (
            <div {...stylex.props(styles.dialogPrSection)}>
              <span {...stylex.props(styles.subLabel)}>
                {t('sessions.autoDelivery.targetPrs', 'Pull requests')}
              </span>
              <div {...stylex.props(styles.options)}>
                {openPullRequests.map((pr) => {
                  const pressed = activePrUrls?.includes(pr.url) ?? true;
                  return (
                    <Toggle
                      key={pr.url}
                      size="mini"
                      shape="pill"
                      pressed={pressed}
                      disabled={disabled}
                      onPressedChange={(next) => togglePr(pr.url, next)}
                    >
                      {pressed ? (
                        <Check size={12} strokeWidth={2.25} aria-hidden="true" />
                      ) : (
                        <Plus size={12} strokeWidth={2.25} aria-hidden="true" />
                      )}
                      {pr.label}
                    </Toggle>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost" />}>
            {t('common.cancel', 'Cancel')}
          </Dialog.Close>
          <Button disabled={!canStart} onClick={() => void handleStart()}>
            {t('sessions.autoDelivery.start', 'Start')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function autoDeliveryStallReasonLabel(
  status: Extract<SessionAutoDelivery, { state: 'stalled' }>,
  t: TFunction
): string {
  if (status.reason === 'request_blocked') {
    if (status.blockReason) {
      const key = `sessions.autoDelivery.blockReason.${status.blockReason}`;
      const translated = t(key, { defaultValue: '' });
      if (translated) return translated;
      const fallback = t('sessions.autoDelivery.reason.request_blocked', {
        defaultValue: '请求被阻塞，暂无法下发',
      });
      return `${fallback} (${status.blockReason})`;
    }
    return t('sessions.autoDelivery.reason.request_blocked', {
      defaultValue: '请求被阻塞，暂无法下发',
    });
  }
  return t(`sessions.autoDelivery.reason.${status.reason ?? 'request_failed'}`, {
    defaultValue: status.reason ?? '',
  });
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
        reason: autoDeliveryStallReasonLabel(status, t),
      });
  }
}

function autoDeliveryTone(status: SessionAutoDelivery): SessionContinuationTone {
  if (status.state === 'stalled') return 'attention';
  if (status.state === 'fix' || status.state === 'conflict' || status.state === 'merge')
    return 'active';
  return 'calm';
}

function autoDeliveryIcon(status: SessionAutoDelivery): LucideIcon {
  if (status.state === 'stalled') return AlertTriangle;
  if (status.state === 'merged') return Check;
  return Rocket;
}

function shortPrLabel(url: string): string {
  const gh = url.match(/\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
  if (gh) return `${gh[1]}#${gh[2]}`;
  const gl = url.match(/\/([^/]+\/[^/]+)\/-\/merge_requests\/(\d+)/i);
  if (gl) return `${gl[1]}!${gl[2]}`;
  return url;
}

/**
 * In-conversation status chip for Auto delivery, built on the same automation
 * note shell and nudge banner as `SessionContinuationNote`.
 */
export function SessionAutoDeliveryNote({
  status,
  now,
  compact = false,
  options,
  onOptionsChange,
  onTurnOff,
  onDismiss,
  onResume,
  onOpenTweaks,
  busy,
}: {
  status: SessionAutoDelivery;
  /** Stable product clock; when provided, shows last update time in the popover. */
  now?: number;
  compact?: boolean;
  options?: AutoDeliverOptions | null;
  onOptionsChange?: (options: AutoDeliverOptions) => void;
  onTurnOff?: () => void;
  /** Clears a finished status for every device; offered only after the merge. */
  onDismiss?: () => void;
  /** Restores collaboration when delivery paused because the Session was stopped. */
  onResume?: () => void;
  onOpenTweaks?: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const baseTitle = t('sessions.autoDelivery.title', 'Auto delivery');
  const title =
    status.prTotal && status.prTotal > 1
      ? `${baseTitle} (${status.prIndex ?? 1}/${status.prTotal})`
      : baseTitle;
  const detail = autoDeliveryStatusLabel(status, t);
  const merged = status.state === 'merged';

  if (status.state === 'stalled' && status.reason === 'stopped' && onResume) {
    return (
      <SessionAutomationNoteNudge
        title={detail}
        reason={title}
        dataAttributes={{ 'data-auto-delivery-state': status.state }}
        actions={
          <>
            <Button type="button" variant="primary" size="mini" disabled={busy} onClick={onResume}>
              {t('sessions.continuation.resume', '恢复会话')}
            </Button>
            {onTurnOff ? (
              <Button type="button" variant="ghost" size="mini" disabled={busy} onClick={onTurnOff}>
                {t('sessions.autoDelivery.turnOff', 'Turn off')}
              </Button>
            ) : null}
          </>
        }
      />
    );
  }

  const primaryAction = merged
    ? onDismiss
      ? { label: t('common.dismiss', 'Dismiss'), onClick: onDismiss, disabled: busy }
      : null
    : onTurnOff
      ? { label: t('sessions.autoDelivery.turnOff', 'Turn off'), onClick: onTurnOff, disabled: busy }
      : null;

  const hasUpdatedAt = now !== undefined && status.updatedAt > 0;
  const showOptions = !merged && Boolean(options) && Boolean(onOptionsChange);
  const hasPrUrl = Boolean(status.prUrl);
  const blockReason =
    status.state === 'stalled' && status.reason === 'request_blocked'
      ? status.blockReason
      : undefined;

  return (
    <SessionAutomationNoteShell
      tone={autoDeliveryTone(status)}
      icon={autoDeliveryIcon(status)}
      title={title}
      detail={detail}
      compact={compact}
      showDetailInCompact
      inlineAction={primaryAction}
      dataAttributes={{ 'data-auto-delivery-state': status.state }}
      role="status"
      popoverBody={
        hasPrUrl || hasUpdatedAt || Boolean(blockReason) || showOptions ? (
          <div {...stylex.props(styles.popoverSection)}>
            {status.prUrl ? (
              <SessionAutomationNoteRow
                icon={GitPullRequestArrow}
                label={t('sessions.autoDelivery.currentPr', 'Current PR')}
                value={shortPrLabel(status.prUrl)}
              />
            ) : null}
            {blockReason ? (
              <SessionAutomationNoteRow
                icon={AlertTriangle}
                label={t('sessions.autoDelivery.blockDetail', 'Blocked reason')}
                value={blockReason}
              />
            ) : null}
            {hasUpdatedAt ? (
              <SessionAutomationNoteRow
                icon={Clock}
                label={t('sessions.continuation.lastChecked', '上次检查')}
                value={formatLocalizedRelativeTime(status.updatedAt, t, new Date(now))}
              />
            ) : null}
            {showOptions && options && onOptionsChange ? (
              <AutoDeliveryOptionsFields
                size="mini"
                value={options}
                disabled={busy}
                onChange={onOptionsChange}
              />
            ) : null}
          </div>
        ) : null
      }
      popoverFooter={
        primaryAction || onOpenTweaks ? (
          <>
            {primaryAction ? (
              <Button
                type="button"
                variant="ghost"
                size="mini"
                disabled={primaryAction.disabled}
                onClick={primaryAction.onClick}
              >
                {primaryAction.label}
              </Button>
            ) : null}
            <SessionAutomationNoteFooterSpacer />
            {onOpenTweaks ? (
              <Button type="button" variant="ghost" size="mini" onClick={onOpenTweaks}>
                {t('sessions.continuation.moreTweaks', '自动化设置')}
                <ChevronRight size={14} strokeWidth={1.8} />
              </Button>
            ) : null}
          </>
        ) : null
      }
    />
  );
}
