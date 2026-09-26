import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import type { PanInfo } from 'framer-motion';
import { Check, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@/ui/drawer';
import { cn } from '@/lib/utils';
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
      <DrawerContent
        className={cn(
          'mobile-filter-drawer',
          'h-[88dvh]! max-h-[88dvh]! rounded-t-2xl border-border/60'
        )}
      >
        <div className="flex h-full min-h-0 flex-col">
          <header className="relative flex shrink-0 items-center px-4 pb-2 pt-2">
            {activePill ? (
              <button
                type="button"
                onClick={() => setActiveId(null)}
                aria-label={t('common.back', 'Back')}
                className={cn(
                  'absolute left-3 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full',
                  'text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <ChevronLeft className="h-5 w-5" aria-hidden="true" />
              </button>
            ) : null}
            <DrawerTitle className="mx-auto text-[0.95rem] font-semibold tracking-tight">
              {activePill ? activePill.label : resolvedTitle}
            </DrawerTitle>
            <DrawerClose asChild>
              <button
                type="button"
                aria-label={t('common.close', 'Close')}
                className={cn(
                  'absolute right-3 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full',
                  'text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <X className="h-5 w-5" aria-hidden="true" strokeWidth={1.8} />
              </button>
            </DrawerClose>
          </header>
          <DrawerDescription className="sr-only">{description ?? resolvedTitle}</DrawerDescription>

          <div className="relative min-h-0 flex-1 overflow-hidden">
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
      className="absolute inset-0 overflow-y-auto"
      initial={{ x: '-15%', opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: '-15%', opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
    >
      {activePills.length > 0 ? (
        <section className="px-4 pb-3 pt-2">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[0.72rem] font-semibold tracking-wide text-muted-foreground">
              {t('mobile.filterDrawer.activeHeading', 'Active filters')}
            </h3>
            <button
              type="button"
              onClick={handleClearAll}
              className={cn(
                '-mr-2 inline-flex h-7 items-center rounded-full px-2.5 text-[0.75rem] font-medium',
                'text-primary transition-colors hover:bg-primary/10 active:scale-[0.97]'
              )}
            >
              {t('mobile.filterDrawer.clearAll', 'Clear all')}
            </button>
          </div>
          <div className="flex flex-col gap-1 rounded-xl bg-card p-1 ring-1 ring-border/60">
            {activePills.map((pill) => {
              /* Display the INCLUDED items (`selectedIds`), capped
                 at MAX_VISIBLE so a 40-machine workspace doesn't
                 spill the badge row off-screen. The whole row is
                 tappable → drill into that dimension's pick list,
                 since the user almost always wants to edit the
                 narrowing they just summarised. */
              const includedOptions = pill.options.filter((opt) =>
                pill.selectedIds.has(opt.id)
              );
              const MAX_VISIBLE = 3;
              const visible = includedOptions.slice(0, MAX_VISIBLE);
              const overflowCount = includedOptions.length - visible.length;
              return (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => onDrillIn(pill.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left',
                    'transition-colors active:bg-muted/40'
                  )}
                >
                  <span className="shrink-0 text-[0.8rem] font-semibold text-foreground">
                    {pill.label}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                    {includedOptions.length === 0 ? (
                      /* Empty inclusion is the "all off" anti-state
                         the user reached via 清空 in the dimension
                         page. Surface it explicitly so they notice
                         their own filter zeroed the list. */
                      <span className="text-[0.75rem] font-medium text-muted-foreground">
                        {t('mobile.filterDrawer.noneSelected', '(none)')}
                      </span>
                    ) : (
                      <>
                        {visible.map((opt) => (
                          <span
                            key={opt.id}
                            className={cn(
                              'inline-flex max-w-[140px] items-center gap-1 rounded-full px-2 py-0.5',
                              'text-[0.75rem] font-medium',
                              'bg-primary/12 text-primary'
                            )}
                          >
                            {opt.icon}
                            <span className="truncate">{opt.label}</span>
                          </span>
                        ))}
                        {overflowCount > 0 ? (
                          <span
                            className={cn(
                              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5',
                              'text-[0.75rem] font-medium',
                              'bg-muted text-muted-foreground'
                            )}
                          >
                            {t('mobile.filterDrawer.moreCount', '+{{count}}', {
                              count: overflowCount,
                            })}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-muted-foreground/60"
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="px-4 pb-6 pt-1">
        <h3 className="mb-2 text-[0.72rem] font-semibold tracking-wide text-muted-foreground">
          {t('mobile.filterDrawer.dimensionsHeading', 'Filter by')}
        </h3>
        <div className="flex flex-col overflow-hidden rounded-xl bg-card ring-1 ring-border/60">
          {pills.map((pill, idx) => {
            const isActive = !setsEqual(pill.selectedIds, pill.defaultIds);
            return (
              <button
                key={pill.id}
                type="button"
                onClick={() => onDrillIn(pill.id)}
                className={cn(
                  'flex items-center gap-3 px-4 py-3 text-left transition-colors active:bg-muted/40',
                  idx > 0 && 'border-t border-border/40'
                )}
              >
                <span className="flex-1 text-sm font-medium">{pill.label}</span>
                <span className="shrink-0 text-xs">
                  {isActive ? (
                    <span className="font-medium text-primary">
                      {pill.selectedIds.size}/{pill.options.length}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('mobile.filterDrawer.allLabel', 'All')}
                    </span>
                  )}
                </span>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-muted-foreground/60"
                  aria-hidden="true"
                />
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
      className="absolute inset-0 overflow-y-auto bg-background"
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
      <div className="flex items-center justify-between px-4 pb-1 pt-2 text-[0.72rem] font-medium tracking-wide text-muted-foreground">
        <span>
          {t('mobile.filterDrawer.selectedCount', '{{count}} / {{total}} selected', {
            count: pill.selectedIds.size,
            total: pill.options.length,
          })}
        </span>
        <div className="flex items-center gap-3">
          {!allSelected ? (
            <button
              type="button"
              onClick={handleSelectAll}
              className="text-primary transition-opacity active:opacity-60"
            >
              {t('mobile.filterDrawer.selectAll', 'Select all')}
            </button>
          ) : null}
          {pill.selectedIds.size > 0 ? (
            <button
              type="button"
              onClick={handleClear}
              className="text-muted-foreground transition-opacity active:opacity-60"
            >
              {t('mobile.filterDrawer.clear', 'Clear')}
            </button>
          ) : null}
        </div>
      </div>
      {showSearch ? (
        <div className="px-3 pb-1 pt-1">
          <div
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 ring-1 ring-border/60 bg-card',
              'focus-within:ring-primary/40'
            )}
          >
            <Search
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('mobile.filterDrawer.searchPlaceholder', 'Search')}
              aria-label={t('mobile.filterDrawer.searchPlaceholder', 'Search')}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={cn(
                'min-w-0 flex-1 border-none bg-transparent text-sm outline-none',
                'focus:outline-none focus:ring-0 focus-visible:shadow-none placeholder:text-muted-foreground'
              )}
            />
          </div>
        </div>
      ) : null}
      <ul className="flex flex-col px-3 pb-6 pt-1">
        {filteredOptions.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-muted-foreground">
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
                <li
                  className={cn(
                    /* Group heading preserves the source's casing —
                       machine names like "MacBook" / "lab-m2" read
                       naturally without being shouted in caps. */
                    'px-3 pb-1 pt-3 text-[0.72rem] font-semibold tracking-tight',
                    'text-muted-foreground',
                    idx === 0 && 'pt-1'
                  )}
                >
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
                  className={cn(
                    /* Selected state is read off the checkbox alone —
                       no row background tint. Earlier `bg-primary/8`
                       painted every selected row in a faint primary
                       wash that competed visually with the checkbox
                       fill, especially when many were selected. */
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors active:bg-muted/40'
                  )}
                >
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border/80'
                    )}
                  >
                    {selected ? (
                      <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
                    ) : null}
                  </span>
                  {opt.icon ? <span className="shrink-0">{opt.icon}</span> : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium leading-tight">
                      {opt.label}
                    </span>
                    {opt.description ? (
                      <span className="mt-0.5 block truncate text-[0.72rem] leading-tight text-muted-foreground">
                        {opt.description}
                      </span>
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
