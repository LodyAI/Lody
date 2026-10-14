import * as React from 'react';
import { useAtomValue } from 'jotai';
import {
  bindAgentRoleTarget,
  formatAgentRoleMentionValue,
  getAgentRoleEmoji,
  getAgentRoleMentionSlug,
  getAgentRoleTargets,
  normalizeAgentRoleMentionSlug,
  type AgentRole,
  type AgentRoleAvailability,
  type MachineId,
  type MachineViewMeta,
  type TextRewrite,
} from '@lody/shared';
import type { AgentRoleDetailSubject } from '@/components/sessions/agent-role-detail-pane';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import {
  hydrateSlugMentionsFromText,
  type HydratedMentions,
} from '@/components/mentions/mention-hydration';
import { rankMentionCandidates } from '@/components/mentions/mention-rank';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import {
  useAgentRoleAvailability,
  useWorkspaceAgentRoles,
} from '@/hooks/use-workspace-agent-roles';

/**
 * Agent Role mentions.
 *
 * Shaped like the session mention — the composer writes a readable
 * `@<mentionSlug>` and the committed RANGE carries the stable Role id — for the
 * same reason: the highlight overlay mirrors the textarea character for
 * character, so the text has to be something the user can read while the agent
 * receives something it can act on.
 *
 * What differs is what the rewrite produces. A session mention asks the agent to
 * read a history; a Role mention asks it to CREATE a Session, and the Role's
 * actual configuration is not in that instruction at all. The agent passes the
 * stable Role id back; the MCP create path resolves the current workspace row
 * and freezes its concrete configuration when it accepts the Operation.
 */

export type AgentRoleMentionItem = {
  /**
   * The text written after `@`, derived from the Role's name — or, for one of
   * several targets, its alias or the name and machine. Whitespace-free by
   * construction, and it changes when the name does — which is why the
   * committed range carries the id instead.
   */
  slug: string;
  /** What the committed range carries: `formatAgentRoleMentionValue`. */
  value: string;
  /** The row's title: the name, the alias, or `name · machine`. */
  label: string;
  /** Bound to this item's machine: its inline target is the one that runs. */
  role: AgentRole;
  availability: AgentRoleAvailability;
  /**
   * The bound agent and the machine it runs on, carried so the detail pane can
   * resolve this Role's stored ids into the labels that agent publishes, and
   * name the machine it binds. The pane is shared with the composer, which
   * passes the same pair.
   */
  agentConfig?: AgentRoleDetailSubject['agentConfig'];
  machine?: Pick<MachineViewMeta, 'acpCapabilities' | 'name'> | null;
};

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Available matches precede disabled matches, even when the latter score higher. */
export const selectAgentRoleMentionCandidates = (
  items: readonly AgentRoleMentionItem[],
  term: string,
  limit = items.length
): AgentRoleMentionItem[] => {
  const rank = (available: boolean) =>
    rankMentionCandidates(
      items.filter((item) => (item.availability.kind === 'available') === available),
      term,
      { limit, fields: (item) => [item.slug, item.label, item.role.name] }
    );
  return [...rank(true), ...rank(false)].slice(0, limit);
};

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * One item per machine a Role runs on. A single-target Role is one item, named
 * and mentioned as today. A Role on several machines lists every target, each
 * labelled by its alias or `name · machine`; the preferred machine's target
 * comes first so the composer's own machine is the first choice.
 */
export const buildAgentRoleMentionItems = (
  roles: readonly AgentRole[],
  resolve: {
    availability: (role: AgentRole) => AgentRoleAvailability;
    machine: (machineId: MachineId) => AgentRoleMentionItem['machine'] | undefined;
    agentConfig: (role: AgentRole) => AgentRoleDetailSubject['agentConfig'] | undefined;
  },
  preferredMachineId?: MachineId | null
): AgentRoleMentionItem[] =>
  [...roles]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .flatMap((role) => {
      const targets = getAgentRoleTargets(role);
      const multi = targets.length > 1;
      const ordered = preferredMachineId
        ? [
            ...targets.filter((target) => target.machineId === preferredMachineId),
            ...targets.filter((target) => target.machineId !== preferredMachineId),
          ]
        : targets;
      return ordered.flatMap((target) => {
        const bound = bindAgentRoleTarget(role, target.machineId);
        if (!bound) return [];
        const machine = resolve.machine(target.machineId) ?? null;
        const machineName = machine?.name || target.machineId;
        const label = !multi ? role.name : target.alias || `${role.name} · ${machineName}`;
        return [
          {
            // `@Reviewer-MacBook`: the separator dot is for reading, not typing.
            slug: multi
              ? normalizeAgentRoleMentionSlug(target.alias || `${role.name} ${machineName}`) ||
                getAgentRoleMentionSlug(role)
              : getAgentRoleMentionSlug(role),
            value: formatAgentRoleMentionValue(role.id, multi ? target.machineId : undefined),
            label,
            role: bound,
            availability: resolve.availability(bound),
            machine,
            agentConfig: resolve.agentConfig(bound),
          },
        ];
      });
    });

