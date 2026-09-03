import type { ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

export type AcpSessionSelectOption = {
  value: string;
  label: string;
  description?: string;
  provider?: string;
  disabled?: boolean;
};

export type AcpSessionSelectProps = {
  value?: string | null;
  onChange: (value: string) => void;
  options: AcpSessionSelectOption[];
  placeholder?: string;
  icon?: ReactNode;
  iconOnly?: boolean;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  align?: 'start' | 'center' | 'end';
  ariaLabel?: string;
  /** Native hover tooltip for the trigger. Defaults to the selected option label. */
  triggerTitle?: string;
  tone?: 'light' | 'dark';
  /** 'default' = pill style, 'text' = borderless, 'compact' = small plain-text tag */
  variant?: 'default' | 'text' | 'compact';
  /** Show description as tooltip in dropdown items (default: true) */
  showDescription?: boolean;
};

const compactClassName = (_isDark: boolean, iconOnly: boolean) =>
  cn(
    iconOnly
      ? 'h-6 w-6 rounded-[4px] px-0'
      : 'h-6 w-auto min-w-0 shrink rounded-[4px] px-2 gap-1 [&_span]:text-xs [&_span]:leading-tight',
    'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
  );

export function AcpSessionSelect({
  value,
  onChange,
  options,
  placeholder,
  icon,
  iconOnly = false,
  disabled = false,
  className,
  contentClassName,
  align = 'start',
  ariaLabel,
  triggerTitle,
  tone = 'light',
  variant = 'default',
  showDescription = true,
}: AcpSessionSelectProps) {
  const selectedOption = options.find((option) => option.value === value);
  const label = selectedOption?.label ?? placeholder ?? '';
  const isMenuEnabled = !disabled && options.length > 1;
  const isDark = tone === 'dark';

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size={iconOnly ? 'icon' : 'sm'}
      className={cn(
        'min-w-0 select-none gap-1 text-foreground/70 hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0',
        variant === 'compact' && compactClassName(isDark, iconOnly),
        variant !== 'compact' && iconOnly && 'h-6 w-6 rounded-[4px]',
        variant !== 'compact' && !iconOnly && 'h-8 px-2',
        variant === 'default' && !iconOnly && 'rounded-full hover:bg-foreground/10',
        variant === 'text' && !iconOnly && 'rounded-md bg-transparent px-1 hover:bg-transparent',
        className
      )}
      aria-label={ariaLabel}
      disabled={disabled}
      title={triggerTitle ?? label}
    >
      {icon ? <span className="flex shrink-0 items-center">{icon}</span> : null}
      {!iconOnly ? <span className="font-medium">{label}</span> : null}
      {isMenuEnabled && !iconOnly ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
      ) : null}
    </Button>
  );

  if (!isMenuEnabled) {
    return trigger;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={cn('min-w-[120px]', contentClassName)}>
        {options.map((option) => {
          const isSelected = option.value === value;
          const menuItem = (
            <DropdownMenuItem
              key={option.value}
              disabled={option.disabled}
              onSelect={() => onChange(option.value)}
              className="items-start"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate">{option.label}</span>
                {option.provider ? (
                  <span className="truncate text-xs text-muted-foreground">{option.provider}</span>
                ) : null}
              </span>
              {isSelected ? <Check className="mt-0.5 h-3 w-3 opacity-70" /> : null}
            </DropdownMenuItem>
          );

          if (showDescription && option.description) {
            return (
              <Tooltip key={option.value} delayDuration={500}>
                <TooltipTrigger asChild>{menuItem}</TooltipTrigger>
                <TooltipContent side="right">{option.description}</TooltipContent>
              </Tooltip>
            );
          }
          return menuItem;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
