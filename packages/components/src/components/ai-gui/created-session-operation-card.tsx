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
  getAgentRoleEmoji,
  getSessionLaunchConfigLegacyFields,
  getSessionRoomId,
  type AgentConfigCliType,
  type AgentConfigId,
  type AgentRoleId,
  type SessionId,
  type SessionMeta,
  type OperationProgressStatus,
} from '@lody/shared';

import { getAgentMetaByIdAtomFamily } from '@/atoms/agents';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { AgentIcon, getAgentDisplayName } from '@/components/icons/agent-icon';
import { useWorkspaceAgentRoles } from '@/hooks/use-workspace-agent-roles';
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

type SessionAgentFields = {
  cliType: AgentConfigCliType;
  agentType: string;
  agentConfigId?: AgentConfigId;
  agentRoleId?: AgentRoleId;
  env?: Record<string, string>;
};

const selectSessionAgent = (session: SessionMeta | null | undefined): SessionAgentFields | null =>
  session?.cliType && session.agentType
    ? {
        cliType: session.cliType,
        agentType: session.agentType,
        agentConfigId: session.agentConfigId,
        agentRoleId: session.agentRoleId,
        env: getSessionLaunchConfigLegacyFields(session)?.env,
      }
    : null;

const sameSessionAgent = (a: SessionAgentFields | null, b: SessionAgentFields | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.cliType === b.cliType &&
    a.agentType === b.agentType &&
    a.agentConfigId === b.agentConfigId &&
    a.agentRoleId === b.agentRoleId &&
    a.env === b.env);

export type CreatedSessionIdentity = SessionAgentFields & {
  /** The readable Agent Role, when the Session was created from one. */
  roleName: string | null;
  /** That Role's glyph, shown in place of the provider icon as on every Role surface. */
  roleEmoji: string | null;
  /** Provider (agent config) name; always present once the target meta synced. */
  providerName: string;
  brandId?: Parameters<typeof AgentIcon>[0]['brandId'];
};

/**
 * Who runs a created Session: its Agent Role when the reader may still see that
 * Role, otherwise its provider. Role metadata is provenance only, so a deleted
 * or unreadable Role falls back to the provider instead of a dangling id.
 */
export function useCreatedSessionIdentity(sessionId: SessionId): CreatedSessionIdentity | null {
  const agentAtom = useMemo(
    () =>
      selectAtom(
        sessionMetaAtomFamily(getSessionRoomId(sessionId)),
        selectSessionAgent,
        sameSessionAgent
      ),
    [sessionId]
  );
  const agent = useAtomValue(agentAtom);
  const agentConfig = useAtomValue(getAgentMetaByIdAtomFamily(agent?.agentConfigId));
  const { roles } = useWorkspaceAgentRoles();
  if (!agent) return null;
  const role = agent.agentRoleId
    ? roles.find((entry) => entry.id === agent.agentRoleId && entry.name?.trim())
    : undefined;
  const providerName =
    agentConfig?.name?.trim() ||
    getAgentDisplayName(agent.cliType, agent.agentType) ||
    agent.agentType;
  return {
    ...agent,
    env: agentConfig?.env ?? agent.env,
    brandId: agentConfig?.brandId,
    roleName: role ? role.name.trim() : null,
    roleEmoji: role ? getAgentRoleEmoji(role) : null,
    providerName,
  };
}

const styles = stylex.create({
  // A single shrinkable track: the nowrap row must ellipsize, not widen the card.
  root: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 },
  /**
   * Who runs the Session, at the row's end where a status word used to sit: the
   * leading mark already says how the Session is doing.
   */
  agent: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    // The title gives way first; only then does a long Role name ellipsize.
    flexShrink: 1,
    minWidth: '3em',
    maxWidth: '45%',
    marginInlineStart: 'auto',
    color: colors.secondaryLabel,
  },
  agentIcon: { width: '13px', height: '13px', flexShrink: 0 },
  // A fixed glyph box, the width of the provider icon it stands in for.
  agentEmoji: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '14px',
    height: '14px',
    fontSize: '13px',
    lineHeight: 1,
  },
  agentName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  title: {
    flexGrow: 1,
    // Shrink is weighted by base size, so at a smaller ratio the agent name still
    // receives a fraction of a pixel, and any fractional overflow draws an
    // ellipsis on a name that fits. At this weight its share rounds to zero
    // until the title reaches its minimum.
    flexShrink: 1_000_000,
    minWidth: '2em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
    textAlign: 'start',
    fontWeight: 400,
  },
  /** The status word, for assistive technology only; sighted readers have the mark. */
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
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
  const identity = useCreatedSessionIdentity(sessionId);
  const agentName = identity ? (identity.roleName ?? identity.providerName) : null;
  const agentDescription = identity
    ? identity.roleName
      ? t('sessions.openedBy.agentRoleOnProvider', '{{role}} (Agent Role) · {{provider}}', {
          role: identity.roleName,
          provider: identity.providerName,
        })
      : identity.providerName
    : null;
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
        title={agentDescription ? `${agentDescription}\n${title}` : title}
        aria-label={`${t('sessions.openedBy.viewSession', 'View session')}: ${
          agentDescription ? `${agentDescription} · ${title}` : title
        }`}
        onClick={onNavigateSession ? () => onNavigateSession({ sessionId }) : undefined}
      >
        <span {...stylex.props(taskStyles.line)}>
          <span
            role="status"
            data-session-creation-status={status}
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
              <Glyph aria-hidden="true" {...stylex.props(taskStyles.glyph)} />
            )}
            <span {...stylex.props(styles.srOnly)}>{t(statusLabels[status])}</span>
          </span>
          <span {...stylex.props(styles.title)}>{title}</span>
          {detail ? (
            <span title={detail} {...stylex.props(styles.detail)}>
              · {detail}
            </span>
          ) : null}
          {identity && agentName ? (
            <span
              data-created-session-agent={identity.roleName ? 'role' : 'provider'}
              {...stylex.props(styles.agent)}
            >
              {identity.roleEmoji ? (
                <span aria-hidden="true" {...stylex.props(styles.agentEmoji)}>
                  {identity.roleEmoji}
                </span>
              ) : (
                <AgentIcon
                  cliType={identity.cliType}
                  agentType={identity.agentType}
                  brandId={identity.brandId}
                  env={identity.env}
                  className={stylex.props(styles.agentIcon).className}
                />
              )}
              <span {...stylex.props(styles.agentName)}>{agentName}</span>
            </span>
          ) : null}
        </span>
      </Button>
    </div>
  );
}
