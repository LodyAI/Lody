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

/** Where a save blocker is shown: next to the control that fixes it. */
export type ScheduleIssueField = 'form' | 'machine' | 'agent' | 'project' | 'destination';

export type ScheduleSaveIssue = {
  field: ScheduleIssueField;
  /**
   * `missing` is an unfinished form (nothing chosen yet) and is only marked
   * once the person tries to save; `invalid` is a real conflict and is marked
   * at once.
   */
  kind: 'missing' | 'invalid';
  message: string;
};

/**
 * Every reason this schedule cannot be saved, in the order a person would fix
 * them, each tagged with the control that fixes it. One list drives the field
 * markers, the Save guard and the proposal card, so they can never disagree.
 *
 * Project is deliberately absent: a schedule with no project runs as a plain
 * chat. Only a project that IS chosen has to exist on the target machine.
 */
export function collectScheduleSaveIssues(
  context: ScheduleSaveContext,
  t: TFunction
): ScheduleSaveIssue[] {
  const issues: ScheduleSaveIssue[] = [];
  const push = (field: ScheduleIssueField, kind: ScheduleSaveIssue['kind'], message: string) =>
    issues.push({ field, kind, message });
  if (context.disabledReason) push('form', 'invalid', context.disabledReason);
  if (!context.workspaceReady || !context.userId)
    push(
      'form',
      'invalid',
      t('schedules.workspaceNotReady', 'Wait for your workspace and account to finish loading.')
    );
  const { agent, agentConfig, machine } = context;
  if (!agentConfig || !agent) {
    push('agent', 'missing', t('schedules.requireAgent', 'Choose an available Agent.'));
  } else {
    if (!context.disabledReason) {
      if (!machine)
        push(
          'machine',
          'invalid',
          t(
            'schedules.machineMissing',
            'The selected machine is unavailable. Start Lody on it and wait for it to sync, or choose another Agent.'
          )
        );
      else if (context.userId && machine.ownerUserId !== context.userId)
        push(
          'machine',
          'invalid',
          t('schedules.requireOwnedMachine', 'Choose an Agent on a machine you own.')
        );
      else if (!machineSupportsSchedulesProtocol(machine))
        push(
          'machine',
          'invalid',
          t('schedules.upgrade', 'Update the target machine’s CLI to edit schedules.')
        );
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
      push(
        'agent',
        'invalid',
        t('schedules.choosePermission', 'Choose an explicit permission mode.')
      );
  }
  if (
    context.project?.kind === 'local' &&
    agentConfig &&
    !context.machineLocalProjectIds.has(context.project.localProjectId)
  )
    push(
      'project',
      'invalid',
      t('schedules.projectMachine', 'Choose a Project on the selected machine.')
    );
  if (context.destination.kind === 'existing_session' && !context.destination.sessionId)
    push(
      'destination',
      'missing',
      t('schedules.destination.requireChat', 'Choose a chat to send runs into.')
    );
  // A shared chat already has an Agent on a machine; the CLI refuses to append
  // a turn driven by any other. Say so here rather than at dispatch time.
  const session = context.destinationSession;
  if (session && agentConfig && agentConfig.id !== session.agentConfigId)
    push(
      'agent',
      'invalid',
      t('schedules.destination.agentMismatch', 'Use the Agent this chat already runs with.')
    );
  if (session && agentConfig && agentConfig.machineId !== session.machineId)
    push(
      'destination',
      'invalid',
      t('schedules.destination.machineMismatch', 'The chat lives on a different machine.')
    );
  return issues;
}

/** The same rule as plain messages, for surfaces with one list of reasons. */
export function collectScheduleSaveBlockers(context: ScheduleSaveContext, t: TFunction): string[] {
  return collectScheduleSaveIssues(context, t).map((issue) => issue.message);
}
