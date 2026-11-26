import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Filter } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

import { cn } from '@/lib/utils';
import { withClassName } from '@/lib/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../style/theme-scale.stylex';
import { MobileFilterDrawer } from './mobile-filter-drawer';

/**
 * Reusable horizontal "filter chip" bar used by mobile views. Each pill
 * represents one filter dimension and opens an animated panel of
 * options beneath the bar when tapped.
 *
 * Two pill shapes are supported:
 *
 * - **single** — radio-style. The pill's label IS the selected
 *   option's label; tap an option to commit + auto-collapse the panel.
 * - **multi** — checkbox-style. The pill keeps its fixed label; tap
 *   options to toggle them in/out of the selection. A small "active"
 *   dot appears on the pill whenever the selection differs from the
 *   pill's `defaultIds` (i.e. "filter applied").
 *
 * The bar is intentionally *unaware* of what each filter does — it
 * just renders chips, manages panel open/close, and emits change
 * callbacks. Consumers wire the pill config + state and apply the
 * resulting filter however makes sense for their data.
 */

export type SingleSelectPill = {
  kind: 'single';
  /** Stable id, used as the React key + to determine which panel is
     open. Must be unique across the bar. */
  id: string;
  /** Fallback label if `selectedId` doesn't match any option (e.g.
     transient state during data refresh). */
  fallbackLabel: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
};

export type MultiSelectPillOption = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Secondary text rendered under the label in a smaller, muted
     font. Use for paths, full names, or any "this is what it
     resolves to" detail that doesn't fit on the same line. */
  description?: ReactNode;
  /** Optional group key. Consecutive options sharing the same group
     value get a single muted section heading rendered above them
     in the dimension page (e.g. machine name above its local
     projects). Options are expected to be pre-sorted by group; the
     renderer doesn't re-group. */
  group?: string;
};

export type MultiSelectPill = {
  kind: 'multi';
  id: string;
  /** Fixed label shown on the pill regardless of selection. */
  label: string;
  options: ReadonlyArray<MultiSelectPillOption>;
  /** Currently-selected option ids. */
  selectedIds: ReadonlySet<string>;
  /** Ids representing the "no filter applied" baseline — usually
     every option. When `selectedIds` equals this set the pill is
     inactive and the active-dot indicator is suppressed. */
  defaultIds: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
};

/**
 * Collapses several `MultiSelectPill`s into one pill that opens a
 * drawer instead of the bar's inline panel. Used when the chip row
 * gets long enough that trailing chips fall off-screen — typically
 * 4+ filter dimensions on a phone — and the user stops noticing
 * them. The drawer presents a summary of active filters first,
 * then a tappable list to drill into each dimension.
 */
export type AggregateFilterPill = {
  kind: 'aggregate';
  id: string;
  /** Text shown on the pill, e.g. "过滤". */
  label: string;
  /** Inner dimensions rendered inside the drawer. */
  pills: ReadonlyArray<MultiSelectPill>;
  /** Optional override for the drawer's header title. Defaults to `label`. */
  drawerTitle?: string;
};

export type FilterPill = SingleSelectPill | MultiSelectPill | AggregateFilterPill;

export type MobileFilterPillBarProps = {
  pills: ReadonlyArray<FilterPill>;
  className?: string;
};

