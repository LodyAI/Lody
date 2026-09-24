import {
  useEffect,
  useMemo,
  useState,
  useRef,
  useLayoutEffect,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronDown, Check } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Command as CommandPrimitive } from 'cmdk';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Popover } from '@lody/ui/popover';
import { fuzzyMatch } from '@/components/commands/fuzzy-match';
import { restoreComposerFocusAfterMenu } from '@/lib/menu-focus';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { withClassName } from '@/lib/stylex';
import { composerSurface as surface } from './composer-surface';

// Above this many options the dropdown virtualizes (branch/project lists can be huge).
// Below it, cmdk's built-in filtering renders all items — unchanged, zero risk.
const OPTION_SELECTOR_VIRTUALIZE_THRESHOLD = 60;
const OPTION_SELECTOR_ROW_ESTIMATE_PX = 28;
const OPTION_SELECTOR_OVERSCAN = 10;

export interface OptionSelectorOption<TValue extends string | number = string> {
  value: TValue;
  label: string;
  key?: string;
  icon?: LucideIcon | ComponentType<{ className?: string }>;
  iconClassName?: string;
  startContent?: ReactNode;
  endContent?: ReactNode;
  description?: string;
  disabled?: boolean;
}

type SelectorSize = 'sm' | 'md' | 'lg';
type SelectorTone = 'light' | 'dark';

/**
 * The material the trigger takes from where it sits.
 *
 * - `toolbar`: a ghost control in the composer's toolbar and the context pills
 *   above it — no fill or edge at rest, the hover fill under the pointer, the
 *   type in `em` of the font-size tier.
 * - `field`: a form value, so the one recessed well every value holder takes.
 */
export type OptionSelectorAppearance = 'toolbar' | 'field';

export interface OptionSelectorProps<TValue extends string | number = string> {
  value?: TValue | null;
  options: OptionSelectorOption<TValue>[];
  onSelect: (option: OptionSelectorOption<TValue>) => void;
  placeholder?: string;
  placeholderIcon?: LucideIcon | ComponentType<{ className?: string }>;
  /** Trigger material; see `OptionSelectorAppearance`. Defaults to `field`. */
  appearance?: OptionSelectorAppearance;
  /** Layout only (width, flex); the trigger's look is `appearance`'s. */
  className?: string;
  /** Layout only (width); the popup's look is the floating rung's. */
  contentClassName?: string;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  avoidCollisions?: boolean;
  /**
   * Control height. A `field` reads the field ladder (28 / 32 / 36); a
   * `toolbar` trigger is 24px at `sm` (inside a context pill) and 28px above.
   */
  size?: SelectorSize;
  /** @deprecated The popup reads the palette in force; kept for callers. */
  tone?: SelectorTone;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  renderTriggerValue?: (option?: OptionSelectorOption<TValue>) => ReactNode;
  renderOption?: (option: OptionSelectorOption<TValue>, isSelected: boolean) => ReactNode;
  showChevron?: boolean;
  /** When false, the search input won't auto-focus when the popover opens. */
  autoFocusSearch?: boolean;
}

const styles = stylex.create({
  // The list scrolls under the search field; the cap keeps it clear of the
  // viewport edge the popup landed against.
  scroll: { maxHeight: 'min(60vh, 320px, calc(var(--available-height) - 3rem))' },
  virtualSizer: { position: 'relative', width: '100%' },
  virtualRow: { position: 'absolute', top: 0, left: 0, width: '100%' },
});

const fieldSizes = {
  sm: surface.fieldSmall,
  md: surface.fieldMedium,
  lg: surface.fieldLarge,
} as const;

const getOptionKey = <TValue extends string | number>(option: OptionSelectorOption<TValue>) =>
  option.key ?? String(option.value);

const getOptionSearchText = <TValue extends string | number>(
  option: OptionSelectorOption<TValue>
) =>
  // De-dupe: key usually equals the label (value === label), and a repeated token lets a
  // fuzzy/subsequence query match far too loosely (e.g. "x-99" hitting "x-19 x-19").
  [...new Set([getOptionKey(option), option.label, option.description].filter(Boolean))].join(' ');

