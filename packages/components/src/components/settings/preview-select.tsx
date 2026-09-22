import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover } from '@lody/ui/popover';
import { cn } from '@/lib/utils';

export interface PreviewSelectOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface PreviewSelectProps<T extends string> {
  value: T;
  options: PreviewSelectOption<T>[];
  /** Live-preview the hovered/highlighted value. Omit when the option has no live preview. */
  onPreview?: (value: T) => void;
  onCommit: (value: T) => void;
  /** Restore the original value when the popover closes without committing. */
  onCancel?: () => void;
  triggerClassName?: string;
  renderValue?: (option: PreviewSelectOption<T> | undefined) => ReactNode;
}

export function PreviewSelect<T extends string>({
  value,
  options,
  onPreview,
  onCommit,
  onCancel,
  triggerClassName,
  renderValue,
}: PreviewSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [frozenWidth, setFrozenWidth] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const originalValueRef = useRef(value);
  const committedRef = useRef(false);

  const selectedOption = options.find((o) => o.value === value);

  const handleOpen = useCallback(() => {
    originalValueRef.current = value;
    committedRef.current = false;
    const idx = options.findIndex((o) => o.value === value);
    setHighlightedIndex(idx >= 0 ? idx : 0);
    // Freeze the panel to the trigger width at open time. Hovering an option
    // live-previews a theme, whose reflow can nudge the trigger width; pinning
    // the panel to `--anchor-width` (re-measured live) would make
    // it jump. A snapshot keeps the width stable for the popover's lifetime.
    setFrozenWidth(triggerRef.current?.getBoundingClientRect().width ?? null);
    setOpen(true);
  }, [value, options]);

  const handleCommit = useCallback(
    (optionValue: T) => {
      committedRef.current = true;
      onCommit(optionValue);
      setOpen(false);
    },
    [onCommit]
  );

  const handleCancel = useCallback(() => {
    onCancel?.();
    setOpen(false);
  }, [onCancel]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        handleOpen();
      } else if (!committedRef.current) {
        handleCancel();
      } else {
        setOpen(false);
      }
    },
    [handleOpen, handleCancel]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) return;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const nextIndex = Math.min(highlightedIndex + 1, options.length - 1);
          setHighlightedIndex(nextIndex);
          const opt = options[nextIndex];
          if (opt) onPreview?.(opt.value);
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const prevIndex = Math.max(highlightedIndex - 1, 0);
          setHighlightedIndex(prevIndex);
          const opt = options[prevIndex];
          if (opt) onPreview?.(opt.value);
          break;
        }
        case 'Enter': {
          e.preventDefault();
          const opt = options[highlightedIndex];
          if (opt) handleCommit(opt.value);
          break;
        }
        case 'Escape': {
          e.preventDefault();
          handleCancel();
          break;
        }
      }
    },
    [open, highlightedIndex, options, onPreview, handleCommit, handleCancel]
  );

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || highlightedIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const items = list.querySelectorAll('[data-preview-item]');
    const item = items[highlightedIndex];
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [open, highlightedIndex]);

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger render={<button
          ref={triggerRef}
          type="button"
          className={cn(
            'flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input-border bg-input-field px-3 py-2 text-sm text-input-foreground shadow-xs ring-offset-background focus:outline-hidden focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60',
            triggerClassName
          )}
        >
          <span className="line-clamp-1">
            {renderValue ? renderValue(selectedOption) : selectedOption?.label}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>}/>
      <Popover.Content
        className="w-[var(--anchor-width)] p-1"
        style={frozenWidth != null ? { width: frozenWidth } : undefined}
        align="start"
        onKeyDown={handleKeyDown}
        // The list takes focus itself rather than an option inside it.
        initialFocus={listRef}
      >
        <div ref={listRef} tabIndex={-1} className="outline-hidden">
          {options.map((option, index) => (
            <div
              key={option.value}
              data-preview-item
              className={cn(
                'relative flex w-full cursor-default select-none items-center rounded-xs py-1.5 pl-2 pr-8 text-sm outline-hidden',
                index === highlightedIndex
                  ? 'bg-hover text-hover-foreground'
                  : 'hover:bg-hover hover:text-hover-foreground'
              )}
              onMouseEnter={() => {
                setHighlightedIndex(index);
                onPreview?.(option.value);
              }}
              onClick={() => handleCommit(option.value)}
            >
              <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                {option.value === originalValueRef.current && <Check className="h-4 w-4" />}
              </span>
              {option.label}
            </div>
          ))}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
