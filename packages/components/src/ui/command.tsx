import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { clsx } from 'clsx';
import { ScrollArea } from '@lody/ui/scroll-area';
import { field } from '@lody/ui/field/field.tokens.stylex';
import { popup } from '@lody/ui/popup/popup.tokens.stylex';
import { control, corner, duration, ease, text } from '@lody/ui/tokens/scales.stylex';
import { Dialog } from './dialog';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  dialogPanel: { height: 'min(640px, 72vh)', overflow: 'hidden', maxWidth: '42rem' },
  command: {
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: 'transparent',
    color: popup.label,
  },
  inputWrapper: {
    display: 'flex',
    alignItems: 'center',
    gap: field.triggerGap,
    margin: { default: popup.inset, ':is([data-command-dialog] *)': themeSpace[1.5] },
    paddingInline: field.paddingXMedium,
    borderRadius: field.radiusMedium,
    cornerShape: corner.round,
    backgroundColor: field.background,
    boxShadow: {
      default: field.well,
      ':focus-within': `0 0 0 ${field.ringWidth} ${field.ring}, ${field.well}`,
    },
    opacity: { default: 1, ':has([cmdk-input]:disabled)': control.disabledOpacity },
    transitionProperty: 'box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  searchIcon: { width: field.iconSize, height: field.iconSize, flexShrink: 0, color: field.icon },
  input: {
    display: 'flex',
    height: { default: control.medium, ':is([data-command-dialog] *)': control.large },
    width: '100%',
    minWidth: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    padding: 0,
    fontFamily: 'inherit',
    fontSize: field.text,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    color: { default: field.value, '::placeholder': field.placeholder },
    boxShadow: { default: 'none', ':focus-visible': 'none' },
    outlineStyle: 'none',
    cursor: { default: null, ':disabled': 'default' },
    '::placeholder': { opacity: 1 },
  },
  listContainer: { maxHeight: 300 },
  listViewport: {
    maxHeight: 300,
    overscrollBehavior: 'contain',
    overflowY: 'auto',
    overflowX: 'hidden',
    touchAction: 'pan-y',
  },
  list: { minWidth: '100%' },
  empty: {
    paddingBlock: themeSpace[6],
    textAlign: 'center',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: popup.hint,
  },
  group: {
    overflow: 'hidden',
    padding: popup.inset,
    color: popup.label,
    ':is(*) [cmdk-group-heading]': {
      paddingInline: popup.itemPaddingX,
      paddingBlock: themeSpace[1.5],
      fontSize: popup.groupLabelSize,
      lineHeight: popup.groupLabelLeading,
      fontWeight: 500,
      color: popup.groupLabel,
    },
  },
  separator: {
    marginInline: `calc(${popup.inset} * -1)`,
    height: 1,
    backgroundColor: popup.separator,
  },
  item: {
    position: 'relative',
    outlineStyle: 'none',
    boxShadow: 'none',
    ':is(*) svg': {
      pointerEvents: 'none',
      flexShrink: 0,
      width: 'var(--lody-command-icon-size, 16px)',
      height: 'var(--lody-command-icon-size, 16px)',
    },
    display: 'flex',
    cursor: 'default',
    gap: popup.itemGap,
    userSelect: 'none',
    alignItems: 'center',
    borderRadius: popup.itemRadius,
    cornerShape: corner.shape,
    minHeight: popup.itemHeight,
    paddingInline: popup.itemPaddingX,
    paddingBlock: 0,
    fontSize: popup.text,
    lineHeight: text.subheadlineLeading,
    fontWeight: 400,
    letterSpacing: text.controlTracking,
    pointerEvents: { default: null, ':is([data-disabled="true"])': 'none' },
    backgroundColor: { default: null, ':is([data-selected="true"])': popup.highlight },
    color: popup.label,
    opacity: { default: null, ':is([data-disabled="true"])': control.disabledOpacity },
  },
  shortcut: {
    marginLeft: 'auto',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: popup.hint,
  },
});

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive> & { xstyle?: stylex.StyleXStyles }
>(({ className, xstyle, style, ...props }, ref) => {
  const sx = stylex.props(styles.command, xstyle);
  return (
    <CommandPrimitive
      ref={ref}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
});
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
      {/* Keep the command layer above mention popovers; the modal owns its material. */}
      <Dialog.Content
        closeButton={false}
        noAnimation
        padding="none"
        gap="none"
        xstyle={styles.dialogPanel}
        style={{ zIndex: 'var(--z-command-palette,85)' }}
        backdropStyle={{ zIndex: 'var(--z-command-palette,85)' }}
      >
        <Command shouldFilter={shouldFilter} data-command-dialog="">
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
      style={stylex.props(styles.listContainer, containerXstyle).style}
      viewportRef={viewportRef}
      viewportClassName={viewportClassName}
      viewportXstyle={[styles.listViewport, viewportXstyle]}
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
>(({ className, xstyle, style, ...props }, ref) => {
  const sx = stylex.props(styles.group, xstyle);
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
});

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
