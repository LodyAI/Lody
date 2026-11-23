import * as stylex from '@stylexjs/stylex';
import type { ComponentType, SVGProps } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Pause } from 'lucide-react';
import { CarbonInProgress } from '@/components/icons/carbon-in-progress';
import type { SessionGoalStatus } from '@lody/shared';

const styles = stylex.create({
  infoInk: { color: 'hsl(var(--status-info))' },
  warningInk: { color: 'hsl(var(--status-warning))' },
  successInk: { color: 'hsl(var(--status-success))' },
  mutedInk: { color: 'hsl(var(--muted-foreground))' },
  infoSurface: { backgroundColor: 'color-mix(in oklab, hsl(var(--status-info)) 10%, transparent)' },
  warningSurface: {
    backgroundColor: 'color-mix(in oklab, hsl(var(--status-warning)) 10%, transparent)',
  },
  successSurface: {
    backgroundColor: 'color-mix(in oklab, hsl(var(--status-success)) 10%, transparent)',
  },
  mutedSurface: { backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)' },
  infoBorder: { borderColor: 'color-mix(in oklab, hsl(var(--status-info)) 30%, transparent)' },
  warningBorder: {
    borderColor: 'color-mix(in oklab, hsl(var(--status-warning)) 30%, transparent)',
  },
  successBorder: {
    borderColor: 'color-mix(in oklab, hsl(var(--status-success)) 30%, transparent)',
  },
  mutedBorder: { borderColor: 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)' },
});

export type GoalStatusIcon = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

export interface GoalStatusPresentation {
  /** i18n key for the human-readable status label. */
  labelKey: string;
  fallbackLabel: string;
  Icon: GoalStatusIcon;
  /** Foreground colour for the icon and label. */
  textStyle: stylex.StyleXStyles;
  /** Tinted surface used by the sticky banner; chat-inline marker can ignore. */
  surfaceStyle: stylex.StyleXStyles;
  /** Bottom-border tint matching the surface. */
  borderStyle: stylex.StyleXStyles;
  /** True when the icon should pulse to signal in-flight work. */
  pulse?: boolean;
}

// Single source of truth so the inline timeline marker (`view.tsx`) and the
// sticky banner (`session-goal-banner.tsx`) cannot drift on icon or colour.
export const GOAL_STATUS_PRESENTATION: Record<SessionGoalStatus, GoalStatusPresentation> = {
  active: {
    labelKey: 'sessions.goal.status.active',
    fallbackLabel: 'Pursuing goal',
    Icon: CarbonInProgress as GoalStatusIcon,
    textStyle: styles.infoInk,
    surfaceStyle: styles.infoSurface,
    borderStyle: styles.infoBorder,
    pulse: true,
  },
  paused: {
    labelKey: 'sessions.goal.status.paused',
    fallbackLabel: 'Goal paused',
    Icon: Pause,
    textStyle: styles.warningInk,
    surfaceStyle: styles.warningSurface,
    borderStyle: styles.warningBorder,
  },
  budgetLimited: {
    labelKey: 'sessions.goal.status.budgetLimited',
    fallbackLabel: 'Goal unmet',
    Icon: AlertTriangle,
    textStyle: styles.warningInk,
    surfaceStyle: styles.warningSurface,
    borderStyle: styles.warningBorder,
  },
  blocked: {
    labelKey: 'sessions.goal.status.blocked',
    fallbackLabel: 'Goal blocked',
    Icon: AlertTriangle,
    textStyle: styles.warningInk,
    surfaceStyle: styles.warningSurface,
    borderStyle: styles.warningBorder,
  },
  usageLimited: {
    labelKey: 'sessions.goal.status.usageLimited',
    fallbackLabel: 'Usage limit reached',
    Icon: AlertTriangle,
    textStyle: styles.warningInk,
    surfaceStyle: styles.warningSurface,
    borderStyle: styles.warningBorder,
  },
  complete: {
    labelKey: 'sessions.goal.status.complete',
    fallbackLabel: 'Goal achieved',
    Icon: CheckCircle2,
    textStyle: styles.successInk,
    surfaceStyle: styles.successSurface,
    borderStyle: styles.successBorder,
  },
  cleared: {
    labelKey: 'sessions.goal.status.cleared',
    fallbackLabel: 'Goal cleared',
    Icon: CircleSlash,
    textStyle: styles.mutedInk,
    surfaceStyle: styles.mutedSurface,
    borderStyle: styles.mutedBorder,
  },
};

export const getGoalStatusPresentation = (
  status: SessionGoalStatus | string | undefined
): GoalStatusPresentation =>
  GOAL_STATUS_PRESENTATION[status as SessionGoalStatus] ?? GOAL_STATUS_PRESENTATION.active;
