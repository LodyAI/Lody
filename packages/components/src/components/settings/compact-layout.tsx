import React, { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface CompactSectionProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  /** Free-form content on the right of the header (rendered as-is, unlike
   * `actions` which are coerced into icon buttons). */
  headerRight?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

interface CompactRowProps {
  label: string;
  helper?: ReactNode;
  children?: ReactNode;
  className?: string;
  alignTop?: boolean;
}

export function CompactSection({
  title,
  description,
  actions,
  headerRight,
  children,
  className,
  contentClassName,
}: CompactSectionProps) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-lg border border-border/70 bg-card/60 text-sm shadow-none',
        className
      )}
    >
      {title || headerRight ? (
        <header className="flex min-h-10 items-center justify-between gap-2 border-b border-border/70 bg-muted/40 px-3 py-1.5">
          <div className="min-w-0 flex-1 leading-tight">
            {title ? <p className="text-xs font-semibold text-muted-foreground">{title}</p> : null}
            {description && <p className="text-[11px] text-muted-foreground/90">{description}</p>}
          </div>
          {headerRight ? (
            <div className="min-w-0 shrink truncate text-right text-[11px] text-muted-foreground">
              {headerRight}
            </div>
          ) : null}
          {actions ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {React.Children.map(actions, (child) => {
                if (
                  !React.isValidElement<{
                    size?: string;
                    variant?: string;
                    className?: string;
                  }>(child)
                ) {
                  return child;
                }

                return React.cloneElement(child, {
                  size: child.props.size ?? 'icon',
                  variant: child.props.variant ?? 'default',
                  className: cn(
                    'h-7 w-7 rounded-md shadow-xs focus-visible:ring-1 focus-visible:ring-ring/60',
                    child.props.className
                  ),
                });
              })}
            </div>
          ) : null}
        </header>
      ) : null}
      <div className={cn('divide-y divide-border/60', contentClassName)}>{children}</div>
    </section>
  );
}

export function CompactRow({
  label,
  helper,
  children,
  className,
  alignTop = false,
}: CompactRowProps) {
  return (
    <div
      className={cn(
        // The control column hugs its content and the label column absorbs the rest. Settings
        // render inside a panel that is much narrower than the window, so a column capped at a
        // fixed px width (which a viewport breakpoint cannot see) would eat the whole row and
        // push the control past the panel's clipped edge.
        'flex flex-col gap-2 px-3 py-2 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4',
        alignTop && 'sm:items-start sm:[&>div:last-child]:self-start',
        !alignTop && 'sm:items-center',
        className
      )}
    >
      {/* Helper copy is capped so it stays readable on a wide panel; a bare label is free to
          use the whole column, because long command names should not wrap early. */}
      <div className={cn('min-w-0', helper && 'sm:max-w-[520px]')}>
        <p className="font-medium leading-tight text-foreground">{label}</p>
        {helper && <p className="text-[11px] text-muted-foreground leading-tight">{helper}</p>}
      </div>
      {children ? (
        <div className="min-w-0 flex flex-wrap items-center gap-2 text-sm sm:justify-end sm:pl-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}
