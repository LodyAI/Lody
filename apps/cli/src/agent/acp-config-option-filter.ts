/**
 * Config option ids the current version intentionally drops from an ACP
 * agent's `NewSessionResponse.configOptions` before they are cached for the UI
 * or applied in a live session.
 *
 * `acp-extension-claude` exposes an `agent`-id config option that the client
 * does not support yet, so it is filtered out instead of surfacing an unhandled
 * selector. Remove the id from this set once the option is supported.
 */
export const FILTERED_ACP_CONFIG_OPTION_IDS: ReadonlySet<string> = new Set(['agent']);

/**
 * Returns only the config options whose id is not in
 * {@link FILTERED_ACP_CONFIG_OPTION_IDS}. Generic over the option shape so it
 * works on both the raw ACP `SessionConfigOption[]` and the normalized summary.
 */
export function filterAcpConfigOptions<T extends { id: string }>(options: readonly T[]): T[] {
  return options.filter((opt) => !FILTERED_ACP_CONFIG_OPTION_IDS.has(opt.id));
}
