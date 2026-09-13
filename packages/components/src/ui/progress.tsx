import * as React from 'react';

import { cn } from '@/lib/utils';

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
  /**
   * For work with no known total. The bar sweeps instead of reporting a
   * position, and exposes no `aria-valuenow`, so neither the UI nor assistive
   * technology implies a measured percentage.
   */
  indeterminate?: boolean;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, max = 100, indeterminate, ...props }, ref) => {
    const percentage = Math.min(100, Math.max(0, (value / max) * 100));

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : value}
        aria-valuemin={0}
        aria-valuemax={max}
        className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/20', className)}
        {...props}
      >
        {indeterminate ? (
          <div className="h-full w-1/3 rounded-full bg-primary animate-progress-sweep" />
        ) : (
          <div
            className="h-full bg-primary transition-all duration-200"
            style={{ width: `${percentage}%` }}
          />
        )}
      </div>
    );
  }
);
Progress.displayName = 'Progress';

export { Progress };
