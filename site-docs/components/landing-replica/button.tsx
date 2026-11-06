import { forwardRef, type ButtonHTMLAttributes } from 'react';
import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'calc(var(--spacing) * 2)',
    whiteSpace: 'nowrap',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
    outlineStyle: {
      default: null,
      ':focus-visible': 'none',
      '@media (forced-colors: active)': { ':focus-visible': 'solid' },
    },
    outlineColor: {
      default: null,
      '@media (forced-colors: active)': { ':focus-visible': 'transparent' },
    },
    outlineWidth: { default: null, '@media (forced-colors: active)': { ':focus-visible': 2 } },
    outlineOffset: { default: null, '@media (forced-colors: active)': { ':focus-visible': 2 } },
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
    ':is(*) svg': { pointerEvents: 'none', flexShrink: 0 },
    ':is(*) svg:not([data-replica-sized])': {
      width: 'var(--replica-button-icon-size, calc(var(--spacing) * 4))',
      height: 'var(--replica-button-icon-size, calc(var(--spacing) * 4))',
    },
  },
  iconSize: (size: string) => ({ '--replica-button-icon-size': size }),
  compactLabel: {
    ':is(*) span': { fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-tight)' },
  },
});

const variants = stylex.create({
  default: {
    backgroundColor: {
      default: 'hsl(var(--primary))',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--button-hover))' },
    },
    color: 'hsl(var(--primary-foreground))',
  },
  outline: {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'hsl(var(--input-border))',
    backgroundColor: {
      default: 'hsl(var(--background))',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--hover))' },
    },
    color: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--hover-foreground))' },
    },
  },
  secondary: {
    backgroundColor: {
      default: 'hsl(var(--button-secondary))',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--button-secondary-hover))' },
    },
    color: 'hsl(var(--button-secondary-foreground))',
  },
  ghost: {
    backgroundColor: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--hover))' },
    },
    color: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--hover-foreground))' },
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
});

const sizes = stylex.create({
  default: {
    height: 'calc(var(--spacing) * 9)',
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBlock: 'calc(var(--spacing) * 2)',
  },
  sm: {
    height: 'calc(var(--spacing) * 8)',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
  lg: {
    height: 'calc(var(--spacing) * 10)',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 8)',
  },
  icon: { height: 'calc(var(--spacing) * 9)', width: 'calc(var(--spacing) * 9)' },
});

const shadows = stylex.create({
  none: {
    boxShadow: {
      default: 'none',
      ':focus-visible': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 1px hsl(var(--ring)), 0 0 #0000',
    },
  },
  xs: {
    boxShadow: {
      default: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-xs)',
      ':focus-visible':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 1px hsl(var(--ring)), var(--shadow-xs)',
    },
  },
  sm: {
    boxShadow: {
      default: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
      ':focus-visible':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 1px hsl(var(--ring)), var(--shadow-sm)',
    },
  },
});

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  xstyle?: stylex.StyleXStyles;
  iconSize?: string;
  compactLabel?: boolean;
  shadow?: keyof typeof shadows;
};

/** Site-owned display replica; native button, refs and event behavior stay intact. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = 'default',
    size = 'default',
    type = 'button',
    xstyle,
    iconSize,
    compactLabel = false,
    shadow,
    style,
    ...props
  },
  ref
) {
  const sx = stylex.props(
    styles.base,
    variants[variant],
    sizes[size],
    shadows[
      shadow ??
        (variant === 'default'
          ? 'sm'
          : variant === 'outline' || variant === 'secondary'
            ? 'xs'
            : 'none')
    ],
    iconSize != null && styles.iconSize(iconSize),
    compactLabel && styles.compactLabel,
    xstyle
  );
  return (
    <button
      ref={ref}
      type={type}
      className={[sx.className, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...style }}
      {...props}
    />
  );
});
