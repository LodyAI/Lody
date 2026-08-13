import type { SVGProps } from 'react';
import { TASK_PRIORITY_VALUES, type TaskPriority } from '@lody/shared';
import {
  LinearPriorityHigh,
  LinearPriorityLow,
  LinearPriorityMedium,
  LinearPriorityNone,
  LinearPriorityUrgent,
} from '@/components/icons/linear-priority-icons';

export type TaskPriorityPresentation = {
  /** `null` is the "no priority" option. */
  priority: TaskPriority | null;
  Icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
  labelKey: string;
  labelFallback: string;
  className: string;
};

/**
 * Linear-style ladder (see `linear-priority-icons.tsx`): three fixed bar slots
 * for none/low/medium/high, circle-bang for urgent. Urgent is the only level
 * that takes color — priority is ambient next to status and counts, and a full
 * rainbow would leave nothing standing out.
 */
const NONE_PRESENTATION: Omit<TaskPriorityPresentation, 'priority'> = {
  Icon: LinearPriorityNone,
  labelKey: 'tasks.priority.none',
  labelFallback: 'No priority',
  className: 'text-muted-foreground',
};

const PRESENTATION: Record<TaskPriority, Omit<TaskPriorityPresentation, 'priority'>> = {
  urgent: {
    Icon: LinearPriorityUrgent,
    labelKey: 'tasks.priority.urgent',
    labelFallback: 'Urgent',
    className: 'text-status-error',
  },
  high: {
    Icon: LinearPriorityHigh,
    labelKey: 'tasks.priority.high',
    labelFallback: 'High',
    className: 'text-muted-foreground',
  },
  medium: {
    Icon: LinearPriorityMedium,
    labelKey: 'tasks.priority.medium',
    labelFallback: 'Medium',
    className: 'text-muted-foreground',
  },
  low: {
    Icon: LinearPriorityLow,
    labelKey: 'tasks.priority.low',
    labelFallback: 'Low',
    className: 'text-muted-foreground',
  },
};

/** Menu order: none first, then most → least urgent. */
export const TASK_PRIORITY_PRESENTATION: readonly TaskPriorityPresentation[] = [
  { priority: null, ...NONE_PRESENTATION },
  ...TASK_PRIORITY_VALUES.map((priority) => ({ priority, ...PRESENTATION[priority] })),
];

export const getTaskPriorityPresentation = (
  priority: TaskPriority | null | undefined
): TaskPriorityPresentation =>
  priority ? { priority, ...PRESENTATION[priority] } : { priority: null, ...NONE_PRESENTATION };
