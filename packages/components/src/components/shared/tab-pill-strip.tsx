import type { ComponentType, ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { cn } from '@/lib/utils';

/**
 * Colors are theme-measured, not eyeballed — see the surface-ladder comment in
 * `session-tab-bar.tsx` (canvas → inactive → active) before touching these;
 * re-derive and measure against the actual theme tokens, don't guess.
 */
export const tabPillStyles = stylex.create({
  active: {
    backgroundColor: 'color-mix(in oklab, hsl(var(--foreground)) 8%, transparent)',
    color: 'hsl(var(--tab-active-foreground))',
  },
  inactive: {
    backgroundColor: {
      default: 'color-mix(in oklab, hsl(var(--foreground)) 3.5%, transparent)',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--foreground)) 6%, transparent)',
      },
    },
    color: {
      default: 'hsl(var(--tab-inactive-foreground))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--tab-hover-foreground))',
      },
    },
  },
});

export const TAB_PILL_ACTIVE_CLASS = stylex.props(tabPillStyles.active).className;
export const TAB_PILL_INACTIVE_CLASS = stylex.props(tabPillStyles.inactive).className;

const styles = stylex.create({
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
  },
  pill: {
    display: 'flex',
    height: '32px',
    minWidth: 0,
    alignItems: 'center',
    gap: space[1.5],
    borderRadius: 'var(--radius-md)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    paddingInline: space[3],
    fontSize: '0.9em',
    fontWeight: 500,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  icon: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
  },
  label: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

export interface TabPillItem<Key extends string = string> {
  key: Key;
  label: ReactNode;
  icon?: ComponentType<{ className?: string }>;
}

interface TabPillStripProps<Key extends string> {
  items: TabPillItem<Key>[];
  activeKey: Key;
  onSelect: (key: Key) => void;
  ariaLabel: string;
  className?: string;
  /** Per-pill overrides, e.g. a width cap for titles that must truncate. */
  itemClassName?: string;
}

/**
 * A small, static row of "browser tab" pills for a fixed, short set of views
 * (e.g. Board/List). Mirrors `SessionTabBar`'s tab-pill visual language (same
 * measured active/inactive colors) but without its dynamic-width, drag-reorder,
 * or close-button machinery — that exists for an open-ended list of session
 * tabs, which a two-item view switcher never needs.
 */
export function TabPillStrip<Key extends string>({
  items,
  activeKey,
  onSelect,
  ariaLabel,
  className,
  itemClassName,
}: TabPillStripProps<Key>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(stylex.props(styles.strip).className, className)}
    >
      {items.map(({ key, label, icon: Icon }) => {
        const active = key === activeKey;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(key)}
            className={cn(
              stylex.props(styles.pill, active ? tabPillStyles.active : tabPillStyles.inactive)
                .className,
              itemClassName
            )}
          >
            {Icon ? <Icon className={stylex.props(styles.icon).className} /> : null}
            <span {...stylex.props(styles.label)}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
