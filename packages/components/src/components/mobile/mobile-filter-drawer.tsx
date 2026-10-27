import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import type { PanInfo } from 'framer-motion';
import { Check, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { sheetSurface } from './sheet-surface';
import type { MultiSelectPill } from './mobile-filter-pill-bar';

/**
 * Drawer that hosts the merged "过滤" pill. Two views inside:
 *  1. Summary — currently-narrowed dimensions shown as `label: badges`
 *     plus a tappable list of every available dimension.
 *  2. Dimension detail — multi-select checklist for one dimension,
 *     with a left-edge swipe-right gesture to return to summary.
 *
 * The summary lives in the drawer instead of inline panels because we
 * collapsed N pills (kind / running / pr / machine) into a single
 * entry point — there's no longer 1:1 mapping between chips and
 * panels for the bar to render.
 */
export type MobileFilterDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pills: ReadonlyArray<MultiSelectPill>;
  title?: string;
  description?: string;
};

const styles = stylex.create({
  /** The pane the two views slide inside. */
  pane: {
    position: 'relative',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
  },
  /** A view that fills the pane and scrolls on its own. */
  view: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflowY: 'auto',
  },
  /** The dimension detail's own canvas, so the summary never shows through. */
  viewCanvas: { backgroundColor: themeColors.background },

  /** A section of the summary. */
  section: {
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[3],
  },
  /** A section that follows the active-filters block. */
  sectionBelow: {
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[6],
  },
  /** The line that holds a heading and the action beside it. */
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: themeSpace[2],
  },
  /** A heading in the sheet's small voice. */
  heading: {
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '0.025em',
    color: themeColors.mutedForeground,
  },
  /** A heading that stands on its own above the block it names. */
  headingSpaced: { marginBottom: themeSpace[2] },

  /** "Clear all", beside the heading it clears. */
  clearAll: {
    display: 'inline-flex',
    alignItems: 'center',
    height: themeSpace[7],
    marginRight: 'calc(var(--spacing) * -2)',
    paddingInline: themeSpace[2.5],
    borderRadius: themeRadius.full,
    fontSize: '0.75rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.primary,
    backgroundColor: { default: null, ':hover': 'hsl(var(--primary) / 0.1)' },
    scale: { default: null, ':active': '0.97' },
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },

  /** The card the active filters sit in. */
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[1],
    padding: themeSpace[1],
    borderRadius: themeRadius.xl,
    backgroundColor: themeColors.card,
    boxShadow: '0 0 0 1px hsl(var(--border) / 0.6)',
  },
  /** The card of dimensions: no padding, the rows carry it. */
  cardFlush: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: themeRadius.xl,
    backgroundColor: themeColors.card,
    boxShadow: '0 0 0 1px hsl(var(--border) / 0.6)',
  },

  /** A row of the active-filters card. */
  summaryRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[2],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[2],
    textAlign: 'left',
    borderRadius: themeRadius.lg,
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.4)' },
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The dimension's name in the active-filters card. */
  summaryLabel: {
    flexShrink: 0,
    fontSize: '0.8rem',
    fontWeight: themeFontWeight.semibold,
    color: themeColors.foreground,
  },
  /** The badges beside the dimension's name. */
  summaryBadges: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  /** The "(none)" note, when a dimension was emptied. */
  summaryEmpty: {
    fontSize: '0.75rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
  },
  /** One selected item's badge. */
  badge: {
    display: 'inline-flex',
    maxWidth: '140px',
    alignItems: 'center',
    gap: themeSpace[1],
    paddingInline: themeSpace[2],
    paddingTop: '0.125rem',
    paddingBottom: '0.125rem',
    borderRadius: themeRadius.full,
    fontSize: '0.75rem',
    fontWeight: themeFontWeight.medium,
    backgroundColor: 'hsl(var(--primary) / 0.12)',
    color: themeColors.primary,
  },
  /** The badge's label, clipped to the badge's width. */
  badgeLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The "+N" badge, for the items that did not fit. */
  badgeOverflow: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    paddingInline: themeSpace[2],
    paddingTop: '0.125rem',
    paddingBottom: '0.125rem',
    borderRadius: themeRadius.full,
    fontSize: '0.75rem',
    fontWeight: themeFontWeight.medium,
    backgroundColor: themeColors.muted,
    color: themeColors.mutedForeground,
  },
  /** The chevron at the end of a row. */
  chevron: {
    flexShrink: 0,
    width: themeSpace[4],
    height: themeSpace[4],
    color: 'hsl(var(--muted-foreground) / 0.6)',
  },

  /** A row of the dimensions card. */
  dimensionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[3],
    paddingBottom: themeSpace[3],
    textAlign: 'left',
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.4)' },
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** A dimension row that follows another one. */
  dimensionRowRuled: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.4)',
  },
  /** The dimension's name. */
  dimensionLabel: {
    flexGrow: 1,
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
  },
  /** The dimension's count, at the end of the row. */
  dimensionCount: {
    flexShrink: 0,
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
  dimensionCountActive: {
    fontWeight: themeFontWeight.medium,
    color: themeColors.primary,
  },
  dimensionCountIdle: { color: themeColors.mutedForeground },

  /** The dimension detail's header line. */
  detailHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[1],
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.medium,
    letterSpacing: '0.025em',
    color: themeColors.mutedForeground,
  },
  /** The two actions at the end of the detail header. */
  detailActions: { display: 'flex', alignItems: 'center', gap: themeSpace[3] },
  /** One of the detail header's actions. */
  detailAction: {
    color: themeColors.primary,
    opacity: { default: 1, ':active': 0.6 },
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  detailActionMuted: { color: themeColors.mutedForeground },

  /** The search field's well. */
  searchWell: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[2],
    borderRadius: themeRadius.lg,
    backgroundColor: themeColors.card,
    boxShadow: {
      default: '0 0 0 1px hsl(var(--border) / 0.6)',
      ':focus-within': '0 0 0 1px hsl(var(--primary) / 0.4)',
    },
  },
  /** The search glyph. */
  searchGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  searchWrap: {
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[1],
  },
  /** The search field itself. */
  searchInput: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    borderStyle: 'none',
    backgroundColor: 'transparent',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    boxShadow: { default: null, ':focus-visible': 'none' },
    '::placeholder': { color: themeColors.mutedForeground },
  },

  /** The list of options. */
  optionList: {
    display: 'flex',
    flexDirection: 'column',
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[6],
  },
  /** The list's empty state. */
  optionEmpty: {
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[6],
    paddingBottom: themeSpace[6],
    textAlign: 'center',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  /** The heading that opens a group of options. */
  groupHeading: {
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[3],
    paddingBottom: themeSpace[1],
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '-0.025em',
    color: themeColors.mutedForeground,
  },
  /** The heading of the very first group, which hugs the list. */
  groupHeadingFirst: { paddingTop: themeSpace[1] },

  /** An option's row. */
  optionRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[2.5],
    paddingBottom: themeSpace[2.5],
    textAlign: 'left',
    borderRadius: themeRadius.lg,
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.4)' },
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The checkbox in front of an option. */
  checkbox: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: themeSpace[5],
    height: themeSpace[5],
    borderRadius: themeRadius.md,
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.8)',
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The checkbox of a selected option. */
  checkboxChecked: {
    borderColor: themeColors.primary,
    backgroundColor: themeColors.primary,
    color: themeColors.primaryForeground,
  },
  /** The option's icon slot. */
  optionIcon: { flexShrink: 0 },
  /** The option's text column. */
  optionText: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  /** The option's name. */
  optionLabel: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.sm,
    fontWeight: themeFontWeight.medium,
    lineHeight: 1.25,
  },
  /** The option's second line. */
  optionDescription: {
    display: 'block',
    marginTop: '0.125rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.72rem',
    lineHeight: 1.25,
    color: themeColors.mutedForeground,
  },
});

