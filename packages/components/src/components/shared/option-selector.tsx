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
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@lody/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/ui/command';
import { fuzzyMatch } from '@/components/commands/fuzzy-match';
import { handleMenuCloseAutoFocus } from '@/lib/menu-focus';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { cn } from '@/lib/utils';

// Above this many options the dropdown virtualizes (branch/project lists can be huge).
// Below it, cmdk's built-in filtering renders all items — unchanged, zero risk.
const OPTION_SELECTOR_VIRTUALIZE_THRESHOLD = 60;
const OPTION_SELECTOR_ROW_ESTIMATE_PX = 36;
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

export interface OptionSelectorProps<TValue extends string | number = string> {
  value?: TValue | null;
  options: OptionSelectorOption<TValue>[];
  onSelect: (option: OptionSelectorOption<TValue>) => void;
  placeholder?: string;
  placeholderIcon?: LucideIcon | ComponentType<{ className?: string }>;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  avoidCollisions?: boolean;
  size?: SelectorSize;
  tone?: SelectorTone;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  renderTriggerValue?: (option?: OptionSelectorOption<TValue>) => ReactNode;
  renderOption?: (option: OptionSelectorOption<TValue>, isSelected: boolean) => ReactNode;
  showChevron?: boolean;
  /** When false, the search input won't auto-focus when the popover opens. */
  autoFocusSearch?: boolean;
}

const sizeClassMap: Record<SelectorSize, string> = {
  sm: 'h-8 text-xs',
  md: 'h-9 text-sm',
  lg: 'h-10 text-sm',
};

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
  tone = 'light',
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
  const isDark = tone === 'dark';
  const commandRef = useRef<HTMLDivElement>(null);
  // Tracks search input changes so we can reset scroll position.
  const [searchToken, setSearchToken] = useState(0);

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

  // cmdk schedules scrollIntoView via rAF inside its own useLayoutEffect.
  // Because React fires child layout effects before parent ones, registering
  // our rAF here (in the parent) guarantees it runs *after* cmdk's in the
  // same animation frame — before the browser paints — so there's no flicker.
  useLayoutEffect(() => {
    if (!searchable || searchToken === 0) return undefined;
    const id = requestAnimationFrame(() => {
      const viewport = commandRef.current?.querySelector('[data-radix-scroll-area-viewport]');
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

  const [query, setQuery] = useState('');
  const listViewportRef = useRef<HTMLDivElement>(null);
  const virtualize = options.length > OPTION_SELECTOR_VIRTUALIZE_THRESHOLD;

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
    return <Icon className={cn('h-4 w-4 shrink-0', option?.iconClassName)} />;
  };

  const triggerContent = renderTriggerValue ? (
    renderTriggerValue(selectedOption)
  ) : (
    <>
      {renderIcon(selectedOption)}
      <span className="truncate font-medium">{selectedOption?.label ?? placeholder ?? ''}</span>
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
    const isSelected = Boolean(selectedOption && optionKey === getOptionKey(selectedOption));
    return (
      <CommandItem
        key={optionKey}
        ref={virtual?.measureRef}
        data-index={virtual?.index}
        value={getOptionSearchText(option)}
        onSelect={() => handleSelect(optionKey)}
        disabled={option.disabled}
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
        className={cn(
          'flex cursor-pointer select-none items-center gap-2 rounded-none px-2 py-2 text-sm transition-colors',
          'hover:bg-muted/60',
          option.disabled && 'opacity-50 pointer-events-none'
        )}
      >
        {renderOption ? (
          renderOption(option, isSelected)
        ) : (
          <>
            {renderIcon(option)}
            <div className="flex flex-col min-w-0">
              <span className="truncate">{option.label}</span>
              {option.description && (
                <span className="text-xs text-muted-foreground">{option.description}</span>
              )}
            </div>
            {option.endContent}
          </>
        )}
        {isSelected && <Check className="ml-auto h-4 w-4 opacity-60" />}
      </CommandItem>
    );
  };

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            'w-auto select-none justify-between rounded-1 hover:foreground/70',
            sizeClassMap[size],
            disabled && 'opacity-50 pointer-events-none',
            className
          )}
          ref={triggerRef}
          disabled={disabled}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">{triggerContent}</span>
          {showChevron ? <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn('max-w-[calc(100vw-1rem)] p-0', contentClassName)}
        portalContainer={portalContainer}
        align={align}
        side={side}
        avoidCollisions={avoidCollisions}
        sideOffset={8}
        style={{ minWidth: contentWidth ? `${contentWidth}px` : undefined }}
        onOpenAutoFocus={!autoFocusOnOpen ? (e) => e.preventDefault() : undefined}
        onCloseAutoFocus={(event) => {
          const didSelectItem = didSelectItemRef.current;
          didSelectItemRef.current = false;
          handleMenuCloseAutoFocus(event, {
            didSelectItem,
            menuContent: event.currentTarget,
          });
        }}
      >
        <Command ref={commandRef} className="bg-transparent" shouldFilter={!virtualize}>
          {searchable && (
            <CommandInput
              placeholder={searchPlaceholder ?? 'Search...'}
              className="h-8"
              value={query}
              onValueChange={(nextQuery: string) => {
                setQuery(nextQuery);
                setSearchToken((n) => n + 1);
              }}
            />
          )}
          <CommandList
            viewportRef={listViewportRef}
            containerClassName="max-h-[min(60vh,320px,calc(var(--radix-popover-content-available-height)-3rem))]"
            viewportClassName="max-h-[min(60vh,320px,calc(var(--radix-popover-content-available-height)-3rem))] text-sm"
            viewportStyle={{ WebkitOverflowScrolling: 'touch' }}
          >
            <CommandEmpty
              className={cn(
                'ml-4 mt-2',
                isDark ? 'text-muted-foreground/80' : 'text-muted-foreground'
              )}
            >
              {emptyText ?? 'No results found'}
            </CommandEmpty>
            <CommandGroup className={virtualize ? 'p-0' : undefined}>
              {virtualize ? (
                <div
                  className="relative w-full"
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
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
