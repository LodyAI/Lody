import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { focus } from '@lody/ui/tokens/scales.stylex';
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

const styles = stylex.create({
  tabs: {
    position: 'relative',
    display: 'flex',
    alignItems: 'stretch',
    gap: '20px',
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
});

/**
 * Settings' tab bar: labels in a row and one 2px line under the current one,
 * sliding to the next. Arrow keys move between tabs. The project window's
 * pages and the Agents page's machines both use it.
 */
export function SettingsLineTabs<Id extends string>({
  tabs,
  current,
  onChange,
  ruled = false,
  label,
}: {
  readonly tabs: readonly SettingsLineTab<Id>[];
  readonly current: Id;
  readonly onChange: (id: Id) => void;
  readonly ruled?: boolean;
  readonly label?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState<{ left: number; width: number } | null>(null);

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
    return observeResizeOnAnimationFrame(list, measure);
  }, [current, tabs]);

  const focusTab = (id: Id) =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-tab]') ?? [])
      .find((node) => node.dataset.tab === id)
      ?.focus();

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      {...stylex.props(styles.tabs, ruled && styles.ruled)}
    >
      {tabs.map((entry) => {
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
              const index = tabs.findIndex((tab) => tab.id === entry.id);
              const next =
                tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!;
              onChange(next.id);
              focusTab(next.id);
            }}
            tabIndex={selected ? 0 : -1}
            {...stylex.props(styles.tab, selected && styles.current)}
          >
            {entry.leading}
            {entry.label}
            {entry.count ? (
              <span {...stylex.props(styles.count, entry.warn && styles.countWarn)}>
                {entry.count}
              </span>
            ) : null}
          </button>
        );
      })}
      {line ? (
        <span
          aria-hidden="true"
          {...stylex.props(styles.line)}
          style={{ transform: `translateX(${line.left}px)`, width: `${line.width}px` }}
        />
      ) : null}
    </div>
  );
}
