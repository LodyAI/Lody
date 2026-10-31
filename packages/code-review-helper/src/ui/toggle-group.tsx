import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const styles = stylex.create({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: 1,
    borderColor: 'hsl(var(--input))',
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 60%, transparent)',
    },
    padding: 'calc(var(--spacing) * 1)',
  },
  item: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'calc(var(--spacing) * 2)',
    whiteSpace: 'nowrap',
    borderRadius: 'calc(var(--radius) - 2px)',
  },
  ink: { color: 'hsl(var(--muted-foreground))' },
  outline: {
    borderStyle: 'var(--tw-border-style)',
    borderWidth: 1,
    borderColor: 'hsl(var(--input))',
    backgroundColor: 'hsl(var(--background))',
  },
  defaultSize: { height: 'calc(var(--spacing) * 8)', 'padding-inline': 'calc(var(--spacing) * 3)' },
  smallSize: { height: 'calc(var(--spacing) * 7)', 'padding-inline': 'calc(var(--spacing) * 2)' },
  largeSize: { height: 'calc(var(--spacing) * 9)', 'padding-inline': 'calc(var(--spacing) * 4)' },
});

// Exported class strings and Slot children keep the original CVA cascade.
// Both selectors share this one declaration and its default/null semantics.
function createToggleGroupItemVariants(useSlotCascade: boolean) {
  return cva(
    cn(
      useSlotCascade
        ? 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm'
        : stylex.props(styles.item).className,
      'text-sm font-medium',
      useSlotCascade ? 'text-muted-foreground' : stylex.props(styles.ink).className,
      "transition-[color,box-shadow,background-color] hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0"
    ),
    {
      variants: {
        variant: {
          default: '',
          outline: cn(
            useSlotCascade
              ? 'border border-input bg-background'
              : stylex.props(styles.outline).className,
            'shadow-xs hover:bg-foreground/5 hover:text-foreground'
          ),
        },
        size: {
          default: cn(useSlotCascade ? 'h-8 px-3' : stylex.props(styles.defaultSize).className),
          sm: cn(useSlotCascade ? 'h-7 px-2' : stylex.props(styles.smallSize).className, 'text-xs'),
          lg: cn(useSlotCascade ? 'h-9 px-4' : stylex.props(styles.largeSize).className),
        },
      },
      defaultVariants: {
        variant: 'default',
        size: 'default',
      },
    }
  );
}

const toggleGroupItemVariants = createToggleGroupItemVariants(true);
const ownedToggleGroupItemVariants = createToggleGroupItemVariants(false);

type ToggleGroupVariant = VariantProps<typeof toggleGroupItemVariants>;

const ToggleGroupContext = React.createContext<ToggleGroupVariant>({
  variant: 'default',
  size: 'default',
});

function ToggleGroup({
  className,
  asChild,
  variant = 'default',
  size = 'default',
  children,
  gap,
  padding,
  style,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> &
  ToggleGroupVariant & {
    gap?: React.CSSProperties['gap'];
    padding?: React.CSSProperties['padding'];
  }) {
  const callerOverrides = (key: keyof React.CSSProperties) =>
    Object.prototype.hasOwnProperty.call(style ?? {}, key);
  const fieldStyle =
    gap == null && padding == null
      ? style
      : {
          ...(gap != null && !callerOverrides('gap') && { gap }),
          ...(padding != null && !callerOverrides('padding') && { padding }),
          ...style,
        };
  return (
    <ToggleGroupPrimitive.Root
      asChild={asChild}
      data-slot="toggle-group"
      className={cn(
        (asChild ?? false)
          ? 'inline-flex items-center gap-1 rounded-md border border-input bg-muted/60 p-1'
          : stylex.props(styles.root).className,
        className
      )}
      {...props}
      style={fieldStyle}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  asChild,
  variant,
  size,
  gap,
  style,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> &
  ToggleGroupVariant & {
    gap?: React.CSSProperties['gap'];
  }) {
  const childStyle =
    gap != null && asChild && React.isValidElement<{ style?: React.CSSProperties }>(props.children)
      ? props.children.props.style
      : undefined;
  const overridesGap =
    gap != null &&
    (Object.prototype.hasOwnProperty.call(style ?? {}, 'gap') ||
      Object.prototype.hasOwnProperty.call(childStyle ?? {}, 'gap'));
  const fieldStyle = gap == null ? style : { ...(!overridesGap && { gap }), ...style };
  const context = React.useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      asChild={asChild}
      data-slot="toggle-group-item"
      className={cn(
        ((asChild ?? false) ? toggleGroupItemVariants : ownedToggleGroupItemVariants)({
          variant: variant ?? context.variant,
          size: size ?? context.size,
        }),
        className
      )}
      {...props}
      style={fieldStyle}
    />
  );
}

export { ToggleGroup, ToggleGroupItem, toggleGroupItemVariants };
