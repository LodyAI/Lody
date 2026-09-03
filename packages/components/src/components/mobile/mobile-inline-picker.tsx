import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Loader2, Search, X } from 'lucide-react';

import { filterFuzzyOptions } from '@/lib/fuzzy-option-filter';
import { cn } from '@/lib/utils';

// Above this many (filtered) options the dropdown list is virtualized — big branch
// lists can run into the thousands. Small lists render plainly (cheaper, no measuring).
const PICKER_VIRTUALIZE_THRESHOLD = 40;
const PICKER_ROW_ESTIMATE_PX = 36;
const PICKER_OVERSCAN = 8;

export type MobileInlinePickerOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  /** Plain-text version of the label used for search filtering when
     `searchable` is true. Falls back to `String(label)` if omitted. */
  searchText?: string;
  description?: ReactNode;
  provider?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Tooltip / aria title for disabled options. */
  disabledReason?: string;
};

export type MobileInlinePickerProps<T extends string = string> = {
  /** Unique id within the active `MobileInlinePickerCoordinator`; used to
     enforce "only one picker open at a time" across the sheet. */
  id: string;
  value: T | null | undefined;
  onChange: (value: T) => void;
  options: MobileInlinePickerOption<T>[];
  /** Content for the closed-state trigger — typically icon + label. The
     trigger renders with no chevron; the click affordance comes from the
     surface treatment (subtle bg, hover, pressed states, open ring). */
  triggerContent: ReactNode;
  ariaLabel: string;
  /** Render an empty state when the filtered list has no options. */
  emptyText?: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  /** Text shown next to the spinner while `loading` is true. When omitted,
     the trigger keeps rendering `triggerContent` (prefixed with a spinner). */
  loadingText?: ReactNode;
  /** Render a search input above the options list. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Optional className for the trigger button. */
  triggerClassName?: string;
  /** Optional className for the expansion panel wrapper. */
  expansionClassName?: string;
  /** Optional max-width override for the dropdown panel — useful for
     composer chips where the trigger is narrow but the list should be
     wider than the chip. */
  expansionPanelClassName?: string;
  /** When provided, the expansion panel renders into this element via a
     React portal instead of inline below the trigger. Lets composer
     chips (which live in a flex row of multiple chips) project their
     dropdown into a dedicated slot below the row so the list can span
     the row's full width without distorting the chip's own width. */
  portalContainer?: HTMLElement | null;
};

/* ── Coordination context ────────────────────────────────────────────── */

type PickerCoordinator = {
  activeId: string | null;
  requestActive: (id: string | null) => void;
};

const PickerCoordinatorContext = createContext<PickerCoordinator | null>(null);

/**
 * Wraps a region (e.g. the mobile new-chat sheet) so the pickers inside
 * coordinate "only one open at a time". Without this provider, each
 * picker manages its own open state independently.
 */
export function MobileInlinePickerCoordinator({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const value = useMemo<PickerCoordinator>(
    () => ({ activeId, requestActive: setActiveId }),
    [activeId]
  );
  return (
    <PickerCoordinatorContext.Provider value={value}>{children}</PickerCoordinatorContext.Provider>
  );
}

/**
 * Hook for reading the nearest picker coordinator. Returns `null` when
 * no coordinator wraps the consumer. Use this when an element OUTSIDE
 * a picker (e.g. an external "reopen this menu" button) needs to drive
 * the coordinator — typically by calling `coordinator?.requestActive(id)`
 * to open a specific picker / menu.
 */
export function useMobileInlinePickerCoordinator(): PickerCoordinator | null {
  return useContext(PickerCoordinatorContext);
}

/* ── Row-slot context ────────────────────────────────────────────────── */

/* Pickers inside this provider portal their expansion drawer into the
   wrapped slot — typically a full-row-width div rendered right below
   the row's trigger cluster — instead of expanding inline below their
   own chip. This is what lets the project + branch row (two chips
   side-by-side) drop one shared dropdown beneath the whole row at full
   width, rather than two narrow column-width dropdowns. */
const RowExpansionSlotContext = createContext<HTMLElement | null>(null);

export function MobileInlinePickerRowSlot({
  children,
  slotClassName,
}: {
  children: ReactNode;
  /** Optional className for the slot element itself. */
  slotClassName?: string;
}) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <RowExpansionSlotContext.Provider value={slot}>
      {children}
      <div ref={setSlot} className={cn('w-full', slotClassName)} aria-hidden="true" />
    </RowExpansionSlotContext.Provider>
  );
}

