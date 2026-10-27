import { Archive } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontWeight,
  themeRadius,
  themeShadow,
  themeSpace,
} from '../style/theme-scale.stylex';

const CONFIRM_RESET_DELAY_MS = 3500;

/**
 * The dark-mode colours of the armed button. StyleX cannot select a `.dark`
 * ancestor, so these two stay Tailwind classes on the button; everything else
 * on it moves to StyleX.
 */
const DARK_CLASS = 'dark:border-destructive/30 dark:text-destructive-foreground';
/** The pill's own fill, in the dark theme. */
const DARK_FILL_CLASS = 'dark:bg-destructive/35';

const styles = stylex.create({
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.sm,
    // The button's focus ring was a Tailwind `focus-visible:ring-2`, which
    // painted nothing and erased the app's global focus ring. It keeps no
    // focus indicator, exactly as before.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  /** Armed: the label sits on a destructive pill. */
  confirming: {
    position: 'relative',
    zIndex: 10,
    height: themeSpace[5],
    minWidth: themeSpace[14],
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: 'hsl(var(--destructive) / 0.2)',
      ':hover': 'hsl(var(--destructive) / 0.25)',
    },
    backgroundColor: themeColors.sidebar,
    paddingInline: themeSpace[2],
    fontSize: '11px',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1,
    color: themeColors.destructive,
    boxShadow: themeShadow.xs,
    transitionProperty: 'none',
  },
  /** At rest: a quiet archive glyph that comes up to the row's ink. */
  idle: {
    height: themeSpace[5],
    width: themeSpace[5],
    color: {
      default: 'hsl(var(--sidebar-foreground-muted) / 0.8)',
      ':hover': themeColors.sidebarForeground,
    },
    transitionProperty: 'opacity, color, background-color, border-color, width',
    transitionDuration: themeDuration[100],
    transitionTimingFunction: themeEasing['in-out'],
  },
  /** The pill's fill, behind the label. */
  fill: {
    pointerEvents: 'none',
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--destructive) / 0.12)',
  },
  label: {
    position: 'relative',
    zIndex: 10,
  },
  glyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
});

type SidebarConfirmArchiveButtonProps = {
  label: string;
  confirmLabel: string;
  className?: string;
  iconClassName?: string;
  onConfirm: () => void;
} & Omit<ComponentPropsWithoutRef<'button'>, 'type' | 'onConfirm'>;

export const SidebarConfirmArchiveButton = forwardRef<
  HTMLButtonElement,
  SidebarConfirmArchiveButtonProps
>(function SidebarConfirmArchiveButton(
  {
    label,
    confirmLabel,
    className,
    iconClassName,
    onConfirm,
    onBlur,
    onClick,
    onKeyDown,
    onMouseLeave,
    ...buttonProps
  },
  ref
) {
  const [isConfirming, setIsConfirming] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current === null) return;
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }, []);

  const resetConfirming = useCallback(() => {
    clearResetTimer();
    setIsConfirming(false);
  }, [clearResetTimer]);

  const armConfirming = useCallback(() => {
    clearResetTimer();
    setIsConfirming(true);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setIsConfirming(false);
    }, CONFIRM_RESET_DELAY_MS);
  }, [clearResetTimer]);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!isConfirming) {
      armConfirming();
      return;
    }

    resetConfirming();
    onConfirm();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }

    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    resetConfirming();
  };

  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    onBlur?.(event);
    resetConfirming();
  };

  const handleMouseLeave = (event: MouseEvent<HTMLButtonElement>) => {
    onMouseLeave?.(event);
    if (isConfirming) {
      resetConfirming();
    }
  };

  const buttonStyle = stylex.props(styles.button, isConfirming ? styles.confirming : styles.idle);
  const fillStyle = stylex.props(styles.fill);
  const glyphStyle = stylex.props(styles.glyph);

  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      {...buttonStyle}
      className={clsx(buttonStyle.className, DARK_CLASS, className)}
      aria-label={isConfirming ? `Confirm ${label}` : label}
      onClick={handleClick}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onMouseLeave={handleMouseLeave}
    >
      {isConfirming ? (
        <>
          <span aria-hidden="true" className={clsx(fillStyle.className, DARK_FILL_CLASS)} />
          <span {...stylex.props(styles.label)}>{confirmLabel}</span>
        </>
      ) : (
        <Archive {...glyphStyle} className={clsx(glyphStyle.className, iconClassName)} />
      )}
    </button>
  );
});