const PANEL_TRANSITION = { duration: 0.18, ease: [0.32, 0.72, 0, 1] as const };

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const DARK_SCOPE =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  root: { position: 'relative' },
  toolbar: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[2],
    overflowX: 'auto',
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[1.5],
  },
  accordion: { overflow: 'hidden' },

  /** A chip in the bar. */
  pill: {
    position: 'relative',
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: themeRadius.full,
    fontSize: '0.78rem',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1,
    letterSpacing: '-0.025em',
    scale: { default: null, ':active': '0.97' },
    ...TRANSITION_COLORS,
  },
  /** The chip that opens the drawer: a wider gap and its own left inset. */
  pillAggregate: {
    gap: themeSpace[2],
    paddingTop: themeSpace[1.5],
    paddingBottom: themeSpace[1.5],
    paddingLeft: themeSpace[3],
    paddingRight: themeSpace[2.5],
  },
  /** The chip that opens the inline panel. */
  pillSingle: {
    gap: themeSpace[1],
    paddingTop: themeSpace[1.5],
    paddingBottom: themeSpace[1.5],
    paddingInline: themeSpace[3],
  },
  /** A chip at rest. */
  pillIdle: {
    borderColor: {
      default: 'hsl(var(--border) / 0.5)',
      [DARK_SCOPE]: {
        default: '#ffffff1f',
        '@supports (color: color-mix(in lab, red, red))':
          'color-mix(in oklab, var(--color-white) 12%, transparent)',
      },
    },
    backgroundColor: {
      default: themeColors.muted,
      ':hover': 'hsl(var(--muted) / 0.8)',
      [DARK_SCOPE]: {
        default: '#ffffff1a',
        '@supports (color: color-mix(in lab, red, red))':
          'color-mix(in oklab, var(--color-white) 10%, transparent)',
        // A touch-emulated hover keeps the dark resting fill; the light hover
        // must not outrank it when this media condition is false.
        ':hover': {
          default: '#ffffff1a',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, var(--color-white) 10%, transparent)',
          '@media (hover: hover)': {
            default: '#ffffff24',
            '@supports (color: color-mix(in lab, red, red))':
              'color-mix(in oklab, var(--color-white) 14%, transparent)',
          },
        },
      },
    },
    color: themeColors.foreground,
  },
  /** A chip that is open, or carries a filter. */
  pillActive: {
    borderColor: 'hsl(var(--primary) / 0.4)',
    backgroundColor: 'hsl(var(--primary) / 0.15)',
    color: themeColors.primary,
  },
  /** The chip's label never wraps. */
  pillLabel: { whiteSpace: 'nowrap' },
  /** The rule that splits the aggregate chip's label from its glyph. */
  pillDivider: {
    width: '1px',
    height: themeSpace[3.5],
  },
  pillDividerIdle: { backgroundColor: 'hsl(var(--border) / 0.7)' },
  pillDividerActive: { backgroundColor: 'hsl(var(--primary) / 0.3)' },
  /** The aggregate chip's glyph. */
  pillGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  /** The single chip's chevron. */
  chevron: {
    width: themeSpace[3],
    height: themeSpace[3],
    flexShrink: 0,
    rotate: '0deg',
    transitionProperty: 'transform',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  chevronOpen: { rotate: '180deg' },

  /** The dot that says a filter is applied. */
  filterDot: {
    position: 'absolute',
    top: 'calc(var(--spacing) * -0.5)',
    right: 'calc(var(--spacing) * -0.5)',
    display: 'inline-block',
    width: themeSpace[2],
    height: themeSpace[2],
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.primary,
    boxShadow: '0 0 0 2px hsl(var(--background))',
  },

  /** The inline panel the chip opens. */
  panel: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: themeSpace[1.5],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[2.5],
  },
  /** One option of the inline panel. */
  option: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: themeRadius.full,
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[1],
    paddingInline: themeSpace[2.5],
    fontSize: '0.78rem',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1,
    letterSpacing: '-0.025em',
    scale: { default: null, ':active': '0.97' },
    ...TRANSITION_COLORS,
  },
  /** An option of a multi-select panel, which carries a check. */
  optionMulti: { gap: themeSpace[1.5] },
  /** A chosen option. */
  optionSelected: {
    borderColor: themeColors.primary,
    backgroundColor: themeColors.primary,
    color: themeColors.primaryForeground,
  },
  /** An option that is not chosen. */
  optionIdle: {
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: { default: themeColors.card, ':hover': 'hsl(var(--muted) / 0.4)' },
    color: themeColors.foreground,
  },
  /** The check in a chosen option. */
  optionCheck: {
    width: themeSpace[3],
    height: themeSpace[3],
    flexShrink: 0,
  },
});

