import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ChevronDown } from 'lucide-react';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { focus, space } from '@lody/ui/tokens/scales.stylex';
import { Menu, MenuSearchInput } from '@/ui/menu';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';

export type SettingsLineTab<Id extends string> = {
  id: Id;
  label: string;
  /** Before the label: a status dot, a glyph. */
  leading?: ReactNode;
  /** After the label, in figures: what is waiting on that tab. */
  count?: number;
  warn?: boolean;
};

/** More tabs than fit collapse into one last tab that opens the rest as a menu. */
export type SettingsLineTabsOverflow = {
  /** The last tab's label for the tabs it holds, e.g. "12 more". */
  label: (count: number) => string;
  /** Past this many held tabs, the menu opens with a search field. */
  searchPlaceholder?: string;
};

/** Held tabs past which the overflow menu offers a search field. */
const SEARCH_FROM = 8;
const GAP = 20;

const styles = stylex.create({
  tabs: {
    position: 'relative',
    display: 'flex',
    alignItems: 'stretch',
    gap: `${GAP}px`,
    minWidth: 0,
  },
  /** A bar of its own under a page's title: a hairline carries the travelling line. */
  ruled: {
    boxShadow: `inset 0 -1px 0 color-mix(in oklab, transparent, ${colors.label} 8%)`,
  },
  tab: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '6px',
    height: '36px',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: '13.5px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
    borderRadius: '4px',
    transitionProperty: 'color',
    transitionDuration: '150ms',
  },
  current: { color: { default: colors.label, ':hover': colors.label } },
  /** The current tab's line: it travels to the next rather than blinking. */
  line: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: '2px',
    borderRadius: '9999px',
    backgroundColor: colors.label,
    transitionProperty: 'transform, width',
    transitionDuration: '240ms',
    transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  },
  count: {
    marginInlineStart: '2px',
    fontSize: '11px',
    fontWeight: 500,
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  countWarn: { color: `color-mix(in oklab, ${colors.warning} 80%, ${colors.label})` },
  moreGlyph: { width: '14px', height: '14px' },
  /** Every tab laid out once, unseen, so the bar knows how many fit. */
  measure: {
    position: 'absolute',
    insetInlineStart: 0,
    top: 0,
    display: 'flex',
    gap: `${GAP}px`,
    height: 0,
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
  },
  menuList: { maxHeight: 'min(50vh, 20rem)', overflowY: 'auto' },
  menuItem: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  menuEmpty: {
    margin: 0,
    paddingInline: space[2],
    paddingBlock: space[1.5],
    fontSize: '12px',
    color: colors.tertiaryLabel,
  },
});

function TabFace<Id extends string>({ tab }: { tab: SettingsLineTab<Id> }) {
  return (
    <>
      {tab.leading}
      {tab.label}
      {tab.count ? (
        <span {...stylex.props(styles.count, tab.warn && styles.countWarn)}>{tab.count}</span>
      ) : null}
    </>
  );
}

/**
 * Settings' tab bar: labels in a row and one 2px line under the current one,
 * sliding to the next. Arrow keys move between tabs. The project window's
 * pages and the Agents page's machines both use it. With `overflow`, tabs that
 * do not fit are held by one last tab that opens them as a menu, and the
 * current tab always stays in the row.
 */
