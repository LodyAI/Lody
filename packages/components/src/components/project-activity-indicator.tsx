import type { TFunction } from 'i18next';
import { SessionRowStatusIndicator } from './sidebar-row-shared';
import { getProjectActivityItems, type ProjectActivityCounts } from './project-activity';

export function getProjectActivityLabel(counts: ProjectActivityCounts, t: TFunction) {
  return [
    [counts.permission, t('sessions.status.requestPermission', 'Request Permission')],
    [counts.unread, t('sessions.unreadMessages', 'Unread messages')],
    [counts.active, t('sessions.status.running', 'Running')],
  ]
    .filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(' · ');
}

export function ProjectActivityIndicator({ counts }: { counts: ProjectActivityCounts }) {
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-1.5 text-[10px] font-medium tabular-nums"
      aria-hidden="true"
    >
      {getProjectActivityItems(counts).map(({ status, count }) => (
        <span
          key={status}
          data-project-activity-status={status}
          className="inline-flex items-center gap-0.5"
        >
          {status === 'more' ? (
            `+${count}`
          ) : (
            <>
              <SessionRowStatusIndicator
                isWaitingPermission={status === 'permission'}
                hasUnreadMessages={status === 'unread'}
                isWorking={status === 'active'}
              />
              {count > 1 ? count : null}
            </>
          )}
        </span>
      ))}
    </span>
  );
}
