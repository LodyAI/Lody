/** Authoritative session grants for one machine. Sharing authority is outside SessionMeta; assignment supplies only a UI read fallback. */
export interface SessionAccessView {
  readonly machineId: string;
  readonly readSharedSessionIds: readonly string[];
  readonly canManage: boolean;
  readonly memberReadSharedSessions?: readonly {
    readonly sessionId: string;
    readonly userId: string;
  }[];
  /** Nonblocking review reminder; retained policy grants remain effective. */
  readonly needsResign?: boolean;
  /** Required for E2EE writes; derived by the host from verified ledger admission. */
  readonly generation?: string;
  /** Interrupted session intent, retained by native custody for exact retry. */
  readonly pendingRequest?: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly level: 'read' | null;
    readonly audience?: 'team' | { readonly userId: string };
  };
}

/** One UI contract for ordinary machine rows and owner-signed encrypted policies.
 * Every method is bound to the live account/workspace by composition. Notifications
 * are invalidation hints only; list/read must authenticate their actual sources.
 */
export interface SessionAccessPort {
  list(workspaceId: string): Promise<readonly SessionAccessView[]>;
  read(workspaceId: string, machineId: string): Promise<SessionAccessView>;
  set(input: {
    workspaceId: string;
    machineId: string;
    sessionId: string;
    level: 'read' | null;
    audience?: 'team' | { readonly userId: string };
    generation?: string;
    /** Retain this ID and the exact intent after unknown results. */
    requestId: string;
  }): Promise<{ status: 'saved' | 'pending' | 'conflict' | 'removed' }>;
  subscribe(workspaceId: string, invalidate: () => void): () => void;
}
