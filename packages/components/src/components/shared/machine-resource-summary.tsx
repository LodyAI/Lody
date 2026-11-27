import * as stylex from '@stylexjs/stylex';
import type { LodyMachinePresenceResources } from '@lody/shared';
import { Cpu, HardDrive, MemoryStick } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

type MetricTone = 'normal' | 'warning' | 'critical';

/** 1 TiB expressed in 0.1 GiB integer units (1024 * 10). */
const TIB_IN_TENTHS_GIB = 10_240;

const styles = stylex.create({
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[2],
    rowGap: '2px',
    fontSize: '11px',
    lineHeight: '15px',
    fontWeight: 400,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
  },
  item: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    whiteSpace: 'nowrap',
  },
  icon: {
    width: '11px',
    height: '11px',
    flexShrink: 0,
    color: colors.tertiaryLabel,
  },
  valueWarning: {
    color: colors.warning,
    fontWeight: 500,
  },
  valueCritical: {
    color: colors.destructive,
    fontWeight: 500,
  },
  iconWarning: {
    color: colors.warning,
  },
  iconCritical: {
    color: colors.destructive,
  },
  suffix: {
    color: colors.tertiaryLabel,
  },
});

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value >= 100) return `${Math.round(value)}`;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

function pickUnit(tenthsGiB: number): { divisor: number; suffix: string } {
  if (tenthsGiB >= TIB_IN_TENTHS_GIB) return { divisor: TIB_IN_TENTHS_GIB, suffix: 'T' };
  return { divisor: 10, suffix: 'G' };
}

function formatTenthsGiBPair(numeratorTenthsGiB: number, totalTenthsGiB: number): string {
  const safeNum = Math.max(0, numeratorTenthsGiB);
  const safeTotal = Math.max(1, totalTenthsGiB);
  const totalUnit = pickUnit(safeTotal);
  const numUnit = pickUnit(safeNum);
  if (safeNum === 0 || numUnit.suffix === totalUnit.suffix) {
    const numVal = safeNum / totalUnit.divisor;
    const totalVal = safeTotal / totalUnit.divisor;
    return `${formatCompactNumber(numVal)}/${formatCompactNumber(totalVal)}${totalUnit.suffix}`;
  }
  return `${formatCompactNumber(safeNum / numUnit.divisor)}${numUnit.suffix}/${formatCompactNumber(safeTotal / totalUnit.divisor)}${totalUnit.suffix}`;
}

function getCpuTone(cpuPercent: number, logicalCores: number): MetricTone {
  const capacity = Math.max(1, logicalCores) * 100;
  const ratio = cpuPercent / capacity;
  if (ratio >= 0.95) return 'critical';
  if (ratio >= 0.85) return 'warning';
  return 'normal';
}

function getMemoryTone(usedTenthsGiB: number, totalTenthsGiB: number): MetricTone {
  if (totalTenthsGiB <= 0) return 'normal';
  const ratio = usedTenthsGiB / totalTenthsGiB;
  if (ratio >= 0.95) return 'critical';
  if (ratio >= 0.85) return 'warning';
  return 'normal';
}

function getDiskTone(freeTenthsGiB: number, totalTenthsGiB: number): MetricTone {
  if (totalTenthsGiB <= 0) return 'normal';
  const freeRatio = freeTenthsGiB / totalTenthsGiB;
  if (freeRatio <= 0.05 || freeTenthsGiB < 50) return 'critical';
  if (freeRatio <= 0.1 || freeTenthsGiB < 150) return 'warning';
  return 'normal';
}

export function formatMachineResourceText(
  resources: LodyMachinePresenceResources,
  freeSuffix = 'free'
): string {
  const cpuPercent = Math.max(0, Math.round(resources.cp));
  const cpuCores = Math.max(1, Math.round(resources.cc));
  const memText = formatTenthsGiBPair(resources.mu, resources.mt);
  const hasDisk =
    typeof resources.df === 'number' && typeof resources.dt === 'number' && resources.dt > 0;
  if (!hasDisk) {
    return `${cpuPercent}%/${cpuCores}c · ${memText}`;
  }
  const diskText = formatTenthsGiBPair(resources.df!, resources.dt!);
  return `${cpuPercent}%/${cpuCores}c · ${memText} · ${diskText} ${freeSuffix}`;
}

export function MachineResourceSummary({
  resources,
  xstyle,
}: {
  resources: LodyMachinePresenceResources;
  xstyle?: stylex.StyleXStyles;
}) {
  const { t } = useTranslation();
  const cpuPercent = Math.max(0, Math.round(resources.cp));
  const cpuCores = Math.max(1, Math.round(resources.cc));
  const cpuTone = getCpuTone(cpuPercent, cpuCores);
  const memTone = getMemoryTone(resources.mu, resources.mt);
  const hasDisk =
    typeof resources.df === 'number' && typeof resources.dt === 'number' && resources.dt > 0;
  const diskTone = hasDisk ? getDiskTone(resources.df!, resources.dt!) : 'normal';

  const memText = formatTenthsGiBPair(resources.mu, resources.mt);
  const diskText = hasDisk ? formatTenthsGiBPair(resources.df!, resources.dt!) : null;

  return (
    <span {...stylex.props(styles.row, xstyle)}>
      <span
        {...stylex.props(
          styles.item,
          cpuTone === 'warning' && styles.valueWarning,
          cpuTone === 'critical' && styles.valueCritical
        )}
        title={t('chat.machineSelector.cpuTitle', 'CPU usage {{percent}}% across {{cores}} cores', {
          percent: cpuPercent,
          cores: cpuCores,
        })}
      >
        <Cpu
          {...stylex.props(
            styles.icon,
            cpuTone === 'warning' && styles.iconWarning,
            cpuTone === 'critical' && styles.iconCritical
          )}
          aria-hidden="true"
        />
        <span>
          {cpuPercent}%/{cpuCores}c
        </span>
      </span>

      <span
        {...stylex.props(
          styles.item,
          memTone === 'warning' && styles.valueWarning,
          memTone === 'critical' && styles.valueCritical
        )}
        title={t('chat.machineSelector.memoryTitle', 'Memory used: {{pair}}', { pair: memText })}
      >
        <MemoryStick
          {...stylex.props(
            styles.icon,
            memTone === 'warning' && styles.iconWarning,
            memTone === 'critical' && styles.iconCritical
          )}
          aria-hidden="true"
        />
        <span>{memText}</span>
      </span>

      {diskText ? (
        <span
          {...stylex.props(
            styles.item,
            diskTone === 'warning' && styles.valueWarning,
            diskTone === 'critical' && styles.valueCritical
          )}
          title={t('chat.machineSelector.diskTitle', 'Disk available: {{pair}}', {
            pair: diskText,
          })}
        >
          <HardDrive
            {...stylex.props(
              styles.icon,
              diskTone === 'warning' && styles.iconWarning,
              diskTone === 'critical' && styles.iconCritical
            )}
            aria-hidden="true"
          />
          <span>
            {diskText}{' '}
            <span {...stylex.props(diskTone === 'normal' && styles.suffix)}>
              {t('chat.machineSelector.diskFreeSuffix', 'free')}
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}
