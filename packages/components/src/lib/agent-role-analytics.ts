import type { AgentRole, MachineId, MessageTextSpan } from '@lody/shared';
import { capturePostHogEvent, type PostHogAnalyticsClient } from '@/lib/posthog-analytics';

export type AgentRoleAppliedSource = 'new_chat' | 'existing_session' | 'mention';

/**
 * One `agent_role/applied` per Role that actually shapes a run. Never sends the
 * Role's name, prompt, or ids: only where it was applied, its visibility, and
 * whether it runs on a machine other than the one the user is working on.
 */
export function captureAgentRoleApplied(
  postHog: PostHogAnalyticsClient | null | undefined,
  role: Pick<AgentRole, 'visibility'>,
  props: { source: AgentRoleAppliedSource; crossMachine: boolean | null }
): void {
  capturePostHogEvent(postHog, 'agent_role/applied', {
    source: props.source,
    cross_machine: props.crossMachine,
    visibility: role.visibility,
  });
}

/**
 * Role mentions in an ACCEPTED message. The spans are the ones frozen at send
 * time, and only an available Role becomes an `agent_role` span, so each one is
 * an actual invocation rather than a draft chip.
 */
export function captureAgentRoleMentionsApplied(
  postHog: PostHogAnalyticsClient | null | undefined,
  input: {
    spans: readonly MessageTextSpan[] | undefined;
    roles: readonly Pick<AgentRole, 'id' | 'machineId' | 'visibility'>[];
    /** Machine the sending conversation runs on; null when not known. */
    executionMachineId: MachineId | null | undefined;
  }
): void {
  for (const span of input.spans ?? []) {
    if (span.kind !== 'agent_role' || !span.target) continue;
    const role = input.roles.find((entry) => entry.id === span.target);
    if (!role) continue;
    captureAgentRoleApplied(postHog, role, {
      source: 'mention',
      crossMachine: input.executionMachineId ? role.machineId !== input.executionMachineId : null,
    });
  }
}
