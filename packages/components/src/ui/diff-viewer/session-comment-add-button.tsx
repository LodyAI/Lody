'use client';

import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeDuration, themeRadius, themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  button: {
    display: 'flex',
    height: themeSpace[5],
    width: themeSpace[5],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.sm,
    backgroundColor: themeColors.primary,
    color: themeColors.primaryForeground,
    transitionProperty: 'all',
    transitionDuration: themeDuration[100],
    transitionTimingFunction:
      'var(--tw-ease, var(--default-transition-timing-function, cubic-bezier(0.4, 0, 0.2, 1)))',
  },
  glyph: { height: themeSpace[3], width: themeSpace[3] },
});

interface SessionCommentAddButtonProps {
  onClick: () => void;
  className?: string;
}

/**
 * The "+" button shown when hovering over a commentable line in the diff viewer.
 * Positioned in the gutter area, similar to GitHub's review button.
 */
export function SessionCommentAddButton({ onClick, className }: SessionCommentAddButtonProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        stylex.props(styles.button).className,
        'shadow-xs hover:bg-primary/90 active:scale-95',
        className
      )}
      aria-label="Add comment"
    >
      <Plus {...stylex.props(styles.glyph)} />
    </button>
  );
}
