import * as stylex from '@stylexjs/stylex';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeRadius, themeSpace } from '../../style/theme-scale.stylex';
import type { SessionFileMenuItem } from '@/hooks/use-session-file-actions';
import { Menu } from '@/ui/menu';

const styles = stylex.create({
  trigger: {
    display: 'flex',
    height: themeSpace[7],
    width: themeSpace[7],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.md,
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    backgroundColor: { default: null, ':hover': themeColors.hover },
    color: { default: themeColors.mutedForeground, ':hover': themeColors.hoverForeground },
    // The old Tailwind `focus-visible:ring-*` painted nothing — the app forces
    // Tailwind's own ring transparent — but it still declared a `box-shadow`,
    // and a utility-layer shadow beats the base layer's inset focus ring. So
    // the button showed NO focus indicator at all. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  glyph: { height: themeSpace[4], width: themeSpace[4] },
});

/**
 * The side panel's ⋯ button: the same actions the file tree offers on
 * right-click, for the file the panel is currently showing. It renders nothing
 * when the active tab is not a file — a "more" button with nothing behind it is
 * worse than no button.
 */
export function SessionFileActionsMenu({
  filePath,
  items,
  className,
}: {
  readonly filePath: string | null;
  readonly items: readonly SessionFileMenuItem[];
  readonly className?: string;
}) {
  const { t } = useTranslation();
  if (!filePath || items.length === 0) return null;
  const visibleItems = items.filter((item) => item.isAvailable?.(filePath) ?? true);
  if (visibleItems.length === 0) return null;

  const triggerProps = stylex.props(styles.trigger);
  const glyphProps = stylex.props(styles.glyph);

  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <button
            type="button"
            aria-label={t('sessions.fileActions.more', 'File actions')}
            {...triggerProps}
            className={clsx(triggerProps.className, className)}
          >
            <MoreHorizontal {...glyphProps} />
          </button>
        }
      >
        <button
          type="button"
          aria-label={t('sessions.fileActions.more', 'File actions')}
          {...triggerProps}
          className={clsx(triggerProps.className, className)}
        >
          <MoreHorizontal {...glyphProps} />
        </button>
      </Menu.Trigger>
      <Menu.Content align="end" minWidth={190}>
        {visibleItems.map((item) => {
          const ItemIcon = item.icon;
          return (
            <Menu.Item key={item.id} icon={ItemIcon} onClick={() => item.run(filePath)}>
              {item.label}
            </Menu.Item>
          );
        })}
      </Menu.Content>
    </Menu.Root>
  );
}
