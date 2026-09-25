import type { ReactNode } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Archive, ChevronDown, PanelLeft, Trash2, Undo2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';
import { navigationSidebarHiddenAtom, showNavigationSidebarAtom } from '@/atoms/layout-state';
import { isMacOSElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import {
  useMacTrafficLightRowPadClass,
  useWindowDragRegionClass,
  useWindowsCaptionPadClass,
  useWindowsCaptionRowPadClass,
} from '@/ui/window-drag-region';
import { isNativeAppShell } from '@/lib/native-platform';
import { Button } from '@lody/ui/button';
import { Menu } from '@/ui/menu';
import { Tooltip } from '@lody/ui/tooltip';

type ArchiveScope = 'my' | 'team';

const styles = stylex.create({
  screen: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minWidth: 0,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
  /* The session tab bar's 44px row, so the sidebar toggle sits at the same spot
     across views. The page is flat: no rule under the header. */
  header: {
    boxSizing: 'border-box',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    height: 'calc(2.75rem + var(--safe-area-top))',
    paddingTop: 'var(--safe-area-top)',
    paddingLeft: 'calc(16px + var(--safe-area-left))',
    paddingRight: 'calc(16px + var(--safe-area-right))',
    backgroundColor: colors.background,
  },
  // The show-sidebar button's -4px lands its left edge at 96px, matching Chat
  // Landing and clearing the traffic lights by 24px.
  headerBesideTrafficLights: { paddingLeft: '100px' },
  sidebarToggle: { marginInlineStart: '-4px' },
  glyph: { width: '16px', height: '16px' },
  glyphSmall: { width: '14px', height: '14px' },
  selectedCount: {
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
  },
  spacer: { flexGrow: 1 },
  titleGroup: { display: 'flex', alignItems: 'center', gap: space[2] },
  titleGlyph: { flexShrink: 0, width: '16px', height: '16px', color: colors.secondaryLabel },
  title: {
    margin: 0,
    fontSize: text.bodySize,
    fontWeight: 600,
    lineHeight: text.bodyLeading,
    color: colors.label,
  },
  scope: { minWidth: 0, marginInlineStart: space[2] },
  scopeLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chevron: { flexShrink: 0, width: '14px', height: '14px', color: colors.tertiaryLabel },
  body: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    width: '100%',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  },
});

export type WebArchiveScreenProps = {
  archiveScope: ArchiveScope;
  isMultiSelectMode: boolean;
  selectedCount: number;
  isBulkActionBusy: boolean;
  bulkRestoreDisabled?: boolean;
  bulkRestoreDisabledReason?: string;
  onArchiveScopeChange: (scope: ArchiveScope) => void;
  onExitMultiSelect: () => void;
  onBulkRestore: () => void;
  onRequestBulkDelete: () => void;
  dialogs: ReactNode;
  children: ReactNode;
};

export function WebArchiveScreen({
  archiveScope,
  isMultiSelectMode,
  selectedCount,
  isBulkActionBusy,
  bulkRestoreDisabled = false,
  bulkRestoreDisabledReason,
  onArchiveScopeChange,
  onExitMultiSelect,
  onBulkRestore,
  onRequestBulkDelete,
  dialogs,
  children,
}: WebArchiveScreenProps) {
  const { t } = useTranslation();
  const isLeftSidebarHidden = useAtomValue(navigationSidebarHiddenAtom);
  const showNavigationSidebar = useSetAtom(showNavigationSidebarAtom);
  const isElectronFullscreen = useElectronFullscreen();
  const windowDragClass = useWindowDragRegionClass();
  const windowsCaptionPadClass = useWindowsCaptionPadClass();
  const macTrafficLightRowPadClass = useMacTrafficLightRowPadClass();
  const windowsCaptionRowPadClass = useWindowsCaptionRowPadClass();
  // Traffic lights auto-hide in native fullscreen — no inset to reserve then.
  // Mirrors the same derivation in session-detail.tsx.
  const hasMacOSTitlebarInset =
    !isNativeAppShell() && isMacOSElectronRenderer() && !isElectronFullscreen;

  const scopeLabel =
    archiveScope === 'my'
      ? t('sessions.sidebar.my', 'My Tasks')
      : t('sessions.sidebar.team', 'All Tasks');
  const chromeClassName = [
    windowDragClass,
    windowsCaptionPadClass,
    windowsCaptionRowPadClass,
    macTrafficLightRowPadClass,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tooltip.Provider>
      <div {...stylex.props(styles.screen)}>
        <header
          {...withClassName(
            stylex.props(
              styles.header,
              isLeftSidebarHidden && hasMacOSTitlebarInset && styles.headerBesideTrafficLights
            ),
            chromeClassName
          )}
        >
          {isLeftSidebarHidden ? (
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon
              onClick={() => showNavigationSidebar()}
              aria-label={t('sessions.leftSidebar.show', 'Show navigation sidebar')}
              className={stylex.props(styles.sidebarToggle).className}
            >
              <PanelLeft {...stylex.props(styles.glyph)} />
            </Button>
          ) : null}
          {isMultiSelectMode ? (
            <>
              <Button
                variant="ghost"
                size="small"
                icon
                aria-label={t('archive.multiSelect.exit', 'Exit selection')}
                onClick={onExitMultiSelect}
              >
                <X {...stylex.props(styles.glyph)} />
              </Button>
              <span {...stylex.props(styles.selectedCount)}>
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
                <Undo2 {...stylex.props(styles.glyphSmall)} />
                {t('archive.multiSelect.restore', 'Restore')}
              </Button>
              <Button
                variant="destructive"
                size="small"
                disabled={selectedCount === 0 || isBulkActionBusy}
                onClick={onRequestBulkDelete}
              >
                <Trash2 {...stylex.props(styles.glyphSmall)} />
                {t('archive.multiSelect.delete', 'Delete')}
              </Button>
            </>
          ) : (
            <>
              <div {...stylex.props(styles.titleGroup)}>
                <Archive {...stylex.props(styles.titleGlyph)} />
                <h1 {...stylex.props(styles.title)}>{t('archive.title', 'Archive')}</h1>
              </div>
              <div {...stylex.props(styles.scope)}>
                <Menu.Root>
                  <Menu.Trigger
                    render={
                      <Button type="button" variant="ghost" size="small">
                        <span {...stylex.props(styles.scopeLabel)}>{scopeLabel}</span>
                        <ChevronDown {...stylex.props(styles.chevron)} />
                      </Button>
                    }
                  />
                  <Menu.Content align="start">
                    <Menu.RadioGroup
                      value={archiveScope}
                      onValueChange={(value) => {
                        if (value === 'my' || value === 'team') {
                          onArchiveScopeChange(value);
                        }
                      }}
                    >
                      <Menu.RadioItem value="my">
                        {t('sessions.sidebar.my', 'My Tasks')}
                      </Menu.RadioItem>
                      <Menu.RadioItem value="team">
                        {t('sessions.sidebar.team', 'All Tasks')}
                      </Menu.RadioItem>
                    </Menu.RadioGroup>
                  </Menu.Content>
                </Menu.Root>
              </div>
            </>
          )}
        </header>

        {/* The archive list owns its own scrollport so virtualization can attach
            to a sibling node instead of this chrome ancestor. */}
        <div {...stylex.props(styles.body)}>{children}</div>
        {dialogs}
      </div>
    </Tooltip.Provider>
  );
}