/**
 * Every readable Role, with execution availability retained for disabled menu
 * rows. Only available items may expand before send.
 *
 * No work-context scope: a Role may be dispatched from any composer to any
 * machine the user can reach, and "reachable" is already the availability
 * resolver's `machine_unknown` rule over the same visible-machine index.
 *
 * One owner, like `useSessionMentionItems`: the menu and the before-send
 * expansion both need the same list, and deriving it twice would re-resolve
 * every Role's availability on each machine-presence tick.
 */
export function useAgentRoleMentionItems(
  /** The composer's machine, whose targets lead; ordering only. */
  preferredMachineId?: MachineId | null
): AgentRoleMentionItem[] {
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const { machines } = useVisibleMachineMetas();
  const { roles } = useWorkspaceAgentRoles();
  const { resolve } = useAgentRoleAvailability(roles);

  return React.useMemo(() => {
    // Indexed once: the same list is walked per Role, and this rebuilds on
    // every machine-presence tick.
    const agentConfigById = new Map(agentConfigs.map((config) => [config.id, config]));
    return buildAgentRoleMentionItems(
      roles,
      {
        availability: resolve,
        machine: (machineId) => machines.get(machineId),
        agentConfig: (role) => agentConfigById.get(role.agentConfigId),
      },
      preferredMachineId
    );
  }, [agentConfigs, machines, preferredMachineId, resolve, roles]);
}

// ---------------------------------------------------------------------------
// Text: hydration and before-send expansion
// ---------------------------------------------------------------------------

/**
 * The instruction the current agent receives in place of the chip.
 *
 * Carries the Role id and nothing else that matters: the machine, agent config,
 * model, reasoning, and prompt prefix come from the workspace catalog, so the
 * agent cannot restate them differently. Operation acceptance freezes the
 * resolved configuration for recovery and retry.
 */
export const buildAgentRoleMentionPrompt = (
  role: { id: string; name: string },
  /** Only for a Role on several machines: the target the user picked. */
  machineId?: string
): string =>
  machineId
    ? `use lody mcp to create a session with agent role[id: ${role.id}, agentRoleMachineId: ${machineId}, name: ${role.name}]`
    : `use lody mcp to create a session with agent role[id: ${role.id}, name: ${role.name}]`;

export const buildAgentRoleMentionRewrites = (
  text: string,
  mentions: readonly { start: number; end: number; kind?: string; value: string }[],
  items: readonly AgentRoleMentionItem[]
): TextRewrite[] => {
  const rewrites: TextRewrite[] = [];
  for (const mention of mentions) {
    if (mention.kind !== 'agent_role' || !mention.value) continue;
    const item = items.find((candidate) => candidate.value === mention.value);
    const label = text.slice(mention.start, mention.end).replace(/^@/, '');
    // An unknown Role id is left verbatim on purpose: the Role may have been
    // deleted, unshared, or become unavailable since the draft was written, and
    // a stale token the agent can ignore beats an instruction to create a
    // Session from something that no longer authorizes one.
    if (!item || item.availability.kind !== 'available' || !label) continue;
    rewrites.push({
      start: mention.start,
      end: mention.end,
      replacement: buildAgentRoleMentionPrompt(
        item.role,
        item.value === item.role.id ? undefined : item.role.machineId
      ),
      // The mark is frozen with the span, not resolved when the bubble renders:
      // a sent message shows the Role as it was, and painting history must not
      // depend on the mutable catalog being loaded.
      span: {
        kind: 'agent_role',
        label,
        target: mention.value,
        mark: getAgentRoleEmoji(item.role),
      },
    });
  }
  return rewrites;
};

/**
 * Recover Role ranges from a reloaded draft's text.
 *
 * The fallback, not the mechanism: ranges are persisted with the draft. Like
 * the session hydrator it may only claim a token no file path claims, because a
 * slug and a path are the same shape and mistaking a path for a Role would turn
 * a file reference into a Session-creation instruction.
 */
export const hydrateAgentRoleMentionsFromText = (
  text: string,
  items: readonly AgentRoleMentionItem[],
  knownFileTokens?: ReadonlySet<string>
): HydratedMentions =>
  hydrateSlugMentionsFromText({
    text,
    slugToValue: new Map(
      items
        .filter((item) => item.availability.kind === 'available')
        .map((item) => [item.slug, item.value])
    ),
    kind: 'agent_role',
    knownFileTokens,
  });
