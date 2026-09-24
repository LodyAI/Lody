import * as React from 'react';
import { type DialogProps } from '@radix-ui/react-dialog';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Dialog, DialogContentWithoutClose } from './dialog';
import { ScrollArea } from './scroll-area';

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
      className
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

const CommandDialog = ({
  children,
  shouldFilter,
  ...props
}: DialogProps & { shouldFilter?: boolean }) => {
  return (
    <Dialog {...props}>
      {/* The mention / slash-command popover in the chat composer carries a hardcoded
          z-index: 50 (from @diceui/shared's anchored positioner), and the shared dialog's
          `z-[var(--z-dialog)]` resolves to `auto` (that CSS var is never defined). Without
          an explicit z-index the palette renders *under* an open mention popover. Pin the
          overlay AND content above it via --z-command-palette (registry value 85, with an
          inline fallback so it works even though the var isn't globally defined).
          See packages/components/src/lib/editor-overlay-z-index.ts for the layer scale. */}
      {/* Fixed, screen-relative height (flex column overrides the dialog's default grid)
          so the panel never resizes or shifts as the result list grows / shrinks / filters —
          the list scrolls inside instead. */}
      <DialogContentWithoutClose
        noAnimation
        className="z-[var(--z-command-palette,85)] flex h-[min(640px,72vh)] max-w-2xl flex-col gap-0 overflow-hidden border-0 bg-transparent p-0 shadow-none sm:p-0"
        overlayClassName="z-[var(--z-command-palette,85)] bg-black/40 backdrop-blur-[2px]"
      >
        <Command
          shouldFilter={shouldFilter}
          className="rounded-xl border border-border/60 shadow-2xl [&_[cmdk-input-wrapper]_svg]:size-4 [&_[cmdk-input]]:h-12"
        >
          {children}
        </Command>
      </DialogContentWithoutClose>
    </Dialog>
  );
};

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
    <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-md bg-transparent py-3 text-sm text-input-foreground outline-hidden ring-0 focus:outline-hidden focus:ring-0 focus-visible:outline-hidden focus-visible:ring-0 placeholder:text-input-placeholder disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  </div>
));

CommandInput.displayName = CommandPrimitive.Input.displayName;

type CommandListProps = React.ComponentPropsWithoutRef<typeof CommandPrimitive.List> & {
  containerClassName?: string;
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportStyle?: React.CSSProperties;
};

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  CommandListProps
>(
  (
    { className, containerClassName, viewportClassName, viewportRef, viewportStyle, ...props },
    ref
  ) => (
    <ScrollArea
      className={cn('max-h-[300px]', containerClassName)}
      viewportRef={viewportRef}
      viewportClassName={cn(
        'scroll-pro scrollbar-pro [scrollbar-gutter:auto] max-h-[300px] overflow-y-auto overflow-x-hidden touch-pan-y',
        viewportClassName
      )}
      viewportStyle={viewportStyle}
    >
      <CommandPrimitive.List ref={ref} className={cn('min-w-full', className)} {...props} />
    </ScrollArea>
  )
);

CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty ref={ref} className="py-6 text-center text-sm" {...props} />
));

CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
      className
    )}
    {...props}
  />
));

CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 h-px bg-border', className)}
    {...props}
  />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default gap-2 select-none items-center rounded-xs px-2 py-1.5 text-sm outline-hidden data-[disabled=true]:pointer-events-none data-[selected=true]:bg-foreground/[0.05] data-[selected=true]:text-foreground data-[disabled=true]:opacity-50 dark:data-[selected=true]:bg-white/[0.10] dark:data-[selected=true]:text-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4 [&_svg]:shrink-0",
      className
    )}
    {...props}
  />
));

CommandItem.displayName = CommandPrimitive.Item.displayName;

const CommandShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  );
};
CommandShortcut.displayName = 'CommandShortcut';

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
