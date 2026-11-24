export type PluginInvocationKind =
  | 'query'
  | 'mutation'
  | 'tool'
  | 'attachment-search'
  | 'attachment-resolve';

export function invocationDeadlineMs(kind: PluginInvocationKind): number {
  return kind === 'tool' ? 600_000 : 30_000;
}

/** Once dispatched, loss of the reply cannot distinguish a committed write from a lost call. */
export function lostInvocationCode(kind: PluginInvocationKind, reason: 'timeout' | 'exit') {
  if (kind === 'mutation' || kind === 'tool') return 'outcome_unknown';
  return reason === 'timeout' ? 'handler_error' : 'plugin_faulted';
}
