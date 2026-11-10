import { BUILTIN_AGENTS, type MemoryAgent } from '@lody/shared';

/** The part of an agent config this join needs; the rest never reaches here. */
export type MemoryAgentConfigSummary = { agentType: string; name: string };

/**
 * One agent on one machine, as the memory panel shows it: Lody's name for it,
 * plus what the provider knows about it. `everme` absent means the provider
 * has not adapted this agent — the row exists, but there is nothing to click.
 */
export type MemoryAgentRow = {
  agentType: string;
  displayName: string;
  everme?: MemoryAgent;
  /**
   * The provider has not answered for this agent yet. Distinct from `everme`
   * being absent, which is a claim — that the provider does not cover it.
   */
  pending?: true;
};

const builtinName = (agentType: string): string | undefined =>
  BUILTIN_AGENTS.find((agent) => agent.agentType === agentType)?.displayName;

const matches = (agent: MemoryAgent, agentType: string): boolean =>
  agent.id === agentType || (agent.aliases?.includes(agentType) ?? false);

/**
 * The panel lists the agents this machine is configured to run, not the ones
 * the provider happens to support: it sits in Lody's settings, so the question
 * it answers is "which of my agents can reach my memory", and an agent the
 * user never set up is not part of that question.
 *
 * Rows are ordered connected, then connectable, then unadapted. Connecting one
 * therefore lifts it to the top on the next inventory, which is the only
 * feedback the row itself gives — its button changes, but its place is what
 * the eye catches.
 */
export function buildMemoryAgentRows(
  configs: readonly MemoryAgentConfigSummary[],
  reported: readonly MemoryAgent[],
  /** False until the provider's first reply; rows stay unjudged until then. */
  answered = true
): MemoryAgentRow[] {
  // An empty config list yields an empty panel on purpose. Quietly showing the
  // provider's own catalogue instead would make "this machine's configs have
  // not arrived" indistinguishable from "working as intended" — a list that is
  // wrong in a way nobody can see is worse than one that is visibly empty.
  const rows = new Map<string, MemoryAgentRow>();
  for (const config of configs) {
    const everme = reported.find((agent) => matches(agent, config.agentType));
    // Keyed by what gets connected, not by what Lody calls it. Several agent
    // types can share one of the provider's: `claude-p` drives the same Claude
    // Code `claude` does. Keying on the agent type would then show one
    // connection as two rows that always agree and both act on each other.
    const key = everme?.id ?? config.agentType;
    if (rows.has(key)) continue;
    rows.set(key, {
      agentType: config.agentType,
      // Lody's own name wins: a user may rename a config, and two configs for
      // one agent would then disagree about what that agent is called.
      displayName: builtinName(config.agentType) ?? everme?.displayName ?? config.name,
      ...(everme ? { everme } : {}),
      // Before the first reply every row would otherwise read "not adapted",
      // which is a verdict the provider has not given yet.
      ...(everme || answered ? {} : { pending: true as const }),
    });
  }
  // Adapted-but-unreachable still belongs with the adapted ones: it is a row
  // the provider knows and will act on once the agent is there, which is a
  // different thing from one the provider has never heard of.
  const rank = (row: MemoryAgentRow): number => {
    if (!row.everme) return 2;
    return row.everme.connected ? 0 : 1;
  };
  return [...rows.values()].sort((left, right) => rank(left) - rank(right));
}
