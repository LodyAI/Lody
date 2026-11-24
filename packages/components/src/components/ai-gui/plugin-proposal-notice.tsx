import { localProbeResultAtom } from '@/atoms/local-probe';
import { useContext, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import type { MachineId, SessionId } from '@lody/shared';
import type { PluginProposalMeta } from '@lody/shared/plugins/proposal';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import { useOnlineMachines } from '@/hooks/use-online-machines';
import { useWorkspaceClientPlugins } from '../../plugins/client-host-provider';
import { SessionReadonlyContext } from './session-readonly-context';
import { PluginProposalCard, type PluginReview } from './plugin-proposal-card';
const unsub = () => () => {},
  zero = () => 0;
export function PluginProposalNotice({
  meta,
  sessionId,
  entryId,
}: {
  meta: PluginProposalMeta;
  sessionId: SessionId;
  entryId: string;
}) {
  const readOnly = useContext(SessionReadonlyContext);
  const review: PluginReview = {
    requestId: meta.command.requestId,
    action: meta.command.action.replace('propose_', '') as PluginReview['action'],
    source: meta.command.packagePath,
    pluginId: meta.artifact.pluginId,
    digest: meta.artifact.sha256,
    version: meta.artifact.version,
    machineId: meta.machineId,
    workspaceId: meta.workspaceId,
    sessionId: meta.sessionId,
    expiresAt: meta.expiresAt,
    capabilities: meta.artifact.requestedCapabilities,
    status: meta.status,
  };
  if (
    readOnly ||
    meta.sessionId !== sessionId ||
    entryId !== `plugin-proposal-${meta.command.requestId}`
  )
    return <PluginProposalCard review={review} />;
  return <LiveProposal review={review} meta={meta} />;
}
function LiveProposal({ review, meta }: { review: PluginReview; meta: PluginProposalMeta }) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const probe = useAtomValue(localProbeResultAtom);
  const account = useWorkspaceLocalAccountId();
  const machines = useOnlineMachines();
  const owner = useWorkspaceClientPlugins();
  useSyncExternalStore(owner?.subscribe ?? unsub, owner?.snapshot ?? zero, zero);
  const installed =
    owner?.workspaceId === meta.workspaceId
      ? owner
          .installations()
          .find((i) => i.dev.machineId === meta.machineId && i.pluginId === meta.artifact.pluginId)
      : undefined;
  const m = installed?.dev.manifest;
  const previous = m
    ? [
        ...(m.machine ? ['machine'] : []),
        ...(m.client ? ['client'] : []),
        ...(
          ['skills', 'agentRoles', 'mcpServers', 'acpProviders', 'themes', 'styles'] as const
        ).filter((k) => m[k]?.length),
        ...(Object.values(m.config ?? {}).some((f) => f.type === 'secret') ? ['secrets'] : []),
      ]
    : undefined;
  const allowed =
    runtime?.workspaceId === meta.workspaceId &&
    probe?.ok &&
    probe.machineId === meta.machineId &&
    (!probe.workspaceId || probe.workspaceId === meta.workspaceId) &&
    !!account &&
    machines.some((m) => m.id === meta.machineId && m.ownerUserId === account);

  return (
    <PluginProposalCard
      review={{
        ...review,
        added: previous && review.capabilities.filter((c) => !previous.includes(c)),
        removed: previous?.filter((c) => !review.capabilities.includes(c)),
      }}
      decide={
        allowed
          ? async (decision) => {
              const result = await runtime.requestPlugin(
                meta.machineId as MachineId,
                {
                  method: 'plugin/proposal-decision',
                  params: {
                    sessionId: meta.sessionId,
                    requestId: meta.command.requestId,
                    sha256: meta.artifact.sha256,
                    decision: decision === 'approved' ? 'approve' : 'deny',
                  },
                },
                { requireLocal: true }
              );
              if (result.type !== 'plugin/proposal-decision')
                throw Error('Unexpected proposal response');
              return result.status;
            }
          : undefined
      }
    />
  );
}
