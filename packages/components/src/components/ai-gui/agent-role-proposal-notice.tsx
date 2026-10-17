import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { z } from 'zod';
import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, radius } from '@lody/ui/tokens/scales.stylex';
import {
  AgentRoleProposalMetaSchema,
  applyAgentRoleProposal,
  getServerNow,
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  readWorkspaceFlockRowsFromFlock,
  type AgentRoleProposalMeta,
  type SessionId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { writeWorkspaceAgentRole } from '@/lib/workspace-catalog-write';

const styles = stylex.create({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    padding: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.secondaryBackground,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
  },
  field: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  text: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 },
  before: { color: colors.secondaryLabel },
  actions: { display: 'flex', gap: space[2] },
  error: { color: colors.destructive },
});

export function AgentRoleProposalCard({
  meta,
  target,
  busy,
  disabled,
  error,
  onSave,
  onDismiss,
}: {
  meta: AgentRoleProposalMeta;
  target?: string;
  busy?: boolean;
  disabled?: boolean;
  error?: string;
  onSave: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const fields = meta.command.action === 'create' ? meta.command : meta.command.patch;
  const labels = {
    name: t('agentRoleProposal.name', 'Name'),
    description: t('agentRoleProposal.description', 'Description'),
    promptPrefix: t('agentRoleProposal.promptPrefix', 'Default instruction'),
  };
  return (
    <section {...stylex.props(styles.card)}>
      <strong>
        {meta.outcome === 'saved'
          ? t('agentRoleProposal.saved', 'Agent Role saved')
          : meta.outcome === 'dismissed'
            ? t('agentRoleProposal.dismissed', 'Proposal dismissed')
            : meta.command.action === 'create'
              ? t('agentRoleProposal.create', 'Create Agent Role?')
              : t('agentRoleProposal.update', 'Update Agent Role?')}
      </strong>
      {target ? <p {...stylex.props(styles.text)}>{target}</p> : null}
      {meta.command.action === 'create' ? (
        <p {...stylex.props(styles.text, styles.before)}>
          {t(
            'agentRoleProposal.defaults',
            'Private Role using this Agent’s default configuration.'
          )}
        </p>
      ) : null}
      {(Object.keys(labels) as (keyof typeof labels)[]).map((key) =>
        fields[key] === undefined ? null : (
          <div key={key} {...stylex.props(styles.field)}>
            <strong>{labels[key]}</strong>
            {meta.before ? (
              <div {...stylex.props(styles.before)}>
                <span>{t('agentRoleProposal.before', 'Before')}</span>
                <p {...stylex.props(styles.text)}>
                  {meta.before[key] || t('agentRoleProposal.empty', '(empty)')}
                </p>
              </div>
            ) : null}
            <div>
              {meta.before ? <span>{t('agentRoleProposal.after', 'After')}</span> : null}
              <p {...stylex.props(styles.text)}>
                {fields[key] || t('agentRoleProposal.empty', '(empty)')}
              </p>
            </div>
          </div>
        )
      )}
      {error ? (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      ) : null}
      {!meta.outcome ? (
        <>
          <p {...stylex.props(styles.text, styles.before)}>
            {t(
              'agentRoleProposal.scope',
              'Applies to future uses of this Role. Existing sessions keep their configuration.'
            )}
          </p>
          <div {...stylex.props(styles.actions)}>
            <Button
              size="small"
              variant="secondary"
              disabled={busy || disabled}
              onClick={onDismiss}
            >
              {t('agentRoleProposal.dismiss', 'Dismiss')}
            </Button>
            <Button size="small" variant="primary" disabled={busy || disabled} onClick={onSave}>
              {t('agentRoleProposal.save', 'Save')}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function AgentRoleProposalNotice({
  meta,
  sessionId,
  entryId,
  itemIndex,
}: {
  meta: AgentRoleProposalMeta;
  sessionId: SessionId;
  entryId: string;
  itemIndex: number;
}) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
  const targetMachineId = meta.command.action === 'create' ? meta.command.machineId : undefined;
  const targetMachineIds = useMemo(
    () => (targetMachineId ? [targetMachineId] : []),
    [targetMachineId]
  );
  useMachineFlockAgentConfigsForMachineIds(targetMachineIds);
  const agents = useAtomValue(getAllAgentConfigAtom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState(meta.outcome);
  const decide = async (decision: 'saved' | 'dismissed') => {
    if (!runtime || !user || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await runtime.withSessionStore(sessionId, async (store) => {
        const read = await store.sessionData.history.readTurn(entryId);
        if (read.state !== 'ready')
          throw new Error(t('agentRoleProposal.unavailable', 'Proposal is unavailable'));
        const item = z
          .object({
            type: z.literal('system_notice'),
            name: z.literal('agent_role_proposal'),
            meta: AgentRoleProposalMetaSchema,
          })
          .passthrough()
          .parse(read.turn.items?.[itemIndex]);
        const current = item.meta;
        if (current.requesterUserId !== user.id)
          throw new Error(
            t('agentRoleProposal.ownerOnly', 'Only the requesting user can confirm this proposal')
          );
        if (current.outcome) {
          setOutcome(current.outcome);
          return;
        }
        if (decision === 'saved') {
          const command = current.command;
          if (
            command.action === 'create' &&
            !agents.some(
              (agent) => agent.id === command.agentConfigId && agent.machineId === command.machineId
            )
          )
            throw new Error(
              t(
                'agentRoleProposal.targetUnavailable',
                'The selected Agent configuration is unavailable'
              )
            );
          const handle = await runtime.repo.openFlockDoc(
            getWorkspaceFlockDocId(runtime.workspaceId)
          );
          const roles = listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(handle.flock));
          const role = applyAgentRoleProposal(current, roles, user.id, getServerNow());
          await writeWorkspaceAgentRole(runtime, role);
        }
        const items = [...(read.turn.items ?? [])];
        items[itemIndex] = { ...item, meta: { ...current, outcome: decision } };
        await store.sessionData.commands.replaceTurn(entryId, { ...read.turn, items });
        setOutcome(decision);
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('agentRoleProposal.failed', 'Could not save the proposal')
      );
    } finally {
      setBusy(false);
    }
  };
  const command = meta.command;
  const target =
    command.action === 'create'
      ? `${agents.find((agent) => agent.id === command.agentConfigId)?.name ?? command.agentConfigId} · ${command.machineId}`
      : meta.before?.name;
  return (
    <AgentRoleProposalCard
      meta={{ ...meta, outcome: meta.outcome ?? outcome }}
      target={target}
      busy={busy}
      disabled={!runtime || user?.id !== meta.requesterUserId}
      error={error}
      onSave={() => void decide('saved')}
      onDismiss={() => void decide('dismissed')}
    />
  );
}
