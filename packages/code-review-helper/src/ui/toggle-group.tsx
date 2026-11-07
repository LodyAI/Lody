import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { clsx, type ClassValue } from 'clsx';

const RING = '0 0 0 3px color-mix(in oklab, hsl(var(--ring)) 50%, transparent)';
const styles = stylex.create({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'var(--radius)',
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor: 'hsl(var(--input))',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 60%, transparent)',
    padding: 'calc(var(--spacing) * 1)',
  },
  item: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'calc(var(--spacing) * 2)',
    whiteSpace: 'nowrap',
    borderRadius: 'calc(var(--radius) - 2px)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    color: {
      default: 'hsl(var(--muted-foreground))',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--foreground))' },
      ':is([data-state="on"])': 'hsl(var(--foreground))',
    },
    backgroundColor: { default: null, ':is([data-state="on"])': 'hsl(var(--background))' },
    boxShadow: {
      default: null,
      ':is([data-state="on"])': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
      ':focus-visible': RING,
    },
    borderColor: { default: null, ':focus-visible': 'hsl(var(--ring))' },
    transitionProperty: 'color,box-shadow,background-color',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    outline: {
      default: null,
      ':focus-visible': '2px solid transparent',
      '@media (forced-colors: active)': { ':focus-visible': 'auto' },
    },
    outlineOffset: { default: null, ':focus-visible': 2 },
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
  },
  glyphs: {
    ':is(*) svg': { pointerEvents: 'none', flexShrink: 0 },
    ":is(*) svg:not([class*='size-'])": {
      width: 'calc(var(--spacing) * 4)',
      height: 'calc(var(--spacing) * 4)',
    },
  },
  outline: {
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor: 'hsl(var(--input))',
    backgroundColor: {
      default: 'hsl(var(--background))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--foreground)) 5%, transparent)',
      },
      ':is([data-state="on"])': 'hsl(var(--background))',
    },
    boxShadow: {
      default: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      ':is([data-state="on"])': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
      ':focus-visible': `${RING}, 0 1px 2px 0 rgb(0 0 0 / 0.05)`,
    },
  },
  defaultSize: { height: 'calc(var(--spacing) * 8)', paddingInline: 'calc(var(--spacing) * 3)' },
  smallSize: {
    height: 'calc(var(--spacing) * 7)',
    paddingInline: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
  largeSize: { height: 'calc(var(--spacing) * 9)', paddingInline: 'calc(var(--spacing) * 4)' },
});
const variants = { default: undefined, outline: styles.outline };
const sizes = { default: styles.defaultSize, sm: styles.smallSize, lg: styles.largeSize };
type ToggleGroupVariant = {
  variant?: keyof typeof variants | null;
  size?: keyof typeof sizes | null;
};
function itemStyles(
  { variant = 'default', size = 'default' }: ToggleGroupVariant,
  xstyle?: stylex.StyleXStyles
) {
  return stylex.props(
    styles.item,
    styles.glyphs,
    variant && variants[variant],
    size && sizes[size],
    xstyle
  );
}
function toggleGroupItemVariants(
  options: ToggleGroupVariant & { className?: ClassValue; class?: ClassValue } = {}
) {
  return clsx(itemStyles(options).className, options.class, options.className);
}

const ToggleGroupContext = React.createContext<ToggleGroupVariant>({
  variant: 'default',
  size: 'default',
});

function ToggleGroup({
  className,
  xstyle,
  asChild,
  variant = 'default',
  size = 'default',
  children,
  gap,
  padding,
  style,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> &
  ToggleGroupVariant & {
    xstyle?: stylex.StyleXStyles;
    gap?: React.CSSProperties['gap'];
    padding?: React.CSSProperties['padding'];
  }) {
  const callerOverrides = (key: keyof React.CSSProperties) =>
    Object.prototype.hasOwnProperty.call(style ?? {}, key);
  const fieldStyle =
    gap == null && padding == null
      ? style
      : {
          ...(gap != null && !callerOverrides('gap') && { gap }),
          ...(padding != null && !callerOverrides('padding') && { padding }),
          ...style,
        };
  const sx = stylex.props(styles.root, xstyle);
  return (
    <ToggleGroupPrimitive.Root
      asChild={asChild}
      data-slot="toggle-group"
      {...sx}
      className={clsx(sx.className, className)}
      {...props}
      style={sx.style ? { ...sx.style, ...fieldStyle } : fieldStyle}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  xstyle,
  asChild,
  variant,
  size,
  gap,
  style,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> &
  ToggleGroupVariant & {
    xstyle?: stylex.StyleXStyles;
    gap?: React.CSSProperties['gap'];
  }) {
  const childStyle =
    gap != null && asChild && React.isValidElement<{ style?: React.CSSProperties }>(props.children)
      ? props.children.props.style
      : undefined;
  const overridesGap =
    gap != null &&
    (Object.prototype.hasOwnProperty.call(style ?? {}, 'gap') ||
      Object.prototype.hasOwnProperty.call(childStyle ?? {}, 'gap'));
  const fieldStyle = gap == null ? style : { ...(!overridesGap && { gap }), ...style };
  const context = React.useContext(ToggleGroupContext);
  const sx = itemStyles(
    { variant: variant ?? context.variant, size: size ?? context.size },
    xstyle
  );
  return (
    <ToggleGroupPrimitive.Item
      asChild={asChild}
      data-slot="toggle-group-item"
      {...sx}
      className={clsx(sx.className, className)}
      {...props}
      style={sx.style ? { ...sx.style, ...fieldStyle } : fieldStyle}
    />
  );
}

export { ToggleGroup, ToggleGroupItem, toggleGroupItemVariants };
