import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Slot } from '@radix-ui/react-slot';

import { cn } from '@/lib/utils';
import { InteractionArmedProvider, useInteractionArmed } from './interaction-arm';

// Inside an unarmed `useInteractionArm` boundary these render only the trigger
// element; see `interaction-arm.tsx`.

function TooltipProvider(props: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  const armed = useInteractionArmed();
  if (!armed) return <>{props.children}</>;
  return <TooltipPrimitive.Provider {...props} />;
}

function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const armed = useInteractionArmed();
  if (armed) return <TooltipPrimitive.Root {...props} />;
  // Opened by its owner rather than by an interaction: mount it for real.
  if (props.open === true || props.defaultOpen === true) {
    return (
      <InteractionArmedProvider value>
        <TooltipPrimitive.Root {...props} />
      </InteractionArmedProvider>
    );
  }
  return <>{props.children}</>;
}

const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ asChild, ...props }, ref) => {
  const armed = useInteractionArmed();
  if (armed) return <TooltipPrimitive.Trigger ref={ref} asChild={asChild} {...props} />;
  return asChild === true ? (
    <Slot ref={ref} {...props} />
  ) : (
    <button type="button" ref={ref} {...props} />
  );
});
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => {
  const armed = useInteractionArmed();
  if (!armed) return null;
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-[var(--z-tooltip)] overflow-hidden rounded-md border-[0.5px] border-border',
          'shadow-[0_0.5px_1px_1px_rgba(0,0,0,0.04)]',
          'bg-popover text-popover-foreground',
          'px-3 py-1.5 text-[0.8em]',
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
  );
});
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