export function MobileFilterDrawer({
  open,
  onOpenChange,
  pills,
  title,
  description,
}: MobileFilterDrawerProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t('mobile.filterDrawer.title', 'Filters');
  const [activeId, setActiveId] = useState<string | null>(null);
  const activePill = activeId ? (pills.find((p) => p.id === activeId) ?? null) : null;

  /* Reset to the summary view whenever the drawer closes — a fresh
     reopen should always land back on the overview, not on whichever
     dimension was last visited. */
  useEffect(() => {
    if (!open) setActiveId(null);
  }, [open]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="mobile-filter-drawer h-[88dvh]! max-h-[88dvh]! rounded-t-2xl border-border/60">
        <div {...stylex.props(sheetSurface.column)}>
          <header {...stylex.props(sheetSurface.header, sheetSurface.headerShrink)}>
            {activePill ? (
              <button
                type="button"
                onClick={() => setActiveId(null)}
                aria-label={t('common.back', 'Back')}
                {...stylex.props(sheetSurface.iconButton, sheetSurface.iconButtonLeft)}
              >
                <ChevronLeft {...stylex.props(sheetSurface.glyph20)} aria-hidden="true" />
              </button>
            ) : null}
            <DrawerTitle {...stylex.props(sheetSurface.title, sheetSurface.titleCentered)}>
              {activePill ? activePill.label : resolvedTitle}
            </DrawerTitle>
            <DrawerClose asChild>
              <button
                type="button"
                aria-label={t('common.close', 'Close')}
                {...stylex.props(sheetSurface.iconButton, sheetSurface.iconButtonRight)}
              >
                <X {...stylex.props(sheetSurface.glyph20)} aria-hidden="true" strokeWidth={1.8} />
              </button>
            </DrawerClose>
          </header>
          <DrawerDescription {...stylex.props(sheetSurface.srOnly)}>
            {description ?? resolvedTitle}
          </DrawerDescription>

          <div {...stylex.props(styles.pane)}>
            <AnimatePresence initial={false}>
              {activePill ? (
                <DimensionPage
                  key={`dim-${activePill.id}`}
                  pill={activePill}
                  onBack={() => setActiveId(null)}
                />
              ) : (
                <SummaryPage key="summary" pills={pills} onDrillIn={setActiveId} />
              )}
            </AnimatePresence>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function SummaryPage({
  pills,
  onDrillIn,
}: {
  pills: ReadonlyArray<MultiSelectPill>;
  onDrillIn: (id: string) => void;
}) {
  const { t } = useTranslation();
  /* "Active" = the user has narrowed the selection from the
     default (= the all-selected baseline). Show their selected
     items as badges so the user sees what's actively filtering
     without drilling in. */
  const activePills = pills.filter((p) => !setsEqual(p.selectedIds, p.defaultIds));

  /* One-tap reset for every active dimension. Lives next to the
     "active filters" heading so it's spatially anchored to the
     summary it clears — closer to the badges than a far-corner
     header button would be, and only present when there's
     actually something to clear. */
  const handleClearAll = () => {
    for (const pill of activePills) {
      pill.onChange(new Set(pill.defaultIds));
    }
  };

  return (
    <motion.div
      {...stylex.props(styles.view)}
      initial={{ x: '-15%', opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: '-15%', opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
    >
      {activePills.length > 0 ? (
        <section {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.sectionHead)}>
            <h3 {...stylex.props(styles.heading)}>
              {t('mobile.filterDrawer.activeHeading', 'Active filters')}
            </h3>
            <button type="button" onClick={handleClearAll} {...stylex.props(styles.clearAll)}>
              {t('mobile.filterDrawer.clearAll', 'Clear all')}
            </button>
          </div>
          <div {...stylex.props(styles.card)}>
            {activePills.map((pill) => {
              /* Display the INCLUDED items (`selectedIds`), capped
                 at MAX_VISIBLE so a 40-machine workspace doesn't
                 spill the badge row off-screen. The whole row is
                 tappable → drill into that dimension's pick list,
                 since the user almost always wants to edit the
                 narrowing they just summarised. */
              const includedOptions = pill.options.filter((opt) => pill.selectedIds.has(opt.id));
              const MAX_VISIBLE = 3;
              const visible = includedOptions.slice(0, MAX_VISIBLE);
              const overflowCount = includedOptions.length - visible.length;
              return (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => onDrillIn(pill.id)}
                  {...stylex.props(styles.summaryRow)}
                >
                  <span {...stylex.props(styles.summaryLabel)}>{pill.label}</span>
                  <div {...stylex.props(styles.summaryBadges)}>
                    {includedOptions.length === 0 ? (
                      /* Empty inclusion is the "all off" anti-state
                         the user reached via 清空 in the dimension
                         page. Surface it explicitly so they notice
                         their own filter zeroed the list. */
                      <span {...stylex.props(styles.summaryEmpty)}>
                        {t('mobile.filterDrawer.noneSelected', '(none)')}
                      </span>
                    ) : (
                      <>
                        {visible.map((opt) => (
                          <span key={opt.id} {...stylex.props(styles.badge)}>
                            {opt.icon}
                            <span {...stylex.props(styles.badgeLabel)}>{opt.label}</span>
                          </span>
                        ))}
                        {overflowCount > 0 ? (
                          <span {...stylex.props(styles.badgeOverflow)}>
                            {t('mobile.filterDrawer.moreCount', '+{{count}}', {
                              count: overflowCount,
                            })}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                  <ChevronRight {...stylex.props(styles.chevron)} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section {...stylex.props(styles.sectionBelow)}>
        <h3 {...stylex.props(styles.heading, styles.headingSpaced)}>
          {t('mobile.filterDrawer.dimensionsHeading', 'Filter by')}
        </h3>
        <div {...stylex.props(styles.cardFlush)}>
          {pills.map((pill, idx) => {
            const isActive = !setsEqual(pill.selectedIds, pill.defaultIds);
            return (
              <button
                key={pill.id}
                type="button"
                onClick={() => onDrillIn(pill.id)}
                {...stylex.props(styles.dimensionRow, idx > 0 && styles.dimensionRowRuled)}
              >
                <span {...stylex.props(styles.dimensionLabel)}>{pill.label}</span>
                <span {...stylex.props(styles.dimensionCount)}>
                  {isActive ? (
                    <span {...stylex.props(styles.dimensionCountActive)}>
                      {pill.selectedIds.size}/{pill.options.length}
                    </span>
                  ) : (
                    <span {...stylex.props(styles.dimensionCountIdle)}>
                      {t('mobile.filterDrawer.allLabel', 'All')}
                    </span>
                  )}
                </span>
                <ChevronRight {...stylex.props(styles.chevron)} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>
    </motion.div>
  );
}

function DimensionPage({ pill, onBack }: { pill: MultiSelectPill; onBack: () => void }) {
  const { t } = useTranslation();
  /* Fuzzy search kicks in for longer option lists (repo / project
     filters can run into 20+ entries in big workspaces). Threshold
     of 8 matches the new-chat picker — anything shorter is faster
     to eyeball-scan than to type into. */
  const showSearch = pill.options.length > 8;
  const [query, setQuery] = useState('');
  const filteredOptions = useMemo(() => {
    if (!showSearch) return pill.options;
    const q = query.trim().toLowerCase();
    if (!q) return pill.options;
    return pill.options.filter((opt) => {
      if (opt.label.toLowerCase().includes(q)) return true;
      /* Also search the description (e.g. a local project's full
         root path) and group key (machine name) so typing "macbook"
         narrows to projects on that machine, and typing a path
         fragment matches even when the project name doesn't. */
      if (typeof opt.description === 'string' && opt.description.toLowerCase().includes(q)) {
        return true;
      }
      if (opt.group && opt.group.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [pill.options, query, showSearch]);

  const allSelected = setsEqual(pill.selectedIds, new Set(pill.options.map((o) => o.id)));
  /* 全选 / 清空 ALWAYS operate on the full option set, not the
     search-filtered view — searching is a visual narrowing only.
     Otherwise typing "macbook" and tapping 清空 would silently
     leave non-macbook machines selected, which contradicts the
     button's plain reading. */
  const handleSelectAll = () => {
    pill.onChange(new Set(pill.options.map((o) => o.id)));
  };
  const handleClear = () => {
    pill.onChange(new Set());
  };

  return (
    <motion.div
      {...stylex.props(styles.view, styles.viewCanvas)}
      /* Drag-right to dismiss back to summary. `dragDirectionLock` lets
         vertical scroll through unimpeded — motion only captures the
         touch when the user's initial gesture is horizontal. */
      drag="x"
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0, right: 0.5 }}
      dragSnapToOrigin
      onDragEnd={(_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
        if (info.offset.x > 80 || info.velocity.x > 400) {
          onBack();
        }
      }}
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
    >
      <div {...stylex.props(styles.detailHead)}>
        <span>
          {t('mobile.filterDrawer.selectedCount', '{{count}} / {{total}} selected', {
            count: pill.selectedIds.size,
            total: pill.options.length,
          })}
        </span>
        <div {...stylex.props(styles.detailActions)}>
          {!allSelected ? (
            <button type="button" onClick={handleSelectAll} {...stylex.props(styles.detailAction)}>
              {t('mobile.filterDrawer.selectAll', 'Select all')}
            </button>
          ) : null}
          {pill.selectedIds.size > 0 ? (
            <button
              type="button"
              onClick={handleClear}
              {...stylex.props(styles.detailAction, styles.detailActionMuted)}
            >
              {t('mobile.filterDrawer.clear', 'Clear')}
            </button>
          ) : null}
        </div>
      </div>
      {showSearch ? (
        <div {...stylex.props(styles.searchWrap)}>
          <div {...stylex.props(styles.searchWell)}>
            <Search {...stylex.props(styles.searchGlyph)} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('mobile.filterDrawer.searchPlaceholder', 'Search')}
              aria-label={t('mobile.filterDrawer.searchPlaceholder', 'Search')}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              {...stylex.props(styles.searchInput)}
            />
          </div>
        </div>
      ) : null}
      <ul {...stylex.props(styles.optionList)}>
        {filteredOptions.length === 0 ? (
          <li {...stylex.props(styles.optionEmpty)}>
            {t('mobile.filterDrawer.searchEmpty', 'No matches')}
          </li>
        ) : null}
        {filteredOptions.map((opt, idx) => {
          const selected = pill.selectedIds.has(opt.id);
          /* Render a small uppercase group heading before this row
             whenever the group key flips. Options are expected to be
             pre-sorted by group at the source (chat-landing builds
             local-project options grouped by machine, for example);
             the renderer doesn't sort them itself, just inserts a
             separator the moment the key changes. */
          const prevGroup = idx === 0 ? undefined : filteredOptions[idx - 1]?.group;
          const showGroupHeading = opt.group && opt.group !== prevGroup;
          return (
            <Fragment key={opt.id}>
              {showGroupHeading ? (
                <li {...stylex.props(styles.groupHeading, idx === 0 && styles.groupHeadingFirst)}>
                  {opt.group}
                </li>
              ) : null}
              <li>
                <button
                  type="button"
                  onClick={() => {
                    const next = new Set(pill.selectedIds);
                    if (next.has(opt.id)) next.delete(opt.id);
                    else next.add(opt.id);
                    pill.onChange(next);
                  }}
                  {...stylex.props(styles.optionRow)}
                >
                  <span {...stylex.props(styles.checkbox, selected && styles.checkboxChecked)}>
                    {selected ? (
                      <Check
                        {...stylex.props(sheetSurface.glyph14)}
                        strokeWidth={3}
                        aria-hidden="true"
                      />
                    ) : null}
                  </span>
                  {opt.icon ? <span {...stylex.props(styles.optionIcon)}>{opt.icon}</span> : null}
                  <span {...stylex.props(styles.optionText)}>
                    <span {...stylex.props(styles.optionLabel)}>{opt.label}</span>
                    {opt.description ? (
                      <span {...stylex.props(styles.optionDescription)}>{opt.description}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            </Fragment>
          );
        })}
      </ul>
    </motion.div>
  );
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
