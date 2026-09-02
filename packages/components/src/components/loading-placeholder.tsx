import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Holds the indicator at opacity 0 for 300ms, then fades it in.
 *
 * A route-chunk fallback has to paint `bg-background` on frame one — that is
 * what keeps a lazy layout from showing the bare `<body>` canvas — but most
 * chunk loads settle well under 300ms, and a spinner that appears and vanishes
 * inside that window reads worse than the quiet canvas it replaced. The delay
 * is CSS, not React state, so the deferral costs no timer and no re-render.
 *
 * `fill-mode-both` is what applies the animation's `from` state (opacity 0)
 * during the delay. Under `prefers-reduced-motion: reduce` the global reset in
 * `tailwind/index.css` collapses the duration but leaves the delay, so the
 * indicator simply appears after 300ms without the fade.
 */
const DEFERRED_INDICATOR_CLASS = 'animate-in fade-in duration-300 delay-300 fill-mode-both ease-out';

export function LoadingPlaceholder({
  title = 'Loading',
  description = '',
  variant = 'viewport',
  deferIndicator = false,
}: {
  title?: string;
  description?: string;
  /**
   * `viewport` is reserved for boot/auth gates where no application shell is
   * safe to show yet. `content` fills an already-mounted workspace pane so the
   * sidebar and workspace identity remain stable during scoped synchronization.
   */
  variant?: 'viewport' | 'content';
  /**
   * Paints the surface immediately but fades the spinner and copy in after a
   * short delay. Use it wherever the wait is usually imperceptible — a lazy
   * route chunk — and keep it off where the wait is known to be real (signing
   * in, loading workspaces), because there the label is the point.
   */
  deferIndicator?: boolean;
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
        className={cn(
          'flex max-w-sm flex-col items-center gap-3 text-center',
          deferIndicator && DEFERRED_INDICATOR_CLASS
        )}
        data-loading-placeholder-deferred={deferIndicator ? '' : undefined}
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
