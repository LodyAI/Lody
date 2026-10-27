import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { formatDistance, type Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { zhCN } from 'date-fns/locale/zh-CN';
import * as stylex from '@stylexjs/stylex';
import { getServerNow } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { useStableNow } from '@/hooks/use-stable-now';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { formatWalletBalance, type AiUsageQuotaRow } from './ai-usage-model';

const styles = stylex.create({
  windows: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: space[4],
    minWidth: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  window: {
    minWidth: 0,
  },
  windowHead: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[2],
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  windowValue: {
    fontSize: text.footnoteSize,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  windowValueWarning: {
    color: colors.warning,
  },
  meter: {
    height: '4px',
    marginTop: space[1],
    overflow: 'hidden',
    borderRadius: radius.full,
    backgroundColor: colors.gray5,
  },
  meterFill: {
    display: 'block',
    height: '100%',
    borderRadius: radius.full,
    backgroundColor: colors.success,
  },
  meterWarning: {
    backgroundColor: colors.warning,
  },
  meterDestructive: {
    backgroundColor: colors.destructive,
  },
  windowFoot: {
    marginTop: space[1],
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  windowEmpty: {
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  walletValue: {
    fontSize: text.footnoteSize,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
});

function useDateLocale(): Locale {
  const { i18n } = useTranslation();
  return i18n.language?.startsWith('zh') ? zhCN : enUS;
}

function formatReset(epochSeconds: number | null, locale: Locale, t: TFunction): string {
  if (epochSeconds === null || epochSeconds === 0) {
    return t('machines.rateLimits.resetUnknown', 'Reset unknown');
  }
  const distance = formatDistance(new Date(epochSeconds * 1000), new Date(getServerNow()), {
    addSuffix: true,
    locale,
  });
  return t('machines.rateLimits.resetsAt', 'Resets {{time}}', { time: distance });
}

function windowLabel(windowSeconds: number | null, t: TFunction): string {
  if (windowSeconds === 5 * 60 * 60) return t('sessions.usage.fiveHour', '5 hours');
  if (windowSeconds === 7 * 24 * 60 * 60) return t('workspace.usage.window.week.short', '7d');
  if (windowSeconds === null) return t('sessions.usage.limit', 'Usage');
  if (windowSeconds % (24 * 60 * 60) === 0) return `${windowSeconds / (24 * 60 * 60)}d`;
  if (windowSeconds % (60 * 60) === 0) return `${windowSeconds / (60 * 60)}h`;
  return `${Math.round(windowSeconds / 60)}m`;
}

function QuotaWindow({
  window,
  locale,
}: {
  window: AiUsageQuotaRow['windows'][number];
  locale: Locale;
}) {
  const { t } = useTranslation();
  const remaining = Math.max(0, Math.min(100, window.remainingPercent));
  const warning = remaining <= 30;
  const destructive = remaining <= 5;
  return (
    <div {...stylex.props(styles.window)}>
      <div {...stylex.props(styles.windowHead)}>
        <span>{windowLabel(window.windowDurationSeconds, t)}</span>
        <span {...stylex.props(styles.windowValue, warning && styles.windowValueWarning)}>
          {Math.round(remaining)}%
        </span>
      </div>
      <div {...stylex.props(styles.meter)}>
        <span
          {...stylex.props(
            styles.meterFill,
            warning && styles.meterWarning,
            destructive && styles.meterDestructive
          )}
          style={{ width: `${remaining}%` }}
        />
      </div>
      <div {...stylex.props(styles.windowFoot)}>
        {formatReset(window.resetsAtEpochSeconds, locale, t)}
      </div>
    </div>
  );
}

function WalletWindow({
  row,
  locale,
}: {
  row: Pick<AiUsageQuotaRow, 'windows' | 'wallet'>;
  locale: string;
}) {
  const { t } = useTranslation();
  const balance = formatWalletBalance(row.wallet, locale);
  if (balance === null || balance.length === 0) {
    return <div {...stylex.props(styles.windowEmpty)}>—</div>;
  }
  const wallet = row.wallet;
  const ratio =
    wallet && wallet.monthlyChargeLimitCents > 0
      ? Math.max(0, Math.min(100, (wallet.monthlyUsedCents / wallet.monthlyChargeLimitCents) * 100))
      : 0;
  return (
    <div {...stylex.props(styles.window)}>
      <div {...stylex.props(styles.windowHead)}>
        <span>{t('sessions.usage.balance', 'Balance')}</span>
        <span {...stylex.props(styles.walletValue)}>{balance}</span>
      </div>
      <div {...stylex.props(styles.meter)}>
        <span {...stylex.props(styles.meterFill)} style={{ width: `${ratio}%` }} />
      </div>
      <div {...stylex.props(styles.windowFoot)}>
        {t('sessions.usage.monthlyUsed', 'Used this month')}
      </div>
    </div>
  );
}

export function ProviderQuotaWindows({
  row,
}: {
  row: Pick<AiUsageQuotaRow, 'windows' | 'wallet'>;
}) {
  const { t, i18n } = useTranslation();
  const locale = useDateLocale();
  const intlLocale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  useStableNow();
  return (
    <div {...stylex.props(styles.windows)}>
      {row.windows.length > 0 ? (
        row.windows.map((window, index) => (
          <QuotaWindow
            key={`${index}-${window.windowDurationSeconds}`}
            window={window}
            locale={locale}
          />
        ))
      ) : row.wallet ? (
        <WalletWindow row={row} locale={intlLocale} />
      ) : (
        <div {...stylex.props(styles.windowEmpty)}>
          {t('settings.aiUsage.quota.unreported', 'Not reported')}
        </div>
      )}
    </div>
  );
}
