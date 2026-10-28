/** Narrow dispatch intent; the target validates inputConfig with its existing turn codec. */
export type E2eeDispatchInput = {
  sessionId: string;
  userTurnId: string;
  userId: string;
  timestamp: string;
  inputConfig: unknown;
};
/** Public original ciphertext receipt. No key or execution authority crosses the host boundary. */
export type E2eePreparedDispatch = {
  requestId: string;
  targetMachineId: string;
  frameHex: string;
  requesterDevice: string;
  expiresAt: number;
};
/** Delivery receipt only. Actual execution remains behind the shared agent-start claim. */
export type E2eeDispatchAck = {
  type: 'session/dispatch-turn_response';
  sessionId: string;
  userTurnId: string;
  accepted: boolean;
  disposition: 'accepted' | 'duplicate' | 'already-terminal' | 'not-owned' | 'error';
};

/** Closed set of machine reads. No installs, saves, agent execution or preview lease renewal. */
export const E2EE_READ_QUERY_METHODS = [
  'machine/status',
  'machine/ping',
  'machine/acp-binary-status',
  'machine/pi-extensions',
  'machine/memory',
  'project/probe-local-member',
  'local-project/git-state',
  'session/live-status',
  'session/history-read',
  'session/history-watch',
  'file/preview',
  'file/download-chunk',
  'code-collab/open-text',
  'code-collab/refresh-text',
  'code-collab/open-current-diff',
  'code-collab/open-all-changes-diff',
  'code-collab/open-turn-diff',
  'code-collab/lsp-definition',
  'code-collab/lsp-references',
] as const;
export type E2eeReadQueryMethod = (typeof E2EE_READ_QUERY_METHODS)[number];
/** Params use the existing method codec, including owner-session envelopes. */
export type E2eeQueryInput = { queryId: string; method: E2eeReadQueryMethod; params: unknown };
/** Encrypted method outcome; raw host exceptions never cross this boundary. */
export type E2eeQueryResult =
  | { result: unknown; error?: never }
  | { error: { code: string; message: string; data?: unknown }; result?: never };

/** Methods with mixed actions admit only their explicitly read-only operation. */
export function isE2eeReadQuery(method: string, params: unknown): method is E2eeReadQueryMethod {
  return (
    (E2EE_READ_QUERY_METHODS as readonly string[]).includes(method) &&
    (method !== 'machine/memory' ||
      (typeof params === 'object' &&
        params !== null &&
        'action' in params &&
        params.action === 'list'))
  );
}
