import type { ReactNode } from 'react';
import { Archive, PanelLeft, Trash2, Undo2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeFontWeight,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  /** The screen: a column of a fixed header and a scrolling body. */
  screen: {
    display: 'flex',
    height: '100%',
    width: '100%',
    minWidth: 0,
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: themeColors.background,
  },
  /** The header: the safe-area height plus the bar's own height. */
  header: {
    display: 'flex',
    height: 'calc(56px + var(--safe-area-top))',
    width: '100%',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[3],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: themeColors.border,
    backgroundColor: themeColors.background,
    paddingLeft: 'calc(16px + var(--safe-area-left))',
    paddingRight: 'calc(16px + var(--safe-area-right))',
    paddingTop: 'var(--safe-area-top)',
  },
  /** The selection count, quiet beside the actions. */
  count: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  /** The space between the count and the actions. */
  spacer: { flexGrow: 1 },
  /** The archive's name and its mark. */
  titleGroup: { display: 'flex', alignItems: 'center', gap: themeSpace[2] },
  title: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.semibold,
  },
  icon: { height: themeSpace[4], width: themeSpace[4] },
  iconMuted: { height: themeSpace[4], width: themeSpace[4], color: themeColors.mutedForeground },
  smallIcon: { height: themeSpace[3.5], width: themeSpace[3.5] },
  /** The body: the list the archive shows. */
  body: {
    display: 'flex',
    minHeight: 0,
    width: '100%',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  /** Said to a screen reader and to nobody else. */
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
});

export type MobileArchiveScreenProps = {
  isMultiSelectMode: boolean;
  selectedCount: number;
  isBulkActionBusy: boolean;
  bulkRestoreDisabled?: boolean;
  bulkRestoreDisabledReason?: string;
  onExitMultiSelect: () => void;
  onBulkRestore: () => void;
  onRequestBulkDelete: () => void;
  onOpenMobileDrawer: () => void;
  dialogs: ReactNode;
  children: ReactNode;
};

/**
 * Mobile Archive chrome. Scope / sort / group filters live next to the
 * search field in the page body (see `archive-view.tsx`), not in this
 * header — matching the chat home pattern of filter-after-search.
 */
export function MobileArchiveScreen({
  isMultiSelectMode,
  selectedCount,
  isBulkActionBusy,
  bulkRestoreDisabled = false,
  bulkRestoreDisabledReason,
  onExitMultiSelect,
  onBulkRestore,
  onRequestBulkDelete,
  onOpenMobileDrawer,
  dialogs,
  children,
}: MobileArchiveScreenProps) {
  const { t } = useTranslation();

  return (
    <Tooltip.Provider>
      <div {...stylex.props(styles.screen)}>
        <header {...stylex.props(styles.header)}>
          {isMultiSelectMode ? (
            <>
              <Button variant="ghost" size="large" icon onClick={onExitMultiSelect}>
                <X {...stylex.props(styles.icon)} />
                <span {...stylex.props(styles.srOnly)}>
                  {t('archive.multiSelect.exit', 'Exit selection')}
                </span>
              </Button>
              <span {...stylex.props(styles.count)}>
                {t('archive.multiSelect.selected', '{{count}} selected', {
                  count: selectedCount,
                })}
              </span>
              <div {...stylex.props(styles.spacer)} />
              <Button
                variant="secondary"
                size="small"
                disabled={selectedCount === 0 || isBulkActionBusy || bulkRestoreDisabled}
                title={bulkRestoreDisabled ? bulkRestoreDisabledReason : undefined}
                onClick={onBulkRestore}
              >
                <Undo2 {...stylex.props(styles.smallIcon)} />
                {t('archive.multiSelect.restore', 'Restore')}
              </Button>
              <Button
                variant="destructive"
                size="small"
                disabled={selectedCount === 0 || isBulkActionBusy}
                onClick={onRequestBulkDelete}
              >
                <Trash2 {...stylex.props(styles.smallIcon)} />
                {t('archive.multiSelect.delete', 'Delete')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="large" icon onClick={onOpenMobileDrawer}>
                <PanelLeft {...stylex.props(styles.icon)} />
                <span {...stylex.props(styles.srOnly)}>Open sidebar</span>
              </Button>
              <div {...stylex.props(styles.titleGroup)}>
                <Archive {...stylex.props(styles.iconMuted)} />
                <h1 {...stylex.props(styles.title)}>{t('archive.title', 'Archive')}</h1>
              </div>
            </>
          )}
        </header>

        <div {...stylex.props(styles.body)}>{children}</div>
        {dialogs}
      </div>
    </Tooltip.Provider>
  );
}
