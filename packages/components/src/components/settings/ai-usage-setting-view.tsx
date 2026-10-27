import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { formatDistance, type Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { zhCN } from 'date-fns/locale/zh-CN';
import { AlertTriangle, Clock, RefreshCw, WifiOff } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { getServerNow } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { ModelBrandIcon } from '@/components/icons/model-brand-icon';
import { UsageStackedAreaChart, type StackedAreaBucket } from './usage-stacked-area-chart';
import { formatCompactNumber, formatUsdAmount } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { useStableNow } from '@/hooks/use-stable-now';
import type { AiUsageProviderKey, AiUsageProviderRow, AiUsageQuotaRow } from './ai-usage-model';
import { formatQuotaPercent, formatWalletBalance } from './ai-usage-model';

export type AiUsageHistoryPanel = {
  id: string;
  title: string;
  rangeLabel: string;
  labels: string[];
  series: Array<{
    id: string;
    label: string;
    color: string;
    points: Array<{ x: number; y: number }>;
  }>;
};

export type AiUsageWaitingState =
  | 'scheduled'
  | 'waiting_for_machine'
  | 'needs_attention'
  | 'retrying';

export type AiUsageWaitingRow = {
  id: string;
  title: string;
  providerLabel: string;
  machineName: string;
  state: AiUsageWaitingState;
  nextActionLabel: string;
  elapsedLabel: string;
  note?: string;
};

export type AiUsageSettingsViewProps = {
  quotaRows: AiUsageQuotaRow[];
  quotaLoading: boolean;
  onRefreshQuota: () => void;
  byModelBuckets?: StackedAreaBucket[];
  byMemberBuckets?: StackedAreaBucket[];
  usageLoading: boolean;
  providerRows: AiUsageProviderRow[];
  historyPanels?: AiUsageHistoryPanel[];
  waitingRows?: AiUsageWaitingRow[];
  onCancelWaiting?: (id: string) => void;
  onOpenWaitingSession?: (id: string) => void;
  onViewQueue?: () => void;
};

const PROVIDER_COLORS: Record<AiUsageProviderKey, string> = {
  claude: '#d97757',
  codex: colors.label,
  deepseek: '#6a86ff',
  kimi: '#b49cff',
  gemini: '#8ab4f8',
  other: colors.secondaryLabel,
};

const styles = stylex.create({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
    minWidth: 0,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    minWidth: 0,
  },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minHeight: '22px',
  },
  sectionTitle: {
    margin: 0,
    fontSize: text.bodySize,
    fontWeight: 500,
    lineHeight: 1.4,
    color: colors.label,
  },
  sectionMeta: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  card: {
    overflow: 'hidden',
    backgroundColor: colors.raisedBackground,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    boxShadow: shadow.card,
  },
  ruled: {
    boxShadow: `inset 0 0.5px 0 ${colors.separator}`,
  },
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingBottom: space[2],
    boxShadow: `inset 0 -0.5px 0 ${colors.separator}`,
  },
  noticeIcon: {
    display: 'flex',
    width: '16px',
    height: '16px',
    flexShrink: 0,
    color: colors.warning,
  },
  noticeText: {
    minWidth: 0,
    flexGrow: 1,
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  noticeStrong: {
    fontWeight: 500,
    color: colors.label,
  },
  quotaRow: {
    display: 'grid',
    gridTemplateColumns: '240px minmax(0, 1fr) minmax(0, 1fr)',
    alignItems: 'center',
    gap: space[4],
    paddingInline: space[4],
    paddingBlock: space[3],
  },
  providerIdentity: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
  },
  providerIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    flexShrink: 0,
  },
  providerCopy: {
    minWidth: 0,
  },
  providerName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
    fontWeight: 500,
    color: colors.label,
  },
  providerMeta: {
    display: 'flex',
    gap: space[2],
    marginTop: '1px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  providerMetaText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
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
    fontSize: text.bodySize,
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
    fontSize: text.bodySize,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  emptyNote: {
    margin: 0,
    paddingInline: space[4],
    paddingBlock: space[3],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  kpis: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    paddingBlock: space[2],
  },
  kpi: {
    minWidth: 0,
    paddingInline: space[4],
  },
  kpiFirst: {
    paddingInlineStart: 0,
  },
  kpiRuled: {
    boxShadow: `inset 0.5px 0 0 ${colors.separator}`,
  },
  kpiLabel: {
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  kpiValue: {
    marginTop: '2px',
    fontSize: text.titleSize,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  kpiFoot: {
    marginTop: '2px',
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  historyGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: space[3],
  },
  historyCard: {
    padding: space[3],
  },
  historyHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  historyTitle: {
    fontSize: text.bodySize,
    fontWeight: 500,
    color: colors.label,
  },
  historyChart: {
    display: 'block',
    width: '100%',
    height: 'auto',
    marginTop: space[2],
  },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[3],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
  },
  swatch: {
    width: '8px',
    height: '8px',
    borderRadius: '2px',
  },
  chartNote: {
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  tableHead: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.4fr) 160px 72px 72px 64px',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[2],
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
    boxShadow: `inset 0 -0.5px 0 ${colors.separator}`,
  },
  tableRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.4fr) 160px 72px 72px 64px',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[2],
    fontSize: text.bodySize,
  },
  tableProvider: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
  },
  tableProviderName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 500,
    color: colors.label,
  },
  tableMachine: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  tableNumber: {
    textAlign: 'end',
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  tableNumberQuiet: {
    textAlign: 'end',
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
  },
  tableQuota: {
    textAlign: 'end',
    fontSize: text.footnoteSize,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
  },
  tableQuotaWarning: {
    color: colors.warning,
  },
  waitingRow: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) 140px 130px',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: space[3],
  },
  waitingIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    alignSelf: 'start',
    marginTop: '2px',
    color: colors.secondaryLabel,
  },
  waitingIconWarning: {
    color: colors.warning,
  },
  waitingIconDestructive: {
    color: colors.destructive,
  },
  waitingMain: {
    minWidth: 0,
  },
  waitingTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
    fontWeight: 500,
    color: colors.label,
  },
  waitingMeta: {
    display: 'flex',
    gap: space[2],
    marginTop: '2px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  waitingMetaText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  waitingNote: {
    marginTop: '2px',
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  waitTime: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  waitTimeValue: {
    fontSize: text.titleSize,
    fontWeight: 600,
    lineHeight: 1.2,
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
    color: colors.accent,
  },
  waitTimeValueSmall: {
    fontSize: text.bodySize,
    fontWeight: 500,
    letterSpacing: 0,
  },
  waitTimeUnit: {
    marginInlineStart: '2px',
    fontSize: text.footnoteSize,
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  waitTimeElapsed: {
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  waitingActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space[2],
  },
  waitingFoot: {
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  footer: {
    paddingTop: space[2],
    boxShadow: `inset 0 0.5px 0 ${colors.separator}`,
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
});

const DIMENSIONS = ['model', 'member'] as const;

const dimensionStyles = stylex.create({
  tray: {
    display: 'inline-flex',
    gap: '1px',
    padding: '2px',
    borderRadius: radius.small,
    backgroundColor: colors.trayBackground,
  },
  tab: {
    boxSizing: 'border-box',
    height: '24px',
    margin: 0,
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.mini,
    backgroundColor: 'transparent',
    color: colors.secondaryLabel,
    fontFamily: 'inherit',
    fontSize: text.footnoteSize,
    cursor: 'pointer',
  },
  selected: {
    backgroundColor: colors.trayRaised,
    boxShadow: shadow.raised,
    color: colors.label,
  },
});

function useDateLocale(): Locale {
  const { i18n } = useTranslation();
  return i18n.language?.startsWith('zh') ? zhCN : enUS;
}

function formatReset(epochSeconds: number | null, locale: Locale, t: TFunction): string {
  if (!epochSeconds) return t('machines.rateLimits.resetUnknown', 'Reset unknown');
  const distance = formatDistance(new Date(epochSeconds * 1000), new Date(getServerNow()), {
    addSuffix: true,
    locale,
  });
  return t('machines.rateLimits.resetsAt', 'Resets {{time}}', { time: distance });
}

function windowLabel(windowSeconds: number | null, t: TFunction): string {
  if (windowSeconds === 5 * 60 * 60) return t('sessions.usage.fiveHour', '5 hours');
  if (windowSeconds === 7 * 24 * 60 * 60) return t('sessions.usage.weekly', 'Weekly');
  if (windowSeconds === null) return t('sessions.usage.limit', 'Usage');
  if (windowSeconds % (24 * 60 * 60) === 0) return `${windowSeconds / (24 * 60 * 60)}d`;
  if (windowSeconds % (60 * 60) === 0) return `${windowSeconds / (60 * 60)}h`;
  return `${Math.round(windowSeconds / 60)}m`;
}

function providerColor(key: AiUsageProviderKey): string {
  return PROVIDER_COLORS[key];
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

function WalletWindow({ row, locale }: { row: AiUsageQuotaRow; locale: string }) {
  const { t } = useTranslation();
  const balance = formatWalletBalance(row.wallet, locale);
  if (!balance) return <div {...stylex.props(styles.windowEmpty)}>—</div>;
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

function HistoryChart({ panel }: { panel: AiUsageHistoryPanel }) {
  const width = 400;
  const height = 140;
  const left = 34;
  const right = 2;
  const top = 8;
  const bottom = 20;
  const innerW = width - left - right;
  const innerH = height - top - bottom;
  const yAt = (value: number) => top + innerH - (value / 100) * innerH;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={panel.title}
      {...stylex.props(styles.historyChart)}
    >
      {[0, 50, 100].map((value) => (
        <g key={value}>
          <line
            x1={left}
            x2={width - right}
            y1={yAt(value)}
            y2={yAt(value)}
            stroke={colors.separator}
            strokeWidth="0.5"
          />
          <text
            x={left - 6}
            y={yAt(value) + 3}
            textAnchor="end"
            fill={colors.tertiaryLabel}
            fontFamily="var(--font-sans)"
            fontSize="12"
          >
            {value}%
          </text>
        </g>
      ))}
      {panel.labels.map((label, index) => {
        const x = left + (index * innerW) / Math.max(1, panel.labels.length - 1);
        return (
          <text
            key={`${label}-${index}`}
            x={x}
            y={height - 5}
            textAnchor={
              index === 0 ? 'start' : index === panel.labels.length - 1 ? 'end' : 'middle'
            }
            fill={colors.tertiaryLabel}
            fontFamily="var(--font-sans)"
            fontSize="12"
          >
            {label}
          </text>
        );
      })}
      {panel.series.map((series) => (
        <path
          key={series.id}
          d={series.points
            .map((point, index) => {
              const x = left + point.x * innerW;
              const y = yAt(point.y);
              return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
            })
            .join(' ')}
          fill="none"
          stroke={series.color}
          strokeWidth="2"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

export function AiUsageSettingsView({
  quotaRows,
  quotaLoading,
  onRefreshQuota,
  byModelBuckets = [],
  byMemberBuckets = [],
  usageLoading,
  providerRows,
  historyPanels = [],
  waitingRows = [],
  onCancelWaiting,
  onOpenWaitingSession,
  onViewQueue,
}: AiUsageSettingsViewProps) {
  const { t, i18n } = useTranslation();
  const locale = useDateLocale();
  const intlLocale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  useStableNow();
  const [dimension, setDimension] = useState<'model' | 'member'>('model');
  const activeBuckets = dimension === 'member' ? byMemberBuckets : byModelBuckets;
  const activeTitle =
    dimension === 'member'
      ? t('settings.aiUsage.usage.byMember', 'By member')
      : t('settings.aiUsage.usage.byModel', 'By model');

  return (
    <div {...stylex.props(styles.page)}>
      {byModelBuckets.length > 0 || byMemberBuckets.length > 0 ? (
        <section {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.sectionHead)}>
            <h2 {...stylex.props(styles.sectionTitle)}>
              {t('settings.aiUsage.breakdown.title', 'Breakdown')}
            </h2>
            <div
              role="tablist"
              aria-label={t('settings.aiUsage.usage.dimension', 'Usage dimension')}
              {...stylex.props(dimensionStyles.tray)}
            >
              {DIMENSIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={dimension === value}
                  onClick={() => setDimension(value)}
                  {...stylex.props(
                    dimensionStyles.tab,
                    dimension === value && dimensionStyles.selected
                  )}
                >
                  {value === 'model'
                    ? t('settings.aiUsage.usage.model', 'Model')
                    : t('settings.aiUsage.usage.member', 'Member')}
                </button>
              ))}
            </div>
          </div>
          <UsageStackedAreaChart
            title={activeTitle}
            buckets={activeBuckets}
            emptyText={t('settings.aiUsage.usage.empty', 'No usage in this range')}
            valueFormatter={(value) => formatCompactNumber(value, intlLocale)}
            tooltipValueFormatter={(value) => formatCompactNumber(value, intlLocale)}
            loading={usageLoading}
            loadingText={t('settings.aiUsage.usage.loading', 'Loading usage...')}
          />
        </section>
      ) : null}

      {waitingRows.length > 0 ? (
        <div {...stylex.props(styles.notice)}>
          <span {...stylex.props(styles.noticeIcon)}>
            <Clock aria-hidden="true" size={16} />
          </span>
          <div {...stylex.props(styles.noticeText)}>
            <span {...stylex.props(styles.noticeStrong)}>
              {t('settings.aiUsage.waitingNotice', '{{count}} Sessions waiting for quota', {
                count: waitingRows.length,
              })}
            </span>
          </div>
          <Button variant="ghost" size="mini" onClick={onViewQueue}>
            {t('settings.aiUsage.viewQueue', 'View')}
          </Button>
        </div>
      ) : null}

      <section {...stylex.props(styles.section)}>
        <div {...stylex.props(styles.sectionHead)}>
          <h2 {...stylex.props(styles.sectionTitle)}>
            {t('settings.aiUsage.quota.title', 'Live quota')}
          </h2>
          <Button variant="ghost" size="mini" onClick={onRefreshQuota}>
            <RefreshCw aria-hidden="true" size={14} />
            {t('settings.aiUsage.quota.refresh', 'Refresh')}
          </Button>
        </div>
        <div {...stylex.props(styles.card)}>
          {quotaRows.length === 0 ? (
            <p {...stylex.props(styles.emptyNote)}>
              {quotaLoading
                ? t('settings.aiUsage.quota.loading', 'Loading Providers...')
                : t('settings.aiUsage.quota.empty', 'No visible Providers.')}
            </p>
          ) : (
            quotaRows.map((row, index) => {
              const firstWindow = row.windows[0];
              const secondWindow = row.windows[1];
              return (
                <div key={row.id} {...stylex.props(styles.quotaRow, index > 0 && styles.ruled)}>
                  <div {...stylex.props(styles.providerIdentity)}>
                    <span
                      {...stylex.props(styles.providerIcon)}
                      style={{ color: providerColor(row.providerKey) }}
                    >
                      <ModelBrandIcon modelId={row.providerKey} className="h-[18px] w-[18px]" />
                    </span>
                    <div {...stylex.props(styles.providerCopy)}>
                      <div {...stylex.props(styles.providerName)}>{row.providerName}</div>
                      <div {...stylex.props(styles.providerMeta)}>
                        <span {...stylex.props(styles.providerMetaText)}>{row.machineName}</span>
                        {!row.machineOnline ? (
                          <span {...stylex.props(styles.providerMetaText)}>
                            {t('settings.aiUsage.quota.offline', 'Offline')}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  {firstWindow ? (
                    <QuotaWindow window={firstWindow} locale={locale} />
                  ) : row.wallet ? (
                    <WalletWindow row={row} locale={intlLocale} />
                  ) : (
                    <div {...stylex.props(styles.windowEmpty)}>
                      {t('settings.aiUsage.quota.unreported', 'Not reported')}
                    </div>
                  )}
                  {secondWindow ? (
                    <QuotaWindow window={secondWindow} locale={locale} />
                  ) : (
                    <div {...stylex.props(styles.windowEmpty)}>
                      {t('settings.aiUsage.quota.window', 'Window')} —
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>

      {historyPanels.length > 0 ? (
        <section {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.sectionHead)}>
            <h2 {...stylex.props(styles.sectionTitle)}>
              {t('settings.aiUsage.history.title', 'Quota history')}
            </h2>
            <span {...stylex.props(styles.sectionMeta)}>
              {t('settings.aiUsage.history.sampling', 'Sampled every 15 minutes')}
            </span>
          </div>
          <div {...stylex.props(styles.historyGrid)}>
            {historyPanels.map((panel) => (
              <div key={panel.id} {...stylex.props(styles.card, styles.historyCard)}>
                <div {...stylex.props(styles.historyHead)}>
                  <span {...stylex.props(styles.historyTitle)}>{panel.title}</span>
                  <span {...stylex.props(styles.sectionMeta)}>{panel.rangeLabel}</span>
                </div>
                <HistoryChart panel={panel} />
                <div {...stylex.props(styles.legend)}>
                  {panel.series.map((series) => (
                    <span key={series.id} {...stylex.props(styles.legendItem)}>
                      <span
                        {...stylex.props(styles.swatch)}
                        style={{ backgroundColor: series.color }}
                      />
                      {series.label}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {providerRows.length > 0 ? (
        <section {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.sectionHead)}>
            <h2 {...stylex.props(styles.sectionTitle)}>
              {t('settings.aiUsage.providers.title', 'Provider and machine')}
            </h2>
          </div>
          <div {...stylex.props(styles.card)}>
            <div {...stylex.props(styles.tableHead)}>
              <span>{t('settings.aiUsage.providers.provider', 'Provider')}</span>
              <span>{t('settings.aiUsage.providers.machine', 'Machine')}</span>
              <span style={{ textAlign: 'end' }}>
                {t('settings.aiUsage.providers.tokens', 'Tokens')}
              </span>
              <span style={{ textAlign: 'end' }}>
                {t('settings.aiUsage.providers.cost', 'Cost')}
              </span>
              <span style={{ textAlign: 'end' }}>
                {t('settings.aiUsage.providers.quota', 'Quota')}
              </span>
            </div>
            {providerRows.map((row, index) => (
              <div key={row.key} {...stylex.props(styles.tableRow, index > 0 && styles.ruled)}>
                <div {...stylex.props(styles.tableProvider)}>
                  <span style={{ color: providerColor(row.key) }}>
                    <ModelBrandIcon
                      modelId={row.key === 'other' ? 'sparkles' : row.key}
                      className="h-4 w-4"
                    />
                  </span>
                  <span {...stylex.props(styles.tableProviderName)}>{row.label}</span>
                </div>
                <span {...stylex.props(styles.tableMachine)}>
                  {row.machines.length > 0 ? row.machines.join(', ') : '—'}
                </span>
                <span {...stylex.props(styles.tableNumber)}>
                  {row.tokens === null ? '—' : formatCompactNumber(row.tokens, intlLocale)}
                </span>
                <span {...stylex.props(styles.tableNumberQuiet)}>
                  {row.costUSD === null
                    ? '—'
                    : formatUsdAmount(row.costUSD, intlLocale, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                </span>
                <span
                  {...stylex.props(
                    styles.tableQuota,
                    row.quotaPercent !== null && row.quotaPercent <= 30
                      ? styles.tableQuotaWarning
                      : null
                  )}
                >
                  {formatQuotaPercent(row.quotaPercent)}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {waitingRows.length > 0 ? (
        <section {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.sectionHead)}>
            <h2 {...stylex.props(styles.sectionTitle)}>
              {t('settings.aiUsage.waiting.title', 'Waiting to resume')}
            </h2>
            <span {...stylex.props(styles.sectionMeta)}>{waitingRows.length}</span>
          </div>
          <div {...stylex.props(styles.card)}>
            {waitingRows.map((row, index) => {
              const scheduled = row.state === 'scheduled';
              const needsAttention = row.state === 'needs_attention';
              const waitingMachine = row.state === 'waiting_for_machine';
              const retrying = row.state === 'retrying';
              return (
                <div key={row.id} {...stylex.props(styles.waitingRow, index > 0 && styles.ruled)}>
                  <span
                    {...stylex.props(
                      styles.waitingIcon,
                      needsAttention && styles.waitingIconDestructive,
                      scheduled && styles.waitingIconWarning
                    )}
                  >
                    {needsAttention ? (
                      <AlertTriangle aria-hidden="true" size={16} />
                    ) : waitingMachine ? (
                      <WifiOff aria-hidden="true" size={16} />
                    ) : (
                      <Clock aria-hidden="true" size={16} />
                    )}
                  </span>
                  <div {...stylex.props(styles.waitingMain)}>
                    <div {...stylex.props(styles.waitingTitle)}>{row.title}</div>
                    <div {...stylex.props(styles.waitingMeta)}>
                      <span {...stylex.props(styles.waitingMetaText)}>{row.providerLabel}</span>
                      <span {...stylex.props(styles.waitingMetaText)}>{row.machineName}</span>
                    </div>
                    {row.note ? <div {...stylex.props(styles.waitingNote)}>{row.note}</div> : null}
                  </div>
                  <div {...stylex.props(styles.waitTime)}>
                    <div>
                      <span
                        {...stylex.props(
                          styles.waitTimeValue,
                          !scheduled && styles.waitTimeValueSmall
                        )}
                        style={{
                          color: needsAttention
                            ? colors.destructive
                            : scheduled
                              ? colors.accent
                              : colors.secondaryLabel,
                        }}
                      >
                        {row.nextActionLabel}
                      </span>
                      {scheduled ? (
                        <span {...stylex.props(styles.waitTimeUnit)}>
                          {t('settings.aiUsage.waiting.retryUnit', 'min until retry')}
                        </span>
                      ) : null}
                    </div>
                    <div {...stylex.props(styles.waitTimeElapsed)}>{row.elapsedLabel}</div>
                  </div>
                  <div {...stylex.props(styles.waitingActions)}>
                    <Button
                      variant="ghost"
                      size="mini"
                      disabled={retrying}
                      onClick={() => onCancelWaiting?.(row.id)}
                    >
                      {needsAttention
                        ? t('settings.aiUsage.waiting.giveUp', 'Give up')
                        : t('settings.aiUsage.waiting.cancel', 'Cancel')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="mini"
                      disabled={retrying}
                      onClick={() => onOpenWaitingSession?.(row.id)}
                    >
                      {t('settings.aiUsage.waiting.open', 'Open Session')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <p {...stylex.props(styles.waitingFoot)}>
            {t(
              'settings.aiUsage.waiting.footnote',
              'Resumes only after the quota reset. A turn with output or tool activity is never replayed.'
            )}
          </p>
        </section>
      ) : null}
    </div>
  );
}
