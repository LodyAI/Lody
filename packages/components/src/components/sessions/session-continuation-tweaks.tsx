import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Archive, BatteryCharging, Layers, Sparkles, type LucideIcon } from 'lucide-react';
import { Separator } from '@lody/ui/separator';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { cn } from '@/lib/utils';

export type SessionContinuationTweaksValue = {
  recoverCapacity: boolean;
  archiveAfterMerge: boolean;
  compactWhenIdle: boolean;
};

export type SessionContinuationTweakAvailability = {
  supported: boolean;
  reason?: string;
};

export type SessionContinuationTweaksProps = {
  value: SessionContinuationTweaksValue;
  onChange: (key: keyof SessionContinuationTweaksValue, checked: boolean) => void;
  disabled?: boolean;
  capabilities?: Partial<
    Record<keyof SessionContinuationTweaksValue, SessionContinuationTweakAvailability>
  >;
  className?: string;
};

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    width: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    paddingBottom: space[2],
  },
  headerIcon: {
    width: 14,
    height: 14,
    flexShrink: 0,
    color: colors.tertiaryLabel,
  },
  headerTitle: {
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 650,
    letterSpacing: text.controlTracking,
  },
  headerScope: {
    marginInlineStart: 'auto',
    color: colors.tertiaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    whiteSpace: 'nowrap',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[1.5],
  },
  icon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    flexShrink: 0,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
  },
  copy: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
  },
  title: {
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
  },
  description: {
    color: colors.tertiaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    marginTop: 1,
  },
  unsupported: {
    color: colors.warning,
  },
  footer: {
    marginTop: space[2],
    paddingTop: space[2],
    color: colors.tertiaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
});

const ROWS = [
  {
    key: 'recoverCapacity',
    icon: BatteryCharging,
    titleKey: 'sessions.continuation.tweaks.recover',
    title: '容量恢复后继续',
    descriptionKey: 'sessions.continuation.tweaks.recoverDescription',
    description: '额度耗尽或模型满载时自动重试，遵循会话停止状态',
  },
  {
    key: 'archiveAfterMerge',
    icon: Archive,
    titleKey: 'sessions.continuation.tweaks.archive',
    title: '合并后自动归档',
    descriptionKey: 'sessions.continuation.tweaks.archiveDescription',
    description: '包括子会话和排队消息',
  },
  {
    key: 'compactWhenIdle',
    icon: Layers,
    titleKey: 'sessions.continuation.tweaks.compact',
    title: '空闲时自动压缩',
    descriptionKey: 'sessions.continuation.tweaks.compactDescription',
    description: '达到配置的上下文阈值后压缩',
  },
] as const satisfies ReadonlyArray<{
  key: keyof SessionContinuationTweaksValue;
  icon: LucideIcon;
  titleKey: string;
  title: string;
  descriptionKey: string;
  description: string;
}>;

/**
 * The three per-Session behaviors, kept as small switches rather than a
 * settings page. The Host owns their semantics; this surface says what each one
 * will and will not do, and disables one it cannot support.
 */
export function SessionContinuationTweaks({
  value,
  onChange,
  disabled = false,
  capabilities,
  className,
}: SessionContinuationTweaksProps) {
  const { t } = useTranslation();
  const rootSx = stylex.props(styles.root);

  return (
    <div {...rootSx} className={cn(rootSx.className, className)}>
      <div {...stylex.props(styles.header)}>
        <Sparkles {...stylex.props(styles.headerIcon)} size={14} strokeWidth={1.8} />
        <span {...stylex.props(styles.headerTitle)}>
          {t('sessions.continuation.tweaks.title', '自动化设置')}
        </span>
        <span {...stylex.props(styles.headerScope)}>
          {t('sessions.continuation.tweaks.scope', '仅适用于此会话')}
        </span>
      </div>

      {ROWS.map((row) => {
        const availability = capabilities?.[row.key];
        const supported = availability?.supported ?? true;
        const Icon = row.icon;
        return (
          <div
            key={row.key}
            {...stylex.props(styles.row)}
            data-session-continuation-tweak={row.key}
          >
            <span {...stylex.props(styles.icon)} aria-hidden="true">
              <Icon size={14} strokeWidth={1.8} />
            </span>
            <span {...stylex.props(styles.copy)}>
              <span {...stylex.props(styles.title)}>{t(row.titleKey, row.title)}</span>
              <span {...stylex.props(styles.description, !supported && styles.unsupported)}>
                {supported
                  ? t(row.descriptionKey, row.description)
                  : (availability?.reason ??
                    t('sessions.continuation.tweaks.unsupported', '当前会话不支持'))}
              </span>
            </span>
            <Switch
              checked={value[row.key]}
              disabled={disabled || !supported}
              onCheckedChange={(checked) => onChange(row.key, checked)}
              aria-label={t(row.titleKey, row.title)}
            />
          </div>
        );
      })}

      <Separator />
      <div {...stylex.props(styles.footer)}>
        {t('sessions.continuation.tweaks.footer', '设置立即生效。关闭设置不会取消已触发的操作。')}
      </div>
    </div>
  );
}
