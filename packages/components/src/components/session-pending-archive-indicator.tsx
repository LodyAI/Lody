import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Archive, X } from 'lucide-react';
import type { SessionId } from '@lody/shared';
import { pendingArchiveRootAtomFamily } from '@/atoms/session-archive';
import { ArchivePendingIcon } from './icons/archive-pending-icon';
import { useSessionActions } from '@/hooks/use-session-actions';
import { toast } from '@/lib/toast';

const styles = stylex.create({ container: { pointerEvents: 'auto', display: 'inline-flex' } });

export function SessionPendingArchiveIndicator({ sessionId }: { sessionId: string }) {
  const rootId = useAtomValue(pendingArchiveRootAtomFamily(sessionId));
  return rootId ? <PendingArchiveActions rootId={rootId} /> : null;
}

function PendingArchiveActions({ rootId }: { rootId: SessionId }) {
  const { t } = useTranslation();
  const { cancelPendingArchive, requestArchiveSession } = useSessionActions();
  const run = (action: () => Promise<unknown>) => {
    void action().catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error))
    );
  };
  const label = t(
    'sessions.deferredArchive.pending',
    'Pending archive: waiting for work and queued messages to finish'
  );
  return (
    <span {...stylex.props(styles.container)} onClick={(event) => event.stopPropagation()}>
      <Menu.Root>
        <Menu.Trigger
          render={<Button variant="ghost" size="mini" icon aria-label={label} title={label} />}
        >
          <ArchivePendingIcon size={14} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Content>
          <Menu.Item icon={X} onClick={() => run(() => cancelPendingArchive(rootId))}>
            {t('sessions.deferredArchive.cancel', 'Cancel pending archive')}
          </Menu.Item>
          <Menu.Item
            icon={Archive}
            tone="destructive"
            onClick={() => run(() => requestArchiveSession(rootId))}
          >
            {t('sessions.deferredArchive.immediate', 'Archive immediately')}
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>
    </span>
  );
}
