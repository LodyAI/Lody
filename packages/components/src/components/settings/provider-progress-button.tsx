import type { ReactNode } from 'react';

import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';

export function ProviderProgressButton({
  label,
  percent,
  ariaLabel,
  title,
  icon,
  onClick,
  className,
}: {
  label: string;
  percent?: number | null;
  ariaLabel?: string;
  title?: string;
  /** Rendered before the label; supplied only when the pill also acts. */
  icon?: ReactNode;
  /**
   * Turns the pill into a real control. Without it the pill is a disabled
   * read-out of work in flight, which is what it is for the whole normal run.
   */
  onClick?: () => void;
  className?: string;
}) {
  const boundedPercent =
    typeof percent === 'number' ? Math.min(100, Math.max(0, Math.round(percent))) : null;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!onClick}
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
      className={cn(
        'relative min-w-[4.5rem] gap-1 overflow-hidden px-2 disabled:opacity-100',
        className
      )}
    >
      {boundedPercent !== null ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 border-r border-primary/30 bg-primary/20 transition-[width] duration-300"
          style={{ width: `${boundedPercent}%` }}
        />
      ) : null}
      {icon !== undefined ? (
        <span aria-hidden="true" className="relative z-10 flex shrink-0 items-center">
          {icon}
        </span>
      ) : null}
      <span className="relative z-10 tabular-nums">{label}</span>
    </Button>
  );
}
