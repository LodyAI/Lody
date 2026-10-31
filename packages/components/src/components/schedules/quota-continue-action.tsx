import { useLocalSessionContinuation } from '@/components/sessions/use-local-session-continuation';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { getAutomationProofIssuer } from '@/lib/cloud-http-port';
import { workspaceSupports } from '@lody/shared/workspace-streams-content';
import { memo, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Check, Clock, Loader2 } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import {
  getDeviceTimeZone,
  getServerNow,
  machineSupportsScheduledMessagesProtocol,
  type SessionMeta,
} from '@lody/shared';
import { currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useWorkspaceFeature } from '@/hooks/use-workspace-feature';
import { useResolvedMachineMeta } from '@/hooks/use-resolved-machine-meta';
import { useProviderQuotaRefresh } from '@/hooks/use-provider-quota-refresh';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { useConversationTail } from '@/hooks/use-conversation-view';
import { useSchedules } from '@/hooks/use-schedules';
import { toast } from '@/lib/toast';
import { formatClockWithZone } from './schedule-format';
import {
  findClaudeSessionLimit,
  quotaContinueDraft,
  quotaContinueIdentity,
  legacyQuotaContinueId,
  quotaContinueReset,
  quotaContinueSendAt,
} from './quota-continue';
import { saveScheduledMessage } from './scheduled-message-write';

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

/**
 * The action lives inside the terminal session-limit banner, so the failure and
 * its one-click recovery share one card. All quota/history subscriptions stay
 * in this leaf; the conversation tree does not re-render on quota refreshes.
 */
export const SessionLimitContinueAction = memo(function SessionLimitContinueAction({
  session,
  entryId,
}: {
  session: SessionMeta;
  entryId: string;
}) {
  const allowed = useWorkspaceFeature('schedules');
  if (!allowed || session.agentType !== 'claude' || session.isArchived) return null;
  return <SessionLimitContinueOwner key={session.id} session={session} entryId={entryId} />;
});

