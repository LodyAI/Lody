import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

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
  trigger: {
    minWidth: 'calc(var(--spacing) * 0)',
    userSelect: 'none',
    gap: 'calc(var(--spacing) * 1)',
    color: {
      default: 'color-mix(in oklab, hsl(var(--foreground) / 1) 70%, transparent)',
      ':hover': {
        default: 'color-mix(in oklab, hsl(var(--foreground) / 1) 70%, transparent)',
        '@media (hover: hover)': 'hsl(var(--foreground) / 1)',
      },
    },
    boxShadow: { default: 'none', ':focus-visible': 'none' },
  },
  compact: {
    borderRadius: '4px',
    color: {
      default: 'hsl(var(--muted-foreground) / 1)',
      ':hover': {
        default: 'hsl(var(--muted-foreground) / 1)',
        '@media (hover: hover)': 'hsl(var(--foreground) / 1)',
      },
    },
    backgroundColor: {
      default: 'transparent',
      ':hover': {
        default: 'transparent',
        '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--muted) / 1) 60%, transparent)',
      },
    },
  },
  iconTrigger: { borderRadius: '4px' },
  compactIcon: { paddingInline: 'calc(var(--spacing) * 0)' },
  labelTrigger: { paddingInline: 'calc(var(--spacing) * 2)' },
  compactLabel: { flexShrink: 1 },
  pill: {
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: { default: 'transparent', ':hover': 'hsl(var(--hover) / 1)' },
  },
  plain: {
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 1)',
    backgroundColor: { default: 'transparent', ':hover': 'transparent' },
  },
  compactText: { fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-tight)' },
  label: { fontWeight: 'var(--font-weight-medium)' },
  icon: { display: 'flex', flexShrink: 0, alignItems: 'center' },
  chevron: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    opacity: 0.7,
  },
});

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
  variant = 'default',
  showDescription = true,
}: AcpSessionSelectProps) {
  const selectedOption = options.find((option) => option.value === value);
  const label = selectedOption?.label ?? placeholder ?? '';
  const isMenuEnabled = !disabled && options.length > 1;
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
      width={iconOnly ? 'calc(var(--spacing) * 6)' : variant === 'compact' ? 'auto' : undefined}
      height={
        variant === 'compact' || iconOnly ? 'calc(var(--spacing) * 6)' : 'calc(var(--spacing) * 8)'
      }
      shape={variant === 'default' && !iconOnly ? 'pill' : 'default'}
      xstyle={[
        styles.trigger,
        variant === 'compact' && styles.compact,
        iconOnly && styles.iconTrigger,
        variant === 'compact' && iconOnly && styles.compactIcon,
        !iconOnly && styles.labelTrigger,
        variant === 'compact' && !iconOnly && styles.compactLabel,
        variant === 'default' && !iconOnly && styles.pill,
        variant === 'text' && !iconOnly && styles.plain,
      ]}
      className={className}
      aria-label={withSelectedLabel(ariaLabel)}
      disabled={disabled}
      title={withSelectedLabel(triggerTitle) ?? label}
    >
      {icon ? (
        <span
          {...stylex.props(styles.icon, variant === 'compact' && !iconOnly && styles.compactText)}
        >
          {icon}
        </span>
      ) : null}
      {!iconOnly ? (
        <span {...stylex.props(styles.label, variant === 'compact' && styles.compactText)}>
          {label}
        </span>
      ) : null}
      {isMenuEnabled && !iconOnly ? <ChevronDown {...stylex.props(styles.chevron)} /> : null}
    </Button>
  );

  if (!isMenuEnabled) {
    return trigger;
  }

  return (
    <Menu.Root>
      <Menu.Trigger render={trigger}>{trigger}</Menu.Trigger>
      <Menu.Content align={align} minWidth={120} className={contentClassName}>
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