export function MobileFilterPillBar({ pills, className }: MobileFilterPillBarProps) {
  const [openPillId, setOpenPillId] = useState<string | null>(null);
  const activePill = openPillId ? (pills.find((pill) => pill.id === openPillId) ?? null) : null;

  /* Inline accordion only renders for single / multi pills. Aggregate
     pills open their own drawer (rendered below). Splitting the
     branches here keeps the AnimatePresence height animation
     focused on the in-flow accordion case where it actually
     applies. */
  const inlineActivePill = activePill && activePill.kind !== 'aggregate' ? activePill : null;
  const aggregatePills = pills.filter(
    (pill): pill is AggregateFilterPill => pill.kind === 'aggregate'
  );

  return (
    <div {...withClassName(stylex.props(styles.root), cn('mobile-filter-pill-bar', className))}>
      <div
        role="toolbar"
        aria-label="filters"
        {...withClassName(stylex.props(styles.toolbar), 'hide-scrollbar')}
      >
        {pills.map((pill) => (
          <FilterPillButton
            key={pill.id}
            pill={pill}
            isOpen={openPillId === pill.id}
            onToggle={() => setOpenPillId((current) => (current === pill.id ? null : pill.id))}
          />
        ))}
      </div>
      <AnimatePresence initial={false}>
        {inlineActivePill ? (
          <motion.div
            key={inlineActivePill.id}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={PANEL_TRANSITION}
            {...stylex.props(styles.accordion)}
          >
            <PillOptionsPanel
              pill={inlineActivePill}
              onAfterSelect={() => {
                /* Single-select pills auto-collapse on commit so the
                   user doesn't have to dismiss. Multi-select pills
                   stay open so the user can toggle several options
                   without re-tapping the pill. */
                if (inlineActivePill.kind === 'single') setOpenPillId(null);
              }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
      {aggregatePills.map((aggregate) => (
        <MobileFilterDrawer
          key={aggregate.id}
          open={openPillId === aggregate.id}
          onOpenChange={(open) => setOpenPillId(open ? aggregate.id : null)}
          pills={aggregate.pills}
          title={aggregate.drawerTitle ?? aggregate.label}
        />
      ))}
    </div>
  );
}

function FilterPillButton({
  pill,
  isOpen,
  onToggle,
}: {
  pill: FilterPill;
  isOpen: boolean;
  onToggle: () => void;
}) {
  /* Aggregate pill has a distinct two-part chip shape: text + thin
     divider + filter icon (modeled on the standard mobile "Sort &
     filter" affordance in iOS Mail, Linear, Pinterest, etc.). Keep
     it visually separate from single/multi pills so users read
     "this opens a drawer" rather than "this is just another inline
     dropdown". */
  if (pill.kind === 'aggregate') {
    const hasActiveFilter = pill.pills.some(
      (inner) => !setsEqual(inner.selectedIds, inner.defaultIds)
    );
    const engaged = isOpen || hasActiveFilter;
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        {...stylex.props(
          styles.pill,
          styles.pillAggregate,
          engaged ? styles.pillActive : styles.pillIdle
        )}
      >
        <span {...stylex.props(styles.pillLabel)}>{pill.label}</span>
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.pillDivider,
            engaged ? styles.pillDividerActive : styles.pillDividerIdle
          )}
        />
        <Filter {...stylex.props(styles.pillGlyph)} strokeWidth={2} aria-hidden="true" />
        {hasActiveFilter ? <span aria-hidden="true" {...stylex.props(styles.filterDot)} /> : null}
      </button>
    );
  }

  let label: string;
  let hasFilterDot = false;

  if (pill.kind === 'single') {
    label = pill.options.find((opt) => opt.id === pill.selectedId)?.label ?? pill.fallbackLabel;
  } else {
    label = pill.label;
    hasFilterDot = !setsEqual(pill.selectedIds, pill.defaultIds);
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      aria-haspopup="listbox"
      {...stylex.props(
        styles.pill,
        styles.pillSingle,
        isOpen ? styles.pillActive : styles.pillIdle
      )}
    >
      <span {...stylex.props(styles.pillLabel)}>{label}</span>
      <ChevronDown
        {...stylex.props(styles.chevron, isOpen && styles.chevronOpen)}
        strokeWidth={2}
        aria-hidden="true"
      />
      {hasFilterDot ? <span aria-hidden="true" {...stylex.props(styles.filterDot)} /> : null}
    </button>
  );
}

function PillOptionsPanel({
  pill,
  onAfterSelect,
}: {
  pill: SingleSelectPill | MultiSelectPill;
  onAfterSelect: () => void;
}) {
  if (pill.kind === 'single') {
    return (
      <div {...stylex.props(styles.panel)}>
        {pill.options.map((option) => {
          const selected = option.id === pill.selectedId;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                if (!selected) pill.onSelect(option.id);
                onAfterSelect();
              }}
              {...stylex.props(styles.option, selected ? styles.optionSelected : styles.optionIdle)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.panel)}>
      {pill.options.map((option) => {
        const selected = pill.selectedIds.has(option.id);
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => {
              const next = new Set(pill.selectedIds);
              if (next.has(option.id)) next.delete(option.id);
              else next.add(option.id);
              pill.onChange(next);
            }}
            {...stylex.props(
              styles.option,
              styles.optionMulti,
              selected ? styles.optionSelected : styles.optionIdle
            )}
          >
            {selected ? (
              <Check {...stylex.props(styles.optionCheck)} strokeWidth={2.4} aria-hidden="true" />
            ) : null}
            {option.icon}
            <span {...stylex.props(styles.pillLabel)}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
