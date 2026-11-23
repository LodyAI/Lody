import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/* Shared mobile form-row primitives for the settings sub-pages. They
   render the home-style "section heading + rounded card + divided
   rows" pattern (see `MobileChatListCard` for the list-side analogue)
   so each settings sub-page can ditch the desktop-oriented
   `CompactSection` / `CompactRow` grid on mobile and keep the same
   visual family as the rest of the mobile app.
   Pure-render — no isMobile gating here. Sub-pages decide whether to
   render the mobile or the desktop layout. */

export type MobileSettingsSectionProps = {
  title?: ReactNode;
  description?: ReactNode;
  /** Optional action chip(s) (`...`) rendered next to the heading. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Drops the rounded card frame, e.g. for sections that need to
     render their own custom container (a list of rows that are not
     inside a single card, etc.). */
  noCard?: boolean;
};

export function MobileSettingsSection({
  title,
  description,
  actions,
  children,
  className,
  noCard = false,
}: MobileSettingsSectionProps) {
  return (
    <section className={cn('mt-5 first:mt-3', className)}>
      {title || actions ? (
        <header className="px-5 pb-1.5">
          <div className="flex items-center justify-between gap-2">
            {title ? (
              <h2 className="min-w-0 text-[0.82rem] font-normal text-muted-foreground">
                {title}
              </h2>
            ) : (
              <span />
            )}
            {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
          </div>
          {/* Description gets its own full-width line under the title/action
             row — squeezing it into the title column wrapped it to 3+ lines
             next to wide actions (e.g. the CLI Token "Create token" button)
             on narrow viewports. */}
          {description ? (
            <p className="mt-0.5 text-[0.78rem] text-muted-foreground/80">{description}</p>
          ) : null}
        </header>
      ) : null}
      {noCard ? (
        children
      ) : (
        <div className="mx-3 overflow-hidden rounded-2xl border border-border/60 bg-card">
          {children}
        </div>
      )}
    </section>
  );
}

export type MobileSettingsRowProps = {
  /** Leading label text. Required because rows without a label read
     as random standalone controls — wrap a label-less control in a
     bare `<div>` inside the card instead. */
  label: ReactNode;
  /** Secondary line under the label (helper text). Optional. */
  helper?: ReactNode;
  /** The control (Switch, Select trigger, button, text value, etc.).
     Aligned to the right of the row on a single line by default;
     pass `stack` to drop it below the label instead. */
  children?: ReactNode;
  /** Render the control under the label rather than to the right.
     Use for wider controls (a long Select trigger, a textarea, a
     row of chips) where a side-by-side layout would clip. */
  stack?: boolean;
  /** Renders a top-border divider — set by `MobileSettingsRowGroup`
     on every row after the first. Manual callers should pass it
     themselves. */
  hasDivider?: boolean;
  /** Optional click handler — when present the row is rendered as a
     button with an `active:bg-muted/40` press state. */
  onClick?: () => void;
  /** Trailing chevron (or other icon) rendered to the right of the
     control. Common for drill-into rows. */
  trailing?: ReactNode;
  className?: string;
};

export function MobileSettingsRow({
  label,
  helper,
  children,
  stack = false,
  hasDivider = false,
  onClick,
  trailing,
  className,
}: MobileSettingsRowProps) {
  /* The label column always wraps in `min-w-0 flex-1` so long labels
     truncate or wrap instead of pushing the control off-screen. The
     control column is `shrink-0` so it stays sized to its content
     against narrow viewports. */
  const body = (
    <div
      className={cn(
        'flex gap-3 px-4 py-3',
        stack ? 'flex-col items-stretch' : 'items-center',
        className
      )}
    >
      <div className="min-w-0 flex-1">
        {typeof label === 'string' ? (
          <p className="text-[0.95rem] font-normal leading-tight text-foreground">{label}</p>
        ) : (
          label
        )}
        {helper ? (
          typeof helper === 'string' ? (
            <p className="mt-0.5 text-[0.78rem] leading-tight text-muted-foreground">{helper}</p>
          ) : (
            <div className="mt-0.5 text-[0.78rem] leading-tight text-muted-foreground">
              {helper}
            </div>
          )
        ) : null}
      </div>
      {children != null && !stack ? (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      ) : null}
      {trailing != null && !stack ? (
        <div className="shrink-0 text-muted-foreground/60">{trailing}</div>
      ) : null}
    </div>
  );

  const stackedControl =
    children != null && stack ? (
      <div className={cn('px-4 pb-3', !label && '-mt-1')}>{children}</div>
    ) : null;

  const wrapperClass = cn(hasDivider && 'border-t border-border');

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn('block w-full text-left transition-colors active:bg-muted/40', wrapperClass)}
      >
        {body}
        {stackedControl}
      </button>
    );
  }

  return (
    <div className={wrapperClass}>
      {body}
      {stackedControl}
    </div>
  );
}

/* Convenience wrapper that auto-applies `hasDivider` to every row
   after the first, so callers don't have to thread the index
   themselves. Just put `<MobileSettingsRow>` children inside and
   they'll get the divider for free. */
export function MobileSettingsRowGroup({ children }: { children: ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <>
      {items
        .filter((node) => node != null && node !== false)
        .map((node, index) => {
          if (typeof node !== 'object' || node === null || !('props' in node)) {
            return node;
          }
          const element = node as { props: Record<string, unknown>; key?: string | number | null };
          const existingDivider = element.props.hasDivider as boolean | undefined;
          return (
            <RowWithDivider key={element.key ?? index} hasDivider={existingDivider ?? index > 0}>
              {node}
            </RowWithDivider>
          );
        })}
    </>
  );
}

/* Helper that injects `hasDivider` into a child `<MobileSettingsRow>`
   without forcing the caller to use `React.cloneElement` themselves. */
function RowWithDivider({ hasDivider, children }: { hasDivider: boolean; children: ReactNode }) {
  if (
    typeof children !== 'object' ||
    children === null ||
    !('type' in children) ||
    children.type !== MobileSettingsRow
  ) {
    return <>{children}</>;
  }
  const element = children as React.ReactElement<MobileSettingsRowProps>;
  return <MobileSettingsRow {...element.props} hasDivider={hasDivider} />;
}
