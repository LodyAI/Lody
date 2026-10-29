import { useMemo } from 'react';
import { CheckCircle2, Circle, ChevronRight } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';

import type { SessionPlanEntry } from '@lody/shared';

import { CarbonInProgress } from '@/components/icons/carbon-in-progress';
import { Collapsible } from '@lody/ui/collapsible';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  panelSpacing: { marginTop: 'calc(var(--spacing) * 2)' },
  root: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: themeRadius.lg,
    backgroundColor: 'hsl(var(--muted) / 0.3)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
  },
  trigger: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[3],
    textAlign: 'left',
    // The old Tailwind `focus-visible:ring-*` painted nothing — the app forces
    // Tailwind's own ring transparent — but it still declared a `box-shadow`,
    // and a utility-layer shadow beats the base layer's inset focus ring. So
    // the trigger showed NO focus indicator at all. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  summaryRow: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[2],
  },
  summaryText: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
  },
  countRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  count: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  chevron: {
    width: themeSpace[4],
    height: themeSpace[4],
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  list: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.6)',
    paddingTop: themeSpace[2],
  },
  entry: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[1.5],
    paddingBlock: themeSpace[1],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': themeColors.hover },
    },
  },
  entryBody: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  entryText: { overflowWrap: 'break-word', lineHeight: 1.375 },
  entryIconOffset: { marginTop: themeSpace[0.5] },
  icon: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
  iconSuccess: { color: themeColors.statusSuccess },
  iconPrimary: { color: themeColors.primary },
  iconMuted: { color: themeColors.mutedForeground },
});

type SessionPlanBarProps = {
  entries?: SessionPlanEntry[] | null;
  defaultOpen?: boolean;
  /** Controlled open state (overrides defaultOpen). */
  open?: boolean;
  /** Callback when the user toggles open/closed (controlled mode). */
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

type PlanStatus = SessionPlanEntry['status'];

const emptyEntries: SessionPlanEntry[] = [];

const PlanStatusIcon = ({ status, className }: { status: PlanStatus; className?: string }) => {
  switch (status) {
    case 'completed': {
      const iconProps = stylex.props(styles.icon, styles.iconSuccess);
      return <CheckCircle2 {...iconProps} className={clsx(iconProps.className, className)} />;
    }
    case 'in_progress': {
      const iconProps = stylex.props(styles.icon, styles.iconPrimary);
      return <CarbonInProgress {...iconProps} className={clsx(iconProps.className, className)} />;
    }
    case 'pending':
    default: {
      const iconProps = stylex.props(styles.icon, styles.iconMuted);
      return <Circle {...iconProps} className={clsx(iconProps.className, className)} />;
    }
  }
};

const pickSummaryEntry = (entries: SessionPlanEntry[]): SessionPlanEntry | null => {
  if (!entries.length) return null;
  return (
    entries.find((entry) => entry.status === 'in_progress') ??
    entries.find((entry) => entry.status === 'pending') ??
    entries[entries.length - 1] ??
    null
  );
};

export const SessionPlanBar = ({
  entries,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
}: SessionPlanBarProps) => {
  const { t } = useTranslation();
  const safeEntries = entries ?? emptyEntries;

  const summary = useMemo(() => pickSummaryEntry(safeEntries), [safeEntries]);
  const completedCount = useMemo(
    () => safeEntries.filter((entry) => entry.status === 'completed').length,
    [safeEntries]
  );
  const totalCount = safeEntries.length;

  const statusLabel = summary
    ? t(`codexMessage.plan.status.${summary.status}` as const)
    : t('codexMessage.plan.empty', 'Plan cleared');
  const summaryText = summary ? summary.content : t('codexMessage.plan.empty', 'Plan cleared');

  const rootProps = stylex.props(styles.root);
  const triggerProps = stylex.props(styles.trigger);
  const listProps = stylex.props(styles.list);
  const chevronProps = stylex.props(styles.chevron);
  const entryIconOffsetClassName = stylex.props(styles.entryIconOffset).className;

  return (
    <Collapsible.Root defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange}>
      <div {...rootProps} className={clsx(rootProps.className, className)}>
        <Collapsible.Trigger
          render={
            <button
              type="button"
              {...triggerProps}
              // `group` is the marker the chevron's `group-data-[panel-open]`
              // rotation reads; StyleX has no group variant.
              className={clsx(triggerProps.className, 'group')}
            />
          }
        >
          <div {...stylex.props(styles.summaryRow)}>
            <PlanStatusIcon status={summary?.status ?? 'pending'} />
            <span {...stylex.props(styles.summaryText)}>
              {statusLabel}: {summaryText}
            </span>
          </div>
          <div {...stylex.props(styles.countRow)}>
            <span {...stylex.props(styles.count)}>
              {completedCount}/{totalCount}
            </span>
            <ChevronRight
              {...chevronProps}
              className={clsx(chevronProps.className, 'group-data-[panel-open]:rotate-90')}
            />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Panel {...stylex.props(styles.panelSpacing)}>
          {/* The rule and the space above the list ride on a child: the panel's
              own height is what the reveal animates, and Base UI measures it
              with `scrollHeight`, which counts padding. */}
          <ul {...listProps} className={clsx(listProps.className, 'space-y-1')}>
            {safeEntries.map((entry, index) => (
              <li key={`${index}-${entry.content}`} {...stylex.props(styles.entry)}>
                <PlanStatusIcon status={entry.status} className={entryIconOffsetClassName} />
                <div {...stylex.props(styles.entryBody)}>
                  <span {...stylex.props(styles.entryText)}>{entry.content}</span>
                </div>
              </li>
            ))}
          </ul>
        </Collapsible.Panel>
      </div>
    </Collapsible.Root>
  );
};

export default SessionPlanBar;
