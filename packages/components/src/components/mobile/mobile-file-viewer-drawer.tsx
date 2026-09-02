import { useState, type ReactNode } from 'react';
import { ArrowLeft, Copy, Ellipsis, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FileIcon } from '@/components/icons/file-icons';
import {
  MobileSessionMenuSheet,
  type MobileSessionMenuAction,
  type MobileSessionMenuInfoRow,
} from '@/components/mobile/mobile-session-menu-sheet';
import { VaulDrawerBody } from '@/components/mobile/vaul-drawer-edge-back-zone';
import { getSessionDetailTouchIconButtonClassName } from '@/lib/session-detail-a11y';
import { getBasename } from '@/lib';
import { isNativeAppShell } from '@/lib/native-platform';
import { Button } from '@lody/ui/button';
import { Drawer, DrawerContent, DrawerTitle } from '@/ui/drawer';

const MOBILE_FILE_DRAWER_HEADER_INSET = 'calc(3.5rem + var(--safe-area-top))';

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
  const fileName = getBasename(filePath) || filePath;
  const menuInfoRows: MobileSessionMenuInfoRow[] = [
    {
      id: 'file-path',
      icon: <FileText className="h-3.5 w-3.5" />,
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
            icon: <Copy className="h-3.5 w-3.5" />,
            label: t('sessions.fileViewer.copyMarkdown', 'Copy full Markdown'),
            onClick: onCopyMarkdown,
          },
        ]
      : []),
    {
      id: 'copy-file-path',
      icon: <Copy className="h-3.5 w-3.5" />,
      label: t('sessions.fileViewer.copyPath', 'Copy file path'),
      onClick: onCopyPath,
    },
  ];

  return (
    <>
      <Drawer
        direction="right"
        repositionInputs={isNativeAppShell()}
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setMenuOpen(false);
          onOpenChange(nextOpen);
        }}
      >
        <DrawerContent
          forceMount
          className="inset-0 w-full! max-w-none! rounded-none border-0 border-l-0!"
          data-sidebar-swipe-open-disabled
        >
          <DrawerTitle className="sr-only">{fileName}</DrawerTitle>
          <VaulDrawerBody topInset={MOBILE_FILE_DRAWER_HEADER_INSET}>
            <div className="flex h-full min-h-0 flex-col">
              <header className="flex h-[calc(3.5rem+var(--safe-area-top))] shrink-0 items-center gap-2 border-b border-border px-3 pt-[var(--safe-area-top)]">
                <Button
                  type="button"
                  variant="ghost"
                  icon
                  className={getSessionDetailTouchIconButtonClassName('-ml-1')}
                  onClick={() => onOpenChange(false)}
                  aria-label={t('common.back', 'Back')}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <FileIcon filePath={filePath} className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 truncate text-sm font-semibold">{fileName}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  icon
                  className={getSessionDetailTouchIconButtonClassName('-mr-1')}
                  onClick={() => setMenuOpen(true)}
                  aria-label={t('sessions.fileViewer.moreActions', 'File actions')}
                >
                  <Ellipsis className="h-4 w-4" />
                </Button>
              </header>
              <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
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
