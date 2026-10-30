import { useState, type ReactNode } from 'react';
import { ArrowLeft, Copy, Ellipsis, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';

import { FileIcon } from '@/components/icons/file-icons';
import {
  MobileSessionMenuSheet,
  type MobileSessionMenuAction,
  type MobileSessionMenuInfoRow,
} from '@/components/mobile/mobile-session-menu-sheet';
import { VaulDrawerBody } from '@/components/mobile/vaul-drawer-edge-back-zone';
import { getBasename } from '@/lib';
import { isNativeIOSAppShell } from '@/lib/native-platform';
import { Button } from '@lody/ui/button';
import { Drawer, DrawerContent, DrawerTitle } from '@/ui/drawer';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { sheetSurface } from './sheet-surface';

const MOBILE_FILE_DRAWER_HEADER_INSET = 'calc(3.5rem + var(--safe-area-top))';
const MOBILE_FILE_DRAWER_TOUCH_SIZE = 'calc(var(--spacing) * 11)';

const styles = stylex.create({
  /** The drawer's column. */
  column: {
    display: 'flex',
    height: '100%',
    minHeight: 0,
    flexDirection: 'column',
  },
  /** The drawer's header. */
  header: {
    display: 'flex',
    height: MOBILE_FILE_DRAWER_HEADER_INSET,
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[3],
    paddingTop: 'var(--safe-area-top)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: themeColors.border,
  },
  /** The header's identity column. */
  identity: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  /** The file's mark. */
  fileIcon: {
    width: themeSpace[5],
    height: themeSpace[5],
    flexShrink: 0,
  },
  /** The file's name. */
  fileName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.semibold,
  },
  /** The drawer's body. */
  body: {
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
  },
  /** The header's glyphs. */
  headerGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
  /** The glyphs the menu sheet's rows carry. */
  menuGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
});

export type MobileFileViewerDrawerProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly filePath: string;
  readonly onCopyPath: () => void;
  readonly onCopyMarkdown?: () => void;
  readonly children: ReactNode;
};

export function MobileFileViewerDrawer({
  open,
  onOpenChange,
  filePath,
  onCopyPath,
  onCopyMarkdown,
  children,
}: MobileFileViewerDrawerProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const isNativeIOS = isNativeIOSAppShell();
  const fileName = getBasename(filePath) || filePath;
  const menuInfoRows: MobileSessionMenuInfoRow[] = [
    {
      id: 'file-path',
      icon: <FileText {...stylex.props(styles.menuGlyph)} />,
      label: t('sessions.fileViewer.path', 'File path'),
      value: filePath,
      wrapValue: true,
      onCopy: onCopyPath,
    },
  ];
  const menuActions: MobileSessionMenuAction[] = [
    ...(onCopyMarkdown
      ? [
          {
            id: 'copy-file-content',
            icon: <Copy {...stylex.props(styles.menuGlyph)} />,
            label: t('sessions.fileViewer.copyMarkdown', 'Copy full Markdown'),
            onClick: onCopyMarkdown,
          },
        ]
      : []),
    {
      id: 'copy-file-path',
      icon: <Copy {...stylex.props(styles.menuGlyph)} />,
      label: t('sessions.fileViewer.copyPath', 'Copy file path'),
      onClick: onCopyPath,
    },
  ];

  return (
    <>
      <Drawer
        direction="right"
        // iOS uses the host's keyboard inset; other shells and browsers use
        // the live viewport. Vaul must not also cache/resize the editor height.
        repositionInputs={!isNativeIOS}
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setMenuOpen(false);
          onOpenChange(nextOpen);
        }}
      >
        {/* Width belongs to the Drawer; keep the consumer's insets and border compatibility. */}
        <DrawerContent
          forceMount
          width="full"
          className="inset-0 rounded-none border-0 border-l-0!"
          style={isNativeIOS ? { bottom: 'var(--native-keyboard-height, 0px)' } : undefined}
          data-sidebar-swipe-open-disabled
        >
          <DrawerTitle {...stylex.props(sheetSurface.srOnly)}>{fileName}</DrawerTitle>
          <VaulDrawerBody topInset={MOBILE_FILE_DRAWER_HEADER_INSET}>
            <div {...stylex.props(styles.column)}>
              <header {...stylex.props(styles.header)}>
                <Button
                  type="button"
                  variant="ghost"
                  icon
                  width={MOBILE_FILE_DRAWER_TOUCH_SIZE}
                  height={MOBILE_FILE_DRAWER_TOUCH_SIZE}
                  className="-ml-1"
                  onClick={() => onOpenChange(false)}
                  aria-label={t('common.back', 'Back')}
                >
                  <ArrowLeft {...stylex.props(styles.headerGlyph)} />
                </Button>
                <div {...stylex.props(styles.identity)}>
                  <FileIcon
                    filePath={filePath}
                    className={stylex.props(styles.fileIcon).className}
                  />
                  <span {...stylex.props(styles.fileName)}>{fileName}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  icon
                  width={MOBILE_FILE_DRAWER_TOUCH_SIZE}
                  height={MOBILE_FILE_DRAWER_TOUCH_SIZE}
                  className="-mr-1"
                  onClick={() => setMenuOpen(true)}
                  aria-label={t('sessions.fileViewer.moreActions', 'File actions')}
                >
                  <Ellipsis {...stylex.props(styles.headerGlyph)} />
                </Button>
              </header>
              <div {...stylex.props(styles.body)}>{children}</div>
            </div>
          </VaulDrawerBody>
        </DrawerContent>
      </Drawer>
      <MobileSessionMenuSheet
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={t('sessions.fileViewer.moreActions', 'File actions')}
        infoRows={menuInfoRows}
        actions={menuActions}
      />
    </>
  );
}
