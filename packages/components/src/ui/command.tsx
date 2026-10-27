import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Dialog } from './dialog';
import { ScrollArea } from '@lody/ui/scroll-area';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';

const styles = stylex.create({
  command: {
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: themeRadius.md,
    backgroundColor: themeColors.popover,
    color: themeColors.popoverForeground,
  },
  inputWrapper: {
    display: 'flex',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: themeColors.border,
    paddingInline: themeSpace[3],
  },
  searchIcon: {
    marginRight: themeSpace[2],
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    opacity: 0.5,
  },
  input: {
    display: 'flex',
    height: themeSpace[10],
    width: '100%',
    borderRadius: themeRadius.md,
    backgroundColor: 'transparent',
    paddingBlock: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: { default: themeColors.inputForeground, '::placeholder': themeColors.inputPlaceholder },
    boxShadow: 'none',
    cursor: { default: null, ':disabled': 'not-allowed' },
    opacity: { default: null, ':disabled': 0.5 },
  },
  listContainer: { maxHeight: 300 },
  listViewport: {
    scrollbarGutter: 'auto',
    maxHeight: 300,
    overflowY: 'auto',
    overflowX: 'hidden',
    touchAction: 'pan-y',
  },
  list: { minWidth: '100%' },
  empty: {
    paddingBlock: themeSpace[6],
    textAlign: 'center',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  group: { overflow: 'hidden', padding: themeSpace[1], color: themeColors.foreground },
  separator: {
    marginInline: `calc(${themeSpace[1]} * -1)`,
    height: 1,
    backgroundColor: themeColors.border,
  },
  item: {
    position: 'relative',
    display: 'flex',
    cursor: 'default',
    gap: themeSpace[2],
    userSelect: 'none',
    alignItems: 'center',
    borderRadius: themeRadius.xs,
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1.5],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    pointerEvents: { default: null, ':is([data-disabled="true"])': 'none' },
    backgroundColor: {
      default: null,
      ':is([data-selected="true"])': 'hsl(var(--foreground) / 0.05)',
    },
    color: { default: null, ':is([data-selected="true"])': themeColors.foreground },
    opacity: { default: null, ':is([data-disabled="true"])': 0.5 },
  },
  shortcut: {
    marginLeft: 'auto',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    letterSpacing: 'var(--tracking-widest)',
    color: themeColors.mutedForeground,
  },
});

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(stylex.props(styles.command).className, className)}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

const CommandDialog = ({
  children,
  shouldFilter,
  ...props
}: Omit<React.ComponentProps<typeof Dialog.Root>, 'children'> & {
  children?: React.ReactNode;
  shouldFilter?: boolean;
}) => {
  return (
    <Dialog.Root {...props}>
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
      <Dialog.Content
        closeButton={false}
        noAnimation
        className="z-[var(--z-command-palette,85)] flex h-[min(640px,72vh)] max-w-2xl flex-col gap-0 overflow-hidden border-0 bg-transparent p-0 shadow-none sm:p-0"
        backdropClassName="z-[var(--z-command-palette,85)] bg-black/40 backdrop-blur-[2px]"
      >
        <Command
          shouldFilter={shouldFilter}
          className="rounded-xl border border-border/60 shadow-2xl [&_[cmdk-input-wrapper]_svg]:size-4 [&_[cmdk-input]]:h-12"
        >
          {children}
        </Command>
      </Dialog.Content>
    </Dialog.Root>
  );
};

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div {...stylex.props(styles.inputWrapper)} cmdk-input-wrapper="">
    <Search {...stylex.props(styles.searchIcon)} />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        stylex.props(styles.input).className,
        'outline-hidden focus:outline-hidden focus-visible:outline-hidden',
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
      className={cn(stylex.props(styles.listContainer).className, containerClassName)}
      viewportRef={viewportRef}
      viewportClassName={cn(
        stylex.props(styles.listViewport).className,
        'scroll-pro scrollbar-pro',
        viewportClassName
      )}
      viewportStyle={viewportStyle}
    >
      <CommandPrimitive.List
        ref={ref}
        className={cn(stylex.props(styles.list).className, className)}
        {...props}
      />
    </ScrollArea>
  )
);

CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => <CommandPrimitive.Empty ref={ref} {...stylex.props(styles.empty)} {...props} />);

CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      stylex.props(styles.group).className,
      '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
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
    className={cn(stylex.props(styles.separator).className, className)}
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
      stylex.props(styles.item).className,
      "outline-hidden dark:data-[selected=true]:bg-white/[0.10] [&_svg]:pointer-events-none [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4 [&_svg]:shrink-0",
      className
    )}
    {...props}
  />
));

CommandItem.displayName = CommandPrimitive.Item.displayName;

const CommandShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return <span className={cn(stylex.props(styles.shortcut).className, className)} {...props} />;
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
