import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from '@/lib/utils';

// Radix Slot merges child classes without Tailwind conflict resolution.
// Keep its original utility cascade while ordinary elements use StyleX.
const styles = stylex.create({
  content: {
    zIndex: 50,
    overflow: 'hidden',
    borderRadius: 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: 0.5,
    borderColor: 'hsl(var(--border))',
    backgroundColor: 'hsl(var(--popover))',
    color: 'hsl(var(--foreground))',
  },
});

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, asChild, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      asChild={asChild}
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // Tooltip content is portaled to <body>, outside the `.crh-shell.dark`
        // wrapper, so re-scope it to dark (this renderer is dark-only) — otherwise
        // it falls back to the light `:root` tokens and clashes with the UI.
        'dark',
        asChild
          ? 'z-50 overflow-hidden rounded-md border-[0.5px] border-border bg-popover text-foreground'
          : stylex.props(styles.content).className,
        'shadow-[0_0.5px_1px_1px_rgba(0,0,0,0.04)]',
        'animate-in fade-in-0 zoom-in-95',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
        'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        'origin-(--radix-tooltip-content-transform-origin)',
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
