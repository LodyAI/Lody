import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';

export function ProviderProgressButton({
  label,
  percent,
  ariaLabel,
  className,
}: {
  label: string;
  percent?: number | null;
  ariaLabel?: string;
  className?: string;
}) {
  const boundedPercent =
    typeof percent === 'number' ? Math.min(100, Math.max(0, Math.round(percent))) : null;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled
      aria-label={ariaLabel}
      className={cn('relative min-w-[4.5rem] overflow-hidden disabled:opacity-100', className)}
    >
      {boundedPercent !== null ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 border-r border-primary/30 bg-primary/20 transition-[width] duration-300"
          style={{ width: `${boundedPercent}%` }}
        />
      ) : null}
      <span className="relative z-10 tabular-nums">{label}</span>
    </Button>
  );
}
