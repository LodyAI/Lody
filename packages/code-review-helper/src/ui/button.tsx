import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const styles = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'calc(var(--spacing) * 2)',
    whiteSpace: 'nowrap',
    borderRadius: 'var(--radius)',
  },
  default: { backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' },
  destructive: {
    backgroundColor: 'hsl(var(--destructive))',
    color: 'hsl(var(--destructive-foreground))',
  },
  outline: {
    borderStyle: 'var(--tw-border-style)',
    borderWidth: 1,
    borderColor: 'hsl(var(--input))',
    backgroundColor: 'hsl(var(--background))',
  },
  secondary: {
    backgroundColor: 'hsl(var(--secondary))',
    color: 'hsl(var(--secondary-foreground))',
  },
  link: { color: 'hsl(var(--primary))', textUnderlineOffset: 4 },
  defaultSize: {
    height: 'calc(var(--spacing) * 9)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  smallSize: { height: 'calc(var(--spacing) * 8)', 'padding-inline': 'calc(var(--spacing) * 3)' },
  largeSize: { height: 'calc(var(--spacing) * 10)', 'padding-inline': 'calc(var(--spacing) * 6)' },
  iconSize: { width: 'calc(var(--spacing) * 9)', height: 'calc(var(--spacing) * 9)' },
});

// Keep one CVA declaration: Slot and the exported class selector retain their
// original utility cascade; ordinary buttons use the owned StyleX mappings.
function createButtonVariants(useSlotCascade: boolean) {
  return cva(
    cn(
      useSlotCascade
        ? 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md'
        : stylex.props(styles.base).className,
      "text-sm font-medium transition-[color,box-shadow,background-color,border-color] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0"
    ),
    {
      variants: {
        variant: {
          default: cn(
            useSlotCascade
              ? 'bg-primary text-primary-foreground'
              : stylex.props(styles.default).className,
            'shadow-xs hover:bg-primary/90'
          ),
          destructive: cn(
            useSlotCascade
              ? 'bg-destructive text-destructive-foreground'
              : stylex.props(styles.destructive).className,
            'shadow-xs hover:bg-destructive/90'
          ),
          outline: cn(
            useSlotCascade
              ? 'border border-input bg-background'
              : stylex.props(styles.outline).className,
            'shadow-xs hover:bg-foreground/5 hover:text-foreground'
          ),
          secondary: cn(
            useSlotCascade
              ? 'bg-secondary text-secondary-foreground'
              : stylex.props(styles.secondary).className,
            'shadow-xs hover:bg-secondary/80'
          ),
          ghost: 'hover:bg-foreground/5 hover:text-foreground',
          link: cn(
            useSlotCascade
              ? 'text-primary underline-offset-4'
              : stylex.props(styles.link).className,
            'hover:underline'
          ),
        },
        size: {
          default: cn(
            useSlotCascade ? 'h-9 px-4 py-2' : stylex.props(styles.defaultSize).className
          ),
          sm: cn(
            useSlotCascade ? 'h-8 rounded-md px-3' : stylex.props(styles.smallSize).className,
            'text-xs'
          ),
          lg: cn(
            useSlotCascade ? 'h-10 rounded-md px-6' : stylex.props(styles.largeSize).className
          ),
          icon: cn(useSlotCascade ? 'size-9' : stylex.props(styles.iconSize).className),
        },
      },
      defaultVariants: {
        variant: 'default',
        size: 'default',
      },
    }
  );
}

const buttonVariants = createButtonVariants(true);
const ownedButtonVariants = createButtonVariants(false);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  width?: React.CSSProperties['width'];
  height?: React.CSSProperties['height'];
  labelColor?: React.CSSProperties['color'];
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, width, height, labelColor, style, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button';
    // Keep CSS-wide keywords on the physical field. Existing caller and Slot child
    // inline styles retain their original priority over the opt-in declarations.
    const fieldStyle =
      width == null && height == null && labelColor == null
        ? style
        : {
            ...(width != null && { width }),
            ...(height != null && { height }),
            ...(labelColor != null && { color: labelColor }),
            ...style,
          };
    return (
      <Comp
        className={cn(
          (asChild ? buttonVariants : ownedButtonVariants)({ variant, size, className })
        )}
        ref={ref}
        {...props}
        style={fieldStyle}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