export function OptionSelector<TValue extends string | number = string>({
  value,
  options,
  onSelect,
  placeholder,
  placeholderIcon,
  appearance = 'field',
  className,
  contentClassName,
  disabled = false,
  searchable = false,
  searchPlaceholder,
  emptyText,
  align = 'start',
  side,
  avoidCollisions,
  size = 'md',
  open,
  onOpenChange,
  renderTriggerValue,
  renderOption,
  showChevron = true,
  autoFocusSearch = true,
}: OptionSelectorProps<TValue>) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const didSelectItemRef = useRef(false);
  const [contentWidth, setContentWidth] = useState<number | undefined>(undefined);
  // Tracks search input changes so we can reset scroll position.
  const [searchToken, setSearchToken] = useState(0);
  // The row under the keyboard or pointer, as cmdk reports it: StyleX cannot read
  // cmdk's `data-selected`, so the highlight is state rather than an attribute.
  const [highlighted, setHighlighted] = useState('');

  // Focus into the dropdown (search input → cmdk ↑/↓ then work) on open, but only with a
  // precise pointer (desktop). Never on touch, where it would raise the soft keyboard.
  // Callers can still force it off with `autoFocusSearch={false}`.
  const autoFocusOnOpen = useMemo(
    () =>
      autoFocusSearch &&
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(pointer: fine)').matches,
    [autoFocusSearch]
  );

  const [query, setQuery] = useState('');
  const listViewportRef = useRef<HTMLDivElement>(null);
  const virtualize = options.length > OPTION_SELECTOR_VIRTUALIZE_THRESHOLD;

  // cmdk schedules scrollIntoView via rAF inside its own useLayoutEffect.
  // Because React fires child layout effects before parent ones, registering
  // our rAF here (in the parent) guarantees it runs *after* cmdk's in the
  // same animation frame — before the browser paints — so there's no flicker.
  useLayoutEffect(() => {
    if (!searchable || searchToken === 0) return undefined;
    const id = requestAnimationFrame(() => {
      const viewport = listViewportRef.current;
      if (viewport) viewport.scrollTop = 0;
    });
    return () => cancelAnimationFrame(id);
  }, [searchToken, searchable]);

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value),
    [options, value]
  );
  // Dialog's scroll lock blocks wheel events in body-level portals. Keeping the menu
  // inside the dialog content preserves scrolling without changing standalone selectors.
  const portalContainer = isOpen
    ? triggerRef.current?.closest<HTMLElement>('[data-lody-dialog-content]')
    : null;

  // When virtualizing we filter ourselves (cmdk can't both filter AND hand us the result
  // to virtualize), reusing the command-palette's fuzzy scorer. Small lists keep cmdk's
  // built-in filtering untouched.
  const filteredOptions = useMemo(() => {
    if (!virtualize) return options;
    const q = query.trim();
    if (!q) return options;
    return options
      .map((option) => ({ option, score: fuzzyMatch(q, getOptionSearchText(option)) }))
      .filter(
        (entry): entry is { option: OptionSelectorOption<TValue>; score: number } =>
          entry.score !== null
      )
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.option);
  }, [virtualize, options, query]);

  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: filteredOptions.length,
    getScrollElement: () => listViewportRef.current,
    estimateSize: () => OPTION_SELECTOR_ROW_ESTIMATE_PX,
    getItemKey: (index) => getOptionKey(filteredOptions[index]!) ?? index,
    overscan: OPTION_SELECTOR_OVERSCAN,
    useAnimationFrameWithResizeObserver: true,
  });

  // The popover's scroll viewport only mounts (and gets its real height) after open, so
  // the virtualizer measures 0 on the first frame and getVirtualItems() comes back empty.
  // Re-measure once the popover is open so the rows actually render.
  useEffect(() => {
    if (!isOpen || !virtualize) return undefined;
    const raf = requestAnimationFrame(() => rowVirtualizer.measure());
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowVirtualizer is stable; re-run on open.
  }, [isOpen, virtualize]);

  useLayoutEffect(() => {
    const element = triggerRef.current;
    if (!element) return undefined;
    const updateWidth = () => setContentWidth(element.offsetWidth);
    updateWidth();

    if (typeof ResizeObserver !== 'undefined') {
      return observeResizeOnAnimationFrame(element, () => updateWidth());
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    return undefined;
  }, []);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      didSelectItemRef.current = false;
    } else {
      setQuery(''); // reopen starts unfiltered
    }
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  };

  const handleSelect = (key: string) => {
    const option = options.find((opt) => getOptionKey(opt) === key);
    if (!option || option.disabled) return;
    didSelectItemRef.current = true;
    onSelect(option);
    handleOpenChange(false);
  };

  const renderIcon = (option?: OptionSelectorOption<TValue>) => {
    if (option?.startContent) return option.startContent;
    const Icon = option?.icon ?? placeholderIcon;
    if (!Icon) return null;
    return <Icon {...withClassName(stylex.props(surface.glyph16), option?.iconClassName)} />;
  };

  const isField = appearance === 'field';
  const triggerContent = renderTriggerValue ? (
    renderTriggerValue(selectedOption)
  ) : (
    <>
      {renderIcon(selectedOption)}
      <span {...stylex.props(surface.truncate)}>{selectedOption?.label ?? placeholder ?? ''}</span>
    </>
  );

  // One option row, shared by the plain and virtualized lists. `virtual` is passed only
  // in the virtualized path (absolute-positions the row + wires `measureElement` for the
  // variable height of rows with a description).
  const renderOptionItem = (
    option: OptionSelectorOption<TValue>,
    virtual?: { measureRef: (el: HTMLDivElement | null) => void; index: number; start: number }
  ) => {
    const optionKey = getOptionKey(option);
    const itemValue = getOptionSearchText(option);
    const isSelected = Boolean(selectedOption && optionKey === getOptionKey(selectedOption));
    const isHighlighted = highlighted !== '' && highlighted === itemValue.trim();
    const rowProps = stylex.props(
      surface.row,
      virtual && styles.virtualRow,
      isHighlighted && surface.rowHighlighted,
      option.disabled && surface.rowDisabled
    );
    return (
      <CommandPrimitive.Item
        key={optionKey}
        ref={virtual?.measureRef}
        data-index={virtual?.index}
        value={itemValue}
        onSelect={() => handleSelect(optionKey)}
        disabled={option.disabled}
        className={rowProps.className}
        style={
          virtual ? { ...rowProps.style, transform: `translateY(${virtual.start}px)` } : undefined
        }
      >
        {renderOption ? (
          renderOption(option, isSelected)
        ) : (
          <>
            {option.startContent || option.icon || placeholderIcon ? (
              <span {...stylex.props(surface.rowIcon)}>{renderIcon(option)}</span>
            ) : null}
            <span
              {...stylex.props(surface.rowText, !!option.description && surface.rowTextStacked)}
            >
              <span {...stylex.props(surface.rowLabel)}>{option.label}</span>
              {option.description && (
                <span {...stylex.props(surface.rowDescription)}>{option.description}</span>
              )}
            </span>
            {option.endContent}
          </>
        )}
        <span {...stylex.props(surface.rowTick)}>
          {isSelected ? <Check {...stylex.props(surface.glyph16)} aria-hidden="true" /> : null}
        </span>
      </CommandPrimitive.Item>
    );
  };

  return (
    <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        ref={triggerRef}
        type="button"
        disabled={disabled}
        className={(state) =>
          withClassName(
            stylex.props(
              isField ? surface.field : surface.trigger,
              isField && fieldSizes[size],
              !isField && size === 'sm' && surface.triggerSmall,
              isField && !selectedOption && surface.fieldPlaceholder,
              !isField && state.open && surface.triggerOpen
            ),
            className
          ).className ?? ''
        }
      >
        <span {...stylex.props(surface.value)}>{triggerContent}</span>
        {showChevron ? <ChevronDown {...stylex.props(surface.chevron)} aria-hidden="true" /> : null}
      </Popover.Trigger>
      <Popover.Content
        className={contentClassName}
        container={portalContainer}
        align={align}
        side={side}
        collisionAvoidance={
          avoidCollisions === false
            ? { side: 'none', align: 'none', fallbackAxisSide: 'none' }
            : undefined
        }
        style={{ minWidth: contentWidth ? `${contentWidth}px` : undefined }}
        initialFocus={!autoFocusOnOpen ? false : undefined}
        finalFocus={() => {
          const didSelectItem = didSelectItemRef.current;
          didSelectItemRef.current = false;
          if (!didSelectItem) return undefined;
          // A selection answers to the composer, never back to the trigger.
          restoreComposerFocusAfterMenu();
          return false;
        }}
      >
        <CommandPrimitive
          shouldFilter={!virtualize}
          value={highlighted}
          onValueChange={setHighlighted}
          {...stylex.props(surface.popupList)}
        >
          {searchable && (
            <CommandPrimitive.Input
              placeholder={searchPlaceholder ?? 'Search...'}
              value={query}
              onValueChange={(nextQuery: string) => {
                setQuery(nextQuery);
                setSearchToken((n) => n + 1);
              }}
              {...stylex.props(surface.search)}
            />
          )}
          <CommandPrimitive.List
            ref={listViewportRef}
            {...stylex.props(surface.popupScroll, styles.scroll)}
          >
            <CommandPrimitive.Empty {...stylex.props(surface.empty)}>
              {emptyText ?? 'No results found'}
            </CommandPrimitive.Empty>
            {virtualize ? (
              <div
                {...stylex.props(styles.virtualSizer)}
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                  const option = filteredOptions[virtualItem.index];
                  if (!option) return null;
                  return renderOptionItem(option, {
                    measureRef: rowVirtualizer.measureElement,
                    index: virtualItem.index,
                    start: virtualItem.start,
                  });
                })}
              </div>
            ) : (
              options.map((option) => renderOptionItem(option))
            )}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </Popover.Content>
    </Popover.Root>
  );
}
