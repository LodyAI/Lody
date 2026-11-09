import { useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { ScrollArea } from '@lody/ui/scroll-area';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { useSessionActions } from '@/hooks/use-session-actions';
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
import { useWorkingHandOver } from '@/ui/working-status-mark';
import { PopoverActionChip } from './info-chip';

const styles = stylex.create({
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    padding: space[2],
    flexWrap: 'wrap',
    borderBottom: `1px solid ${colors.separator}`,
  },
  label: { fontSize: text.footnoteSize, color: colors.secondaryLabel },
  confirmation: { display: 'flex', flexDirection: 'column', gap: space[3], maxWidth: 320 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space[2] },
  status: { padding: space[2], fontSize: text.footnoteSize, color: colors.secondaryLabel },
  error: { padding: space[2], fontSize: text.footnoteSize, color: colors.destructive },
  tree: { maxHeight: 320, overflowY: 'auto', padding: space[1.5] },
  scroll: { minWidth: 0, width: '100%' },
  hiddenTrack: { display: 'none' },
  row: { display: 'flex', gap: space[1], width: 'max-content', padding: space[0.5] },
  pill: { flex: '0 0 auto', maxWidth: '24ch' },
  title: { maxWidth: '16ch' },
  current: { backgroundColor: colors.selectedFill },
  fade: (left: string, right: string) => ({
    maskImage: `linear-gradient(to right, transparent, black ${left}, black calc(100% - ${right}), transparent)`,
  }),
});

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
  const { setTreeCollaborationStopped } = useSessionActions();
  const tree = useMemo(() => buildSessionRelationTree(sessions, sessionId), [sessions, sessionId]);
  return tree ? (
    <SessionRelationsChip
      key={tree.session.id}
      tree={tree}
      currentSessionId={sessionId}
      onOpenSession={onOpenSession}
      onSetCollaborationStopped={(stopped) => setTreeCollaborationStopped(tree.session.id, stopped)}
    />
  ) : null;
}

