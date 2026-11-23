import * as React from 'react';
import * as stylex from '@stylexjs/stylex';

import { clsx } from 'clsx';

const styles = stylex.create({
  glyphs: {
    ':is(*) > svg': {
      width: 'calc(var(--spacing) * 4)',
      height: 'calc(var(--spacing) * 4)',
      translate: '0 calc(var(--spacing) * .5)',
      color: 'currentColor',
    },
  },
  root: {
    gridTemplateColumns: { default: '0 1fr', ':has(> svg)': '1rem 1fr' },
    columnGap: { default: null, ':has(> svg)': 'calc(var(--spacing) * 2.5)' },
    position: 'relative',
    display: 'grid',
    width: '100%',
    alignItems: 'flex-start',
    rowGap: 'calc(var(--spacing) * 0.5)',
    borderRadius: 'var(--radius)',
    borderStyle: 'solid',
    borderWidth: 1,
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2.5)',
    fontSize: 13,
  },
  default: {
    borderColor: 'hsl(var(--border))',
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    },
    color: 'hsl(var(--foreground))',
  },
  destructive: {
    borderColor: {
      default: 'hsl(var(--status-danger))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-danger)) 35%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--status-danger))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-danger)) 10%, transparent)',
    },
    color: 'hsl(var(--status-danger))',
  },
  warning: {
    borderColor: {
      default: 'hsl(var(--status-warning))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-warning)) 35%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--status-warning))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-warning)) 10%, transparent)',
    },
    color: 'hsl(var(--status-warning))',
  },
  info: {
    borderColor: {
      default: 'hsl(var(--status-info))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-info)) 35%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--status-info))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-info)) 10%, transparent)',
    },
    color: 'hsl(var(--status-info))',
  },
  title: {
    fontWeight: 'var(--font-weight-medium)',
    lineHeight: 1,
    letterSpacing: 'var(--tracking-tight)',
    gridColumnStart: '2',
    minHeight: 'calc(var(--spacing) * 4)',
  },
  description: {
    gridColumnStart: '2',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--crh-leading, var(--text-sm--line-height))',
    color: 'hsl(var(--muted-foreground))',
  },
});

type AlertVariant = 'default' | 'destructive' | 'warning' | 'info';
const variants = {
  default: styles.default,
  destructive: styles.destructive,
  warning: styles.warning,
  info: styles.info,
};

function Alert({
  className,
  variant = 'default',
  xstyle,
  style,
  ...props
}: React.ComponentProps<'div'> & { variant?: AlertVariant | null; xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.root, styles.glyphs, variant && variants[variant], xstyle);
  return (
    <div
      data-slot="alert"
      role="alert"
      {...sx}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
}
function AlertTitle({
  className,
  xstyle,
  style,
  ...props
}: React.ComponentProps<'div'> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.title, xstyle);
  return (
    <div
      data-slot="alert-title"
      {...sx}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
}
function AlertDescription({
  className,
  xstyle,
  style,
  ...props
}: React.ComponentProps<'div'> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.description, xstyle);
  return (
    <div
      data-slot="alert-description"
      {...sx}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
}
export { Alert, AlertTitle, AlertDescription };
