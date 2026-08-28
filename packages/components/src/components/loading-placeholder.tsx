import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function LoadingPlaceholder({
  title = 'Loading',
  description = '',
  variant = 'viewport',
}: {
  title?: string;
  description?: string;
  /**
   * `viewport` is reserved for boot/auth gates where no application shell is
   * safe to show yet. `content` fills an already-mounted workspace pane so the
   * sidebar and workspace identity remain stable during scoped synchronization.
   */
  variant?: 'viewport' | 'content';
}) {
  return (
    <div
      className={cn(
        'flex w-full items-center justify-center bg-background p-6 text-muted-foreground',
        variant === 'viewport' ? 'min-h-[100dvh]' : 'h-full min-h-0'
      )}
      data-loading-placeholder-scope={variant}
    >
      <div
        className="flex max-w-sm flex-col items-center gap-3 text-center"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description ? (
            <div className="mx-auto max-w-[320px] text-xs leading-5">{description}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
