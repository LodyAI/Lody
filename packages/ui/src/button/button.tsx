import { Button as BaseButton } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { colors } from '../tokens/colors.stylex';
import { corner, duration, ease, radius, text } from '../tokens/scales.stylex';
import { button } from './button.tokens.stylex';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'link';
export type ButtonSize = 'mini' | 'small' | 'medium' | 'large';
export type ButtonTone = 'neutral' | 'destructive';
export type ButtonShape = 'default' | 'pill';

type BaseProps = ComponentProps<typeof BaseButton>;

export interface ButtonProps extends Omit<BaseProps, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: ButtonTone;
  shape?: ButtonShape;
  icon?: boolean;
  className?: string;
}

const PRESS = { transform: 'translateY(1px)' };

const styles = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: button.gap,
    flexShrink: 0,
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    lineHeight: 1,
    color: 'inherit',
    cursor: { default: 'pointer', ':disabled': 'default' },
    userSelect: 'none',
    textDecoration: 'none',
    cornerShape: corner.shape,
    outlineStyle: { default: 'none', ':focus-visible': 'solid' },
    outlineWidth: '2px',
    outlineColor: colors.accent,
    outlineOffset: '1px',
    opacity: { default: 1, ':disabled': 0.45 },
    pointerEvents: { default: 'auto', ':disabled': 'none' },
    transitionProperty: 'background-color, color, box-shadow, transform, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  mini: {
    height: button.heightMini,
    paddingInline: button.paddingXMini,
    borderRadius: button.radiusMini,
    fontSize: button.textMini,
  },
  small: {
    height: button.heightSmall,
    paddingInline: button.paddingXSmall,
    borderRadius: button.radiusSmall,
    fontSize: button.textSmall,
  },
  medium: {
    height: button.heightMedium,
    paddingInline: button.paddingXMedium,
    borderRadius: button.radiusMedium,
    fontSize: button.textMedium,
  },
  large: {
    height: button.heightLarge,
    paddingInline: button.paddingXLarge,
    borderRadius: button.radiusMedium,
    fontSize: button.textMedium,
  },
  iconMini: { width: button.heightMini, paddingInline: 0 },
  iconSmall: { width: button.heightSmall, paddingInline: 0 },
  iconMedium: { width: button.heightMedium, paddingInline: 0 },
  iconLarge: { width: button.heightLarge, paddingInline: 0 },
  pill: { borderRadius: radius.full },
  primary: {
    backgroundColor: {
      default: button.primaryBackground,
      ':hover': `color-mix(in oklab, ${button.primaryBackground}, ${button.primaryLabel} 12%)`,
    },
    color: button.primaryLabel,
    boxShadow: { default: button.primaryEdge, ':active': 'none' },
    transform: { default: 'none', ':active': PRESS.transform },
  },
  secondary: {
    backgroundColor: {
      default: button.secondaryBackground,
      ':hover': `color-mix(in oklab, ${button.secondaryBackground}, ${colors.label} 4%)`,
    },
    color: colors.label,
    boxShadow: { default: button.secondaryShadow, ':active': 'none' },
    transform: { default: 'none', ':active': PRESS.transform },
  },
  ghost: {
    backgroundColor: { default: 'transparent', ':hover': button.ghostHover },
    color: { default: button.ghostLabel, ':hover': colors.label },
  },
  destructive: {
    backgroundColor: {
      default: colors.destructive,
      ':hover': `color-mix(in oklab, ${colors.destructive}, ${colors.label} 10%)`,
    },
    color: colors.onDestructive,
    boxShadow: { default: 'inset 0 1px 0 hsl(0 0% 100% / 0.2)', ':active': 'none' },
    transform: { default: 'none', ':active': PRESS.transform },
  },
  link: {
    height: 'auto',
    paddingInline: 0,
    color: colors.accent,
    textDecoration: { default: 'none', ':hover': 'underline' },
    textUnderlineOffset: '4px',
  },
  destructiveTone: {
    color: { default: colors.destructive, ':hover': colors.destructive },
    backgroundColor: { ':hover': `color-mix(in oklab, ${colors.destructive} 10%, transparent)` },
  },
});

const sizeStyles = {
  mini: styles.mini,
  small: styles.small,
  medium: styles.medium,
  large: styles.large,
};

const iconStyles = {
  mini: styles.iconMini,
  small: styles.iconSmall,
  medium: styles.iconMedium,
  large: styles.iconLarge,
};

export const Button = forwardRef<HTMLElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'medium',
    tone = 'neutral',
    shape = 'default',
    icon = false,
    className,
    ...rest
  },
  ref
) {
  const sx = stylex.props(
    styles.base,
    sizeStyles[size],
    icon && iconStyles[size],
    shape === 'pill' && styles.pill,
    styles[variant],
    tone === 'destructive' &&
      variant !== 'primary' &&
      variant !== 'destructive' &&
      styles.destructiveTone
  );
  return (
    <BaseButton
      ref={ref}
      data-variant={variant}
      data-size={size}
      {...rest}
      className={className ? `${sx.className} ${className}` : sx.className}
      style={sx.style}
    />
  );
});
