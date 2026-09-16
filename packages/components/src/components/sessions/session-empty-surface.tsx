import type { SessionId, SessionMeta } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/button';
import { ClosedTabsPopover } from './session-tab-bar';

/** A workspace with no selected conversation still owns its tools and closed tabs. */
export function SessionEmptySurface({
  closedSessions,
  onNew,
  onReopen,
}: {
  closedSessions: SessionMeta[];
  onNew: () => void;
  onReopen: (id: SessionId) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 p-6"
      role="region"
      aria-label={t('sessions.tabs.empty', 'No conversation open')}
    >
      <p className="text-sm text-muted-foreground">
        {t('sessions.tabs.empty', 'No conversation open')}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onNew}>
          {t('sessions.tabs.newChat', 'New Chat')}
        </Button>
        {closedSessions.length > 0 && (
          <ClosedTabsPopover archivedSessions={closedSessions} onRestore={onReopen} />
        )}
      </div>
    </div>
  );
}
