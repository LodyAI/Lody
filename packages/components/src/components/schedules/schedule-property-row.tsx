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

/**
 * Right-aligned ghost control, matching the property-row triggers elsewhere.
 *
 * Alignment contract for every row: the last VISIBLE mark (text, chevron, or a
 * solid control such as a switch or the day toggles) ends on the row's inner
 * padding line. A ghost control's own `px-2` is transparent, so when it ends a
 * row it bleeds that padding into the gutter (`last:-mr-2`); a solid control
 * does not. The bleed widens the `max-w-full` cap by the same amount, or the
 * value truncates by exactly the bled 8px. Without this the chevrons, menu labels and switch each stopped at a
 * different x and the right edge read as ragged.
 */
export const ghostValueClass =
  'flex h-8 last:-mr-2 last:max-w-[calc(100%+0.5rem)] min-w-0 max-w-full items-center justify-end gap-1.5 rounded-md bg-transparent px-2 text-[0.9em] font-normal text-foreground transition-colors hover:bg-foreground/[0.05] dark:hover:bg-white/[0.08] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-foreground/[0.05] dark:data-[state=open]:bg-white/[0.08]';

/** One chevron for every menu trigger in the editor, so the right edge is one line. */
export const scheduleChevronClass = 'size-3.5 shrink-0 opacity-50';

export const ghostSelectTriggerClass = cn(
  ghostValueClass,
  // Radix renders a hidden native <select> after the trigger inside a form, so
  // the trigger is never `:last-child`; it always ends its row, so bleed here.
  '-mr-2 max-w-[calc(100%+0.5rem)] w-auto shrink-0 border-0 py-0 shadow-none data-placeholder:text-muted-foreground [&>span]:truncate [&>svg]:size-3.5 [&>svg]:opacity-50'
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
      <div className="flex min-h-7 items-center gap-2 px-3">
        <h2 className="text-[0.8em] font-normal text-muted-foreground">{title}</h2>
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
  // A hint or a multi-line control makes the row taller than its first line;
  // centring the label then parks it between the control and the hint. Pin it
  // to the control's first line instead: controls sit in a 32px (`min-h-8`)
  // line, so `pt-1.5` centres a 1em label on it, and the 28px day toggles need
  // `pt-1`.
  const top = align === 'start' || !!hint;
  return (
    <div
      className={cn(
        'flex min-h-11 flex-col gap-1 px-3 py-1 sm:grid sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)] sm:gap-3',
        top ? 'sm:items-start' : 'sm:items-center'
      )}
    >
      <span
        className={cn(
          'min-w-0 truncate text-[0.9em] text-muted-foreground',
          align === 'start' ? 'sm:pt-1' : hint ? 'sm:pt-1.5' : undefined
        )}
      >
        {label}
      </span>
      <div className="flex min-w-0 flex-col items-end gap-0.5">
        <div className="flex min-h-8 min-w-0 max-w-full flex-wrap items-center justify-end">
          {children}
        </div>
        {hint ? (
          <p className="pb-1 text-right text-[0.8em] leading-tight text-muted-foreground">{hint}</p>
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
  // `pr-1`, not `pr-3`: the menu trigger's own `px-2` is the other 8px, so its
  // label and chevron end on the same line as every other row.
  return (
    <div className="flex min-h-11 flex-col gap-1 py-1 pl-3 pr-1 sm:grid sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)] sm:items-center sm:gap-3">
      <span className="min-w-0 truncate text-[0.9em] text-muted-foreground">{label}</span>
      <div className="flex min-w-0 justify-end [&>*]:min-w-0 [&>*]:max-w-full">{children}</div>
    </div>
  );
}
