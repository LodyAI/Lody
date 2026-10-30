import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import { cn } from '@/lib/utils';

// Radix Slot merges child classes without Tailwind conflict resolution.
// Keep its original utility cascade while ordinary elements use StyleX.
const styles = stylex.create({
  content: {
    zIndex: 50,
    minWidth: 'calc(var(--spacing) * 44)',
    overflow: 'hidden',
    borderRadius: 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: 1,
    borderColor: 'hsl(var(--border))',
    backgroundColor: 'hsl(var(--popover))',
    padding: 'calc(var(--spacing) * 1)',
    color: 'hsl(var(--foreground))',
  },
  item: {
    position: 'relative',
    display: 'flex',
    cursor: 'pointer',
    userSelect: 'none',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'calc(var(--radius) - 2px)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    fontSize: 12.5,
  },
  label: {
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1)',
    fontSize: 10,
    textTransform: 'uppercase',
    color: 'hsl(var(--muted-foreground))',
  },
  separator: {
    'margin-inline': 'calc(var(--spacing) * -1)',
    'margin-block': 'calc(var(--spacing) * 1)',
    height: 1,
    backgroundColor: 'hsl(var(--border))',
  },
});

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, asChild, sideOffset = 6, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      asChild={asChild}
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // Portaled to <body>: inherits the VS Code theme tokens applied to
        // <html>. Use `text-foreground` (correct/light) rather than
        // `text-popover-foreground`, which the Vesper mapping leaves dark.
        'dark',
        asChild
          ? 'z-50 min-w-44 overflow-hidden rounded-md border border-border bg-popover p-1 text-foreground'
          : stylex.props(styles.content).className,
        'shadow-md',
        'animate-in fade-in-0 zoom-in-95',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
        'origin-(--radix-dropdown-menu-content-transform-origin)',
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, asChild, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    asChild={asChild}
    ref={ref}
    className={cn(
      asChild
        ? 'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[12.5px]'
        : stylex.props(styles.item).className,
      'outline-hidden',
      'focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      '[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
      className
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, asChild, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    asChild={asChild}
    ref={ref}
    className={cn(
      asChild
        ? 'px-2 py-1 text-[10px] uppercase text-muted-foreground'
        : stylex.props(styles.label).className,
      'font-semibold tracking-[0.1em]',
      className
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, asChild, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    asChild={asChild}
    ref={ref}
    className={cn(
      asChild ? '-mx-1 my-1 h-px bg-border' : stylex.props(styles.separator).className,
      className
    )}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
};
