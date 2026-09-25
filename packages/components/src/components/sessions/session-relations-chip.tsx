import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { MessageSquare, MessagesSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getSessionLaunchConfigLegacyFields, type SessionId, type SessionMeta } from '@lody/shared';

import { getAgentMetaByIdAtomFamily } from '@/atoms/agents';
import { createdSessionsAtomFamily } from '@/atoms/doc-meta';
import { AgentIcon } from '@/components/icons/agent-icon';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { PopoverActionChip } from './info-chip';

export type SessionRelationsItem = {
  sessionId: SessionId;
  title: string;
  /** Null while the related Session's metadata is unknown (deleted or unsynced). */
  session: SessionMeta | null;
  /** Null when the Session cannot be routed to yet. */
  target: SessionNavigationTarget | null;
};

/**
 * Whether `sessionId` created any Session or Tab. A boolean selection, so the
 * page re-renders only when the first one appears or the last one leaves —
 * never for a created Session's status churn.
 */
export function useHasCreatedSessions(sessionId: SessionId): boolean {
  const hasCreatedAtom = useMemo(
    () => selectAtom(createdSessionsAtomFamily(sessionId), (sessions) => sessions.length > 0),
    [sessionId]
  );
  return useAtomValue(hasCreatedAtom);
}

/**
 * Info-bar chip for the "opened by" relationship (`SessionMeta.openedBySessionId`,
 * written when `lody_session_create` runs inside a Session). The in-stream
 * creation cards scroll away with the conversation; this chip keeps the opener
 * and every Session or Tab created here one click away. The created list is
 * subscribed here, in the leaf.
 */
export function CurrentSessionRelationsChip({
  sessionId,
  parent,
  onOpenSession,
}: {
  sessionId: SessionId;
  parent: SessionRelationsItem | null;
  onOpenSession: (target: SessionNavigationTarget) => void;
}) {
  const { t } = useTranslation();
  const createdSessions = useAtomValue(createdSessionsAtomFamily(sessionId));
  const created = useMemo(
    () =>
      createdSessions.map((session): SessionRelationsItem => ({
        sessionId: session.id,
        title: session.title?.trim() || t('sessions.untitled', 'Untitled session'),
        session,
        target: session.parentSessionId
          ? { sessionId: session.parentSessionId, tabSessionId: session.id }
          : { sessionId: session.id },
      })),
    [createdSessions, t]
  );
  return <SessionRelationsChip parent={parent} created={created} onOpenSession={onOpenSession} />;
}

export function SessionRelationsChip({
  parent,
  created,
  onOpenSession,
  defaultOpen,
}: {
  parent: SessionRelationsItem | null;
  /** Oldest first. A Tab child carries `parentSessionId`. */
  created: readonly SessionRelationsItem[];
  onOpenSession: (target: SessionNavigationTarget) => void;
  /** Storybook/testing aid. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <PopoverActionChip
      icon={MessagesSquare}
      label={t('sessions.relations.label', 'Related sessions')}
      value={created.length > 0 ? String(created.length) : undefined}
      defaultOpen={defaultOpen}
      content={
        <SessionRelationsList parent={parent} created={created} onOpenSession={onOpenSession} />
      }
    />
  );
}

/** Opener, a divider, then every created Session/Tab: agent icon, title, kind. */
function SessionRelationsList({
  parent,
  created,
  onOpenSession,
}: {
  parent: SessionRelationsItem | null;
  created: readonly SessionRelationsItem[];
  onOpenSession: (target: SessionNavigationTarget) => void;
}) {
  const { t } = useTranslation();
  const renderRow = (item: SessionRelationsItem, kindLabel: string) => {
    const target = item.target;
    return (
      <button
        key={item.sessionId}
        type="button"
        disabled={!target}
        title={item.title}
        data-session-relation-row={item.sessionId}
        onClick={target ? () => onOpenSession(target) : undefined}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-muted-foreground/10 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
      >
        {item.session ? (
          <RelatedSessionAgentIcon
            session={item.session}
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          />
        ) : (
          <MessageSquare
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{kindLabel}</span>
      </button>
    );
  };

  return (
    <div className="max-h-64 overflow-y-auto p-1">
      {parent ? renderRow(parent, t('sessions.relations.parent', 'Parent')) : null}
      {parent && created.length > 0 ? (
        <div role="separator" className="mx-2 my-1 h-px bg-muted-foreground/20" />
      ) : null}
      {created.map((item) =>
        renderRow(
          item,
          item.session?.parentSessionId
            ? t('sessions.relations.kind.tab', 'Tab')
            : t('sessions.relations.kind.session', 'Session')
        )
      )}
    </div>
  );
}

function RelatedSessionAgentIcon({
  session,
  className,
}: {
  session: SessionMeta;
  className?: string;
}) {
  const agentConfig = useAtomValue(getAgentMetaByIdAtomFamily(session.agentConfigId));
  return (
    <AgentIcon
      cliType={session.cliType}
      agentType={session.agentType}
      env={agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env}
      className={className}
    />
  );
}
