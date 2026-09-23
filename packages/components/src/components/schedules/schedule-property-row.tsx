import type { ReactNode } from 'react';
import { SETTINGS_ROW_CARD_CLASS } from '@/components/settings/compact-layout';
import { cn } from '@/lib/utils';

/**
 * The schedule editor's one layout primitive.
 *
 * A grouped card of quiet rows — label on the left, the live value on the
 * right — so Frequency and Run configuration read as the same object rather
 * than as two unrelated forms. Rows appear only when they apply, which is what
 * keeps the surface short without hiding anything behind a mode switch.
 */
export const scheduleCardClass = cn(
  SETTINGS_ROW_CARD_CLASS,
  'divide-y divide-border/60 overflow-hidden'
);

/** Right-aligned ghost control, matching the property-row triggers elsewhere. */
export const ghostValueClass =
  'flex h-8 min-w-0 max-w-full items-center justify-end gap-1.5 rounded-md bg-transparent px-2 text-[1em] font-normal text-foreground transition-colors hover:bg-foreground/[0.05] dark:hover:bg-white/[0.08] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-foreground/[0.05] dark:data-[state=open]:bg-white/[0.08]';

export const ghostSelectTriggerClass = cn(
  ghostValueClass,
  'w-auto shrink-0 border-0 py-0 shadow-none data-placeholder:text-muted-foreground [&>span]:truncate'
);

export function ScheduleSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex min-h-5 items-center gap-2 px-1">
        <h2 className="text-[0.75em] font-normal text-muted-foreground">{title}</h2>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      <div className={scheduleCardClass}>{children}</div>
    </section>
  );
}

/**
 * Label left, control right.
 *
 * Both tracks are content-driven and both may shrink, the same contract as
 * `settings/compact-layout.tsx`. A schedule editor renders inside a panel far
 * narrower than the window, and a viewport breakpoint cannot see that panel — a
 * column sized from `sm:` would keep its desktop width in a narrow side panel
 * and push the control past the clipped edge. The row stacks below `sm` only to
 * switch layout, never to size a column.
 *
 * The label track is `minmax(0,auto)` and the control track `minmax(0,1fr)`,
 * which is load-bearing in both directions: a hugging control track let the
 * seven weekday toggles take the whole row and truncate the label away, while a
 * hugging label track lets a long translated label ("上一次运行仍在进行时")
 * take the row instead. Wide controls wrap inside their own track.
 */
export function PropertyRow({
  label,
  hint,
  children,
  align = 'center',
}: {
  label: string;
  /** Small explanation under the value; only for rows that genuinely need one. */
  hint?: string;
  children: ReactNode;
  align?: 'center' | 'start';
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 px-3 py-1.5 sm:grid sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)] sm:gap-3',
        align === 'center' ? 'sm:items-center' : 'sm:items-start'
      )}
    >
      <span
        className={cn(
          'min-w-0 truncate text-[1em] text-muted-foreground',
          align === 'start' && 'sm:pt-2'
        )}
      >
        {label}
      </span>
      <div className="flex min-w-0 flex-col items-end gap-0.5">
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end">{children}</div>
        {hint ? (
          <p className="text-right text-[0.8em] leading-tight text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Row for a control that owns the remaining width (Agent, Project).
 *
 * Here the LABEL hugs and the control absorbs the rest, because those two
 * controls are the shared composer menus: they are `w-full` and truncate their
 * own value, so giving them the slack is what keeps a long agent or repository
 * name readable instead of clipped.
 */
export function PropertyRowWide({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-1.5 pl-3 pr-1 sm:grid sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)] sm:items-center sm:gap-3">
      <span className="min-w-0 truncate text-[1em] text-muted-foreground">{label}</span>
      <div className="flex min-w-0 justify-end [&>*]:min-w-0 [&>*]:max-w-full">{children}</div>
    </div>
  );
}