function SessionLimitContinueOwner({
  session,
  entryId,
}: {
  session: SessionMeta;
  entryId: string;
}) {
  const { t, i18n } = useTranslation();
  const user = useAtomValue(userAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const active = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime = scope.enabled && scope.workspaceId === active?.workspaceId ? active : null;
  const slug = useAtomValue(currentWorkspaceSlugAtom);
  const navigate = useNavigate();
  const { machine } = useResolvedMachineMeta(session.machineId);
  // The banner is only rendered while its turn is in the stream's window; the
  // leaf unmounts with it and releases the acquired tail range.
  const { history } = useSessionDoc(session.id);
  const { turns } = useConversationTail(history, { extendToLastUserTurn: true });
  const failure = findClaudeSessionLimit(turns);
  const isThisFailure = failure?.noticeId === entryId;
  const local = !!localMachineId && session.machineId === localMachineId;
  const continuation = useLocalSessionContinuation(
    runtime && session.machineId && user?.id === session.userId &&
      workspaceSupports({ mode: runtime.contentMode === 'e2ee' ? 'protected' : 'plaintext' }, 'automations') &&
      (local || (!!localMachineId && !!getAutomationProofIssuer()))
      ? { workspaceId: runtime.workspaceId, machineId: session.machineId, sessionId: session.id,
          ...(!local ? { remote: { runtime, requesterUserId: user.id } } : {}) }
      : null,
    isThisFailure
  );
  useProviderQuotaRefresh(
    session.machineId,
    session.agentConfigId,
    isThisFailure &&
      machine?.acpCapabilities?.[session.agentConfigId ?? '']?.rateLimits?.query === true
  );
  const registry = useSchedules();
  const reset =
    failure && isThisFailure
      ? quotaContinueReset({
          failure,
          session,
          rateLimits: machine?.raceLimits,
          now: getServerNow(),
        })
      : null;
  const sendAt = reset === null ? null : quotaContinueSendAt(reset);
  const identity =
    runtime && reset && failure
      ? quotaContinueIdentity(runtime.workspaceId, session.id, reset, failure.user.id)
      : null;
  const key = `${runtime?.accountId}:${runtime?.workspaceId}:${user?.id}:${identity?.scheduleId}`;
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const owner = useRef<object | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const token = {};
    owner.current = token;
    return () => {
      if (owner.current === token) owner.current = null;
    };
  }, [key, runtime]);
  if (
    !runtime ||
    !user ||
    !machine ||
    !failure ||
    !isThisFailure ||
    reset === null ||
    sendAt === null ||
    !identity ||
    !registry.ready ||
    registry.error ||
    session.userId !== user.id ||
    machine.ownerUserId !== user.id ||
    !machineSupportsScheduledMessagesProtocol(machine)
  )
    return null;
  const exists =
    saved === key || registry.rows.some((row) => row.scheduleId === identity.scheduleId);
  const legacyId = legacyQuotaContinueId(runtime.workspaceId, session.id, reset);
  const legacyV2Id = legacyQuotaContinueId(runtime.workspaceId, session.id, reset, 2);
  const existingId = registry.rows.some((row) => row.scheduleId === legacyId)
    ? legacyId
    : registry.rows.some((row) => row.scheduleId === legacyV2Id)
      ? legacyV2Id
      : exists
        ? identity.scheduleId
        : null;
  const hasReservation = !!existingId;
  if (continuation.recoveryEnabled && !hasReservation) return null;
  const timeLabel = formatClockWithZone(
    sendAt,
    machine.timeZone ?? getDeviceTimeZone(),
    i18n.language
  );
  const open = () => {
    if (slug)
      void navigate({
        to: '/$workspaceName/schedules/$scheduleId',
        params: { workspaceName: slug, scheduleId: existingId ?? identity.scheduleId },
      });
  };
  const save = async () => {
    if (inFlight.current || !owner.current) return;
    // The reset or failed turn may have changed while this control was visible.
    const current = findClaudeSessionLimit(turns);
    const currentReset =
      current && current.noticeId === entryId
        ? quotaContinueReset({
            failure: current,
            session,
            rateLimits: machine.raceLimits,
            now: getServerNow(),
          })
        : null;
    if (!current || currentReset !== reset) {
      toast.error(t('scheduledMessage.futureTime'));
      return;
    }
    const token = owner.current;
    inFlight.current = true;
    setPending(key);
    try {
      await saveScheduledMessage({
        runtime,
        actorId: user.id,
        ...identity,
        create: true,
        draft: quotaContinueDraft(session, current.user, sendAt, t('scheduledMessage.quotaTitle')),
      });
      if (owner.current === token) {
        setSaved(key);
        toast.success(t('scheduledMessage.saved'));
      }
    } catch {
      if (owner.current === token) toast.error(t('scheduledMessage.saveError'));
    } finally {
      inFlight.current = false;
      if (owner.current === token) setPending(null);
    }
  };
  return (
    <SessionLimitContinueRow
      state={hasReservation ? 'scheduled' : pending === key ? 'pending' : 'idle'}
      timeLabel={timeLabel}
      onSchedule={() => void save()}
      onOpen={open}
    />
  );
}

export function SessionLimitContinueRow({
  state,
  timeLabel,
  onSchedule,
  onOpen,
}: {
  state: 'idle' | 'pending' | 'scheduled';
  timeLabel: string;
  onSchedule: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const scheduled = state === 'scheduled';
  const pending = state === 'pending';
  return (
    <div {...stylex.props(styles.row)}>
      {scheduled ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : pending ? (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
      ) : (
        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span {...stylex.props(styles.copy)}>
        {scheduled
          ? t('scheduledMessage.quotaScheduled', { time: timeLabel })
          : t('scheduledMessage.quotaSchedule', { time: timeLabel })}
      </span>
      {scheduled ? (
        <Button variant="ghost" size="small" onClick={onOpen}>
          {t('common.view')}
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="small"
          shape="pill"
          disabled={pending}
          onClick={onSchedule}
        >
          {pending ? t('schedules.saving') : t('scheduledMessage.quotaScheduleAction')}
        </Button>
      )}
    </div>
  );
}
