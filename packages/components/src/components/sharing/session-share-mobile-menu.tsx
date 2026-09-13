import { useState } from 'react';
import { Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppCapability } from '@/lib/app-platform';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import {
  MobileSessionMenuSheet,
  type MobileSessionMenuSheetProps,
} from '@/components/mobile/mobile-session-menu-sheet';
import { SessionShareDialog } from './session-share-dialog';

/** Mobile hides SessionHeaderMenu, so its native menu owns a separate entry. */
export function SessionShareMobileMenu({
  workspaceId,
  session,
  ...menu
}: MobileSessionMenuSheetProps & {
  workspaceId: WorkspaceId | null;
  /** The active persisted Tab; drafts/viewers must pass null. */
  session: SessionMeta | null;
}) {
  const { t } = useTranslation();
  const available = useAppCapability('teamSharing');
  const [sharing, setSharing] = useState(false);
  const enabled = available && workspaceId !== null && session !== null;
  return (
    <>
      <MobileSessionMenuSheet
        {...menu}
        actions={
          enabled
            ? [
                ...menu.actions,
                {
                  id: 'public-share',
                  icon: <Share2 className="h-3.5 w-3.5" />,
                  label: t('sharing.manager.title', 'Share conversation'),
                  onClick: () => setSharing(true),
                },
              ]
            : menu.actions
        }
      />
      {enabled && sharing && (
        <SessionShareDialog
          workspaceId={workspaceId}
          session={session}
          onClose={() => setSharing(false)}
        />
      )}
    </>
  );
}
