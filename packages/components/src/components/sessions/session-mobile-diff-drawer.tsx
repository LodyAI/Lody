import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Drawer } from '@lody/ui/drawer';
import { space } from '@lody/ui/tokens/scales.stylex';
import { SessionMobileDiffDrawerContent } from './session-mobile-diff-drawer-content';
import { SessionChangesSidebar, type SessionChangesSidebarProps } from './session-changes-sidebar';

/** Initial browsing defers the diff; Back keeps an already-mounted diff alive. */
export type MobileDiffView = 'files' | 'diff' | 'files-with-diff';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view?: MobileDiffView;
  onBackToFiles?: () => void;
  changes: SessionChangesSidebarProps;
  children: ReactNode;
};

const styles = stylex.create({
  popup: { padding: 0, overflow: 'hidden' },
  frame: {
    display: 'flex',
    height: '85dvh',
    minHeight: 0,
    flexDirection: 'column',
    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  },
  header: {
    display: 'flex',
    minHeight: '52px',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[2],
    paddingInlineStart: space[3],
    paddingInlineEnd: space[8],
  },
  icon: { width: '16px', height: '16px' },
  body: { minHeight: 0, flex: '1 1 0%', overflow: 'hidden' },
  hidden: { display: 'none' },
});

/** One modal, with the desktop changes list before the mobile diff. */
export function SessionMobileDiffDrawer({
  open,
  onOpenChange,
  view = 'diff',
  onBackToFiles,
  changes,
  children,
}: Props) {
  const { t } = useTranslation();
  const showFiles = view !== 'diff';
  return (
    <Drawer.Root side="bottom" open={open} onOpenChange={onOpenChange}>
      <SessionMobileDiffDrawerContent
        side="bottom"
        className={stylex.props(styles.popup).className}
        closeLabel={t('common.close', 'Close')}
        aria-describedby={undefined}
      >
        <div {...stylex.props(styles.frame)}>
          <div {...stylex.props(styles.header)}>
            {onBackToFiles && !showFiles ? (
              <Button variant="ghost" size="small" onClick={onBackToFiles}>
                <ArrowLeft {...stylex.props(styles.icon)} />
                {t('common.back', 'Back')}
              </Button>
            ) : null}
            <Drawer.Title>
              {onBackToFiles
                ? t('sessions.changes.title', 'Changes')
                : t('sessions.diffTab', 'Conversation Diff')}
            </Drawer.Title>
          </div>
          {onBackToFiles ? (
            <div
              {...stylex.props(styles.body, !showFiles && styles.hidden)}
              aria-hidden={!showFiles}
              inert={!showFiles}
            >
              <SessionChangesSidebar {...changes} />
            </div>
          ) : null}
          <div
            {...stylex.props(styles.body, showFiles && styles.hidden)}
            aria-hidden={showFiles}
            inert={showFiles}
          >
            {view !== 'files' ? children : null}
          </div>
        </div>
      </SessionMobileDiffDrawerContent>
    </Drawer.Root>
  );
}
