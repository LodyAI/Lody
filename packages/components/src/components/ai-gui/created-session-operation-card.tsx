import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { CheckCircle2, Circle, CircleX, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getSessionRoomId,
  type SessionId,
  type SessionMeta,
  type OperationProgressStatus,
} from '@lody/shared';

import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { SessionRelationCard } from '@/components/shared/session-relation-card';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { cn } from '@/lib/utils';

type CreatedSessionStatus = OperationProgressStatus;

const statusLabels = {
  created: 'sessions.openedBy.status.created',
  running: 'sessions.openedBy.status.running',
  succeeded: 'sessions.openedBy.status.succeeded',
  failed: 'sessions.openedBy.status.failed',
  cancelled: 'sessions.openedBy.status.cancelled',
} as const;
const selectSessionTitle = (session: SessionMeta | null | undefined): string | null =>
  session?.title?.trim() || null;

/** The status belongs to the creating Operation's target Turn, not later Session activity. */
export function CreatedSessionOperationCard({
  sessionId,
  fallbackTitle,
  status,
  onNavigateSession,
}: {
  sessionId: SessionId;
  fallbackTitle?: string;
  status: CreatedSessionStatus;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
}) {
  const { t } = useTranslation();
  const titleAtom = useMemo(
    () => selectAtom(sessionMetaAtomFamily(getSessionRoomId(sessionId)), selectSessionTitle),
    [sessionId]
  );
  const liveTitle = useAtomValue(titleAtom);
  const title = liveTitle || fallbackTitle?.trim() || t('sessions.untitled', 'Untitled session');
  const StatusIcon =
    status === 'running'
      ? LoaderCircle
      : status === 'succeeded'
        ? CheckCircle2
        : status === 'failed'
          ? CircleX
          : Circle;

  return (
    <SessionRelationCard
      relation="opened"
      label={t('sessions.openedBy.createdSession', 'Session created')}
      sessionTitle={title}
      actionLabel={t('sessions.openedBy.viewSession', 'View session')}
      onAction={onNavigateSession ? () => onNavigateSession({ sessionId }) : undefined}
      status={
        <span
          role="status"
          data-session-creation-status={status}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 self-start text-xs sm:self-auto',
            status === 'failed'
              ? 'text-destructive'
              : status === 'succeeded'
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground'
          )}
        >
          <StatusIcon
            className={cn('h-3.5 w-3.5', status === 'running' && 'motion-safe:animate-spin')}
            aria-hidden="true"
          />
          {t(statusLabels[status])}
        </span>
      }
    />
  );
}
