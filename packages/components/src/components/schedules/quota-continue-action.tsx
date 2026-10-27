import { memo, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Clock } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
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
import {
  findClaudeSessionLimit,
  quotaContinueDraft,
  quotaContinueIdentity,
  quotaContinueReset,
} from './quota-continue';
import { saveScheduledMessage } from './scheduled-message-write';

const styles = stylex.create({
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    paddingBottom: space[2],
    minWidth: 0,
  },
});

/** The quota and tail subscriptions stay outside the composer and conversation tree. */
export const QuotaContinueAction = memo(function QuotaContinueAction({
  session,
  visible,
}: {
  session: SessionMeta;
  visible: boolean;
}) {
  const allowed = useWorkspaceFeature('schedules');
  if (!allowed || session.agentType !== 'claude' || session.isArchived) return null;
  return <QuotaContinueOwner key={session.id} session={session} visible={visible} />;
});

function QuotaContinueOwner({ session, visible }: { session: SessionMeta; visible: boolean }) {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const active = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime = scope.enabled && scope.workspaceId === active?.workspaceId ? active : null;
  const slug = useAtomValue(currentWorkspaceSlugAtom);
  const navigate = useNavigate();
  const { machine } = useResolvedMachineMeta(session.machineId);
  const { history } = useSessionDoc(session.id, { enabled: visible });
  const { turns } = useConversationTail(history, { extendToLastUserTurn: true });
  const failure = findClaudeSessionLimit(turns);
  useProviderQuotaRefresh(
    session.machineId,
    session.agentConfigId,
    visible &&
      !!failure &&
      machine?.acpCapabilities?.[session.agentConfigId ?? '']?.rateLimits?.query === true
  );
  const registry = useSchedules();
  const reset = failure
    ? quotaContinueReset({ failure, session, rateLimits: machine?.raceLimits, now: getServerNow() })
    : null;
  const identity =
    runtime && reset ? quotaContinueIdentity(runtime.workspaceId, session.id, reset) : null;
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
    !visible ||
    !runtime ||
    !user ||
    !machine ||
    !failure ||
    !reset ||
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
  const open = () => {
    if (slug)
      void navigate({
        to: '/$workspaceName/schedules/$scheduleId',
        params: { workspaceName: slug, scheduleId: identity.scheduleId },
      });
  };
  const save = async () => {
    if (inFlight.current || !owner.current) return;
    // The reset or failed turn may have changed while this control was visible.
    const current = findClaudeSessionLimit(turns);
    if (
      !current ||
      quotaContinueReset({
        failure: current,
        session,
        rateLimits: machine.raceLimits,
        now: getServerNow(),
      }) !== reset
    ) {
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
        draft: quotaContinueDraft(session, failure.user, reset, t('scheduledMessage.quotaTitle')),
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
    <QuotaContinueView
      saved={exists}
      pending={pending === key}
      onClick={exists ? open : () => void save()}
    />
  );
}

export function QuotaContinueView({
  saved,
  pending,
  onClick,
}: {
  saved: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.row)}>
      <Button size="small" variant="ghost" disabled={pending} onClick={onClick}>
        <Clock size={14} aria-hidden="true" />
        {pending
          ? t('schedules.saving')
          : saved
            ? t('scheduledMessage.quotaView')
            : t('scheduledMessage.quotaContinue')}
      </Button>
    </div>
  );
}
