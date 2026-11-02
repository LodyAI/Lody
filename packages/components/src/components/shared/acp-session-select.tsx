import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

import { cn } from '@/lib/utils';
import {
  acpCompactIconClass,
  acpCompactTextLeadClass,
  acpCompactTextTailClass,
  acpMinimumClass,
  acpGapClass,
  acpIconClass,
  acpLabelClass,
  acpPlainCornerClass,
  acpPlainPaddingClass,
  acpMediumWeightClass,
} from '@/style/legacy-defaults.stylex';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@/ui/armed-overlays';
import { Menu } from '@/ui/menu';

export type AcpSessionSelectOption = {
  value: string;
  label: string;
  description?: string;
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

const styles = stylex.create({
  icon: { display: 'flex', flexShrink: 0, alignItems: 'center' },
  chevron: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    opacity: 0.7,
  },
});

const compactClassName = (_isDark: boolean, iconOnly: boolean) =>
  cn(
    iconOnly
      ? acpCompactIconClass
      : `${acpCompactTextLeadClass} shrink ${acpCompactTextTailClass} [&_span]:text-xs [&_span]:leading-tight`,
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
  // Icon-only triggers hide the selected label, so the tooltip and the
  // accessible name carry it instead ("Permission mode: Plan").
  const withSelectedLabel = (name: string | undefined) =>
    iconOnly && label ? (name ? `${name}: ${label}` : label) : name;

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="mini"
      icon={iconOnly}
      className={cn(
        `${acpMinimumClass} select-none ${acpGapClass} text-foreground/70 hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0`,
        variant === 'compact' && compactClassName(isDark, iconOnly),
        variant !== 'compact' && iconOnly && acpIconClass,
        variant !== 'compact' && !iconOnly && acpLabelClass,
        variant === 'default' && !iconOnly && 'rounded-full hover:bg-hover',
        variant === 'text' &&
          !iconOnly &&
          `${acpPlainCornerClass} bg-transparent ${acpPlainPaddingClass} hover:bg-transparent`,
        className
      )}
      aria-label={withSelectedLabel(ariaLabel)}
      disabled={disabled}
      title={withSelectedLabel(triggerTitle) ?? label}
    >
      {icon ? <span {...stylex.props(styles.icon)}>{icon}</span> : null}
      {!iconOnly ? <span className={acpMediumWeightClass}>{label}</span> : null}
      {isMenuEnabled && !iconOnly ? <ChevronDown {...stylex.props(styles.chevron)} /> : null}
    </Button>
  );

  if (!isMenuEnabled) {
    return trigger;
  }

  return (
    <Menu.Root>
      <Menu.Trigger render={trigger}>{trigger}</Menu.Trigger>
      <Menu.Content align={align} className={cn('min-w-[120px]', contentClassName)}>
        <Menu.RadioGroup value={value ?? ''} onValueChange={onChange}>
          {options.map((option) => {
            const menuItem = (
              <Menu.RadioItem
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                indicator="check"
                indicatorSide="end"
              >
                {option.label}
              </Menu.RadioItem>
            );

            if (showDescription && option.description) {
              return (
                <Tooltip.Root key={option.value}>
                  <Tooltip.Trigger delay={500} render={menuItem} />
                  <Tooltip.Content side="right">{option.description}</Tooltip.Content>
                </Tooltip.Root>
              );
            }
            return menuItem;
          })}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  );
}
