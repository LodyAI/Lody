import { useId, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { ChevronDown, ChevronUp, GitBranchPlus, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getSessionLaunchConfigLegacyFields, type SessionId, type SessionMeta } from '@lody/shared';

import { getAgentMetaByIdAtomFamily } from '@/atoms/agents';
import { createdSessionsAtomFamily } from '@/atoms/doc-meta';
import { INFO_BAR_ELEVATION_CLASS } from '@/components/chat/composer-surface';
import { AgentIcon } from '@/components/icons/agent-icon';
import { ConversationColumn } from '@/components/shared/conversation-column';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { cn } from '@/lib/utils';

export type SessionRelationsBarItem = {
  sessionId: SessionId;
  title: string;
  /** Null while the related Session's metadata is unknown (deleted or unsynced). */
  session: SessionMeta | null;
  /** Null when the Session cannot be routed to yet. */
  target: SessionNavigationTarget | null;
};

/**
 * Subscribes to the Sessions `sessionId` created here, in the leaf, so a
 * created Session's status churn never re-renders the conversation page.
 */
export function CurrentSessionRelationsBar({
  sessionId,
  parent,
  onOpenSession,
}: {
  sessionId: SessionId;
  parent: SessionRelationsBarItem | null;
  onOpenSession: (target: SessionNavigationTarget) => void;
}) {
  const { t } = useTranslation();
  const createdSessions = useAtomValue(createdSessionsAtomFamily(sessionId));
  const created = useMemo(
    () =>
      createdSessions.map((session): SessionRelationsBarItem => ({
        sessionId: session.id,
        title: session.title?.trim() || t('sessions.untitled', 'Untitled session'),
        session,
        target: session.parentSessionId
          ? { sessionId: session.parentSessionId, tabSessionId: session.id }
          : { sessionId: session.id },
      })),
    [createdSessions, t]
  );
  return <SessionRelationsBar parent={parent} created={created} onOpenSession={onOpenSession} />;
}

/**
 * The "opened by" relationship (`SessionMeta.openedBySessionId`, written when
 * `lody_session_create` runs inside a Session) pinned above the info bar.
 * The in-stream creation cards scroll away with the conversation; this bar
 * keeps the opener and every Session or Tab this one created one click away.
 *
 * Collapsed it is one info-bar-height row; expanded, the list grows upward so
 * the toggle row stays put next to the info bar.
 */
export function SessionRelationsBar({
  parent,
  created,
  onOpenSession,
  defaultExpanded = false,
}: {
  parent: SessionRelationsBarItem | null;
  /** Oldest first. A Tab child carries `parentSessionId`. */
  created: readonly SessionRelationsBarItem[];
  onOpenSession: (target: SessionNavigationTarget) => void;
  /** Storybook/testing aid. */
  defaultExpanded?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const listId = useId();
  if (!parent && created.length === 0) return null;

  const renderRow = (item: SessionRelationsBarItem, kindLabel: string) => {
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
    <div className="w-full shrink-0 bg-background pb-1">
      <ConversationColumn>
        <div
          className={cn(
            'w-full min-w-0 overflow-hidden rounded-lg border-[0.5px] border-foreground/[0.10] bg-[hsl(var(--composer))] dark:border-input-border/45 dark:bg-input/70',
            INFO_BAR_ELEVATION_CLASS
          )}
        >
          {expanded ? (
            <div
              id={listId}
              className="max-h-64 overflow-y-auto border-b-[0.5px] border-foreground/[0.08] p-1"
            >
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
          ) : null}
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((value) => !value)}
            className="flex h-8 w-full min-w-0 select-none items-center gap-1.5 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <GitBranchPlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {created.length > 0 ? (
              <span className="shrink-0 font-medium text-foreground">
                {t('sessions.relations.createdCount', 'Created sessions ({{count}})', {
                  count: created.length,
                })}
              </span>
            ) : null}
            {parent ? (
              <>
                {created.length > 0 ? (
                  <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-muted-foreground/25" />
                ) : null}
                <span className="min-w-0 truncate">
                  {t('sessions.relations.openedBy', 'From {{title}}', { title: parent.title })}
                </span>
              </>
            ) : null}
            {expanded ? (
              <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronUp className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
          </button>
        </div>
      </ConversationColumn>
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
