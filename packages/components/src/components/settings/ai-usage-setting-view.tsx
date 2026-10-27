import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock, Laptop, RefreshCw, Server, WifiOff } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Select } from '@lody/ui/select';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { ProviderQuotaWindows } from './provider-quota-windows';
import { ModelBrandIcon } from '@/components/icons/model-brand-icon';
import { UsageStackedAreaChart, type StackedAreaBucket } from './usage-stacked-area-chart';
import { formatCompactNumber, formatUsdAmount } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import type { AiUsageProviderKey, AiUsageProviderRow, AiUsageQuotaRow } from './ai-usage-model';
import { formatQuotaPercent, providerLabel } from './ai-usage-model';

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
  surface?: 'all' | 'usage' | 'quota';
  quotaRows: AiUsageQuotaRow[];
  quotaLoading: boolean;
  onRefreshQuota?: () => void;
  byModelBuckets?: StackedAreaBucket[];
  byMemberBuckets?: StackedAreaBucket[];
  usageLoading: boolean;
  providerRows: AiUsageProviderRow[];
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

const ROOMY_QUOTA = '@container (min-width: 32rem)';

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
  quotaControls: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    marginBottom: space[2],
  },
  groupToggle: {
    display: 'inline-flex',
    gap: '1px',
    padding: '2px',
    borderRadius: radius.small,
    backgroundColor: colors.trayBackground,
  },
  groupToggleButton: {
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
  groupToggleSelected: {
    backgroundColor: colors.trayRaised,
    boxShadow: shadow.raised,
    color: colors.label,
  },
  filterButton: {
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
    boxShadow: `inset 0 0 0 0.5px ${colors.separator}`,
  },
  filterButtonSelected: {
    backgroundColor: colors.trayRaised,
    boxShadow: shadow.raised,
    color: colors.label,
  },
  select: {
    minWidth: '116px',
  },
  searchBox: {
    width: '160px',
  },
  groupHead: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  groupIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    flexShrink: 0,
  },
  groupTitle: {
    fontSize: text.bodySize,
    fontWeight: 500,
    color: colors.label,
  },
  groupCount: {
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  quotaRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      [ROOMY_QUOTA]: 'minmax(0, 1.35fr) minmax(0, 2fr)',
    },
    alignItems: 'center',
    gap: space[4],
    minHeight: '56px',
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  plan: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '17px',
    marginInlineStart: space[1],
    paddingInline: '5px',
    borderRadius: '4px',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 5%)`,
    color: colors.tertiaryLabel,
    fontFamily: 'inherit',
    fontSize: text.captionSize,
    fontWeight: 400,
  },
  machineChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    height: '18px',
    paddingInline: '6px',
    borderRadius: '4px',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 5%)`,
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
  },
  machineChipIcon: {
    display: 'flex',
    width: '10px',
    height: '10px',
    flexShrink: 0,
  },
  providerIdentity: {
    gridColumn: 1,
    gridRow: 1,
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
  quotaWindows: {
    minWidth: 0,
    gridColumn: { default: '1', [ROOMY_QUOTA]: '2' },
    gridRow: { default: '2', [ROOMY_QUOTA]: '1' },
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
  quotaCard: { containerType: 'inline-size' },
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

function providerColor(key: AiUsageProviderKey): string {
  return PROVIDER_COLORS[key];
}

type QuotaGroup = {
  id: string;
  label: string;
  rows: AiUsageQuotaRow[];
  kind: 'provider' | 'machine';
  providerKey?: AiUsageProviderKey;
  machineName?: string;
  online?: boolean;
};

function rowRemaining(row: AiUsageQuotaRow): number | null {
  const windows = row.windows.filter((window) => Number.isFinite(window.remainingPercent));
  if (windows.length === 0) return null;
  return Math.min(...windows.map((window) => window.remainingPercent));
}

function machineIcon(machineName: string) {
  return /book/i.test(machineName) ? Laptop : Server;
}

function LiveQuotaSection({
  rows,
  loading,
  onRefresh,
}: {
  rows: AiUsageQuotaRow[];
  loading: boolean;
  onRefresh?: () => void;
}) {
  const { t } = useTranslation();
  const [groupBy, setGroupBy] = useState<'provider' | 'machine'>('provider');
  const [machineFilter, setMachineFilter] = useState('all');
  const [providerFilter, setProviderFilter] = useState('all');
  const [belowTwenty, setBelowTwenty] = useState(false);
  const [query, setQuery] = useState('');

  const machineItems = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of rows) byId.set(row.machineId, row.machineName);
    return [
      { value: 'all', label: t('settings.aiUsage.quota.allMachines', 'All machines') },
      ...[...byId.entries()]
        .sort((left, right) => left[1].localeCompare(right[1]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [rows, t]);

  const providerItems = useMemo(() => {
    const keys = [...new Set(rows.map((row) => row.providerKey))].sort((left, right) =>
      providerLabel(left).localeCompare(providerLabel(right))
    );
    return [
      { value: 'all', label: t('settings.aiUsage.quota.allProviders', 'All providers') },
      ...keys.map((key) => ({ value: key, label: providerLabel(key) })),
    ];
  }, [rows, t]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (machineFilter !== 'all' && row.machineId !== machineFilter) return false;
        if (providerFilter !== 'all' && row.providerKey !== providerFilter) return false;
        const remaining = rowRemaining(row);
        if (belowTwenty && (remaining === null || remaining > 20)) return false;
        if (!normalizedQuery) return true;
        return [row.providerName, row.machineName, row.planName ?? '']
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .sort((left, right) => {
        const leftRemaining = rowRemaining(left);
        const rightRemaining = rowRemaining(right);
        if (leftRemaining === null && rightRemaining === null) {
          return left.providerName.localeCompare(right.providerName);
        }
        if (leftRemaining === null) return 1;
        if (rightRemaining === null) return -1;
        if (leftRemaining !== rightRemaining) return leftRemaining - rightRemaining;
        return left.providerName.localeCompare(right.providerName);
      });
  }, [belowTwenty, machineFilter, providerFilter, query, rows]);

  const groups = useMemo<QuotaGroup[]>(() => {
    if (groupBy === 'provider') {
      const byProvider = new Map<AiUsageProviderKey, AiUsageQuotaRow[]>();
      for (const row of filtered) {
        const bucket = byProvider.get(row.providerKey) ?? [];
        bucket.push(row);
        byProvider.set(row.providerKey, bucket);
      }
      return [...byProvider.entries()]
        .sort((left, right) => providerLabel(left[0]).localeCompare(providerLabel(right[0])))
        .map(([key, groupRows]) => ({
          id: `provider:${key}`,
          label: providerLabel(key),
          rows: groupRows,
          kind: 'provider',
          providerKey: key,
        }));
    }

    const byMachine = new Map<string, AiUsageQuotaRow[]>();
    for (const row of filtered) {
      const bucket = byMachine.get(row.machineId) ?? [];
      bucket.push(row);
      byMachine.set(row.machineId, bucket);
    }
    return [...byMachine.entries()]
      .sort((left, right) => left[1][0]!.machineName.localeCompare(right[1][0]!.machineName))
      .map(([machineId, groupRows]) => ({
        id: `machine:${machineId}`,
        label: groupRows[0]!.machineName,
        rows: groupRows,
        kind: 'machine',
        machineName: groupRows[0]!.machineName,
        online: groupRows.some((row) => row.machineOnline),
      }));
  }, [filtered, groupBy]);

  return (
    <section {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 {...stylex.props(styles.sectionTitle)}>
          {t('settings.aiUsage.quota.title', 'Live quota')}
        </h2>
        {onRefresh ? (
          <Button variant="ghost" size="mini" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" size={14} />
            {t('settings.aiUsage.quota.refresh', 'Refresh')}
          </Button>
        ) : null}
      </div>

      <div {...stylex.props(styles.quotaControls)}>
        <div
          role="tablist"
          aria-label={t('settings.aiUsage.quota.groupBy', 'Group quota by')}
          {...stylex.props(styles.groupToggle)}
        >
          {(['provider', 'machine'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={groupBy === value}
              onClick={() => setGroupBy(value)}
              {...stylex.props(
                styles.groupToggleButton,
                groupBy === value && styles.groupToggleSelected
              )}
            >
              {value === 'provider'
                ? t('settings.aiUsage.quota.byProvider', 'Provider')
                : t('settings.aiUsage.quota.byMachine', 'Machine')}
            </button>
          ))}
        </div>

        <Select.Root
          items={providerItems}
          value={providerFilter}
          onValueChange={(value) => setProviderFilter(value ?? 'all')}
        >
          <div {...stylex.props(styles.select)}>
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
          </div>
          <Select.Content>
            {providerItems.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                {item.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>

        <Select.Root
          items={machineItems}
          value={machineFilter}
          onValueChange={(value) => setMachineFilter(value ?? 'all')}
        >
          <div {...stylex.props(styles.select)}>
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
          </div>
          <Select.Content>
            {machineItems.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                {item.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>

        <button
          type="button"
          aria-pressed={belowTwenty}
          onClick={() => setBelowTwenty((value) => !value)}
          {...stylex.props(styles.filterButton, belowTwenty && styles.filterButtonSelected)}
        >
          {t('settings.aiUsage.quota.belowTwenty', 'Below 20%')}
        </button>

        <div {...stylex.props(styles.searchBox)}>
          <Input
            size="small"
            value={query}
            aria-label={t('settings.aiUsage.quota.search', 'Search quota')}
            placeholder={t('settings.aiUsage.quota.searchPlaceholder', 'Search')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div {...stylex.props(styles.card)}>
          <p {...stylex.props(styles.emptyNote)}>
            {loading
              ? t('settings.aiUsage.quota.loading', 'Loading Providers...')
              : t('settings.aiUsage.quota.empty', 'No visible Providers.')}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div {...stylex.props(styles.card)}>
          <p {...stylex.props(styles.emptyNote)}>
            {t('settings.aiUsage.quota.noMatch', 'No Providers match these filters.')}
          </p>
        </div>
      ) : (
        groups.map((group) => {
          const GroupIcon = group.kind === 'provider' ? null : machineIcon(group.label);
          return (
            <div key={group.id} {...stylex.props(styles.section)}>
              <div {...stylex.props(styles.groupHead)}>
                {group.kind === 'provider' && group.providerKey ? (
                  <span
                    {...stylex.props(styles.groupIcon)}
                    style={{ color: providerColor(group.providerKey) }}
                  >
                    <ModelBrandIcon modelId={group.providerKey} className="h-4 w-4" />
                  </span>
                ) : GroupIcon ? (
                  <span {...stylex.props(styles.groupIcon)}>
                    <GroupIcon aria-hidden="true" size={16} />
                  </span>
                ) : null}
                <span {...stylex.props(styles.groupTitle)}>{group.label}</span>
                <span {...stylex.props(styles.groupCount)}>
                  {group.kind === 'machine' && group.online === false
                    ? t('settings.aiUsage.quota.offline', 'Offline')
                    : null}
                  {group.kind === 'machine' && group.online === false ? ' · ' : null}
                  {t('settings.aiUsage.quota.configCount', '{{count}} configs', {
                    count: group.rows.length,
                  })}
                </span>
              </div>

              <div {...stylex.props(styles.card, styles.quotaCard)}>
                {group.rows.map((row, index) => {
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
                          <div {...stylex.props(styles.providerName)}>
                            {row.providerName}
                            {row.planName ? (
                              <span {...stylex.props(styles.plan)}>{row.planName}</span>
                            ) : null}
                          </div>
                          <div {...stylex.props(styles.providerMeta)}>
                            {groupBy === 'provider' ? (
                              <span {...stylex.props(styles.machineChip)}>
                                <span {...stylex.props(styles.machineChipIcon)}>
                                  {(() => {
                                    const MachineIcon = machineIcon(row.machineName);
                                    return <MachineIcon aria-hidden="true" size={10} />;
                                  })()}
                                </span>
                                <span {...stylex.props(styles.providerMetaText)}>
                                  {row.machineName}
                                </span>
                              </span>
                            ) : null}
                            {!row.machineOnline ? (
                              <span {...stylex.props(styles.providerMetaText)}>
                                {t('settings.aiUsage.quota.offline', 'Offline')}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div {...stylex.props(styles.quotaWindows)}>
                        <ProviderQuotaWindows row={row} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

export function AiUsageSettingsView({
  surface = 'all',
  quotaRows,
  quotaLoading,
  onRefreshQuota,
  byModelBuckets = [],
  byMemberBuckets = [],
  usageLoading,
  providerRows,
  waitingRows = [],
  onCancelWaiting,
  onOpenWaitingSession,
  onViewQueue,
}: AiUsageSettingsViewProps) {
  const { t, i18n } = useTranslation();
  const intlLocale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const [dimension, setDimension] = useState<'model' | 'member'>('model');
  const activeBuckets = dimension === 'member' ? byMemberBuckets : byModelBuckets;
  const activeTitle =
    dimension === 'member'
      ? t('settings.aiUsage.usage.byMember', 'By member')
      : t('settings.aiUsage.usage.byModel', 'By model');

  return (
    <div {...stylex.props(styles.page)}>
      {surface !== 'quota' && (byModelBuckets.length > 0 || byMemberBuckets.length > 0) ? (
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

      {surface === 'all' && waitingRows.length > 0 ? (
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

      {surface !== 'usage' ? (
        <>
          {quotaRows.some(
            (row) => row.machineOnline && row.windows.some((window) => window.remainingPercent <= 0)
          ) ? (
            <div {...stylex.props(styles.notice)}>
              <span {...stylex.props(styles.noticeIcon)}>
                <AlertTriangle aria-hidden="true" size={16} />
              </span>
              <span {...stylex.props(styles.noticeText)}>
                {t(
                  'settings.aiUsage.overview.exhausted',
                  '{{count}} configurations have an exhausted quota window. Check their reset times.',
                  {
                    count: quotaRows.filter(
                      (row) =>
                        row.machineOnline &&
                        row.windows.some((window) => window.remainingPercent <= 0)
                    ).length,
                  }
                )}
              </span>
            </div>
          ) : null}
          <LiveQuotaSection rows={quotaRows} loading={quotaLoading} onRefresh={onRefreshQuota} />
        </>
      ) : null}

      {surface === 'all' && providerRows.length > 0 ? (
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

      {surface === 'all' && waitingRows.length > 0 ? (
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
