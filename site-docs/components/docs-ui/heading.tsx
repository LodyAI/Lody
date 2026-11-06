'use client';

import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { Heading as BehaviorHeading } from 'fumadocs-ui/components/heading';
import type { ComponentProps } from 'react';

const styles = stylex.create({
  heading: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 'var(--spacing)',
    scrollMargin: 'calc(var(--spacing) * 28)',
    ':is(*) > button': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      borderRadius: 'var(--radius-md)',
      padding: 'var(--spacing)',
      fontSize: 'var(--text-sm)',
      lineHeight: 'var(--text-sm--line-height)',
      fontWeight: 'var(--font-weight-medium)',
      color: 'var(--color-fd-muted-foreground)',
      opacity: 0,
      transitionProperty: 'opacity',
      transitionDuration: '100ms',
      transitionTimingFunction: 'var(--default-transition-timing-function)',
    },
    ':is(*) > button:disabled': { pointerEvents: 'none', opacity: 0.5 },
    ':is(*) > button:focus-visible': {
      outlineStyle: 'none',
      boxShadow: '0 0 0 2px var(--color-fd-ring)',
    },
    '@media (hover: hover)': {
      ':is(*):hover > button': { opacity: 1 },
      ':is(*) > button:hover': {
        backgroundColor: 'var(--color-fd-accent)',
        color: 'var(--color-fd-accent-foreground)',
      },
    },
    ':is(*) > button svg': {
      width: 'calc(var(--spacing) * 4)',
      height: 'calc(var(--spacing) * 4)',
    },
  },
});

export function Heading({ className, ...props }: ComponentProps<typeof BehaviorHeading>) {
  const sx = stylex.props(Boolean(props.id) && styles.heading);
  return <BehaviorHeading {...props} className={clsx(sx.className, className)} />;
}
