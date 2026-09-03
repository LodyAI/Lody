import { ChevronsUpDown, Loader2 } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type MobileNativeSelectOption<T extends string = string> = {
  value: T;
  label: string;
  group?: string;
  disabled?: boolean;
};

export type MobileNativeSelectProps<T extends string = string> = {
  value: T | null | undefined;
  onChange: (value: T) => void;
  options: MobileNativeSelectOption<T>[];
  triggerContent: ReactNode;
  ariaLabel: string;
  disabled?: boolean;
  loading?: boolean;
  loadingText?: ReactNode;
  showIndicator?: boolean;
  className?: string;
};

/**
 * A visually branded trigger backed by a real HTML select. Touch platforms
 * therefore present their system option picker instead of an app-owned menu.
 */
export function MobileNativeSelect<T extends string = string>({
  value,
  onChange,
  options,
  triggerContent,
  ariaLabel,
  disabled = false,
  loading = false,
  loadingText,
  showIndicator = true,
  className,
}: MobileNativeSelectProps<T>) {
  const hasAlternative = options.some((option) => !option.disabled && option.value !== value);
  const isInteractive = !disabled && !loading && hasAlternative;
  const groupedOptions = options.reduce<
    Array<{ label: string | null; options: MobileNativeSelectOption<T>[] }>
  >((groups, option) => {
    const label = option.group ?? null;
    const existing = groups.find((group) => group.label === label);
    if (existing) {
      existing.options.push(option);
    } else {
      groups.push({ label, options: [option] });
    }
    return groups;
  }, []);

  return (
    <div
      className={cn(
        'relative flex h-8 w-full select-none items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm font-medium',
        'text-foreground/85 transition-colors hover:text-foreground',
        (disabled || loading) && 'opacity-60',
        className
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {loading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin opacity-70" aria-hidden="true" />
            {loadingText ?? triggerContent}
          </>
        ) : (
          triggerContent
        )}
      </span>
      {isInteractive && showIndicator ? (
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
      ) : null}
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value as T)}
        disabled={!isInteractive}
        aria-label={ariaLabel}
        className={cn(
          'absolute inset-0 h-full w-full appearance-none opacity-0 outline-none',
          isInteractive ? 'cursor-pointer' : 'cursor-default'
        )}
      >
        <option value="" disabled>
          {ariaLabel}
        </option>
        {groupedOptions.map((group) => {
          const optionNodes = group.options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ));
          return group.label ? (
            <optgroup key={group.label} label={group.label}>
              {optionNodes}
            </optgroup>
          ) : (
            <Fragment key="ungrouped">{optionNodes}</Fragment>
          );
        })}
      </select>
    </div>
  );
}
