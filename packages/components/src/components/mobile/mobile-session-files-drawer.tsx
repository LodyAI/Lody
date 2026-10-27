import { useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  MobileProjectFileBrowser,
  type MobileProjectFileBrowserHandle,
} from '@/components/files/mobile-project-file-browser';
import { VaulDrawerBody } from '@/components/mobile/vaul-drawer-edge-back-zone';
import type { FileWorkspaceProvider } from '@/lib/file-workspace-provider';
import { isNativeAppShell } from '@/lib/native-platform';
import { getSessionDetailTouchIconButtonClassName } from '@/lib/session-detail-a11y';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Drawer, DrawerContent, DrawerTitle } from '@/ui/drawer';

const HEADER_INSET = 'calc(3.5rem + var(--safe-area-top))';

const styles = stylex.create({
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  column: { display: 'flex', height: '100%', flexDirection: 'column' },
  header: {
    display: 'flex',
    height: HEADER_INSET,
    flexShrink: 0,
    alignItems: 'center',
    gap: space[2],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
    paddingInline: space[3],
    paddingTop: 'var(--safe-area-top)',
  },
  icon: { width: '16px', height: '16px' },
  title: {
    minWidth: 0,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    fontWeight: 500,
  },
  body: { position: 'relative', minHeight: 0, flex: 1 },
});

export type MobileSessionFilesDrawerProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly provider: FileWorkspaceProvider | null;
  readonly pending?: boolean;
  readonly message?: string;
  /** Opens the file in the host's viewer drawer. The Files drawer stays open
     underneath, so the viewer's Back lands on the folder it was opened from. */
  readonly onOpenFile: (path: string) => void;
};

/**
 * Mobile Files full-screen drawer — the counterpart of the desktop Files side
 * panel. Opened from the session tab sheet's Files viewer entry.
 *
 * Back layering (deliberate, and it falls out of the z-indexes): inside a
 * folder the browser mounts its own edge zone at z-60, so an edge swipe pops
 * one directory level; at the root it mounts none, leaving only
 * `VaulDrawerBody`'s z-30 strip, so the same gesture closes the drawer. That is
 * the iOS drill-out order — keep the two z values apart if either zone moves.
 *
 * Opening a file never closes this drawer: the host's viewer drawer is a later
 * body portal at the same z rung, so it stacks above and closing it reveals
 * the folder again (closing here first unmounted the browser and dropped its
 * folder stack, so Back fell through to the conversation).
 */
export function MobileSessionFilesDrawer({
  open,
  onOpenChange,
  provider,
  pending,
  message,
  onOpenFile,
}: MobileSessionFilesDrawerProps) {
  const { t } = useTranslation();
  const browserRef = useRef<MobileProjectFileBrowserHandle>(null);
  const title = t('sessions.detailTabs.files', 'Files');

  return (
    <Drawer
      direction="right"
      repositionInputs={isNativeAppShell()}
      open={open}
      onOpenChange={onOpenChange}
    >
      <DrawerContent
        className="w-full! max-w-none! inset-0 border-0 border-l-0! rounded-none"
        data-sidebar-swipe-open-disabled
      >
        <DrawerTitle className={stylex.props(styles.srOnly).className}>{title}</DrawerTitle>
        <VaulDrawerBody topInset={HEADER_INSET}>
          <div {...stylex.props(styles.column)}>
            <header {...stylex.props(styles.header)}>
              <Button
                type="button"
                variant="ghost"
                icon
                className={getSessionDetailTouchIconButtonClassName('-ml-1')}
                /* Same order as the edge swipe: pop a directory level first,
                   close the drawer only at the root. */
                onClick={() => {
                  if (browserRef.current?.canGoBack() === true) {
                    browserRef.current.goBack();
                    return;
                  }
                  onOpenChange(false);
                }}
                aria-label={t('common.back', 'Back')}
              >
                <ArrowLeft {...stylex.props(styles.icon)} />
              </Button>
              <span {...stylex.props(styles.title)}>{title}</span>
            </header>
            <div {...stylex.props(styles.body)}>
              <MobileProjectFileBrowser
                ref={browserRef}
                provider={provider}
                pending={pending}
                message={message}
                onOpenFile={onOpenFile}
                /* No bottom tab bar over this drawer — only the safe area
                   needs clearing. */
                bottomTabBarVisible={false}
              />
            </div>
          </div>
        </VaulDrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
