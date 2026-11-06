import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';

import { clsx } from 'clsx';
import { Dialog } from './dialog';
import { ScrollArea } from '@lody/ui/scroll-area';
import { dialog } from '@lody/ui/dialog/dialog.tokens.stylex';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';

const styles = stylex.create({
  dialogPanel: {
    height: 'min(640px, 72vh)',
    overflow: 'hidden',
    borderStyle: 'solid',
    borderWidth: 0,
    maxWidth: '42rem',
    backgroundColor: 'transparent',
    boxShadow: 'none',
  },
  dialogBackdrop: {
    zIndex: 'var(--z-command-palette,85)',
    [dialog.overlay]: {
      default: '#0006',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, var(--color-black) 40%, transparent)',
    },
    backdropFilter: 'blur(2px)',
  },
  dialogCommand: {
    borderRadius: 'var(--radius-xl)',
    borderWidth: 1,
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    boxShadow: 'var(--shadow-2xl)',
    ':is(*) [cmdk-input-wrapper] svg': {
      width: 'calc(var(--spacing) * 4)',
      height: 'calc(var(--spacing) * 4)',
    },
    ':is(*) [cmdk-input]': { height: 'calc(var(--spacing) * 12)' },
  },
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
    outlineStyle: 'none',
    cursor: { default: null, ':disabled': 'not-allowed' },
    opacity: { default: null, ':disabled': 0.5 },
  },
  listContainer: { maxHeight: 300 },
  listViewport: {
    scrollbarGutter: 'auto',
    overscrollBehavior: 'contain',
    scrollbarWidth: 'thin',
    scrollbarColor: 'hsl(var(--scrollbar-thumb) / .5) transparent',
    '::-webkit-scrollbar': { width: 10, height: 10 },
    '::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
    '::-webkit-scrollbar-thumb': {
      backgroundColor: 'hsl(var(--scrollbar-thumb) / .5)',
      borderRadius: 999,
      borderWidth: 3,
      borderStyle: 'solid',
      borderColor: 'transparent',
      backgroundClip: 'content-box',
    },
    '::-webkit-scrollbar-thumb:hover': {
      backgroundColor: 'hsl(var(--scrollbar-thumb-hover) / .65)',
    },
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
  group: {
    overflow: 'hidden',
    padding: themeSpace[1],
    color: themeColors.foreground,
    ':is(*) [cmdk-group-heading]': {
      paddingInline: 'calc(var(--spacing) * 2)',
      paddingBlock: 'calc(var(--spacing) * 1.5)',
      fontSize: 'var(--text-xs)',
      lineHeight: 'var(--text-xs--line-height)',
      fontWeight: 'var(--font-weight-medium)',
      color: 'hsl(var(--muted-foreground) / 1)',
    },
  },
  separator: {
    marginInline: `calc(${themeSpace[1]} * -1)`,
    height: 1,
    backgroundColor: themeColors.border,
  },
  item: {
    position: 'relative',
    outlineStyle: 'none',
    ':is(.dark, .dark-scope, .dark *, .dark-scope *):not(:is(.light-scope, .light-scope *))[data-selected="true"]':
      { backgroundColor: 'color-mix(in oklab, var(--color-white) 10%, transparent)' },
    ':is(*) svg': {
      pointerEvents: 'none',
      flexShrink: 0,
      width: 'var(--lody-command-icon-size, calc(var(--spacing) * 4))',
      height: 'var(--lody-command-icon-size, calc(var(--spacing) * 4))',
    },
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
  React.ComponentPropsWithoutRef<typeof CommandPrimitive> & { xstyle?: stylex.StyleXStyles }
>(({ className, xstyle, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={clsx(stylex.props(styles.command, xstyle).className, className)}
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
      {/* A fixed, screen-relative height keeps the panel in place as results filter;
          the list scrolls inside the dialog's column. */}
      <Dialog.Content
        closeButton={false}
        noAnimation
        padding="none"
        gap="none"
        xstyle={styles.dialogPanel}
        style={{ zIndex: 'var(--z-command-palette,85)' }}
        backdropClassName={stylex.props(styles.dialogBackdrop).className}
      >
        <Command shouldFilter={shouldFilter} xstyle={styles.dialogCommand}>
          {children}
        </Command>
      </Dialog.Content>
    </Dialog.Root>
  );
};

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input> & { xstyle?: stylex.StyleXStyles }
>(({ className, xstyle, style, ...props }, ref) => {
  const sx = stylex.props(styles.input, xstyle);
  return (
    <div {...stylex.props(styles.inputWrapper)} cmdk-input-wrapper="">
      <Search {...stylex.props(styles.searchIcon)} />
      <CommandPrimitive.Input
        ref={ref}
        className={clsx(sx.className, className)}
        style={sx.style ? { ...sx.style, ...style } : style}
        {...props}
      />
    </div>
  );
});

CommandInput.displayName = CommandPrimitive.Input.displayName;

type CommandListProps = React.ComponentPropsWithoutRef<typeof CommandPrimitive.List> & {
  containerClassName?: string;
  containerXstyle?: stylex.StyleXStyles;
  viewportClassName?: string;
  viewportXstyle?: stylex.StyleXStyles;
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportStyle?: React.CSSProperties;
};

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  CommandListProps
>(
  (
    {
      className,
      containerClassName,
      containerXstyle,
      viewportClassName,
      viewportXstyle,
      viewportRef,
      viewportStyle,
      ...props
    },
    ref
  ) => (
    <ScrollArea
      className={clsx(
        stylex.props(styles.listContainer, containerXstyle).className,
        containerClassName
      )}
      viewportRef={viewportRef}
      viewportClassName={clsx(
        stylex.props(styles.listViewport, viewportXstyle).className,
        viewportClassName
      )}
      viewportStyle={viewportStyle}
    >
      <CommandPrimitive.List
        ref={ref}
        className={clsx(stylex.props(styles.list).className, className)}
        {...props}
      />
    </ScrollArea>
  )
);

CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty> & { xstyle?: stylex.StyleXStyles }
>(({ xstyle, ...props }, ref) => {
  const sx = stylex.props(styles.empty, xstyle);
  return (
    <CommandPrimitive.Empty
      ref={ref}
      {...sx}
      {...props}
      {...(xstyle
        ? {
            className: clsx(sx.className, props.className),
            style: sx.style ? { ...sx.style, ...props.style } : props.style,
          }
        : {})}
    />
  );
});

CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group> & { xstyle?: stylex.StyleXStyles }
>(({ className, xstyle, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={clsx(stylex.props(styles.group, xstyle).className, className)}
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
    className={clsx(stylex.props(styles.separator).className, className)}
    {...props}
  />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

const iconSizing = stylex.create({
  size: (value: string) => ({ '--lody-command-icon-size': value }),
});

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item> & {
    xstyle?: stylex.StyleXStyles;
    iconSize?: string;
  }
>(({ className, xstyle, iconSize, style, ...props }, ref) => {
  const sx = stylex.props(styles.item, iconSize != null && iconSizing.size(iconSize), xstyle);
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
});

CommandItem.displayName = CommandPrimitive.Item.displayName;

const CommandShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return <span className={clsx(stylex.props(styles.shortcut).className, className)} {...props} />;
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