export function SettingsLineTabs<Id extends string>({
  tabs,
  current,
  onChange,
  ruled = false,
  label,
  overflow,
}: {
  readonly tabs: readonly SettingsLineTab<Id>[];
  readonly current: Id;
  readonly onChange: (id: Id) => void;
  readonly ruled?: boolean;
  readonly label?: string;
  readonly overflow?: SettingsLineTabsOverflow;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState<{ left: number; width: number } | null>(null);
  const [fit, setFit] = useState(tabs.length);
  const [query, setQuery] = useState('');

  useLayoutEffect(() => {
    const list = listRef.current;
    const measure = measureRef.current;
    if (!overflow || !list || !measure) {
      setFit(tabs.length);
      return undefined;
    }
    const compute = () => {
      const nodes = Array.from(measure.children) as HTMLElement[];
      const widths = nodes.slice(0, tabs.length).map((node) => node.offsetWidth);
      const moreWidth = nodes[tabs.length]?.offsetWidth ?? 0;
      const available = list.clientWidth;
      const total = widths.reduce((sum, width) => sum + width, 0) + GAP * (tabs.length - 1);
      if (total <= available) {
        setFit(tabs.length);
        return;
      }
      let used = moreWidth;
      let count = 0;
      for (const width of widths) {
        if (used + width + GAP > available) break;
        used += width + GAP;
        count += 1;
      }
      setFit(Math.max(1, count));
    };
    compute();
    // The unseen row changes width when a web font lands; the bar does not.
    const stopList = observeResizeOnAnimationFrame(list, compute);
    const stopMeasure = observeResizeOnAnimationFrame(measure, compute);
    return () => {
      stopList();
      stopMeasure();
    };
  }, [overflow, tabs]);

  // The row keeps its order; when the current tab is among the held ones it
  // takes the last visible place, so the line always has a tab to sit under.
  const { shown, held } = useMemo(() => {
    if (fit >= tabs.length) return { shown: tabs, held: [] as SettingsLineTab<Id>[] };
    const head = tabs.slice(0, fit);
    if (head.some((tab) => tab.id === current)) {
      return { shown: head, held: tabs.slice(fit) };
    }
    const currentTab = tabs.find((tab) => tab.id === current);
    const shownTabs = currentTab ? [...head.slice(0, fit - 1), currentTab] : head;
    const shownIds = new Set(shownTabs.map((tab) => tab.id));
    return { shown: shownTabs, held: tabs.filter((tab) => !shownIds.has(tab.id)) };
  }, [current, fit, tabs]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = () => {
      const tab = Array.from(list.querySelectorAll<HTMLElement>('[data-tab]')).find(
        (node) => node.dataset.tab === current
      );
      if (tab) setLine({ left: tab.offsetLeft, width: tab.offsetWidth });
    };
    measure();
    // Every tab, not just the bar: a label that widens when its font lands
    // moves the tabs after it without resizing the bar.
    const stops = [list, ...Array.from(list.querySelectorAll<HTMLElement>('[data-tab]'))].map(
      (node) => observeResizeOnAnimationFrame(node, measure)
    );
    return () => stops.forEach((stop) => stop());
  }, [current, shown]);

  const focusTab = (id: Id) =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-tab]') ?? [])
      .find((node) => node.dataset.tab === id)
      ?.focus();

  const heldMatches = query.trim()
    ? held.filter((tab) => tab.label.toLowerCase().includes(query.trim().toLowerCase()))
    : held;

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      {...stylex.props(styles.tabs, ruled && styles.ruled)}
    >
      {shown.map((entry) => {
        const selected = entry.id === current;
        return (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={selected}
            data-tab={entry.id}
            onClick={() => onChange(entry.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const index = shown.findIndex((tab) => tab.id === entry.id);
              const next =
                shown[
                  (index + (event.key === 'ArrowRight' ? 1 : -1) + shown.length) % shown.length
                ]!;
              onChange(next.id);
              focusTab(next.id);
            }}
            tabIndex={selected ? 0 : -1}
            {...stylex.props(styles.tab, selected && styles.current)}
          >
            <TabFace tab={entry} />
          </button>
        );
      })}
      {overflow && held.length > 0 ? (
        <Menu.Root onOpenChange={(open) => (open ? undefined : setQuery(''))}>
          <Menu.Trigger render={<button type="button" {...stylex.props(styles.tab)} />}>
            {overflow.label(held.length)}
            <ChevronDown aria-hidden="true" {...stylex.props(styles.moreGlyph)} />
          </Menu.Trigger>
          <Menu.Content align="end">
            {held.length > SEARCH_FROM ? (
              <MenuSearchInput
                value={query}
                onValueChange={setQuery}
                placeholder={overflow.searchPlaceholder ?? ''}
                onSubmit={() => {
                  const first = heldMatches[0];
                  if (first) onChange(first.id);
                }}
              />
            ) : null}
            <div {...stylex.props(styles.menuList)}>
              {heldMatches.map((tab) => (
                <Menu.Item key={tab.id} onClick={() => onChange(tab.id)}>
                  <span {...stylex.props(styles.menuItem)}>
                    <TabFace tab={tab} />
                  </span>
                </Menu.Item>
              ))}
              {heldMatches.length === 0 ? <p {...stylex.props(styles.menuEmpty)}>—</p> : null}
            </div>
          </Menu.Content>
        </Menu.Root>
      ) : null}
      {line ? (
        <span
          aria-hidden="true"
          {...stylex.props(styles.line)}
          style={{ transform: `translateX(${line.left}px)`, width: `${line.width}px` }}
        />
      ) : null}
      {overflow ? (
        <div ref={measureRef} aria-hidden="true" {...stylex.props(styles.measure)}>
          {tabs.map((tab) => (
            <span key={tab.id} {...stylex.props(styles.tab)}>
              <TabFace tab={tab} />
            </span>
          ))}
          <span {...stylex.props(styles.tab)}>
            {overflow.label(tabs.length)}
            <ChevronDown {...stylex.props(styles.moreGlyph)} />
          </span>
        </div>
      ) : null}
    </div>
  );
}
