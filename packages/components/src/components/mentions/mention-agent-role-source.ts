import * as React from 'react';
import { useAtomValue } from 'jotai';
import {
  getAgentRoleEmoji,
  getAgentRoleMentionSlug,
  selectMentionableAgentRoles,
  type AgentRole,
  type AgentRoleMentionScope,
  type MachineId,
  type MachineViewMeta,
  type TextRewrite,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import type { AgentRoleDetailSubject } from '@/components/sessions/agent-role-detail-pane';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import {
  hydrateSlugMentionsFromText,
  type HydratedMentions,
} from '@/components/mentions/mention-hydration';
import { rankMentionCandidates } from '@/components/mentions/mention-rank';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
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
   * The text written after `@`, derived from the Role's name. Whitespace-free
   * by construction, and it changes when the name does — which is why the
   * committed range carries the id instead.
   */
  slug: string;
  role: AgentRole;
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
// Work-context scope
// ---------------------------------------------------------------------------

/**
 * What a composer is attached to, as far as Roles are concerned.
 *
 * Kept separate from the shared `AgentRoleMentionScope` so the rule is decidable
 * from the composer's own props: which machines the user may reach is resolved
 * later, by the hook that already reads the visible-machine index.
 */
export type AgentRoleMentionContext =
  | { kind: 'github' }
  | { kind: 'machine'; machineId: MachineId | null };

/**
 * Where a composer's Roles may run.
 *
 * A GitHub project is the only context that opens up: the target Session clones
 * the repo itself, so it can live on another authorized machine. A Local
 * Project — and a plain chat, in V1 — is pinned to the machine the work is on,
 * because a Role elsewhere could not reach that filesystem. A GitHub session
 * that is already checked out on a machine (`localWorktree`) is pinned for the
 * same reason.
 */
export const buildAgentRoleMentionContext = (options: {
  mentionSource: MentionProjectSource | undefined;
  /** The machine this chat runs on, when it has one. */
  currentMachineId: string | null | undefined;
}): AgentRoleMentionContext => {
  const currentMachineId = (options.currentMachineId || null) as MachineId | null;
  const { mentionSource } = options;
  if (mentionSource?.kind === 'local') {
    return { kind: 'machine', machineId: mentionSource.machineId };
  }
  if (mentionSource?.kind === 'provider' && mentionSource.localProject) {
    return { kind: 'machine', machineId: mentionSource.localProject.machineId };
  }
  // A GitHub project whose files are being read out of a live worktree is
  // already checked out on one machine, so it is pinned like a local project.
  if (mentionSource?.kind === 'github' && mentionSource.repoFullName) {
    return mentionSource.localWorktree
      ? { kind: 'machine', machineId: mentionSource.localWorktree.machineId }
      : { kind: 'github' };
  }
  if (mentionSource?.kind === 'provider' && mentionSource.githubRepoFullName) {
    return { kind: 'github' };
  }
  return { kind: 'machine', machineId: currentMachineId };
};

export const resolveAgentRoleMentionScope = (
  context: AgentRoleMentionContext,
  authorizedMachineIds: ReadonlySet<MachineId>
): AgentRoleMentionScope =>
  context.kind === 'github'
    ? { kind: 'authorized_machines', machineIds: authorizedMachineIds }
    : { kind: 'machine', machineId: context.machineId };

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Matches the other categories' caps: every row is an arrow-key stop. */
const MAX_AGENT_ROLE_SUGGESTIONS = 50;

export const selectAgentRoleMentionCandidates = (
  items: readonly AgentRoleMentionItem[],
  term: string,
  limit = MAX_AGENT_ROLE_SUGGESTIONS
): AgentRoleMentionItem[] =>
  rankMentionCandidates(items, term, {
    limit,
    fields: (item) => [item.slug, item.role.name],
  });

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const buildAgentRoleMentionItems = (
  roles: readonly AgentRole[],
  resolve: {
    machine: (machineId: MachineId) => AgentRoleMentionItem['machine'] | undefined;
    agentConfig: (role: AgentRole) => AgentRoleDetailSubject['agentConfig'] | undefined;
  }
): AgentRoleMentionItem[] =>
  roles.map((role) => ({
    slug: getAgentRoleMentionSlug(role),
    role,
    machine: resolve.machine(role.machineId) ?? null,
    agentConfig: resolve.agentConfig(role),
  }));

/**
 * The Roles this composer may offer, already filtered by visibility,
 * executability, and work context.
 *
 * One owner, like `useSessionMentionItems`: the menu and the before-send
 * expansion both need the same list, and deriving it twice would re-resolve
 * every Role's availability on each machine-presence tick.
 */
export function useAgentRoleMentionItems(context: AgentRoleMentionContext): AgentRoleMentionItem[] {
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const { machines } = useVisibleMachineMetas();
  const { roles } = useWorkspaceAgentRoles();
  const { resolve } = useAgentRoleAvailability(roles);

  return React.useMemo(() => {
    const mentionable = selectMentionableAgentRoles(roles, {
      currentUserId,
      scope: resolveAgentRoleMentionScope(context, new Set(machines.keys())),
      getAvailability: resolve,
    });
    // Indexed once: the same list is walked per Role, and this rebuilds on
    // every machine-presence tick.
    const agentConfigById = new Map(agentConfigs.map((config) => [config.id, config]));
    return buildAgentRoleMentionItems(mentionable, {
      machine: (machineId) => machines.get(machineId),
      agentConfig: (role) => agentConfigById.get(role.agentConfigId),
    });
  }, [agentConfigs, context, currentUserId, machines, resolve, roles]);
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
export const buildAgentRoleMentionPrompt = (role: { id: string; name: string }): string =>
  `use lody mcp to create a session with agent role[id: ${role.id}, name: ${role.name}]`;

export const buildAgentRoleMentionRewrites = (
  text: string,
  mentions: readonly { start: number; end: number; kind?: string; value: string }[],
  items: readonly AgentRoleMentionItem[]
): TextRewrite[] => {
  const rewrites: TextRewrite[] = [];
  for (const mention of mentions) {
    if (mention.kind !== 'agent_role' || !mention.value) continue;
    const item = items.find((candidate) => candidate.role.id === mention.value);
    const label = text.slice(mention.start, mention.end).replace(/^@/, '');
    // An unknown Role id is left verbatim on purpose: the Role may have been
    // deleted, unshared, or become unavailable since the draft was written, and
    // a stale token the agent can ignore beats an instruction to create a
    // Session from something that no longer authorizes one.
    if (!item || !label) continue;
    rewrites.push({
      start: mention.start,
      end: mention.end,
      replacement: buildAgentRoleMentionPrompt(item.role),
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
    slugToValue: new Map(items.map((item) => [item.slug, item.role.id as string])),
    kind: 'agent_role',
    knownFileTokens,
  });
