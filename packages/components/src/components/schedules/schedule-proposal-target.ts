import type { AgentRunRef } from '@/components/shared/agent-run-ref';
import {
  getBuiltinDefaultModeId,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type ProjectRef,
  type ScheduleDestination,
  type ScheduleProposalMeta,
  type SessionMeta,
} from '@lody/shared';

/** What the conversation the proposal came from was running with. */
export type ProposalConversation = {
  session: SessionMeta;
  /** Effective run config of the conversation's latest user turn. */
  runConfig: { modeId?: string; modelId?: string; configOptionValues?: Record<string, string> };
};

export type ResolvedProposalTarget = {
  agent: AgentRunRef;
  agentConfig: AgentConfigMeta;
  project: ProjectRef | null;
  destination: ScheduleDestination;
  /** Where each value came from, for the card to say so. */
  source: { agent: 'conversation' | 'role' | 'named'; project: 'conversation' | 'named' | 'none' };
  role?: AgentRole;
};

export type ProposalTargetProblem =
  | 'role_not_found'
  | 'agent_not_found'
  | 'machine_mismatch'
  | 'no_agent';

/**
 * Turn a proposal's optional `target` into the concrete configuration a
 * schedule needs.
 *
 * The rule is the one the person agreed to: everything defaults to the
 * conversation the proposal was made in — the Agent, its permission mode, its
 * machine, its project — and a named Role, Agent, machine or project overrides
 * only that part. A Role brings its own pinned run config, so it also replaces
 * the mode. An Agent named without a Role gets the conversation's mode when it
 * is the same Agent, otherwise Lody's builtin default for that Agent; never an
 * elevated mode the person did not choose somewhere.
 */
export function resolveScheduleProposalTarget(args: {
  meta: ScheduleProposalMeta;
  conversation: ProposalConversation | null;
  agents: readonly AgentConfigMeta[];
  roles: readonly AgentRole[];
}): { ok: true; target: ResolvedProposalTarget } | { ok: false; problem: ProposalTargetProblem } {
  const { meta, conversation, agents, roles } = args;
  const named = meta.target ?? {};

  let role: AgentRole | undefined;
  if (named.agentRoleId) {
    role = roles.find((entry) => entry.id === named.agentRoleId);
    if (!role) return { ok: false, problem: 'role_not_found' };
  }

  const agentConfigId =
    role?.agentConfigId ?? named.agentConfigId ?? conversation?.session.agentConfigId;
  if (!agentConfigId) return { ok: false, problem: 'no_agent' };
  const agentConfig = agents.find((entry) => entry.id === agentConfigId);
  if (!agentConfig) return { ok: false, problem: 'agent_not_found' };

  // A named machine is a constraint, not a lookup key: the Agent decides the
  // machine, so naming a different one is a contradiction to surface.
  const machineId = named.machineId ?? role?.machineId;
  if (machineId && machineId !== agentConfig.machineId)
    return { ok: false, problem: 'machine_mismatch' };

  const sameAgentAsConversation = conversation?.session.agentConfigId === agentConfig.id;
  const runConfig = role
    ? {
        modeId: role.runConfig.modeId,
        modelId: role.runConfig.modelId,
        configOptionValues: role.runConfig.configOptionValues
          ? Object.fromEntries(
              Object.entries(role.runConfig.configOptionValues).map(([key, value]) => [
                key,
                String(value),
              ])
            )
          : undefined,
      }
    : sameAgentAsConversation
      ? (conversation?.runConfig ?? {})
      : { modeId: getBuiltinDefaultModeId(agentConfig.cliType, agentConfig.agentType) };

  const agent: AgentRunRef = {
    agentConfigId: agentConfig.id as AgentConfigId,
    ...(runConfig.modeId ? { modeId: runConfig.modeId } : {}),
    ...(runConfig.modelId ? { modelId: runConfig.modelId } : {}),
    ...(runConfig.configOptionValues && Object.keys(runConfig.configOptionValues).length
      ? { configOptionValues: runConfig.configOptionValues }
      : {}),
  };

  const destination: ScheduleDestination =
    meta.destination?.kind === 'own_session'
      ? { kind: 'own_session', epoch: 0 }
      : meta.destination?.kind === 'existing_session'
        ? { kind: 'existing_session', sessionId: meta.destination.sessionId }
        : { kind: 'new_session' };

  // A shared chat carries its own workspace; only a fresh chat takes a project.
  const conversationProject =
    conversation?.session.project ??
    (conversation?.session.repoFullName
      ? ({
          kind: 'github',
          repoFullName: conversation.session.repoFullName,
          branch: conversation.session.baseBranch ?? 'main',
        } satisfies ProjectRef)
      : undefined);
  const project =
    destination.kind !== 'new_session' ? null : (named.project ?? conversationProject ?? null);

  return {
    ok: true,
    target: {
      agent,
      agentConfig,
      project,
      destination,
      role,
      source: {
        agent: role ? 'role' : named.agentConfigId ? 'named' : 'conversation',
        project:
          destination.kind !== 'new_session' || !project
            ? 'none'
            : named.project
              ? 'named'
              : 'conversation',
      },
    },
  };
}
