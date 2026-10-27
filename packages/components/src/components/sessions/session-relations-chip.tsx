import { useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
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
import { useWorkingHandOver } from '@/ui/working-status-mark';
import { PopoverActionChip } from './info-chip';

const styles = stylex.create({
  relationRow: { display: 'flex', minWidth: 0, gap: themeSpace[1] },
  children: { marginLeft: '14px' },
  child: { position: 'relative', paddingLeft: themeSpace[4], paddingTop: themeSpace[1] },
  trunk: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '1px',
    backgroundColor: themeColors.border,
  },
  trunkEnd: { height: '18px' },
  trunkContinued: { bottom: 0 },
  branch: {
    position: 'absolute',
    left: 0,
    top: '18px',
    height: '1px',
    width: themeSpace[3],
    backgroundColor: themeColors.border,
  },
  pill: {
    display: 'flex',
    height: themeSpace[7],
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: themeSpace[0],
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    paddingInline: themeSpace[2],
    textAlign: 'left',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  current: {
    borderColor: 'hsl(var(--foreground) / 0.15)',
    backgroundColor: 'hsl(var(--muted-foreground) / 0.1)',
    fontWeight: themeFontWeight.medium,
  },
  other: {
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: { default: null, ':hover': 'hsl(var(--muted-foreground) / 0.1)' },
  },
  agent: {
    height: themeSpace[3.5],
    width: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  title: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: themeColors.foreground,
  },
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
  return (
    <div>
      <div {...stylex.props(styles.relationRow)}>
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
        <div {...stylex.props(styles.children)}>
          {node.children.map((child, index) => (
            <div key={child.session.id} {...stylex.props(styles.child)}>
              <span
                aria-hidden="true"
                {...stylex.props(
                  styles.trunk,
                  index === node.children.length - 1 ? styles.trunkEnd : styles.trunkContinued
                )}
              />
              <span aria-hidden="true" {...stylex.props(styles.branch)} />
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
      {...stylex.props(styles.pill, isCurrent ? styles.current : styles.other)}
    >
      <AgentIcon
        cliType={session.cliType}
        agentType={session.agentType}
        env={agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env}
        {...stylex.props(styles.agent)}
      />
      <span {...stylex.props(styles.title)}>{title}</span>
      {/* `waiting > working > unread`, tested in that order. */}
      <SessionRowStatusIndicator
        isWaitingPermission={liveStatus?.type === 'requestPermission'}
        isWorking={working}
        hasUnreadMessages={unread}
      />
    </button>
  );
}
