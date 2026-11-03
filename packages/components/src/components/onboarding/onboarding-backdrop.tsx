import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';

const styles = stylex.create({
  root: {
    pointerEvents: 'none',
    position: 'absolute',
    inset: 0,
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted) / 1) 20%, transparent)',
  },
});

export function OnboardingBackdrop({ className }: { className?: string }) {
  return <div aria-hidden className={clsx(stylex.props(styles.root).className, className)} />;
}
