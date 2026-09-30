/** Pure submit/resume decisions. I/O, CAS and persistence stay in the engine workflow. */

/** Where exact pending bytes stand relative to a freshly verified view. */
export function classifyLedgerPresence(input: {
  readonly containsRecord: boolean;
  readonly parentIsHead: boolean;
}): 'committed' | 'conflict' | 'absent' {
  if (input.containsRecord) return 'committed';
  if (!input.parentIsHead) return 'conflict';
  return 'absent';
}

/** A first-attempt `unsupported` CAS drops pending bytes; anything else stays pending. */
export function classifyUnresolvedSubmit(input: {
  readonly cas: 'accepted' | 'conflict' | 'unsupported' | 'unknown';
  readonly retrying: boolean;
}): 'unsupported' | 'pending' {
  return input.cas === 'unsupported' && !input.retrying ? 'unsupported' : 'pending';
}
