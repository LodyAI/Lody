import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';

import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { duration, ease } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';

const styles = stylex.create({
  /** Layout only: the button keeps its own material, and the fill is clipped to it. */
  button: { position: 'relative', minWidth: '4.5rem', overflow: 'hidden' },
  /** Work in flight is live state, so the fill is a film of the accent with no edge. */
  fill: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: 0,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.accent} 20%)`,
    transitionProperty: 'width',
    transitionDuration: duration.slow,
    transitionTimingFunction: ease.standard,
    pointerEvents: 'none',
  },
  fillWidth: (percent: number) => ({ width: `${percent}%` }),
  layer: { position: 'relative', zIndex: 1 },
  icon: { display: 'flex', flexShrink: 0, alignItems: 'center' },
  label: { fontVariantNumeric: 'tabular-nums' },
});

export function ProviderProgressButton({
  label,
  percent,
  ariaLabel,
  title,
  icon,
  onClick,
  className,
}: {
  label: string;
  percent?: number | null;
  ariaLabel?: string;
  title?: string;
  /** Rendered before the label; supplied only when the pill also acts. */
  icon?: ReactNode;
  /**
   * Turns the pill into a real control. Without it the pill is a disabled
   * read-out of work in flight, which is what it is for the whole normal run.
   */
  onClick?: () => void;
  className?: string;
}) {
  const boundedPercent =
    typeof percent === 'number' ? Math.min(100, Math.max(0, Math.round(percent))) : null;

  return (
    <Button
      type="button"
      variant="secondary"
      size="small"
      disabled={!onClick}
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
      className={withClassName(stylex.props(styles.button), className).className}
    >
      {boundedPercent !== null ? (
        <span aria-hidden="true" {...stylex.props(styles.fill, styles.fillWidth(boundedPercent))} />
      ) : null}
      {icon !== undefined ? (
        <span aria-hidden="true" {...stylex.props(styles.layer, styles.icon)}>
          {icon}
        </span>
      ) : null}
      <span {...stylex.props(styles.layer, styles.label)}>{label}</span>
    </Button>
  );
}
