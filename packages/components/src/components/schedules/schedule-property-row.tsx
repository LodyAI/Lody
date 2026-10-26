import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { settingsCard } from '@/components/settings/compact-layout';
import { withClassName } from '@/lib/stylex';
import { cn } from '@/lib/utils';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  card: { overflow: 'hidden' },
  ghostValue: {
    display: 'flex',
    height: themeSpace[8],
    marginRight: { default: null, ':last-child': 'calc(var(--spacing) * -2)' },
    minWidth: 0,
    maxWidth: { default: '100%', ':last-child': 'calc(100% + 0.5rem)' },
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: themeSpace[1.5],
    borderRadius: themeRadius.md,
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground) / 0.05)' },
    },
    paddingInline: themeSpace[2],
    fontSize: '0.9em',
    fontWeight: themeFontWeight.normal,
    color: themeColors.foreground,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
    cursor: { default: null, ':disabled': 'not-allowed' },
    opacity: { default: null, ':disabled': 0.5 },
  },
  row: {
    display: { default: 'flex', '@media (min-width: 40rem)': 'grid' },
    minHeight: themeSpace[11],
    flexDirection: 'column',
    gap: { default: themeSpace[1], '@media (min-width: 40rem)': themeSpace[3] },
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[1],
    gridTemplateColumns: {
      default: null,
      '@media (min-width: 40rem)': 'minmax(0,auto) minmax(0,1fr)',
    },
  },
  rowTop: { alignItems: { default: null, '@media (min-width: 40rem)': 'flex-start' } },
  rowCenter: { alignItems: { default: null, '@media (min-width: 40rem)': 'center' } },
  label: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.9em',
    color: themeColors.mutedForeground,
  },
  labelStart: { paddingTop: { default: null, '@media (min-width: 40rem)': themeSpace[1] } },
  labelHint: { paddingTop: { default: null, '@media (min-width: 40rem)': themeSpace[1.5] } },
  values: {
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: themeSpace[0.5],
  },
  controls: {
    display: 'flex',
    minHeight: themeSpace[8],
    minWidth: 0,
    maxWidth: '100%',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  hint: {
    paddingBottom: themeSpace[1],
    textAlign: 'right',
    fontSize: '0.8em',
    lineHeight: 'var(--leading-tight)',
    color: themeColors.mutedForeground,
  },
  wideRow: {
    display: { default: 'flex', '@media (min-width: 40rem)': 'grid' },
    minHeight: 'calc(var(--spacing) * 11)',
    flexDirection: 'column',
    gap: {
      default: 'calc(var(--spacing) * 1)',
      '@media (min-width: 40rem)': 'calc(var(--spacing) * 3)',
    },
    paddingBlock: 'calc(var(--spacing) * 1)',
    paddingLeft: 'calc(var(--spacing) * 3)',
    paddingRight: 'calc(var(--spacing) * 1)',
    gridTemplateColumns: {
      default: null,
      '@media (min-width: 40rem)': 'minmax(0,auto) minmax(0,1fr)',
    },
    alignItems: { default: null, '@media (min-width: 40rem)': 'center' },
  },
  wideLabel: { color: 'hsl(var(--muted-foreground) / 1)' },
  wideControls: { display: 'flex', minWidth: 0, justifyContent: 'flex-end' },
});

/**
 * The schedule editor's one layout primitive.
 *
 * A grouped card of quiet rows — label on the left, the live value on the
 * right — so Frequency and Run configuration read as the same object rather
 * than as two unrelated forms. Rows appear only when they apply, which is what
 * keeps the surface short without hiding anything behind a mode switch.
 */
export function scheduleCardProps(className?: string) {
  // The settings card material (its edge is its shadow), plus layout only.
  return withClassName(
    stylex.props(settingsCard, styles.card),
    cn('divide-y divide-border/60', className)
  );
}

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
export const ghostValueClass = cn(
  stylex.props(styles.ghostValue).className,
  'dark:hover:bg-white/[0.08] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-foreground/[0.05] dark:data-[state=open]:bg-white/[0.08]'
);

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
    <div {...stylex.props(styles.row, top ? styles.rowTop : styles.rowCenter)}>
      <span
        {...stylex.props(
          styles.label,
          align === 'start' ? styles.labelStart : !!hint && styles.labelHint
        )}
      >
        {label}
      </span>
      <div {...stylex.props(styles.values)}>
        <div {...stylex.props(styles.controls)}>{children}</div>
        {hint ? <p {...stylex.props(styles.hint)}>{hint}</p> : null}
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
    <div {...stylex.props(styles.wideRow)}>
      <span {...stylex.props(styles.label, styles.wideLabel)}>{label}</span>
      <div
        className={cn(
          stylex.props(styles.wideControls).className,
          '[&>*]:min-w-0 [&>*]:max-w-full'
        )}
      >
        {children}
      </div>
    </div>
  );
}
