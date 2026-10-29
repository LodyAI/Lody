import type { CSSProperties, ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { clsx } from 'clsx';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { useIsMobile } from '../../hooks/use-mobile';
import { useSetAtom } from 'jotai';
import { toggleMobileDrawerAtom } from '../../atoms';
import { isNativeAppShell } from '@/lib/native-platform';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeSpace,
} from '../../style/theme-scale.stylex';

interface BaseHeaderProps {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Inline overrides (e.g. the mobile session floating header's exact height). */
  style?: CSSProperties;
  hideMenuButton?: boolean;
  leading?: ReactNode;
  truncateTitle?: boolean;
}

const styles = stylex.create({
  /** The bar: a row of title and actions, on the page's own plane. */
  bar: {
    display: 'flex',
    alignItems: 'center',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: themeColors.border,
    backgroundColor: themeColors.background,
  },
  /**
   * A native shell reserves the safe areas: the bar starts below the notch and
   * keeps clear of the sides. The safe-area insets differ per side, so the
   * left and right padding are stated separately.
   */
  barNative: {
    height: 'calc(3.5rem + var(--safe-area-top))',
    paddingTop: 'var(--safe-area-top)',
    paddingLeft: 'calc(0.75rem + var(--safe-area-left))',
    paddingRight: 'calc(0.75rem + var(--safe-area-right))',
    '@media (min-width: 640px)': {
      paddingLeft: 'calc(1rem + var(--safe-area-left))',
      paddingRight: 'calc(1rem + var(--safe-area-right))',
    },
  },
  /** A browser-shaped surface: a fixed bar with the ordinary padding. */
  barWeb: {
    height: '3.5rem',
    paddingInline: themeSpace[3],
    '@media (min-width: 640px)': { paddingInline: themeSpace[4] },
  },
  /** The title: the page's name, taking the room the actions do not. */
  title: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: themeFontSize.xl,
    lineHeight: themeLineHeight.xl,
    fontWeight: themeFontWeight.semibold,
  },
  titleSmall: {
    fontSize: themeFontSize.base,
    lineHeight: themeLineHeight.base,
  },
  titleTruncated: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The slot before the title: the drawer toggle or a caller's leading mark. */
  leading: { marginRight: themeSpace[2], flexShrink: 0 },
  /** The actions: a cluster that never wraps and never takes the title's room. */
  actions: {
    marginLeft: themeSpace[2],
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    '@media (min-width: 640px)': { gap: themeSpace[2] },
  },
  /** The drawer's glyph. */
  menuIcon: { height: themeSpace[5], width: themeSpace[5] },
  menuButtonSpacing: { marginRight: 'calc(var(--spacing) * 2)' },
});

/**
 * Base header component.
 * Provides a responsive page header layout and shows a drawer toggle on mobile.
 */
export function BaseHeader({
  title,
  actions,
  className,
  style,
  hideMenuButton = false,
  leading,
  truncateTitle = true,
}: BaseHeaderProps) {
  const isMobile = useIsMobile();
  const isNativeApp = isNativeAppShell();
  const toggleDrawer = useSetAtom(toggleMobileDrawerAtom);
  const barProps = stylex.props(styles.bar, isNativeApp ? styles.barNative : styles.barWeb);

  return (
    <div
      {...barProps}
      // A caller's class stays a plain Tailwind class: the `utilities` layer
      // sits above the `stylex` layer, so it keeps overriding this bar's own
      // layout, exactly as `twMerge` used to let it.
      className={clsx(barProps.className, className)}
      style={style}
    >
      {/* Mobile: drawer toggle */}
      {isMobile && !hideMenuButton && (
        <Button
          variant="ghost"
          icon
          className={clsx(stylex.props(styles.menuButtonSpacing).className, 'md:hidden')}
          onClick={(e) => {
            // Remove focus to avoid aria-hidden warnings in some browsers.
            (e.currentTarget as HTMLElement).blur();
            toggleDrawer();
          }}
        >
          <Menu {...stylex.props(styles.menuIcon)} />
        </Button>
      )}

      {/* Custom leading element (e.g. back button) */}
      {leading && <div {...stylex.props(styles.leading)}>{leading}</div>}

      {/* Title */}
      <h2
        {...stylex.props(
          styles.title,
          isMobile && styles.titleSmall,
          truncateTitle && styles.titleTruncated
        )}
      >
        {title}
      </h2>

      {/* Actions */}
      {actions && <div {...stylex.props(styles.actions)}>{actions}</div>}
    </div>
  );
}
