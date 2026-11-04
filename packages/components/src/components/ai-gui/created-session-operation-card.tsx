import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { Ban, Check, CircleDashed, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { styles as taskStyles } from './subagent-task-panel.stylex';
import { useTranslation } from 'react-i18next';
import {
  getSessionRoomId,
  type SessionId,
  type SessionMeta,
  type OperationProgressStatus,
} from '@lody/shared';

import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import type { SessionNavigationTarget } from '@/lib/session-navigation';

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

/** A target Session's live title, falling back to the Operation's label. */
export function useOperationTargetTitle(sessionId: SessionId, fallbackTitle?: string): string {
  const { t } = useTranslation();
  const titleAtom = useMemo(
    () => selectAtom(sessionMetaAtomFamily(getSessionRoomId(sessionId)), selectSessionTitle),
    [sessionId]
  );
  const liveTitle = useAtomValue(titleAtom);
  return liveTitle || fallbackTitle?.trim() || t('sessions.untitled', 'Untitled session');
}

const styles = stylex.create({
  root: { display: 'grid', minWidth: 0 },
  title: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
    textAlign: 'start',
    fontWeight: 400,
  },
  status: { fontWeight: 400 },
  detail: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.tertiaryLabel,
  },
});

/** A compact task-style row; status stays bound to the creating Operation's Turn. */
export function CreatedSessionOperationCard({
  sessionId,
  fallbackTitle,
  status,
  detail,
  onNavigateSession,
}: {
  sessionId: SessionId;
  fallbackTitle?: string;
  status: CreatedSessionStatus;
  detail?: string;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
}) {
  const { t } = useTranslation();
  const title = useOperationTargetTitle(sessionId, fallbackTitle);
  const Glyph =
    status === 'succeeded'
      ? Check
      : status === 'failed'
        ? X
        : status === 'cancelled'
          ? Ban
          : CircleDashed;
  return (
    <div data-session-relation-card="opened" {...stylex.props(styles.root)}>
      <Button
        variant="ghost"
        size="small"
        disabled={!onNavigateSession}
        title={title}
        aria-label={`${t('sessions.openedBy.viewSession', 'View session')}: ${title}`}
        onClick={onNavigateSession ? () => onNavigateSession({ sessionId }) : undefined}
      >
        <span {...stylex.props(taskStyles.line)}>
          <span
            aria-hidden="true"
            {...stylex.props(
              taskStyles.mark,
              status === 'succeeded'
                ? taskStyles.markDone
                : status === 'failed'
                  ? taskStyles.markFailed
                  : taskStyles.markPending
            )}
          >
            {status === 'running' ? (
              <Spinner size="small" label={null} />
            ) : (
              <Glyph {...stylex.props(taskStyles.glyph)} />
            )}
          </span>
          <span {...stylex.props(styles.title)}>{title}</span>
          {detail ? (
            <span title={detail} {...stylex.props(styles.detail)}>
              · {detail}
            </span>
          ) : null}
          <span
            role="status"
            data-session-creation-status={status}
            {...stylex.props(
              taskStyles.meta,
              styles.status,
              status === 'failed' && taskStyles.danger
            )}
          >
            {t(statusLabels[status])}
          </span>
        </span>
      </Button>
    </div>
  );
}
