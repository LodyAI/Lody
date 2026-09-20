import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Colors are theme-measured, not eyeballed — see the surface-ladder comment in
 * `session-tab-bar.tsx` (canvas → inactive → active) before touching these;
 * re-derive and measure against the actual theme tokens, don't guess.
 */
export const TAB_PILL_ACTIVE_CLASS = 'bg-foreground/[0.08] text-tab-active-foreground';
export const TAB_PILL_INACTIVE_CLASS =
  'bg-foreground/[0.035] text-tab-inactive-foreground hover:bg-foreground/[0.06] hover:text-tab-hover-foreground';

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
    <div role="tablist" aria-label={ariaLabel} className={cn('flex items-center gap-1', className)}>
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
              'flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-transparent px-3 text-[0.9em] font-medium transition-colors',
              active ? TAB_PILL_ACTIVE_CLASS : TAB_PILL_INACTIVE_CLASS,
              itemClassName
            )}
          >
            {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
            <span className="min-w-0 truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
