import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';

const styles = stylex.create({
  steps: {
    counterReset: 'step',
    position: 'relative',
    'padding-inline-start': {
      default: 'calc(var(--spacing) * 6)',
      '@media (width >= 40rem)': 'calc(var(--spacing) * 7)',
    },
    'margin-inline-start': {
      default: 'calc(var(--spacing) * 2)',
      '@media (width >= 40rem)': 'calc(var(--spacing) * 4)',
    },
    'border-inline-start-width': '1px',
    'border-inline-start-style': 'solid',
    'border-inline-start-color': 'var(--color-fd-border)',
  },
  step: {
    '::before': {
      backgroundColor: 'var(--color-fd-secondary)',
      color: 'var(--color-fd-secondary-foreground)',
      content: 'counter(step)',
      counterIncrement: 'step',
      justifyContent: 'center',
      alignItems: 'center',
      fontSize: '.875rem',
      lineHeight: '1.25rem',
      display: 'flex',
      position: 'absolute',
      width: 'calc(var(--spacing) * 8)',
      height: 'calc(var(--spacing) * 8)',
      'inset-inline-start': 'calc(var(--spacing) * -4)',
      borderRadius: 'calc(infinity * 1px)',
    },
  },
});

export function Steps({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.steps)}>{children}</div>;
}

export function Step({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.step)}>{children}</div>;
}
