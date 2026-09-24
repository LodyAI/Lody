import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { Slot } from '@radix-ui/react-slot';

import { cn } from '@/lib/utils';
import { useSafeAreaCollisionPadding } from '@/hooks/use-safe-area-insets';
import { InteractionArmedProvider, useInteractionArmed } from './interaction-arm';

// Inside an unarmed `useInteractionArm` boundary these render only the trigger
// element; see `interaction-arm.tsx`.

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const armed = useInteractionArmed();
  if (armed) return <PopoverPrimitive.Root {...props} />;
  // Opened by its owner rather than by an interaction: mount it for real.
  if (props.open === true || props.defaultOpen === true) {
    return (
      <InteractionArmedProvider value>
        <PopoverPrimitive.Root {...props} />
      </InteractionArmedProvider>
    );
  }
  return <>{props.children}</>;
}

const PopoverTrigger = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(({ asChild, ...props }, ref) => {
  const armed = useInteractionArmed();
  if (armed) return <PopoverPrimitive.Trigger ref={ref} asChild={asChild} {...props} />;
  return asChild === true ? (
    <Slot ref={ref} {...props} />
  ) : (
    <button type="button" ref={ref} {...props} />
  );
});
PopoverTrigger.displayName = PopoverPrimitive.Trigger.displayName;

/** Positions the popover without Trigger's open-on-click behavior — for
 *  controlled popovers whose anchor owns its own click semantics. */
const PopoverAnchor = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Anchor>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Anchor>
>(({ asChild, ...props }, ref) => {
  const armed = useInteractionArmed();
  if (armed) return <PopoverPrimitive.Anchor ref={ref} asChild={asChild} {...props} />;
  return asChild === true ? <Slot ref={ref} {...props} /> : <div ref={ref} {...props} />;
});
PopoverAnchor.displayName = PopoverPrimitive.Anchor.displayName;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    portalContainer?: HTMLElement | null;
  }
>(
  (
    { className, align = 'center', sideOffset = 4, collisionPadding, portalContainer, ...props },
    ref
  ) => {
    const mergedCollisionPadding = useSafeAreaCollisionPadding(collisionPadding);
    const armed = useInteractionArmed();
    if (!armed) return null;
    return (
      <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
        <PopoverPrimitive.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={mergedCollisionPadding}
          className={cn(
            'scroll-pro scrollbar-pro [scrollbar-gutter:auto] z-[var(--z-popover)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  }
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
