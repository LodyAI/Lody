import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import * as stylex from '@stylexjs/stylex';

import { cn } from '@/lib/utils';

const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'grid',
    width: '100%',
    alignItems: 'flex-start',
    rowGap: 'calc(var(--spacing) * 0.5)',
    borderRadius: 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
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
    gridColumnStart: '2',
    minHeight: 'calc(var(--spacing) * 4)',
  },
  description: {
    gridColumnStart: '2',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--tw-leading, var(--text-sm--line-height))',
    color: 'hsl(var(--muted-foreground))',
  },
});

const alertVariants = cva(stylex.props(styles.root).className, {
  variants: {
    variant: {
      default: stylex.props(styles.default).className,
      destructive: stylex.props(styles.destructive).className,
      warning: stylex.props(styles.warning).className,
      info: stylex.props(styles.info).className,
    },
  },
  defaultVariants: { variant: 'default' },
});

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(
        alertVariants({ variant }),
        'grid-cols-[0_1fr] has-[>svg]:grid-cols-[1rem_1fr] has-[>svg]:gap-x-2.5 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
        className
      )}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        stylex.props(styles.title).className,
        'font-medium leading-none tracking-tight',
        className
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(stylex.props(styles.description).className, className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