/* ── Picker ──────────────────────────────────────────────────────────── */

/**
 * Unified mobile selector. Renders a chip-style trigger; tapping expands
 * an inline drawer of options directly below it via a height-animated
 * accordion — "pulled from behind" the trigger, in document flow so
 * content below it shifts down rather than being overlaid.
 *
 * For composer-row chips where the trigger is one of many in a flex row,
 * pass `portalContainer` so the expansion projects into a dedicated slot
 * below the row instead of inflating the trigger's flex cell.
 *
 * When wrapped in `MobileInlinePickerCoordinator`, tapping a picker
 * closes any other open picker in the same region.
 */
export function MobileInlinePicker<T extends string = string>({
  id,
  value,
  onChange,
  options,
  triggerContent,
  ariaLabel,
  emptyText,
  disabled = false,
  loading = false,
  loadingText,
  searchable = false,
  searchPlaceholder,
  triggerClassName,
  expansionClassName,
  expansionPanelClassName,
  portalContainer,
}: MobileInlinePickerProps<T>) {
  const coordinator = useContext(PickerCoordinatorContext);
  /* Explicit `portalContainer` wins; otherwise fall back to the
     nearest `MobileInlinePickerRowSlot` if one exists; otherwise
     render inline below the trigger. */
  const rowSlot = useContext(RowExpansionSlotContext);
  const effectivePortalContainer = portalContainer ?? rowSlot ?? null;
  const [localOpen, setLocalOpen] = useState(false);
  const open = coordinator ? coordinator.activeId === id : localOpen;
  const setOpen = (next: boolean) => {
    if (coordinator) {
      coordinator.requestActive(next ? id : null);
    } else {
      setLocalOpen(next);
    }
  };

  const triggerRef = useRef<HTMLButtonElement>(null);
  const expansionRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [query, setQuery] = useState('');
  /* Keyboard highlight for the open dropdown. Focus stays on the trigger button
     (so the picker still works when driven by an external roving controller that
     opens it without moving focus); ↑/↓ move this index, Enter/Space select it,
     Esc closes. -1 = nothing highlighted (closed). */
  const [activeIndex, setActiveIndex] = useState(-1);
  /* Auto-focus the search input on open only with a precise pointer (desktop) —
     never on touch, where it would force the soft keyboard up. */
  const autoFocusSearch = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches,
    []
  );

  /* Close when tapping outside both the trigger AND the expansion panel
     (the panel may live in a portal, so a single containing ref isn't
     enough). Use pointerdown (capture) so the close fires before another
     picker's trigger sees its click, letting the coordinator transition
     cleanly between active ids. */
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (expansionRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setOpen is stable; we only care about `open` and `coordinator`
  }, [open, coordinator]);

  /* Reset the search query whenever the picker closes so reopening starts
     fresh — searching for one branch, closing, then reopening shouldn't
     leave the old query filtering the list. */
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  /* Fuzzy, not substring: a provider's model list can run to dozens of ids, and
     `op5` should still find `claude-opus-5`. Ranked, so the best match is the
     one the highlight lands on. An empty query returns `options` itself, which
     is every render without a search field. */
  const filteredOptions = useMemo(
    () =>
      filterFuzzyOptions(options, query, (opt) => ({
        primary: opt.searchText ?? String(opt.label ?? ''),
        secondary: [opt.value, opt.provider],
      })),
    [options, query]
  );

  const handleSelect = (next: T) => {
    onChange(next);
    setOpen(false);
    // Return focus to the trigger so keyboard users stay in the flow (the search
    // input that had focus is unmounting).
    triggerRef.current?.focus();
  };

  const optionId = (index: number) => `${listboxId}-opt-${index}`;

  // Virtualize only large lists. The <div> list (max-h-[200px]) is the scroll element;
  // measureElement handles variable row heights (options with a description are taller).
  const listRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = filteredOptions.length > PICKER_VIRTUALIZE_THRESHOLD;
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: filteredOptions.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => PICKER_ROW_ESTIMATE_PX,
    getItemKey: (index) => filteredOptions[index]?.value ?? index,
    overscan: PICKER_OVERSCAN,
    useAnimationFrameWithResizeObserver: true,
  });

  /* When the dropdown opens (or its filtered list changes via search), highlight
     the current value — or, while filtering, the first enabled match. Closing
     clears the highlight. */
  useEffect(() => {
    if (!open) {
      setActiveIndex(-1);
      return;
    }
    const firstEnabled = filteredOptions.findIndex((opt) => !opt.disabled);
    if (query.trim()) {
      setActiveIndex(firstEnabled);
      return;
    }
    const selected = filteredOptions.findIndex((opt) => opt.value === value && !opt.disabled);
    setActiveIndex(selected >= 0 ? selected : firstEnabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filteredOptions is derived from query+options; re-run on open/query.
  }, [open, query]);

  /* Keep the highlighted option scrolled into the list's bounded viewport. The
     virtualized path must scroll by index (the active row may not be in the DOM). */
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    if (shouldVirtualize) {
      rowVirtualizer.scrollToIndex(activeIndex, { align: 'auto' });
    } else {
      expansionRef.current
        ?.querySelector('[data-active="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowVirtualizer identity is stable per lib; re-run on open/activeIndex/mode.
  }, [open, activeIndex, shouldVirtualize]);

  const moveActive = (delta: 1 | -1) => {
    setActiveIndex((cur) => {
      const start = cur < 0 ? (delta > 0 ? 0 : filteredOptions.length - 1) : cur + delta;
      for (let i = start; i >= 0 && i < filteredOptions.length; i += delta) {
        if (!filteredOptions[i]?.disabled) return i;
      }
      return cur;
    });
  };

  /* Keyboard control while the dropdown is open. Shared by the trigger button and
     the (autofocused) search input: ↑/↓ move the highlight, Enter selects, Esc closes
     and refocuses the trigger. Space selects only from the trigger — in the search
     input it must keep typing literal spaces. */
  const handleOpenListKey = (
    event: ReactKeyboardEvent<HTMLElement>,
    { allowSpaceSelect }: { allowSpaceSelect: boolean }
  ) => {
    const selectActive = () => {
      const opt = activeIndex >= 0 ? filteredOptions[activeIndex] : undefined;
      if (opt && !opt.disabled) handleSelect(opt.value);
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex(filteredOptions.findIndex((opt) => !opt.disabled));
        break;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex(filteredOptions.map((opt) => !opt.disabled).lastIndexOf(true));
        break;
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        selectActive();
        break;
      case ' ':
        if (!allowSpaceSelect) break; // a focused search input keeps typing spaces
        event.preventDefault();
        event.stopPropagation();
        selectActive();
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      default:
        break;
    }
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // Only own keys while open. When closed, let arrows bubble to any roving
    // controller that moves between triggers.
    if (!open) return;
    handleOpenListKey(event, { allowSpaceSelect: true });
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    handleOpenListKey(event, { allowSpaceSelect: false });
  };

  /* One option row, shared by the plain and virtualized lists. `virtual` is passed only
     in the virtualized path: it absolutely-positions the row and wires `measureElement`
     for dynamic height. The row is a `div[role=option]`; the inner button stays the
     active/click target (carries the id `aria-activedescendant` points at). */
  const renderOption = (
    opt: MobileInlinePickerOption<T>,
    index: number,
    virtual?: { measureRef: (el: HTMLDivElement | null) => void; start: number }
  ) => {
    const isSelected = opt.value === value;
    const isActive = index === activeIndex;
    return (
      <div
        key={opt.value}
        role="option"
        aria-selected={isSelected}
        data-index={index}
        ref={virtual?.measureRef}
        style={
          virtual
            ? {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtual.start}px)`,
              }
            : undefined
        }
      >
        <button
          type="button"
          id={optionId(index)}
          data-active={isActive}
          disabled={opt.disabled}
          title={opt.disabled ? opt.disabledReason : undefined}
          onClick={() => {
            if (opt.disabled) return;
            handleSelect(opt.value);
          }}
          onPointerMove={() => {
            if (!opt.disabled && !isActive) setActiveIndex(index);
          }}
          className={cn(
            'flex w-full select-none items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
            'hover:bg-hover/60 focus-visible:outline-none focus-visible:bg-hover/60',
            isActive && 'bg-hover/60',
            isSelected && 'text-foreground',
            opt.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
          )}
        >
          {opt.icon ? (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center opacity-80">
              {opt.icon}
            </span>
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{opt.label}</span>
            {opt.provider ? (
              <span className="truncate text-xs text-muted-foreground">{opt.provider}</span>
            ) : null}
            {opt.description ? (
              <span className="truncate text-xs text-muted-foreground">{opt.description}</span>
            ) : null}
          </span>
          {isSelected ? (
            <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          ) : null}
        </button>
      </div>
    );
  };

  const triggerElement = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => {
        if (disabled || loading) return;
        setOpen(!open);
      }}
      onKeyDown={handleTriggerKeyDown}
      disabled={disabled || loading}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
      aria-label={ariaLabel}
      className={cn(
        'group/picker-trigger flex w-full select-none items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm font-medium transition-all',
        'bg-input/40 text-foreground/85',
        'hover:bg-muted/60 hover:text-foreground',
        'active:scale-[0.985]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        /* Open state: subtle ring + slightly darker bg so the trigger
           reads as "expanded" even without a chevron. */
        open && 'bg-muted/70 text-foreground ring-2 ring-primary/30',
        (disabled || loading) && 'cursor-not-allowed opacity-60',
        triggerClassName
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {loading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin opacity-70" aria-hidden="true" />
            {loadingText ? <span className="truncate">{loadingText}</span> : triggerContent}
          </>
        ) : (
          triggerContent
        )}
      </span>
    </button>
  );

  /* In-flow accordion: height animates from 0 → auto so the list +
     search "pull down from behind" the trigger row, and content
     below shifts down rather than being overlaid. For portaled
     rendering, the same motion node is mounted into the host's tree
     position instead. */
  const expansionElement = (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key={`picker-expansion-${id}`}
          ref={expansionRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className={cn('overflow-hidden', expansionClassName)}
        >
          <div
            className={cn(
              /* Search at the top, list below — the standard mobile
                 list-with-search layout (iOS Contacts, Telegram,
                 Gmail compose, Material UI Autocomplete). The first
                 reachable target is the search input right under the
                 trigger; the keyboard rising from the bottom never
                 competes with the search input because the input
                 sits high in the panel. List below it has its own
                 `max-h + overflow-y-auto`, so long lists scroll
                 within their bounded area instead of pushing the
                 search away. */
              'mt-1.5 flex flex-col rounded-lg border border-border/60 bg-popover text-popover-foreground shadow-lg overflow-hidden',
              expansionPanelClassName
            )}
          >
            {searchable ? (
              <PickerSearchInput
                query={query}
                onQueryChange={setQuery}
                placeholder={searchPlaceholder}
                ariaLabel={searchPlaceholder ?? ariaLabel}
                autoFocus={autoFocusSearch}
                onKeyDown={handleSearchKeyDown}
              />
            ) : null}
            <div
              ref={listRef}
              className="scroll-pro scrollbar-pro max-h-[200px] overflow-y-auto py-1 [scrollbar-gutter:auto]"
            >
              {filteredOptions.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">{emptyText ?? '—'}</div>
              ) : shouldVirtualize ? (
                <div
                  className="relative w-full"
                  style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                    const opt = filteredOptions[virtualItem.index];
                    if (!opt) return null;
                    return renderOption(opt, virtualItem.index, {
                      measureRef: rowVirtualizer.measureElement,
                      start: virtualItem.start,
                    });
                  })}
                </div>
              ) : (
                filteredOptions.map((opt, index) => renderOption(opt, index))
              )}
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  if (effectivePortalContainer) {
    return (
      <>
        {triggerElement}
        {createPortal(expansionElement, effectivePortalContainer)}
      </>
    );
  }

  return (
    <div className="w-full">
      {triggerElement}
      {expansionElement}
    </div>
  );
}

/* ── Menu (arbitrary-content sibling of MobileInlinePicker) ──────────── */

export type MobileInlineMenuProps = {
  /** Unique id within the active `MobileInlinePickerCoordinator`; used
     to enforce "only one open at a time" across the sheet AND to let
     an external button open this menu via
     `useMobileInlinePickerCoordinator().requestActive(id)`. */
  id: string;
  triggerContent: ReactNode;
  ariaLabel: string;
  /** Panel body. Receives a `close` callback so action rows can
     dismiss the menu (toggle rows that want to stay open simply
     don't call it). */
  children: (api: { close: () => void }) => ReactNode;
  disabled?: boolean;
  /** Fully replaces the default trigger className — the picker's
     pill-style default doesn't fit narrow icon-only triggers like
     the composer's "+" button, so each consumer styles its own. */
  triggerClassName?: string;
  expansionClassName?: string;
  expansionPanelClassName?: string;
  /** Where to portal the expansion panel. When omitted, falls back to
     the nearest `MobileInlinePickerRowSlot` if present; otherwise
     renders inline below the trigger. */
  portalContainer?: HTMLElement | null;
};

function isFocusableMenuControl(element: HTMLElement): boolean {
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  if (element.getAttribute('tabindex') === '-1') return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  return true;
}

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable;
}

/**
 * Arbitrary-content companion to `MobileInlinePicker`. Shares the same
 * coordinator + row-slot mechanism so a menu opens with the same drop-
 * in-below-the-row animation and auto-closes whenever any sibling
 * picker / menu opens. Use this for chips whose panel isn't a list of
 * mutually-exclusive options (e.g. the composer's "+" button, which
 * mixes an action row with toggles).
 */
export function MobileInlineMenu({
  id,
  triggerContent,
  ariaLabel,
  children,
  disabled = false,
  triggerClassName,
  expansionClassName,
  expansionPanelClassName,
  portalContainer,
}: MobileInlineMenuProps) {
  const coordinator = useContext(PickerCoordinatorContext);
  const rowSlot = useContext(RowExpansionSlotContext);
  const effectivePortalContainer = portalContainer ?? rowSlot ?? null;

  const [localOpen, setLocalOpen] = useState(false);
  const open = coordinator ? coordinator.activeId === id : localOpen;
  const setOpen = (next: boolean) => {
    if (coordinator) coordinator.requestActive(next ? id : null);
    else setLocalOpen(next);
  };

  const triggerRef = useRef<HTMLButtonElement>(null);
  const expansionRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (expansionRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setOpen is stable
  }, [open, coordinator]);

  useEffect(() => {
    if (!open) return undefined;

    const menuControls = () =>
      Array.from(
        expansionRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="menuitem"], [role="radio"]'
        ) ?? []
      ).filter(isFocusableMenuControl);

    const focusByOffset = (offset: 1 | -1) => {
      const controls = menuControls();
      if (controls.length === 0) return false;
      const active = document.activeElement;
      const currentIndex = active instanceof HTMLElement ? controls.indexOf(active) : -1;
      const nextIndex =
        currentIndex < 0
          ? offset > 0
            ? 0
            : controls.length - 1
          : (currentIndex + offset + controls.length) % controls.length;
      controls[nextIndex]?.focus();
      return true;
    };

    const focusEdge = (edge: 'first' | 'last') => {
      const controls = menuControls();
      if (controls.length === 0) return false;
      controls[edge === 'first' ? 0 : controls.length - 1]?.focus();
      return true;
    };

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as Element | null;
      const targetInsideMenu =
        !!target &&
        (triggerRef.current?.contains(target) || expansionRef.current?.contains(target));
      if (!targetInsideMenu && event.key !== 'Escape') return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }

      if (!targetInsideMenu || isEditableElement(target)) return;

      const handled = (() => {
        switch (event.key) {
          case 'ArrowDown':
          case 'ArrowRight':
            return focusByOffset(1);
          case 'ArrowUp':
          case 'ArrowLeft':
            return focusByOffset(-1);
          case 'Home':
            return focusEdge('first');
          case 'End':
            return focusEdge('last');
          default:
            return false;
        }
      })();

      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setOpen is stable
  }, [open, coordinator]);

  const close = () => setOpen(false);

  const triggerElement = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => {
        if (disabled) return;
        setOpen(!open);
      }}
      disabled={disabled}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={ariaLabel}
      className={cn(triggerClassName, 'select-none')}
    >
      {triggerContent}
    </button>
  );

  const expansionElement = (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key={`menu-expansion-${id}`}
          ref={expansionRef}
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className={cn('overflow-hidden', expansionClassName)}
        >
          <div
            className={cn(
              'mt-1.5 rounded-lg border border-border/60 bg-popover p-1 text-popover-foreground shadow-lg',
              expansionPanelClassName
            )}
          >
            {children({ close })}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  if (effectivePortalContainer) {
    return (
      <>
        {triggerElement}
        {createPortal(expansionElement, effectivePortalContainer)}
      </>
    );
  }

  return (
    <div className="w-full">
      {triggerElement}
      {expansionElement}
    </div>
  );
}

/**
 * Top-anchored search row inside the picker panel. Sits above the
 * options list (`border-b` separates them), so when the keyboard
 * rises it never competes with the search input — the input is
 * already high in the drawer, well above the keyboard's reach.
 * This is the standard mobile list-with-search layout (iOS
 * Contacts, Telegram, Gmail, Material UI Autocomplete).
 *
 * On desktop (`autoFocus`, gated on `pointer: fine` by the caller) it grabs
 * focus on open so the user can type immediately, then drive the list with
 * ↑/↓/Enter/Esc via `onKeyDown`. On touch it stays unfocused so the soft
 * keyboard doesn't pop up.
 *
 * `type="text"`, not `type="search"`: the search type draws
 * `::-webkit-search-cancel-button` in the browser's own accent — a blue ✕ in
 * Chromium's dark scheme, a grey disc in WebKit — which belongs to no theme and
 * is the wrong size for a thumb, and declining to summon it is cheaper than
 * un-drawing it. The clear button below is ours, and touch is exactly where one
 * earns its place: there is no Esc key to abandon a query with.
 */
function PickerSearchInput({
  query,
  onQueryChange,
  placeholder,
  ariaLabel,
  autoFocus,
  onKeyDown,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  placeholder: string | undefined;
  ariaLabel: string | undefined;
  autoFocus?: boolean;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- desktop-only (pointer: fine); the picker opens on explicit user action, so focusing its search is expected.
        autoFocus={autoFocus}
        className="min-w-0 flex-1 border-none bg-transparent text-sm outline-none focus:outline-none focus:ring-0 placeholder:text-muted-foreground"
      />
      {query ? (
        <button
          type="button"
          aria-label={t('common.clear', 'Clear')}
          // Clearing keeps the field focused: on touch, blurring here would
          // drop the keyboard the user is still typing on.
          onClick={() => {
            onQueryChange('');
            inputRef.current?.focus();
          }}
          className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-hover/60 hover:text-foreground active:bg-hover/60"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
