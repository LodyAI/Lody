/** Credential-free binding carried by the session control document. The marker
 * identifies the application's stream lifetime, not a server generation proof. */
export type SessionRoostHistoryRemoteDocState = {
  version: 1;
  generation: string;
  ownerPublicKey: string;
};

export function parseRoostHistoryRemoteBinding(
  value: unknown
): SessionRoostHistoryRemoteDocState | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new Error('Invalid Roost history remote binding');
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.generation !== 'string' ||
    !/^[0-9a-f]{32}$/.test(row.generation) ||
    typeof row.ownerPublicKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.ownerPublicKey)
  ) {
    throw new Error('Invalid Roost history remote binding');
  }
  return { version: 1, generation: row.generation, ownerPublicKey: row.ownerPublicKey };
}

/** Supplied only by an authenticated platform/workspace lifetime. Neither the
 * endpoint nor a credential is read from a replicated session document. */
export type RoostStreamsConnection = {
  readonly baseUrl: string;
  readonly signal: AbortSignal;
  readonly auth: (context?: {
    reason: string;
    previousToken?: string;
  }) => Promise<string | undefined>;
};
