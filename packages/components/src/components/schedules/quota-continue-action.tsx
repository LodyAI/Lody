import { memo } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { BatteryCharging, Check, Loader2 } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { workspaceSupports } from '@lody/shared/workspace-streams-content';
import type { SessionMeta } from '@lody/shared';
import { userAtom } from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { useConversationTail } from '@/hooks/use-conversation-view';
import { getAutomationProofIssuer } from '@/lib/cloud-http-port';
import { useLocalSessionContinuation } from '@/components/sessions/use-local-session-continuation';
import { findClaudeSessionLimit } from './quota-continue';

const styles = stylex.create({
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[3],
    rowGap: space[2],
    paddingTop: space[2],
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    minWidth: 0,
  },
  copy: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.bodyLeading,
    color: colors.label,
    overflowWrap: 'anywhere',
  },
});

export const SessionLimitContinueAction = memo(function SessionLimitContinueAction({
  session,
  entryId,
}: {
  session: SessionMeta;
  entryId: string;
}) {
  if (session.agentType !== 'claude' || session.isArchived) return null;
  return <SessionLimitContinueOwner key={session.id} session={session} entryId={entryId} />;
});

function SessionLimitContinueOwner({
  session,
  entryId,
}: {
  session: SessionMeta;
  entryId: string;
}) {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const active = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime = scope.enabled && scope.workspaceId === active?.workspaceId ? active : null;
  const { history } = useSessionDoc(session.id);
  const { turns } = useConversationTail(history, { extendToLastUserTurn: true });
  const failure = findClaudeSessionLimit(turns);
  const current = failure?.noticeId === entryId;
  const local = !!localMachineId && session.machineId === localMachineId;
  const target =
    runtime &&
    session.machineId &&
    user?.id === session.userId &&
    workspaceSupports(
      { mode: runtime.contentMode === 'e2ee' ? 'protected' : 'plaintext' },
      'automations'
    ) &&
    (local || (!!localMachineId && !!getAutomationProofIssuer()))
      ? {
          workspaceId: runtime.workspaceId,
          machineId: session.machineId,
          sessionId: session.id,
          ...(!local ? { remote: { runtime, requesterUserId: user.id } } : {}),
        }
      : null;
  const continuation = useLocalSessionContinuation(target, current);
  if (current && target && continuation.error)
    return <div {...stylex.props(styles.row)}>{t('sessions.continuation.connectionError')}</div>;
  if (!current || !target || continuation.recoveryEnabled === null) return null;
  return (
    <SessionLimitContinueRow
      state={continuation.busy ? 'pending' : continuation.recoveryEnabled ? 'enabled' : 'idle'}
      onEnable={() => continuation.setTweak('recoverCapacity', true)}
    />
  );
}

export function SessionLimitContinueRow({
  state,
  onEnable,
}: {
  state: 'idle' | 'pending' | 'enabled';
  onEnable: () => void;
}) {
  const { t } = useTranslation();
  const enabled = state === 'enabled';
  const Icon = enabled ? Check : state === 'pending' ? Loader2 : BatteryCharging;
  return (
    <div {...stylex.props(styles.row)}>
      <Icon size={14} aria-hidden="true" />
      <span {...stylex.props(styles.copy)}>
        {enabled
          ? t(
              'sessions.continuation.failureEnabled',
              'Automatic capacity recovery is enabled for this session.'
            )
          : t(
              'sessions.continuation.failureOffer',
              'Automatically continue this session after capacity recovers.'
            )}
      </span>
      {!enabled && (
        <Button
          variant="secondary"
          size="small"
          shape="pill"
          disabled={state === 'pending'}
          onClick={onEnable}
        >
          {t('sessions.continuation.failureEnable', 'Enable automatic recovery')}
        </Button>
      )}
    </div>
  );
}
