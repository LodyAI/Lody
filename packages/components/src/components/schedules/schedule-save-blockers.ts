import type { AgentRunRef } from '@/components/shared/agent-run-ref';
import type { TFunction } from 'i18next';
import {
  getAcpCapabilityCacheKey,
  getStaticBuiltinAcpCapabilities,
  hasExplicitSchedulePermission,
  machineSupportsSchedulesProtocol,
  type AgentConfigMeta,
  type MachineLegacyMetaFields,
  type MachineMeta,
  type ProjectRef,
  type ScheduleDestination,
} from '@lody/shared';

export type ScheduleSaveContext = {
  /** Read-only reason from the container (not owner / machine too old). */
  disabledReason?: string;
  workspaceReady: boolean;
  userId?: string;
  agent: AgentRunRef | null;
  agentConfig: AgentConfigMeta | null | undefined;
  machine: (MachineMeta & MachineLegacyMetaFields) | undefined;
  /** `null` is a deliberate chat-only schedule, not an unfinished form. */
  project: ProjectRef | null;
  /** Local projects available on the agent's machine. */
  machineLocalProjectIds: ReadonlySet<string>;
  destination: ScheduleDestination;
  /**
   * The chat runs will be appended to, once it exists: a picked chat, or an
   * owned chat after its first run. Its Agent and machine are then fixed.
   */
  destinationSession?: { agentConfigId: string; machineId: string } | null;
};

/**
 * Every reason this schedule cannot be saved, in the order a person would fix
 * them. One list drives the Save button, the visible explanation and the
 * submission guard, so the three can never disagree.
 *
 * Project is deliberately absent: a schedule with no project runs as a plain
 * chat. Only a project that IS chosen has to exist on the target machine.
 */
export function collectScheduleSaveBlockers(context: ScheduleSaveContext, t: TFunction): string[] {
  const blockers: string[] = [];
  if (context.disabledReason) blockers.push(context.disabledReason);
  if (!context.workspaceReady || !context.userId)
    blockers.push(
      t('schedules.workspaceNotReady', 'Wait for your workspace and account to finish loading.')
    );
  const { agent, agentConfig, machine } = context;
  if (!agentConfig || !agent) {
    blockers.push(t('schedules.requireAgent', 'Choose an available Agent.'));
  } else {
    if (!context.disabledReason) {
      if (!machine)
        blockers.push(
          t(
            'schedules.machineMissing',
            'The selected machine is unavailable. Start Lody on it and wait for it to sync, or choose another Agent.'
          )
        );
      else if (context.userId && machine.ownerUserId !== context.userId)
        blockers.push(t('schedules.requireOwnedMachine', 'Choose an Agent on a machine you own.'));
      else if (!machineSupportsSchedulesProtocol(machine))
        blockers.push(t('schedules.upgrade', 'Update the target machine’s CLI to edit schedules.'));
    }
    if (
      !hasExplicitSchedulePermission(
        agent,
        machine?.acpCapabilities?.[getAcpCapabilityCacheKey(agentConfig.id)] ??
          getStaticBuiltinAcpCapabilities(
            agentConfig.cliType,
            agentConfig.agentType,
            agentConfig.runtimeOverrides
          )
      )
    )
      blockers.push(t('schedules.choosePermission', 'Choose an explicit permission mode.'));
  }
  if (
    context.project?.kind === 'local' &&
    agentConfig &&
    !context.machineLocalProjectIds.has(context.project.localProjectId)
  )
    blockers.push(t('schedules.projectMachine', 'Choose a Project on the selected machine.'));
  if (context.destination.kind === 'existing_session' && !context.destination.sessionId)
    blockers.push(t('schedules.destination.requireChat', 'Choose a chat to send runs into.'));
  // A shared chat already has an Agent on a machine; the CLI refuses to append
  // a turn driven by any other. Say so here rather than at dispatch time.
  const session = context.destinationSession;
  if (session && agentConfig && agentConfig.id !== session.agentConfigId)
    blockers.push(
      t('schedules.destination.agentMismatch', 'Use the Agent this chat already runs with.')
    );
  if (session && agentConfig && agentConfig.machineId !== session.machineId)
    blockers.push(
      t('schedules.destination.machineMismatch', 'The chat lives on a different machine.')
    );
  return blockers;
}
