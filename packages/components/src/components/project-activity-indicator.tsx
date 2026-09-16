import type { TFunction } from 'i18next';
import { SessionRowStatusIndicator } from './sidebar-row-shared';
import { getProjectActivityItems, type ProjectActivityCounts } from './project-activity';

// Desktop project rows anchor the indicator's right edge this far from the
// row's right edge: LocalProjectItem reserves pr-3 (12px), the row's gap-2
// between the indicator and the actions cluster (8px), and two 20px hover
// actions with a 2px gap (42px). Other collapsed row kinds reserve the
// remainder of this zone so their slots land on the same x.
export const PROJECT_ACTIVITY_TRAILING_PX = 62;

export function getProjectActivityLabel(counts: ProjectActivityCounts, t: TFunction) {
  return [
    [counts.permission, t('sessions.status.requestPermission', 'Request Permission')],
    [counts.unread, t('sessions.unreadMessages', 'Unread messages')],
    [counts.active, t('sessions.status.active', 'Active')],
  ]
    .filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(' · ');
}

export function ProjectActivityIndicator({ counts }: { counts: ProjectActivityCounts }) {
  const items = getProjectActivityItems(counts);
  return (
    <span
      className="inline-grid h-5 shrink-0 grid-cols-[repeat(2,1.75rem)] items-center gap-1 text-[10px] font-medium leading-none tabular-nums"
      aria-hidden="true"
    >
      {items.map(({ status, count }, index) => (
        <span
          key={status}
          data-project-activity-status={status}
          className={`grid h-3.5 w-7 grid-cols-[0.875rem_0.75rem] items-center gap-0.5${
            items.length === 1 ? ' col-start-2' : ''
          }`}
        >
          {status === 'more' ? (
            <span className="col-span-2 flex h-3.5 w-7 items-center justify-center">+{count}</span>
          ) : (
            <SessionRowStatusIndicator
              isWaitingPermission={status === 'permission'}
              hasUnreadMessages={status === 'unread'}
              isWorking={status === 'active'}
            />
          )}
          {status !== 'more' ? (
            <span
              // Left-aligned so the digit hugs the indicator box: a centered
              // digit floats on its single-count slack and the pair loosens.
              className="text-left"
              style={count > 999 ? { fontSize: `${30 / String(count).length}px` } : undefined}
            >
              {count > 1 || (index === 0 && items[1]?.status === 'more') ? count : null}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}
