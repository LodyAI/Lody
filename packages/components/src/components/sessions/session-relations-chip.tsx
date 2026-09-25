import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { MessagesSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getSessionLaunchConfigLegacyFields, type SessionId, type SessionMeta } from '@lody/shared';

import { getAgentMetaByIdAtomFamily } from '@/atoms/agents';
import { allActiveSessionsAtom } from '@/atoms/doc-meta';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { AgentIcon } from '@/components/icons/agent-icon';
import { SessionRowStatusIndicator } from '@/components/sidebar-row-shared';
import { sessionHasUnreadMessages } from '@/lib/session-read-receipt';
import type { SessionNavigationTarget } from '@/lib/session-navigation';
import {
  buildSessionRelationTree,
  countSessionRelationTree,
  hasSessionRelations,
  type SessionRelationTreeNode,
} from '@/lib/session-relation-tree';
import { cn } from '@/lib/utils';
import { PopoverActionChip } from './info-chip';

/**
 * Whether the current Session sits in an opened-by tree worth showing. A
 * boolean selection, so the page re-renders only when that answer flips —
 * never for a related Session's status churn.
 */
export function useHasSessionRelations(sessionId: SessionId): boolean {
  const hasRelationsAtom = useMemo(
    () =>
      selectAtom(allActiveSessionsAtom, (sessions) =>
        hasSessionRelations(buildSessionRelationTree(sessions, sessionId))
      ),
    [sessionId]
  );
  return useAtomValue(hasRelationsAtom);
}

/**
 * Info-bar chip for the opened-by relationship (`SessionMeta.openedBySessionId`,
 * written when `lody_session_create` runs inside a Session). The in-stream
 * creation cards scroll away with the conversation; this chip keeps the whole
 * tree — every ancestor and descendant — one click away. The tree is built
 * here, in the leaf.
 */
export function CurrentSessionRelationsChip({
  sessionId,
  onOpenSession,
}: {
  sessionId: SessionId;
  onOpenSession: (target: SessionNavigationTarget) => void;
}) {
  const sessions = useAtomValue(allActiveSessionsAtom);
  const tree = useMemo(() => buildSessionRelationTree(sessions, sessionId), [sessions, sessionId]);
  return tree ? (
    <SessionRelationsChip tree={tree} currentSessionId={sessionId} onOpenSession={onOpenSession} />
  ) : null;
}

export function SessionRelationsChip({
  tree,
  currentSessionId,
  onOpenSession,
  defaultOpen,
}: {
  tree: SessionRelationTreeNode;
  currentSessionId: SessionId;
  onOpenSession: (target: SessionNavigationTarget) => void;
  /** Storybook/testing aid. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <PopoverActionChip
      icon={MessagesSquare}
      label={t('sessions.relations.label', 'Related sessions')}
      // Everything in the tree except the current Session.
      value={String(countSessionRelationTree(tree) - 1)}
      defaultOpen={defaultOpen}
      content={
        <div className="max-h-80 overflow-y-auto p-1.5">
          <RelationTreeRow
            node={tree}
            currentSessionId={currentSessionId}
            onOpenSession={onOpenSession}
          />
        </div>
      }
    />
  );
}

/**
 * One row: the root Session, then its Tabs as equal pills beside it. Rows
 * opened from it hang below on a trunk whose ticks meet each row's centre.
 */
function RelationTreeRow({
  node,
  currentSessionId,
  onOpenSession,
}: {
  node: SessionRelationTreeNode;
  currentSessionId: SessionId;
  onOpenSession: (target: SessionNavigationTarget) => void;
}) {
  const rootId = node.session.id;
  return (
    <div>
      <div className="flex min-w-0 gap-1">
        <RelationPill
          session={node.session}
          target={{ sessionId: rootId }}
          isCurrent={rootId === currentSessionId}
          onOpenSession={onOpenSession}
        />
        {node.tabs.map((tab) => (
          <RelationPill
            key={tab.id}
            session={tab}
            target={{ sessionId: rootId, tabSessionId: tab.id }}
            isCurrent={tab.id === currentSessionId}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>
      {node.children.length > 0 ? (
        // The trunk sits under the parent row's agent icon.
        <div className="ml-[14px]">
          {node.children.map((child, index) => (
            <div key={child.session.id} className="relative pl-4 pt-1">
              <span
                aria-hidden="true"
                className={cn(
                  'absolute left-0 top-0 w-px bg-border',
                  index === node.children.length - 1 ? 'h-[18px]' : 'bottom-0'
                )}
              />
              <span aria-hidden="true" className="absolute left-0 top-[18px] h-px w-3 bg-border" />
              <RelationTreeRow
                node={child}
                currentSessionId={currentSessionId}
                onOpenSession={onOpenSession}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Agent icon, live title, and the same live status mark as the sidebar row. */
function RelationPill({
  session,
  target,
  isCurrent,
  onOpenSession,
}: {
  session: SessionMeta;
  target: SessionNavigationTarget;
  isCurrent: boolean;
  onOpenSession: (target: SessionNavigationTarget) => void;
}) {
  const { t } = useTranslation();
  const liveStatus = useAtomValue(sessionLiveStatusAtomFamily(session.id));
  const agentConfig = useAtomValue(getAgentMetaByIdAtomFamily(session.agentConfigId));
  const title = session.title?.trim() || t('sessions.untitled', 'Untitled session');
  return (
    <button
      type="button"
      title={title}
      aria-current={isCurrent ? 'page' : undefined}
      data-session-relation-row={session.id}
      onClick={() => onOpenSession(target)}
      className={cn(
        'flex h-7 min-w-0 flex-1 basis-0 items-center gap-2 rounded-md border px-2 text-left text-xs transition-colors',
        isCurrent
          ? 'border-foreground/15 bg-muted-foreground/10 font-medium'
          : 'border-border/60 hover:bg-muted-foreground/10'
      )}
    >
      <AgentIcon
        cliType={session.cliType}
        agentType={session.agentType}
        env={agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env}
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      {/* `waiting > working > unread`, tested in that order. */}
      <SessionRowStatusIndicator
        isWaitingPermission={liveStatus?.type === 'requestPermission'}
        isWorking={liveStatus != null}
        hasUnreadMessages={!isCurrent && sessionHasUnreadMessages(session)}
      />
    </button>
  );
}