export function SessionRelationsChip({
  tree,
  currentSessionId,
  onOpenSession,
  defaultOpen,
  onSetCollaborationStopped,
}: {
  tree: SessionRelationTreeNode;
  currentSessionId: SessionId;
  onOpenSession: (target: SessionNavigationTarget) => void;
  /** Storybook/testing aid. */
  defaultOpen?: boolean;
  onSetCollaborationStopped?: (stopped: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stopped = tree.session.collaborationStopped === true;
  const apply = async (next: boolean) => {
    if (inFlight.current || !onSetCollaborationStopped) return;
    inFlight.current = true;
    setPending(true);
    setError(false);
    try {
      await onSetCollaborationStopped(next);
      setConfirmOpen(false);
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <PopoverActionChip
      icon={MessagesSquare}
      label={t('sessions.relations.label', 'Related sessions')}
      // Everything in the tree except the current Session.
      value={String(countSessionRelationTree(tree) - 1)}
      defaultOpen={defaultOpen}
      content={
        <div>
          <div {...stylex.props(styles.header)}>
            <span {...stylex.props(styles.label)}>
              {t('sessions.relations.label', 'Related sessions')}
            </span>
            {onSetCollaborationStopped ? (
              stopped ? (
                <Button
                  size="mini"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => void apply(false)}
                >
                  {t('sessions.relations.resumeCollaboration', 'Restore collaboration')}
                </Button>
              ) : (
                <Popover.Root
                  open={confirmOpen}
                  onOpenChange={(open) => {
                    if (!pending) setConfirmOpen(open);
                  }}
                >
                  <Popover.Trigger
                    render={<Button size="mini" variant="ghost" tone="destructive" />}
                  >
                    {t(
                      'sessions.relations.stopCollaboration',
                      'Stop all conversation collaboration'
                    )}
                  </Popover.Trigger>
                  <Popover.Content side="top" align="end" initialFocus={cancelRef}>
                    <div {...stylex.props(styles.confirmation)}>
                      <Popover.Title>
                        {t(
                          'sessions.relations.stopConfirmation',
                          'This will stop all conversations in the conversation tree.'
                        )}
                      </Popover.Title>
                      <Popover.Description>
                        {t(
                          'sessions.relations.stopDetails',
                          'Execution stays blocked until you restore collaboration. Offline machines stop after reconnecting.'
                        )}
                      </Popover.Description>
                      {error ? (
                        <p role="alert" {...stylex.props(styles.error)}>
                          {t(
                            'sessions.relations.controlFailed',
                            'Could not update the whole tree. Check the connection and update all machines, then retry.'
                          )}
                        </p>
                      ) : null}
                      <div {...stylex.props(styles.actions)}>
                        <Button
                          ref={cancelRef}
                          size="small"
                          variant="secondary"
                          disabled={pending}
                          onClick={() => setConfirmOpen(false)}
                        >
                          {t('sessions.relations.cancel', 'Cancel')}
                        </Button>
                        <Button
                          size="small"
                          variant="destructive"
                          disabled={pending}
                          onClick={() => void apply(true)}
                        >
                          {t('sessions.relations.confirm', 'Confirm')}
                        </Button>
                      </div>
                    </div>
                  </Popover.Content>
                </Popover.Root>
              )
            ) : null}
          </div>
          {stopped ? (
            <p role="status" {...stylex.props(styles.status)}>
              {t(
                'sessions.relations.stopped',
                'Collaboration stopped. Restore it here before continuing. Offline machines apply the stop after reconnecting.'
              )}
            </p>
          ) : null}
          {error && !confirmOpen ? (
            <p role="alert" {...stylex.props(styles.error)}>
              {t(
                'sessions.relations.controlFailed',
                'Could not update the whole tree. Check the connection and update all machines, then retry.'
              )}
            </p>
          ) : null}
          <div {...stylex.props(styles.tree)}>
            <RelationTreeRow
              node={tree}
              currentSessionId={currentSessionId}
              onOpenSession={onOpenSession}
            />
          </div>
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const update = () => {
      const offset = Math.abs(viewport.scrollLeft);
      const remaining = viewport.scrollWidth - viewport.clientWidth - offset;
      const rtl = getComputedStyle(viewport).direction === 'rtl';
      const next = {
        left: rtl ? remaining > 1 : offset > 1,
        right: rtl ? offset > 1 : remaining > 1,
      };
      setEdges((previous) =>
        previous.left === next.left && previous.right === next.right ? previous : next
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(content);
    viewport.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  const fadeProps = stylex.props(
    (edges.left || edges.right) &&
      styles.fade(edges.left ? '12px' : '0px', edges.right ? '12px' : '0px')
  );
  return (
    <div>
      <ScrollArea
        axis="horizontal"
        viewportRef={viewportRef}
        className={stylex.props(styles.scroll).className}
        viewportClassName={fadeProps.className}
        viewportStyle={fadeProps.style}
        scrollbarClassName={stylex.props(styles.hiddenTrack).className}
      >
        <div ref={contentRef} {...stylex.props(styles.row)}>
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
      </ScrollArea>
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
  const unread = !isCurrent && sessionHasUnreadMessages(session);
  const working = useWorkingHandOver(liveStatus != null, unread);
  return (
    <button
      type="button"
      title={title}
      aria-current={isCurrent ? 'page' : undefined}
      data-session-relation-row={session.id}
      onClick={() => onOpenSession(target)}
      className={cn(
        'flex h-7 min-w-0 items-center gap-2 rounded-md border border-border/60 px-2 text-left text-xs transition-colors',
        stylex.props(styles.pill, isCurrent && styles.current).className,
        !isCurrent && 'hover:bg-muted-foreground/10'
      )}
    >
      <AgentIcon
        cliType={session.cliType}
        agentType={session.agentType}
        env={agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env}
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-foreground',
          stylex.props(styles.title).className
        )}
      >
        {title}
      </span>
      {/* `waiting > working > unread`, tested in that order. */}
      <SessionRowStatusIndicator
        isWaitingPermission={liveStatus?.type === 'requestPermission'}
        isWorking={working}
        hasUnreadMessages={unread}
      />
    </button>
  );
}
