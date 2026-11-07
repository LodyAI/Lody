import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
const enter = stylex.keyframes({
  from: { opacity: 0, transform: 'translateY(var(--crh-menu-y,0px)) scale(.95)' },
  to: { opacity: 1, transform: 'translateY(0) scale(1)' },
});
const exit = stylex.keyframes({
  from: { opacity: 1, transform: 'scale(1)' },
  to: { opacity: 0, transform: 'scale(.95)' },
});
const styles = stylex.create({
  content: {
    zIndex: 50,
    minWidth: 'calc(var(--spacing) * 44)',
    overflow: 'hidden',
    borderRadius: 'var(--radius)',
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor: 'hsl(var(--border))',
    backgroundColor: 'hsl(var(--popover))',
    padding: 'calc(var(--spacing) * 1)',
    color: 'hsl(var(--foreground))',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / .1), 0 2px 4px -2px rgb(0 0 0 / .1)',
    transformOrigin: 'var(--radix-dropdown-menu-content-transform-origin)',
    '--crh-menu-y': {
      default: '0px',
      ':is([data-side="bottom"])': 'calc(var(--spacing) * -2)',
      ':is([data-side="top"])': 'calc(var(--spacing) * 2)',
    },
    animationName: { default: enter, ':is([data-state="closed"])': exit },
    animationDuration: '150ms',
    animationTimingFunction: 'ease',
  },
  item: {
    position: 'relative',
    display: 'flex',
    cursor: 'pointer',
    userSelect: 'none',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'calc(var(--radius) - 2px)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    fontSize: 12.5,
    outline: '2px solid transparent',
    outlineOffset: 2,
    backgroundColor: { default: null, ':focus': 'hsl(var(--accent))' },
    color: { default: null, ':focus': 'hsl(var(--accent-foreground))' },
    pointerEvents: { default: null, ':is([data-disabled])': 'none' },
    opacity: { default: null, ':is([data-disabled])': 0.5 },
  },
  glyphs: {
    ':is(*) svg': {
      width: 'calc(var(--spacing) * 3.5)',
      height: 'calc(var(--spacing) * 3.5)',
      flexShrink: 0,
      color: 'hsl(var(--muted-foreground))',
    },
  },
  label: {
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: 10,
    textTransform: 'uppercase',
    color: 'hsl(var(--muted-foreground))',
    fontWeight: 'var(--font-weight-semibold)',
    letterSpacing: '.1em',
  },
  separator: {
    marginInline: 'calc(var(--spacing) * -1)',
    marginBlock: 'calc(var(--spacing) * 1)',
    height: 1,
    backgroundColor: 'hsl(var(--border))',
  },
});
const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
    xstyle?: stylex.StyleXStyles;
  }
>(({ className, xstyle, sideOffset = 6, style, ...props }, ref) => {
  const sx = stylex.props(styles.content, xstyle);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        {...sx}
        className={clsx('dark', sx.className, className)}
        style={sx.style ? { ...sx.style, ...style } : style}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;
const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    xstyle?: stylex.StyleXStyles;
  }
>(({ className, xstyle, style, ...props }, ref) => {
  const sx = stylex.props(styles.item, styles.glyphs, xstyle);
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      {...sx}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
});
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;
const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    xstyle?: stylex.StyleXStyles;
  }
>(({ className, xstyle, style, ...props }, ref) => {
  const sx = stylex.props(styles.label, xstyle);
  return (
    <DropdownMenuPrimitive.Label
      ref={ref}
      {...sx}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
});
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;
const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator> & {
    xstyle?: stylex.StyleXStyles;
  }
>(({ className, xstyle, style, ...props }, ref) => {
  const sx = stylex.props(styles.separator, xstyle);
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      {...sx}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
});
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
};
