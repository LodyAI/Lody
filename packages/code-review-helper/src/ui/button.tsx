import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { Slot } from '@radix-ui/react-slot';
import { clsx, type ClassValue } from 'clsx';

const FOCUS = '0 0 0 3px color-mix(in oklab, hsl(var(--ring)) 50%, transparent)';
const SMALL_SHADOW = '0 1px 2px 0 rgb(0 0 0 / 0.05)';
const styles = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'calc(var(--spacing) * 2)',
    whiteSpace: 'nowrap',
    borderRadius: 'var(--radius)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    transitionProperty: 'color,box-shadow,background-color,border-color',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    borderColor: { default: null, ':focus-visible': 'hsl(var(--ring))' },
    boxShadow: { default: null, ':focus-visible': FOCUS },
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
  shadow: { boxShadow: { default: SMALL_SHADOW, ':focus-visible': `${FOCUS}, ${SMALL_SHADOW}` } },
  default: {
    backgroundColor: {
      default: 'hsl(var(--primary))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--primary)) 90%, transparent)',
      },
    },
    color: 'hsl(var(--primary-foreground))',
  },
  destructive: {
    backgroundColor: {
      default: 'hsl(var(--destructive))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--destructive)) 90%, transparent)',
      },
    },
    color: 'hsl(var(--destructive-foreground))',
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
    },
    color: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--foreground))' },
    },
  },
  secondary: {
    backgroundColor: {
      default: 'hsl(var(--secondary))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--secondary)) 80%, transparent)',
      },
    },
    color: 'hsl(var(--secondary-foreground))',
  },
  ghost: {
    backgroundColor: {
      default: null,
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--foreground)) 5%, transparent)',
      },
    },
    color: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--foreground))' },
    },
  },
  link: {
    color: 'hsl(var(--primary))',
    textUnderlineOffset: 4,
    textDecorationLine: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'underline' },
    },
  },
  defaultSize: {
    height: 'calc(var(--spacing) * 9)',
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBlock: 'calc(var(--spacing) * 2)',
  },
  smallSize: {
    height: 'calc(var(--spacing) * 8)',
    paddingInline: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
  largeSize: { height: 'calc(var(--spacing) * 10)', paddingInline: 'calc(var(--spacing) * 6)' },
  iconSize: { width: 'calc(var(--spacing) * 9)', height: 'calc(var(--spacing) * 9)' },
});
const variants = {
  default: styles.default,
  destructive: styles.destructive,
  outline: styles.outline,
  secondary: styles.secondary,
  ghost: styles.ghost,
  link: styles.link,
};
const sizes = {
  default: styles.defaultSize,
  sm: styles.smallSize,
  lg: styles.largeSize,
  icon: styles.iconSize,
};
type ButtonVariant = keyof typeof variants;
type ButtonSize = keyof typeof sizes;
type ButtonVariantOptions = {
  variant?: ButtonVariant | null;
  size?: ButtonSize | null;
  className?: ClassValue;
  class?: ClassValue;
};
function buttonStyles(
  { variant = 'default', size = 'default' }: ButtonVariantOptions,
  xstyle?: stylex.StyleXStyles
) {
  return stylex.props(
    styles.base,
    styles.glyphs,
    variant && variants[variant],
    variant && variant !== 'ghost' && variant !== 'link' && styles.shadow,
    size && sizes[size],
    xstyle
  );
}
function buttonVariants(options: ButtonVariantOptions = {}) {
  return clsx(buttonStyles(options).className, options.class, options.className);
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | null;
  size?: ButtonSize | null;
  xstyle?: stylex.StyleXStyles;
  asChild?: boolean;
  width?: React.CSSProperties['width'];
  height?: React.CSSProperties['height'];
  labelColor?: React.CSSProperties['color'];
  gap?: React.CSSProperties['gap'];
  paddingInline?: React.CSSProperties['paddingInline'];
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      xstyle,
      variant,
      size,
      asChild = false,
      width,
      height,
      labelColor,
      gap,
      paddingInline,
      style,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button';
    // A pre-inserted duplicate key can reverse caller shorthand/longhand order.
    // Keep legacy fields unchanged unless the new spacing path is selected.
    const hasSpacingFields = gap != null || paddingInline != null;
    const childStyle =
      hasSpacingFields &&
      asChild &&
      React.isValidElement<{ style?: React.CSSProperties }>(props.children)
        ? props.children.props.style
        : undefined;
    const overridesField = (key: keyof React.CSSProperties) =>
      Object.prototype.hasOwnProperty.call(style ?? {}, key) ||
      Object.prototype.hasOwnProperty.call(childStyle ?? {}, key);
    const fieldStyle =
      width == null && height == null && labelColor == null && gap == null && paddingInline == null
        ? style
        : {
            ...(width != null && (!hasSpacingFields || !overridesField('width')) && { width }),
            ...(height != null && (!hasSpacingFields || !overridesField('height')) && { height }),
            ...(labelColor != null &&
              (!hasSpacingFields || !overridesField('color')) && { color: labelColor }),
            ...(gap != null && !overridesField('gap') && { gap }),
            ...(paddingInline != null && !overridesField('paddingInline') && { paddingInline }),
            ...style,
          };
    const sx = buttonStyles({ variant, size }, xstyle);
    return (
      <Comp
        className={clsx(sx.className, className)}
        ref={ref}
        {...props}
        style={sx.style ? { ...sx.style, ...fieldStyle } : fieldStyle}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
